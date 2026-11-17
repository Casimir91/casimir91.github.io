/* Thumb Calculator (phones): same engine and display as calculator.js, but a thumb-sized keypad where
   hidden keys fan out when a key is held (radial.js). Hand side, tour and haptics live here. */
import { MathfieldElement, convertLatexToMarkup } from "./vendor/mathlive/mathlive.min.mjs";
import { evaluate, describe, CalcError } from "./calculator-engine.js";
import { attachRadial } from "./radial.js";
import { exitStructures, closeBracketIfAny, trigPower } from "./thumb-edit.js";

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
mf.setAttribute("placeholder", "\\text{Type here}");
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

/* ---------- haptics (Android/Chrome only: iOS Safari has no vibration API) ---------- */
const tick = (ms = 8) => { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} };

/* ---------- keypad: 4 columns x 6 rows. No arrow keys: tap the expression to move the caret; operators leave
   denominators / exponents / radicands by themselves and ( ) closes a bracket. Hidden keys are petals. ---------- */
const FRAC_ICON = '<svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true"><rect x="7.5" y="2.5" width="9" height="6.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 12h17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="7.5" y="15" width="9" height="6.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const SQRT_ICON = '<svg viewBox="0 0 24 24" width="28" height="28" aria-hidden="true"><path d="M2.5 12.5l3.2-1.6 3.6 8.1 6-15.5h6.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const num = (d) => ({ l: d, kind: "num", ins: d });
const op = (l, aria, ins) => ({ l, aria, kind: "op", ins, ans: true, exit: true });
/* trig family: inner ring sin cos tan cot, outer ring (slide further out) the inverses */
const trigItem = (name, aria) => ({
  l: name, aria, ins: `\\${name}\\left(#?\\right)`,
  outer: { l: `${name}<sup>−1</sup>`, aria: `Inverse ${aria.toLowerCase()}`, ins: `\\${name}^{-1}\\left(#?\\right)` } });
const TRIGS = [trigItem("sin", "Sine"), trigItem("cos", "Cosine"), trigItem("tan", "Tangent"), trigItem("cot", "Cotangent")];

const KEYS = [
  { l: "π", aria: "Pi", kind: "fn", ins: "\\pi", alts: [{ l: "e", aria: "Euler's number e", ins: "\\exponentialE" }] },
  { ...TRIGS[0], kind: "fn mono", alts: TRIGS },
  { l: "×10<sup>x</sup>", aria: "Times ten to the power", kind: "fn", ins: "\\times10^{#?}", ans: true, exit: true, alts: [
    { l: "log", aria: "Logarithm base 10", ins: "\\log\\left(#?\\right)" },
    { l: "ln", aria: "Natural logarithm", ins: "\\ln\\left(#?\\right)" },
    { l: "10<sup>x</sup>", aria: "Ten to the power", ins: "10^{#?}" },
    { l: "e<sup>x</sup>", aria: "e to the power", ins: "\\exponentialE^{#?}" } ] },
  { l: "⌫", aria: "Delete", kind: "ctl", cmd: "deleteBackward", alts: [{ l: "AC", aria: "Clear all", act: "clear" }] },

  { l: FRAC_ICON, aria: "Fraction", kind: "hero", ins: "\\frac{#@}{#?}" },
  { l: "x<sup>2</sup>", aria: "Square", kind: "fn", ins: "#@^{2}", pow: 2, ans: true, alts: [
    { l: "x<sup>n</sup>", aria: "Power", ins: "#@^{#?}", ans: true },
    { l: "x<sup>3</sup>", aria: "Cube", ins: "#@^{3}", pow: 3, ans: true },
    { l: "x<sup>−1</sup>", aria: "Reciprocal", ins: "#@^{-1}", ans: true } ] },
  { l: SQRT_ICON, aria: "Square root", kind: "fn", ins: "\\sqrt{#?}", alts: [
    { l: "<sup class=\"n\">n</sup>√", aria: "Nth root (type the index first)", ins: "\\sqrt[#@]{#?}", nth: true },
    { l: "<sup class=\"n\">3</sup>√", aria: "Cube root", ins: "\\sqrt[3]{#?}" } ] },
  { l: "( )", aria: "Brackets", kind: "fn", act: "paren" },

  num("7"), num("8"), num("9"), { ...op("÷", "Divide", "\\div "), alts: [
    { l: "%", aria: "Percent", ins: "\\%" }, { l: "n!", aria: "Factorial", ins: "!" }] },
  num("4"), num("5"), num("6"), op("×", "Multiply", "\\times "),
  num("1"), num("2"), num("3"), op("−", "Subtract", "-"),
  num("0"), { l: ".", aria: "Decimal point", kind: "num", act: "point" },
  { l: "=", aria: "Equals", kind: "eq", act: "equals", alts: [{ l: "Ans", aria: "Previous answer", ins: "\\mathrm{Ans}" }] },
  op("+", "Add", "+"),
];

