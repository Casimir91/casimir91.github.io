// Mosaicus — motore di fit unico, uguale per tutti gli esperimenti.
//
// Ogni modello restituisce: parametri con incertezza standard (σ, dalla matrice di
// covarianza s²·(JᵀJ)⁻¹), equazione con i numeri, R², residui e la curva.
// I modelli lineari nei parametri (media, retta, polinomi) usano i minimi quadrati
// esatti; gli altri (esponenziali, potenza, sinusoide smorzata) Levenberg–Marquardt
// con una stima iniziale automatica.
//
// Le equazioni si scrivono con i simboli veri degli assi (es. v = m·t + q).
// Retta e polinomi: il calcolo avviene in τ = t − t₁ (ben condizionato anche a t = 38 s),
// poi i coefficienti e la loro covarianza sono riportati all'origine t = 0.
// Esponenziali e sinusoide: i parametri si riferiscono all'inizio dell'intervallo t₁,
// che compare esplicitamente nell'equazione come (t − t₁) con il suo valore numerico.

import { polyfit, evalPoly, invert, fmt } from './analysis.js';

const SUP = ['', '', '²', '³', '⁴'];
const powUnit = (xU, k) => (k === 0 ? '' : k === 1 ? `/${xU}` : `/${xU}${SUP[k]}`);
const joinU = (yU, rest) => (yU && rest ? `${yU}${rest}` : yU || (rest ? `1${rest}` : ''));
const n4 = (v) => fmt(v, 4);
const sgn = (v) => (v < 0 ? ' − ' : ' + ');

// ---------------------------------------------------------------------------
// Levenberg–Marquardt generico con jacobiano numerico (differenze centrali)
// ---------------------------------------------------------------------------
export function levenberg(f, p0, x, y, { maxIter = 400 } = {}) {
  const n = x.length, m = p0.length;
  let p = [...p0];
  const sse = (q) => { let s = 0; for (let i = 0; i < n; i++) { const r = y[i] - f(q, x[i]); s += r * r; } return isFinite(s) ? s : Infinity; };
  const jac = (q) => {
    const J = Array.from({ length: n }, () => new Array(m));
    for (let k = 0; k < m; k++) {
      const h = 1e-6 * Math.max(Math.abs(q[k]), 1e-3);
      const qa = [...q], qb = [...q]; qa[k] += h; qb[k] -= h;
      for (let i = 0; i < n; i++) J[i][k] = (f(qa, x[i]) - f(qb, x[i])) / (2 * h);
    }
    return J;
  };
  let cur = sse(p), lambda = 1e-3;
  for (let it = 0; it < maxIter; it++) {
    const J = jac(p);
    const JtJ = Array.from({ length: m }, () => new Array(m).fill(0));
    const Jtr = new Array(m).fill(0);
    for (let i = 0; i < n; i++) {
      const r = y[i] - f(p, x[i]);
      for (let a = 0; a < m; a++) { Jtr[a] += J[i][a] * r; for (let b = 0; b < m; b++) JtJ[a][b] += J[i][a] * J[i][b]; }
    }
    const inv = invert(JtJ.map((row, i) => row.map((v, j) => (i === j ? v + lambda * (v || 1e-12) : v))));
    if (!inv) { lambda *= 10; if (lambda > 1e15) break; continue; }
    const d = inv.map((row) => row.reduce((s, v, j) => s + v * Jtr[j], 0));
    const trial = p.map((v, k) => v + d[k]);
    const s = sse(trial);
    if (s < cur) {
      const rel = (cur - s) / (cur || 1);
      p = trial; cur = s; lambda = Math.max(lambda / 10, 1e-15);
      if (rel < 1e-13) break;
    } else {
      lambda *= 10;
      if (lambda > 1e15) break;
    }
  }
  const J = jac(p);
  const JtJ = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) JtJ[a][b] += J[i][a] * J[i][b];
  const inv = invert(JtJ);
  const s2 = cur / Math.max(1, n - m);
  const sigma = inv ? inv.map((row, i) => Math.sqrt(Math.abs(row[i]) * s2)) : new Array(m).fill(NaN);
  return { p, sigma, sse: cur };
}

