// Mosaicus — i sensori dello smartphone come "strumento di misura", senza Arduino.
//
// Stessa interfaccia di SerialLink e SimulatedLink, e stesso protocollo testuale:
//   START,MOTION,<ms>  →  P,<t_ms>,ax,ay,az,wx,wy,wz   (accelerometro m/s², giroscopio rad/s)
//   START,SOUND,<ms>   →  M,<t_ms>,frequenza_Hz,livello_dB
//   STOP
// Così il resto dell'app tratta il telefono come una scheda in più.
//
// Note pratiche
//  • Serve una pagina sicura (https:// oppure localhost).
//  • iPhone: il permesso per i sensori di movimento si chiede con un tocco (requestPermission).
//  • L'accelerometro usa "accelerationIncludingGravity": a telefono fermo sul tavolo a_z ≈ +9,8 m/s².
//    Alcuni dispositivi usano la convenzione opposta: per questo c'è il parametro "segno".
//  • Il livello sonoro è relativo (dB rispetto al fondo scala del microfono), non tarato in dB SPL.

import { micSessionOn, micSessionOff } from './audio.js';

const FW = 'telefono';

export const phoneSupport = () => ({
  motion: typeof window !== 'undefined' && 'DeviceMotionEvent' in window,
  sound: !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia),
  secure: window.isSecureContext,
});

export class PhoneLink {
  constructor() {
    this.kind = 'telefono';
    this._lineCb = () => {};
    this._closeCb = () => {};
    this._stopFns = [];
    this.motionOK = false;
  }
  onLine(cb) { this._lineCb = cb; }
  onClose(cb) { this._closeCb = cb; }
  _emit(l) { this._lineCb(l); }

  /** Va chiamata dentro un tocco/clic: su iPhone chiede il permesso per i sensori di movimento. */
  async open() {
    if (!window.isSecureContext) throw new Error('i sensori funzionano solo da una pagina sicura (https)');
    if (typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function') {
      const r = await DeviceMotionEvent.requestPermission();
      if (r !== 'granted') throw new Error('permesso per i sensori di movimento negato');
    }
    this.motionOK = true;
    setTimeout(() => this._emit(`#MOSAICUS,${FW},READY`), 50);
  }

  async close() { this._stop(); this._closeCb(); }

  _stop() { for (const f of this._stopFns) f(); this._stopFns = []; }

  async write(cmd) {
    const c = cmd.trim();
    if (c === 'ID?') return this._emit(`#MOSAICUS,${FW},READY`);
    if (c === 'STOP') { this._stop(); return this._emit('#ACK,STOP'); }
    let m;
    if ((m = c.match(/^START,(MOTION|SOUND),(\d+)$/))) {
      this._stop();
      const interval = Math.max(m[1] === 'MOTION' ? 10 : 30, +m[2]);
      this._emit(`#ACK,START,${m[1]},${interval}`);
      if (m[1] === 'MOTION') this._startMotion(interval);
      else await this._startSound(interval);
      return;
    }
    this._emit(`#ERR,${c}`);
  }

  _startMotion(interval) {
    const t0 = performance.now();
    let last = -Infinity, got = false;
    const DEG = Math.PI / 180;
    const h = (e) => {
      const t = e.timeStamp ?? performance.now();
      if (t - last < interval - 4) return; // tolleranza: gli eventi arrivano a passi di ~16 ms
      last = t; got = true;
      const g = e.accelerationIncludingGravity || {}, r = e.rotationRate || {};
      const v = (x) => (x == null || !isFinite(x) ? 'nan' : (+x).toFixed(4));
      // rotationRate è in gradi al secondo: alpha attorno a z, beta attorno a x, gamma attorno a y
      this._emit(`P,${Math.round(t - t0)},${v(g.x)},${v(g.y)},${v(g.z)},${v(r.beta * DEG)},${v(r.gamma * DEG)},${v(r.alpha * DEG)}`);
    };
    window.addEventListener('devicemotion', h);
    const warn = setTimeout(() => { if (!got) this._emit('#ERR,nessun dato dai sensori di movimento: questo dispositivo ne è privo?'); }, 2500);
    this._stopFns.push(() => { window.removeEventListener('devicemotion', h); clearTimeout(warn); });
  }

  async _startSound(interval) {
    let stream;
    micSessionOn();
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    } catch (e) { micSessionOff(); this._emit(`#ERR,microfono non disponibile (${e.message})`); return; }
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(stream);
    const an = ctx.createAnalyser();
    an.fftSize = 8192; an.smoothingTimeConstant = 0;
    src.connect(an);
    const spec = new Float32Array(an.frequencyBinCount);
    const wave = new Float32Array(an.fftSize);
    const t0 = performance.now();
    const timer = setInterval(() => {
      an.getFloatFrequencyData(spec);
      an.getFloatTimeDomainData(wave);
      const { f } = dominantFrequency(spec, ctx.sampleRate, an.fftSize);
      let s = 0; for (const x of wave) s += x * x;
      const level = 10 * Math.log10(s / wave.length + 1e-12);
      this._emit(`M,${Math.round(performance.now() - t0)},${isFinite(f) ? f.toFixed(2) : 'nan'},${level.toFixed(2)}`);
    }, interval);
    this._stopFns.push(() => { clearInterval(timer); stream.getTracks().forEach((tr) => tr.stop()); ctx.close(); micSessionOff(); });
  }
}

/**
 * Frequenza dominante dallo spettro (dB per bin): massimo tra 50 Hz e 5 kHz, raffinato con
 * l'interpolazione parabolica sui tre bin vicini (risoluzione molto migliore di un bin).
 */
export function dominantFrequency(specDb, sampleRate, fftSize, fMin = 50, fMax = 5000) {
  const df = sampleRate / fftSize;
  const i0 = Math.max(1, Math.floor(fMin / df)), i1 = Math.min(specDb.length - 2, Math.ceil(fMax / df));
  let best = -1, bv = -Infinity;
  for (let i = i0; i <= i1; i++) if (specDb[i] > bv) { bv = specDb[i]; best = i; }
  if (best < 0 || bv < -95) return { f: NaN, db: bv };
  const a = specDb[best - 1], b = specDb[best], c = specDb[best + 1];
  const den = a - 2 * b + c;
  const delta = den !== 0 ? (0.5 * (a - c)) / den : 0;
  return { f: (best + delta) * df, db: bv };
}
