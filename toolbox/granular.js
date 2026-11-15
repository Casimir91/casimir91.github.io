/* Waveshaper & Granular · Toolbox. Everything is Web Audio: a WaveShaperNode with a drawable curve, and a granular
   engine that schedules short windowed BufferSource grains. No samples, no libraries. */
const $ = (s, r = document) => r.querySelector(s), $$ = (s, r = document) => [...r.querySelectorAll(s)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
let cssAt = 0; const cssC = {};
const css = (n) => { const t = performance.now(); if (!cssC.v || t - cssAt > 400) { cssAt = t; cssC.v = getComputedStyle(document.documentElement); for (const k in cssC) if (k !== 'v') delete cssC[k]; } return cssC[n] ??= cssC.v.getPropertyValue(n).trim() || '#888'; };
const status = (t) => { $('#status').textContent = t; };

// ================================================================= audio graph (created on the first Play)
let ctx = null, master, comp, specAn, shaperIn, preAn, shaper, dcBlock, postAn, wsOut, grainOut, osc = null, oscGain;
function engine() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return ctx; }
  const AC = window.AudioContext || window.webkitAudioContext; ctx = new AC({ latencyHint: 'interactive' });
  master = ctx.createGain(); master.gain.value = 0.8;
  comp = ctx.createDynamicsCompressor(); comp.threshold.value = -8; comp.knee.value = 6; comp.ratio.value = 12; comp.attack.value = 0.003; comp.release.value = 0.15;
  master.connect(comp); comp.connect(ctx.destination);
  specAn = ctx.createAnalyser(); specAn.fftSize = 8192; specAn.smoothingTimeConstant = 0.72; specAn.minDecibels = -100; specAn.maxDecibels = -6; master.connect(specAn);
  shaperIn = ctx.createGain(); shaperIn.gain.value = W.level;
  preAn = ctx.createAnalyser(); preAn.fftSize = 4096; shaperIn.connect(preAn);
  shaper = ctx.createWaveShaper(); shaper.oversample = '4x'; shaper.curve = new Float32Array(curve);
  dcBlock = ctx.createBiquadFilter(); dcBlock.type = 'highpass'; dcBlock.frequency.value = 18; dcBlock.Q.value = 0.5;   // asymmetric curves create a DC offset: it would only eat headroom
  postAn = ctx.createAnalyser(); postAn.fftSize = 4096;
  wsOut = ctx.createGain(); wsOut.gain.value = W.vol;
  shaperIn.connect(shaper); shaper.connect(dcBlock); dcBlock.connect(postAn); dcBlock.connect(wsOut); wsOut.connect(master);
  grainOut = ctx.createGain(); grainOut.gain.value = G.level; routeGrains();
  oscGain = ctx.createGain(); oscGain.gain.value = 0; oscGain.connect(shaperIn);
  return ctx;
}
const routeGrains = () => { if (!grainOut) return; grainOut.disconnect(); grainOut.connect(W.src === 'grain' ? shaperIn : master); };

// ================================================================= UI helpers
/** A labelled slider. map: slider position (0..1) → value; unmap: value → position. */
function slider(parent, o) {
  const id = o.id, row = document.createElement('div'); row.className = 'sl';
  const map = o.log ? (p) => o.min * (o.max / o.min) ** p : (p) => o.min + p * (o.max - o.min), unmap = o.log ? (v) => Math.log(v / o.min) / Math.log(o.max / o.min) : (v) => (v - o.min) / (o.max - o.min);
  row.innerHTML = `<label for="${id}">${o.label}</label><input id="${id}" type="range" min="0" max="1000" step="1"><output></output>`;
  const r = $('input', row), out = $('output', row); r.value = Math.round(unmap(o.value) * 1000);
  const upd = () => { let v = map(r.value / 1000); if (o.step) v = Math.round(v / o.step) * o.step; out.textContent = o.fmt(v); return v; };
  r.addEventListener('input', () => o.onInput(upd())); upd(); parent.appendChild(row);
  return { set(v) { r.value = Math.round(unmap(v) * 1000); out.textContent = o.fmt(v); }, el: r };
}
function fit(cv) { const d = window.devicePixelRatio || 1, w = Math.round(cv.clientWidth * d), h = Math.round(cv.clientHeight * d); if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } return [cv.getContext('2d'), w, h, d]; }
const radio = (box, attr, fn) => $$(`[${attr}]`, box).forEach((b) => b.addEventListener('click', () => { $$(`[${attr}]`, box).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); fn(b.getAttribute(attr), b); }));

