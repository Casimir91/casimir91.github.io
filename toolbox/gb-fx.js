/* Groovebox · Mix FX extras.
   1. Waveshaper: an insert on the master (and on the Drums / Bass stems when recording): dry/wet crossfade around a WaveShaperNode
      whose transfer function you can pick, draw, or build from the Lab harmonics (Chebyshev).
   2. Granular cloud: a sound source that feeds the bus. Source = the last bars of the groove (grabbed live) or an audio file of yours.
      The file is decoded in the browser's memory: it is never uploaded and never stored. */
import { prepareRecorder, Tap } from './gb-export.js';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const N = 513;                                            // points of the transfer function, x = −1 … +1
const xOf = (i) => -1 + (2 * i) / (N - 1);
const curve = new Float32Array(N);
export const TRIM = 0.5; // the master bus peaks at about ±2 before the compressor: half of that fits the curve's range (|x| ≤ 1). Beyond ±1 a WaveShaperNode clamps = hard clip
export const WS = { on: false, mix: 0.5, drive: 0, preset: 'tanh', cheb: [1, 0, 0, 0, 0, 0, 0, 0], f0: 220 };   // drive in dB; cheb = own Chebyshev weights; f0 = test tone
export const PRESETS = {
  identity: ['Linear', (x) => x],
  tanh: ['Soft clip', (x) => Math.tanh(3 * x) / Math.tanh(3)],
  hard: ['Hard clip', (x) => clamp(2.5 * x, -1, 1)],
  fold: ['Wavefold', (x) => Math.sin(1.5 * Math.PI * x)],
  asym: ['Asymmetric', (x) => (x > 0 ? Math.tanh(2.5 * x) / Math.tanh(2.5) : 0.35 * x)],
  stairs: ['Bit-crush', (x) => Math.round(x * 4) / 4],
  rect: ['Rectifier', (x) => 2 * Math.abs(x) - 1],
};
const fill = (f) => { for (let i = 0; i < N; i++) curve[i] = f(xOf(i)); };
fill(PRESETS.tanh[1]);
/** f(x) = Σ aₙ Tₙ(x) (Chebyshev), scaled to |f| ≤ 1. Tₙ(cos θ) = cos nθ: a full-scale sine comes out as the harmonics a₁ … aₙ. */
function chebFill(a) {
  if (!a.some((v) => v > 0.004)) { fill((x) => x); return; }
  const s = a.reduce((t, v) => t + v, 0) || 1;
  for (let i = 0; i < N; i++) { const x = xOf(i); let t0 = 1, t1 = x, y = a[0] * t1; for (let n = 2; n <= a.length; n++) { const t2 = 2 * x * t1 - t0; y += a[n - 1] * t2; t0 = t1; t1 = t2; } curve[i] = y / s; }
}

/** Builds the insert between `input` (the low-pass) and `out` (the compressor). It replaces the direct connection input → out. */
export function buildShaper(ctx, input, out, withAnalyser) {
  const G = (v) => { const g = ctx.createGain(); g.gain.value = v; return g; };
  const dry = G(1), drive = G(1), wet = G(0), sh = ctx.createWaveShaper(), dc = ctx.createBiquadFilter();
  sh.oversample = '4x'; sh.curve = new Float32Array(curve);
  dc.type = 'highpass'; dc.frequency.value = 18; dc.Q.value = 0.5;        // asymmetric curves make a DC offset: it would only eat headroom
  input.connect(dry); dry.connect(out); input.connect(drive); drive.connect(sh); sh.connect(dc); dc.connect(wet); wet.connect(out);
  let an = null; if (withAnalyser) { an = ctx.createAnalyser(); an.fftSize = 4096; an.smoothingTimeConstant = 0.7; an.minDecibels = -100; an.maxDecibels = -10; dc.connect(an); }
  let anIn = null; if (withAnalyser) { anIn = ctx.createAnalyser(); anIn.fftSize = 2048; drive.connect(anIn); } // what the curve really sees
  const h = { dry, drive, wet, sh, an, anIn }; setShaper(h, ctx, true); return h;
}
/** Level match: a curve with slope s at the origin, fed through the input trim, makes quiet signals TRIM·s times as loud. The shaped path is divided by TRIM·s, so that Mix changes the character and not the loudness. */
const wetComp = () => { const m = (N - 1) >> 1, d = 8, sl = Math.abs((curve[m + d] - curve[m - d]) / ((2 * d * 2) / (N - 1))); return 1 / (TRIM * clamp(sl, 0.5, 6)); };
export function setShaper(h, ctx, instant) {
  const t = ctx.currentTime, k = WS.on ? WS.mix : 0, T = 0.02, set = (p, v) => (instant ? (p.value = v) : p.setTargetAtTime(v, t, T));
  set(h.dry.gain, Math.cos((k * Math.PI) / 2)); set(h.wet.gain, Math.sin((k * Math.PI) / 2) * wetComp()); set(h.drive.gain, TRIM * 10 ** (WS.drive / 20));
}
const setCurve = (h) => { h.sh.curve = new Float32Array(curve); };

