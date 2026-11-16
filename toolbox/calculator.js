/* Calculator page: math-field (MathLive) + our own keypad + exact engine. */
import { MathfieldElement, convertLatexToMarkup } from "./vendor/mathlive/mathlive.min.mjs";
import { evaluate, describe, CalcError } from "./calculator-engine.js";

MathfieldElement.fontsDirectory = "vendor/mathlive/fonts";
MathfieldElement.soundsDirectory = null;

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

/* ---------- state ---------- */
const state = {
  dec: store.get("calc-dec", "."),           // decimal separator shown in results
  pref: store.get("calc-pref", "exact"),      // exact | mixed | decimal | sci
  angle: store.get("calc-angle", "deg"),      // deg | rad (for sin, cos, tan and their inverses)
  second: false,                              // "2nd" layer armed
  ans: null,                                  // last committed value
  committed: null,                            // value currently shown after "="
  live: null,                                 // value of the expression being typed
  history: [],                                // [{ latex, value }]
};
if (!["exact", "mixed", "decimal", "sci"].includes(state.pref)) state.pref = "exact";
if (state.dec !== "," && state.dec !== ".") state.dec = ".";
if (state.angle !== "rad") state.angle = "deg";

/* ---------- math field ---------- */
const mf = new MathfieldElement();
const coarse = window.matchMedia && window.matchMedia("(pointer: coarse)").matches;
mf.addEventListener("mount", () => {
  mf.mathVirtualKeyboardPolicy = "manual";
  mf.smartFence = true;
  mf.smartMode = false;
  mf.smartSuperscript = true;
  // typing "log(" on a physical keyboard should give log, not log with an empty subscript
  mf.inlineShortcuts = { ...mf.inlineShortcuts, log: "\\log", lg: "\\log" };
  mf.setAttribute("aria-label", "Calculation");
  refresh();
  if (!coarse) mf.focus({ preventScroll: true });
}, { once: true });
mf.setAttribute("placeholder", "\\text{Type a calculation}");
$("entry").appendChild(mf);

const focusField = () => { if (!coarse) mf.focus({ preventScroll: true }); };
const isEmpty = () => mf.getValue("latex").trim() === "";

/* ---------- rendering helpers ---------- */
const markup = (latex) => convertLatexToMarkup(latex);

const FORMAT_LABEL = {
  exact: (d) => (d.kind === "surd" ? "Exact" : "Fraction"),
  mixed: () => "Mixed",
  decimal: () => "Decimal",
  sci: () => "Standard form",
};

function pickForm(d) {
  let f = state.pref;
  if (f === "mixed" && !d.mixed) f = "exact";
  if (f === "exact" && d.kind === "approx") f = "decimal";
  return f;
}

function formLatex(d, f) {
  if (f === "exact") return { latex: d.exact, approx: false };
  if (f === "mixed") return { latex: d.mixed, approx: false };
  if (f === "decimal") return { latex: d.decimal.latex, approx: d.decimal.approx, periodic: d.decimal.periodic };
  return { latex: d.sci.latex, approx: d.sci.approx };
}

function renderFormats(d) {
  const box = $("formats");
  box.textContent = "";
  if (!d) return;
  const shown = pickForm(d);
  const options = ["exact", ...(d.mixed ? ["mixed"] : []), "decimal", "sci"];
  for (const f of options) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "chip";
    b.textContent = FORMAT_LABEL[f](d);
    b.setAttribute("aria-pressed", String(f === shown));
    if (f === "exact" && d.kind === "approx") { b.disabled = true; b.title = "This number is not a fraction"; b.textContent = "Fraction"; }
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", () => { state.pref = f; store.set("calc-pref", f); refresh(); });
    box.appendChild(b);
  }
}

