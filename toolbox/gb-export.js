/* Groovebox export helpers: exact audio capture (AudioWorklet), WAV / MP3 320 kbps encoders, ZIP writer.
   MP3 uses lamejs (lame.min.js, LGPL-3.0), loaded only when an MP3 is requested. */

// ---------------------------------------------------------------- capture: one AudioWorkletNode per track
const WORKLET = `
class GbRec extends AudioWorkletProcessor {
  constructor() {
    super(); this.on = false; this.n = 0; this.f0 = 0; this.L = new Int16Array(4096); this.R = new Int16Array(4096);
    this.port.onmessage = (e) => {
      if (e.data === 'on') this.on = true;
      else if (e.data === 'off') { this.flush(); this.on = false; }
      else if (e.data === 'flush') { this.flush(); this.port.postMessage({ ack: currentFrame }); }
    };
  }
  flush() { if (this.n) { this.port.postMessage({ f: this.f0, L: this.L.slice(0, this.n), R: this.R.slice(0, this.n) }); this.n = 0; } }
  process(inputs) {
    if (!this.on) return true;
    const i = inputs[0], l = i && i[0], r = (i && i[1]) || l;
    if (this.n === 0) this.f0 = currentFrame;
    for (let k = 0; k < 128; k++) {
      let a = l ? l[k] : 0, b = r ? r[k] : 0;
      a = a < -1 ? -1 : a > 1 ? 1 : a; b = b < -1 ? -1 : b > 1 ? 1 : b;
      this.L[this.n] = Math.round(a * 32767); this.R[this.n] = Math.round(b * 32767); this.n++;
    }
    if (this.n >= 4096) this.flush();
    return true;
  }
}
registerProcessor('gb-rec', GbRec);`;

const loaded = new WeakMap();
/** Registers the recorder worklet once per AudioContext. Rejects if the browser has no AudioWorklet. */
export async function prepareRecorder(ctx) {
  if (!ctx.audioWorklet) throw new Error('This browser cannot record the audio (no AudioWorklet).');
  if (loaded.has(ctx)) return loaded.get(ctx);
  const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
  const p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
  loaded.set(ctx, p); return p;
}

