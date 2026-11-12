// Mosaicus — sintetizzatore: una sola sorgente di suono, più modi di suonarla.
//
//  • Timbro: somma di 8 armoniche (sintesi additiva). Le forme d'onda classiche sono ricette
//    di armoniche (serie di Fourier); gli strumenti sono ricette approssimate.
//  • Inviluppo: come il suono nasce e si spegne. Continuo (organo), Pizzicato (corda pizzicata),
//    Campana (colpo che si smorza lentamente): smorzamento esponenziale con costante di tempo τ.
//  • Volume pareggiato: ogni timbro suona con lo stesso valore efficace (RMS), così si confronta
//    il timbro e non il volume.
//  • Come lo suoni: 🎹 tastiera (frequenza esatta, secondo suono per i battimenti), ✋ nastro col dito,
//    📱 inclinazione del telefono, 📡 distanza della mano dall'HC-SR04 (Arduino). Con le ultime tre
//    la posizione diventa n semitoni e f = 440 · 2^(n/12); con una scala n si aggancia alle note.
//
// Il motore è unico per tutta l'app: in modalità tastiera continua a suonare anche cambiando
// pagina, così lo si guarda con l'oscilloscopio (sorgente «Esempi», che legge l'uscita dell'app).

import { audio, periodicWave, audioSupported, monitorAnalyser, readSamples, sampleRate } from './audio.js';
import { noteOf, noteFreq, snapToScale, NOTE_IT, TIMBRES, synth, findTrigger } from './dsp.js';
import { Screen, fmtIt } from './screen.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* niente */ } },
};

// ---------------------------------------------------------------------------
// Ricette dei timbri
// ---------------------------------------------------------------------------
const odd = (f) => Array.from({ length: 8 }, (_, k) => ((k + 1) % 2 ? f(k + 1) : 0));
/** Forme d'onda classiche: suonano con l'oscillatore "vero" (tutte le armoniche); i cursori ne mostrano le prime 8. */
const WAVES = {
  sinusoide: { label: 'Sinusoide', type: 'sine', amps: [1, 0, 0, 0, 0, 0, 0, 0], d: 'M2 12 C6 2 10 2 14 12 S22 22 26 12' },
  quadra: { label: 'Quadra', type: 'square', amps: odd((n) => 1 / n), d: 'M2 17 V5 H14 V17 H26 V5' },
  triangolare: { label: 'Triangolare', type: 'triangle', amps: odd((n) => 1 / (n * n)), d: 'M2 12 L8 4 L20 20 L26 12' },
  dente: { label: 'Dente di sega', type: 'sawtooth', amps: Array.from({ length: 8 }, (_, k) => 1 / (k + 1)), d: 'M2 18 L14 4 V18 L26 4 V18' },
};
const INSTR = ['flauto', 'clarinetto', 'violino', 'voce', 'organo'];
const instrLabel = (id) => TIMBRES[id].label.replace(', vocale «a»', ' «a»');

/** Valore efficace (RMS) della forma d'onda normalizzata a picco 1, come fa Web Audio. */
function rmsOf(amps, signs = null) {
  const n = 2048, y = synth(amps, 1, n, n, { phases: signs ? signs.map((s) => (s < 0 ? Math.PI : 0)) : null });
  let s = 0; for (let i = 0; i < n; i++) s += y[i] * y[i];
  return Math.sqrt(s / n);
}
// per le forme d'onda classiche l'RMS si calcola con molte armoniche (come l'oscillatore vero)
const NH = 128;                                 // armoniche della forma classica (l'oscillatore vero a 220 Hz ne ha circa 100)
const many = (f, N = NH) => Array.from({ length: N }, (_, k) => f(k + 1));
/** Coefficiente (con segno) della k-esima armonica delle forme classiche, come le calcola Web Audio. */
const waveCoef = (type, k) => type === 'sine' ? (k === 1 ? 1 : 0)
  : type === 'square' ? (k % 2 ? 1 / k : 0)
  : type === 'triangle' ? (k % 2 ? (((k - 1) / 2) % 2 ? -1 : 1) / (k * k) : 0)
  : (k % 2 ? 1 : -1) / k;                       // dente di sega (rampa che sale)
