// Mosaicus — oscilloscopio.
//
// Due modalità con la stessa interfaccia:
//  • 'audio'   : microfono, generatore dell'app o suoni di esempio (Web Audio, ~48 000 campioni/s)
//  • 'arduino' : tensione su A0 catturata "a raffica" dal firmware (START,SCOPE,…), 400 campioni
//
// Schermo della forma d'onda con trigger, spettro con le armoniche, frequenza dalla
// autocorrelazione, nota musicale. «Congela» conserva fino a 3 tracce (A, B, C) sovrapposte,
// allineate sul trigger; si possono inviare a Elaborazione (forme d'onda e spettri).

import { Screen, niceDiv, fmtIt } from './screen.js';
import { pitch, spectrum, findTrigger, harmonics, noteOf, TIMBRES, sig } from './dsp.js';
import { micAnalyser, monitorAnalyser, readSamples, Voice, closeMic, audioSupported, sampleRate } from './audio.js';
import { generatorOn } from './generator.js';

const LIVE = '#C6F432';
const SLOT = [{ id: 'A' }, { id: 'B' }, { id: 'C' }];
/** Colore della traccia congelata: dipende dal tema (chiaro: zafferano, cielo, rosa; scuro: bianco, verde, grigio). */
const slotColor = (id) => getComputedStyle(document.documentElement).getPropertyValue(`--slot-${id.toLowerCase()}`).trim() || '#fff';
/** Tratteggio della traccia (nel tema scuro B e C sono tratteggiate: ci sono solo bianco e lime). */
const slotDash = (id) => { const v = getComputedStyle(document.documentElement).getPropertyValue(`--slot-${id.toLowerCase()}-dash`).trim(); return !v || v === 'none' ? null : v.split(/\s+/).map(Number); };
const WIN_STEPS = [2, 3, 4, 5, 6, 8, 10, 12, 15, 20, 25, 30, 40, 50];       // ms
const DT_STEPS = [20, 50, 100, 250, 500, 1000, 2500];                        // µs tra due campioni (Arduino)
const N_ARD = 400;
const KEEP_MS = 51;          // ms conservati dopo il trigger per ogni traccia
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* niente */ } },
};
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const EXAMPLES = [
  ['sinusoide', 'Diapason'], ['flauto', 'Flauto'], ['clarinetto', 'Clarinetto'], ['violino', 'Violino'], ['voce', 'Voce «a»'],
];

