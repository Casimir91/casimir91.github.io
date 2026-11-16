/* Graph page: function cards (MathLive) + our own keypad + canvas + numeric analysis. */
import { MathfieldElement } from "./vendor/mathlive/mathlive.min.mjs";
import { verticalAsymptotes, horizontalAsymptotes, parseExpr, compile, zeros, extrema, intersections, niceNumber, niceStep, fmtValue, GraphError, PARAM_NAMES } from "./graph-engine.js";

MathfieldElement.fontsDirectory = "vendor/mathlive/fonts";
MathfieldElement.soundsDirectory = null;

const $ = (id) => document.getElementById(id);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};
const finite = Number.isFinite;
const minus = (s) => String(s).replace("-", "−");
const coarse = !!(window.matchMedia && window.matchMedia("(pointer: coarse)").matches);

/* ---------- state ---------- */
const NAMES = ["f", "g", "h", "p", "q", "r"];
const state = {
  fns: [],            // { latex, visible, ci, f, params, error, el, mf, ... }
  angle: "rad",
  tab: "fn",
  kb: coarse,
  marked: null,       // x chosen in the table
  trace: null,        // { px, py, color, html }
  pois: [],
  asym: { v: [], h: [] },
};
const V = { cx: 0, cy: 0, s: 40 };                 // view: centre (world) and pixels per unit
const PARAMS = {};                                  // name → { v, min, max }
const P = {};                                       // name → value (passed to compiled functions)
let active = null;                                  // function card whose field has the focus
let nextColor = 0;

/* ---------- parameters ---------- */
function ensureParam(name) {
  if (!PARAMS[name]) { PARAMS[name] = { v: 1, min: -5, max: 5 }; P[name] = 1; }
}
function setParam(name, v) {
  ensureParam(name);
  const p = PARAMS[name];
  if (Math.abs(v) > Math.max(Math.abs(p.min), Math.abs(p.max))) {
    const r = Math.pow(10, Math.ceil(Math.log10(Math.abs(v) * 1.2)));
    p.min = -r; p.max = r;
  }
  p.v = v; P[name] = v;
}

/* ---------- functions ---------- */
function compileFn(fn) {
  fn.f = null; fn.params = new Set(); fn.error = "";
  if (!fn.latex.trim()) return;
  try {
    const { ast, params } = parseExpr(fn.latex);
    fn.f = compile(ast, { deg: state.angle === "deg" });
    fn.params = params;
    fn.trig = /\\(sin|cos|tan)/.test(fn.latex);
    for (const n of params) ensureParam(n);
  } catch (e) {
    fn.error = e instanceof GraphError ? e.message : "Check the expression";
  }
}

function makeCard(fn) {
  const card = document.createElement("div");
  card.className = "fn";
  const vis = document.createElement("button");
  vis.type = "button"; vis.className = "vis"; vis.setAttribute("aria-pressed", "true"); vis.title = "Show / hide";
  vis.addEventListener("click", () => {
    fn.visible = !fn.visible; vis.setAttribute("aria-pressed", String(fn.visible));
    updateParams(); requestDraw(); renderTable(); save();
  });
  const nm = document.createElement("span"); nm.className = "nm";
  const mf = new MathfieldElement();
  mf.setAttribute("aria-label", "Function");
  mf.setAttribute("placeholder", "\\text{write a function}");
  mf.addEventListener("mount", () => {
    mf.mathVirtualKeyboardPolicy = "manual";
    mf.smartFence = true; mf.smartMode = false; mf.smartSuperscript = true;
    mf.inlineShortcuts = { ...mf.inlineShortcuts, log: "\\log", lg: "\\log" };
    if (fn.latex) mf.setValue(fn.latex);
    if (fn.focusOnMount && !coarse) mf.focus({ preventScroll: true });
  }, { once: true });
  mf.addEventListener("focus", () => setActive(fn));
  mf.addEventListener("input", () => onFnInput(fn));
  mf.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const i = state.fns.indexOf(fn);
      if (i < state.fns.length - 1) state.fns[i + 1].mf.focus();
      else if (fn.latex.trim()) addFn("", { focus: true });
    }
  });
  const del = document.createElement("button");
  del.type = "button"; del.className = "del"; del.setAttribute("aria-label", "Delete function"); del.textContent = "✕";
  del.addEventListener("click", () => removeFn(fn));
  const err = document.createElement("div"); err.className = "err"; err.hidden = true;
  const eq = document.createElement("span"); eq.className = "nm"; eq.textContent = "(x) =";
  card.append(vis, nm, eq, mf, del, err);
  Object.assign(fn, { el: card, mf, nmEl: nm, errEl: err, visEl: vis });
  return card;
}

function colorOf(fn) { return getComputedStyle(document.documentElement).getPropertyValue("--c" + (fn.ci + 1)).trim() || "#2f6fb0"; }
function paintCardColor(fn) { fn.el.style.setProperty("--col", colorOf(fn)); }

