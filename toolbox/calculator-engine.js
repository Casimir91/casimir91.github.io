/* Calculator engine (no dependencies, works in the browser and in Node).
   - Reads the LaTeX produced by the MathLive math-field.
   - Exact arithmetic: rationals with BigInt, plus simple radicals (q·√m).
     Anything outside this closed set (π, √2+√3, 2^0.7 …) falls back to a decimal number.
   - Output: fraction / mixed number / decimal (with repeating period) / standard form. */

/* ---------- BigInt helpers ---------- */
const abs = (a) => (a < 0n ? -a : a);
const gcd = (a, b) => { a = abs(a); b = abs(b); while (b) { [a, b] = [b, a % b]; } return a; };

function isqrt(n) {                       // floor(√n), n ≥ 0n (Newton from above)
  if (n < 2n) return n;
  let x = 1n << BigInt(Math.ceil(n.toString(2).length / 2));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x) return x;
    x = y;
  }
}

function iroot(n, k) {                    // floor(n^(1/k)), n ≥ 0n, k ≥ 1 integer
  if (k === 1) return n;
  if (n < 2n) return n;
  let lo = 0n, hi = 1n;
  while (hi ** BigInt(k) <= n) hi <<= 1n;
  while (lo < hi - 1n) {
    const mid = (lo + hi) >> 1n;
    if (mid ** BigInt(k) <= n) lo = mid; else hi = mid;
  }
  return lo;
}

/* m = s²·r with r squarefree. Trial division up to a bound; beyond it r may keep a square factor. */
function squareFree(m) {
  let s = 1n, r = m;
  for (let p = 2n; p * p <= r && p < 100000n; p += p === 2n ? 1n : 2n) {
    const pp = p * p;
    while (r % pp === 0n) { r /= pp; s *= p; }
    if (r % p === 0n) { /* single factor of p stays in r */ }
  }
  const t = isqrt(r);
  if (t * t === r) { s *= t; r = 1n; }
  return { s, r };
}

/* ---------- values ----------
   exact:  { ex: true, n, d, m }   value = (n/d)·√m, d > 0, gcd(n,d) = 1, m squarefree ≥ 1
   approx: { ex: false, x }        a JavaScript number                                      */
const MAX_BITS = 40000;                   // refuse monstrous numbers instead of freezing the page
const bits = (a) => abs(a).toString(2).length;

class CalcError extends Error {
  constructor(code, msg) { super(msg); this.code = code; }
}

function exact(n, d = 1n, m = 1n) {
  if (d === 0n) throw new CalcError("div0", "Cannot divide by zero");
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d) || 1n;
  n /= g; d /= g;
  if (m !== 1n) {
    const { s, r } = squareFree(m);
    if (s !== 1n) {
      n *= s;
      const g2 = gcd(n, d) || 1n;
      n /= g2; d /= g2;
    }
    m = r;
  }
  if (n === 0n) m = 1n;
  if (bits(n) > MAX_BITS || bits(d) > MAX_BITS) throw new CalcError("big", "The number is too large");
  return { ex: true, n, d, m };
}
const approx = (x) => {
  if (Number.isNaN(x)) throw new CalcError("nan", "Not a real number");
  if (!Number.isFinite(x)) throw new CalcError("big", "The number is too large");
  return { ex: false, x };
};

function toNumber(v) {
  if (!v.ex) return v.x;
  const ratio = (a, b) => {
    const fa = Number(a), fb = Number(b);
    if (Number.isFinite(fa) && Number.isFinite(fb)) return fa / fb;
    const shift = BigInt(Math.max(bits(a), bits(b)) - 1000);          // scale both down
    return Number(a >> shift) / Number(b >> shift);
  };
  const q = ratio(v.n, v.d);
  return v.m === 1n ? q : q * Math.sqrt(Number(v.m));
}

const isRational = (v) => v.ex && v.m === 1n;
const isInteger = (v) => v.ex && v.m === 1n && v.d === 1n;
const isZero = (v) => (v.ex ? v.n === 0n : v.x === 0);