/** A capture point: connect any node to `.input`; chunks of 16-bit stereo are stored with their exact start frame. */
export class Tap {
  constructor(ctx) {
    this.ctx = ctx; this.chunks = []; this.waiting = null;
    this.node = new AudioWorkletNode(ctx, 'gb-rec', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    this.node.port.onmessage = (e) => { if (e.data.ack !== undefined) { this.waiting?.(); this.waiting = null; } else this.chunks.push(e.data); };
    this.mute = ctx.createGain(); this.mute.gain.value = 0; this.node.connect(this.mute); this.mute.connect(ctx.destination); // pulled by the graph, silent
    this.input = this.node;
  }
  start() { this.node.port.postMessage('on'); }
  /** Pushes out whatever the processor still holds. */
  flush() { return new Promise((res) => { this.waiting = res; this.node.port.postMessage('flush'); setTimeout(res, 800); }); }
  stop() { this.node.port.postMessage('off'); }
  close() { try { this.node.disconnect(); this.mute.disconnect(); } catch (e) {} }
  /** Samples [f0, f1) as two Int16Arrays (missing parts are silence). */
  slice(f0, f1) {
    const n = Math.max(0, f1 - f0), L = new Int16Array(n), R = new Int16Array(n);
    for (const c of this.chunks) {
      const a = Math.max(f0, c.f), b = Math.min(f1, c.f + c.L.length); if (b <= a) continue;
      L.set(c.L.subarray(a - c.f, b - c.f), a - f0); R.set(c.R.subarray(a - c.f, b - c.f), a - f0);
    }
    return { L, R };
  }
}

// ---------------------------------------------------------------- WAV (PCM 16 bit, stereo)
export function encodeWav(L, R, sr) {
  const n = L.length, buf = new ArrayBuffer(44 + n * 4), v = new DataView(buf), w = (o, s) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 4, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 2, true);
  v.setUint32(24, sr, true); v.setUint32(28, sr * 4, true); v.setUint16(32, 4, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, n * 4, true);
  const o = new Int16Array(buf, 44, n * 2); for (let i = 0; i < n; i++) { o[2 * i] = L[i]; o[2 * i + 1] = R[i]; }
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------- MP3 (lamejs, constant bit rate)
let lamePromise = null;
function loadLame() {
  if (globalThis.lamejs?.Mp3Encoder) return Promise.resolve();
  return (lamePromise ||= new Promise((res, rej) => {
    const s = document.createElement('script'); s.src = new URL('lame.min.js', import.meta.url).href; s.onload = () => (globalThis.lamejs?.Mp3Encoder ? res() : rej(new Error('MP3 encoder not found'))); s.onerror = () => rej(new Error('Could not load the MP3 encoder (lame.min.js)')); document.head.appendChild(s);
  }));
}
/** MPEG-1 Layer III only accepts 32, 44.1 and 48 kHz: anything else is resampled to 44.1 kHz. */
async function toMp3Rate(L, R, sr) {
  if ([32000, 44100, 48000].includes(sr)) return { L, R, sr };
  const to = 44100, len = Math.round((L.length * to) / sr), off = new OfflineAudioContext(2, len, to), b = off.createBuffer(2, L.length, sr);
  const l = b.getChannelData(0), r = b.getChannelData(1); for (let i = 0; i < L.length; i++) { l[i] = L[i] / 32768; r[i] = R[i] / 32768; }
  const src = off.createBufferSource(); src.buffer = b; src.connect(off.destination); src.start(); const o = await off.startRendering();
  const cv = (a) => { const z = new Int16Array(a.length); for (let i = 0; i < a.length; i++) z[i] = Math.max(-32768, Math.min(32767, Math.round(a[i] * 32768))); return z; };
  return { L: cv(o.getChannelData(0)), R: cv(o.getChannelData(1)), sr: to };
}
export async function encodeMp3(L0, R0, sr0, kbps = 320, onProgress = () => {}) {
  await loadLame();
  const { L, R, sr } = await toMp3Rate(L0, R0, sr0), enc = new globalThis.lamejs.Mp3Encoder(2, sr, kbps), parts = [], B = 1152 * 8;
  for (let i = 0; i < L.length; i += B) {
    const o = enc.encodeBuffer(L.subarray(i, i + B), R.subarray(i, i + B)); if (o.length) parts.push(new Uint8Array(o.buffer.slice(o.byteOffset, o.byteOffset + o.length)));
    if ((i / B) % 40 === 0) { onProgress(i / L.length); await new Promise((r) => setTimeout(r, 0)); } // let the page breathe
  }
  const f = enc.flush(); if (f.length) parts.push(new Uint8Array(f.buffer.slice(f.byteOffset, f.byteOffset + f.length)));
  return concat(parts);
}
function concat(parts) { const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; }

// ---------------------------------------------------------------- ZIP (no compression: WAV and MP3 do not shrink)
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = (u) => { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = CRC[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
/** files: [{ name, data: Uint8Array }] → Blob (.zip). */
export function zip(files) {
  const enc = new TextEncoder(), d = new Date(), time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  const local = [], central = []; let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 0, true); h.setUint16(10, time, true); h.setUint16(12, date, true);
    h.setUint32(14, crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, nm.length, true); h.setUint16(28, 0, true);
    local.push(new Uint8Array(h.buffer), nm, f.data);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 0, true); c.setUint16(12, time, true); c.setUint16(14, date, true);
    c.setUint32(16, crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    central.push(new Uint8Array(c.buffer), nm); off += 30 + nm.length + f.data.length;
  }
  const csize = central.reduce((a, p) => a + p.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...local, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