/* "Cleared · Undo" */
let undoTimer = null, cleared = null;
function showUndo(prev) {
  cleared = prev;
  const t = $("toast"); t.hidden = false; t.classList.add("show");
  clearTimeout(undoTimer);
  undoTimer = setTimeout(() => { t.classList.remove("show"); t.hidden = true; cleared = null; }, 5000);
}
$("undoBtn").addEventListener("click", () => {
  if (cleared == null) return;
  mf.setValue(cleared); mf.position = mf.lastOffset; cleared = null;
  $("toast").classList.remove("show"); $("toast").hidden = true;
  onInput(); tick(10);
});

function press(k) {
  if (k.act === "equals") return equals();
  if (k.act === "clear") {
    const prev = mf.getValue();
    mf.setValue(""); state.live = null; state.committed = null; refresh();
    if (prev && prev.trim()) showUndo(prev);
    return;
  }
  if (k.act === "paren") {
    if (!closeBracketIfAny(mf)) mf.insert("\\left(#?\\right)", { focus: !coarse, selectionMode: "placeholder" });
    if (!coarse) mf.focus({ preventScroll: true });
    onInput(); return;
  }
  if (k.exit) exitStructures(mf);                                   // 1/3 + …  2³ + …  √9 + …
  if (k.ans && isEmpty() && state.ans) mf.insert("\\mathrm{Ans}", { focus: !coarse });
  if (k.pow && trigPower(mf, k.pow)) { onInput(); return; }         // sin(x) then x² → sin²(x)
  if (k.act === "point") mf.insert(state.dec === "," ? "{,}" : ".", { focus: !coarse });
  else if (k.cmd) mf.executeCommand(k.cmd);
  else if (k.ins) {
    let ins = k.ins;
    if (k.nth) {                                                    // ⁿ√: the number just typed is the index
      const a = atomAtCaretForNth();
      if (!a) ins = "\\sqrt[#?]{#?}";
    }
    mf.insert(ins, { focus: !coarse, selectionMode: "placeholder" });
  }
  if (!coarse) mf.focus({ preventScroll: true });
  onInput();
}
function atomAtCaretForNth() {
  try { const a = mf._mathfield.model.at(mf.position); return a && a.type === "mord" && /^[0-9]$/.test(a.value || a.command || ""); }
  catch (e) { return false; }
}

const pad = $("pad");
for (const k of KEYS) {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "key " + k.kind;
  b.innerHTML = k.l;
  b.setAttribute("aria-label", k.aria || k.l.replace(/<[^>]+>/g, ""));
  b.addEventListener("pointerdown", (e) => { e.preventDefault(); tick(6); });   // keep focus (and the caret) in the field
  if (k.alts) attachRadial(b, k.alts, (item) => press({ ans: k.ans, exit: k.exit, ...item }));
  b.addEventListener("click", () => press(k));
  pad.appendChild(b);
}

/* ---------- hand: right | left (mirrors the keypad so the operators sit under the thumb) ---------- */
const handBtn = $("handBtn");
let hand = store.get("thumb-hand", "right") === "left" ? "left" : "right";
function paintHand() {
  pad.classList.toggle("lefty", hand === "left");
  // left hand: the right-hand column (operators, delete, brackets; the arrows in row 2) moves to the left; digits keep their order
  [...pad.children].forEach((el, i) => {
    const row = Math.floor(i / 4), col = i % 4;
    // left hand: the right-hand column moves to the left; in the top row only π and ⌫ swap, so the two big fans stay central
    const c = hand !== "left" ? col : row === 0 ? [3, 1, 2, 0][col] : (col === 3 ? 0 : col + 1);
    el.style.order = String(row * 4 + c);
  });
  handBtn.innerHTML = `<span class="${hand === "left" ? "on" : ""}">Left</span><span class="${hand === "left" ? "" : "on"}">Right</span>`;
  handBtn.setAttribute("aria-label", `Keypad for the ${hand} hand. Tap to switch.`);
}
handBtn.addEventListener("click", () => { hand = hand === "left" ? "right" : "left"; store.set("thumb-hand", hand); paintHand(); });
paintHand();

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



