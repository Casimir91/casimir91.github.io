/* Graphing engine (no dependencies; browser and Node).
   - parseExpr(latex): LaTeX from MathLive → syntax tree, with x and parameters a b c d k m.
   - compile(tree): fast float function (x, params) → y.
   - zeros / extrema / intersections: numeric analysis over an interval.
   - niceNumber / niceStep: pretty labels (1/2, π/2, 3.1416) and grid steps.                      */

export class GraphError extends Error {}
export const PARAM_NAMES = ["a", "b", "c", "d", "k", "m"];

/* ---------------- parser ---------------- */
function normalise(src) {
  return String(src)
    .replace(/\\left\s*\|/g, "|").replace(/\\right\s*\|/g, "|").replace(/\\lvert|\\rvert/g, "|")
    .replace(/\\left|\\right/g, "")
    .replace(/\\[,;:! ]|~/g, "")
    .replace(/\\displaystyle|\\textstyle/g, "")
    .replace(/\\cdot|\\times|·|×|\*/g, "*")
    .replace(/\\div|÷/g, "/")
    .replace(/−|\\minus/g, "-")
    .replace(/π/g, "\\pi ")
    .replace(/(\d)\s*\{,\}\s*(\d)/g, "$1.$2")
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/\\(?:mathrm|operatorname|text)\{\s*e\s*\}/g, "\\exponentialE ")
    .replace(/\\placeholder(?:\[[^\]]*\])?\{[^}]*\}/g, "\\EMPTY ")
    .replace(/\s+/g, " ")
    .trim();
}

const FUNCS = ["sin", "cos", "tan", "arcsin", "arccos", "arctan", "ln", "log", "exp"];
const CMDS_PRIMARY = ["frac", "sqrt", "pi", "exponentialE", "EMPTY", ...FUNCS];

