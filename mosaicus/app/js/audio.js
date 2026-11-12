// Mosaicus — motore audio condiviso (Web Audio API).
//
// Un solo AudioContext per tutta l'app. Tutto ciò che l'app suona (generatore, strumento,
// suoni di esempio) passa da un'uscita comune ("master") e da un analizzatore "monitor":
// così l'oscilloscopio può guardare il segnale direttamente, senza microfono.
//
//   generatore ─┐
//   strumento  ─┼─► master (volume) ─► monitor (AnalyserNode) ─► altoparlanti
//   esempi     ─┘
//   microfono  ───► micAnalyser (AnalyserNode, non va agli altoparlanti)

let ctx = null, master = null, monitor = null;
let mic = null; // { stream, src, analyser }

export const audioSupported = () => typeof window !== 'undefined' && !!(window.AudioContext || window.webkitAudioContext);

/**
 * Tipo di sessione audio (Safari su iPhone/iPad). Il valore predefinito è "ambient": con
 * l'interruttore laterale su silenzioso i suoni della pagina sono muti. "playback" li fa
 * suonare come una app di musica; "play-and-record" serve mentre si usa il microfono.
 */
function sessionType(type) {
  try { if ('audioSession' in navigator && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch { /* non supportato */ }
}

/** Il contesto audio va creato/ripreso dentro un tocco o un clic (regola dei browser). */
export function audio() {
  if (!mic) sessionType('playback');
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC({ latencyHint: 'interactive' });
    master = ctx.createGain(); master.gain.value = 0.8;
    monitor = ctx.createAnalyser(); monitor.fftSize = 16384; monitor.smoothingTimeConstant = 0;
    master.connect(monitor); monitor.connect(ctx.destination);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return { ctx, master, monitor };
}

// i browser avviano l'audio "sospeso": lo riprendo al primo tocco
if (typeof document !== 'undefined') document.addEventListener('pointerdown', () => { if (ctx && ctx.state !== 'running') ctx.resume(); }, true);

export function monitorAnalyser() { return audio().monitor; }

/** Microfono: analizzatore con il segnale "pulito" (niente cancellazione d'eco, niente controllo automatico del guadagno). */
export async function micAnalyser() {
  if (mic) return mic.analyser;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('questo browser non dà accesso al microfono');
  if (!window.isSecureContext) throw new Error('il microfono funziona solo da una pagina sicura (https)');
  sessionType('play-and-record');
  const { ctx: c } = audio();
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
  const src = c.createMediaStreamSource(stream);
  const analyser = c.createAnalyser(); analyser.fftSize = 16384; analyser.smoothingTimeConstant = 0;
  src.connect(analyser);
  mic = { stream, src, analyser };
  return analyser;
}

export function closeMic() {
  if (!mic) return;
  mic.stream.getTracks().forEach((t) => t.stop());
  mic.src.disconnect();
  mic = null;
  sessionType('playback');
}

/** Onda periodica da una ricetta di armoniche (ampiezze dei seni, fasi nulle). */
export function periodicWave(amps) {
  const { ctx: c } = audio();
  const n = amps.length + 1;
  const real = new Float32Array(n), imag = new Float32Array(n);
  amps.forEach((a, k) => (imag[k + 1] = a));
  return c.createPeriodicWave(real, imag, { disableNormalization: false });
}

/**
 * Una "voce": oscillatore → guadagno → master. Forma d'onda standard (sine, square,
 * triangle, sawtooth) oppure ricetta di armoniche. Le variazioni di frequenza e volume
 * sono raccordate (setTargetAtTime) per non sentire "click".
 */
export class Voice {
  constructor({ type = 'sine', amps = null, freq = 440, gain = 0.3 } = {}) {
    const { ctx: c, master: m } = audio();
    this.c = c;
    this.osc = c.createOscillator();
    this.g = c.createGain(); this.g.gain.value = 0;
    this.osc.connect(this.g); this.g.connect(m);
    this.setWave(type, amps);
    this.osc.frequency.value = freq;
    this.level = gain;
    this.osc.start();
    this.on = false;
  }
  setWave(type, amps) {
    if (amps) this.osc.setPeriodicWave(periodicWave(amps));
    else this.osc.type = type;
  }
  setFreq(f, glide = 0.015) { this.osc.frequency.setTargetAtTime(f, this.c.currentTime, glide); }
  setLevel(g) { this.level = g; if (this.on) this.g.gain.setTargetAtTime(g, this.c.currentTime, 0.02); }
  start() { this.on = true; this.g.gain.setTargetAtTime(this.level, this.c.currentTime, 0.02); }
  stop() { this.on = false; this.g.gain.setTargetAtTime(0, this.c.currentTime, 0.02); }
  dispose() {
    this.stop();
    const o = this.osc, g = this.g;
    setTimeout(() => { try { o.stop(); o.disconnect(); g.disconnect(); } catch { /* già fermo */ } }, 200);
  }
}

/** Legge l'ultimo blocco di campioni da un analizzatore. */
export function readSamples(analyser, buf) {
  if (!buf || buf.length !== analyser.fftSize) buf = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(buf);
  return buf;
}

export const sampleRate = () => (ctx ? ctx.sampleRate : 48000);
