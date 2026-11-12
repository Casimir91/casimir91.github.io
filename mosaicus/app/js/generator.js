// Mosaicus — generatore di suoni ed editor delle armoniche (sintesi additiva).
//
// Il generatore è unico per tutta l'app e continua a suonare anche se si cambia
// esperimento: così lo si può guardare con l'Oscilloscopio (sorgente «Generatore»)
// o con un altro telefono. Due voci: la seconda, se attiva, suona a f + Δf → battimenti.

import { Voice, audioSupported } from './audio.js';
import { noteOf, noteFreq, NOTE_IT, TIMBRES, synth } from './dsp.js';
import { Screen, fmtIt } from './screen.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* niente */ } },
};

const FMIN = 20, FMAX = 4000;
const G = { type: 'sine', f: 440, vol: 0.35, two: false, df: 3, amps: [...TIMBRES.violino.amps], on: false, v1: null, v2: null, ...pick(store.get('mosaicus.gen', {})) };
function pick(o) { const { type, f, vol, two, df, amps } = o; return Object.fromEntries(Object.entries({ type, f, vol, two, df, amps }).filter(([, v]) => v !== undefined)); }
const saveG = () => store.set('mosaicus.gen', pick(G));
const listeners = new Set();
const notify = () => listeners.forEach((fn) => fn(G));

export const generatorOn = () => G.on;
export const generatorState = () => G;
export function onGeneratorChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const isCustom = () => G.type === 'custom';
function applyVoices() {
  if (!G.on) return;
  if (!G.v1) G.v1 = new Voice({ type: isCustom() ? 'sine' : G.type, amps: isCustom() ? G.amps : null, freq: G.f, gain: G.vol });
  G.v1.setWave(G.type, isCustom() ? G.amps : null); G.v1.setFreq(G.f); G.v1.setLevel(G.two ? G.vol * 0.6 : G.vol); G.v1.start();
  if (G.two) {
    if (!G.v2) G.v2 = new Voice({ type: 'sine', freq: G.f + G.df, gain: 0 });
    G.v2.setWave(G.type, isCustom() ? G.amps : null); G.v2.setFreq(G.f + G.df); G.v2.setLevel(G.vol * 0.6); G.v2.start();
  } else if (G.v2) { G.v2.dispose(); G.v2 = null; }
}
export function startGenerator() { if (!audioSupported()) return false; G.on = true; applyVoices(); notify(); return true; }
export function stopGenerator() {
  G.on = false;
  G.v1?.dispose(); G.v2?.dispose(); G.v1 = G.v2 = null;
  notify();
}

// ---------------------------------------------------------------------------
// Icone delle forme d'onda (una sola riga di SVG ciascuna)
// ---------------------------------------------------------------------------
const WAVES = [
  ['sine', 'Sinusoide', 'M2 12 C6 2 10 2 14 12 S22 22 26 12'],
  ['square', 'Quadra', 'M2 17 V5 H14 V17 H26 V5'],
  ['triangle', 'Triangolare', 'M2 12 L8 4 L20 20 L26 12'],
  ['sawtooth', 'Dente di sega', 'M2 18 L14 4 V18 L26 4 V18'],
  ['custom', 'Armoniche', 'M2 12 C4 4 6 4 8 10 C9 13 11 6 13 9 C15 13 16 19 19 17 C22 15 23 10 26 12'],
];
const waveIcon = (d) => `<svg viewBox="0 0 28 22" width="28" height="22" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>`;