// ================================================================= 1 · WAVESHAPER
const N = 513;                                           // points of the transfer function, x = −1 … +1
const curve = new Float32Array(N);
const W = { src: 'sine', f0: 220, level: 1, vol: 0.35, mode: 'preset', preset: 'identity', cheb: [1, 0, 0, 0, 0, 0, 0, 0] };
const xOf = (i) => -1 + (2 * i) / (N - 1);
const PRESETS = {
  identity: ['Linear', (x) => x],
  tanh: ['Soft clip', (x) => Math.tanh(3 * x) / Math.tanh(3)],
  hard: ['Hard clip', (x) => clamp(2.5 * x, -1, 1)],
  fold: ['Wavefold', (x) => Math.sin(1.5 * Math.PI * x)],
  asym: ['Asymmetric', (x) => (x > 0 ? Math.tanh(2.5 * x) / Math.tanh(2.5) : 0.35 * x)],
  stairs: ['Bit-crush', (x) => Math.round(x * 4) / 4],
  rect: ['Full-wave rect.', (x) => 2 * Math.abs(x) - 1],
};
function chebFill(a) { // f(x) = Σ aₙ Tₙ(x), scaled so that |f| ≤ 1
  const s = a.reduce((t, v) => t + v, 0) || 1;
  for (let i = 0; i < N; i++) { const x = xOf(i); let t0 = 1, t1 = x, y = a[0] * t1; for (let n = 2; n <= a.length; n++) { const t2 = 2 * x * t1 - t0; y += a[n - 1] * t2; t0 = t1; t1 = t2; } curve[i] = y / s; }
}
function applyCurve() { if (shaper) shaper.curve = new Float32Array(curve); }
function setPreset(k) { W.mode = 'preset'; W.preset = k; const f = PRESETS[k][1]; for (let i = 0; i < N; i++) curve[i] = f(xOf(i)); applyCurve(); paintWsUi(); }
function setCheb() { W.mode = 'cheb'; chebFill(W.cheb); applyCurve(); paintWsUi(); }
function paintWsUi() {
  $$('#wsPresets [data-p]').forEach((b) => b.setAttribute('aria-pressed', String(W.mode === 'preset' && b.dataset.p === W.preset)));
  $$('#cheb input').forEach((r, i) => { r.value = Math.round(W.cheb[i] * 100); r.parentNode.querySelector('output').textContent = W.cheb[i].toFixed(2); });
}
{ const box = $('#wsPresets'); for (const [k, [name]] of Object.entries(PRESETS)) { const b = document.createElement('button'); b.dataset.p = k; b.textContent = name; b.setAttribute('aria-pressed', 'false'); b.addEventListener('click', () => setPreset(k)); box.appendChild(b); }
  const sm = document.createElement('button'); sm.textContent = 'Smooth'; sm.title = 'Average neighbouring points'; sm.addEventListener('click', () => { for (let p = 0; p < 3; p++) { const c = Float32Array.from(curve); for (let i = 1; i < N - 1; i++) curve[i] = (c[i - 1] + c[i] + c[i + 1]) / 3; } W.mode = 'drawn'; applyCurve(); paintWsUi(); }); box.appendChild(sm); }
$('#cheb').innerHTML = W.cheb.map((_, i) => `<label><output>0.00</output><input type="range" min="0" max="100" step="1" data-n="${i}" aria-label="Amplitude of harmonic ${i + 1}"><b>${i + 1}</b></label>`).join('');
$('#cheb').addEventListener('input', (e) => { const r = e.target.closest('input[data-n]'); if (!r) return; W.cheb[+r.dataset.n] = +r.value / 100; setCheb(); });
const wsS = $('#wsSliders');
slider(wsS, { id: 'wsF', label: 'Frequency', min: 55, max: 880, value: 220, log: true, fmt: (v) => v.toFixed(0) + ' Hz', onInput: (v) => { W.f0 = v; if (osc) osc.frequency.setTargetAtTime(v, ctx.currentTime, 0.01); } });
slider(wsS, { id: 'wsL', label: 'Input level', min: 0, max: 2, value: 1, fmt: (v) => Math.round(v * 100) + ' %', onInput: (v) => { W.level = v; shaperIn?.gain.setTargetAtTime(v, ctx.currentTime, 0.01); } });
slider(wsS, { id: 'wsV', label: 'Volume', min: 0, max: 1, value: 0.35, fmt: (v) => Math.round(v * 100) + ' %', onInput: (v) => { W.vol = v; wsOut?.gain.setTargetAtTime(v, ctx.currentTime, 0.01); } });