const RMS_WAVE = {
  sine: Math.SQRT1_2,
  square: rmsOf(many((n) => (n % 2 ? 1 / n : 0))),
  triangle: rmsOf(many((n) => (n % 2 ? 1 / (n * n) : 0)), many((n) => ((n - 1) / 2) % 2 ? -1 : 1)),
  sawtooth: rmsOf(many((n) => 1 / n)),
};

// ---------------------------------------------------------------------------
// Inviluppi
// ---------------------------------------------------------------------------
const ENV = {
  continuo: { label: 'Continuo', attack: 0.015, tau: Infinity, d: 'M2 18 L5 6 H23 L26 18' },
  pizzicato: { label: 'Pizzicato', attack: 0.005, tau: 0.25, d: 'M2 18 L4 4 C8 13 12 17 26 18' },
  campana: { label: 'Campana', attack: 0.003, tau: 1.2, d: 'M2 18 L4 4 C12 8 18 14 26 17' },
};

// ---------------------------------------------------------------------------
// Motore (unico per tutta l'app)
// ---------------------------------------------------------------------------
const DEF = { preset: 'sinusoide', amps: [...WAVES.sinusoide.amps], sgn: Array(8).fill(1), tail: [], env: 'continuo', f: 440, vol: 0.6, two: false, df: 3, mode: 'keys', scale: 'pentatonica', range: 'Do4–Do6' };
const saved = store.get('mosaicus.synth', null) || (() => { const g = store.get('mosaicus.gen', {}); return { f: g.f, vol: g.vol }; })();
const SY = { ...DEF, ...Object.fromEntries(Object.entries(saved || {}).filter(([k, v]) => k in DEF && v != null)), on: false };
/** Fissa segni e armoniche 9…64 della forma classica: toccando un cursore la "forma libera" parte dall'onda esatta. */
function classicTail(id) {
  const w = WAVES[id];
  SY.sgn = Array.from({ length: 8 }, (_, i) => (w && waveCoef(w.type, i + 1) < 0 ? -1 : 1));
  SY.tail = w ? Array.from({ length: NH - 8 }, (_, i) => waveCoef(w.type, i + 9)) : [];
}
if (WAVES[SY.preset]) classicTail(SY.preset);
/** Coefficienti (con segno) di tutte le armoniche del timbro attuale: quelli da cui nasce il suono. */
const fullCoefs = () => {
  const w = WAVES[SY.preset];
  return w ? many((k) => waveCoef(w.type, k), NH) : SY.amps.map((a, i) => a * (SY.sgn[i] || 1)).concat(SY.tail);
};
export const synthCoefs = fullCoefs;           // aggancio per le prove automatiche
const save = () => { const o = {}; Object.keys(DEF).forEach((k) => (o[k] = SY[k])); store.set('mosaicus.synth', o); };
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn(SY));