/* ---------- tour: tap / hold / brackets / your turn ---------- */
const tour = $("tour"), stage = $("tourStage");
const STEPS = [
  { title: "Tap", text: "A tap types the key, as usual.",
    stage: () => `<div class="demo-key"><span>sin</span></div><div class="finger f-tap"></div><div class="bubble b-tap">sin(▢)</div>` },
  { title: "Hold", text: "Keys with little dots hide more keys. Press and hold: they fan out around your thumb. Slide to one and let go. Some keys have a second, outer ring: pull further for the inverse.",
    stage: () => `<div class="demo-key has-alt" data-alts="2"><span>sin</span></div>
      <div class="dp dp1">sin</div><div class="dp dp2">cos</div>
      <div class="finger f-hold"></div><div class="bubble b-hold">sin(▢)</div>` },
  { title: "Brackets", text: "",
    stage: () => `<div class="bx"><span class="bfrac"><span class="bn">1</span><span class="bd"><i class="bq">▢</i><i class="b1">(</i><i class="b2">2</i><i class="b3">+</i><i class="b4">3</i><i class="b5">)</i></span></span><i class="b6">+1</i></div>
      <div class="demo-key sm"><span>( )</span></div><div class="finger f-br"></div>` },
  { title: "Your turn", text: "Hold the key, slide up-left to the inner ring, then pull further out for sin⁻¹. Release.",
    stage: () => `<button type="button" class="key fn mono demo-live" id="demoKey">sin</button><div class="bubble b-live" id="demoOut">&nbsp;</div>` },
];
let step = 0, demoOk = false;
function paintTour() {
  const s = STEPS[step];
  $("tourTitle").textContent = s.title; $("tourText").textContent = s.text; $("tourText").hidden = !s.text;
  stage.innerHTML = s.stage();
  stage.dataset.step = String(step);
  $("tourDots").innerHTML = STEPS.map((_, i) => `<i class="${i === step ? "on" : ""}"></i>`).join("");
  $("tourNext").textContent = step === STEPS.length - 1 ? (demoOk ? "Start" : "Skip") : "Next";
  $("tourSkip").hidden = step === STEPS.length - 1;
  if (step === STEPS.length - 1) {
    demoOk = false;
    const key = $("demoKey");
    key.addEventListener("pointerdown", (e) => e.preventDefault());
    attachRadial(key, [
      { l: "sin", outer: { l: "sin<sup>−1</sup>", ok: true } }, { l: "cos", outer: { l: "cos<sup>−1</sup>" } },
      { l: "tan", outer: { l: "tan<sup>−1</sup>" } }, { l: "cot", outer: { l: "cot<sup>−1</sup>" } },
    ], (item) => {
      $("demoOut").innerHTML = item.ok ? "sin<sup>−1</sup>(▢) ✓ well done!" : "Nice! Now pull further out on the left for sin<sup>−1</sup>";
      demoOk = !!item.ok; $("demoOut").classList.toggle("good", demoOk); tick(item.ok ? [12, 40, 12] : 8);
      $("tourNext").textContent = demoOk ? "Start" : "Skip";
    });
  }
}
function openTour() { step = 0; paintTour(); tour.hidden = false; $("tourNext").focus({ preventScroll: true }); }
function closeTour() { tour.hidden = true; store.set("thumb-tour", "1"); }
$("tourNext").addEventListener("click", () => { if (step < STEPS.length - 1) { step++; paintTour(); } else closeTour(); });
$("tourSkip").addEventListener("click", closeTour);
$("tourBtn").addEventListener("click", openTour);
tour.addEventListener("keydown", (e) => { if (e.key === "Escape") closeTour(); });
if (store.get("thumb-tour", "") !== "1") setTimeout(openTour, 500);
