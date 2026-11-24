/* Thumb Calculator (phones): same engine and display as calculator.js, but a thumb-sized keypad where
   hidden keys fan out when a key is held (radial.js). Hand side, tour and haptics live here. */
import { MathfieldElement, convertLatexToMarkup } from "./vendor/mathlive/mathlive.min.mjs";
import { evaluate, describe, CalcError } from "./calculator-engine.js";
import { attachRadial } from "./radial.js";
import { exitStructures, closeBracketIfAny, trigPower } from "./thumb-edit.js";

MathfieldElement.fontsDirectory = "vendor/mathlive/fonts";
MathfieldElement.soundsDirectory = null;

// If the browser still holds an older copy of the page, an element this script wants may be missing: a detached
// stand-in keeps the rest of the script alive (a missing button must never break "?" and the keys).
const $ = (id) => document.getElementById(id) || document.createElement("div");
const store = {
  get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

/* ---------- state ---------- */
const state = {
  dec: ".",                                   // decimal separator shown in results (a comma only if ever needed again)
  pick: null,                                 // one-off form chosen with a chip: { plain, f } (valid for that result only)
  angle: store.get("calc-angle", "deg"),      // deg | rad (for sin, cos, tan and their inverses)
  ans: null,                                  // last committed value
  committed: null,                            // value currently shown after "="
  live: null,                                 // value of the expression being typed
  undo: [],                                   // what AC and = took off the line, newest last: the undo petal of AC brings it back
};
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
  watchFit();
}, { once: true });
mf.setAttribute("placeholder", "\\text{Type here}");
$("entry").appendChild(mf);

/* ---------- the expression shrinks to stay in view; below the minimum size it scrolls to the caret ---------- */
let fitQueued = false, fitForce = false, baseSize = 0, lastSig = "";
function readBase() {                                           // the size CSS asks for (it changes with the screen height)
  const had = mf.style.fontSize;
  if (had) mf.style.fontSize = "";
  const v = parseFloat(getComputedStyle(mf).fontSize);
  if (had) mf.style.fontSize = had;
  return v;
}
function fitEntry(force) {
  const root = mf.shadowRoot && mf.shadowRoot.querySelector(".ML__latex");
  if (!root || !mf.clientWidth) return;
  if (!baseSize) baseSize = readBase();
  const cs = getComputedStyle(mf);
  const avail = mf.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 14;   // room for the caret
  const min = Math.max(17, baseSize * 0.5);
  let size = parseFloat(cs.fontSize);
  const setSize = (s) => {
    size = s;
    const next = s >= baseSize - 0.3 ? "" : s.toFixed(2) + "px";
    if (mf.style.fontSize !== next) mf.style.fontSize = next;
  };
  // height: what is left of the display once the top row and the result have their space
  const screen = mf.closest(".screen"), scs = getComputedStyle(screen);
  const above = screen.querySelector(".sc-top"), below = screen.querySelector(".result");
  const room = screen.clientHeight - parseFloat(scs.paddingTop) - parseFloat(scs.paddingBottom)
    - (above ? above.offsetHeight : 0) - (below ? below.offsetHeight : 0);
  const pcs = mf.parentElement ? getComputedStyle(mf.parentElement) : null;
  const extra = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom) + parseFloat(cs.borderBottomWidth || 0)
    + (pcs ? parseFloat(pcs.paddingTop) + parseFloat(pcs.paddingBottom) : 0);
  const availH = room - extra - 4;
  for (let i = 0; i < 3; i++) {
    const r = root.getBoundingClientRect();
    const naturalW = r.width * baseSize / size;                  // size at the full font (layout is linear in the font size)
    const naturalH = r.height * baseSize / size;
    let want = baseSize;
    if (naturalW > avail) want = Math.min(want, baseSize * avail / naturalW * 0.985);
    if (availH > 20 && naturalH > availH) want = Math.min(want, baseSize * availH / naturalH * 0.985);
    want = Math.max(min, want);
    if (Math.abs(want - size) < 0.4) break;
    setSize(want);
  }
  const sig = size.toFixed(1) + "|" + Math.round(root.getBoundingClientRect().width);
  if (force || sig !== lastSig) { lastSig = sig; try { mf.executeCommand("scrollIntoView"); } catch (e) {} }
}
function queueFit(force) {
  fitForce = fitForce || force === true;
  if (fitQueued) return;
  fitQueued = true;
  requestAnimationFrame(() => { fitQueued = false; const f = fitForce; fitForce = false; fitEntry(f); });
}
function watchFit() {
  if (mf.shadowRoot) new MutationObserver(() => queueFit()).observe(mf.shadowRoot, { childList: true, subtree: true, characterData: true });
  mf.addEventListener("input", () => queueFit(true));
  const res = document.getElementById("result");
  if (res) new MutationObserver(() => queueFit()).observe(res, { childList: true, subtree: true, characterData: true });
  addEventListener("resize", () => { baseSize = 0; queueFit(true); });
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { baseSize = 0; queueFit(); });
}

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

/* The fraction is always shown when the result is one. A chip changes the form of the
   current result only: the next calculation goes back to the fraction. */