class SynthVoice {
  constructor() {
    const { ctx, master } = audio();
    this.c = ctx;
    this.osc = ctx.createOscillator();
    this.g = ctx.createGain(); this.g.gain.value = 0;
    this.osc.connect(this.g); this.g.connect(master);
    this.osc.start();
    this.timbre();
  }
  /** Applica il timbro attuale e restituisce il fattore che pareggia il volume. */
  timbre() {
    const w = WAVES[SY.preset];
    if (w) { this.osc.type = w.type; this.eq = Math.SQRT1_2 / RMS_WAVE[w.type]; }
    else { const c = fullCoefs(); this.osc.setPeriodicWave(periodicWave(c)); this.eq = Math.SQRT1_2 / (rmsOf(c) || 1); }
  }
  level() { return Math.min(0.9, 0.42 * SY.vol * this.eq); }
  freq(f, glide = 0.012) { this.osc.frequency.setTargetAtTime(f, this.c.currentTime, glide); }
  /** Attacco (e, per pizzicato/campana, smorzamento esponenziale con costante di tempo τ). */
  on(f) {
    const t = this.c.currentTime, e = ENV[SY.env], g = this.g.gain;
    if (f) this.osc.frequency.setValueAtTime(f, t);
    g.cancelScheduledValues(t); g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(this.level(), t + e.attack);
    if (isFinite(e.tau)) g.setTargetAtTime(0, t + e.attack, e.tau);
  }
  /** Aggiorna il volume di una nota che sta suonando (solo inviluppo continuo). */
  relevel() { if (SY.env === 'continuo' && this.sounding) { const g = this.g.gain; g.cancelScheduledValues(this.c.currentTime); g.setTargetAtTime(this.level(), this.c.currentTime, 0.02); } }
  off(fast = false) { const g = this.g.gain, t = this.c.currentTime; g.cancelScheduledValues(t); g.setValueAtTime(g.value, t); g.setTargetAtTime(0, t, fast ? 0.02 : 0.06); }
  dispose() { this.off(true); const o = this.osc, g = this.g; setTimeout(() => { try { o.stop(); o.disconnect(); g.disconnect(); } catch { /* già fermo */ } }, 300); }
}
let V1 = null, V2 = null;
const voices = () => [V1, V2].filter(Boolean);
function ensureVoices() {
  if (!audioSupported()) return false;
  if (!V1) V1 = new SynthVoice();
  if (SY.mode === 'keys' && SY.two) { if (!V2) V2 = new SynthVoice(); } else if (V2) { V2.dispose(); V2 = null; }
  return true;
}
function retimbre() { voices().forEach((v) => { v.timbre(); v.relevel(); }); }

/** Nota: f (e f + Δf se c'è il secondo suono). Restituisce false se l'audio non è disponibile. */
function noteOn(f) {
  if (!ensureVoices()) return false;
  SY.f = f;
  V1.on(f); V1.sounding = true;
  if (V2) { V2.on(f + SY.df); V2.sounding = true; }
  SY.on = SY.env === 'continuo'; notify();
  return true;
}
function glideTo(f) { SY.f = f; V1?.freq(f); V2?.freq(f + SY.df); }
function noteOff(fast = false) { voices().forEach((v) => { v.off(fast); v.sounding = false; }); SY.on = false; notify(); }

// ---- interfaccia verso il resto dell'app (spia in alto, oscilloscopio)
export const generatorOn = () => SY.on;
export const generatorState = () => SY;
export function onGeneratorChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function stopGenerator() { noteOff(true); }