function addFn(latex = "", { focus = false, visible = true } = {}) {
  const fn = { latex, visible, ci: nextColor++ % 6, f: null, params: new Set(), error: "", focusOnMount: focus };
  state.fns.push(fn);
  $("fnlist").appendChild(makeCard(fn));
  compileFn(fn);
  renameAll();
  return fn;
}
function removeFn(fn) {
  if (state.fns.length === 1) { fn.mf.setValue(""); onFnInput(fn); fn.mf.focus(); return; }
  state.fns.splice(state.fns.indexOf(fn), 1);
  fn.el.remove();
  if (active === fn) active = null;
  renameAll(); updateParams(); updateEmpty(); requestDraw(); renderTable(); save();
}
function renameAll() {
  state.fns.forEach((fn, i) => { fn.nmEl.textContent = NAMES[i] || "f" + (i + 1); fn.nmEl.nextSibling.textContent = "(x) ="; paintCardColor(fn); });
}
function setActive(fn) {
  active = fn;
  state.fns.forEach((f) => f.el.classList.toggle("active", f === fn));
}

function onFnInput(fn) {
  fn.latex = fn.mf.getValue("latex");
  compileFn(fn);
  fn.errEl.hidden = true; fn.el.classList.remove("bad");
  clearTimeout(fn.errTimer);
  if (fn.error) fn.errTimer = setTimeout(() => {
    if (!fn.error) return;
    fn.errEl.textContent = fn.error; fn.errEl.hidden = false; fn.el.classList.add("bad");
  }, 900);
  updateParams(); updateEmpty(); requestDraw(); renderTable(); save();
}

/* ---------- empty state with examples ---------- */
const EXAMPLES = [
  { l: "2x + 1", latex: "2x+1" },
  { l: "x² − 4", latex: "x^2-4" },
  { l: "ax² + bx + c", latex: "ax^2+bx+c", p: { a: 1, b: -2, c: -3 } },
  { l: "a·sin(bx)", latex: "a\\sin\\left(bx\\right)", p: { a: 2, b: 1 } },
  { l: "2ˣ", latex: "2^x" },
  { l: "1/x", latex: "\\frac{1}{x}" },
  { l: "|x|", latex: "\\left|x\\right|" },
  { l: "√x", latex: "\\sqrt{x}" },
];
function buildChips() {
  const box = $("chips");
  for (const ex of EXAMPLES) {
    const b = document.createElement("button");
    b.type = "button"; b.textContent = ex.l;
    b.addEventListener("click", () => {
      let fn = state.fns.find((f) => !f.latex.trim()) || addFn("");
      if (ex.p) for (const [k, v] of Object.entries(ex.p)) setParam(k, v);
      fn.latex = ex.latex;
      if (fn.mf.isConnected && fn.mf.mounted !== false) { try { fn.mf.setValue(ex.latex); } catch (e) {} }
      onFnInput(fn);
      resetView();
    });
    box.appendChild(b);
  }
}
function updateEmpty() { $("empty").hidden = state.fns.some((f) => f.latex.trim()); }

/* ---------- sliders ---------- */
let sliderKey = "";
const playing = new Set();
function usedParams() {
  const s = new Set();
  for (const fn of state.fns) if (fn.f && fn.visible) for (const n of fn.params) s.add(n);
  return PARAM_NAMES.filter((n) => s.has(n));
}
function updateParams() {
  const names = usedParams();
  const key = names.join("");
  for (const n of [...playing]) if (!names.includes(n)) playing.delete(n);
  if (key === sliderKey) return;
  sliderKey = key;
  const box = $("params"); box.textContent = "";
  for (const n of names) {
    const p = PARAMS[n];
    const row = document.createElement("div"); row.className = "par";
    const lab = document.createElement("b"); lab.textContent = n;
    const rng = document.createElement("input");
    rng.type = "range"; rng.min = p.min; rng.max = p.max; rng.step = "any"; rng.value = p.v; rng.setAttribute("aria-label", "Value of " + n);
    const num = document.createElement("input");
    num.type = "number"; num.step = "any"; num.value = +p.v.toFixed(2); num.setAttribute("aria-label", "Value of " + n);
    const play = document.createElement("button");
    play.type = "button"; play.textContent = "▶"; play.setAttribute("aria-pressed", "false"); play.setAttribute("aria-label", "Animate " + n);
    const sync = (fromRange) => {
      const q = PARAMS[n];
      rng.min = q.min; rng.max = q.max;
      if (!fromRange) rng.value = q.v;
      if (document.activeElement !== num) num.value = +q.v.toFixed(2);
    };
    row._sync = sync; row._n = n;
    rng.addEventListener("input", () => { setParam(n, parseFloat(rng.value)); sync(true); num.value = +PARAMS[n].v.toFixed(2); onParamChange(); });
    num.addEventListener("input", () => { const v = parseFloat(num.value); if (finite(v)) { setParam(n, v); sync(false); onParamChange(); } });
    play.addEventListener("click", () => {
      if (playing.has(n)) playing.delete(n); else { playing.add(n); dir[n] = dir[n] || 1; }
      play.setAttribute("aria-pressed", String(playing.has(n))); play.textContent = playing.has(n) ? "❚❚" : "▶";
      kick();
    });
    row._play = play;
    row.append(lab, rng, num, play);
    box.appendChild(row);
  }
}
function onParamChange() { requestDraw(); renderTable(); save(); }
const dir = {};
let animId = 0, lastT = 0;
function kick() { if (!animId && playing.size) { lastT = performance.now(); animId = requestAnimationFrame(tick); } }
function tick(t) {
  animId = 0;
  if (!playing.size) return;
  const dt = Math.min(0.05, (t - lastT) / 1000); lastT = t;
  for (const n of playing) {
    const p = PARAMS[n], speed = (p.max - p.min) / 5;
    let v = p.v + (dir[n] || 1) * speed * dt;
    if (v >= p.max) { v = p.max; dir[n] = -1; } else if (v <= p.min) { v = p.min; dir[n] = 1; }
    p.v = v; P[n] = v;
  }
  for (const row of $("params").children) row._sync && row._sync(false);
  requestDraw(); renderTable();
  animId = requestAnimationFrame(tick);
}

