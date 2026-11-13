// Mosaicus — elaborazione dei segnali per l'oscilloscopio, il generatore e lo strumento.
// Funzioni pure (niente DOM, niente Web Audio): si provano con node nei test.
//
//  • fft            trasformata di Fourier veloce (radix 2, sul posto)
//  • spectrum       spettro di ampiezza con finestra di Hann
//  • pitch          frequenza fondamentale con l'autocorrelazione (calcolata via FFT)
//  • findTrigger    trigger dell'oscilloscopio: attraversamento di un livello nel verso scelto
//  • harmonics      ampiezze delle armoniche n·f₀ lette dallo spettro ("ricetta del timbro")
//  • noteOf, noteFreq, snapToScale   note del temperamento equabile, f = 440·2^(n/12)
//  • synth          somma di armoniche: y(t) = Σ Aₙ sin(2π n f t)

/** FFT sul posto (re, im di lunghezza potenza di 2). inverse = true per l'antitrasformata (non normalizzata). */
export function fft(re, im, inverse = false) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

const pow2 = (n) => 1 << Math.ceil(Math.log2(Math.max(2, n)));

/**
 * Spettro di ampiezza (finestra di Hann, media tolta). Restituisce { mag, df }:
 * mag[k] è l'ampiezza della componente a frequenza k·df, nella stessa unità del segnale
 * (una sinusoide di ampiezza A dà un picco alto ≈ A).
 */
export function spectrum(x, sr, size = null) {
  const n = size || pow2(x.length);
  const m = Math.min(x.length, n);
  let mean = 0; for (let i = 0; i < m; i++) mean += x[i]; mean /= m || 1;
  const re = new Float64Array(n), im = new Float64Array(n);
  let wsum = 0;
  for (let i = 0; i < m; i++) { const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (m - 1)); re[i] = (x[i] - mean) * w; wsum += w; }
  fft(re, im);
  const mag = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) mag[k] = (2 * Math.hypot(re[k], im[k])) / (wsum || 1);
  return { mag, df: sr / n };
}

/** Vertice della parabola per tre punti equidistanti (interpolazione di un picco). */
function parabolic(a, b, c) {
  const d = a - 2 * b + c;
  return d === 0 ? 0 : (0.5 * (a - c)) / d;
}

/**
 * Frequenza fondamentale con l'autocorrelazione normalizzata.
 * Si cerca il primo massimo dell'autocorrelazione che superi una frazione (0,85) del massimo
 * assoluto, dopo il primo passaggio per lo zero: è il periodo T. Restituisce
 * { f, T, clarity } con clarity ∈ [0, 1] (vicino a 1 = suono periodico pulito), oppure null.
 */
export function pitch(x, sr, { fmin = 40, fmax = 4000, threshold = 0.85, minRms = 0.004 } = {}) {
  const N = x.length;
  if (N < 64) return null;
  let mean = 0; for (let i = 0; i < N; i++) mean += x[i]; mean /= N;
  let e = 0; for (let i = 0; i < N; i++) e += (x[i] - mean) ** 2;
  if (Math.sqrt(e / N) < minRms) return null;
  const n = pow2(2 * N);
  const re = new Float64Array(n), im = new Float64Array(n);
  for (let i = 0; i < N; i++) re[i] = x[i] - mean;
  fft(re, im);
  for (let k = 0; k < n; k++) { re[k] = re[k] * re[k] + im[k] * im[k]; im[k] = 0; }
  fft(re, im, true);
  // autocorrelazione "senza distorsione": divido per il numero di prodotti (N − τ)
  const maxLag = Math.min(Math.floor(sr / fmin), Math.floor(N * 0.6));
  const minLag = Math.max(2, Math.floor(sr / fmax));
  const r0 = re[0] / N;
  const r = new Float64Array(maxLag + 2);
  for (let t = 0; t <= maxLag + 1 && t < N; t++) r[t] = re[t] / (N - t) / r0;
  let t = minLag;
  while (t < maxLag && r[t] > 0) t++;          // supera il primo lobo
  let best = -Infinity;
  for (let k = t; k <= maxLag; k++) if (r[k] > best) best = r[k];
  if (!(best > 0.3)) return null;
  for (let k = Math.max(t, 1); k <= maxLag; k++) {
    if (r[k] >= threshold * best && r[k] >= r[k - 1] && r[k] >= r[k + 1]) {
      const lag = k + parabolic(r[k - 1], r[k], r[k + 1]);
      const f = sr / lag;
      return { f, T: 1 / f, clarity: Math.min(1, r[k]) };
    }
  }
  return null;
}

