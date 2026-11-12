// Mosaicus — analisi numerica (nessuna dipendenza esterna)
// Minimi quadrati polinomiali con incertezze, derivate per regressione locale,
// fit esponenziale (legge di Newton del raffreddamento) con Levenberg–Marquardt.

// ---------- algebra lineare minima ----------

/** Inversa di una matrice quadrata (Gauss–Jordan con pivot parziale). */
export function invert(M) {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    if (Math.abs(A[p][c]) < 1e-300) return null; // singolare
    [A[c], A[p]] = [A[p], A[c]];
    const piv = A[c][c];
    for (let j = 0; j < 2 * n; j++) A[c][j] /= piv;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c];
      if (f !== 0) for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row) => row.slice(n));
}

// ---------- minimi quadrati polinomiali ----------

/**
 * Fit y = c0 + c1·τ + c2·τ² + …  con τ = t − tRef.
 * Restituisce coefficienti, incertezze standard (σ), covarianza, R², n.
 */
export function polyfit(t, y, deg, tRef = 0) {
  const n = t.length;
  const p = deg + 1;
  if (n < p) return null;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < n; i++) {
    const tau = t[i] - tRef;
    const pow = [1];
    for (let k = 1; k < p; k++) pow[k] = pow[k - 1] * tau;
    for (let a = 0; a < p; a++) {
      Xty[a] += pow[a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += pow[a] * pow[b];
    }
  }
  const inv = invert(XtX);
  if (!inv) return null;
  const c = inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
  let ssr = 0, mean = 0;
  for (let i = 0; i < n; i++) mean += y[i];
  mean /= n;
  let sst = 0;
  for (let i = 0; i < n; i++) {
    const r = y[i] - evalPoly(c, t[i] - tRef);
    ssr += r * r;
    sst += (y[i] - mean) ** 2;
  }
  const dof = n - p;
  const s2 = dof > 0 ? ssr / dof : NaN;
  const cov = inv.map((row) => row.map((v) => v * s2));
  const sigma = cov.map((row, i) => Math.sqrt(row[i]));
  const r2 = sst > 0 ? 1 - ssr / sst : NaN;
  return { coef: c, sigma, cov, r2, n, s: Math.sqrt(s2), tRef };
}

export function evalPoly(c, tau) {
  let v = 0;
  for (let k = c.length - 1; k >= 0; k--) v = v * tau + c[k];
  return v;
}

// ---------- derivate numeriche ----------

/**
 * Regressione polinomiale locale (Savitzky–Golay generalizzato a campionamento
 * non uniforme): per ogni punto si adatta una parabola ai 2h+1 punti vicini.
 * Restituisce { ys, d1, d2 }: valore lisciato, derivata prima e seconda.
 */
export function localPolyDerivs(t, y, h = 3) {
  const n = t.length;
  const ys = new Array(n).fill(NaN), d1 = new Array(n).fill(NaN), d2 = new Array(n).fill(NaN);
  if (n < 3) return { ys, d1, d2 };
  for (let i = 0; i < n; i++) {
    let lo = i - h, hi = i + h;
    if (lo < 0) { hi = Math.min(n - 1, hi - lo); lo = 0; }
    if (hi > n - 1) { lo = Math.max(0, lo - (hi - (n - 1))); hi = n - 1; }
    if (hi - lo + 1 < 3) continue;
    const tt = t.slice(lo, hi + 1), yy = y.slice(lo, hi + 1);
    const deg = Math.min(2, tt.length - 1);
    const f = fastPoly(tt, yy, deg, t[i]);
    if (!f) continue;
    ys[i] = f[0];
    d1[i] = f[1] ?? NaN;
    d2[i] = deg >= 2 ? 2 * f[2] : NaN;
  }
  return { ys, d1, d2 };
}

function fastPoly(t, y, deg, tRef) {
  const p = deg + 1;
  const XtX = Array.from({ length: p }, () => new Array(p).fill(0));
  const Xty = new Array(p).fill(0);
  for (let i = 0; i < t.length; i++) {
    const tau = t[i] - tRef;
    const pow = [1, tau, tau * tau];
    for (let a = 0; a < p; a++) {
      Xty[a] += pow[a] * y[i];
      for (let b = 0; b < p; b++) XtX[a][b] += pow[a] * pow[b];
    }
  }
  const inv = invert(XtX);
  if (!inv) return null;
  return inv.map((row) => row.reduce((s, v, j) => s + v * Xty[j], 0));
}

// ---------- fit esponenziale: T(τ) = Ta + A·exp(−τ/θ) ----------

/**
 * Levenberg–Marquardt su 3 parametri [Ta, A, θ] (θ = costante di tempo).
 * fixedTa: se è un numero, Ta resta fissato (fit a 2 parametri).
 */