/* ---------- canvas ---------- */
const cv = $("cv"), ctx = cv.getContext("2d");
let W = 1, H = 1, dpr = 1, drawQueued = false;

const toPx = (x) => W / 2 + (x - V.cx) * V.s;
const toPy = (y) => H / 2 - (y - V.cy) * V.s;
const toX = (px) => V.cx + (px - W / 2) / V.s;
const toY = (py) => V.cy - (py - H / 2) / V.s;

function resetView() {
  V.cx = 0; V.cy = 0; V.s = Math.max(8, W / 20);
  requestDraw(); save();
}
function resize() {
  const r = cv.getBoundingClientRect();
  const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
  const d = window.devicePixelRatio || 1;
  if (w === W && h === H && d === dpr) return;
  const first = W === 1;
  W = w; H = h; dpr = d;
  cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
  if (first && !restoredView) V.s = Math.max(8, W / 20);
  requestDraw();
}
function requestDraw() { if (!drawQueued) { drawQueued = true; requestAnimationFrame(draw); } }

const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

function tickLabel(v, step) {
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return minus(Number(v.toFixed(Math.min(dec, 8))).toString());
}

function xTicks(xmin, xmax) {
  const wantPi = state.angle === "rad" && state.fns.some((f) => f.f && f.visible && f.trig) && (xmax - xmin) < 60;
  if (wantPi) {
    for (const k of [Math.PI / 4, Math.PI / 2, Math.PI, 2 * Math.PI]) {
      if ((xmax - xmin) / k <= 12) return { step: k, pi: true };
    }
  }
  return { step: niceStep(xmax - xmin, Math.max(3, Math.min(10, W / 70))), pi: false };
}

function halo(text, x, y, bg) {
  ctx.lineWidth = 3; ctx.strokeStyle = bg; ctx.strokeText(text, x, y); ctx.fillText(text, x, y);
}

function drawGrid() {
  const bg = css("--plot-bg"), grid = css("--grid"), grid2 = css("--grid2"), axis = css("--axis"), fg = css("--muted");
  ctx.fillStyle = bg; ctx.fillRect(0, 0, W, H);
  const xmin = toX(0), xmax = toX(W), ymin = toY(H), ymax = toY(0);
  const xt = xTicks(xmin, xmax);
  const ystep = niceStep(ymax - ymin, Math.max(3, Math.min(10, H / 60)));
  const lines = (vmin, vmax, step, vertical, strong) => {
    ctx.strokeStyle = strong ? grid2 : grid; ctx.lineWidth = 1; ctx.beginPath();
    for (let k = Math.ceil(vmin / step); k <= Math.floor(vmax / step); k++) {
      const v = k * step;
      if (vertical) { const px = Math.round(toPx(v)) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, H); }
      else { const py = Math.round(toPy(v)) + 0.5; ctx.moveTo(0, py); ctx.lineTo(W, py); }
    }
    ctx.stroke();
  };
  lines(xmin, xmax, xt.step, true, true);
  lines(ymin, ymax, ystep, false, true);

  const ax = Math.min(W, Math.max(0, toPx(0))), ay = Math.min(H, Math.max(0, toPy(0)));
  ctx.strokeStyle = axis; ctx.lineWidth = 1.6;
  ctx.beginPath(); ctx.moveTo(0, Math.round(ay) + 0.5); ctx.lineTo(W, Math.round(ay) + 0.5); ctx.moveTo(Math.round(ax) + 0.5, 0); ctx.lineTo(Math.round(ax) + 0.5, H); ctx.stroke();

  ctx.font = '12px Roboto, system-ui, sans-serif'; ctx.fillStyle = fg;
  ctx.textAlign = "center"; ctx.textBaseline = "alphabetic";
  let ly = ay + 15; if (ly > H - 4) ly = ay - 6;
  for (let k = Math.ceil(xmin / xt.step); k <= Math.floor(xmax / xt.step); k++) {
    if (k === 0) continue;
    const v = k * xt.step, px = toPx(v);
    if (px < 14 || px > W - 14) continue;
    halo(xt.pi ? niceNumber(v) : tickLabel(v, xt.step), px, ly, bg);
  }
  const left = ax > 40;
  ctx.textAlign = left ? "right" : "left";
  const lx = left ? ax - 6 : ax + 6;
  for (let k = Math.ceil(ymin / ystep); k <= Math.floor(ymax / ystep); k++) {
    if (k === 0) continue;
    const v = k * ystep, py = toPy(v);
    if (py < 10 || py > H - 10) continue;
    halo(tickLabel(v, ystep), lx, py + 4, bg);
  }
  ctx.textAlign = left ? "right" : "left";
  halo("0", left ? ax - 6 : ax + 6, ay + 15 > H - 4 ? ay - 6 : ay + 15, bg);
}