// ---------------------------------------------------------------------------
// Editor delle armoniche: 8 cursori verticali + ricette pronte + anteprima della forma d'onda
// ---------------------------------------------------------------------------
export function harmonicEditor(el, getAmps, onChange) {
  el.innerHTML = `
    <div class="harm">
      <div class="harm-presets">${Object.entries(TIMBRES).map(([id, t]) => `<button class="btn btn-small" data-preset="${id}">${t.label}</button>`).join('')}</div>
      <div class="harm-main">
        <div class="harm-sliders">${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<label><input type="range" class="vs" min="0" max="1" step="0.01" data-n="${n}" aria-label="Ampiezza dell'armonica ${n}"><b>${n}</b><small class="hv"></small></label>`).join('')}</div>
        <div class="harm-prev screen-wrap"><canvas aria-label="Forma d'onda risultante"></canvas></div>
      </div>
      <details class="sub harm-f"><summary><span>La formula</span></summary><p class="harm-eq"></p></details>
    </div>`;
  const scr = new Screen(el.querySelector('canvas'), { divX: 8, divY: 4 });
  const sliders = [...el.querySelectorAll('.vs')];
  function paint() {
    const a = getAmps();
    sliders.forEach((s, i) => { s.value = a[i]; s.parentElement.querySelector('.hv').textContent = fmtIt(a[i], 2); });
    const n = 400, y = synth(a, 2, n, n);      // due periodi
    const x = Array.from({ length: n }, (_, i) => i / n * 2);
    scr.draw({ x0: 0, x1: 2, y0: -1.25, y1: 1.25, traces: [{ x, y, color: '#C6F432', width: 2.2, glow: true }], xLabel: '2 periodi', yLabel: 'Σ Aₙ sin(n ω t)' });
    const terms = a.map((v, i) => (v ? `${fmtIt(v, 2)}·sin(${i ? `${i + 1}` : ''}ωt)` : null)).filter(Boolean);
    el.querySelector('.harm-eq').textContent = `y = ${terms.join(' + ') || '0'}`;
    el.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('active', TIMBRES[b.dataset.preset].amps.every((v, i) => Math.abs(v - a[i]) < 0.005)));
  }
  sliders.forEach((s) => s.addEventListener('input', () => { const a = getAmps().slice(); a[+s.dataset.n - 1] = +s.value; onChange(a); paint(); }));
  sliders.forEach((s) => s.addEventListener('pointerup', () => s.blur()));
  el.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => { onChange([...TIMBRES[b.dataset.preset].amps]); paint(); }));
  paint();
  return { paint, destroy: () => scr.destroy() };
}

// ---------------------------------------------------------------------------
// Tastiera di due ottave (Do4 – Do6)
// ---------------------------------------------------------------------------
export function keyboardHTML(lowN = -9, octaves = 2) {
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

// ---------------------------------------------------------------------------
// Pannello del generatore
// ---------------------------------------------------------------------------
const toSlider = (f) => Math.round((1000 * Math.log(f / FMIN)) / Math.log(FMAX / FMIN));
const fromSlider = (u) => FMIN * Math.pow(FMAX / FMIN, u / 1000);
const roundF = (f) => (f < 100 ? Math.round(f * 10) / 10 : Math.round(f));

export function createGenerator(el, api) {
  el.innerHTML = `
  <div class="card gen">
    <div class="gen-top">
      <div class="gen-display"><b class="gen-f"></b><span>Hz</span><em class="gen-note"></em></div>
      <button class="btn btn-play big gen-play">▶ Suona</button>
    </div>
    <div class="seg wave" role="group" aria-label="Forma d'onda">${WAVES.map(([id, l, d]) => `<button data-type="${id}" title="${l}">${waveIcon(d)}<span>${l}</span></button>`).join('')}</div>
    <div class="gen-freq">
      <button class="btn btn-small" data-step="-1" title="−1 Hz">−</button>
      <input type="range" class="fr" min="0" max="1000" step="1" aria-label="Frequenza">
      <button class="btn btn-small" data-step="1" title="+1 Hz">+</button>
      <input type="number" class="fnum" min="${FMIN}" max="${FMAX}" step="0.1" aria-label="Frequenza in hertz">
    </div>
    ${keyboardHTML(-9, 2)}
    <div class="gen-row">
      <label class="vol">🔈 <input type="range" class="vl" min="0" max="1" step="0.01" aria-label="Volume"> 🔊</label>
    </div>
    <div class="custom-box" hidden></div>
    <div class="two">
      <label class="tog"><input type="checkbox" class="two-on"> ＋ secondo suono</label>
      <span class="two-ctrl">f₂ = f + Δf &nbsp;<input type="range" class="dfr" min="-10" max="10" step="0.5" aria-label="Differenza di frequenza"> <b class="df-v"></b></span>
      <p class="beats"></p>
    </div>
    <p class="hint gen-tip">Suona anche se cambi esperimento: guardalo con l'Oscilloscopio, sorgente 🎛 Generatore.</p>
  </div>`;
  const $ = (s) => el.querySelector(s);
  let editor = null;

  function paint() {
    $('.gen-f').textContent = fmtIt(G.f, G.f < 100 ? 1 : 0);
    const nt = noteOf(G.f);
    $('.gen-note').textContent = nt ? `${nt.label}${nt.cents ? ` ${nt.cents > 0 ? '+' : '−'}${Math.abs(nt.cents)} cent` : ''}` : '';
    $('.fr').value = toSlider(G.f); $('.fnum').value = G.f;
    $('.vl').value = G.vol;
    $('.gen-play').textContent = G.on ? '■ Ferma' : '▶ Suona';
    $('.gen-play').classList.toggle('on', G.on);
    el.querySelectorAll('[data-type]').forEach((b) => b.classList.toggle('active', b.dataset.type === G.type));
    el.querySelectorAll('.key').forEach((k) => k.classList.toggle('on', Math.abs(1200 * Math.log2(G.f / noteFreq(+k.dataset.n))) < 3));
    $('.two-on').checked = G.two; $('.dfr').value = G.df; $('.df-v').textContent = `${G.df > 0 ? '+' : G.df < 0 ? '−' : ''}${fmtIt(Math.abs(G.df), 1)} Hz`;
    $('.two-ctrl').hidden = !G.two;
    const fb = Math.abs(G.df);
    $('.beats').innerHTML = G.two ? (fb ? `battimenti: f<sub>b</sub> = |Δf| = <b>${fmtIt(fb, 1)} Hz</b> → un "wa" ogni <b>${fmtIt(1 / fb, 2)} s</b>` : 'Δf = 0: nessun battimento') : '';
    $('.custom-box').hidden = !isCustom();
    if (isCustom() && !editor) editor = harmonicEditor($('.custom-box'), () => G.amps, (a) => { G.amps = a; saveG(); applyVoices(); });
    if (!isCustom() && editor) { editor.destroy(); editor = null; $('.custom-box').innerHTML = ''; }
  }
  const setF = (f, exact = false) => { G.f = Math.min(FMAX, Math.max(FMIN, exact ? Math.round(f * 100) / 100 : roundF(f))); saveG(); applyVoices(); paint(); notify(); };

  $('.gen-play').addEventListener('click', () => { if (G.on) stopGenerator(); else if (!startGenerator()) api.toast('Questo browser non supporta l\'audio.'); paint(); });
  el.querySelectorAll('[data-type]').forEach((b) => b.addEventListener('click', () => { G.type = b.dataset.type; saveG(); applyVoices(); paint(); }));
  $('.fr').addEventListener('input', (e) => setF(fromSlider(+e.target.value)));
  $('.fnum').addEventListener('change', (e) => { const v = parseFloat(String(e.target.value).replace(',', '.')); if (isFinite(v)) setF(v); else paint(); });
  el.querySelectorAll('[data-step]').forEach((b) => b.addEventListener('click', () => setF(G.f + +b.dataset.step)));
  el.querySelectorAll('.key').forEach((k) => k.addEventListener('click', () => { setF(noteFreq(+k.dataset.n), true); if (!G.on) { startGenerator(); paint(); } }));
  $('.vl').addEventListener('input', (e) => { G.vol = +e.target.value; saveG(); applyVoices(); });
  $('.two-on').addEventListener('change', (e) => { G.two = e.target.checked; saveG(); applyVoices(); paint(); });
  $('.dfr').addEventListener('input', (e) => { G.df = +e.target.value; saveG(); applyVoices(); paint(); });
  el.querySelectorAll('input[type=range]').forEach((r) => r.addEventListener('pointerup', () => r.blur()));
  paint();
  const off = onGeneratorChange(() => paint());
  return { destroy() { off(); editor?.destroy(); } };
}