export function fitNewtonCooling(t, y, { fixedTa = null } = {}) {
  const n = t.length;
  if (n < 4) return null;
  const tRef = t[0];
  const tau = t.map((v) => v - tRef);
  const yEnd = y[n - 1], y0 = y[0];
  let Ta = fixedTa ?? yEnd - 0.25 * (y0 - yEnd);
  let A = y0 - Ta;
  // stima iniziale di θ: primo istante in cui il salto si riduce di 1/e
  let theta = tau[n - 1] / 2 || 1;
  for (let i = 0; i < n; i++) {
    if (Math.abs(y[i] - Ta) <= Math.abs(A) / Math.E) { theta = Math.max(tau[i], 1e-6); break; }
  }
  const free = fixedTa == null ? [0, 1, 2] : [1, 2];
  let p = [Ta, A, theta];
  const model = (q, x) => q[0] + q[1] * Math.exp(-x / q[2]);
  const sse = (q) => { let s = 0; for (let i = 0; i < n; i++) s += (y[i] - model(q, tau[i])) ** 2; return s; };
  let lambda = 1e-3, cur = sse(p);
  for (let it = 0; it < 300; it++) {
    const m = free.length;
    const JtJ = Array.from({ length: m }, () => new Array(m).fill(0));
    const Jtr = new Array(m).fill(0);
    for (let i = 0; i < n; i++) {
      const e = Math.exp(-tau[i] / p[2]);
      const full = [1, e, (p[1] * e * tau[i]) / (p[2] * p[2])];
      const J = free.map((k) => full[k]);
      const r = y[i] - model(p, tau[i]);
      for (let a = 0; a < m; a++) {
        Jtr[a] += J[a] * r;
        for (let b = 0; b < m; b++) JtJ[a][b] += J[a] * J[b];
      }
    }
    const Aug = JtJ.map((row, i) => row.map((v, j) => (i === j ? v * (1 + lambda) : v)));
    const inv = invert(Aug);
    if (!inv) break;
    const delta = inv.map((row) => row.reduce((s, v, j) => s + v * Jtr[j], 0));
    const trial = [...p];
    free.forEach((k, a) => (trial[k] += delta[a]));
    if (trial[2] <= 0) { lambda *= 10; continue; }
    const s = sse(trial);
    if (s < cur) {
      const rel = (cur - s) / (cur || 1);
      p = trial; cur = s; lambda = Math.max(lambda / 10, 1e-12);
      if (rel < 1e-12) break;
    } else {
      lambda *= 10;
      if (lambda > 1e12) break;
    }
  }
  // incertezze dalla matrice di covarianza s²(JᵀJ)⁻¹
  const m = free.length;
  const JtJ = Array.from({ length: m }, () => new Array(m).fill(0));
  for (let i = 0; i < n; i++) {
    const e = Math.exp(-tau[i] / p[2]);
    const full = [1, e, (p[1] * e * tau[i]) / (p[2] * p[2])];
    const J = free.map((k) => full[k]);
    for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) JtJ[a][b] += J[a] * J[b];
  }
  const inv = invert(JtJ);
  const dof = n - m;
  const s2 = cur / dof;
  const sigma = [0, 0, 0];
  if (inv) free.forEach((k, a) => (sigma[k] = Math.sqrt(inv[a][a] * s2)));
  let mean = 0; for (const v of y) mean += v; mean /= n;
  let sst = 0; for (const v of y) sst += (v - mean) ** 2;
  return {
    Ta: p[0], A: p[1], theta: p[2],
    sTa: fixedTa == null ? sigma[0] : 0, sA: sigma[1], sTheta: sigma[2],
    r2: sst > 0 ? 1 - cur / sst : NaN, n, tRef,
    evaluate: (tt) => model(p, tt - tRef),
  };
}

// ---------- presentazione delle misure ----------

/** Arrotonda l'incertezza a 2 cifre significative e il valore alla stessa cifra. */
export function formatMeasure(value, err, unit = '', locale = 'it-IT') {
  if (!isFinite(value)) return '—';
  if (!isFinite(err) || err <= 0) {
    return `${fmt(value, 4, locale)}${unit ? ' ' + unit : ''}`;
  }
  const exp = Math.floor(Math.log10(err)) - 1; // 2 cifre significative
  const decimals = Math.max(0, -exp);
  const q = Math.pow(10, exp);
  const v = Math.round(value / q) * q;
  const e = Math.round(err / q) * q;
  const f = (x) => x.toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  return `(${f(v)} ± ${f(e)})${unit ? ' ' + unit : ''}`;
}

export function fmt(x, sig = 4, locale = 'it-IT') {
  if (!isFinite(x)) return '—';
  if (x === 0) return '0';
  const mag = Math.floor(Math.log10(Math.abs(x)));
  const decimals = Math.max(0, sig - 1 - mag);
  return x.toLocaleString(locale, { maximumFractionDigits: Math.min(decimals, 10), minimumFractionDigits: 0 });
}