function drawCurve(fn, color) {
  ctx.strokeStyle = color; ctx.lineWidth = 2.6; ctx.lineJoin = "round"; ctx.lineCap = "round";
  ctx.beginPath();
  let pen = false, prev = 0;
  for (let px = -1; px <= W + 1; px += 1) {
    const y = fn.f(toX(px), P);
    let py = finite(y) ? toPy(y) : NaN;
    if (!finite(py)) { pen = false; continue; }
    py = Math.max(-1e6, Math.min(1e6, py));
    if (pen && Math.abs(py - prev) > H * 1.5 && (py - H / 2) * (prev - H / 2) < 0) pen = false;   // jump across a pole
    if (pen) ctx.lineTo(px, py); else ctx.moveTo(px, py);
    pen = true; prev = py;
  }
  ctx.stroke();
}

/* points of interest */
const KIND = { zero: "Zero", max: "Maximum", min: "Minimum", yint: "y-intercept", cross: "Intersection" };
function analyse() {
  const xmin = toX(0), xmax = toX(W), ySpan = H / V.s;
  const list = [];
  const live = state.fns.map((fn, i) => ({ fn, i })).filter(({ fn }) => fn.f && fn.visible);
  const bound = new Map(live.map(({ fn }) => [fn, (x) => fn.f(x, P)]));
  for (const { fn } of live) {
    const g = bound.get(fn);
    const z = zeros(g, xmin, xmax); if (z.length <= 40) for (const x of z) list.push({ kind: "zero", x, y: 0, fn });
    for (const e of extrema(g, xmin, xmax, ySpan).slice(0, 40)) list.push({ kind: e.kind, x: e.x, y: e.y, fn });
    if (xmin < 0 && xmax > 0) {
      const y0 = g(0), dup = list.some((p) => p.fn === fn && Math.abs(p.x) < 1e-7);
      if (finite(y0) && !dup) list.push({ kind: "yint", x: 0, y: y0, fn });
    }
  }
  const asym = { v: [], h: [] };
  const addUnique = (arr, val, tol) => { if (!arr.some((u) => Math.abs(u - val) < tol)) arr.push(val); };
  for (const { fn } of live) {
    const g = bound.get(fn);
    for (const x of verticalAsymptotes(g, xmin, xmax, ySpan)) addUnique(asym.v, x, (xmax - xmin) * 1e-4);
    for (const y of horizontalAsymptotes(g)) addUnique(asym.h, y, ySpan * 1e-4);
  }
  asym.v = asym.v.slice(0, 16); asym.h = asym.h.slice(0, 4);
  state.asym = asym;
  let nCross = 0;
  for (let i = 0; i < live.length; i++) for (let j = i + 1; j < live.length; j++) {
    const fa = bound.get(live[i].fn), fb = bound.get(live[j].fn);
    const pts = intersections(fa, fb, xmin, xmax);
    if (pts.length > 40) continue;
    for (const p of pts) { if (nCross++ < 40) list.push({ kind: "cross", x: p.x, y: p.y, fn: live[i].fn, fn2: live[j].fn }); }
  }
  return list;
}

function drawPois() {
  const bg = css("--plot-bg"), fg = css("--fg");
  const r = state.pois.length > 14 ? 3.6 : 5.5;
  for (const p of state.pois) {
    const px = toPx(p.x), py = toPy(p.y);
    if (px < -10 || px > W + 10 || py < -10 || py > H + 10) continue;
    const col = colorOf(p.fn);
    ctx.beginPath();
    if (p.kind === "cross") { ctx.arc(px, py, r, 0, 7); ctx.fillStyle = bg; ctx.fill(); ctx.lineWidth = 2.4; ctx.strokeStyle = fg; ctx.stroke(); }
    else if (p.kind === "zero" || p.kind === "yint") { ctx.arc(px, py, r, 0, 7); ctx.fillStyle = bg; ctx.fill(); ctx.lineWidth = 2.4; ctx.strokeStyle = col; ctx.stroke(); }
    else { ctx.arc(px, py, r, 0, 7); ctx.fillStyle = col; ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = bg; ctx.stroke(); }
  }
}