/* ---------- arithmetic ---------- */
function neg(a) { return a.ex ? exact(-a.n, a.d, a.m) : approx(-a.x); }

function add(a, b) {
  if (a.ex && b.ex) {
    if (a.n === 0n) return b;
    if (b.n === 0n) return a;
    if (a.m === b.m) return exact(a.n * b.d + b.n * a.d, a.d * b.d, a.m);
  }
  return approx(toNumber(a) + toNumber(b));
}
const sub = (a, b) => add(a, neg(b));

function mul(a, b) {
  if (a.ex && b.ex) return exact(a.n * b.n, a.d * b.d, a.m * b.m);
  return approx(toNumber(a) * toNumber(b));
}

function inv(a) {
  if (isZero(a)) throw new CalcError("div0", "Cannot divide by zero");
  // 1/(q√m) = √m / (q·m)
  if (a.ex) return exact(a.d, a.n * a.m, a.m);
  return approx(1 / a.x);
}
const div = (a, b) => mul(a, inv(b));

function powInt(a, k) {                   // k: JavaScript integer
  if (k === 0) return exact(1n);
  if (k < 0) return powInt(inv(a), -k);
  if (a.ex) {
    const K = BigInt(k);
    const estimated = (bits(a.n) + bits(a.d)) * k;
    if (estimated > MAX_BITS * 2) return approx(Math.pow(toNumber(a), k));
    const half = K / 2n;
    const n = a.n ** K, d = a.d ** K;
    // (q√m)^k = q^k · m^⌊k/2⌋ · (√m if k odd)
    const mm = a.m ** half;
    return K % 2n === 0n ? exact(n * mm, d, 1n) : exact(n * mm, d, a.m);
  }
  return approx(Math.pow(a.x, k));
}

function power(a, e) {
  if (isInteger(e)) {
    const k = Number(e.n);
    if (Math.abs(k) <= 5000) return powInt(a, k);
  }
  // rational exponent p/q on an exact rational base: try an exact root
  if (isRational(e) && isRational(a) && a.n >= 0n && e.d <= 12n && abs(e.n) <= 200n) {
    const k = Number(e.d);
    const rn = iroot(a.n, k), rd = iroot(a.d, k);
    if (rn ** BigInt(k) === a.n && rd ** BigInt(k) === a.d) {
      return powInt(exact(rn, rd), Number(e.n));
    }
    if (k === 2 && e.n === 1n) return sqrt(a);
  }
  const x = toNumber(a), y = toNumber(e);
  return approx(Math.pow(x, y));
}

function sqrt(a) {
  if (a.ex && a.m === 1n) {
    if (a.n < 0n) throw new CalcError("domain", "Square root of a negative number");
    // √(n/d) = √(n·d) / d, and n·d = s²·r  →  (s/d)·√r
    const { s, r } = squareFree(a.n * a.d);
    return exact(s, a.d, r);
  }
  const x = toNumber(a);
  if (x < 0) throw new CalcError("domain", "Square root of a negative number");
  return approx(Math.sqrt(x));
}

function nthRoot(a, k) {                  // k exact integer ≥ 1 (index of \sqrt[k]{a})
  if (!isInteger(k) || k.n < 1n) throw new CalcError("syntax", "Check the index of the root");
  const kk = Number(k.n);
  if (kk === 1) return a;
  if (kk === 2) return sqrt(a);
  const x = toNumber(a);
  if (x < 0 && kk % 2 === 0) throw new CalcError("domain", "Even root of a negative number");
  if (isRational(a)) {
    const sign = a.n < 0n ? -1n : 1n;
    const rn = iroot(abs(a.n), kk), rd = iroot(a.d, kk);
    if (rn ** BigInt(kk) === abs(a.n) && rd ** BigInt(kk) === a.d && (sign > 0n || kk % 2 === 1)) {
      return exact(sign * rn, rd);
    }
  }
  return approx(x < 0 ? -Math.pow(-x, 1 / kk) : Math.pow(x, 1 / kk));
}