// start / stop the oscillator
function oscStart() {
  engine(); if (osc) return;
  osc = ctx.createOscillator(); osc.type = W.src === 'grain' ? 'sine' : W.src; osc.frequency.value = W.f0; osc.connect(oscGain); osc.start();
  oscGain.gain.cancelScheduledValues(ctx.currentTime); oscGain.gain.setTargetAtTime(W.src === 'grain' ? 0 : 1, ctx.currentTime, 0.02);
}
function oscStop() { if (!osc) return; const o = osc, t = ctx.currentTime; osc = null; oscGain.gain.cancelScheduledValues(t); oscGain.gain.setTargetAtTime(0, t, 0.03); o.stop(t + 0.2); }
const wsPlaying = () => $('#wsPlay').getAttribute('aria-pressed') === 'true';
const setWsBtn = (on) => { $('#wsPlay').setAttribute('aria-pressed', String(on)); $('#wsPlay').textContent = on ? '■ Stop' : '▶ Play'; };
$('#wsPlay').addEventListener('click', () => {
  const on = !wsPlaying(); setWsBtn(on);
  if (on) { engine(); if (W.src === 'grain') { if (!grainOn()) grainToggle(true); } else oscStart(); status('Waveshaper playing: draw on the curve'); } else { oscStop(); if (W.src === 'grain' && grainOn()) grainToggle(false); status('Stopped'); }
});
radio($('#wsSrc'), 'data-src', (v) => {
  W.src = v; routeGrains();
  if (v === 'grain') { oscStop(); if (wsPlaying()) grainToggle(true); }
  else { if (grainOn() && wsPlaying()) grainToggle(false); if (osc) osc.type = v; else if (wsPlaying()) oscStart(); if (osc) oscGain.gain.setTargetAtTime(1, ctx.currentTime, 0.02); }
});

// drawing on the transfer function
{
  const cv = $('#curve'); let last = -1, drawing = false;
  const at = (e) => { const r = cv.getBoundingClientRect(), px = clamp((e.clientX - r.left) / r.width, 0, 1), py = clamp((e.clientY - r.top) / r.height, 0, 1); return [Math.round(px * (N - 1)), clamp(1 - 2 * py, -1, 1)]; };
  const put = (e) => { const [i, y] = at(e); if (last < 0) last = i; const a = Math.min(i, last), b = Math.max(i, last), ya = i <= last ? y : curve[last], yb = i <= last ? curve[last] : y; for (let k = a; k <= b; k++) curve[k] = b === a ? y : ya + ((yb - ya) * (k - a)) / (b - a); last = i; W.mode = 'drawn'; applyCurve(); paintWsUi(); };
  cv.addEventListener('pointerdown', (e) => { e.preventDefault(); cv.setPointerCapture(e.pointerId); drawing = true; last = -1; put(e); });
  cv.addEventListener('pointermove', (e) => { if (drawing) put(e); });
  for (const ev of ['pointerup', 'pointercancel']) cv.addEventListener(ev, () => { drawing = false; last = -1; });
}