// =================================================================================================================================
export function initFx(api) {
  const { $, $$, store, engine, A, S, status, fxList, bpm, isPlaying, tabIsFx } = api;
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';
  const fit = (cv) => { const d = window.devicePixelRatio || 1, w = Math.round(cv.clientWidth * d), h = Math.round(cv.clientHeight * d); if (!w) return null; if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; } const g = cv.getContext('2d'); g.setTransform(d, 0, 0, d, 0, 0); return [g, cv.clientWidth, cv.clientHeight]; };
  const radio = (box, attr, fn) => $$(`[${attr}]`, box).forEach((b) => b.addEventListener('click', () => { $$(`[${attr}]`, box).forEach((x) => x.setAttribute('aria-pressed', String(x === b))); fn(b.getAttribute(attr)); }));
  /** A labelled slider on the Lab's .pn-row layout. map: 0…1000 → value. */
  function slider(parent, o) {
    const row = document.createElement('label'); row.className = 'pn-row';
    const map = o.log ? (p) => o.min * (o.max / o.min) ** p : (p) => o.min + p * (o.max - o.min), unmap = o.log ? (v) => Math.log(v / o.min) / Math.log(o.max / o.min) : (v) => (v - o.min) / (o.max - o.min);
    row.innerHTML = `<span>${o.label}</span><output></output><input type="range" min="0" max="1000" step="1" aria-label="${o.label}">`;
    const r = row.querySelector('input'), out = row.querySelector('output'); r.value = Math.round(unmap(o.value) * 1000);
    const upd = () => { let v = map(r.value / 1000); if (o.step) v = Math.round(v / o.step) * o.step; out.textContent = o.fmt(v); return v; };
    r.addEventListener('input', () => o.onInput(upd())); r.addEventListener('change', () => o.onChange?.()); upd(); parent.appendChild(row);
    return { set(v) { r.value = Math.round(unmap(v) * 1000); out.textContent = o.fmt(v); } };
  }

  // ======================================================================= waveshaper
  const saved = store.get('ws1', null);
  if (saved) { Object.assign(WS, { on: !!saved.on, mix: clamp(+saved.mix || 0, 0, 1), drive: saved.v === 2 ? clamp(+saved.drive || 0, 0, 24) : 0, preset: saved.preset || 'tanh', f0: clamp(+saved.f0 || 220, 40, 2000) });
    if (Array.isArray(saved.cheb) && saved.cheb.length === 8) WS.cheb = saved.cheb.map((v) => clamp(+v || 0, 0, 1));
    if (Array.isArray(saved.curve) && saved.curve.length === N) curve.set(saved.curve); else if (PRESETS[WS.preset]) fill(PRESETS[WS.preset][1]); else if (WS.preset === 'cheb') chebFill(S.harm); else if (WS.preset === 'chebx') chebFill(WS.cheb); }
  const wsSave = () => store.set('ws1', { v: 2, on: WS.on, mix: WS.mix, drive: WS.drive, preset: WS.preset, cheb: WS.cheb, f0: WS.f0, curve: Array.from(curve, (v) => Math.round(v * 1000) / 1000) });
  const wsApply = (withCurve) => { const a = A(); if (!a) return; for (const f of fxList()) if (f.ws) { setShaper(f.ws, a.ctx); if (withCurve) setCurve(f.ws); } if (withCurve && toneSh) toneSh.curve = new Float32Array(curve); };
  const wsPaint = () => {
    $('#wsOn').setAttribute('aria-pressed', String(WS.on)); $('#wsOn').textContent = WS.on ? '● Waveshaper on' : '○ Waveshaper off';
    $$('#wsPresets [data-p]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.p === WS.preset)));
    $('#wsChip').textContent = WS.on ? `${WS.preset === 'drawn' ? 'drawn' : WS.preset === 'cheb' ? 'Lab harmonics' : WS.preset === 'chebx' ? 'Chebyshev' : PRESETS[WS.preset]?.[0] || ''} · ${Math.round(WS.mix * 100)} %` : 'off';
  };
  $('#wsPresets').innerHTML = Object.entries(PRESETS).map(([k, [n]]) => `<button data-p="${k}" aria-pressed="false">${n}</button>`).join('') + '<button data-p="cheb" aria-pressed="false" title="Chebyshev curve built from the harmonics of the Lab: a full-scale sine comes out with exactly that spectrum">From Lab harmonics</button><button data-p="chebx" aria-pressed="false" title="Your own Chebyshev weights (sliders below)">Chebyshev sliders</button>';
  $('#wsPresets').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]'); if (!b) return; const k = b.dataset.p; WS.preset = k;
    if (k === 'cheb') chebFill(S.harm); else if (k === 'chebx') chebFill(WS.cheb); else fill(PRESETS[k][1]);
    if (!WS.on) WS.on = true; wsApply(true); wsPaint(); wsSave(); drawCurve();
  });
  $('#wsOn').addEventListener('click', () => { WS.on = !WS.on; engine(); wsApply(true); wsPaint(); wsSave(); });
  const wsS = $('#wsParams');
  const drv = slider(wsS, { label: 'Drive (more level into the curve)', min: 0, max: 24, value: WS.drive, step: 0.5, fmt: (v) => '+' + v.toFixed(1) + ' dB', onInput: (v) => { WS.drive = v; wsApply(); drawCurve(); }, onChange: wsSave });
  const mix = slider(wsS, { label: 'Mix (dry ⇄ shaped)', min: 0, max: 1, value: WS.mix, fmt: (v) => Math.round(v * 100) + ' %', onInput: (v) => { WS.mix = v; wsApply(); wsPaint(); }, onChange: wsSave });

  // Chebyshev sliders: f(x) = Σ aₙ Tₙ(x). A sine of amplitude 1 through Tₙ comes out as the n-th harmonic alone.
  const chebBox = $('#wsCheb'); chebBox.innerHTML = WS.cheb.map((v, i) => `<label>H${i + 1}<input type="range" min="0" max="100" value="${Math.round(v * 100)}" data-n="${i}" aria-label="Chebyshev harmonic ${i + 1}"><output>${Math.round(v * 100)}</output></label>`).join('');
  const chebEq = () => { const t = WS.cheb.map((v, i) => (v > 0.004 ? `${v.toFixed(2)}·T${i + 1}(x)` : '')).filter(Boolean).join(' + '); $('#wsChebEq').textContent = 'f(x) = ' + (t || 'x') + (t ? '   (scaled so that |f| ≤ 1)' : ''); };
  const chebPaint = () => { $$('input', chebBox).forEach((r) => { r.value = Math.round(WS.cheb[+r.dataset.n] * 100); r.nextElementSibling.textContent = r.value; }); chebEq(); };
  const chebSet = () => { WS.preset = 'chebx'; if (!WS.on) { WS.on = true; engine(); } chebFill(WS.cheb); wsApply(true); wsPaint(); drawCurve(); chebEq(); };
  chebBox.addEventListener('input', (e) => { const r = e.target.closest('input'); if (!r) return; WS.cheb[+r.dataset.n] = +r.value / 100; r.nextElementSibling.textContent = r.value; chebSet(); });
  chebBox.addEventListener('change', wsSave);
  $('#wsChebLab').addEventListener('click', () => { WS.cheb = S.harm.slice(0, 8).map((v) => clamp(v, 0, 1)); while (WS.cheb.length < 8) WS.cheb.push(0); chebPaint(); chebSet(); wsSave(); });
  $('#wsChebReset').addEventListener('click', () => { WS.cheb = [1, 0, 0, 0, 0, 0, 0, 0]; chebPaint(); chebSet(); wsSave(); });
  chebEq();
  // test tone: a pure sine into the insert, so the harmonics of the curve stand out in the spectrum
  let osc = null, toneSh = null, toneNodes = [];
  const toneBtn = $('#wsTone');
  /** The tone does not go through Drive or Mix: a sine of amplitude exactly 1 meets the same curve, so Tₙ gives pure harmonics. Quiet (−15 dB). */
  function tone(on) {
    toneBtn.setAttribute('aria-pressed', String(on)); toneBtn.textContent = on ? '■ Stop test tone' : '▶ Sine test tone';
    if (on) {
      if (osc) return; const a = engine(), c = a.ctx;
      osc = c.createOscillator(); osc.frequency.value = WS.f0; toneSh = c.createWaveShaper(); toneSh.oversample = '4x'; toneSh.curve = new Float32Array(curve);
      const dc = c.createBiquadFilter(); dc.type = 'highpass'; dc.frequency.value = 18; dc.Q.value = 0.5; const out = c.createGain(); out.gain.value = 0;
      osc.connect(toneSh); toneSh.connect(dc); dc.connect(out); out.connect(a.lp); if (a.fx.ws.an) dc.connect(a.fx.ws.an); osc.start(); out.gain.setTargetAtTime(0.18, c.currentTime, 0.03);
      toneNodes = [toneSh, dc, out]; status('Sine test tone: look at the spectrum for the harmonics of the curve');
    } else if (osc) {
      const o = osc, nodes = toneNodes, c = A().ctx; osc = toneSh = null; toneNodes = []; nodes[2].gain.setTargetAtTime(0, c.currentTime, 0.03);
      setTimeout(() => { try { o.stop(); o.disconnect(); nodes.forEach((n) => n.disconnect()); } catch {} }, 200);
    }
  }
  toneBtn.addEventListener('click', () => tone(!osc));
  slider(wsS, { label: 'Test tone frequency', min: 40, max: 2000, value: WS.f0, log: true, step: 1, fmt: (v) => Math.round(v) + ' Hz', onInput: (v) => { WS.f0 = v; if (osc) osc.frequency.setTargetAtTime(v, A().ctx.currentTime, 0.02); }, onChange: wsSave });
  // drawing the curve
  const cvC = $('#wsCurve'); let dragging = false, lastI = -1, lastY = 0;
  const pt = (e) => { const r = cvC.getBoundingClientRect(); return [clamp(Math.round(((e.clientX - r.left) / r.width) * (N - 1)), 0, N - 1), clamp(1 - 2 * ((e.clientY - r.top) / r.height), -1, 1)]; };
  const draw = (e) => {
    const [i, y] = pt(e);
    if (lastI < 0) { curve[i] = y; } else { const a = Math.min(i, lastI), b = Math.max(i, lastI); for (let k = a; k <= b; k++) { const u = b === a ? 1 : (k - lastI) / (i - lastI); curve[k] = lastY + (y - lastY) * clamp(u, 0, 1); } }
    lastI = i; lastY = y; WS.preset = 'drawn'; wsApply(true); drawCurve();
  };
  cvC.addEventListener('pointerdown', (e) => { cvC.setPointerCapture(e.pointerId); dragging = true; lastI = -1; if (!WS.on) { WS.on = true; engine(); } draw(e); wsPaint(); });
  cvC.addEventListener('pointermove', (e) => { if (dragging) draw(e); });
  for (const ev of ['pointerup', 'pointercancel']) cvC.addEventListener(ev, () => { if (dragging) { dragging = false; wsSave(); wsPaint(); } });
  $('#wsSmooth').addEventListener('click', () => { const c = Float32Array.from(curve); for (let i = 1; i < N - 1; i++) curve[i] = (c[i - 1] + 2 * c[i] + c[i + 1]) / 4; WS.preset = 'drawn'; wsApply(true); wsSave(); drawCurve(); wsPaint(); });
  let pkHold = 0; const lvBuf = new Float32Array(2048);
  function level() { // peak and RMS of the signal that reaches the curve (after Drive); the peak falls slowly so that it can be read
    const ai = A()?.fx.ws?.anIn; if (!ai) return null; ai.getFloatTimeDomainData(lvBuf); let pk = 0, s = 0; for (const v of lvBuf) { const a = Math.abs(v); if (a > pk) pk = a; s += v * v; }
    pkHold = Math.max(pk, pkHold * 0.96); return { pk: pkHold, rms: Math.sqrt(s / lvBuf.length) };
  }
  function drawCurve() {
    const f = fit(cvC); if (!f) return; const [g, W, H] = f, X = (x) => ((x + 1) / 2) * W, Y = (y) => (1 - (y + 1) / 2) * H;
    g.clearRect(0, 0, W, H); g.strokeStyle = css('--border'); g.lineWidth = 1; g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
    g.setLineDash([4, 4]); g.beginPath(); g.moveTo(0, H); g.lineTo(W, 0); g.stroke(); g.setLineDash([]);
    const lv = level(), cl = (v) => Math.min(1, v), band = (v, al) => { g.fillStyle = css('--primary') + al; g.fillRect(X(-cl(v)), 0, X(cl(v)) - X(-cl(v)), H); };
    if (lv) { band(lv.pk, '1c'); band(lv.rms * 2, '33'); if (lv.pk > 1) { g.fillStyle = '#e5484d'; g.fillRect(0, 0, 3, H); g.fillRect(W - 3, 0, 3, H); } }
    const m = $('#wsMeter'); if (m) { const t = lv ? `On the curve: typical level ±${lv.rms.toFixed(2)} · peaks ±${lv.pk.toFixed(2)}` + (lv.pk > 1 ? ' · ⚠ above ±1: clipped (lower Drive)' : '') : 'Press Play: the shaded bands show where the music sits on the curve'; if (m.textContent !== t) m.textContent = t; m.classList.toggle('warn', !!lv && lv.pk > 1); }
    g.strokeStyle = css('--primary'); g.lineWidth = 2.4; g.beginPath(); for (let i = 0; i < N; i++) { const px = X(xOf(i)), py = Y(curve[i]); i ? g.lineTo(px, py) : g.moveTo(px, py); } g.stroke();
    g.fillStyle = css('--muted'); g.font = '11px system-ui'; g.fillText('input →', W - 48, H / 2 - 5); g.fillText('output ↑', W / 2 + 5, 12);
  }
  const spC = $('#wsSpec');
  function drawSpec() {
    const a = A(), f = fit(spC); if (!f) return; const [g, W, H] = f; g.clearRect(0, 0, W, H);
    g.strokeStyle = css('--border'); g.lineWidth = 1; g.fillStyle = css('--muted'); g.font = '10px system-ui';
    const fx = (hz) => (Math.log(hz / 40) / Math.log(16000 / 40)) * W;
    for (const hz of [100, 1000, 10000]) { g.beginPath(); g.moveTo(fx(hz), 0); g.lineTo(fx(hz), H); g.stroke(); g.fillText(hz >= 1000 ? hz / 1000 + 'k' : hz, fx(hz) + 3, H - 3); }
    if (osc) { g.fillStyle = css('--muted'); g.strokeStyle = css('--primary'); g.setLineDash([3, 4]); for (let k = 1; k * WS.f0 < 16000 && k <= 24; k++) { const x = fx(k * WS.f0); g.beginPath(); g.moveTo(x, 0); g.lineTo(x, H - 14); g.stroke(); g.fillText(k, x + 2, 11); } g.setLineDash([]); }
    const an = a?.fx.ws?.an; if (!an) { g.fillText('Press Play: the spectrum of the shaped signal appears here', 10, 16); return; }
    const d = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(d); const sr = a.ctx.sampleRate, bin = sr / an.fftSize;
    g.strokeStyle = css('--accent'); g.lineWidth = 1.6; g.beginPath(); let first = true;
    for (let x = 0; x < W; x++) { const hz = 40 * (16000 / 40) ** (x / W), v = d[Math.round(hz / bin)]; const y = H - clamp((v + 100) / 90, 0, 1) * (H - 4) - 2; first ? g.moveTo(x, y) : g.lineTo(x, y); first = false; } g.stroke();
  }

  // ======================================================================= granular
  const G = Object.assign({ pos: 0.1, spray: 0.02, size: 80, dens: 20, pitch: 0, pitchSpread: 0, pan: 0.4, rev: 0, scan: 0, level: 0.7, win: 'hann', timing: 'reg' }, store.get('gr1', {}));
  const grSave = () => store.set('gr1', G);
  let buf = null, revBuf = null, srcName = '', grainOut = null, peaks = null, peaksW = 0;
  const WIN = (() => { const n = 128, mk = (f) => Float32Array.from({ length: n }, (_, k) => f(k / (n - 1)));
    return { hann: mk((u) => 0.5 - 0.5 * Math.cos(2 * Math.PI * u)), gauss: mk((u) => (u === 0 || u === 1 ? 0 : Math.exp(-0.5 * ((u - 0.5) / 0.17) ** 2))), tri: mk((u) => 1 - Math.abs(2 * u - 1)),
      tukey: mk((u) => (u < 0.25 ? 0.5 - 0.5 * Math.cos((Math.PI * u) / 0.25) : u > 0.75 ? 0.5 - 0.5 * Math.cos((Math.PI * (1 - u)) / 0.25) : 1)), rect: mk(() => 1) }; })();
  const setMono = (mono, sr, name, note) => {
    buf = new AudioBuffer({ length: mono.length, sampleRate: sr }); buf.copyToChannel(mono, 0);
    revBuf = new AudioBuffer({ length: mono.length, sampleRate: sr }); revBuf.copyToChannel(Float32Array.from(mono).reverse(), 0);
    srcName = name; peaks = null; $('#grSrcName').textContent = `${name} · ${buf.duration.toFixed(1)} s${note ? ' — ' + note : ''}`; $('#grChip').textContent = timer ? 'playing' : 'ready'; status(name + ' ready: start the cloud');
  };
  async function grab(bars) {
    const btns = $$('#grGrab button'); if (!isPlaying()) { status('Press Play first: the cloud grabs what the groove is playing.'); return; }
    const a = engine(); btns.forEach((b) => (b.disabled = true));
    try {
      await prepareRecorder(a.ctx); const secs = (bars * 4 * 60) / bpm(), tap = new Tap(a.ctx);
      a.master.connect(tap.input); tap.start(); status(`Grabbing ${bars} bars (${secs.toFixed(1)} s)…`); await sleep(secs * 1000 + 80);
      tap.stop(); await tap.flush(); try { a.master.disconnect(tap.input); } catch {}
      if (!tap.chunks.length) throw new Error('nothing recorded');
      const f0 = Math.min(...tap.chunks.map((c) => c.f)), f1 = Math.max(...tap.chunks.map((c) => c.f + c.L.length)), { L, R } = tap.slice(f0, f1); tap.close();
      const mono = new Float32Array(L.length); let pk = 0; for (let i = 0; i < mono.length; i++) { mono[i] = (L[i] + R[i]) / 65536; pk = Math.max(pk, Math.abs(mono[i])); }
      if (pk < 0.005) { status('That was silence: unmute something and grab again.'); return; }
      setMono(mono, a.ctx.sampleRate, `Groove, ${bars} bars`);
    } catch (e) { status('Could not grab the audio: ' + (e.message || e)); } finally { btns.forEach((b) => (b.disabled = false)); }
  }
  $('#grGrab').addEventListener('click', (e) => { const b = e.target.closest('[data-bars]'); if (b) grab(+b.dataset.bars); });

  const SR = 44100, gen = (secs, fn) => { const d = new Float32Array(Math.round(secs * SR)); fn(d, SR); return d; };
  const useSweep = () => setMono(gen(6, (d, sr) => { let ph = 0; for (let i = 0; i < d.length; i++) { const p = i / d.length, f = 110 * 2 ** (5 * p); ph += (2 * Math.PI * f) / sr; d[i] = 0.5 * Math.sin(ph) * Math.min(1, i / 400, (d.length - i) / 400); } }), SR, 'Sine sweep', 'a pure sine rising from 110 Hz to 3520 Hz (5 octaves) in 6 s: the position is the pitch, f = 110·2^(5·position). With a big spray you hear a band of frequencies.');
  const useChord = () => setMono(gen(5, (d, sr) => {
    const chords = [[130.81, 196, 233.08, 311.13], [155.56, 233.08, 311.13, 392], [130.81, 196, 233.08, 293.66, 349.23], [116.54, 174.61, 233.08, 293.66]];
    chords.forEach((ch, s) => { const t0 = Math.round(s * 1.2 * sr); ch.forEach((f, n) => { const ts = t0 + Math.round(n * 0.045 * sr); for (let k = 1; k <= 9; k++) { const a = 0.12 / k ** 1.1, tau = 1.6 / (1 + 0.5 * k), w = (2 * Math.PI * f * k) / sr; for (let i = ts; i < d.length; i++) { const t = (i - ts) / sr; if (t > 4 * tau) break; d[i] += a * Math.exp(-t / tau) * Math.sin(w * (i - ts)); } } }); });
    let pk = 0; for (const v of d) pk = Math.max(pk, Math.abs(v)); for (let i = 0; i < d.length; i++) d[i] *= 0.6 / pk;
  }), SR, 'Plucked chords', 'four strummed chords (additive synthesis, nine decaying harmonics per note). Scan the position: bright attacks and dark tails come apart.');
  async function decode(ab, name) {
    try {
      const a = engine(), b = await a.ctx.decodeAudioData(ab), max = Math.round(b.sampleRate * 60), n = Math.min(b.length, max), mono = new Float32Array(n);
      for (let c = 0; c < b.numberOfChannels; c++) { const x = b.getChannelData(c); for (let i = 0; i < n; i++) mono[i] += x[i] / b.numberOfChannels; }
      setMono(mono, b.sampleRate, name.length > 28 ? name.slice(0, 25) + '…' : name, b.length > max ? 'first 60 s' : ''); return true;
    } catch { status('This audio could not be decoded (try WAV, MP3 or M4A).'); return false; }
  }
  async function recordMic() {
    const btn = $('#grMic'); if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) { status('This browser cannot record from the microphone.'); return; }
    try {
      const st = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }), rec = new MediaRecorder(st), parts = [];
      rec.ondataavailable = (e) => parts.push(e.data); btn.disabled = true; btn.textContent = '● Recording…'; status('Recording 4 seconds…');
      rec.onstop = async () => { st.getTracks().forEach((t) => t.stop()); btn.disabled = false; btn.textContent = '● Microphone 4 s'; await decode(await new Blob(parts).arrayBuffer(), 'Microphone'); };
      rec.start(); setTimeout(() => rec.state !== 'inactive' && rec.stop(), 4000);
    } catch (e) { btn.disabled = false; status('Microphone not available: ' + (e.message || e.name)); }
  }
  $('#grSweep').addEventListener('click', useSweep); $('#grChord').addEventListener('click', useChord); $('#grMic').addEventListener('click', recordMic);
  $('#grFileBtn').addEventListener('click', () => $('#grFile').click());
  $('#grFile').addEventListener('change', async (e) => { const f = e.target.files[0]; if (!f) return; e.target.value = ''; await decode(await f.arrayBuffer(), f.name); });
  const gs = $('#grSliders'), SL = {};
  const rd = () => { const ov = (G.dens * G.size) / 1000, df = 1000 / G.size; $('#grRead').textContent = `overlap ≈ ${ov.toFixed(ov < 10 ? 1 : 0)} grains sounding · Δt = ${G.size.toFixed(G.size < 10 ? 1 : 0)} ms → Δf ≈ 1/Δt ≈ ${df < 1000 ? df.toFixed(0) + ' Hz' : (df / 1000).toFixed(1) + ' kHz'}`; };
  const S1 = (k, o) => (SL[k] = slider(gs, { ...o, onChange: grSave }));
  S1('pos', { label: 'Position in the sample', min: 0, max: 1, value: G.pos, fmt: (v) => Math.round(v * 100) + ' %', onInput: (v) => { G.pos = v; } });
  S1('spray', { label: 'Spray (scatter)', min: 0, max: 0.5, value: G.spray, fmt: (v) => '±' + Math.round(v * 100) + ' %', onInput: (v) => { G.spray = v; } });
  S1('size', { label: 'Grain size', min: 3, max: 500, value: G.size, log: true, fmt: (v) => v.toFixed(v < 10 ? 1 : 0) + ' ms', onInput: (v) => { G.size = v; rd(); } });
  S1('dens', { label: 'Density', min: 1, max: 150, value: G.dens, log: true, fmt: (v) => v.toFixed(v < 10 ? 1 : 0) + ' /s', onInput: (v) => { G.dens = v; rd(); } });
  S1('pitch', { label: 'Pitch', min: -24, max: 24, value: G.pitch, step: 1, fmt: (v) => (v > 0 ? '+' : '') + v + ' st', onInput: (v) => { G.pitch = v; } });
  S1('ps', { label: 'Pitch scatter', min: 0, max: 600, value: G.pitchSpread, step: 5, fmt: (v) => '±' + v + ' ct', onInput: (v) => { G.pitchSpread = v; } });
  S1('pan', { label: 'Stereo spread', min: 0, max: 1, value: G.pan, fmt: (v) => Math.round(v * 100) + ' %', onInput: (v) => { G.pan = v; } });
  S1('rev', { label: 'Reversed grains', min: 0, max: 1, value: G.rev, fmt: (v) => Math.round(v * 100) + ' %', onInput: (v) => { G.rev = v; } });
  S1('scan', { label: 'Scan speed', min: -0.5, max: 0.5, value: G.scan, step: 0.01, fmt: (v) => (v > 0 ? '+' : '') + Math.round(v * 100) + ' %/s', onInput: (v) => { G.scan = v; } });
  S1('level', { label: 'Level into the mix', min: 0, max: 1.2, value: G.level, fmt: (v) => Math.round(v * 100) + ' %', onInput: (v) => { G.level = v; grainOut?.gain.setTargetAtTime(v, grainOut.context.currentTime, 0.02); } });
  rd();
  const mark = (box, attr, val) => $$(`[${attr}]`, box).forEach((b) => b.setAttribute('aria-pressed', String(b.getAttribute(attr) === val)));
  mark($('#grWin'), 'data-w', G.win); mark($('#grTime'), 'data-t', G.timing);
  radio($('#grWin'), 'data-w', (v) => { G.win = v; grSave(); }); radio($('#grTime'), 'data-t', (v) => { G.timing = v; grSave(); });

  let timer = 0, nextT = 0, lastT = 0, active = 0; const recent = [];
  function spawn(t) {
    const a = A(); if (!buf || !a || active > 160) return;
    const D = buf.duration, dur = G.size / 1000, rate = 2 ** ((G.pitch + (Math.random() * 2 - 1) * (G.pitchSpread / 100)) / 12), need = dur * rate, rv = Math.random() < G.rev, c = a.ctx;
    const p = clamp(G.pos + (Math.random() * 2 - 1) * G.spray, 0, 1), start = Math.min(p * D, Math.max(0, D - need)), off = rv ? Math.max(0, D - start - need) : start;
    const src = c.createBufferSource(); src.buffer = rv ? revBuf : buf; src.playbackRate.value = rate;
    const g = c.createGain(), pan = c.createStereoPanner(), ov = (G.dens * G.size) / 1000, norm = 1 / Math.sqrt(Math.max(1, ov));
    g.gain.value = 0; g.gain.setValueCurveAtTime(WIN[G.win].map((v) => v * norm), t, dur); g.gain.setValueAtTime(0, t + dur + 0.001);
    pan.pan.value = (Math.random() * 2 - 1) * G.pan; src.connect(g); g.connect(pan); pan.connect(grainOut);
    src.start(t, off, Math.min(need, D - off)); src.stop(t + dur + 0.01); active++; src.onended = () => { active--; src.disconnect(); g.disconnect(); pan.disconnect(); };
    recent.push({ t, dur, p: start / D, w: need / D }); if (recent.length > 120) recent.shift();
  }
  function schedule() {
    const c = A().ctx, now = c.currentTime; if (nextT < now) nextT = now + 0.02;
    while (nextT < now + 0.12) {
      if (G.scan) { G.pos += G.scan * (nextT - lastT); G.pos = ((G.pos % 1) + 1) % 1; } lastT = nextT;
      spawn(nextT); nextT += G.timing === 'rnd' ? -Math.log(1 - Math.random()) / G.dens : 1 / G.dens;
    }
  }
  function cloud(on) {
    const b = $('#grPlay'); if (on && !buf) { status('Grab the groove or load a file first.'); return; }
    b.setAttribute('aria-pressed', String(on)); b.textContent = on ? '■ Stop cloud' : '▶ Start cloud'; $('#grChip').textContent = on ? 'playing' : buf ? 'ready' : 'no sample';
    if (on) { const a = engine(); if (!grainOut) { grainOut = a.ctx.createGain(); grainOut.connect(a.bus); } grainOut.gain.value = G.level; nextT = lastT = a.ctx.currentTime + 0.05; timer = setInterval(schedule, 25); status('Granular cloud playing (it goes through the master filter and effects)'); }
    else { clearInterval(timer); timer = 0; status('Cloud stopped'); }
  }
  $('#grPlay').addEventListener('click', () => cloud(!timer));
  const wvC = $('#grWave');
  function drawWave() {
    const f = fit(wvC); if (!f) return; const [g, W, H] = f; g.clearRect(0, 0, W, H);
    g.strokeStyle = css('--border'); g.beginPath(); g.moveTo(0, H / 2); g.lineTo(W, H / 2); g.stroke();
    if (!buf) { g.fillStyle = css('--muted'); g.font = '12px system-ui'; g.fillText('No sample yet: grab the groove or load a file', 10, H / 2 - 8); return; }
    if (!peaks || peaksW !== W) { const d = buf.getChannelData(0), n = d.length; peaks = new Float32Array(Math.round(W) * 2); for (let x = 0; x < Math.round(W); x++) { const a = Math.floor((x / W) * n), b = Math.max(a + 1, Math.floor(((x + 1) / W) * n)); let lo = 0, hi = 0; for (let i = a; i < b; i += Math.ceil((b - a) / 64)) { lo = Math.min(lo, d[i]); hi = Math.max(hi, d[i]); } peaks[2 * x] = lo; peaks[2 * x + 1] = hi; } peaksW = W; }
    g.fillStyle = css('--primary') + '22'; g.fillRect(clamp(G.pos - G.spray, 0, 1) * W, 0, (Math.min(1, G.pos + G.spray) - Math.max(0, G.pos - G.spray)) * W, H);
    g.strokeStyle = css('--muted'); g.lineWidth = 1; g.beginPath(); for (let x = 0; x < Math.round(W); x++) { g.moveTo(x + 0.5, H / 2 - peaks[2 * x + 1] * (H / 2 - 4)); g.lineTo(x + 0.5, H / 2 - peaks[2 * x] * (H / 2 - 4)); } g.stroke();
    const now = A()?.ctx.currentTime || 0; g.fillStyle = css('--accent'); for (const r of recent) if (now >= r.t && now < r.t + r.dur + 0.1) g.fillRect(r.p * W, H - 6, Math.max(2, r.w * W), 4);
    g.strokeStyle = css('--accent'); g.lineWidth = 2; g.beginPath(); g.moveTo(G.pos * W, 0); g.lineTo(G.pos * W, H); g.stroke();
  }
  const posFromEvent = (e) => { const r = wvC.getBoundingClientRect(); G.pos = clamp((e.clientX - r.left) / r.width, 0, 1); SL.pos.set(G.pos); };
  let dp = false; wvC.addEventListener('pointerdown', (e) => { wvC.setPointerCapture(e.pointerId); dp = true; posFromEvent(e); });
  wvC.addEventListener('pointermove', (e) => { if (dp) posFromEvent(e); }); for (const ev of ['pointerup', 'pointercancel']) wvC.addEventListener(ev, () => { if (dp) { dp = false; grSave(); } });

  // ======================================================================= redraw loop (only while the section is open)
  const open = (id) => $(id).open;
  const frame = () => {
    if (tabIsFx()) {
      if (open('#sec-ws')) { drawSpec(); drawCurve(); } if (open('#sec-gr')) { if (G.scan && timer) SL.pos.set(G.pos); drawWave(); }
    }
    requestAnimationFrame(frame);
  };
  $('#sec-ws').addEventListener('toggle', () => { if (open('#sec-ws')) drawCurve(); });
  addEventListener('resize', () => { if (tabIsFx() && open('#sec-ws')) drawCurve(); });
  wsPaint(); $('#grChip').textContent = 'no sample'; requestAnimationFrame(frame);
  return { redraw: () => { if (open('#sec-ws')) drawCurve(); }, chebChanged: () => { if (WS.preset === 'cheb') { chebFill(S.harm); wsApply(true); wsSave(); drawCurve(); } }, cloud };
}