/* ---------- functions: trigonometry, logarithms ---------- */
const E_CONST = () => approx(Math.E);

/* Float results that are an integer up to rounding noise become exact integers (ln e = 1, log 1000 = 3). */
function snap(x) {
  if (!Number.isFinite(x)) return approx(x);
  const r = Math.round(x);
  if (Math.abs(r) < 1e15 && Math.abs(x - r) <= 1e-14 * Math.max(1, Math.abs(x))) return exact(BigInt(r));
  return approx(x);
}

/* exact (n/d)·√m for the sine of 0°, 30°, 45°, 60°, 90° */
const SIN_REF = { 0: [0n, 1n, 1n], 30: [1n, 2n, 1n], 45: [1n, 2n, 2n], 60: [1n, 2n, 3n], 90: [1n, 1n, 1n] };
const TAN_REF = { 0: [0n, 1n, 1n], 30: [1n, 3n, 3n], 45: [1n, 1n, 1n], 60: [1n, 1n, 3n] };
const ref = (table, a) => exact(...table[a]);

function sinExact(a) {                    // a: integer degrees in [0, 360), multiple of 30 or 45
  if (a <= 90) return ref(SIN_REF, a);
  if (a <= 180) return ref(SIN_REF, 180 - a);
  if (a <= 270) return neg(ref(SIN_REF, a - 180));
  return neg(ref(SIN_REF, 360 - a));
}

/* Integer number of degrees (reduced to [0,360)) when the angle is a "special" one, else null. */
function specialDegrees(v, angle) {
  let deg;
  if (angle === "deg") {
    if (!(isRational(v) && v.d === 1n) || abs(v.n) > 100000000n) return null;
    deg = Number(v.n);
  } else {
    const x = toNumber(v);
    const d = (x * 180) / Math.PI;
    deg = Math.round(d);
    if (Math.abs(d - deg) > 1e-9 * Math.max(1, Math.abs(d)) || Math.abs(deg) > 1e8) return null;
  }
  const a = ((deg % 360) + 360) % 360;
  return a % 30 === 0 || a % 45 === 0 ? a : null;
}

function toRadians(v, angle) { return angle === "deg" ? (toNumber(v) * Math.PI) / 180 : toNumber(v); }
function fromRadians(x, angle) { return angle === "deg" ? (x * 180) / Math.PI : x; }

function trig(name, v, angle) {           // name: sin | cos | tan
  const a = specialDegrees(v, angle);
  if (a !== null) {
    const s = sinExact(a), c = sinExact((a + 90) % 360);
    if (name === "sin") return s;
    if (name === "cos") return c;
    if (isZero(c)) throw new CalcError("domain", "tan is not defined for this angle");
    return div(s, c);
  }
  const x = toRadians(v, angle);
  return snap(name === "sin" ? Math.sin(x) : name === "cos" ? Math.cos(x) : Math.tan(x));
}

const keyOf = (v) => (v.ex ? `${v.n}/${v.d}/${v.m}` : null);
const lookup = (table) => {
  const m = new Map();
  for (const a of Object.keys(table)) m.set(keyOf(exact(...table[a])), Number(a));
  return m;
};
const ASIN_TABLE = lookup(SIN_REF), ATAN_TABLE = lookup(TAN_REF);