export function parseExpr(src) {
  const s = normalise(src);
  let i = 0, absDepth = 0;
  const params = new Set();
  const fail = (msg = "Check the expression") => { throw new GraphError(msg); };
  const ws = () => { while (s[i] === " ") i++; };
  const peek = () => { ws(); return s[i]; };
  const cmdAt = () => { const m = /^\\([A-Za-z]+)/.exec(s.slice(i)); return m ? m[1] : null; };

  const startsPrimary = () => {
    const c = peek();
    if (c === undefined) return false;
    if (/[0-9.(]/.test(c)) return true;
    if (c === "|") return absDepth === 0;
    if (c === "x" || c === "e" || PARAM_NAMES.includes(c)) return true;
    if (c === "\\") return CMDS_PRIMARY.includes(cmdAt());
    return false;
  };

  function expr() {
    let v = term();
    for (;;) {
      const c = peek();
      if (c === "+") { i++; v = ["add", v, term()]; }
      else if (c === "-") { i++; v = ["sub", v, term()]; }
      else return v;
    }
  }
  function term() {
    let v = unary();
    for (;;) {
      const c = peek();
      if (c === "*") { i++; v = ["mul", v, unary()]; }
      else if (c === "/") { i++; v = ["div", v, unary()]; }
      else if (startsPrimary()) v = ["mul", v, power()];
      else return v;
    }
  }
  function unary() {
    const c = peek();
    if (c === "-") { i++; return ["neg", unary()]; }
    if (c === "+") { i++; return unary(); }
    return power();
  }
  function power() {
    const base = primary();
    if (peek() === "^") { i++; return ["pow", base, arg(true)]; }
    return base;
  }
  function arg(isExp = false) {
    const c = peek();
    if (c === "{") {
      i++; const v = expr();
      if (peek() !== "}") fail();
      i++; return v;
    }
    if (c === undefined) fail("Complete the expression");
    if (/[0-9]/.test(c)) { i++; return ["num", Number(c)]; }
    if (c === "-" && isExp) { i++; return ["neg", arg(true)]; }
    if (c === "x" || c === "e" || PARAM_NAMES.includes(c) || c === "\\") return primary();
    return fail();
  }
  function fnArg() {
    const c = peek();
    if (c === "-") { i++; return ["neg", fnArg()]; }
    if (c === undefined) fail("Complete the expression");
    if (c === "(") return primary();             // sin(x)² means (sin x)², not sin(x²)
    return power();
  }

  function primary() {
    const c = peek();
    if (c === undefined) fail("Complete the expression");
    if (/[0-9.]/.test(c)) {
      const m = /^\d*(?:\.\d*)?/.exec(s.slice(i));
      if (!m[0] || m[0] === ".") fail();
      i += m[0].length;
      return ["num", parseFloat(m[0])];
    }
    if (c === "(") {
      i++; const v = expr();
      if (peek() !== ")") fail("Missing closing bracket");
      i++; return v;
    }
    if (c === "|") {
      i++; absDepth++;
      const v = expr();
      if (peek() !== "|") fail("Missing closing bar |");
      i++; absDepth--;
      return ["abs", v];
    }
    if (c === "{") return arg();
    if (s.startsWith("abs", i) && /^abs\s*(\(|\\left\()/.test(s.slice(i))) {       // abs(x) typed in plain letters
      i += 3; const v = primary(); return ["abs", v];
    }
    if (c === "x") { i++; return ["x"]; }
    if (c === "e") { i++; return ["num", Math.E]; }
    if (PARAM_NAMES.includes(c)) { i++; params.add(c); return ["p", c]; }
    if (/[A-Za-z]/.test(c)) fail("Unknown symbol " + c);
    if (c === "\\") {
      const k = cmdAt();
      i += k.length + 1;
      switch (k) {
        case "frac": { const a = arg(); const b = arg(); return ["div", a, b]; }
        case "sqrt": {
          let idx = null;
          if (peek() === "[") { i++; idx = expr(); if (peek() !== "]") fail(); i++; }
          const a = arg();
          return idx ? ["root", idx, a] : ["fn", "sqrt", a];
        }
        case "pi": return ["num", Math.PI];
        case "exponentialE": return ["num", Math.E];
        case "EMPTY": return fail("Complete the expression");
        default:
          if (FUNCS.includes(k)) {
            let base = null, pw = null;
            if (k === "log" && peek() === "_") { i++; base = arg(); }
            if (peek() === "^") { i++; pw = arg(true); }
            const a = fnArg();
            let node;
            if (k === "log") node = base ? ["div", ["fn", "ln", a], ["fn", "ln", base]] : ["fn", "log10", a];
            else if (["sin", "cos", "tan"].includes(k) && pw && pw[0] === "neg" && pw[1][0] === "num" && pw[1][1] === 1) { node = ["fn", "arc" + k, a]; pw = null; }
            else node = ["fn", k, a];
            return pw ? ["pow", node, pw] : node;
          }
          return fail("Unknown symbol \\" + k);
      }
    }
    return fail();
  }

  if (!s) fail("Type a function of x");
  const ast = expr();
  ws();
  if (i < s.length) fail();
  return { ast, params };
}

/* ---------------- compile to a float function ---------------- */
function ratio(e) {                        // small fraction p/q close to e, or null
  for (let q = 1; q <= 15; q++) { const p = Math.round(e * q); if (Math.abs(e - p / q) < 1e-9) return [p, q]; }
  return null;
}
function powReal(b, e) {
  if (b >= 0 || Number.isInteger(e)) return Math.pow(b, e);
  const r = ratio(e);
  if (r && r[1] % 2 === 1) return (Math.abs(r[0]) % 2 === 0 ? 1 : -1) * Math.pow(-b, e);   // real odd roots: x^(1/3)
  return NaN;
}

export function compile(ast, { deg = false } = {}) {
  const D = deg ? Math.PI / 180 : 1;
  const c = (n) => {
    switch (n[0]) {
      case "num": { const v = n[1]; return () => v; }
      case "x": return (x) => x;
      case "p": { const k = n[1]; return (x, P) => P[k]; }
      case "neg": { const a = c(n[1]); return (x, P) => -a(x, P); }
      case "add": { const a = c(n[1]), b = c(n[2]); return (x, P) => a(x, P) + b(x, P); }
      case "sub": { const a = c(n[1]), b = c(n[2]); return (x, P) => a(x, P) - b(x, P); }
      case "mul": { const a = c(n[1]), b = c(n[2]); return (x, P) => a(x, P) * b(x, P); }
      case "div": { const a = c(n[1]), b = c(n[2]); return (x, P) => a(x, P) / b(x, P); }
      case "pow": { const a = c(n[1]), b = c(n[2]); return (x, P) => powReal(a(x, P), b(x, P)); }
      case "abs": { const a = c(n[1]); return (x, P) => Math.abs(a(x, P)); }
      case "root": { const k = c(n[1]), a = c(n[2]); return (x, P) => powReal(a(x, P), 1 / k(x, P)); }
      case "fn": {
        const a = c(n[2]);
        switch (n[1]) {
          case "sin": return (x, P) => Math.sin(a(x, P) * D);
          case "cos": return (x, P) => Math.cos(a(x, P) * D);
          case "tan": return (x, P) => Math.tan(a(x, P) * D);
          case "arcsin": return (x, P) => Math.asin(a(x, P)) / D;
          case "arccos": return (x, P) => Math.acos(a(x, P)) / D;
          case "arctan": return (x, P) => Math.atan(a(x, P)) / D;
          case "ln": return (x, P) => Math.log(a(x, P));
          case "log10": return (x, P) => Math.log10(a(x, P));
          case "exp": return (x, P) => Math.exp(a(x, P));
          case "sqrt": return (x, P) => Math.sqrt(a(x, P));
        }
      }
    }
    throw new GraphError("Unsupported expression");
  };
  const f = c(ast);
  return (x, P = {}) => f(x, P);
}

/* ---------------- numeric analysis ---------------- */
const finite = Number.isFinite;

function sample(f, x0, x1, n) {
  const xs = new Float64Array(n + 1), ys = new Float64Array(n + 1);
  for (let i = 0; i <= n; i++) { const x = x0 + ((x1 - x0) * i) / n; xs[i] = x; const y = f(x); ys[i] = finite(y) ? y : NaN; }
  return { xs, ys };
}

function bisect(f, a, b, fa) {
  let lo = a, hi = b, flo = fa;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2, fm = f(mid);
    if (!finite(fm)) return null;
    if (fm === 0) return mid;
    if ((fm < 0) === (flo < 0)) { lo = mid; flo = fm; } else hi = mid;
  }
  return (lo + hi) / 2;
}

/* roots of f in [x0, x1]; poles (tan, 1/x) are rejected */
export function zeros(f, x0, x1, n = 600) {
  const { xs, ys } = sample(f, x0, x1, n);
  const out = [];
  for (let i = 0; i <= n; i++) {
    const y0 = ys[i];
    if (y0 === 0) { out.push(xs[i]); continue; }
    if (i === n) break;
    const y1 = ys[i + 1];
    if (!finite(y0) || !finite(y1) || y1 === 0 || y0 * y1 > 0) continue;
    const r = bisect(f, xs[i], xs[i + 1], y0);
    if (r === null) continue;
    const fr = Math.abs(f(r));
    if (finite(fr) && fr <= 1e-6 * (Math.abs(y0) + Math.abs(y1)) + 1e-9) out.push(r);
  }
  const tol = ((x1 - x0) / n) * 0.75, res = [];
  for (const r of out) if (!res.length || r - res[res.length - 1] > tol) res.push(Math.abs(r) < 1e-12 ? 0 : r);
  return res;
}

/* local maxima and minima of f in [x0, x1]; `ySpan` = height of the visible window (to reject poles) */
export function extrema(f, x0, x1, ySpan = Infinity, n = 600) {
  const { xs, ys } = sample(f, x0, x1, n);
  const out = [];
  for (let i = 1; i < n; i++) {
    const a = ys[i - 1], b = ys[i], c = ys[i + 1];
    if (!finite(a) || !finite(b) || !finite(c)) continue;
    const d1 = b - a, d2 = c - b;
    if (!(d1 * d2 < 0)) continue;
    if (Math.abs(d1) > 3 * ySpan || Math.abs(d2) > 3 * ySpan) continue;      // jump across an asymptote
    const isMax = d1 > 0;
    const s = isMax ? 1 : -1;
    let lo = xs[i - 1], hi = xs[i + 1];
    const g = (x) => s * f(x);
    const phi = (Math.sqrt(5) - 1) / 2;
    let p = hi - phi * (hi - lo), q = lo + phi * (hi - lo), gp = g(p), gq = g(q);
    for (let k = 0; k < 60; k++) {
      if (gp > gq) { hi = q; q = p; gq = gp; p = hi - phi * (hi - lo); gp = g(p); }
      else { lo = p; p = q; gp = gq; q = lo + phi * (hi - lo); gq = g(q); }
    }
    const x = (lo + hi) / 2, y = f(x);
    if (!finite(y)) continue;
    out.push({ x, y, kind: isMax ? "max" : "min" });
  }
  return out;
}

export function intersections(f, g, x0, x1, n = 500) {
  return zeros((x) => f(x) - g(x), x0, x1, n).map((x) => ({ x, y: f(x) }));
}

/* ---------------- labels and grid ---------------- */
export function niceStep(range, target = 8) {
  const raw = range / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}

const gcd = (a, b) => (b ? gcd(b, a % b) : Math.abs(a));
function trimDec(x, digits) {
  let s = Number(x.toFixed(digits)).toString();
  if (/e/.test(s)) s = x.toPrecision(4);
  return s.replace("-", "−");
}

/* 1/2, −3/4, π/2, 3π/4 when the number is that simple; otherwise a short decimal */
export function niceNumber(x, digits = 4) {
  if (!finite(x)) return String(x);
  if (Math.abs(x) < 1e-10) return "0";
  const r = Math.round(x);
  if (Math.abs(x - r) < 2e-7 * Math.max(1, Math.abs(x))) return String(r).replace("-", "−");
  for (let q = 2; q <= 12; q++) {
    const p = Math.round(x * q);
    if (p !== 0 && Math.abs(x - p / q) < 2e-7 * Math.max(1, Math.abs(x)) && gcd(p, q) === 1) return `${p < 0 ? "−" : ""}${Math.abs(p)}/${q}`;
  }
  const y = x / Math.PI;
  for (let q = 1; q <= 12; q++) {
    const p = Math.round(y * q);
    if (p !== 0 && Math.abs(y - p / q) < 2e-7 && gcd(p, q) === 1) {
      const num = Math.abs(p) === 1 ? "π" : `${Math.abs(p)}π`;
      return `${p < 0 ? "−" : ""}${num}${q === 1 ? "" : "/" + q}`;
    }
  }
  return trimDec(x, digits);
}

export function fmtValue(y, digits = 6) {  // table cells and trace labels
  if (!finite(y)) return "—";
  if (Math.abs(y) < 1e-12) return "0";
  const s = Number(y.toPrecision(digits)).toString();
  return (/e/.test(s) ? y.toExponential(Math.max(1, digits - 3)) : s).replace("-", "−");
}

/* ---------------- asymptotes ---------------- */
/* |f| must grow without bound when approaching x0 from `side` (±1): ln, 1/x, tan, 1/√x yes; √x, smooth peaks no. */
function blowsUp(f, x0, side) {
  const a = [1e-2, 1e-4, 1e-6, 1e-8].map((h) => Math.abs(f(x0 + side * h)));
  if (!a.every(finite)) return false;
  return a[1] > 1.25 * a[0] && a[2] > 1.25 * a[1] && a[3] > 1.2 * a[2] && a[3] > 2.5 * a[0] && a[3] > 8;
}

/* vertical asymptotes in [x0, x1]: x-values where f blows up (poles) or at the edge of the domain (ln, 1/√x) */
export function verticalAsymptotes(f, x0, x1, ySpan = Infinity, n = 800) {
  const { xs, ys } = sample(f, x0, x1, n);
  const found = [];
  const test = (x, sides) => { if (sides.length && sides.every((s) => blowsUp(f, x, s))) found.push(x); };
  for (let i = 0; i < n; i++) {
    const a = ys[i], b = ys[i + 1];
    if (finite(a) && finite(b)) {
      if (a * b < 0) {                                           // sign change: zero or odd pole
        let lo = xs[i], hi = xs[i + 1], flo = a;
        for (let k = 0; k < 60; k++) {
          const m = (lo + hi) / 2, fm = f(m);
          if (!finite(fm)) break;
          if ((fm < 0) === (flo < 0)) { lo = m; flo = fm; } else hi = m;
        }
        test((lo + hi) / 2, [-1, 1]);
      }
    } else if (finite(a) !== finite(b)) {                        // domain edge (or a pole sitting exactly on the grid)
      let lo = finite(a) ? xs[i] : xs[i + 1], hi = finite(a) ? xs[i + 1] : xs[i];
      for (let k = 0; k < 60; k++) { const m = (lo + hi) / 2; if (finite(f(m))) lo = m; else hi = m; }
      test((lo + hi) / 2, [Math.sign(finite(a) ? xs[i] - xs[i + 1] : xs[i + 1] - xs[i])]);
    }
  }
  for (let i = 1; i < n; i++) {                                  // even poles (1/x²): a tall isolated peak of |f|
    const a = ys[i - 1], b = ys[i], c = ys[i + 1];
    if (!finite(a) || !finite(b) || !finite(c) || a * b <= 0 || b * c <= 0) continue;
    const m = Math.abs(b);
    if (m < Math.abs(a) || m < Math.abs(c) || m < ySpan || m < 1.5 * Math.max(Math.abs(a), Math.abs(c))) continue;
    let lo = xs[i - 1], hi = xs[i + 1];
    const phi = (Math.sqrt(5) - 1) / 2;
    let p = hi - phi * (hi - lo), q = lo + phi * (hi - lo), gp = Math.abs(f(p)), gq = Math.abs(f(q));
    for (let k = 0; k < 70; k++) {
      if (!(gp <= Infinity) || !finite(gp)) { hi = q; } else if (gp > gq) { hi = q; } else { lo = p; }
      p = hi - phi * (hi - lo); q = lo + phi * (hi - lo); gp = Math.abs(f(p)); gq = Math.abs(f(q));
    }
    test((lo + hi) / 2, [-1, 1]);
  }
  found.sort((u, v) => u - v);
  const tol = (x1 - x0) * 1e-6 + 1e-9, out = [];
  for (const x of found) if (!out.length || x - out[out.length - 1] > tol) out.push(x);
  return out;
}

/* horizontal asymptotes: finite limits of f at +∞ and −∞ */
export function horizontalAsymptotes(f) {
  const lim = (sgn) => {
    const v = [1e3, 1e5, 1e7, 1e9].map((x) => f(sgn * x));
    if (!v.every(finite)) return null;
    const L = v[3], d1 = Math.abs(v[1] - L), d2 = Math.abs(v[2] - L), d0 = Math.abs(v[0] - L);
    if (d2 <= 1e-3 * (1 + Math.abs(L)) && d2 <= d1 && d1 <= d0 + 1e-12 && Math.abs(L) < 1e8) return L;
    return null;
  };
  const out = [];
  for (const L of [lim(1), lim(-1)]) if (L !== null && !out.some((u) => Math.abs(u - L) < 1e-6 * (1 + Math.abs(L)))) out.push(L);
  return out;
}