let lastShown = "";
function refresh({ error = null, fresh = false } = {}) {
  const value = state.live || state.committed;
  const main = $("resMain"), note = $("resNote");
  note.className = "res-note";
  if (error) {
    main.textContent = ""; note.textContent = error; note.classList.add("err");
    renderFormats(null);
    return;
  }
  if (!value) {
    main.textContent = ""; note.textContent = isEmpty() ? "Try ½ + ⅓ with the fraction key" : "";
    renderFormats(null);
    lastShown = "";
    return;
  }
  const d = describe(value, { dec: state.dec });
  const f = pickForm(d);
  const out = formLatex(d, f);
  const html = (out.approx ? "<span class='ML__text' style='opacity:.6'>≈&nbsp;</span>" : "") + markup(out.latex);
  main.innerHTML = html;
  main.classList.toggle("preview", !!state.live);
  const key = out.latex + f + (state.live ? "p" : "c");
  if ((fresh || key !== lastShown) && !state.live) { main.classList.remove("fresh"); void main.offsetWidth; main.classList.add("fresh"); }
  lastShown = key;
  main.setAttribute("aria-label", d.plain);
  note.textContent = out.periodic ? "repeating decimal" : (f === "sci" ? "standard form" : "");
  renderFormats(d);
}

/* ---------- live preview ---------- */
function onInput() {
  const latex = mf.getValue("latex");
  if (!latex.trim()) { state.live = null; refresh(); return; }
  try {
    state.live = evaluate(latex, { ans: state.ans, angle: state.angle });
    refresh();
  } catch (e) {
    state.live = null;
    if (e instanceof CalcError && (e.code === "div0" || e.code === "domain")) refresh({ error: e.message });
    else refresh();
  }
}
mf.addEventListener("input", onInput);

/* ---------- history ---------- */
function renderHistory() {
  const ol = $("history");
  ol.textContent = "";
  for (const item of state.history.slice(-30)) {
    const li = document.createElement("li");
    const e = document.createElement("button");
    e.type = "button"; e.className = "h-expr"; e.title = "Edit this calculation";
    e.innerHTML = markup(item.latex);
    e.addEventListener("click", () => { mf.setValue(item.latex); focusField(); onInput(); });
    const r = document.createElement("button");
    r.type = "button"; r.className = "h-res"; r.title = "Use this result";
    const d = describe(item.value, { dec: state.dec });
    const out = formLatex(d, pickForm(d));
    r.innerHTML = "= " + (out.approx ? "≈&nbsp;" : "") + markup(out.latex);
    r.addEventListener("click", () => {
      mf.insert(d.exact && d.kind !== "approx" ? d.exact : d.decimal.latex.replace("{,}", "."), { focus: !coarse });
      onInput();
    });
    li.append(e, r);
    ol.appendChild(li);
  }
  ol.scrollTop = ol.scrollHeight;
}

/* ---------- equals ---------- */
function equals() {
  const latex = mf.getValue("latex");
  if (!latex.trim()) return;
  try {
    const value = evaluate(latex, { ans: state.ans, angle: state.angle });
    state.history.push({ latex, value });
    state.ans = value;
    state.committed = value;
    state.live = null;
    mf.setValue("");
    renderHistory();
    refresh({ fresh: true });
  } catch (e) {
    const msg = e instanceof CalcError ? e.message : "Check the expression";
    state.live = null;
    refresh({ error: msg });
    const r = $("result");
    r.classList.remove("shake"); void r.offsetWidth; r.classList.add("shake");
  }
}

/* ---------- keypad ---------- */
const FRAC_ICON = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><rect x="7.5" y="2.5" width="9" height="6.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 12h17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="7.5" y="15" width="9" height="6.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const SQRT_ICON = '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true"><path d="M2.5 12.5l3.2-1.6 3.6 8.1 6-15.5h6.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';

/* kind: num | op | fn | hero | eq | ctl;  ans: insert "Ans" first when the field is empty after "=".
   alt: what the key becomes while "2nd" is armed (label, aria and/or inserted LaTeX).             */