/**
 * Trigger: primo indice ≥ from in cui il segnale attraversa `level` nel verso `edge`
 * (+1 salita, −1 discesa), dopo essere stato oltre la soglia di isteresi dalla parte opposta.
 * L'istante è interpolato tra due campioni (indice frazionario). −1 se non c'è.
 */
export function findTrigger(x, { level = 0, hyst = 0.01, edge = 1, from = 0, to = x.length } = {}) {
  let armed = false;
  for (let i = Math.max(1, from); i < to; i++) {
    const v = edge > 0 ? x[i] - level : level - x[i];
    if (v < -hyst) armed = true;
    else if (armed && v >= 0) {
      const p = edge > 0 ? x[i - 1] - level : level - x[i - 1];
      return i - 1 + (p < 0 ? -p / (v - p) : 0);
    }
  }
  return -1;
}

/**
 * Ampiezze delle prime `count` armoniche di f0 lette dallo spettro: per ciascuna il massimo
 * entro ±3 % della frequenza attesa. Restituisce [{ n, f, a, rel }] con rel = a / a₁.
 */
export function harmonics(mag, df, f0, count = 8) {
  const out = [];
  for (let n = 1; n <= count; n++) {
    const fc = n * f0;
    const k0 = Math.max(1, Math.floor((fc * 0.97) / df)), k1 = Math.min(mag.length - 2, Math.ceil((fc * 1.03) / df));
    if (k0 > k1) { out.push({ n, f: fc, a: 0 }); continue; }
    let kb = k0; for (let k = k0; k <= k1; k++) if (mag[k] > mag[kb]) kb = k;
    const p = parabolic(mag[kb - 1], mag[kb], mag[kb + 1]);
    out.push({ n, f: (kb + p) * df, a: mag[kb] - 0.25 * (mag[kb - 1] - mag[kb + 1]) * p });
  }
  const a1 = out[0]?.a || 1;
  out.forEach((h) => (h.rel = h.a / a1));
  return out;
}

// ---------------------------------------------------------------------------
// Note musicali (temperamento equabile, La₄ = 440 Hz)
// ---------------------------------------------------------------------------
export const NOTE_IT = ['Do', 'Do♯', 'Re', 'Re♯', 'Mi', 'Fa', 'Fa♯', 'Sol', 'Sol♯', 'La', 'La♯', 'Si'];

/** n = numero di semitoni da La₄ (n = 0 → 440 Hz). */
export const noteFreq = (n, a4 = 440) => a4 * Math.pow(2, n / 12);

/** Nota più vicina a f: { n, name, octave, label, cents, fNote }. cents = scarto in centesimi di semitono. */
export function noteOf(f, a4 = 440) {
  if (!(f > 0)) return null;
  const x = 12 * Math.log2(f / a4);
  const n = Math.round(x);
  const idx = ((n + 9) % 12 + 12) % 12;          // La = indice 9
  const octave = 4 + Math.floor((n + 9) / 12);
  return { n, name: NOTE_IT[idx], octave, label: `${NOTE_IT[idx]}${octave}`, cents: Math.round((x - n) * 100), fNote: noteFreq(n, a4) };
}