export function createScope(el, api) {
  const ard = api.mode === 'arduino';
  const pref = store.get(`mosaicus.scope.${api.mode}`, {});
  const S = {
    source: ard ? 'arduino' : null, analyser: null, buf: null,
    paused: !ard, showLive: true, winMs: pref.winMs ?? 10, edge: pref.edge ?? 1, same: pref.same ?? !ard,
    live: null, slots: [], fHist: [], yHalf: 0.05, fRef: 0,
    example: null, voices: [],
    dt: pref.dt ?? 100, level: pref.level ?? 2.5, single: pref.single ?? false, acq: false,
    qty: pref.qty ?? 'V', R: pref.R ?? 100, V0: pref.V0 ?? 0, circuit: pref.circuit ?? 'mic',
    lastTick: 0, nTick: 0, raf: 0, dead: false, msg: '',
  };
  const save = () => store.set(`mosaicus.scope.${api.mode}`, { winMs: S.winMs, edge: S.edge, same: S.same, dt: S.dt, level: S.level, single: S.single, qty: S.qty, R: S.R, V0: S.V0, circuit: S.circuit });

  el.innerHTML = `
  <div class="card scope-head">
    ${ard ? `
      <div class="ctrl-left">
        <label class="mini">circuito <select class="circuit">
          <option value="mic">Microfono del kit</option><option value="coil">Bobina e magnete</option><option value="lamp">Luce di una lampada</option></select></label>
      </div>` : `
      <div class="seg src" role="group" aria-label="Sorgente del segnale">
        <button data-src="mic">🎤 Microfono</button><button data-src="ex">🎻 Esempi</button>
      </div>`}
    <div class="readouts scope-ro"></div>
  </div>
  ${ard ? '' : `<div class="card examples" hidden><span class="ex-lab">La₃ = 220 Hz</span>${EXAMPLES.map(([id, l]) => `<button class="btn btn-small" data-ex="${id}">${l}</button>`).join('')}<button class="btn btn-small" data-ex="beats">Battimenti 440 + 443 Hz</button><span class="ex-gen" hidden>＋ 🎛 Generatore acceso</span></div>`}
  <div class="card scope-body">
    <div class="transport">
      <button class="btn btn-play big run"></button>
      <button class="btn btn-play big freeze" title="Ferma e conserva la traccia (fino a 3)">❄ Congela</button>
      <div class="slots"></div>
    </div>
    <div class="screen-wrap"><canvas class="cv-wave" aria-label="Forma d'onda"></canvas><div class="screen-msg"></div></div>
    <div class="knobs">
      ${ard ? `
        <label class="knob">⟷ <select class="dt">${DT_STEPS.map((d) => `<option value="${d}">${fmtIt((d * N_ARD) / 1000, 1)} ms</option>`).join('')}</select></label>
        <label class="knob">trigger <input type="range" class="lvl" min="0" max="5" step="0.01"> <b class="lvl-v"></b></label>
        <button class="btn btn-small lvl-mean" title="Trigger al valore medio del segnale">⌖ media</button>
        <div class="seg mode" role="group"><button data-single="0">continuo</button><button data-single="1">singolo</button></div>` : `
        <label class="knob">⟷ <input type="range" class="win" min="0" max="${WIN_STEPS.length - 1}" step="1"> <b class="win-v"></b></label>`}
      <div class="seg edge" role="group" aria-label="Trigger"><button data-edge="1" title="Trigger sul fronte di salita">↗</button><button data-edge="-1" title="Trigger sul fronte di discesa">↘</button><button data-edge="0" title="Senza trigger">⟿</button></div>
      <label class="tog"><input type="checkbox" class="same"> ↕ stessa altezza</label>
    </div>
    <div class="screen-wrap spec"><canvas class="cv-spec" aria-label="Spettro"></canvas></div>
    <div class="recipe"></div>
    <div class="send-bar">
      <button class="btn btn-go send">Invia le forme d'onda a Elaborazione →</button>
      <button class="btn btn-small send-spec">Invia gli spettri →</button>
    </div>
    ${ard ? `<details class="adv"><summary>Grandezza misurata</summary>
      <div class="params">
        <label class="param"><span>Grandezza</span><select class="qty"><option value="V">Tensione V − V₀</option><option value="I">Corrente I = (V − V₀)/R</option></select></label>
        <label class="param"><span>V₀ <em>(V)</em></span><input type="number" class="v0" step="0.01"></label>
        <label class="param"><span>R <em>(Ω)</em></span><input type="number" class="r" step="any" min="0.001"></label>
      </div></details>` : ''}
  </div>`;

  const $ = (s) => el.querySelector(s);
  const wave = new Screen($('.cv-wave'));
  const spec = new Screen($('.cv-spec'), { divX: 10, divY: 4 });

  // ---------------- controlli ----------------
  const setSeg = (sel, attr, val) => el.querySelectorAll(`${sel} [${attr}]`).forEach((b) => b.classList.toggle('active', b.getAttribute(attr) === String(val)));
  function syncControls() {
    setSeg('.edge', 'data-edge', S.edge);
    $('.same').checked = S.same;
    if (ard) {
      $('.dt').value = S.dt; $('.lvl').value = S.level; $('.lvl-v').textContent = `${fmtIt(S.level, 2)} V`;
      setSeg('.mode', 'data-single', S.single ? 1 : 0);
      $('.circuit').value = S.circuit; $('.qty').value = S.qty; $('.v0').value = S.V0; $('.r').value = S.R;
      $('.run').textContent = S.acq ? '■ Ferma' : '▶ Avvia';
      $('.run').classList.toggle('on', S.acq);
      api.setSimSignal?.(S.circuit);
    } else {
      const i = WIN_STEPS.indexOf(S.winMs);
      $('.win').value = i < 0 ? 6 : i; $('.win-v').textContent = `${S.winMs} ms`;
      setSeg('.src', 'data-src', S.source);
      $('.examples').hidden = S.source !== 'ex';
      $('.ex-gen').hidden = !generatorOn();
      el.querySelectorAll('[data-ex]').forEach((b) => b.classList.toggle('active', b.dataset.ex === S.example));
      const live = S.analyser && !S.paused;
      $('.run').textContent = live ? '❚❚ Pausa' : '▶ Avvia';
      $('.run').classList.toggle('on', !!live);
    }
    $('.freeze').disabled = S.slots.length >= 3 || !S.live || !S.showLive;
    $('.freeze').textContent = S.slots.length >= 3 ? '❄ Tre tracce: togline una' : '❄ Congela';
  }

  el.querySelectorAll('.edge [data-edge]').forEach((b) => b.addEventListener('click', () => { S.edge = +b.dataset.edge; save(); syncControls(); if (S.acq) restartAcq(); }));
  $('.same').addEventListener('change', (e) => { S.same = e.target.checked; save(); redraw(); });
  $('.freeze').addEventListener('click', freeze);
  $('.send').addEventListener('click', () => sendWaves());
  $('.send-spec').addEventListener('click', () => sendSpectra());
  if (ard) {
    $('.dt').addEventListener('change', (e) => { S.dt = +e.target.value; save(); if (S.acq) restartAcq(); });
    $('.lvl').addEventListener('input', (e) => { S.level = +e.target.value; $('.lvl-v').textContent = `${fmtIt(S.level, 2)} V`; redraw(); });
    $('.lvl').addEventListener('change', () => { save(); if (S.acq) restartAcq(); });
    el.querySelectorAll('.mode [data-single]').forEach((b) => b.addEventListener('click', () => { S.single = b.dataset.single === '1'; save(); syncControls(); if (S.acq) restartAcq(); }));
    $('.circuit').addEventListener('change', (e) => {
      S.circuit = e.target.value;
      // impostazioni di partenza adatte al circuito
      if (S.circuit === 'coil') Object.assign(S, { V0: 2.5, level: 2.6, single: true, dt: 100, edge: 1 });
      else Object.assign(S, { V0: 0, level: 2.45, single: false, dt: 50, edge: 1 });
      S.live = null; save(); syncControls(); redraw();
      if (S.acq) restartAcq();
    });
    $('.lvl-mean').addEventListener('click', () => {
      if (!S.live?.adc) { api.toast('Serve prima una traccia: ▶ Avvia.'); return; }
      const m = S.live.adc.reduce((a, b) => a + b, 0) / S.live.adc.length;
      S.level = Math.round((m / 1023) * 5 * 100) / 100; save(); syncControls(); redraw();
      if (S.acq) restartAcq();
    });
    $('.qty').addEventListener('change', (e) => { S.qty = e.target.value; save(); reconvert(); });
    $('.v0').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (isFinite(v)) S.V0 = v; save(); reconvert(); });
    $('.r').addEventListener('change', (e) => { const v = parseFloat(e.target.value); if (v > 0) S.R = v; save(); reconvert(); });
    $('.run').addEventListener('click', () => (S.acq ? stopAcq() : startAcq()));
  } else {
    $('.win').addEventListener('input', (e) => { S.winMs = WIN_STEPS[+e.target.value]; $('.win-v').textContent = `${S.winMs} ms`; save(); redraw(); });
    el.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', () => useSource(b.dataset.src)));
    el.querySelectorAll('[data-ex]').forEach((b) => b.addEventListener('click', () => playExample(b.dataset.ex)));
    $('.run').addEventListener('click', async () => {
      if (S.analyser && !S.paused) { S.paused = true; syncControls(); return; }        // ❚❚ Pausa
      if (!S.source) { await useSource(store.get('mosaicus.scope.src', 'mic') || 'mic'); return; }
      S.paused = false; S.showLive = true; S.fHist = []; syncControls();               // ▶ Avvia
    });
  }

  // ---------------- sorgenti audio ----------------
  async function useSource(src) {
    if (!audioSupported()) { api.toast('Questo browser non supporta l\'audio (Web Audio API).'); return; }
    if (src !== 'ex') stopExample();
    try {
      S.analyser = src === 'mic' ? await micAnalyser() : monitorAnalyser();
    } catch (e) {
      api.toast(`Microfono non disponibile: ${e.message}`, 5000);
      return;
    }
    S.source = src; S.paused = false; S.showLive = true; S.live = null; S.fHist = [];
    store.set('mosaicus.scope.src', src);
    syncControls();
    if (src === 'ex' && !S.example && !generatorOn()) playExample('violino');
  }

  function stopExample() { S.voices.forEach((v) => v.dispose()); S.voices = []; S.example = null; }
  function playExample(id) {
    if (S.example === id) { stopExample(); syncControls(); return; }
    stopExample();
    if (id === 'beats') S.voices = [new Voice({ type: 'sine', freq: 440, gain: 0.18 }), new Voice({ type: 'sine', freq: 443, gain: 0.18 })];
    else S.voices = [new Voice({ amps: TIMBRES[id].amps, freq: 220, gain: 0.3 })];
    S.voices.forEach((v) => v.start());
    S.example = id; S.fHist = [];
    S.paused = false; S.showLive = true;      // scegliere un esempio = volerlo vedere
    syncControls();
  }

  // ---------------- Arduino ----------------
  function acqCommand() {
    const lvl = Math.round((S.level / 5) * 1023);
    return `START,SCOPE,${S.dt},${N_ARD},${lvl},${S.edge},${S.single ? 0 : 1}`;
  }
  async function startAcq() {
    if (!api.ready()) { api.toast('Prima collega Arduino (o il simulatore) con i pulsanti in alto.'); return; }
    S.acq = true; S.showLive = true; syncControls();
    await api.send(acqCommand());
    S.msg = S.single && S.edge ? 'In attesa del trigger…' : '';
  }
  async function stopAcq() { if (!S.acq) return; S.acq = false; syncControls(); S.msg = ''; try { await api.send('STOP'); } catch { /* scollegato */ } }
  async function restartAcq() { await api.send('STOP'); await api.send(acqCommand()); }
  const toQty = (adc) => { const V = (adc * 5) / 1023 - S.V0; return S.qty === 'I' ? (V / S.R) * 1000 : V; };
  const unit = () => (ard ? (S.qty === 'I' ? 'mA' : 'V') : 'u.a.');
  function reconvert() {
    for (const f of [S.live, ...S.slots]) if (f?.adc) { f.y = Float32Array.from(f.adc, toQty); f.unit = unit(); analyse(f, true); }
    redraw();
  }

  function onLine(line) {
    if (!line.startsWith('W,')) return false;
    if (!S.acq) return true;
    const p = line.slice(2).split(',').map(Number);
    const [fired, dt] = p, adc = p.slice(2);
    if (adc.length < 8 || !(dt > 0)) return true;
    const fr = { adc, y: Float32Array.from(adc, toQty), sr: 1e6 / dt, off: 0, unit: unit(), fired: !!fired };
    analyse(fr, true);
    S.live = fr; S.msg = '';
    if (S.single) { stopAcq(); api.toast('Traccia catturata. ❄ Congela per conservarla.'); }
    syncControls(); redraw(); updateReadouts(true);
    return true;
  }

  // ---------------- analisi di una traccia ----------------
  function analyse(fr, full) {
    const sr = fr.sr;
    const pk = pitch(fr.pitchBuf || fr.y, sr, { fmin: ard ? Math.max(2, sr / fr.y.length * 2) : 50, fmax: Math.min(sr / 4, 5000), minRms: ard ? 0.002 : 0.004 });
    fr.f = pk?.f ?? NaN; fr.T = pk?.T ?? NaN; fr.clarity = pk?.clarity ?? 0;
    if (full || !fr.spec) {
      const s = spectrum(fr.specBuf || fr.y, sr, ard ? 2048 : null);
      const kmax = Math.min(s.mag.length, Math.ceil(Math.min(sr / 2, 10000) / s.df));
      fr.spec = { mag: s.mag.slice(0, kmax), df: s.df };
    }
    fr.recipe = isFinite(fr.f) ? harmonics(fr.spec.mag, fr.spec.df, fr.f, 8).map((h) => h.rel) : null;
    delete fr.pitchBuf; delete fr.specBuf;
    return fr;
  }

  function grabAudio() {
    const buf = (S.buf = readSamples(S.analyser, S.buf));
    const sr = sampleRate(), N = buf.length;
    let mean = 0; for (let i = N - 4096; i < N; i++) mean += buf[i]; mean /= 4096;
    const keep = Math.ceil((KEEP_MS / 1000) * sr);
    const span = Math.ceil(sr / 25);
    const to = N - keep, from = Math.max(1, to - span);
    let peak = 0; for (let i = from; i < N; i++) peak = Math.max(peak, Math.abs(buf[i] - mean));
    let trig = S.edge ? findTrigger(buf, { level: mean, hyst: 0.35 * peak, edge: S.edge, from, to }) : -1;
    if (trig < 0) trig = to;
    const i0 = Math.floor(trig);
    const fr = {
      y: buf.slice(i0, Math.min(N, i0 + keep + 1)), sr, off: trig - i0, unit: 'u.a.', peak,
      pitchBuf: buf.subarray(N - 4096),
    };
    const doSpec = S.nTick % 3 === 0 || !S.live?.spec;
    if (doSpec) fr.specBuf = buf; else fr.spec = S.live.spec;
    return analyse(fr, doSpec);
  }

  // ---------------- congela e slot ----------------
  function freeze() {
    if (!S.live || S.slots.length >= 3) return;
    const free = SLOT.find((s) => !S.slots.some((x) => x.id === s.id));
    const fr = S.live;
    const slot = { ...fr, y: fr.y.slice(), adc: fr.adc?.slice(), id: free.id, visible: true,
      name: ard ? `${free.id}` : S.source === 'ex' && S.example ? `${EX_NAME[S.example] || free.id}` : free.id };
    S.slots.push(slot);
    S.slots.sort((a, b) => a.id.localeCompare(b.id));
    // «Congela» ferma davvero: niente più traccia che si muove. Per un'altra traccia: ▶ Avvia, poi di nuovo ❄
    S.paused = true; S.showLive = false;
    if (S.acq) stopAcq();
    renderSlots(); syncControls(); redraw(); updateReadouts(true);
  }
  const EX_NAME = Object.fromEntries([...EXAMPLES, ['beats', 'Battimenti']]);

  function renderSlots() {
    const box = $('.slots');
    box.innerHTML = S.slots.map((s) => `
      <div class="slot${s.visible ? '' : ' off'}" data-id="${s.id}" style="--c:${slotColor(s.id)}">
        <button class="eye" title="Mostra/nascondi">${s.id}</button>
        <input value="${esc(s.name)}" aria-label="Nome della traccia ${s.id}">
        <small>${isFinite(s.f) ? `${fmtIt(sig(s.f, 4), 1)} Hz${noteOf(s.f) && !ard ? ` · ${noteOf(s.f).label}` : ''}` : '—'}</small>
        <button class="x" title="Elimina">✕</button>
      </div>`).join('');
    box.querySelectorAll('.slot').forEach((d) => {
      const s = S.slots.find((x) => x.id === d.dataset.id);
      d.querySelector('.eye').addEventListener('click', () => { s.visible = !s.visible; renderSlots(); redraw(); });
      d.querySelector('input').addEventListener('change', (e) => { s.name = e.target.value.trim() || s.id; renderRecipe(); });
      d.querySelector('.x').addEventListener('click', () => { S.slots = S.slots.filter((x) => x !== s); renderSlots(); syncControls(); redraw(); });
    });
    renderRecipe();
  }

  // ---------------- disegno ----------------
  function traceXY(fr, tmax, norm) {
    const n = Math.min(fr.y.length, Math.ceil((tmax / 1000) * fr.sr) + 2);
    const x = new Float32Array(n), y = new Float32Array(n);
    let mean = 0, pk = 0;
    if (norm || !ard) { for (let i = 0; i < fr.y.length; i++) mean += fr.y[i]; mean /= fr.y.length || 1; }
    if (norm) for (let i = 0; i < n; i++) pk = Math.max(pk, Math.abs(fr.y[i] - mean));
    for (let i = 0; i < n; i++) { x[i] = ((i - fr.off) / fr.sr) * 1000; y[i] = norm ? (fr.y[i] - mean) / (pk || 1) : ard ? fr.y[i] : fr.y[i] - mean; }
    return { x, y };
  }

  function windowMs() { return ard ? (S.live ? (S.live.y.length / S.live.sr) * 1000 : (S.dt * N_ARD) / 1000) : S.winMs; }

  function redraw() {
    const tmax = windowMs();
    const frames = [...S.slots.filter((s) => s.visible), ...(S.live && S.showLive ? [S.live] : [])];
    const tr = frames.map((f) => ({ ...traceXY(f, tmax, S.same), color: f === S.live ? LIVE : slotColor(f.id), dash: f === S.live ? null : slotDash(f.id), width: f === S.live ? 2 : 2.8, glow: f === S.live }));
    let y0, y1, yLabel;
    if (S.same) { y0 = -1.2; y1 = 1.2; yLabel = 'altezze normalizzate'; }
    else {
      let lo = Infinity, hi = -Infinity;
      tr.forEach((t) => t.y.forEach((v) => { if (v < lo) lo = v; if (v > hi) hi = v; }));
      if (!isFinite(lo)) { lo = ard ? 0 : -0.05; hi = ard ? 5 : 0.05; }
      const half = Math.max((hi - lo) / 2, ard ? 0.02 : 0.002) * 1.15;
      S.yHalf = half > S.yHalf ? half : S.yHalf * 0.92 + half * 0.08;
      const div = niceDiv(2 * S.yHalf, 8);
      const c = ard ? Math.round((lo + hi) / 2 / div) * div : 0;
      y0 = c - 4 * div; y1 = c + 4 * div;
      yLabel = `${fmtIt(div, 3)} ${unit()}/div`;
    }
    const markers = [];
    const hlines = [];
    if (ard && !S.same && S.edge && S.qty === 'V') hlines.push(S.level - S.V0);
    wave.draw({
      x0: 0, x1: tmax, y0, y1, traces: tr, markers,
      xLabel: `${fmtIt(tmax / 10, 3)} ms/div`, yLabel,
      note: S.msg || (ard && S.live && !S.live.fired && S.edge ? 'senza trigger' : ''),
    });
    if (hlines.length && wave.map) drawLevel(hlines[0]);
    const msg = $('.screen-msg');
    msg.textContent = !ard && !S.source ? 'Scegli una sorgente ↑ e premi ▶ Avvia'
      : !frames.length ? 'Premi ▶ Avvia'
      : ard && !S.live && !S.acq ? 'Collega in alto, poi ▶ Avvia' : '';
    msg.hidden = !msg.textContent;
    drawSpectrum(frames);
  }

  function drawLevel(v) {
    const { g } = wave, m = wave.map;
    const Y = m.sy(v); if (Y < m.pad.t || Y > m.pad.t + m.ph) return;
    g.save(); g.strokeStyle = 'rgba(255,255,255,0.55)'; g.setLineDash([2, 4]); g.beginPath(); g.moveTo(m.pad.l, Y); g.lineTo(m.pad.l + m.pw, Y); g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.moveTo(m.pad.l, Y - 6); g.lineTo(m.pad.l + 9, Y); g.lineTo(m.pad.l, Y + 6); g.fill(); g.restore();
  }

  function drawSpectrum(frames) {
    const liveOn = S.live && S.showLive;
    const ref = liveOn && isFinite(S.live.f) ? S.live.f : S.slots.find((s) => isFinite(s.f))?.f;
    if (ref && (!S.fRef || Math.abs(ref / S.fRef - 1) > 0.15)) S.fRef = ref;
    const srMin = Math.min(...frames.map((f) => f.sr), 48000);
    // fondo scala: il primo valore "tondo" che contiene circa 9 armoniche
    const SPANS = [50, 100, 200, 300, 400, 500, 600, 800, 1000, 1500, 2000, 2500, 3000, 4000, 5000, 6000, 8000, 10000, 15000, 20000];
    const want = S.fRef ? Math.max(ard ? 50 : 500, S.fRef * 8.6) : ard ? srMin / 4 : 4000;
    const fmax = Math.min(srMin / 2, SPANS.find((v) => v >= want) ?? srMin / 2);
    let gmax = 0;
    const tr = frames.map((f) => {
      const { mag, df } = f.spec; const kmax = Math.min(mag.length, Math.ceil(fmax / df) + 1);
      let m = 0; for (let k = 1; k < kmax; k++) m = Math.max(m, mag[k]);
      gmax = Math.max(gmax, m);
      return { f, kmax, m };
    }).map(({ f, kmax, m }) => {
      const x = new Float32Array(kmax), y = new Float32Array(kmax);
      for (let k = 0; k < kmax; k++) { x[k] = k * f.spec.df; y[k] = f.spec.mag[k] / (S.same ? m || 1 : 1); }
      const live = f === S.live;
      return { x, y, color: live ? LIVE : slotColor(f.id), dash: live ? null : slotDash(f.id), width: live ? 1.8 : 2.2, glow: live, fill: live ? 'rgba(198,244,50,0.12)' : null };
    });
    const markers = [];
    const base = liveOn && isFinite(S.live.f) ? S.live.f : S.slots.find((s) => s.visible && isFinite(s.f))?.f ?? null;
    if (base) for (let n = 1; n * base <= fmax && n <= 12; n++) markers.push({ x: n * base, label: String(n), color: 'rgba(198,244,50,0.55)' });
    spec.draw({
      x0: 0, x1: fmax, y0: 0, y1: (S.same ? 1 : gmax || 1) * 1.12, traces: tr, markers, centerX: false, centerY: false,
      xLabel: `${fmtIt(fmax / 10, 0)} Hz/div · spettro`, yLabel: S.same ? 'ampiezze normalizzate' : `ampiezza (${unit()})`,
    });
  }

  function renderRecipe() {
    const rows = [...(S.live && S.showLive ? [{ ...S.live, id: 'ora', name: 'dal vivo', color: LIVE }] : []), ...S.slots.filter((s) => s.visible)];
    const box = $('.recipe');
    if (!rows.some((r) => r.recipe)) { box.innerHTML = ''; return; }
    box.innerHTML = `<div class="rc-head"><b>Armoniche</b><span>${[1, 2, 3, 4, 5, 6, 7, 8].map((n) => `<i>${n}</i>`).join('')}</span></div>` +
      rows.map((r) => `<div class="rc-row" style="--c:${r.id === 'ora' ? LIVE : slotColor(r.id)}"><b title="${esc(r.name)}">${esc(r.id)}</b><span>${(r.recipe || []).map((a) => `<i style="height:${Math.round(Math.min(1.15, Math.max(0, a)) * 100 / 1.15)}%" title="${fmtIt(a, 2)}"></i>`).join('')}</span></div>`).join('');
  }

  let roLast = 0;
  function updateReadouts(force = false) {
    const now = performance.now();
    if (!force && now - roLast < 160) return;
    roLast = now;
    const src = S.showLive ? S.live : S.slots[S.slots.length - 1];
    const f = src?.f;
    if (!S.showLive) S.fHist = isFinite(f) ? [f] : [];
    else if (isFinite(f)) { S.fHist.push(f); if (S.fHist.length > 5) S.fHist.shift(); } else S.fHist = [];
    const fm = S.fHist.length ? [...S.fHist].sort((a, b) => a - b)[S.fHist.length >> 1] : NaN;
    const note = !ard && isFinite(fm) ? noteOf(fm) : null;
    const cells = [
      ['f', isFinite(fm) ? fmtIt(sig(fm, 4), fm < 100 ? 2 : 1) : '—', 'Hz'],
      ['T', isFinite(fm) ? fmtIt(sig(1000 / fm, 3), 3) : '—', 'ms'],
    ];
    if (note) cells.push(['nota', note.label, `${note.cents >= 0 ? '+' : '−'}${Math.abs(note.cents)} cent`]);
    if (ard && src) {
      let lo = Infinity, hi = -Infinity, s = 0; src.y.forEach((v) => { lo = Math.min(lo, v); hi = Math.max(hi, v); s += v; });
      cells.push(['picco-picco', fmtIt(sig(hi - lo, 3), 3), unit()], ['media', fmtIt(sig(s / src.y.length, 3), 3), unit()]);
    }
    $('.scope-ro').innerHTML = cells.map(([l, v, u]) => `<div class="ro"><small>${l}</small><b>${v}</b><em>${u}</em></div>`).join('');
  }

  // ---------------- ciclo di animazione ----------------
  function tick(now) {
    if (S.dead) return;
    S.raf = requestAnimationFrame(tick);
    if (document.hidden || !el.offsetParent) return;
    if (now - S.lastTick < 33) return;
    S.lastTick = now; S.nTick++;
    if (!ard && S.analyser && !S.paused) {
      S.live = grabAudio();
      if (S.nTick % 6 === 0) renderRecipe();
      updateReadouts();
      if (S.nTick % 10 === 1) syncControls();
    }
    redraw();
  }

  // ---------------- invio a Elaborazione ----------------
  function chosen() {
    const vis = S.slots.filter((s) => s.visible);
    if (vis.length) return vis;
    if (S.live && S.showLive) return [{ ...S.live, id: 'A', name: ard ? 'A' : S.source === 'ex' ? EX_NAME[S.example] || 'A' : 'A' }];
    return [];
  }
  const meta = (list) => list.map((s) => `${s.id}${s.name !== s.id ? ` = ${s.name}` : ''}: ${isFinite(s.f) ? `${fmtIt(sig(s.f, 4), 1)} Hz` : 'f non trovata'}${!ard && noteOf(s.f) ? ` (${noteOf(s.f).label})` : ''}`).join(' · ');

  async function sendWaves() {
    const list = chosen();
    if (!list.length) { api.toast('Non c\'è ancora nessuna traccia da inviare.'); return; }
    const tmax = windowMs(), base = list[0], dt = 1000 / base.sr;
    const n = Math.min(Math.floor(tmax / dt) + 1, 6000);
    const rows = [];
    const series = list.map((s) => traceXY(s, tmax + dt, false));
    for (let i = 0; i < n; i++) {
      const t = i * dt;
      const r = { t: +t.toPrecision(7) };
      list.forEach((s, j) => { r[s.id] = interp(series[j].x, series[j].y, t); });
      rows.push(r);
    }
    const u = list[0].unit;
    await api.sendBox({
      title: `Oscilloscopio · ${list.map((s) => s.name).join(', ')}`,
      subtitle: meta(list), wave: true, tUnit: 'ms', t1: 0, t2: rows[rows.length - 1].t,
      columns: [{ key: 't', sym: 't', unit: 'ms', name: 'tempo dal trigger' }, ...list.map((s) => ({ key: s.id, sym: s.id, unit: u, name: s.name }))],
      xKey: 't', yKey: list[0].id, rows,
    }, `Inviate ${list.length} forme d'onda (${rows.length} punti).`);
  }

  async function sendSpectra() {
    const list = chosen();
    if (!list.length) { api.toast('Non c\'è ancora nessuno spettro da inviare.'); return; }
    const fmax = Math.min(...list.map((s) => s.spec.df * (s.spec.mag.length - 1)), S.fRef ? S.fRef * 10 : 5000);
    const df = list[0].spec.df, n = Math.min(Math.floor(fmax / df) + 1, 6000);
    const rows = [];
    for (let k = 0; k < n; k++) {
      const f = k * df, r = { f: +f.toPrecision(7) };
      list.forEach((s) => { const j = f / s.spec.df, j0 = Math.floor(j); r[s.id] = j0 + 1 < s.spec.mag.length ? s.spec.mag[j0] + (s.spec.mag[j0 + 1] - s.spec.mag[j0]) * (j - j0) : NaN; });
      rows.push(r);
    }
    await api.sendBox({
      title: `Spettro · ${list.map((s) => s.name).join(', ')}`,
      subtitle: meta(list), wave: true, tUnit: 'Hz', t1: 0, t2: rows[rows.length - 1].f,
      columns: [{ key: 'f', sym: 'f', unit: 'Hz', name: 'frequenza' }, ...list.map((s) => ({ key: s.id, sym: s.id, unit: s.unit, name: `ampiezza ${s.name}` }))],
      xKey: 'f', yKey: list[0].id, rows,
    }, `Inviati ${list.length} spettri.`);
  }

  // ---------------- avvio ----------------
  syncControls(); renderSlots(); updateReadouts(true); redraw();
  if (!ard) {
    // il generatore si riprende da solo; il microfono e gli esempi partono solo con un tocco
    // il microfono e gli esempi partono solo con un tocco
  }
  S.raf = requestAnimationFrame(tick);

  return {
    onLine,
    destroy() {
      S.dead = true; cancelAnimationFrame(S.raf);
      stopExample();
      if (S.acq) api.send('STOP').catch(() => {});
      closeMic();
      wave.destroy(); spec.destroy();
    },
    linkChanged() { if (!api.ready()) { S.acq = false; syncControls(); } },
    refreshStyle() { renderSlots(); redraw(); },
    _state: S,
  };
}

function interp(x, y, t) {
  if (!x.length || t < x[0] || t > x[x.length - 1]) return NaN;
  let lo = 0, hi = x.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (x[m] <= t) lo = m; else hi = m; }
  const a = x[lo], b = x[hi];
  return b === a ? y[lo] : y[lo] + ((y[hi] - y[lo]) * (t - a)) / (b - a);
}