function drawAsymptotes() {
  const { v, h } = state.asym;
  if (!v.length && !h.length) return;
  const col = css("--asym"), bg = css("--plot-bg");
  ctx.save();
  ctx.strokeStyle = col; ctx.lineWidth = 1.8; ctx.setLineDash([8, 6]); ctx.lineCap = "butt";
  ctx.beginPath();
  for (const x of v) { const px = Math.round(toPx(x)) + 0.5; ctx.moveTo(px, 0); ctx.lineTo(px, H); }
  for (const y of h) { const py = Math.round(toPy(y)) + 0.5; if (py > -2 && py < H + 2) { ctx.moveTo(0, py); ctx.lineTo(W, py); } }
  ctx.stroke(); ctx.setLineDash([]);
  ctx.font = "600 12px Roboto, system-ui, sans-serif"; ctx.fillStyle = col; ctx.textBaseline = "alphabetic";
  if (v.length <= 5) { ctx.textAlign = "left"; for (const x of v) halo("x = " + niceNumber(x), toPx(x) + 5, 16, bg); }
  ctx.textAlign = "right";
  for (const y of h) { const py = toPy(y); if (py > 14 && py < H - 4) halo("y = " + niceNumber(y), W - 56, py - 5, bg); }
  ctx.restore();
}

function drawMarked() {
  if (state.marked == null) return;
  const px = toPx(state.marked);
  ctx.save(); ctx.setLineDash([4, 4]); ctx.strokeStyle = css("--axis"); ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(Math.round(px) + 0.5, 0); ctx.lineTo(Math.round(px) + 0.5, H); ctx.stroke(); ctx.restore();
  for (const fn of state.fns) {
    if (!fn.f || !fn.visible) continue;
    const y = fn.f(state.marked, P); if (!finite(y)) continue;
    const py = toPy(y); if (py < -5 || py > H + 5) continue;
    ctx.beginPath(); ctx.arc(px, py, 5, 0, 7); ctx.fillStyle = colorOf(fn); ctx.fill(); ctx.lineWidth = 2; ctx.strokeStyle = css("--plot-bg"); ctx.stroke();
  }
}

function drawTrace() {
  const t = state.trace; if (!t) return;
  ctx.beginPath(); ctx.arc(t.px, t.py, 6.5, 0, 7); ctx.fillStyle = css("--plot-bg"); ctx.fill();
  ctx.lineWidth = 3; ctx.strokeStyle = t.color; ctx.stroke();
}

function draw() {
  drawQueued = false;
  if (W <= 1) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  drawGrid();
  ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, H); ctx.clip();
  state.pois = analyse();
  drawAsymptotes();
  for (const fn of state.fns) if (fn.f && fn.visible) drawCurve(fn, colorOf(fn));
  drawMarked(); drawPois(); drawTrace();
  ctx.restore();
  updateTip();
}

/* ---------- tooltip / trace ---------- */
const tip = $("tip");
let pinned = false;
function updateTip() {
  const t = state.trace;
  if (!t) { tip.hidden = true; return; }
  // re-resolve the trace so it follows the curve while a slider moves
  tip.hidden = false;
  tip.innerHTML = t.html;
  tip.style.borderLeftColor = t.color;
  tip.style.left = Math.max(70, Math.min(W - 70, t.px)) + "px";
  tip.style.top = Math.max(40, t.py) + "px";
}
function traceAt(px, py) {
  // 1. nearest point of interest
  let best = null, bd = 18;
  for (const p of state.pois) {
    const d = Math.hypot(toPx(p.x) - px, toPy(p.y) - py);
    if (d < bd) { bd = d; best = p; }
  }
  if (best) {
    const xs = niceNumber(best.x), ys = niceNumber(best.y);
    state.trace = { px: toPx(best.x), py: toPy(best.y), color: colorOf(best.fn),
      html: `<small>${KIND[best.kind]}</small>(${xs}, ${ys})` };
    return requestDraw();
  }
  // 2. nearest curve
  const x = toX(px); let bf = null, bdy = 40;
  for (const fn of state.fns) {
    if (!fn.f || !fn.visible) continue;
    const y = fn.f(x, P); if (!finite(y)) continue;
    const dy = Math.abs(toPy(y) - py);
    if (dy < bdy) { bdy = dy; bf = { fn, y }; }
  }
  if (bf) {
    const i = state.fns.indexOf(bf.fn);
    state.trace = { px, py: toPy(bf.y), color: colorOf(bf.fn),
      html: `<small>${NAMES[i] || "f"}(x)</small>(${fmtValue(x, 4)}, ${fmtValue(bf.y, 4)})` };
  } else state.trace = null;
  requestDraw();
}

