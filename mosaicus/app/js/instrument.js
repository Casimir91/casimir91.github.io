// Mosaicus — strumento musicale: un "theremin" comandato da un sensore.
//
// Sorgenti: ✋ dito sul nastro, 📱 inclinazione del telefono, 📡 distanza della mano
// dal sensore a ultrasuoni HC-SR04 (Arduino). La posizione u ∈ [0, 1] diventa un numero
// di semitoni n tra la nota più bassa e la più alta, e la frequenza è f = 440 · 2^(n/12)
// (temperamento equabile). Con una scala scelta, n si aggancia alla nota della scala più vicina.
// Il timbro si costruisce sommando armoniche (sintesi additiva).

import { Voice, audioSupported } from './audio.js';
import { noteOf, noteFreq, snapToScale, NOTE_IT, TIMBRES } from './dsp.js';
import { harmonicEditor } from './generator.js';
import { fmtIt } from './screen.js';

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* niente */ } },
};

const RANGES = { 'Do3–Do5': [-21, 3], 'Do4–Do6': [-9, 15], 'Do2–Do4': [-33, -9] };
const SCALE_LABEL = { continua: 'continua', cromatica: 'cromatica', maggiore: 'Do maggiore', pentatonica: 'pentatonica' };
const D_NEAR = 0.05, D_FAR = 0.50;    // m: mano vicina → nota alta, mano lontana → nota bassa
const V_SOUND = 343;                   // m/s, aria a 20 °C