// ---------- drawing the three displays
const fbuf = new Float32Array(4096), sbuf = new Float32Array(4096);
function drawCurve() {
  const [g, w, h, d] = fit($('#curve')), cs = { b: css('--border'), m: css('--muted'), p: css('--primary'), f: css('--fg') };
  g.clearRect(0, 0, w, h); g.lineWidth = d; g.strokeStyle = cs.b;
  for (const t of [0.25, 0.5, 0.75]) { g.globalAlpha = t === 0.5 ? 1 : 0.4; g.beginPath(); g.moveTo(t * w, 0); g.lineTo(t * w, h); g.moveTo(0, t * h); g.lineTo(w, t * h); g.stroke(); } g.globalAlpha = 1;
  g.strokeStyle = cs.m; g.setLineDash([4 * d, 6 * d]); g.beginPath(); g.moveTo(0, h); g.lineTo(w, 0); g.stroke(); g.setLineDash([]);          // y = x for reference
  const L = W.level; if (L < 1) { g.fillStyle = cs.p; g.globalAlpha = 0.08; g.fillRect(((1 - L) / 2) * w, 0, L * w, h); g.globalAlpha = 1; }
  g.strokeStyle = cs.p; g.lineWidth = 2.5 * d; g.beginPath();
  for (let i = 0; i < N; i++) { const px = (i / (N - 1)) * w, py = (0.5 - curve[i] / 2) * h; i ? g.lineTo(px, py) : g.moveTo(px, py); } g.stroke();
  if (preAn) { preAn.getFloatTimeDomainData(fbuf); const x = clamp(fbuf[fbuf.length - 1], -1, 1), i = Math.round(((x + 1) / 2) * (N - 1)), px = ((x + 1) / 2) * w, py = (0.5 - curve[i] / 2) * h;
    g.strokeStyle = cs.f; g.globalAlpha = 0.5; g.lineWidth = d; g.setLineDash([3 * d, 4 * d]); g.beginPath(); g.moveTo(px, h / 2); g.lineTo(px, py); g.lineTo(w / 2, py); g.stroke(); g.setLineDash([]); g.globalAlpha = 1;
    g.fillStyle = cs.p; g.beginPath(); g.arc(px, py, 6 * d, 0, 7); g.fill(); }
  g.fillStyle = cs.m; g.font = `${11 * d}px system-ui`; g.fillText('x (in)', w - 44 * d, h / 2 - 5 * d); g.fillText('y (out)', w / 2 + 6 * d, 13 * d);
}
function drawScope() {
  const [g, w, h, d] = fit($('#scope')), cs = { b: css('--border'), m: css('--muted'), p: css('--primary') };
  g.clearRect(0, 0, w, h); g.strokeStyle = cs.b; g.lineWidth = d; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.moveTo(0, h * 0.25); g.lineTo(w, h * 0.25); g.moveTo(0, h * 0.75); g.lineTo(w, h * 0.75); g.stroke();
  if (!preAn) return;
  preAn.getFloatTimeDomainData(fbuf); postAn.getFloatTimeDomainData(sbuf);
  let s0 = 1; for (; s0 < 1500; s0++) if (fbuf[s0 - 1] < 0 && fbuf[s0] >= 0) break; if (s0 >= 1500) s0 = 0;       // trigger on a rising zero crossing of the input
  const n = W.src === 'grain' ? 1200 : Math.min(2400, Math.round((3 * ctx.sampleRate) / W.f0));
  const trace = (buf, col, lw) => { g.strokeStyle = col; g.lineWidth = lw * d; g.beginPath(); for (let i = 0; i < n; i++) { const y = (0.5 - clamp(buf[s0 + i] ?? 0, -1.2, 1.2) / 2.4 * 2 / 2) * h; i ? g.lineTo((i / (n - 1)) * w, y) : g.moveTo(0, y); } g.stroke(); };
  g.globalAlpha = 0.7; trace(fbuf, cs.m, 1.5); g.globalAlpha = 1; trace(sbuf, cs.p, 2.4);
}
let harmNext = 0;
function drawSpec(now) {
  const [g, w, h, d] = fit($('#spec')), cs = { b: css('--border'), m: css('--muted'), p: css('--primary'), a: css('--accent') };
  g.clearRect(0, 0, w, h); if (!specAn) return;
  const nb = specAn.frequencyBinCount; specAn.getFloatFrequencyData(sbuf.length >= nb ? sbuf : (sbuf2 = new Float32Array(nb))); const data = sbuf.length >= nb ? sbuf : sbuf2;
  const sr = ctx.sampleRate, fmin = 30, fmax = 16000, X = (f) => (Math.log(f / fmin) / Math.log(fmax / fmin)) * w, F = (x) => fmin * (fmax / fmin) ** (x / w), Y = (db) => (1 - clamp((db + 100) / 94, 0, 1)) * h;
  g.strokeStyle = cs.b; g.fillStyle = cs.m; g.lineWidth = d; g.font = `${10.5 * d}px system-ui`;
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { g.globalAlpha = 0.5; g.beginPath(); g.moveTo(X(f), 0); g.lineTo(X(f), h); g.stroke(); g.globalAlpha = 1; g.fillText(f >= 1000 ? f / 1000 + 'k' : f, X(f) + 3 * d, h - 4 * d); }
  const harm = osc && W.src !== 'grain'; if (harm) { g.strokeStyle = cs.a; g.globalAlpha = 0.45; for (let k = 1; k * W.f0 < fmax && k <= 24; k++) { g.beginPath(); g.moveTo(X(k * W.f0), 0); g.lineTo(X(k * W.f0), h * 0.9); g.stroke(); if (k <= 12) { g.fillStyle = cs.a; g.fillText(k, X(k * W.f0) + 3 * d, 12 * d); } } g.globalAlpha = 1; }
  g.beginPath(); g.moveTo(0, h);
  for (let x = 0; x < w; x += 1) { const a = F(x), b = F(x + 1), i0 = Math.floor((a / (sr / 2)) * nb), i1 = Math.max(i0, Math.floor((b / (sr / 2)) * nb)); let m = -200; for (let i = i0; i <= i1 && i < nb; i++) m = Math.max(m, data[i]); g.lineTo(x, Y(m)); }
  g.lineTo(w, h); g.closePath(); g.fillStyle = cs.p; g.globalAlpha = 0.28; g.fill(); g.globalAlpha = 1; g.strokeStyle = cs.p; g.lineWidth = 1.6 * d; g.stroke();
  if (harm && now > harmNext) { harmNext = now + 150; const lev = []; let ref = -200;
    for (let k = 1; k <= 8 && k * W.f0 < sr / 2 - 200; k++) { const c = Math.round((k * W.f0 / (sr / 2)) * nb); let m = -200; for (let i = c - 2; i <= c + 2; i++) m = Math.max(m, data[i] ?? -200); lev.push(m); ref = Math.max(ref, m); }
    $('#harmRead').textContent = ' · harmonics in dB, 0 = the strongest: ' + lev.map((m, i) => `${i + 1}: ${m - ref > -80 ? Math.round(m - ref) : '−∞'}`).join(' · ') + ' dB'; }
  if (!harm && now > harmNext) { harmNext = now + 300; $('#harmRead').textContent = ''; }
}
let sbuf2 = null;