/* ---------- pointer interaction ---------- */
const ptrs = new Map();
let gesture = null;
const rectPos = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
function zoomAt(px, py, f) {
  const wx = toX(px), wy = toY(py);
  V.s = Math.max(0.02, Math.min(1e6, V.s * f));
  V.cx = wx - (px - W / 2) / V.s; V.cy = wy + (py - H / 2) / V.s;
  requestDraw();
}
cv.addEventListener("pointerdown", (e) => {
  cv.setPointerCapture(e.pointerId);
  const p = rectPos(e); ptrs.set(e.pointerId, p);
  gesture = { moved: ptrs.size > 1, sx: p.x, sy: p.y };
  if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; gesture.d = Math.hypot(a.x - b.x, a.y - b.y); gesture.mx = (a.x + b.x) / 2; gesture.my = (a.y + b.y) / 2; }
});
cv.addEventListener("pointermove", (e) => {
  const p = rectPos(e);
  if (!ptrs.has(e.pointerId)) { if (e.pointerType === "mouse" && !pinned) traceAt(p.x, p.y); return; }
  const prev = ptrs.get(e.pointerId); ptrs.set(e.pointerId, p);
  if (ptrs.size === 1) {
    if (!gesture.moved && Math.hypot(p.x - gesture.sx, p.y - gesture.sy) < 5) return;
    gesture.moved = true; cv.classList.add("dragging"); pinned = false; state.trace = null;
    V.cx -= (p.x - prev.x) / V.s; V.cy += (p.y - prev.y) / V.s; requestDraw();
  } else if (ptrs.size === 2) {
    gesture.moved = true; state.trace = null;
    const [a, b] = [...ptrs.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    if (gesture.d > 0) {
      const wx = toX(gesture.mx), wy = toY(gesture.my);
      V.s = Math.max(0.02, Math.min(1e6, V.s * d / gesture.d));
      V.cx = wx - (mx - W / 2) / V.s; V.cy = wy + (my - H / 2) / V.s;
    }
    gesture.d = d; gesture.mx = mx; gesture.my = my; requestDraw();
  }
});
function endPtr(e) {
  if (!ptrs.has(e.pointerId)) return;
  const wasSingle = ptrs.size === 1;
  ptrs.delete(e.pointerId); cv.classList.remove("dragging");
  if (wasSingle && gesture && !gesture.moved && e.type === "pointerup") {
    pinned = true; const p = rectPos(e); traceAt(p.x, p.y);
    if (!state.trace) pinned = false;
  }
  if (gesture && ptrs.size === 1) { const [p] = [...ptrs.values()]; gesture.sx = p.x; gesture.sy = p.y; gesture.moved = true; }
  if (ptrs.size === 0) { save(); }
}
cv.addEventListener("pointerup", endPtr);
cv.addEventListener("pointercancel", endPtr);
cv.addEventListener("pointerleave", (e) => { if (e.pointerType === "mouse" && !pinned && !ptrs.size) { state.trace = null; requestDraw(); } });
cv.addEventListener("wheel", (e) => {
  e.preventDefault();
  const p = rectPos(e); zoomAt(p.x, p.y, Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0016)));
  state.trace = null; pinned = false; clearTimeout(wheelT); wheelT = setTimeout(save, 400);
}, { passive: false });
let wheelT = 0;
cv.addEventListener("dblclick", (e) => { const p = rectPos(e); zoomAt(p.x, p.y, 2); state.trace = null; save(); });
cv.tabIndex = 0;
cv.addEventListener("keydown", (e) => {
  const k = e.key, step = 40 / V.s;
  if (k === "ArrowLeft") V.cx -= step; else if (k === "ArrowRight") V.cx += step;
  else if (k === "ArrowUp") V.cy += step; else if (k === "ArrowDown") V.cy -= step;
  else if (k === "+" || k === "=") zoomAt(W / 2, H / 2, 1.25); else if (k === "-") zoomAt(W / 2, H / 2, 0.8);
  else if (k === "0" || k === "Home") resetView(); else return;
  e.preventDefault(); requestDraw();
});
$("zin").addEventListener("click", () => { zoomAt(W / 2, H / 2, 1.5); state.trace = null; save(); });
$("zout").addEventListener("click", () => { zoomAt(W / 2, H / 2, 1 / 1.5); state.trace = null; save(); });
$("zhome").addEventListener("click", () => { state.trace = null; resetView(); });

/* ---------- angle unit ---------- */
const angleBtn = $("angleBtn");
function paintAngle() {
  const rad = state.angle === "rad";
  angleBtn.innerHTML = `<span class="${rad ? "on" : ""}">RAD</span><span class="${rad ? "" : "on"}">DEG</span>`;
  angleBtn.setAttribute("aria-label", `Angle unit: ${rad ? "radians" : "degrees"}. Tap to switch.`);
  angleBtn.title = "Angle unit for sin, cos, tan: tap to switch";
}
angleBtn.addEventListener("click", () => {
  state.angle = state.angle === "rad" ? "deg" : "rad"; paintAngle();
  for (const fn of state.fns) compileFn(fn);
  state.trace = null; requestDraw(); renderTable(); save();
});