function inverseTrig(name, v, angle) {    // name: sin | cos | tan  (arcsin, arccos, arctan)
  const out = (deg) => (angle === "deg" ? exact(BigInt(deg)) : approx((deg * Math.PI) / 180));
  if (v.ex) {
    const negative = v.n < 0n;
    const pos = negative ? neg(v) : v;
    if (name === "tan") {
      const d = ATAN_TABLE.get(keyOf(pos));
      if (d !== undefined) return out(negative ? -d : d);
    } else {
      const d = ASIN_TABLE.get(keyOf(pos));
      if (d !== undefined) return out(name === "sin" ? (negative ? -d : d) : 90 - (negative ? -d : d));
    }
  }
  const x = toNumber(v);
  if (name !== "tan" && Math.abs(x) > 1) throw new CalcError("domain", "Out of range: use a number from −1 to 1");
  const r = name === "sin" ? Math.asin(x) : name === "cos" ? Math.acos(x) : Math.atan(x);
  return snap(fromRadians(r, angle));
}

/* log_b(x) as an exact integer when x is a power of the integer base b (log 1000 = 3, log_2 (1/4) = −2). */
function exactLog(b, x) {
  if (!(isRational(b) && b.d === 1n && b.n >= 2n && isRational(x) && x.n > 0n)) return null;
  const power = (n) => { let k = 0, p = 1n; while (p < n && k < 4096) { p *= b.n; k++; } return p === n ? k : null; };
  if (x.d === 1n) { const k = power(x.n); return k === null ? null : exact(BigInt(k)); }
  if (x.n === 1n) { const k = power(x.d); return k === null ? null : exact(BigInt(-k)); }
  return null;
}

function logarithm(x, base) {             // base: value, or null for ln (natural)
  const xv = toNumber(x);
  if (!(xv > 0)) throw new CalcError("domain", "A logarithm needs a positive number");
  if (isRational(x) && x.n === x.d) return exact(0n);
  if (base) {
    const bv = toNumber(base);
    if (!(bv > 0) || bv === 1) throw new CalcError("domain", "The base must be positive and not 1");
    const e = exactLog(base, x);
    if (e) return e;
    return snap(bv === 10 ? Math.log10(xv) : Math.log(xv) / Math.log(bv));
  }
  return snap(Math.log(xv));
}

/* ---------- parser (recursive descent over the LaTeX string) ---------- */
function normalise(src) {
  let s = String(src);
  s = s.replace(/\\left|\\right/g, "")
       .replace(/\\[,;:! ]|~/g, "")
       .replace(/\\displaystyle|\\textstyle/g, "")
       .replace(/\\cdot|\\times|·|×|\*/g, "*")
       .replace(/\\div|÷/g, "/")
       .replace(/−|\\minus/g, "-")
       .replace(/π/g, "\\pi ")
       .replace(/(\d)\s*\{,\}\s*(\d)/g, "$1.$2")
       .replace(/(\d),(\d)/g, "$1.$2")
       .replace(/\\(?:mathrm|operatorname|text)\{\s*Ans\s*\}/g, "\\Ans ")
       .replace(/\\(?:mathrm|operatorname|text)\{\s*e\s*\}/g, "\\exponentialE ")
       .replace(/\\placeholder(?:\[[^\]]*\])?\{[^}]*\}/g, "\\EMPTY ")
       .replace(/\s+/g, " ")
       .trim();
  return s;
}

const FUNCTIONS = {
  sin: { kind: "trig", name: "sin" }, cos: { kind: "trig", name: "cos" }, tan: { kind: "trig", name: "tan" },
  arcsin: { kind: "trig", name: "sin", inverse: true }, arccos: { kind: "trig", name: "cos", inverse: true }, arctan: { kind: "trig", name: "tan", inverse: true },
  ln: { kind: "ln" }, log: { kind: "log" },
};
const power_ = (a, e) => power(a, e);