const KEYS = [
  { l: FRAC_ICON, aria: "Fraction", kind: "hero", ins: "\\frac{#@}{#?}" },
  { l: "x<sup>n</sup>", aria: "Power", kind: "fn", ins: "#@^{#?}", ans: true },
  { l: SQRT_ICON, aria: "Square root", kind: "fn", ins: "\\sqrt{#?}",
    alt: { l: "<sup class=\"n\">n</sup>√", aria: "Nth root", ins: "\\sqrt[#?]{#?}" } },
  { l: "π", aria: "Pi", kind: "fn", ins: "\\pi",
    alt: { l: "e", aria: "Euler's number e", ins: "\\exponentialE" } },
  { l: "⌫", aria: "Delete", kind: "ctl", cmd: "deleteBackward" },

  { l: "(", aria: "Open bracket", kind: "fn", ins: "\\left(#?\\right)" },
  { l: ")", aria: "Close bracket", kind: "fn", cmd: "moveToNextChar" },
  { l: "◀", aria: "Move left", kind: "ctl", cmd: "moveToPreviousChar" },
  { l: "▶", aria: "Move right", kind: "ctl", cmd: "moveToNextChar" },
  { l: "AC", aria: "Clear all", kind: "ctl clear", act: "clear" },

  { l: "7", kind: "num", ins: "7" }, { l: "8", kind: "num", ins: "8" }, { l: "9", kind: "num", ins: "9" },
  { l: "÷", aria: "Divide", kind: "op", ins: "\\div ", ans: true },
  { l: "Ans", aria: "Previous answer", kind: "fn", ins: "\\mathrm{Ans}" },

  { l: "4", kind: "num", ins: "4" }, { l: "5", kind: "num", ins: "5" }, { l: "6", kind: "num", ins: "6" },
  { l: "×", aria: "Multiply", kind: "op", ins: "\\times ", ans: true },
  { l: "×10<sup>x</sup>", aria: "Times ten to the power", kind: "fn", ins: "\\times10^{#?}", ans: true },

  { l: "1", kind: "num", ins: "1" }, { l: "2", kind: "num", ins: "2" }, { l: "3", kind: "num", ins: "3" },
  { l: "−", aria: "Subtract", kind: "op", ins: "-", ans: true },
  { l: "=", aria: "Equals", kind: "eq", act: "equals" },

  { l: "0", kind: "num", ins: "0" }, { l: ".", aria: "Decimal point", kind: "num", act: "point" },
  { l: "x<sup>2</sup>", aria: "Square", kind: "fn", ins: "#@^{2}", ans: true },
  { l: "+", aria: "Add", kind: "op", ins: "+", ans: true },
];

/* function row: "2nd" flips every key that has an alt (sin → sin⁻¹, log → 10ˣ, ln → eˣ, √ → ⁿ√, π → e) */
const FN_KEYS = [
  { l: "2nd", aria: "Second function: inverse functions", kind: "fn second", act: "second" },
  { l: "sin", aria: "Sine", kind: "fn", ins: "\\sin\\left(#?\\right)",
    alt: { l: "sin<sup>−1</sup>", aria: "Inverse sine", ins: "\\sin^{-1}\\left(#?\\right)" } },
  { l: "cos", aria: "Cosine", kind: "fn", ins: "\\cos\\left(#?\\right)",
    alt: { l: "cos<sup>−1</sup>", aria: "Inverse cosine", ins: "\\cos^{-1}\\left(#?\\right)" } },
  { l: "tan", aria: "Tangent", kind: "fn", ins: "\\tan\\left(#?\\right)",
    alt: { l: "tan<sup>−1</sup>", aria: "Inverse tangent", ins: "\\tan^{-1}\\left(#?\\right)" } },
  { l: "log", aria: "Logarithm base 10", kind: "fn", ins: "\\log\\left(#?\\right)",
    alt: { l: "10<sup>x</sup>", aria: "Ten to the power", ins: "10^{#?}" } },
  { l: "ln", aria: "Natural logarithm", kind: "fn", ins: "\\ln\\left(#?\\right)",
    alt: { l: "e<sup>x</sup>", aria: "e to the power", ins: "\\exponentialE^{#?}" } },
];