// ---------------------------------------------------------------------------
// Tastiera di due ottave
// ---------------------------------------------------------------------------
function keyboardHTML(lowN = -9, octaves = 2) {
  const whites = [], blacks = [];
  let w = 0;
  for (let s = 0; s <= octaves * 12; s++) {
    const n = lowN + s, idx = ((n + 9) % 12 + 12) % 12, name = NOTE_IT[idx];
    const oct = 4 + Math.floor((n + 9) / 12);
    if (name.includes('♯')) blacks.push(`<button class="key black" data-n="${n}" style="--i:${w}" title="${name}${oct}"></button>`);
    else { whites.push(`<button class="key white" data-n="${n}" title="${name}${oct}"><span>${name === 'Do' ? `Do${oct}` : name}</span></button>`); w++; }
  }
  return `<div class="keys" style="--w:${w}">${whites.join('')}${blacks.join('')}</div>`;
}
const icon = (d) => `<svg viewBox="0 0 28 22" width="28" height="22" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

const FMIN = 20, FMAX = 4000;
const toSlider = (f) => Math.round((1000 * Math.log(f / FMIN)) / Math.log(FMAX / FMIN));
const fromSlider = (u) => FMIN * Math.pow(FMAX / FMIN, u / 1000);
const roundF = (f) => (f < 100 ? Math.round(f * 10) / 10 : Math.round(f));
const RANGES = { 'Do3–Do5': [-21, 3], 'Do4–Do6': [-9, 15], 'Do2–Do4': [-33, -9] };
const SCALE_LABEL = { continua: 'continua', cromatica: 'cromatica', maggiore: 'Do maggiore', pentatonica: 'pentatonica' };
const D_NEAR = 0.05, D_FAR = 0.5, V_SOUND = 343;
const MODES = [['keys', '🎹 Tastiera'], ['ribbon', '✋ Nastro'], ['tilt', '📱 Inclinazione'], ['sonar', '📡 Ultrasuoni']];

// ---------------------------------------------------------------------------
// Pannello
// ---------------------------------------------------------------------------
export function createSynth(el, api) {
  if (!RANGES[SY.range]) SY.range = 'Do4–Do6';
  const L = { u: null, n: NaN, d: NaN, tilt: null, dBuf: [], acq: false, tiltOn: false, lastNote: null, raf: 0, dead: false, buf: null, last: 0 };

  el.innerHTML = `
  <div class="card syn-top">
    <div class="gen-display"><b class="sy-note">—</b><span class="sy-f"></span><em class="sy-extra"></em></div>
    <button class="btn btn-play big sy-play">▶ Suona</button>
    <label class="vol">🔈 <input type="range" class="sy-vol" min="0" max="1" step="0.01" aria-label="Volume"> 🔊</label>
  </div>

  <div class="card syn-timbre">
    <h3>Timbro</h3>
    <div class="syn-tgrid">
      <div class="screen-wrap"><canvas class="sy-scr" aria-label="Forma d'onda"></canvas></div>
      <div class="harm-sliders">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<label><input type="range" class="vs" min="0" max="1" step="0.01" data-n="${n}" aria-label="Ampiezza dell'armonica ${n}"><b>${n}</b><small class="hv"></small></label>`).join('')}</div>
    </div>
    <div class="syn-presets">
      <div class="seg wave" role="group" aria-label="Forme d'onda">${Object.entries(WAVES).map(([id, w]) => `<button data-preset="${id}" title="${w.label}">${icon(w.d)}<span>${w.label}</span></button>`).join('')}</div>
      <div class="syn-instr">${INSTR.map((id) => `<button class="btn btn-small" data-preset="${id}">${instrLabel(id)}</button>`).join('')}<span class="sy-free" hidden>✎ forma libera</span></div>
    </div>
    <div class="syn-env">
      <span class="mini">inviluppo</span>
      <div class="seg wave env" role="group" aria-label="Inviluppo">${Object.entries(ENV).map(([id, e]) => `<button data-env="${id}" title="${e.label}">${icon(e.d)}<span>${e.label}</span></button>`).join('')}</div>
    </div>
    <details class="sub harm-f"><summary><span>La formula</span></summary><p class="harm-eq"></p></details>
  </div>

  <div class="card syn-play">
    <div class="seg modes" role="group" aria-label="Come lo suoni">${MODES.map(([id, l]) => `<button data-mode="${id}">${l}</button>`).join('')}</div>
    <div class="mode-keys">
      ${keyboardHTML(-9, 2)}
      <div class="gen-freq">
        <button class="btn btn-small" data-step="-1" title="−1 Hz">−</button>
        <input type="range" class="fr" min="0" max="1000" step="1" aria-label="Frequenza">
        <button class="btn btn-small" data-step="1" title="+1 Hz">+</button>
        <input type="number" class="fnum" min="${FMIN}" max="${FMAX}" step="0.1" aria-label="Frequenza in hertz">
      </div>
      <div class="two">
        <label class="tog"><input type="checkbox" class="two-on"> ＋ secondo suono</label>
        <span class="two-ctrl">f₂ = f + Δf &nbsp;<input type="range" class="dfr" min="-10" max="10" step="0.5" aria-label="Differenza di frequenza"> <b class="df-v"></b></span>
        <p class="beats"></p>
      </div>
    </div>
    <div class="mode-hand">
      <div class="ribbon" data-prevent-swipe><canvas aria-label="Nastro delle note"></canvas></div>
      <p class="hint in-hint"></p>
      <div class="ictrl">
        <label class="mini">note <select class="irange">${Object.keys(RANGES).map((r) => `<option>${r}</option>`).join('')}</select></label>
        <div class="seg iscale" role="group" aria-label="Scala">${Object.entries(SCALE_LABEL).map(([k, l]) => `<button data-scale="${k}">${l}</button>`).join('')}</div>
      </div>
    </div>
    <p class="hint gen-tip">La differenza tra i timbri si sente meglio tra 300 e 1000 Hz: l'altoparlante del telefono quasi non riproduce le note basse.</p>
  </div>`;

  const $ = (s) => el.querySelector(s);
  const scr = new Screen($('.sy-scr'), { divX: 8, divY: 4 });
  const sliders = [...el.querySelectorAll('.vs')];
  const rib = $('.ribbon canvas');

  // ---------------- timbro ----------------
  function setPreset(id) {
    SY.preset = id;
    SY.amps = [...(WAVES[id]?.amps || TIMBRES[id]?.amps || SY.amps)];
    classicTail(id);
    save(); retimbre(); paint();
  }
  sliders.forEach((s) => {
    s.addEventListener('input', () => { SY.amps[+s.dataset.n - 1] = +s.value; SY.preset = 'libera'; save(); retimbre(); paint(); });
    s.addEventListener('pointerup', () => s.blur());
  });
  el.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { setPreset(b.dataset.preset); if (SY.mode === 'keys' && SY.env !== 'continuo') noteOn(SY.f); }));
  el.querySelectorAll('[data-env]').forEach((b) => b.addEventListener('click', () => {
    SY.env = b.dataset.env; save();
    if (SY.on && SY.env !== 'continuo') noteOff();
    if (SY.mode === 'keys' && SY.env !== 'continuo') noteOn(SY.f);       // fa sentire subito l'inviluppo
    paint();
  }));

  // ---------------- tastiera ----------------
  const setF = (f, exact = false) => {
    f = Math.min(FMAX, Math.max(FMIN, exact ? Math.round(f * 100) / 100 : roundF(f)));
    SY.f = f; save(); glideTo(f); paint(); notify();
  };
  el.querySelectorAll('.key').forEach((k) => k.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    setF(noteFreq(+k.dataset.n), true);
    if (!noteOn(SY.f)) api.toast('Questo browser non supporta l\'audio.');
    paint();
  }));
  $('.fr').addEventListener('input', (e) => setF(fromSlider(+e.target.value)));
  $('.fnum').addEventListener('change', (e) => { const v = parseFloat(String(e.target.value).replace(',', '.')); if (isFinite(v)) setF(v); else paint(); });
  el.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => setF(SY.f + +b.dataset.step)));
  $('.two-on').addEventListener('change', (e) => { SY.two = e.target.checked; save(); const was = SY.on; ensureVoices(); if (was) noteOn(SY.f); paint(); });
  $('.dfr').addEventListener('input', (e) => { SY.df = +e.target.value; save(); V2?.freq(SY.f + SY.df); paint(); });
  $('.sy-vol').addEventListener('input', (e) => { SY.vol = +e.target.value; save(); voices().forEach((v) => v.relevel()); });

  // ---------------- con la mano: nastro, inclinazione, ultrasuoni ----------------
  function setU(u, retrigger = false) {
    if (u == null || !isFinite(u)) { L.u = null; paint(); return; }
    L.u = Math.min(1, Math.max(0, u));
    const [a, b] = RANGES[SY.range];
    let f = noteFreq(a + L.u * (b - a));
    if (SY.scale !== 'continua') f = snapToScale(f, SY.scale);
    L.n = 12 * Math.log2(f / 440);
    const changed = L.lastNote == null || Math.abs(L.n - L.lastNote) > 0.01;
    // con pizzicato o campana, ogni nota nuova della scala è un nuovo "colpo"
    if (retrigger || (SY.env !== 'continuo' && SY.scale !== 'continua' && changed && L.playing)) { noteOn(f); }
    else if (L.playing) glideTo(f);
    else SY.f = f;
    L.lastNote = L.n;
    paint();
  }
  let down = false;
  const uFrom = (e) => { const r = rib.getBoundingClientRect(); return (e.clientX - r.left) / r.width; };
  rib.addEventListener('pointerdown', (e) => {
    if (SY.mode !== 'ribbon') return;
    down = true; rib.setPointerCapture(e.pointerId); L.playing = true; setU(uFrom(e), true);
  });
  rib.addEventListener('pointermove', (e) => { if (down) setU(uFrom(e)); });
  const up = () => { if (down) { down = false; L.playing = false; noteOff(); paint(); } };
  rib.addEventListener('pointerup', up); rib.addEventListener('pointercancel', up);

  const onTilt = (e) => { if (e.gamma == null) return; L.tilt = e.gamma; setU((Math.max(-45, Math.min(45, e.gamma)) + 45) / 90); };
  async function startTilt() {
    if (!('DeviceOrientationEvent' in window)) { api.toast('Questo dispositivo non ha il sensore di inclinazione.'); return false; }
    if (!window.isSecureContext) { api.toast('Il sensore di inclinazione funziona solo da una pagina sicura (https).'); return false; }
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try { if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') { api.toast('Permesso per i sensori negato.'); return false; } } catch { return false; }
    }
    window.addEventListener('deviceorientation', onTilt); L.tiltOn = true;
    return true;
  }
  const stopTilt = () => { window.removeEventListener('deviceorientation', onTilt); L.tiltOn = false; };

  function onLine(line) {
    if (SY.mode !== 'sonar' || !L.acq || !line.startsWith('S,')) return false;
    const echo = Number(line.split(',')[2]);
    if (!(echo > 0)) return true;
    const d = (echo * 1e-6 * V_SOUND) / 2;
    if (d > 1.2) return true;
    L.dBuf.push(d); if (L.dBuf.length > 3) L.dBuf.shift();
    L.d = [...L.dBuf].sort((p, q) => p - q)[L.dBuf.length >> 1];       // mediana di 3: toglie i salti
    setU(1 - (L.d - D_NEAR) / (D_FAR - D_NEAR));
    return true;
  }

  // ---------------- ▶ Suona ----------------
  async function stopHand() {
    stopTilt();
    if (L.acq) { L.acq = false; try { await api.send('STOP'); } catch { /* scollegato */ } }
    L.playing = false;
  }
  $('.sy-play').addEventListener('click', async () => {
    if (SY.mode === 'keys') {
      if (SY.on) noteOff(); else if (!noteOn(SY.f)) api.toast('Questo browser non supporta l\'audio.');
      paint(); return;
    }
    if (L.playing || L.acq || L.tiltOn) { await stopHand(); noteOff(); paint(); return; }
    if (SY.mode === 'tilt') { if (!(await startTilt())) return; L.playing = true; setU(L.u ?? 0.5, true); }
    if (SY.mode === 'sonar') {
      if (!api.ready()) { api.toast('Prima collega Arduino (o il simulatore) con i pulsanti in alto.'); return; }
      L.acq = true; L.dBuf = []; L.playing = true; await api.send('START,SONAR,30'); noteOn(SY.f);
    }
    paint();
  });

  el.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', async () => {
    await stopHand(); noteOff(true);
    SY.mode = b.dataset.mode; save(); L.u = null; L.n = NaN; L.lastNote = null; ensureVoices(); paint(); api.onSource?.(SY.mode);
  }));
  el.querySelectorAll('[data-scale]').forEach((b) => b.addEventListener('click', () => { SY.scale = b.dataset.scale; save(); setU(L.u); }));
  $('.irange').addEventListener('change', (e) => { SY.range = e.target.value; save(); setU(L.u); });
  el.querySelectorAll('input[type=range]').forEach((r) => r.addEventListener('pointerup', () => r.blur()));

  // ---------------- disegno ----------------
  function drawRibbon() {
    const r = rib.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width) return;
    rib.width = Math.round(r.width * dpr); rib.height = Math.round(r.height * dpr);
    const g = rib.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height, k = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 15) / 15;
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--screen').trim() || '#00302A'; g.fillRect(0, 0, W, H);
    const [a, b] = RANGES[SY.range];
    const xOf = (n) => ((n - a) / (b - a)) * W;
    const deg = { cromatica: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], maggiore: [0, 2, 4, 5, 7, 9, 11], pentatonica: [0, 2, 4, 7, 9], continua: [0, 2, 4, 5, 7, 9, 11] }[SY.scale];
    g.font = `500 ${11 * k}px "Plus Jakarta Sans", system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
    for (let n = Math.ceil(a); n <= b; n++) {
      const c = ((n + 9) % 12 + 12) % 12, isDo = c === 0, inScale = deg.includes(c);
      const X = Math.round(xOf(n)) + 0.5;
      g.strokeStyle = isDo ? 'rgba(198,244,50,0.6)' : inScale ? 'rgba(198,244,50,0.28)' : 'rgba(255,255,255,0.07)';
      g.lineWidth = isDo ? 2 : 1;
      g.beginPath(); g.moveTo(X, 4); g.lineTo(X, H - 18 * k); g.stroke();
      if (inScale && (SY.scale !== 'cromatica' || isDo || W > 700)) {
        g.fillStyle = isDo ? '#C6F432' : 'rgba(198,244,50,0.7)';
        const lab = isDo ? `${NOTE_IT[c]}${4 + Math.floor((n + 9) / 12)}` : NOTE_IT[c], hw = g.measureText(lab).width / 2 + 2;
        g.fillText(lab, Math.min(W - hw, Math.max(hw, X)), H - 3);
      }
    }
    if (L.u != null) {
      const X = isFinite(L.n) ? xOf(L.n) : L.u * W, R = 14 * Math.sqrt(k);
      g.shadowColor = '#C6F432'; g.shadowBlur = L.playing ? 18 : 0;
      g.fillStyle = L.playing ? '#C6F432' : 'rgba(198,244,50,0.45)';
      g.beginPath(); g.arc(X, (H - 18 * k) / 2 + 2, R, 0, 2 * Math.PI); g.fill(); g.shadowBlur = 0;
    }
  }

  /** Schermo: la forma d'onda vera (dall'uscita dell'app) se suona, altrimenti quella calcolata dalle armoniche. */
  function drawScreen() {
    let x, y, note = '';
    const an = audioSupported() && (SY.on || voices().some((v) => v.sounding)) ? monitorAnalyser() : null;
    if (an) {
      const buf = (L.buf = readSamples(an, L.buf)), sr = sampleRate(), N = buf.length;
      const per = sr / SY.f, span = Math.ceil(2 * per);
      let pk = 0; for (let i = N - 3 * span; i < N; i++) pk = Math.max(pk, Math.abs(buf[i]));
      if (pk > 0.003) {
        let t = findTrigger(buf, { level: 0, hyst: 0.3 * pk, edge: 1, from: N - 3 * span - Math.ceil(per), to: N - span });
        if (t < 0) t = N - span;
        const i0 = Math.floor(t);
        x = []; y = [];
        for (let i = 0; i <= span && i0 + i < N; i++) { x.push(((i - (t - i0)) / per)); y.push(buf[i0 + i] / pk); }
        note = 'dal vivo';
      }
    }
    if (!x) {
      const n = 400;
      const yy = synth(fullCoefs().slice(0, 96), 2, n, n);   // 2 periodi su 400 punti: oltre la 96ª armonica ci sarebbe aliasing
      x = Array.from({ length: n }, (_, i) => (i / n) * 2); y = Array.from(yy);
      note = 'calcolata';
    }
    scr.draw({ x0: 0, x1: 2, y0: -1.25, y1: 1.25, traces: [{ x, y, color: '#C6F432', width: 2.2, glow: true }], xLabel: '2 periodi', yLabel: '', note });
  }
  function loop(now) {
    if (L.dead) return;
    L.raf = requestAnimationFrame(loop);
    if (document.hidden || !el.offsetParent || now - L.last < 50) return;
    L.last = now; drawScreen();
  }

  function paint() {
    const f = SY.mode === 'keys' ? SY.f : isFinite(L.n) ? noteFreq(L.n) : NaN;
    const nt = isFinite(f) ? noteOf(f) : null;
    $('.sy-note').textContent = nt ? (SY.mode !== 'keys' && SY.scale === 'continua' && Math.abs(nt.cents) > 10 ? `≈ ${nt.label}` : nt.label) : '—';
    $('.sy-f').textContent = isFinite(f) ? `${fmtIt(f, f < 100 ? 1 : 0)} Hz` : '';
    $('.sy-extra').innerHTML = SY.mode === 'sonar' && isFinite(L.d) ? `mano a ${fmtIt(L.d * 100, 0)} cm`
      : SY.mode === 'tilt' && L.tilt != null ? `inclinazione ${fmtIt(L.tilt, 0)}°`
        : SY.mode !== 'keys' && isFinite(L.n) ? `n = ${fmtIt(L.n, SY.scale === 'continua' ? 1 : 0)} → f = 440·2<sup>n/12</sup>` : '';
    const live = SY.mode === 'keys' ? SY.on : L.playing || L.acq || L.tiltOn;
    const oneShot = SY.mode === 'keys' && SY.env !== 'continuo';
    $('.sy-play').textContent = live ? '■ Ferma' : oneShot ? '▶ Suona (un colpo)' : '▶ Suona';
    $('.sy-play').classList.toggle('on', live);
    $('.sy-play').hidden = SY.mode === 'ribbon';
    $('.sy-vol').value = SY.vol;
    // timbro
    sliders.forEach((s, i) => { s.value = SY.amps[i]; s.parentElement.querySelector('.hv').textContent = fmtIt(SY.amps[i], 2); });
    el.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('active', b.dataset.preset === SY.preset));
    $('.sy-free').hidden = SY.preset !== 'libera';
    el.querySelectorAll('[data-env]').forEach((b) => b.classList.toggle('active', b.dataset.env === SY.env));
    const terms = SY.amps.map((v, i) => (v ? { v, i, neg: SY.sgn[i] < 0 } : null)).filter(Boolean);
    const eq = terms.map((t, j) => `${t.neg ? (j ? ' − ' : '−') : (j ? ' + ' : '')}${fmtIt(t.v, 2)}·sin(${t.i ? t.i + 1 : ''}ωt)`).join('');
    $('.harm-eq').textContent = `y = ${eq || '0'}${SY.tail.some(Boolean) ? ' + … (continua con le armoniche più alte)' : ''}`;
    // modi
    el.querySelectorAll('[data-mode]').forEach((b) => b.classList.toggle('active', b.dataset.mode === SY.mode));
    $('.mode-keys').hidden = SY.mode !== 'keys';
    $('.mode-hand').hidden = SY.mode === 'keys';
    $('.fr').value = toSlider(SY.f); $('.fnum').value = SY.f;
    el.querySelectorAll('.key').forEach((k) => k.classList.toggle('on', SY.mode === 'keys' && Math.abs(1200 * Math.log2(SY.f / noteFreq(+k.dataset.n))) < 3));
    $('.two-on').checked = SY.two; $('.dfr').value = SY.df; $('.df-v').textContent = `${SY.df > 0 ? '+' : SY.df < 0 ? '−' : ''}${fmtIt(Math.abs(SY.df), 1)} Hz`;
    $('.two-ctrl').hidden = !SY.two;
    const fb = Math.abs(SY.df);
    $('.beats').innerHTML = SY.two ? (fb ? `battimenti: f<sub>b</sub> = |Δf| = <b>${fmtIt(fb, 1)} Hz</b> → un "wa" ogni <b>${fmtIt(1 / fb, 2)} s</b>` : 'Δf = 0: nessun battimento') : '';
    el.querySelectorAll('[data-scale]').forEach((b) => b.classList.toggle('active', b.dataset.scale === SY.scale));
    $('.irange').value = SY.range;
    $('.in-hint').textContent = {
      ribbon: 'Tieni premuto sul nastro e scorri: a destra le note alte.',
      tilt: 'Premi ▶ Suona e inclina il telefono a destra e a sinistra.',
      sonar: `Collega Arduino (o il simulatore), premi ▶ Suona e avvicina la mano al sensore (${D_NEAR * 100}–${D_FAR * 100} cm): più vicina, nota più alta.`,
    }[SY.mode] || '';
    drawRibbon();
  }

  const ro = new ResizeObserver(() => drawRibbon()); ro.observe(rib);
  const off = onGeneratorChange(() => paint());
  paint();
  L.raf = requestAnimationFrame(loop);

  return {
    onLine,
    destroy() {
      L.dead = true; cancelAnimationFrame(L.raf); off(); ro.disconnect(); scr.destroy();
      // la tastiera continua a suonare cambiando pagina; i modi "con la mano" si fermano
      if (SY.mode !== 'keys') { stopHand(); noteOff(true); }
    },
    linkChanged() { if (!api.ready() && L.acq) { L.acq = false; L.playing = false; noteOff(); paint(); } },
    refreshStyle() { drawRibbon(); },
  };
}