function parse(src, ctx = {}) {
  const s = normalise(src);
  let i = 0;
  const ws = () => { while (s[i] === " ") i++; };
  const peek = () => { ws(); return s[i]; };
  const fail = (code = "syntax", msg = "Check the expression") => { throw new CalcError(code, msg); };
  const eof = () => { ws(); return i >= s.length; };
  const cmdAt = () => { const m = /^\\([A-Za-z]+)/.exec(s.slice(i)); return m ? m[1] : null; };

  function parseExpr() {
    let v = parseTerm();
    for (;;) {
      const c = peek();
      if (c === "+") { i++; v = add(v, parseTerm()); }
      else if (c === "-") { i++; v = sub(v, parseTerm()); }
      else return v;
    }
  }

  const startsPrimary = () => {
    const c = peek();
    if (c === undefined) return false;
    if (/[0-9.(]/.test(c)) return true;
    if (c === "e") return true;
    if (c === "\\") { const k = cmdAt(); return ["frac", "sqrt", "pi", "Ans", "EMPTY", "exponentialE", ...Object.keys(FUNCTIONS)].includes(k); }
    return false;
  };

  function parseTerm() {
    let v = parseUnary();
    for (;;) {
      const c = peek();
      if (c === "*") { i++; v = mul(v, parseUnary()); }
      else if (c === "/") { i++; v = div(v, parseUnary()); }
      else if (startsPrimary()) { v = mul(v, parsePower()); }   // implicit multiplication: 2π, 3(4+1), 2\sqrt{3}
      else return v;
    }
  }

  function parseUnary() {
    const c = peek();
    if (c === "-") { i++; return neg(parseUnary()); }
    if (c === "+") { i++; return parseUnary(); }
    return parsePower();
  }

  function parsePower() {
    const base = parsePrimary();
    if (peek() === "^") {
      i++;
      const e = parseArg(true);
      return power(base, e);
    }
    return base;
  }

  // argument of ^, \frac, \sqrt: {expr} or a single digit / command
  function parseArg(isExponent = false) {
    const c = peek();
    if (c === "{") {
      i++;
      const v = parseExpr();
      if (peek() !== "}") fail();
      i++;
      return v;
    }
    if (c === undefined) fail("incomplete", "Complete the expression");
    if (/[0-9]/.test(c)) { i++; return exact(BigInt(c)); }
    if (c === "-" && isExponent) { i++; return neg(parseArg(true)); }
    if (c === "\\") return parsePrimary();
    return fail();
  }

  function parsePrimary() {
    const c = peek();
    if (c === undefined) fail("incomplete", "Complete the expression");
    if (/[0-9.]/.test(c)) return parseNumber();
    if (c === "(") {
      i++;
      const v = parseExpr();
      if (peek() !== ")") fail("syntax", "Missing closing bracket");
      i++;
      return v;
    }
    if (c === "{") return parseArg();
    if (c === "e") { i++; return E_CONST(); }
    if (/[A-Za-z]/.test(c)) fail("syntax", "Unknown symbol " + c);
    if (c === "\\") {
      const k = cmdAt();
      i += k.length + 1;
      switch (k) {
        case "frac": { const a = parseArg(); const b = parseArg(); return div(a, b); }
        case "sqrt": {
          let idx = null;
          if (peek() === "[") {
            i++;
            idx = parseExpr();
            if (peek() !== "]") fail();
            i++;
          }
          const a = parseArg();
          return idx ? nthRoot(a, idx) : sqrt(a);
        }
        case "pi": return approx(Math.PI);
        case "exponentialE": return E_CONST();
        case "Ans":
          if (!ctx.ans) fail("noans", "There is no previous answer yet");
          return ctx.ans;
        case "EMPTY": return fail("incomplete", "Complete the expression");
        default:
          if (FUNCTIONS[k]) return parseFunction(k);
          return fail("syntax", "Unknown symbol \\" + k);
      }
    }
    return fail();
  }

  // argument of a function: (expr) or a single factor; \\sin 30 and \\sin(30) both work
  function parseFnArg() {
    const c = peek();
    if (c === "-") { i++; return neg(parseFnArg()); }
    if (c === "+") { i++; return parseFnArg(); }
    if (c === undefined) fail("incomplete", "Complete the expression");
    return parsePower();
  }

  function parseFunction(k) {
    const fn = FUNCTIONS[k];
    let base = null, power = null;
    if (fn.kind === "log" && peek() === "_") { i++; base = parseArg(); }
    if (peek() === "^") { i++; power = parseArg(true); }
    const arg = parseFnArg();
    const angle = ctx.angle === "rad" ? "rad" : "deg";
    let result;
    if (fn.kind === "trig") {
      const minusOne = power && isInteger(power) && power.n === -1n;
      result = fn.inverse || minusOne ? inverseTrig(fn.name, arg, angle) : trig(fn.name, arg, angle);
      if (power && !minusOne && !fn.inverse) result = power_(result, power);   // sin²x
      return result;
    }
    if (fn.kind === "ln") result = logarithm(arg, null);
    else result = logarithm(arg, base || exact(10n));
    if (power) result = power_(result, power);
    return result;
  }

  function parseNumber() {
    const m = /^(\d*)(?:\.(\d*))?/.exec(s.slice(i));
    const ip = m[1] || "", fp = m[2] || "";
    if (!ip && !fp) fail();
    i += m[0].length;
    const digits = BigInt((ip + fp) || "0");
    return exact(digits, 10n ** BigInt(fp.length));
  }

  if (!s) fail("empty", "Type a calculation");
  const v = parseExpr();
  if (!eof()) fail();
  return v;
}

/* ---------- formatting ---------- */
const MAX_PERIOD_DIGITS = 40;

/* Decimal expansion of an exact rational n/d (d > 0): integer part, non-repeating part, repeating part. */
function expand(n, d) {
  const sign = n < 0n ? "-" : "";
  n = abs(n);
  const ip = (n / d).toString();
  let r = n % d;
  const seen = new Map();
  let digits = "";
  while (r !== 0n && !seen.has(r) && digits.length < 200) {
    seen.set(r, digits.length);
    r *= 10n;
    digits += (r / d).toString();
    r %= d;
  }
  if (r === 0n) return { sign, ip, pre: digits, rep: "", terminates: true };
  if (seen.has(r)) {
    const at = seen.get(r);
    return { sign, ip, pre: digits.slice(0, at), rep: digits.slice(at), terminates: false };
  }
  return { sign, ip, pre: digits, rep: "", terminates: false, tooLong: true };
}

function sepLatex(dec) { return dec === "," ? "{,}" : "."; }

function trimNumberString(str) {          // "1.2300" → "1.23"
  return str.includes(".") ? str.replace(/0+$/, "").replace(/\.$/, "") : str;
}

function floatToDecimalString(x, sig = 12) {
  if (x === 0) return "0";
  let str = Number(x.toPrecision(sig)).toString();
  if (/e/i.test(str)) {                   // expand exponent notation for the plain decimal form
    const [mant, exp] = str.split(/e/i);
    const e = parseInt(exp, 10);
    const neg_ = mant.startsWith("-");
    const digs = mant.replace("-", "").replace(".", "");
    const pointPos = (mant.replace("-", "").indexOf(".") === -1 ? mant.replace("-", "").length : mant.replace("-", "").indexOf(".")) + e;
    let out;
    if (pointPos <= 0) out = "0." + "0".repeat(-pointPos) + digs;
    else if (pointPos >= digs.length) out = digs + "0".repeat(pointPos - digs.length);
    else out = digs.slice(0, pointPos) + "." + digs.slice(pointPos);
    str = (neg_ ? "-" : "") + out;
  }
  return trimNumberString(str);
}

function withSeparator(str, dec) {
  return str.replace(".", sepLatex(dec));
}

/* Standard form a × 10^n with `sig` significant digits. Returns { mant: "1.5", exp: -3, approx } */
function standardForm(v, sig = 10) {
  if (isZero(v)) return { mant: "0", exp: 0, approx: false };
  if (v.ex && v.m === 1n) {
    const neg_ = v.n < 0n;
    const n = abs(v.n), d = v.d;
    let e = n.toString().length - d.toString().length;       // first guess
    // make sure 10^e ≤ n/d < 10^(e+1)
    const ge = (ex) => (ex >= 0 ? n >= d * 10n ** BigInt(ex) : n * 10n ** BigInt(-ex) >= d);
    while (!ge(e)) e--;
    while (ge(e + 1)) e++;
    const shift = sig - 1 - e;
    const num = shift >= 0 ? n * 10n ** BigInt(shift) : n;
    const den = shift >= 0 ? d : d * 10n ** BigInt(-shift);
    let q = num / den;
    const rem = num % den;
    let inexact = rem !== 0n;
    if (rem * 2n >= den) q += 1n;
    if (q.toString().length > sig) { q /= 10n; e += 1; }
    let digits = q.toString();
    digits = digits.replace(/0+$/, "") || "0";
    const mant = digits.length > 1 ? digits[0] + "." + digits.slice(1) : digits;
    return { mant: (neg_ ? "-" : "") + mant, exp: e, approx: inexact };
  }
  const x = toNumber(v);
  const [m, ex] = x.toExponential(sig - 1).split("e");
  return { mant: trimNumberString(m), exp: parseInt(ex, 10), approx: true };
}

function fracLatex(n, d, sign) {
  const body = d === 1n ? n.toString() : `\\frac{${n}}{${d}}`;
  return (sign ? "-" : "") + body;
}

/* Build every representation of a value. `dec` is the decimal separator ("." or ","). */
function describe(v, { dec = "." } = {}) {
  const out = { kind: null, exact: null, mixed: null, decimal: null, sci: null, plain: "" };

  // --- exact form ---
  if (v.ex) {
    const negative = v.n < 0n;
    const n = abs(v.n);
    if (v.m === 1n) {
      out.kind = v.d === 1n ? "integer" : "fraction";
      out.exact = fracLatex(n, v.d, negative);
      if (v.d !== 1n && n > v.d) {
        const whole = n / v.d, rest = n % v.d;
        out.mixed = `${negative ? "-" : ""}${whole}\\,\\frac{${rest}}{${v.d}}`;
      }
    } else {
      out.kind = "surd";
      const root = n === 1n ? `\\sqrt{${v.m}}` : `${n}\\sqrt{${v.m}}`;
      out.exact = (negative ? "-" : "") + (v.d === 1n ? root : `\\frac{${root}}{${v.d}}`);
    }
  } else {
    out.kind = "approx";
  }

  // --- decimal form ---
  if (v.ex && v.m === 1n) {
    const e = expand(v.n, v.d);
    const sep = sepLatex(dec);
    if (e.terminates) {
      out.decimal = { latex: e.sign + e.ip + (e.pre ? sep + e.pre : ""), approx: false };
    } else if (!e.tooLong && e.rep.length <= MAX_PERIOD_DIGITS) {
      out.decimal = { latex: e.sign + e.ip + sep + e.pre + `\\overline{${e.rep}}`, approx: false, periodic: true };
    } else {
      out.decimal = { latex: withSeparator(floatToDecimalString(toNumber(v), 12), dec), approx: true };
    }
  } else {
    const x = toNumber(v);
    out.decimal = { latex: withSeparator(floatToDecimalString(x, 12), dec), approx: true };
  }

  // --- standard form ---
  const sf = standardForm(v, 10);
  const mant = withSeparator(sf.mant, dec);
  out.sci = { latex: sf.exp === 0 ? mant : `${mant}\\times10^{${sf.exp}}`, approx: sf.approx };
  out.sciParts = sf;

  // --- plain text (for copy / accessibility) ---
  out.plain = v.ex && v.m === 1n
    ? (v.d === 1n ? v.n.toString() : `${v.n}/${v.d}`)
    : floatToDecimalString(toNumber(v), 12);
  out.number = toNumber(v);
  return out;
}

function evaluate(latex, ctx = {}) {
  const value = parse(latex, ctx);
  return value;
}

export { parse, evaluate, describe, standardForm, expand, CalcError, exact, approx, isRational, isInteger, toNumber };