// ---------------------------------------------------------------------------
// Stime iniziali
// ---------------------------------------------------------------------------
const avgNear = (x, y, x0, w) => { let s = 0, c = 0; for (let i = 0; i < x.length; i++) if (Math.abs(x[i] - x0) <= w) { s += y[i]; c++; } return c ? s / c : NaN; };

/** Esponenziale con asintoto, metodo dei tre punti: (y_m − C)² = (y_0 − C)(y_2 − C). */
function guessExpC(tau, y) {
  const T = tau[tau.length - 1], w = T * 0.04;
  const y0 = avgNear(tau, y, 0, w), y1 = avgNear(tau, y, T / 2, w), y2 = avgNear(tau, y, T, w);
  const den = y0 + y2 - 2 * y1;
  let C = Math.abs(den) > 1e-12 ? (y0 * y2 - y1 * y1) / den : NaN;
  if (!isFinite(C) || (y0 - C) * (y2 - C) <= 0) C = y2 - 0.25 * (y0 - y2);
  const A = y0 - C;
  let k = Math.log((y2 - C) / A) / T;
  if (!isFinite(k)) k = -1 / (T || 1);
  return [C, A, k];
}

/** Sinusoide: periodo dai passaggi per il valore medio, fase per ricerca a griglia. */
function guessSin(tau, y) {
  const n = y.length;
  const C = y.reduce((s, v) => s + v, 0) / n;
  const A = (Math.max(...y) - Math.min(...y)) / 2;
  const up = [];
  for (let i = 1; i < n; i++) if (y[i - 1] < C && y[i] >= C) up.push(tau[i - 1] + ((C - y[i - 1]) / (y[i] - y[i - 1])) * (tau[i] - tau[i - 1]));
  const T = up.length >= 2 ? (up[up.length - 1] - up[0]) / (up.length - 1) : tau[n - 1];
  const w = (2 * Math.PI) / T;
  let best = 0, bestS = Infinity;
  for (let j = 0; j < 24; j++) {
    const ph = (j / 24) * 2 * Math.PI;
    let s = 0; for (let i = 0; i < n; i++) s += (y[i] - C - A * Math.sin(w * tau[i] + ph)) ** 2;
    if (s < bestS) { bestS = s; best = ph; }
  }
  return [C, A, 0, w, best];
}

// ---------------------------------------------------------------------------
// Catalogo dei modelli
// ---------------------------------------------------------------------------
const binom = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return r; };