/* ---------- table ---------- */
const tFrom = $("tFrom"), tStep = $("tStep");
tFrom.value = "-5"; tStep.value = "1";
function renderTable() {
  if (state.tab !== "tbl") return;
  const t = $("tbl");
  const from = parseFloat(tFrom.value), step = parseFloat(tStep.value);
  const cols = state.fns.map((fn, i) => ({ fn, i })).filter(({ fn }) => fn.f && fn.visible);
  if (!finite(from) || !(step > 0)) { t.innerHTML = ""; return; }
  let html = "<thead><tr><th>x</th>" + cols.map(({ fn, i }) => `<th style="--col:${colorOf(fn)}"><span></span>${NAMES[i] || "f"}(x)</th>`).join("") + "</tr></thead><tbody>";
  for (let r = 0; r < 60; r++) {
    const x = Math.round((from + r * step) * 1e10) / 1e10;
    html += `<tr data-x="${x}" class="${state.marked === x ? "on" : ""}"><td>${fmtValue(x)}</td>` + cols.map(({ fn }) => `<td>${fmtValue(fn.f(x, P))}</td>`).join("") + "</tr>";
  }
  t.innerHTML = html + "</tbody>";
}
$("tbl").addEventListener("click", (e) => {
  const tr = e.target.closest("tr[data-x]"); if (!tr) return;
  const x = parseFloat(tr.dataset.x);
  state.marked = state.marked === x ? null : x;
  for (const r of $("tbl").querySelectorAll("tr.on")) r.classList.remove("on");
  if (state.marked != null) tr.classList.add("on");
  requestDraw();
});
for (const el of [tFrom, tStep]) el.addEventListener("input", () => { state.marked = null; renderTable(); save(); });

/* ---------- tabs ---------- */
function setTab(t) {
  state.tab = t;
  $("tabFn").setAttribute("aria-selected", String(t === "fn")); $("tabTbl").setAttribute("aria-selected", String(t === "tbl"));
  $("panelFn").hidden = t !== "fn"; $("panelTbl").hidden = t !== "tbl";
  if (t !== "tbl") { state.marked = null; requestDraw(); }
  paintKeys(); renderTable();
}
$("tabFn").addEventListener("click", () => setTab("fn"));
$("tabTbl").addEventListener("click", () => setTab("tbl"));
$("addFn").addEventListener("click", () => { addFn("", { focus: true }); updateEmpty(); save(); });

/* ---------- keypad ---------- */
const FRAC = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><rect x="7.5" y="2.5" width="9" height="6.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 12h17" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="7.5" y="15" width="9" height="6.5" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const SQRT = '<svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true"><path d="M2.5 12.5l3.2-1.6 3.6 8.1 6-15.5h6.2" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const num = (d) => ({ l: d, ins: d, c: "" });
const LAYERS = [
  { id: "123", label: "123", keys: [
    { l: "<i>x</i>", ins: "x", c: "hero", aria: "x" }, num("7"), num("8"), num("9"), { l: "÷", ins: "\\div ", c: "op", aria: "Divide" }, { l: "⌫", cmd: "deleteBackward", c: "ctl", aria: "Delete" },
    { l: "<i>x</i><sup>2</sup>", ins: "#@^{2}", c: "fn", aria: "Square" }, num("4"), num("5"), num("6"), { l: "×", ins: "\\times ", c: "op", aria: "Multiply" }, { l: "◀", cmd: "moveToPreviousChar", c: "ctl", aria: "Move left" },
    { l: "<i>x</i><sup>n</sup>", ins: "#@^{#?}", c: "fn", aria: "Power" }, num("1"), num("2"), num("3"), { l: "−", ins: "-", c: "op", aria: "Subtract" }, { l: "▶", cmd: "moveToNextChar", c: "ctl", aria: "Move right" },
    { l: FRAC, ins: "\\frac{#@}{#?}", c: "fn", aria: "Fraction" }, num("0"), { l: ".", ins: ".", c: "", aria: "Decimal point" }, { l: "( )", ins: "\\left(#?\\right)", c: "fn", aria: "Brackets" }, { l: "+", ins: "+", c: "op", aria: "Add" }, { l: SQRT, ins: "\\sqrt{#?}", c: "fn", aria: "Square root" },
  ] },
  { id: "fx", label: "ƒ", keys: [
    { l: "sin", ins: "\\sin\\left(#?\\right)", c: "fn" }, { l: "cos", ins: "\\cos\\left(#?\\right)", c: "fn" }, { l: "tan", ins: "\\tan\\left(#?\\right)", c: "fn" },
    { l: "ln", ins: "\\ln\\left(#?\\right)", c: "fn", aria: "Natural logarithm" }, { l: "log", ins: "\\log\\left(#?\\right)", c: "fn", aria: "Logarithm base 10" }, { l: "|<i>x</i>|", ins: "\\left|#?\\right|", c: "fn", aria: "Absolute value" },
    { l: "sin<sup>−1</sup>", ins: "\\sin^{-1}\\left(#?\\right)", c: "fn", aria: "Inverse sine" }, { l: "cos<sup>−1</sup>", ins: "\\cos^{-1}\\left(#?\\right)", c: "fn", aria: "Inverse cosine" }, { l: "tan<sup>−1</sup>", ins: "\\tan^{-1}\\left(#?\\right)", c: "fn", aria: "Inverse tangent" },
    { l: "e<sup>x</sup>", ins: "\\exponentialE^{#?}", c: "fn", aria: "e to the power" }, { l: "10<sup>x</sup>", ins: "10^{#?}", c: "fn", aria: "Ten to the power" }, { l: "<sup>n</sup>√", ins: "\\sqrt[#?]{#?}", c: "fn", aria: "Nth root" },
    { l: "π", ins: "\\pi", c: "fn", aria: "Pi" }, { l: "e", ins: "\\exponentialE", c: "fn", aria: "Euler's number" }, { l: "log<sub>n</sub>", ins: "\\log_{#?}\\left(#?\\right)", c: "fn", aria: "Logarithm with base" },
    { l: "( )", ins: "\\left(#?\\right)", c: "fn", aria: "Brackets" }, { l: "◀", cmd: "moveToPreviousChar", c: "ctl", aria: "Move left" }, { l: "⌫", cmd: "deleteBackward", c: "ctl", aria: "Delete" },
  ] },
  { id: "abc", label: "a b c", keys: [
    ...["a", "b", "c", "d", "k", "m"].map((s) => ({ l: `<i>${s}</i>`, ins: s, c: "hero", aria: "Parameter " + s })),
    { l: "<i>x</i>", ins: "x", c: "fn", aria: "x" }, { l: "π", ins: "\\pi", c: "fn" }, { l: "e", ins: "\\exponentialE", c: "fn" }, { l: "( )", ins: "\\left(#?\\right)", c: "fn", aria: "Brackets" }, { l: "◀", cmd: "moveToPreviousChar", c: "ctl", aria: "Move left" }, { l: "⌫", cmd: "deleteBackward", c: "ctl", aria: "Delete" },
  ] },
];
let layer = 0;
function press(k) {
  let fn = active && state.fns.includes(active) ? active : state.fns[state.fns.length - 1] || addFn("");
  const mf = fn.mf;
  if (k.cmd) mf.executeCommand(k.cmd);
  else mf.insert(k.ins, { focus: true, selectionMode: "placeholder" });
  if (!coarse) mf.focus({ preventScroll: true });
  onFnInput(fn);
}
function buildKeys() {
  const tabs = $("ktabs");
  LAYERS.forEach((L, i) => {
    const b = document.createElement("button");
    b.type = "button"; b.setAttribute("role", "tab"); b.textContent = L.label;
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", () => { layer = i; paintKeys(); });
    tabs.appendChild(b);
  });
}
function paintKeys() {
  const showKeys = state.kb && state.tab === "fn";
  $("keys").hidden = !showKeys;
  $("gr").classList.toggle("kb-on", showKeys);
  $("kbToggle").setAttribute("aria-pressed", String(state.kb));
  $("kbToggle").setAttribute("aria-label", state.kb ? "Hide keypad" : "Show keypad");
  if (!showKeys) return;
  [...$("ktabs").children].forEach((b, i) => b.setAttribute("aria-selected", String(i === layer)));
  const pad = $("kpad"); pad.textContent = "";
  for (const k of LAYERS[layer].keys) {
    const b = document.createElement("button");
    b.type = "button"; b.className = "k " + (k.c || ""); b.innerHTML = k.l;
    b.setAttribute("aria-label", k.aria || k.l.replace(/<[^>]+>/g, ""));
    b.addEventListener("pointerdown", (e) => e.preventDefault());
    b.addEventListener("click", () => press(k));
    pad.appendChild(b);
  }
  requestAnimationFrame(resize);
}
$("kbToggle").addEventListener("click", () => { state.kb = !state.kb; paintKeys(); save(); });

