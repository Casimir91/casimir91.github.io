// Mosaicus — formule per le colonne calcolate, alla maniera di un foglio di calcolo.
// Analizzatore a discesa ricorsiva: niente eval(), solo ciò che è previsto qui.
//
//   Numeri:    3   0,5   1.5   2e-3        (la virgola vale come separatore decimale)
//   Operatori: + − * / ^   (anche · × ÷ e il segno meno tipografico −)
//   Funzioni:  ln log exp sqrt √ abs sin cos tan asin acos atan
//   Costanti:  pi π e g (9,81 m/s²)
//   Variabili: i nomi delle colonne del riquadro (t, x, v, a, T, …)
//
// compile("ln(T − 21)", ["t","T"]) → { fn(row) → numero, vars: ["T"] }  oppure lancia un Error in italiano.

const FUNCS = {
  ln: Math.log, log: Math.log10, exp: Math.exp, sqrt: Math.sqrt, '√': Math.sqrt, abs: Math.abs,
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
};
const CONSTS = { pi: Math.PI, 'π': Math.PI, e: Math.E, g: 9.81 };

function tokenize(src) {
  const s = src.replace(/[−–]/g, '-').replace(/[·×]/g, '*').replace(/÷/g, '/').replace(/²/g, '^2').replace(/³/g, '^3');
  const out = [];
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9.,]/.test(c)) {
      const m = s.slice(i).match(/^(\d+([.,]\d*)?|[.,]\d+)([eE][+-]?\d+)?/);
      if (!m) throw new Error(`numero non valido vicino a «${s.slice(i, i + 6)}»`);
      out.push({ t: 'num', v: parseFloat(m[0].replace(',', '.')) }); i += m[0].length; continue;
    }
    if (c === '√') { out.push({ t: 'id', v: '√' }); i++; continue; }
    if (/[A-Za-z_πθτ]/.test(c)) {
      const m = s.slice(i).match(/^[A-Za-z_πθτ][A-Za-z0-9_πθτ]*/);
      out.push({ t: 'id', v: m[0] }); i += m[0].length; continue;
    }
    if ('+-*/^()'.includes(c)) { out.push({ t: c }); i++; continue; }
    throw new Error(`simbolo non riconosciuto: «${c}»`);
  }
  return out;
}

export function compile(src, columns) {
  const toks = tokenize(src);
  let p = 0;
  const used = new Set();
  const peek = () => toks[p];
  const eat = (t) => { if (toks[p]?.t === t) return toks[p++]; throw new Error(t === ')' ? 'manca una parentesi chiusa «)»' : `atteso «${t}»`); };

  // espr := termine (('+'|'-') termine)*
  function expr() {
    let node = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) {
      const op = toks[p++].t, r = term(), l = node;
      node = op === '+' ? (x) => l(x) + r(x) : (x) => l(x) - r(x);
    }
    return node;
  }
  // termine := unario (('*'|'/') unario | unario implicito)*
  function term() {
    let node = unary();
    for (;;) {
      const t = peek();
      if (t && (t.t === '*' || t.t === '/')) {
        p++; const r = unary(), l = node;
        node = t.t === '*' ? (x) => l(x) * r(x) : (x) => l(x) / r(x);
      } else if (t && (t.t === 'num' || t.t === 'id' || t.t === '(')) {
        const r = unary(), l = node; node = (x) => l(x) * r(x); // moltiplicazione implicita: 2x, 2(t+1)
      } else break;
    }
    return node;
  }
  function unary() {
    if (peek()?.t === '-') { p++; const a = unary(); return (x) => -a(x); }
    if (peek()?.t === '+') { p++; return unary(); }
    return power();
  }
  // potenza := primario ('^' unario)?   (associativa a destra)
  function power() {
    const base = primary();
    if (peek()?.t === '^') { p++; const ex = unary(); return (x) => Math.pow(base(x), ex(x)); }
    return base;
  }
  function primary() {
    const t = toks[p++];
    if (!t) throw new Error('la formula è incompleta');
    if (t.t === 'num') return () => t.v;
    if (t.t === '(') { const e = expr(); eat(')'); return e; }
    if (t.t === 'id') {
      if (FUNCS[t.v] || FUNCS[t.v.toLowerCase()]) {
        const f = FUNCS[t.v] || FUNCS[t.v.toLowerCase()];
        if (peek()?.t !== '(') { const a = primary(); return (x) => f(a(x)); } // es. √x
        p++; const a = expr(); eat(')');
        return (x) => f(a(x));
      }
      if (columns.includes(t.v)) { used.add(t.v); return (row) => row[t.v]; }
      if (t.v in CONSTS) return () => CONSTS[t.v];
      throw new Error(`«${t.v}» non è una colonna né una funzione conosciuta (colonne: ${columns.join(', ')})`);
    }
    throw new Error(`«${t.t}» fuori posto`);
  }

  if (!toks.length) throw new Error('scrivi una formula');
  const fn = expr();
  if (p < toks.length) throw new Error(`c'è qualcosa in più alla fine: «${toks.slice(p).map((k) => k.v ?? k.t).join(' ')}»`);
  return { fn: (row) => { const v = fn(row); return isFinite(v) ? v : NaN; }, vars: [...used] };
}