function polyModel(deg, label) {
  return {
    label, short: deg === 1 ? 'retta' : `polinomio di grado ${deg}`,
    formula: deg === 1 ? 'y = m·x + q' : `y = c₀ + c₁·x${deg >= 2 ? ' + c₂·x²' : ''}${deg >= 3 ? ' + c₃·x³' : ''}${deg >= 4 ? ' + c₄·x⁴' : ''}`,
    minPoints: deg + 2,
    run(t, y, U) {
      const f = polyfit(t, y, deg, t[0]); if (!f) return null;
      // da τ = t − t₁ a t:  a_j = Σ_k c_k·C(k,j)·(−t₁)^(k−j);  cov_a = J·cov_c·Jᵀ
      const t1 = f.tRef, p = deg + 1;
      const J = Array.from({ length: p }, (_, j) => Array.from({ length: p }, (_, k) => (k >= j ? binom(k, j) * Math.pow(-t1, k - j) : 0)));
      const a = J.map((row) => row.reduce((s, v, k) => s + v * f.coef[k], 0));
      const covA = J.map((rj) => J.map((rl) => rj.reduce((s, v, k) => s + v * rl.reduce((u, w, m) => u + w * f.cov[k][m], 0), 0)));
      const sa = covA.map((row, i) => Math.sqrt(Math.abs(row[i])));
      const xs = U.xs || 'x', ys = U.ys || 'y';
      if (deg === 1) {
        // retta: sempre nella forma familiare y = m·x + q (q = valore per x = 0)
        return {
          params: [{ key: 'm', sym: 'm (pendenza)', value: a[1], sigma: sa[1], unit: joinU(U.y, powUnit(U.x, 1)) },
            { key: 'q', sym: `q (valore di ${ys} per ${xs} = 0)`, value: a[0], sigma: sa[0], unit: U.y }],
          eq: `${ys} = ${n4(a[1])}·${xs}${sgn(a[0])}${n4(Math.abs(a[0]))}`,
          curve: (tt) => evalPoly(a, tt), tRef: null,
        };
      }
      // polinomi: se l'intervallo parte lontano da 0 si scrive in (x − x₁), più leggibile
      const far = Math.abs(t1) > 1e-9;
      const cc = far ? f.coef : a, ss = far ? f.sigma : sa, xx = shifted(xs, t1);
      return {
        params: cc.map((c, k) => ({ key: `c${k}`, sym: k === 0 && far ? `c₀ (valore di ${ys} per ${xs} = ${n4(t1)})` : `c${'₀₁₂₃₄'[k]}`, value: c, sigma: ss[k], unit: joinU(U.y, powUnit(U.x, k)) })),
        eq: `${ys} = ` + cc.map((c, k) => (k === 0 ? n4(c) : `${sgn(c)}${n4(Math.abs(c))}·${xx}${SUP[k] || ''}`)).join(''),
        curve: (tt) => evalPoly(f.coef, tt - t1), tRef: far ? t1 : null,
      };
    },
  };
}

/** "(t − 1,25)" oppure "t" se l'intervallo parte da zero. */
const shifted = (xs, t1) => (Math.abs(t1) < 1e-12 ? xs : `(${xs} − ${n4(t1)})`);