function pickForm(d, own = false) {
  let f = own && state.pick && state.pick.plain === d.plain ? state.pick.f : "exact";
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

let lastShown = "";
function refresh({ error = null, fresh = false } = {}) {
  const value = state.live || state.committed;
  const main = $("resMain"), note = $("resNote");
  note.className = "res-note";
  if (error) {
    main.textContent = ""; note.textContent = error; note.classList.add("err");
    return;
  }
  if (!value) {
    main.textContent = ""; note.textContent = isEmpty() ? "Try ½ + ⅓ with the fraction key" : "";
    lastShown = "";
    return;
  }
  const d = describe(value, { dec: state.dec });
  const f = pickForm(d, true);
  const out = formLatex(d, f);
  const html = (out.approx ? "<span class='ML__text' style='opacity:.6'>≈&nbsp;</span>" : "") + markup(out.latex);
  main.innerHTML = html;
  main.classList.toggle("preview", !!state.live);
  const key = out.latex + f + (state.live ? "p" : "c");
  if ((fresh || key !== lastShown) && !state.live) { main.classList.remove("fresh"); void main.offsetWidth; main.classList.add("fresh"); }
  lastShown = key;
  main.setAttribute("aria-label", d.plain);
  note.textContent = out.periodic ? "repeating decimal" : (f === "sci" ? "standard form" : "");
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

/* ---------- undo (hold AC) ---------- */
function pushUndo(latex) {
  if (!latex || !latex.trim() || state.undo[state.undo.length - 1] === latex) return;
  state.undo.push(latex);
  if (state.undo.length > 50) state.undo.shift();
}
function undo() {
  const latex = state.undo.pop();
  if (latex == null) { tick(4); return; }
  state.committed = null; state.live = null;
  mf.setValue(latex); focusField(); onInput();
}

/* ---------- equals ---------- */
function equals() {
  const latex = mf.getValue("latex");
  if (!latex.trim()) return;
  try {
    const value = evaluate(latex, { ans: state.ans, angle: state.angle });
    pushUndo(latex);
    state.ans = value;
    state.committed = value;
    state.live = null;
    mf.setValue("");
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

/* Layout (iPhone-keyboard habits: delete on the right edge, equals bottom right):
     ( )  sin  ×10ˣ  ÷
     frac x²   √     ×
     7    8    9     −
     4    5    6     +
     1    2    3     ⌫
     π    0    .     =                                  */
const K = {
  paren: { l: "( )", aria: "Brackets", kind: "fn", act: "paren", alts: [
    { l: "(", aria: "Open bracket only", ins: "(" }, { l: ")", aria: "Close bracket only", ins: ")" }] },
  trig: { ...TRIGS[0], kind: "fn mono", alts: TRIGS },
  sci: { l: "×10<sup>x</sup>", aria: "Times ten to the power", kind: "fn", ins: "\\times10^{#?}", ans: true, exit: true, alts: [
    { l: "log", aria: "Logarithm base 10", ins: "\\log\\left(#?\\right)" },
    { l: "ln", aria: "Natural logarithm", ins: "\\ln\\left(#?\\right)" },
    { l: "10<sup>x</sup>", aria: "Ten to the power", ins: "10^{#?}" },
    { l: "e<sup>x</sup>", aria: "e to the power", ins: "\\exponentialE^{#?}" } ] },
  div: { ...op("÷", "Divide", "\\div "), alts: [
    { l: "%", aria: "Percent", ins: "\\%" }, { l: "n!", aria: "Factorial", ins: "!" }] },
  frac: { l: FRAC_ICON, aria: "Fraction", kind: "hero", ins: "\\frac{#@}{#?}" },
  sq: { l: "x<sup>2</sup>", aria: "Square", kind: "fn", ins: "#@^{2}", pow: 2, ans: true, alts: [
    { l: "x<sup>n</sup>", aria: "Power", ins: "#@^{#?}", ans: true },
    { l: "x<sup>3</sup>", aria: "Cube", ins: "#@^{3}", pow: 3, ans: true },
    { l: "x<sup>−1</sup>", aria: "Reciprocal", ins: "#@^{-1}", ans: true } ] },
  root: { l: SQRT_ICON, aria: "Square root", kind: "fn", ins: "\\sqrt{#?}", alts: [
    { l: "<sup class=\"n\">n</sup>√", aria: "Nth root (type the index first)", ins: "\\sqrt[#@]{#?}", nth: true },
    { l: "<sup class=\"n\">3</sup>√", aria: "Cube root", ins: "\\sqrt[3]{#?}" } ] },
  mul: op("×", "Multiply", "\\times "),
  sub: op("−", "Subtract", "-"),
  add: op("+", "Add", "+"),
  ac: { l: "AC", aria: "Clear all", kind: "ctl", act: "clear", alts: [{ l: "↶", aria: "Undo: bring back what was cleared", act: "undo" }] },
  pi: { l: "π", aria: "Pi", kind: "fn", ins: "\\pi", alts: [{ l: "e", aria: "Euler's number e", ins: "\\exponentialE" }] },
  point: { l: ".", aria: "Decimal point", kind: "num", act: "point" },
  eq: { l: "=", aria: "Equals", kind: "eq", act: "equals", alts: [        // hold: how to show the result
    { l: "/", aria: "Show the result as a fraction", act: "fmt", f: "exact" },
    { l: "d", aria: "Show the result as a decimal", act: "fmt", f: "decimal" },
    { l: "s", aria: "Show the result in standard form", act: "fmt", f: "sci" } ] },
};
const KEYS = [                       // = on top (the thumb of a right hand goes up to it), AC under it; ⌫ lives on the screen
  K.paren, K.trig, K.sci, K.eq,
  K.frac, K.sq, K.root, K.ac,
  num("7"), num("8"), num("9"), K.div,
  num("4"), num("5"), num("6"), K.mul,
  num("1"), num("2"), num("3"), K.sub,
  K.pi, num("0"), K.point, K.add,
];

/* a short message above the keypad (only used for the iPhone install hint) */
let toastTimer = null;
function toast(text, ms = 6000) {
  const t = $("toast"), s = t.querySelector("span");
  s.textContent = text; t.hidden = false; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove("show"); t.hidden = true; }, ms);
}

function setFormat(f) {
  const value = state.live || state.committed;
  if (!value) return;
  state.pick = { plain: describe(value, { dec: state.dec }).plain, f };
  refresh();
}

function press(k) {
  if (k.act === "equals") return equals();
  if (k.act === "fmt") return setFormat(k.f);
  if (k.act === "undo") return undo();
  if (k.act === "clear") {
    pushUndo(mf.getValue("latex"));
    mf.setValue(""); state.live = null; state.committed = null; refresh();
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

/* ---------- delete: a region of the screen, hold to keep deleting ---------- */
const delBtn = $("delBtn");
let delWait = null, delRun = null;
const delOnce = () => press({ cmd: "deleteBackward" });
const delStop = () => { clearTimeout(delWait); clearInterval(delRun); delWait = delRun = null; };
delBtn.addEventListener("pointerdown", (e) => {
  e.preventDefault(); delStop(); delOnce(); tick(6);
  delWait = setTimeout(() => { delRun = setInterval(delOnce, 70); }, 420);
  try { delBtn.setPointerCapture(e.pointerId); } catch (err) {}
});
for (const t of ["pointerup", "pointercancel", "lostpointercapture"]) delBtn.addEventListener(t, delStop);
addEventListener("blur", delStop);
delBtn.addEventListener("click", (e) => { if (e.detail === 0) delOnce(); });   // keyboard

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
  else if (e.key === "Escape") { pushUndo(mf.getValue("latex")); mf.setValue(""); state.live = null; refresh(); }
});
mf.addEventListener("beforeinput", () => {});

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
  { title: "Result", text: "Hold = to choose how the result looks:  /  fraction,  d  decimal,  s  standard form.",
    stage: () => `<div class="demo-key"><span>=</span></div>
      <div class="dp dp2 dpl">/</div><div class="dp dp1 dpm">d</div><div class="dp dp2 dpr">s</div>
      <div class="finger f-holdc"></div><div class="bubble b-hold">9/20 → 0.45</div>` },
  { title: "Undo", text: "Hold AC and slide to ↶: it brings back what you cleared or calculated.",
    stage: () => `<div class="demo-key"><span>AC</span></div>
      <div class="dp dp1 dpm">↶</div>
      <div class="finger f-holdc"></div><div class="bubble b-hold">2+3</div>` },
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

/* ---------- app (PWA): installable and offline ---------- */
{
  const btn = $("pwaBtn"), meta = document.querySelector('meta[name="theme-color"]'), root = document.documentElement;
  const paintTheme = () => meta && meta.setAttribute("content", getComputedStyle(document.body).backgroundColor ? rgbToHex(getComputedStyle(document.body).backgroundColor) : "#071d19");
  const rgbToHex = (c) => { const m = c.match(/\d+/g); return m ? "#" + m.slice(0, 3).map((n) => (+n).toString(16).padStart(2, "0")).join("") : "#071d19"; };
  paintTheme(); new MutationObserver(() => requestAnimationFrame(paintTheme)).observe(root, { attributes: true, attributeFilter: ["data-mode"] });
  if ("serviceWorker" in navigator && /^https?:$/.test(location.protocol)) addEventListener("load", () => navigator.serviceWorker.register("thumb-sw.js", { scope: "thumb.html" }).catch(() => {}));
  const standalone = matchMedia("(display-mode: standalone)").matches || navigator.standalone;
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  let ask = null;
  if (!standalone && ios) btn.hidden = false;                 // iOS has no install prompt: the button explains the steps
  addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); ask = e; if (!standalone) btn.hidden = false; });
  addEventListener("appinstalled", () => { ask = null; btn.hidden = true; });
  btn.addEventListener("click", async () => {
    if (ask) { ask.prompt(); await ask.userChoice; ask = null; btn.hidden = true; return; }
    toast("Share → Add to Home Screen");
  });
}