/* ---------- persistence ---------- */
let saveT = 0, restoredView = false;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    store.set("graph-v1", JSON.stringify({
      fns: state.fns.map((f) => ({ latex: f.latex, visible: f.visible, ci: f.ci })),
      params: PARAMS, view: V, angle: state.angle, kb: state.kb,
    }));
  }, 300);
}
function restore() {
  let d = null;
  try { d = JSON.parse(store.get("graph-v1") || "null"); } catch (e) {}
  if (!d || !Array.isArray(d.fns)) return false;
  if (d.angle === "deg") state.angle = "deg";
  if (typeof d.kb === "boolean" && !coarse) state.kb = d.kb;
  for (const [k, p] of Object.entries(d.params || {})) {
    if (PARAM_NAMES.includes(k) && p && finite(p.v) && finite(p.min) && finite(p.max)) { PARAMS[k] = { v: p.v, min: p.min, max: p.max }; P[k] = p.v; }
  }
  if (d.view && finite(d.view.cx) && finite(d.view.cy) && d.view.s > 0.01 && d.view.s < 1e6) { Object.assign(V, d.view); restoredView = true; }
  for (const f of d.fns.slice(0, 6)) {
    const fn = addFn(String(f.latex || ""), { visible: f.visible !== false });
    if (Number.isInteger(f.ci)) fn.ci = Math.abs(f.ci) % 6;
    fn.visEl.setAttribute("aria-pressed", String(fn.visible));
  }
  return state.fns.length > 0;
}

/* ---------- start ---------- */
buildKeys(); buildChips();
if (!restore()) addFn("", { focus: true });
paintAngle(); renameAll(); updateParams(); updateEmpty(); paintKeys();
new ResizeObserver(resize).observe($("plot"));
new MutationObserver(() => { state.fns.forEach(paintCardColor); requestDraw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-mode"] });
resize();
window.__graph = { state, V, P, PARAMS, setTab, resetView };   // for tests