/** Gradi delle scale, in semitoni dalla tonica (la tonica si sceglie a parte: Do, Re, Mi…). */
export const SCALES = {
  continua: null,
  cromatica: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  // luminose
  maggiore: [0, 2, 4, 5, 7, 9, 11],           // = modo ionico
  lidia: [0, 2, 4, 6, 7, 9, 11],
  misolidia: [0, 2, 4, 5, 7, 9, 10],
  pentatonica: [0, 2, 4, 7, 9],
  // malinconiche
  minore: [0, 2, 3, 5, 7, 8, 10],             // = minore naturale = modo eolio
  dorica: [0, 2, 3, 5, 7, 9, 10],
  frigia: [0, 1, 3, 5, 7, 8, 10],
  locria: [0, 1, 3, 5, 6, 8, 10],
  minoreArmonica: [0, 2, 3, 5, 7, 8, 11],
  minoreMelodica: [0, 2, 3, 5, 7, 9, 11],     // salendo
  pentatonicaMin: [0, 3, 5, 7, 10],
  // esotiche
  araba: [0, 1, 4, 5, 7, 8, 11],              // doppia armonica
  napoletana: [0, 1, 3, 5, 7, 8, 11],         // minore napoletana
  ungherese: [0, 2, 3, 6, 7, 8, 11],          // minore ungherese
  giapponese: [0, 2, 3, 7, 8],                // hirajoshi
  spagnola: [0, 1, 4, 5, 7, 8, 10],           // frigia dominante
  // blues e altre
  blues: [0, 3, 5, 6, 7, 10],
  bluesMag: [0, 2, 3, 4, 7, 9],
  esatonale: [0, 2, 4, 6, 8, 10],
  diminuita: [0, 2, 3, 5, 6, 8, 9, 11],       // tono-semitono
};

/** Aggancia la frequenza alla nota della scala più vicina (in semitoni); root = tonica in semitoni sopra il Do (0…11). */
export function snapToScale(f, scale = 'cromatica', a4 = 440, root = 0) {
  const deg = SCALES[scale];
  if (!deg || !(f > 0)) return f;
  const x = 12 * Math.log2(f / a4) + 9;          // semitoni da Do₄
  let best = null;
  for (let oct = Math.floor(x / 12) - 2; oct <= Math.floor(x / 12) + 1; oct++) {
    for (const d of deg) { const s = oct * 12 + root + d; if (best == null || Math.abs(s - x) < Math.abs(best - x)) best = s; }
  }
  return noteFreq(best - 9, a4);
}

// ---------------------------------------------------------------------------
// Sintesi additiva e timbri di esempio
// ---------------------------------------------------------------------------
/** Campioni di y(t) = Σ Aₙ sin(2π n f t + φₙ), normalizzati con picco 1 se normalize. */
export function synth(amps, f, sr, n, { phases = null, normalize = true, t0 = 0 } = {}) {
  const y = new Float64Array(n);
  amps.forEach((A, k) => {
    if (!A) return;
    const w = (2 * Math.PI * (k + 1) * f) / sr, ph = phases?.[k] ?? 0;
    for (let i = 0; i < n; i++) y[i] += A * Math.sin(w * (i + t0 * sr) + ph);
  });
  if (normalize) { let p = 0; for (let i = 0; i < n; i++) p = Math.max(p, Math.abs(y[i])); if (p > 0) for (let i = 0; i < n; i++) y[i] /= p; }
  return y;
}

/** Ricette dei timbri (ampiezze delle armoniche 1…8): valori relativi, approssimati ma plausibili. */
export const TIMBRES = {
  sinusoide:  { label: 'Sinusoide (diapason)', amps: [1, 0, 0, 0, 0, 0, 0, 0] },
  flauto:     { label: 'Flauto', amps: [1, 0.45, 0.18, 0.08, 0.04, 0.02, 0, 0] },
  clarinetto: { label: 'Clarinetto', amps: [1, 0.04, 0.6, 0.05, 0.4, 0.04, 0.25, 0.03] },
  violino:    { label: 'Violino', amps: [1, 0.72, 0.55, 0.42, 0.5, 0.25, 0.2, 0.15] },
  voce:       { label: 'Voce, vocale «a»', amps: [0.55, 0.8, 1, 0.9, 0.45, 0.35, 0.2, 0.1] },
  organo:     { label: 'Organo', amps: [1, 0.8, 0, 0.6, 0, 0, 0, 0.4] },
  quadra:     { label: 'Onda quadra', amps: [1, 0, 1 / 3, 0, 1 / 5, 0, 1 / 7, 0] },
  dente:      { label: 'Dente di sega', amps: [1, 1 / 2, 1 / 3, 1 / 4, 1 / 5, 1 / 6, 1 / 7, 1 / 8] },
};

/** Arrotonda alle cifre significative (per le letture). */
export const sig = (v, d = 3) => (isFinite(v) && v !== 0 ? +v.toPrecision(d) : v);