// ================================================================= 2 · GRANULAR
const G = { pos: 0.1, spray: 0.02, size: 80, dens: 20, pitch: 0, pitchSpread: 0, pan: 0.4, rev: 0, scan: 0, level: 0.7, win: 'hann', timing: 'reg' };
let buf = null, revBuf = null, srcName = '';
const WIN = (() => { const n = 128, mk = (f) => Float32Array.from({ length: n }, (_, k) => f(k / (n - 1)));
  return { hann: mk((u) => 0.5 - 0.5 * Math.cos(2 * Math.PI * u)), gauss: mk((u) => (u === 0 || u === 1 ? 0 : Math.exp(-0.5 * ((u - 0.5) / 0.17) ** 2))), tri: mk((u) => 1 - Math.abs(2 * u - 1)),
    tukey: mk((u) => (u < 0.25 ? 0.5 - 0.5 * Math.cos((Math.PI * u) / 0.25) : u > 0.75 ? 0.5 - 0.5 * Math.cos((Math.PI * (1 - u)) / 0.25) : 1)), rect: mk(() => 1) }; })();

// ---------- sources
const SR = 44100;
const gen = (secs, fn) => { const d = new Float32Array(Math.round(secs * SR)); fn(d, SR); return d; };
function setMono(mono, sr, name, note) {
  buf = new AudioBuffer({ length: mono.length, sampleRate: sr }); buf.copyToChannel(mono, 0);
  revBuf = new AudioBuffer({ length: mono.length, sampleRate: sr }); revBuf.copyToChannel(Float32Array.from(mono).reverse(), 0);
  srcName = name; $('#srcNote').textContent = note || ''; peaksDirty = true;
}
function setBuffer(b, name, note) {   // an AudioBuffer from decodeAudioData: mix down to mono
  let mono = Float32Array.from(b.getChannelData(0)); for (let c = 1; c < b.numberOfChannels; c++) { const x = b.getChannelData(c); for (let i = 0; i < mono.length; i++) mono[i] += x[i]; } if (b.numberOfChannels > 1) for (let i = 0; i < mono.length; i++) mono[i] /= b.numberOfChannels;
  setMono(mono, b.sampleRate, name, note); status(name);
}
function useSweep() { setMono(gen(6, (d, sr) => { let ph = 0; for (let i = 0; i < d.length; i++) { const p = i / d.length, f = 110 * 2 ** (5 * p); ph += (2 * Math.PI * f) / sr; d[i] = 0.5 * Math.sin(ph) * Math.min(1, i / 400, (d.length - i) / 400); } }), SR, 'Sine sweep', 'A pure sine that rises from 110 Hz to 3520 Hz (5 octaves) in 6 s: the position of the grains is the pitch you hear, f = 110·2^(5·position). With a big spray you hear a band of frequencies.'); }
function useChord() {
  setMono(gen(5, (d, sr) => { const chords = [[130.81, 196, 233.08, 311.13], [155.56, 233.08, 311.13, 392], [130.81, 196, 233.08, 293.66, 349.23], [116.54, 174.61, 233.08, 293.66]];
    chords.forEach((ch, s) => { const t0 = Math.round(s * 1.2 * sr); ch.forEach((f, n) => { const ts = t0 + Math.round(n * 0.045 * sr); for (let k = 1; k <= 9; k++) { const a = 0.12 / k ** 1.1, tau = 1.6 / (1 + 0.5 * k), w = (2 * Math.PI * f * k) / sr; for (let i = ts; i < d.length; i++) { const t = (i - ts) / sr; if (t > 4 * tau) break; d[i] += a * Math.exp(-t / tau) * Math.sin(w * (i - ts)); } } }); }); let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v)); for (let i = 0; i < d.length; i++) d[i] *= 0.6 / pk; }),
    SR, 'Plucked chords', 'Four strummed chords (additive synthesis, nine decaying harmonics per note). Scan the position to hear the bright attacks and the dark tails separately.');
}
async function decode(ab, name) { try { const c = engine(), b = await c.decodeAudioData(ab); const max = Math.round(b.sampleRate * 60); let use = b; if (b.length > max) { use = c.createBuffer(b.numberOfChannels, max, b.sampleRate); for (let k = 0; k < b.numberOfChannels; k++) use.copyToChannel(b.getChannelData(k).subarray(0, max), k); } setBuffer(use, name, `${name} · ${use.duration.toFixed(1)} s${b.length > max ? ' (first 60 s)' : ''}`); return true; } catch (e) { status('Could not read this audio: ' + e.message); return false; } }
async function recordMic() {
  const btn = $('#grSrc [data-src=mic]');
  try {
    const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }), rec = new MediaRecorder(st), parts = [];
    rec.ondataavailable = (e) => parts.push(e.data); btn.textContent = '● Recording…'; status('Recording 4 seconds…');
    rec.onstop = async () => { st.getTracks().forEach((t) => t.stop()); btn.textContent = '● Microphone 4 s'; const ok = await decode(await new Blob(parts).arrayBuffer(), 'Microphone'); if (!ok) return; };
    rec.start(); setTimeout(() => rec.state !== 'inactive' && rec.stop(), 4000);
  } catch (e) { status('Microphone not available: ' + (e.message || e.name)); useSweep(); setSrcButton('sweep'); }
}
const setSrcButton = (v) => $$('#grSrc [data-src]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.src === v)));
radio($('#grSrc'), 'data-src', (v) => { $('#grFileBtn').setAttribute('aria-pressed', 'false'); if (v === 'sweep') useSweep(); else if (v === 'chord') useChord(); else if (v === 'mic') recordMic(); });
$('#grFileBtn').addEventListener('click', () => $('#grFile').click());
$('#grFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; $$('#grSrc [data-src]').forEach((b) => b.setAttribute('aria-pressed', 'false')); $('#grFileBtn').setAttribute('aria-pressed', 'true'); await decode(await f.arrayBuffer(), f.name); e.target.value = ''; });

// ---------- sliders
const gs = $('#grSliders'); const SL = {};
SL.pos = slider(gs, { id: 'gPos', label: 'Position', min: 0, max: 1, value: G.pos, fmt: (v) => Math.round(v * 100) + ' %', onInput: (v) => { G.pos = v; } });
SL.spray = slider(gs, { id: 'gSpray', label: 'Spray (scatter)', min: 0, max: 0.5, value: G.spray, fmt: (v) => '±' + Math.round(v * 100) + ' %', onInput: (v) => { G.spray = v; } });
SL.size = slider(gs, { id: 'gSize', label: 'Grain size', min: 3, max: 500, value: G.size, log: true, fmt: (v) => v.toFixed(v < 10 ? 1 : 0) + ' ms', onInput: (v) => { G.size = v; readout(); } });
SL.dens = slider(gs, { id: 'gDens', label: 'Density', min: 1, max: 150, value: G.dens, log: true, fmt: (v) => v.toFixed(v < 10 ? 1 : 0) + ' /s', onInput: (v) => { G.dens = v; readout(); } });
SL.pitch = slider(gs, { id: 'gPitch', label: 'Pitch', min: -24, max: 24, value: 0, step: 1, fmt: (v) => (v > 0 ? '+' : '') + v + ' st', onInput: (v) => { G.pitch = v; } });
SL.ps = slider(gs, { id: 'gPS', label: 'Pitch scatter', min: 0, max: 600, value: 0, step: 5, fmt: (v) => '±' + v + ' ct', onInput: (v) => { G.pitchSpread = v; } });
SL.pan = slider(gs, { id: 'gPan', label: 'Stereo spread', min: 0, max: 1, value: G.pan, fmt: (v) => Math.round(v * 100) + ' %', onInput: (v) => { G.pan = v; } });
SL.rev = slider(gs, { id: 'gRev', label: 'Reversed grains', min: 0, max: 1, value: 0, fmt: (v) => Math.round(v * 100) + ' %', onInput: (v) => { G.rev = v; } });
SL.scan = slider(gs, { id: 'gScan', label: 'Scan speed', min: -0.5, max: 0.5, value: 0, step: 0.01, fmt: (v) => (v > 0 ? '+' : '') + Math.round(v * 100) + ' %/s', onInput: (v) => { G.scan = v; } });
SL.level = slider(gs, { id: 'gLev', label: 'Level', min: 0, max: 1.2, value: G.level, fmt: (v) => Math.round(v * 100) + ' %', onInput: (v) => { G.level = v; grainOut?.gain.setTargetAtTime(v, ctx.currentTime, 0.02); } });
radio($('#grWin'), 'data-w', (v) => { G.win = v; });
radio($('#grTime'), 'data-t', (v) => { G.timing = v; });
function readout() { const ov = (G.dens * G.size) / 1000, df = 1000 / G.size; $('#grRead').textContent = `overlap ≈ ${ov.toFixed(ov < 10 ? 1 : 0)} grains sounding · Δt = ${G.size.toFixed(G.size < 10 ? 1 : 0)} ms → Δf ≈ 1/Δt ≈ ${df < 1000 ? df.toFixed(0) + ' Hz' : (df / 1000).toFixed(1) + ' kHz'}`; }
readout();

// ---------- the scheduler: look-ahead, grains created ~100 ms before they sound
let grainTimer = 0, nextT = 0, lastT = 0, active = 0; const recent = [];
const grainOn = () => !!grainTimer;
function spawn(t) {
  if (!buf || active > 160) return;
  const D = buf.duration, dur = G.size / 1000, rate = 2 ** ((G.pitch + (Math.random() * 2 - 1) * (G.pitchSpread / 100)) / 12), need = dur * rate, rv = Math.random() < G.rev;
  const p = clamp(G.pos + (Math.random() * 2 - 1) * G.spray, 0, 1), start = Math.min(p * D, Math.max(0, D - need)), off = rv ? Math.max(0, D - start - need) : start;
  const src = ctx.createBufferSource(); src.buffer = rv ? revBuf : buf; src.playbackRate.value = rate;
  const g = ctx.createGain(), pan = ctx.createStereoPanner(), ov = (G.dens * G.size) / 1000, norm = 1 / Math.sqrt(Math.max(1, ov));
  g.gain.value = 0; g.gain.setValueCurveAtTime(WIN[G.win].map((v) => v * norm), t, dur); g.gain.setValueAtTime(0, t + dur + 0.001);
  pan.pan.value = (Math.random() * 2 - 1) * G.pan; src.connect(g); g.connect(pan); pan.connect(grainOut);
  src.start(t, off, Math.min(need, D - off)); src.stop(t + dur + 0.01); active++; src.onended = () => { active--; src.disconnect(); g.disconnect(); pan.disconnect(); };
  recent.push({ t, dur, p: start / D, w: need / D }); if (recent.length > 200) recent.shift();
}
function schedule() {
  const now = ctx.currentTime; if (nextT < now) nextT = now + 0.02;
  while (nextT < now + 0.12) {
    if (G.scan) { G.pos += G.scan * (nextT - lastT); G.pos = ((G.pos % 1) + 1) % 1; } lastT = nextT;
    spawn(nextT); nextT += G.timing === 'rnd' ? -Math.log(1 - Math.random()) / G.dens : 1 / G.dens;
  }
}
function grainToggle(on) {
  const b = $('#grPlay'); b.setAttribute('aria-pressed', String(on)); b.textContent = on ? '■ Stop cloud' : '▶ Start cloud'; if (W.src === 'grain') setWsBtn(on);
  if (on) { engine(); routeGrains(); nextT = lastT = ctx.currentTime + 0.05; grainTimer = setInterval(schedule, 25); status('Granular cloud playing'); }
  else { clearInterval(grainTimer); grainTimer = 0; status('Cloud stopped'); }
}
$('#grPlay').addEventListener('click', () => grainToggle(!grainOn()));

// ---------- source waveform with the position, the spray band and the grains that are sounding
let peaks = null, peaksDirty = true, peaksW = 0;
function computePeaks(w) { const d = buf.getChannelData(0), n = d.length; peaks = new Float32Array(w * 2); for (let x = 0; x < w; x++) { const a = Math.floor((x / w) * n), b = Math.max(a + 1, Math.floor(((x + 1) / w) * n)); let mn = 1, mx = -1; const st = Math.max(1, Math.floor((b - a) / 64)); for (let i = a; i < b; i += st) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; } peaks[2 * x] = mn; peaks[2 * x + 1] = mx; } peaksW = w; peaksDirty = false; }
function drawWave() {
  const [g, w, h, d] = fit($('#wave')), cs = { b: css('--border'), m: css('--muted'), p: css('--primary'), f: css('--fg') }; g.clearRect(0, 0, w, h);
  g.strokeStyle = cs.b; g.lineWidth = d; g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();
  if (!buf) { g.fillStyle = cs.m; g.font = `${13 * d}px system-ui`; g.fillText('Choose a source or press Start cloud', 14 * d, h / 2 - 8 * d); return; }
  if (peaksDirty || peaksW !== w) computePeaks(w);
  g.fillStyle = cs.m; g.globalAlpha = 0.75; for (let x = 0; x < w; x++) { const y0 = (0.5 - peaks[2 * x + 1] / 2) * h, y1 = (0.5 - peaks[2 * x] / 2) * h; g.fillRect(x, y0, 1, Math.max(1, y1 - y0)); } g.globalAlpha = 1;
  g.fillStyle = cs.p; g.globalAlpha = 0.12; g.fillRect(clamp(G.pos - G.spray, 0, 1) * w, 0, (clamp(G.pos + G.spray, 0, 1) - clamp(G.pos - G.spray, 0, 1)) * w, h); g.globalAlpha = 1;
  if (ctx) { const now = ctx.currentTime; g.fillStyle = cs.p; for (const r of recent) { const age = now - r.t; if (age < 0 || age > r.dur + 0.05) continue; g.globalAlpha = 0.55 * (1 - clamp(age / (r.dur + 0.05), 0, 1)) + 0.1; g.fillRect(r.p * w, h * 0.12, Math.max(2 * d, r.w * w), h * 0.76); } g.globalAlpha = 1; }
  g.strokeStyle = cs.p; g.lineWidth = 2.5 * d; g.beginPath(); g.moveTo(G.pos * w, 0); g.lineTo(G.pos * w, h); g.stroke();
}
{ const cv = $('#wave'); let dn = false; const mv = (e) => { const r = cv.getBoundingClientRect(); G.pos = clamp((e.clientX - r.left) / r.width, 0, 1); SL.pos.set(G.pos); };
  cv.addEventListener('pointerdown', (e) => { e.preventDefault(); cv.setPointerCapture(e.pointerId); dn = true; mv(e); }); cv.addEventListener('pointermove', (e) => { if (dn) mv(e); }); for (const ev of ['pointerup', 'pointercancel']) cv.addEventListener(ev, () => { dn = false; }); }

// ================================================================= main loop
function frame(now) { drawCurve(); drawScope(); drawSpec(now); drawWave(); if (G.scan && grainOn()) SL.pos.set(G.pos); requestAnimationFrame(frame); }
setPreset('identity');
useSweep();
requestAnimationFrame(frame);
window.__granular = { ctx: () => ctx, specAn: () => specAn, postAn: () => postAn, W, G, curve, active: () => active, recent };