export function createInstrument(el, api) {
  const P = { src: 'finger', range: 'Do3–Do5', scale: 'pentatonica', amps: [...TIMBRES.flauto.amps], vol: 0.5, ...store.get('mosaicus.instr', {}) };
  const save = () => { const { src, range, scale, amps, vol } = P; store.set('mosaicus.instr', { src, range, scale, amps, vol }); };
  const S = { u: null, f: NaN, n: NaN, d: NaN, playing: false, voice: null, dBuf: [], tilt: null, acq: false };

  el.innerHTML = `
  <div class="card instr-head">
    <div class="seg isrc" role="group" aria-label="Che cosa comanda la nota">
      <button data-src="finger">✋ Dito</button><button data-src="tilt">📱 Inclinazione</button><button data-src="sonar">📡 Ultrasuoni</button>
    </div>
    <button class="btn btn-play big iplay">▶ Suona</button>
  </div>
  <div class="card instr-body">
    <div class="inote"><b class="in-name">—</b><span class="in-f"></span><em class="in-d"></em></div>
    <p class="in-eq"></p>
    <div class="ribbon" data-prevent-swipe><canvas aria-label="Nastro delle note"></canvas></div>
    <p class="hint in-hint"></p>
    <div class="ictrl">
      <label class="mini">note <select class="irange">${Object.keys(RANGES).map((r) => `<option>${r}</option>`).join('')}</select></label>
      <div class="seg iscale" role="group" aria-label="Scala">${Object.entries(SCALE_LABEL).map(([k, l]) => `<button data-scale="${k}">${l}</button>`).join('')}</div>
      <label class="vol">🔈 <input type="range" class="ivol" min="0" max="1" step="0.01" aria-label="Volume"> 🔊</label>
    </div>
  </div>
  <div class="card instr-timbre">
    <h3>Timbro: somma di armoniche</h3>
    <div class="harm-box"></div>
  </div>`;
  const $ = (s) => el.querySelector(s);
  const cv = $('.ribbon canvas');
  const ed = harmonicEditor($('.harm-box'), () => P.amps, (a) => { P.amps = a; save(); S.voice?.setWave(null, a); });

  // ---------------- nota dalla posizione ----------------
  if (!RANGES[P.range]) P.range = 'Do3–Do5';
  function setU(u) {
    if (u == null || !isFinite(u)) { S.u = null; paint(); return; }
    S.u = Math.min(1, Math.max(0, u));
    const [a, b] = RANGES[P.range];
    const n = a + S.u * (b - a);
    let f = noteFreq(n);
    if (P.scale !== 'continua') f = snapToScale(f, P.scale);
    S.f = f; S.n = 12 * Math.log2(f / 440);
    if (S.voice) S.voice.setFreq(f, P.scale === 'continua' ? 0.02 : 0.008);
    paint();
  }

  function ensureVoice() {
    if (!audioSupported()) { api.toast('Questo browser non supporta l\'audio.'); return false; }
    if (!S.voice) S.voice = new Voice({ amps: P.amps, freq: isFinite(S.f) ? S.f : 440, gain: P.vol * 0.6 });
    return true;
  }
  function soundOn() { if (!ensureVoice()) return; S.voice.setLevel(P.vol * 0.6); S.voice.start(); S.playing = true; paint(); }
  function soundOff() { S.voice?.stop(); S.playing = false; paint(); }

  // ---------------- sorgenti ----------------
  // dito: si suona tenendo premuto sul nastro
  let down = false;
  const uFromEvent = (e) => { const r = cv.getBoundingClientRect(); return (e.clientX - r.left) / r.width; };
  cv.addEventListener('pointerdown', (e) => {
    if (P.src !== 'finger') return;
    down = true; cv.setPointerCapture(e.pointerId); setU(uFromEvent(e)); soundOn();
  });
  cv.addEventListener('pointermove', (e) => { if (down && P.src === 'finger') setU(uFromEvent(e)); });
  const up = () => { if (down) { down = false; soundOff(); } };
  cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);

  // inclinazione: angolo destra/sinistra (gamma) tra −45° e +45°
  function onTilt(e) {
    if (e.gamma == null) return;
    S.tilt = e.gamma;
    setU((Math.max(-45, Math.min(45, e.gamma)) + 45) / 90);
  }
  async function startTilt() {
    if (!('DeviceOrientationEvent' in window)) { api.toast('Questo dispositivo non ha il sensore di inclinazione.'); return false; }
    if (!window.isSecureContext) { api.toast('Il sensore di inclinazione funziona solo da una pagina sicura (https).'); return false; }
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      try { if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') { api.toast('Permesso per i sensori negato.'); return false; } } catch { return false; }
    }
    window.addEventListener('deviceorientation', onTilt);
    return true;
  }
  const stopTilt = () => window.removeEventListener('deviceorientation', onTilt);

  // ultrasuoni: righe S,<t_us>,<eco_us> dal firmware (o dal simulatore)
  function onLine(line) {
    if (P.src !== 'sonar' || !S.acq || !line.startsWith('S,')) return false;
    const echo = Number(line.split(',')[2]);
    if (!(echo > 0)) return true;
    const d = (echo * 1e-6 * V_SOUND) / 2;
    if (d > 1.2) return true;                     // eco spurio o mano assente
    S.dBuf.push(d); if (S.dBuf.length > 3) S.dBuf.shift();
    const dm = [...S.dBuf].sort((a, b) => a - b)[S.dBuf.length >> 1];   // mediana: toglie i salti
    S.d = dm;
    setU(1 - (dm - D_NEAR) / (D_FAR - D_NEAR));
    return true;
  }

  async function play() {
    if (S.playing || S.acq) { await stop(); return; }
    if (P.src === 'tilt') { if (!(await startTilt())) return; if (S.u == null) setU(0.5); soundOn(); }
    if (P.src === 'sonar') {
      if (!api.ready()) { api.toast('Prima collega Arduino (o il simulatore) con i pulsanti in alto.'); return; }
      S.acq = true; S.dBuf = []; await api.send('START,SONAR,30'); soundOn();
    }
  }
  async function stop() {
    stopTilt();
    if (S.acq) { S.acq = false; try { await api.send('STOP'); } catch { /* scollegato */ } }
    soundOff();
  }

  // ---------------- disegno ----------------
  function drawRibbon() {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (!r.width) return;
    cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = r.width, H = r.height, k = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 15) / 15;
    g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--screen').trim() || '#00302A'; g.fillRect(0, 0, W, H);
    const [a, b] = RANGES[P.range];
    const xOf = (n) => ((n - a) / (b - a)) * W;
    const deg = { cromatica: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], maggiore: [0, 2, 4, 5, 7, 9, 11], pentatonica: [0, 2, 4, 7, 9], continua: [0, 2, 4, 5, 7, 9, 11] }[P.scale];
    g.font = `500 ${11 * k}px "Plus Jakarta Sans", system-ui, sans-serif`; g.textAlign = 'center'; g.textBaseline = 'bottom';
    for (let n = Math.ceil(a); n <= b; n++) {
      const c = ((n + 9) % 12 + 12) % 12;
      const isDo = c === 0, inScale = deg.includes(c);
      const X = Math.round(xOf(n)) + 0.5;
      g.strokeStyle = isDo ? 'rgba(198,244,50,0.6)' : inScale ? 'rgba(198,244,50,0.28)' : 'rgba(255,255,255,0.07)';
      g.lineWidth = isDo ? 2 : 1;
      g.beginPath(); g.moveTo(X, 4); g.lineTo(X, H - 18 * k); g.stroke();
      if (inScale && (P.scale !== 'cromatica' || isDo || W > 700)) {
        g.fillStyle = isDo ? '#C6F432' : 'rgba(198,244,50,0.7)';
        const lab = isDo ? `${NOTE_IT[c]}${4 + Math.floor((n + 9) / 12)}` : NOTE_IT[c], hw = g.measureText(lab).width / 2 + 2;
        g.fillText(lab, Math.min(W - hw, Math.max(hw, X)), H - 3);
      }
    }
    if (S.u != null) {
      const X = isFinite(S.n) ? xOf(S.n) : S.u * W;
      const R = 14 * Math.sqrt(k);
      g.shadowColor = '#C6F432'; g.shadowBlur = S.playing ? 18 : 0;
      g.fillStyle = S.playing ? '#C6F432' : 'rgba(198,244,50,0.45)';
      g.beginPath(); g.arc(X, (H - 18 * k) / 2 + 2, R, 0, 2 * Math.PI); g.fill(); g.shadowBlur = 0;
    }
  }

  function paint() {
    el.querySelectorAll('[data-src]').forEach((b) => b.classList.toggle('active', b.dataset.src === P.src));
    el.querySelectorAll('[data-scale]').forEach((b) => b.classList.toggle('active', b.dataset.scale === P.scale));
    $('.irange').value = P.range; $('.ivol').value = P.vol;
    const nt = isFinite(S.f) ? noteOf(S.f) : null;
    $('.in-name').textContent = nt ? (P.scale === 'continua' && Math.abs(nt.cents) > 10 ? `≈ ${nt.label}` : nt.label) : '—';
    $('.in-f').textContent = isFinite(S.f) ? `${fmtIt(S.f, 1)} Hz` : '';
    $('.in-d').textContent = P.src === 'sonar' && isFinite(S.d) ? `mano a ${fmtIt(S.d * 100, 0)} cm` : P.src === 'tilt' && S.tilt != null ? `inclinazione ${fmtIt(S.tilt, 0)}°` : '';
    $('.in-eq').innerHTML = isFinite(S.n)
      ? `f = 440 · 2<sup>n/12</sup> &nbsp;con&nbsp; n = <b>${fmtIt(S.n, P.scale === 'continua' ? 2 : 0)}</b> semitoni dal La4`
      : 'f = 440 · 2<sup>n/12</sup>';
    const live = P.src === 'finger' ? false : S.playing || S.acq;
    $('.iplay').hidden = P.src === 'finger';
    $('.iplay').textContent = live ? '■ Ferma' : '▶ Suona';
    $('.iplay').classList.toggle('on', live);
    $('.in-hint').textContent = {
      finger: 'Tieni premuto sul nastro e scorri: a destra le note alte.',
      tilt: 'Inclina il telefono a destra e a sinistra.',
      sonar: `Avvicina la mano al sensore (${D_NEAR * 100}–${D_FAR * 100} cm): più vicina, nota più alta.`,
    }[P.src];
    drawRibbon();
  }

  el.querySelectorAll('[data-src]').forEach((b) => b.addEventListener('click', async () => { await stop(); P.src = b.dataset.src; save(); S.u = null; S.f = NaN; S.n = NaN; paint(); api.onSource?.(P.src); }));
  el.querySelectorAll('[data-scale]').forEach((b) => b.addEventListener('click', () => { P.scale = b.dataset.scale; save(); setU(S.u); }));
  $('.irange').addEventListener('change', (e) => { P.range = e.target.value; save(); setU(S.u); });
  $('.ivol').addEventListener('input', (e) => { P.vol = +e.target.value; save(); if (S.playing) S.voice?.setLevel(P.vol * 0.6); });
  $('.iplay').addEventListener('click', play);
  const ro = new ResizeObserver(() => drawRibbon()); ro.observe(cv);
  paint();

  return {
    onLine,
    usesArduino: () => P.src === 'sonar',
    destroy() { stop(); S.voice?.dispose(); ed.destroy(); ro.disconnect(); },
    linkChanged() { if (!api.ready() && S.acq) { S.acq = false; soundOff(); } },
  };
}