const built = [];                         // [{ el, key }]
const specOf = (key) => (state.second && key.alt ? { ...key, ...key.alt } : key);

function paint() {
  for (const { el, key } of built) {
    const sp = specOf(key);
    el.innerHTML = sp.l;
    el.setAttribute("aria-label", sp.aria || sp.l.replace(/<[^>]+>/g, ""));
    if (key.act === "second") el.setAttribute("aria-pressed", String(state.second));
    if (key.alt) {
      el.classList.toggle("alt", state.second);
      el.classList.remove("flip"); void el.offsetWidth; el.classList.add("flip");
    }
  }
}

function press(key) {
  if (key.act === "second") { state.second = !state.second; paint(); return; }
  const k = specOf(key);
  if (state.second) { state.second = false; paint(); }                 // 2nd is one-shot
  if (k.act === "equals") return equals();
  if (k.act === "clear") {
    mf.setValue(""); state.live = null; state.committed = null; refresh(); return;
  }
  if (k.ans && isEmpty() && state.ans) mf.insert("\\mathrm{Ans}", { focus: !coarse });
  if (k.act === "point") mf.insert(state.dec === "," ? "{,}" : ".", { focus: !coarse });
  else if (k.cmd) mf.executeCommand(k.cmd);
  else if (k.ins) mf.insert(k.ins, { focus: !coarse, selectionMode: "placeholder" });
  if (!coarse) mf.focus({ preventScroll: true });
  onInput();
}

function buildPad() {
  for (const [list, host] of [[FN_KEYS, $("fnrow")], [KEYS, $("pad")]]) {
    for (const k of list) {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "key " + k.kind;
      b.addEventListener("pointerdown", (e) => e.preventDefault());     // keep focus (and the caret) in the field
      b.addEventListener("click", () => press(k));
      host.appendChild(b);
      built.push({ el: b, key: k });
    }
  }
  paint();
  for (const { el } of built) el.classList.remove("flip");
}
buildPad();

/* ---------- angle unit pill (DEG | RAD) ---------- */
const angleBtn = $("angleBtn");
function paintAngle() {
  const deg = state.angle === "deg";
  angleBtn.innerHTML = `<span class="${deg ? "on" : ""}">DEG</span><span class="${deg ? "" : "on"}">RAD</span>`;
  angleBtn.setAttribute("aria-label", `Angle unit: ${deg ? "degrees" : "radians"}. Tap to switch.`);
  angleBtn.title = "Angle unit for sin, cos, tan: tap to switch";
}
angleBtn.addEventListener("click", () => {
  state.angle = state.angle === "deg" ? "rad" : "deg";
  store.set("calc-angle", state.angle); paintAngle();
  if (!isEmpty()) onInput();
});
paintAngle();

/* physical keyboard */
mf.addEventListener("keydown", (e) => {
  if (e.key === "Enter") { e.preventDefault(); equals(); }
  else if (e.key === "Escape") { mf.setValue(""); state.live = null; refresh(); }
});
mf.addEventListener("beforeinput", () => {});

/* ---------- decimal separator toggle (next to the theme buttons) ---------- */
const bar = $("themebar");
const decBtn = document.createElement("button");
decBtn.type = "button"; decBtn.className = "toggle tb-dec";
decBtn.title = "Decimal separator in the results";
const paintDec = () => { decBtn.textContent = state.dec === "," ? "1,5" : "1.5"; };
decBtn.addEventListener("click", () => {
  state.dec = state.dec === "." ? "," : ".";
  store.set("calc-dec", state.dec); paintDec(); renderHistory(); refresh();
});
paintDec();
bar.appendChild(decBtn);