export const MODELS = {
  mean: {
    label: 'Costante (media)', short: 'media', formula: 'y = ȳ', minPoints: 2,
    run(t, y, U) {
      const f = polyfit(t, y, 0, 0); if (!f) return null;
      return {
        params: [{ key: 'mean', sym: 'ȳ', value: f.coef[0], sigma: f.sigma[0], unit: U.y }, { key: 'sd', sym: 's (dispersione dei dati)', value: f.s, sigma: NaN, unit: U.y }],
        eq: `${U.ys || 'y'} = ${n4(f.coef[0])}`, curve: () => f.coef[0], tRef: null,
      };
    },
  },
  lin: polyModel(1, 'Retta'),
  poly2: polyModel(2, 'Parabola (grado 2)'),
  poly3: polyModel(3, 'Polinomio di grado 3'),
  poly4: polyModel(4, 'Polinomio di grado 4'),
  exp: {
    label: 'Esponenziale', short: 'esponenziale', formula: 'y = A·e^(k·(x − x₁))', minPoints: 4,
    run(t, y, U) {
      const t0 = t[0], tau = t.map((v) => v - t0);
      let p0 = [y[0] || 1, 0];
      if (y.every((v) => v > 0) || y.every((v) => v < 0)) {
        const s = Math.sign(y[0]); const g = polyfit(tau, y.map((v) => Math.log(s * v)), 1, 0);
        if (g) p0 = [s * Math.exp(g.coef[0]), g.coef[1]];
      }
      const f = (p, x) => p[0] * Math.exp(p[1] * x);
      const r = levenberg(f, p0, tau, y);
      return {
        params: [{ key: 'A', sym: 'A', value: r.p[0], sigma: r.sigma[0], unit: U.y }, { key: 'k', sym: 'k', value: r.p[1], sigma: r.sigma[1], unit: `${U.x}⁻¹` }],
        eq: `${U.ys || 'y'} = ${n4(r.p[0])}·e^(${n4(r.p[1])}·${shifted(U.xs || 'x', t0)})`, curve: (tt) => f(r.p, tt - t0), tRef: t0,
      };
    },
  },
  expC: {
    label: 'Esponenziale con asintoto', short: 'esponenziale con asintoto', formula: 'y = C + A·e^(k·(x − x₁))', minPoints: 5,
    run(t, y, U) {
      const t0 = t[0], tau = t.map((v) => v - t0);
      const f = (p, x) => p[0] + p[1] * Math.exp(p[2] * x);
      const r = levenberg(f, guessExpC(tau, y), tau, y);
      return {
        params: [
          { key: 'C', sym: 'C (asintoto)', value: r.p[0], sigma: r.sigma[0], unit: U.y },
          { key: 'A', sym: 'A', value: r.p[1], sigma: r.sigma[1], unit: U.y },
          { key: 'k', sym: 'k', value: r.p[2], sigma: r.sigma[2], unit: `${U.x}⁻¹` },
        ],
        eq: `${U.ys || 'y'} = ${n4(r.p[0])}${sgn(r.p[1])}${n4(Math.abs(r.p[1]))}·e^(${n4(r.p[2])}·${shifted(U.xs || 'x', t0)})`, curve: (tt) => f(r.p, tt - t0), tRef: t0,
      };
    },
  },
  power: {
    label: 'Potenza', short: 'potenza', formula: 'y = A·xⁿ', minPoints: 4,
    run(t, y, U) {
      if (!t.every((v) => v > 0)) return { error: 'La potenza richiede t > 0 in tutto l\'intervallo.' };
      let p0 = [y[0] || 1, 1];
      if (y.every((v) => v > 0)) { const g = polyfit(t.map(Math.log), y.map(Math.log), 1, 0); if (g) p0 = [Math.exp(g.coef[0]), g.coef[1]]; }
      const f = (p, x) => p[0] * Math.pow(x, p[1]);
      const r = levenberg(f, p0, t, y);
      return {
        params: [{ key: 'A', sym: 'A', value: r.p[0], sigma: r.sigma[0], unit: '' }, { key: 'n', sym: 'n (esponente)', value: r.p[1], sigma: r.sigma[1], unit: '' }],
        eq: `${U.ys || 'y'} = ${n4(r.p[0])}·${U.xs || 'x'}^${n4(r.p[1])}`, curve: (tt) => f(r.p, tt), tRef: null,
      };
    },
  },
  dsin: {
    label: 'Sinusoide smorzata', short: 'sinusoide smorzata', formula: 'y = C + A·e^(−γ·(x − x₁))·sin(ω·(x − x₁) + φ)', minPoints: 8,
    run(t, y, U) {
      const t0 = t[0], tau = t.map((v) => v - t0);
      const f = (p, x) => p[0] + p[1] * Math.exp(-p[2] * x) * Math.sin(p[3] * x + p[4]);
      const r = levenberg(f, guessSin(tau, y), tau, y);
      let [C, A, g, w, ph] = r.p;
      if (w < 0) { w = -w; ph = -ph + Math.PI; }
      if (A < 0) { A = -A; ph += Math.PI; }
      ph = ((ph % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
      const p = [C, A, g, w, ph];
      return {
        params: [
          { key: 'C', sym: 'C (centro)', value: C, sigma: r.sigma[0], unit: U.y },
          { key: 'A', sym: 'A (ampiezza a inizio intervallo)', value: A, sigma: r.sigma[1], unit: U.y },
          { key: 'g', sym: 'γ (smorzamento)', value: g, sigma: r.sigma[2], unit: `${U.x}⁻¹` },
          { key: 'w', sym: 'ω (pulsazione)', value: w, sigma: r.sigma[3], unit: `rad/${U.x}` },
          { key: 'phi', sym: 'φ (fase a inizio intervallo)', value: ph, sigma: r.sigma[4], unit: 'rad' },
        ],
        eq: (() => { const xx = shifted(U.xs || 'x', t0); return `${U.ys || 'y'} = ${n4(C)}${sgn(A)}${n4(A)}·e^(${g >= 0 ? '−' : '+'}${n4(Math.abs(g))}·${xx})·sin(${n4(w)}·${xx}${sgn(ph)}${n4(Math.abs(ph))})`; })(), curve: (tt) => f(p, tt - t0), tRef: t0,
      };
    },
  },
};

/** Ordine in cui i modelli compaiono nel riquadro Analisi. */
export const MODEL_ORDER = ['lin', 'poly2', 'poly3', 'poly4', 'exp', 'expC', 'power', 'dsin', 'mean'];

/**
 * Esegue un fit. t, y: dati nell'intervallo scelto. units: { x: 's', y: 'm' }.
 * Restituisce { model, params, eq, r2, n, s, curve, residuals, t1, t2 } oppure { error }.
 */
export function runModel(id, t, y, units) {
  const M = MODELS[id];
  if (!M) return { error: 'Modello sconosciuto.' };
  if (t.length < M.minPoints) return { error: `Servono almeno ${M.minPoints} punti validi nell'intervallo.` };
  let r;
  try { r = M.run(t, y, units); } catch (e) { return { error: `Il fit non è riuscito (${e.message}).` }; }
  if (!r) return { error: 'Il fit non è riuscito: prova con un altro intervallo.' };
  if (r.error) return r;
  if (r.params.some((p) => p.key !== 'sd' && !isFinite(p.value))) return { error: 'Il fit non converge: prova un altro modello o un intervallo diverso.' };
  const n = t.length;
  const residuals = y.map((v, i) => v - r.curve(t[i]));
  const mean = y.reduce((s, v) => s + v, 0) / n;
  const sst = y.reduce((s, v) => s + (v - mean) ** 2, 0);
  const sse = residuals.reduce((s, v) => s + v * v, 0);
  const m = r.params.filter((p) => p.key !== 'sd').length;
  return {
    model: id, label: M.label, formula: M.formula, ...r,
    r2: sst > 0 ? 1 - sse / sst : NaN, n, s: Math.sqrt(sse / Math.max(1, n - m)),
    residuals, t1: t[0], t2: t[n - 1],
  };
}

/** Utilità per le "grandezze fisiche": valore e incertezza di un parametro per chiave. */
export const P = (fit, key) => { const p = fit.params.find((q) => q.key === key); return p ? [p.value, p.sigma] : [NaN, NaN]; };

/**
 * Test delle successioni (Wald–Wolfowitz) sui segni dei residui.
 * Se i residui sono casuali, il numero di "successioni" (gruppi consecutivi dello
 * stesso segno) è vicino a μ = 2·n₊·n₋/n + 1. Troppo poche successioni → i residui
 * hanno un andamento sistematico ("pancia"): il modello non descrive bene i dati.
 */
export function runsTest(residuals) {
  const sg = residuals.filter((r) => r !== 0 && isFinite(r)).map((r) => (r > 0 ? 1 : -1));
  const n = sg.length, np = sg.filter((v) => v > 0).length, nm = n - np;
  let runs = n ? 1 : 0;
  for (let i = 1; i < n; i++) if (sg[i] !== sg[i - 1]) runs++;
  const mu = (2 * np * nm) / (n || 1) + 1;
  const varR = n > 1 ? ((mu - 1) * (mu - 2)) / (n - 1) : NaN;
  const z = varR > 0 ? (runs - mu) / Math.sqrt(varR) : NaN;
  const verdict = !isFinite(z) ? 'pochi dati' : z < -2 ? 'sistematici' : 'casuali';
  return { n, np, nm, runs, mu, z, verdict };
}
