// Mosaicus — pagina Elaborazione.
//
// Ogni tratto salvato dalla pagina Misura diventa un "riquadro": i suoi dati, un grafico
// con gli assi a scelta, gli strumenti per lavorarci sopra (retta a mano agganciata ai
// dati, tangente, fit), le analisi salvate e le colonne calcolate con una formula.
// Una casella di spunta decide quali riquadri finiscono nel file Excel esportato.

import { Chart, ChartGroup } from './chart.js';
import { MODELS, MODEL_ORDER, runModel, runsTest } from './fits.js';
import { polyfit, formatMeasure, fmt } from './analysis.js';
import { compile } from './formula.js';
import { QUANTITIES } from './experiments.js';
import { saveBox, deleteBox, listBoxes } from './storage.js';
import { toXLSX, download } from './export.js';

const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v, d = 3) => (isFinite(v) ? v.toLocaleString('it-IT', { maximumFractionDigits: d }) : '—');
const n4 = (v) => fmt(v, 4);
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let boxes = [];        // riquadri caricati
const views = new Map(); // id → stato grafico del riquadro
let toastFn = () => {};
let onChange = () => {};

// ---------------------------------------------------------------------------
// Unità e significati
// ---------------------------------------------------------------------------
function slopeUnit(yU, xU) {
  if (!xU) return yU;
  if (xU === 's') {
    if (!yU) return 's⁻¹';
    if (yU.endsWith('/s²')) return yU.replace('/s²', '/s³');
    if (yU.endsWith('/s')) return `${yU}²`;
    return `${yU}/s`;
  }
  return `${yU || '1'}/${xU}`;
}
const colInfo = (box, key) => box.columns.find((c) => c.key === key) || box.computed.find((c) => c.key === key) || { key, sym: key, unit: '' };
const axisLabel = (c) => (c.unit ? `${c.sym} (${c.unit})` : c.sym);
function slopeMeaning(box) {
  if (box.xKey !== 't') return null;
  const q = QUANTITIES[box.yKey];
  return q?.slope || null;
}

// ---------------------------------------------------------------------------
// Dati del riquadro (colonne base + calcolate)
// ---------------------------------------------------------------------------
function computeRows(box) {
  const rows = box.rows.map((r) => ({ ...r }));
  const avail = box.columns.map((c) => c.key);
  for (const c of box.computed) {
    try {
      const { fn } = compile(c.formula, avail);
      for (const r of rows) r[c.key] = fn(r);
      c.error = null;
    } catch (e) { c.error = e.message; for (const r of rows) r[c.key] = NaN; }
    avail.push(c.key);
  }
  return rows;
}

// ---------------------------------------------------------------------------
// Ciclo di vita
// ---------------------------------------------------------------------------
export async function initWorkbench({ toast, onCount }) {
  toastFn = toast; onChange = onCount;
  try { boxes = await listBoxes(); } catch { boxes = []; }
  render();
  $('#wbExport').addEventListener('click', exportChecked);
  $('#wbAll').addEventListener('click', () => { const all = boxes.every((b) => b.checked); boxes.forEach((b) => { b.checked = !all; persist(b); }); render(); });
  onChange(boxes.length);
}

export function boxesForSession(sessionId) { return boxes.filter((b) => b.sessionId === sessionId); }

export async function addBox(data) {
  const box = {
    created: Date.now(), checked: true, computed: [], analyses: [], xKey: 't', ...data,
  };
  box.id = await saveBox(box);
  boxes.push(box);
  render();
  onChange(boxes.length);
  return box;
}

export function focusBox(id) {
  const el = document.querySelector(`.box[data-id="${id}"]`);
  if (el) { el.scrollIntoView({ behavior: 'smooth', block: 'start' }); el.classList.add('flash'); setTimeout(() => el.classList.remove('flash'), 1200); }
}

export function refreshStyle() { for (const v of views.values()) v.group.refreshStyle(); }

let saveTimers = new Map();
function persist(box) {
  clearTimeout(saveTimers.get(box.id));
  saveTimers.set(box.id, setTimeout(() => {
    const clean = { ...box, computed: box.computed.map(({ error, ...c }) => c) };
    saveBox(clean).catch((e) => toastFn(`Salvataggio non riuscito: ${e.message}`));
  }, 250));
}

// ---------------------------------------------------------------------------
// Disegno della pagina
// ---------------------------------------------------------------------------
function render() {
  for (const v of views.values()) v.group.clear();
  views.clear();
  const list = $('#wbList');
  const nChecked = boxes.filter((b) => b.checked).length;
  $('#wbExport').textContent = `Esporta in Excel i riquadri spuntati (${nChecked})`;
  $('#wbExport').disabled = !nChecked;
  $('#wbAll').textContent = boxes.length && boxes.every((b) => b.checked) ? 'Togli tutte le spunte' : 'Spunta tutti';
  if (!boxes.length) {
    list.innerHTML = `<div class="card empty"><h3>Qui arrivano i tratti che salvi</h3>
      <p>In <b>Misura</b>: trascina su un grafico → <b>Invia il tratto a Elaborazione →</b></p></div>`;
    return;
  }
  list.innerHTML = '';
  for (const box of boxes) list.appendChild(renderBox(box));
}

function renderBox(box) {
  const el = document.createElement('section');
  el.className = 'card box'; el.dataset.id = box.id;
  // negli assi solo grandezze fisiche: i dati tecnici del sensore (eco, ADC…) restano fuori, anche nei riquadri vecchi
  const cols = [...box.columns.filter((c) => !QUANTITIES[c.key]?.raw || c.key === box.xKey || c.key === box.yKey), ...box.computed];
  const opt = (sel) => cols.map((c) => `<option value="${esc(c.key)}"${c.key === sel ? ' selected' : ''}>${esc(axisLabel(c))}</option>`).join('');
  el.innerHTML = `
    <header class="box-head">
      <label class="box-check" title="Includi questo riquadro nell'export"><input type="checkbox" ${box.checked ? 'checked' : ''}><span>Esporta</span></label>
      <div class="box-title">
        <input class="box-name" value="${esc(box.title)}" aria-label="Nome del riquadro">
        <small>${esc(box.expTitle)}${box.sessionName ? ` · da «${esc(box.sessionName)}»` : ''} · ${num(box.t1, 2)}–${num(box.t2, 2)} ${esc(box.tUnit || 's')} · ${box.rows.length} punti</small>
        ${box.subtitle ? `<small class="box-sub">${esc(box.subtitle)}</small>` : ''}
      </div>
      <button class="btn btn-small btn-ghost box-del" title="Elimina il riquadro">Elimina</button>
    </header>
    <div class="box-bar">
      <label class="axis"><span class="long">asse orizzontale</span><span class="short">x</span> <select class="sx">${opt(box.xKey)}</select></label>
      <label class="axis"><span class="long">asse verticale</span><span class="short">y</span> <select class="sy">${opt(box.yKey)}</select></label>
      <div class="tools" role="group" aria-label="Strumenti">
        <button class="btn btn-small tool" data-tool="select" title="Trascina sul grafico per scegliere il tratto da analizzare">⇔ <span class="long">Seleziona </span>tratto</button>
        <button class="btn btn-small tool" data-tool="line" title="Tira tu la retta che media i punti, poi misurane la pendenza">／ Retta<span class="long"> a occhio</span></button>
        <button class="btn btn-small tool" data-tool="tangent" title="Scegli un punto misurato: tangente alla curva in quel punto">⌒ Tangente</button>
        <button class="btn btn-small tool" data-tool="fit" title="Retta o curva dei minimi quadrati">∿ Fit</button>
        <button class="btn btn-small tool" data-tool="ruler" title="Due cursori verticali: periodo e frequenza">📏 Righello</button>
      </div>
      <button class="btn btn-small btn-ghost zoomfit">Adatta</button>
    </div>
    <div class="box-body">
      <div class="box-chart"><canvas aria-label="Grafico del riquadro"></canvas></div>
      <aside class="box-side">
        <div class="tool-panel"></div>
        <div class="saved"></div>
      </aside>
    </div>
    <details class="box-data">
      <summary><span>Foglio dei dati</span></summary>
      <p class="hint"><b>x</b> / <b>y</b> nell'intestazione → asse del grafico · <b>＋ Nuova colonna</b> → formula (es. <code>x^2</code>, <code>ln(T − 21)</code>)</p>
      <div class="sheet-wrap"></div>
    </details>`;

  // --- intestazione
  $('.box-check input', el).addEventListener('change', (e) => { box.checked = e.target.checked; persist(box); updateHeaderCount(); });
  $('.box-name', el).addEventListener('change', (e) => { box.title = e.target.value.trim() || box.title; persist(box); });
  $('.box-del', el).addEventListener('click', async () => {
    if (!confirm(`Eliminare il riquadro «${box.title}»? I dati della misura originale restano nel Quaderno.`)) return;
    await deleteBox(box.id);
    boxes = boxes.filter((b) => b !== box);
    render(); onChange(boxes.length);
  });

  // --- grafico
  const group = new ChartGroup({ includeZero: false, onSelect: (sel) => { v.selection = sel; if (v.tool === 'fit' && v.fitModel) runFitTool(box, v, v.fitModel); } });
  const chart = group.add(new Chart($('canvas', el), { compact: false }));
  const v = { el, group, chart, tool: 'select', selection: null, eye: null, tangent: null, fitModel: null, current: null, pending: null };
  views.set(box.id, v);
  el.__mz = { box, v };   // aggancio per le prove automatiche e la registrazione dei video della guida

  $('.sx', el).addEventListener('change', (e) => setAxis(box, v, 'x', e.target.value));
  $('.sy', el).addEventListener('change', (e) => setAxis(box, v, 'y', e.target.value));
  $('.zoomfit', el).addEventListener('click', () => group.fitAll());
  el.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => setTool(box, v, b.dataset.tool)));

  chart.onPick = (i) => onPick(box, v, i);
  chart.onAnchorMove = (id, i) => onAnchorMove(box, v, id, i);

  // --- foglio dei dati
  $('.box-data', el).addEventListener('toggle', () => { if ($('.box-data', el).open) renderSheet(box, v); });

  setTool(box, v, box.wave ? 'ruler' : 'select');
  renderSaved(box, v);
  return el;
}

function updateHeaderCount() {
  const nChecked = boxes.filter((b) => b.checked).length;
  $('#wbExport').textContent = `Esporta in Excel i riquadri spuntati (${nChecked})`;
  $('#wbExport').disabled = !nChecked;
}

// ---------------------------------------------------------------------------
// Grafico del riquadro
// ---------------------------------------------------------------------------
function seriesOf(box) {
  const rows = computeRows(box);
  const x = rows.map((r) => r[box.xKey]), y = rows.map((r) => r[box.yKey]);
  return { rows, x, y };
}

function drawBox(box, v) {
  const { x, y } = seriesOf(box);
  v.data = { x, y };
  const cx = colInfo(box, box.xKey), cy = colInfo(box, box.yKey);
  v.chart.xSym = cx.sym;
  v.chart.setData({ series: [{ x, y, label: cy.sym, mode: box.wave && box.xKey === box.columns[0].key ? 'line' : 'points', width: 1.8 }], xLabel: axisLabel(cx), yLabel: axisLabel(cy) });
  v.chart.setOverlays([...savedOverlays(box), ...(v.current?.overlays || [])]);
}

function savedOverlays(box) {
  const out = [];
  const ink = css('--green');
  for (const a of box.analyses) {
    if (a.xKey !== box.xKey || a.yKey !== box.yKey || a.hidden) continue;
    if (a.kind === 'fit' && a.curve) out.push({ type: 'curve', x: a.curve.x, y: a.curve.y, color: css('--rosa'), width: 2, dash: [6, 4] });
    if (a.kind === 'ruler' && a.span) out.push({ type: 'span', ...a.span, color: css('--muted'), label: a.spanLabel });
    if ((a.kind === 'line' || a.kind === 'tangent') && a.seg) out.push({ type: 'segment', ...a.seg, extend: a.kind === 'line', color: ink, width: 1.6, dash: [6, 4] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Strumenti
// ---------------------------------------------------------------------------
const TOOL_HELP = {
  select: '<p class="say">Trascina sul grafico per scegliere un tratto.</p>',
  line: '',
  tangent: '<p class="say">Tocca un punto della curva.</p>',
  fit: '<p class="say">Scegli un modello.</p>',
  ruler: '',
};

function setTool(box, v, tool) {
  v.tool = tool;
  v.el.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === tool));
  v.chart.tool = tool === 'line' || tool === 'tangent' || tool === 'ruler' ? 'pick' : 'select';
  v.chart.c.style.cursor = v.chart.tool === 'pick' ? 'pointer' : 'crosshair';
  v.chart.onClickXY = null; v.chart.onAnchorDrag = null;
  resetTool(box, v, false);
  const panel = $('.tool-panel', v.el);
  panel.innerHTML = TOOL_HELP[tool];
  if (tool === 'fit') renderFitMenu(box, v);
  drawBox(box, v);
  if (tool === 'line') { initEye(box, v); renderEye(box, v); }
  if (tool === 'ruler') { initRuler(box, v); renderRuler(box, v); }
}

function resetTool(box, v, redraw = true) {
  v.eye = null; v.tangent = null; v.current = null; v.fitModel = v.tool === 'fit' ? v.fitModel : null;
  if (redraw) setTool(box, v, v.tool);
}

function onPick(box, v, i) {
  if (v.tool === 'tangent') { v.tangent = i; updateTangent(box, v); }
}
function onAnchorMove(box, v, id, i) {
  if (v.tool === 'tangent') { v.tangent = i; updateTangent(box, v); }
}

// ----- retta a occhio -----
// 1) lo studente trascina due maniglie finché la retta "media" la nuvola di punti;
// 2) sceglie due punti SULLA retta (agganciati alla griglia, come su carta millimetrata)
//    e legge Δy/Δx; poi, se vuole, confronta con la retta calcolata dal computer.
const lineThrough = (a, b) => { const m = (b.y - a.y) / (b.x - a.x); return { m, q: a.y - m * a.x, at: (x) => a.y + m * (x - a.x) }; };
const read3 = (v) => (isFinite(v) && v !== 0 ? +v.toPrecision(3) : v);

function initEye(box, v) {
  const { x, y } = v.data;
  const xs = x.filter(isFinite), ys = y.filter(isFinite);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const ym = ys.reduce((s, q) => s + q, 0) / (ys.length || 1);
  v.eye = { step: 1, h1: { x: x0 + 0.2 * (x1 - x0), y: ym }, h2: { x: x0 + 0.8 * (x1 - x0), y: ym }, pts: [], cmp: null };
}

function eyeOverlays(box, v) {
  const e = v.eye, green = css('--green'), rosa = css('--rosa-d');
  const ov = [{ type: 'segment', x1: e.h1.x, y1: e.h1.y, x2: e.h2.x, y2: e.h2.y, extend: true, color: green, width: 2.6 }];
  if (e.step === 1) ov.push({ type: 'anchor', handle: true, free: true, id: 'h1', x: e.h1.x, y: e.h1.y, color: green }, { type: 'anchor', handle: true, free: true, id: 'h2', x: e.h2.x, y: e.h2.y, color: green });
  if (e.cmp) ov.push({ type: 'segment', x1: e.cmp.x1, y1: e.cmp.y1, x2: e.cmp.x2, y2: e.cmp.y2, extend: true, color: css('--rosa'), width: 2, dash: [2, 3] });
  if (e.step === 2) {
    e.pts.forEach((p, i) => ov.push({ type: 'anchor', x: p.x, y: p.y, label: i ? 'B' : 'A', color: rosa }));
    if (e.pts.length === 2) {
      const [A, B] = e.pts, cx = colInfo(box, box.xKey), cy = colInfo(box, box.yKey);
      ov.push({ type: 'triangle', x1: A.x, y1: A.y, x2: B.x, y2: B.y, color: rosa, dxLabel: `Δ${cx.sym} = ${num(B.x - A.x)} ${cx.unit}`, dyLabel: `Δ${cy.sym} = ${num(read3(B.y) - read3(A.y))} ${cy.unit}` });
    }
  }
  return ov;
}

function eyeDrag(box, v, id, x, y) {
  const e = v.eye;
  const other = id === 'h1' ? e.h2 : e.h1;
  if (Math.abs(x - other.x) < 1e-9) return;
  e[id] = { x, y };
  renderEye(box, v);
}

function eyeClick(box, v, x) {
  const e = v.eye;
  if (e.step !== 2) return;
  // aggancio alla griglia: l'ascissa si arrotonda alla mezza divisione più vicina
  const st = v.chart.gridSteps().x / 2;
  const xs = Math.round(x / st) * st;
  const p = { x: xs, y: lineThrough(e.h1, e.h2).at(xs) };
  if (e.pts.length >= 2) e.pts = [];
  if (e.pts.length === 1 && Math.abs(e.pts[0].x - p.x) < st / 2) return;
  e.pts.push(p);
  e.pts.sort((a, b) => a.x - b.x);
  renderEye(box, v);
}

function renderEye(box, v) {
  const e = v.eye, { x, y } = v.data;
  const cx = colInfo(box, box.xKey), cy = colInfo(box, box.yKey);
  const L = lineThrough(e.h1, e.h2);
  const su = slopeUnit(cy.unit, cx.unit), mean = slopeMeaning(box);
  const panel = $('.tool-panel', v.el);
  v.chart.onClickXY = e.step === 2 ? (px) => eyeClick(box, v, px) : null;
  v.chart.onAnchorDrag = (id, px, py) => eyeDrag(box, v, id, px, py);
  v.chart.c.style.cursor = e.step === 2 ? 'copy' : 'grab';
  v.current = { overlays: eyeOverlays(box, v) };

  let up = 0, down = 0;
  x.forEach((xi, i) => { if (isFinite(xi) && isFinite(y[i])) { if (y[i] > L.at(xi)) up++; else down++; } });
  const balance = Math.abs(up - down) <= Math.max(2, 0.15 * (up + down));

  const steps = `<ol class="eye-steps">${['Tira la retta', 'Misura la pendenza'].map((t, i) => `<li class="${e.step === i + 1 ? 'on' : e.step > i + 1 ? 'done' : ''}">${t}</li>`).join('')}</ol>`;
  let html = steps;

  if (e.step === 1) {
    html += `<p class="say">Trascina i <b>cerchi verdi</b>: la retta deve passare in mezzo ai punti.</p>
      <p class="balance ${balance ? 'ok' : ''}">⬆ ${up} &nbsp; ⬇ ${down} ${balance ? '✓' : ''}</p>
      <div class="tool-actions"><button class="btn btn-go" data-act="next">Fatto →</button></div>`;
  } else {
    if (e.pts.length < 2) html += `<p class="say">Tocca <b>due punti della retta</b>, lontani tra loro.</p>`;
    if (e.pts.length === 2) {
      const [A, B] = e.pts;
      const ya = read3(A.y), yb = read3(B.y);
      const dx = B.x - A.x, dy = yb - ya, m = dy / dx, q = ya - m * A.x;
      e.result = { m, q, A: { x: A.x, y: ya }, B: { x: B.x, y: yb }, su };
      html += `<div class="calcbox">
          <div>m = <span class="frac"><span>Δ${esc(cy.sym)}</span><span>Δ${esc(cx.sym)}</span></span> = <span class="frac"><span>${num(yb)} − ${num(ya)}</span><span>${num(B.x)} − ${num(A.x)}</span></span> = <b>${n4(m)} ${esc(su)}</b></div>
          <div class="eqline">${esc(cy.sym)} = ${n4(m)}·${esc(cx.sym)} ${q < 0 ? '−' : '+'} ${n4(Math.abs(q))}</div>
        </div>
        ${mean ? `<p class="meaning">${esc(mean[0].toUpperCase() + mean.slice(1))} ≈ <b>${n4(m)} ${esc(su)}</b></p>` : ''}`;
      if (e.cmp) {
        const rel = Math.abs((m - e.cmp.m) / e.cmp.m) * 100;
        const badge = rel <= 3 ? '<b>Ottima!</b> ✓' : rel <= 10 ? '<b>Buona</b> ✓' : '<b>Riprova</b> ↺';
        html += `<p class="cmpbox">Computer: <b>${formatMeasure(e.cmp.m, e.cmp.s, su)}</b> · differenza ${rel.toLocaleString('it-IT', { maximumFractionDigits: 1 })} % · ${badge}</p>`;
      }
      html += `<div class="tool-actions">
          <button class="btn btn-small btn-go" data-act="save">＋ Salva</button>
          <button class="btn btn-small" data-act="cmp">${e.cmp ? 'Nascondi il computer' : 'E il computer?'}</button>
        </div>`;
    }
    html += `<div class="tool-actions"><button class="btn btn-small btn-ghost" data-act="back">← Ritocca la retta</button></div>`;
  }
  panel.innerHTML = html;
  const act = (a, fn) => panel.querySelector(`[data-act="${a}"]`)?.addEventListener('click', fn);
  act('next', () => { e.step = 2; e.pts = []; renderEye(box, v); });
  act('back', () => { e.step = 1; e.pts = []; e.cmp = null; renderEye(box, v); });
  act('cmp', () => {
    if (e.cmp) { e.cmp = null; renderEye(box, v); return; }
    const tt = [], yy = [];
    x.forEach((xi, i) => { if (isFinite(xi) && isFinite(y[i])) { tt.push(xi); yy.push(y[i]); } });
    const f = polyfit(tt, yy, 1, tt[0]);
    if (!f) return;
    const mf = f.coef[1], q0 = f.coef[0] - mf * f.tRef, a = Math.min(...tt), b = Math.max(...tt);
    e.cmp = { m: mf, s: f.sigma[1], n: tt.length, x1: a, y1: mf * a + q0, x2: b, y2: mf * b + q0 };
    renderEye(box, v);
  });
  act('save', () => {
    const r = e.result;
    saveAnalysis(box, v, {
      kind: 'line', title: 'Retta a occhio',
      main: { label: mean ? `pendenza (${mean})` : 'pendenza m', value: r.m, sigma: NaN, unit: su },
      detail: `A = (${num(r.A.x)}; ${num(r.A.y)}), B = (${num(r.B.x)}; ${num(r.B.y)})${e.cmp ? `; computer: ${n4(e.cmp.m)} ± ${n4(e.cmp.s)} ${su}` : ''}`,
      eq: `${cy.sym} = ${n4(r.m)}·${cx.sym} ${r.q < 0 ? '−' : '+'} ${n4(Math.abs(r.q))}`,
      seg: { x1: e.h1.x, y1: e.h1.y, x2: e.h2.x, y2: e.h2.y },
    });
  });
  drawBox(box, v);
}

// ----- righello: due cursori verticali, N periodi tra i due → T = Δt/N, f = 1/T -----
// Sull'asse delle frequenze (spettro) misura invece la distanza tra due armoniche: Δf/N = f₀.
const TO_SECONDS = { s: 1, ms: 1e-3, 'µs': 1e-6, us: 1e-6, min: 60 };

function initRuler(box, v) {
  const xs = v.data.x.filter(isFinite);
  const a = Math.min(...xs), b = Math.max(...xs);
  const keep = v.ruler;
  v.ruler = keep && keep.x1 >= a && keep.x2 <= b ? keep : { x1: a + 0.2 * (b - a), x2: a + 0.6 * (b - a), n: 1 };
}

function renderRuler(box, v) {
  const r = v.ruler, cx = colInfo(box, box.xKey);
  const lo = Math.min(r.x1, r.x2), hi = Math.max(r.x1, r.x2), d = hi - lo;
  const isFreq = cx.unit === 'Hz';
  const toS = TO_SECONDS[cx.unit];
  const T = d / r.n;
  const f = toS ? 1 / (T * toS) : NaN;
  const rosa = css('--rosa-d');
  v.chart.onAnchorDrag = (id, x) => { r[id] = x; renderRuler(box, v); };
  v.chart.onClickXY = (x) => { const k = Math.abs(x - r.x1) < Math.abs(x - r.x2) ? 'x1' : 'x2'; r[k] = x; renderRuler(box, v); };
  v.chart.c.style.cursor = 'ew-resize';
  const spanLabel = `Δ${cx.sym} = ${num(d, 4)} ${cx.unit}`;
  v.current = { overlays: [
    { type: 'span', x1: r.x1, x2: r.x2, color: rosa, label: spanLabel },
    { type: 'vline', id: 'x1', x: r.x1, color: rosa, label: '1' },
    { type: 'vline', id: 'x2', x: r.x2, color: rosa, label: '2' },
  ] };
  const panel = $('.tool-panel', v.el);
  const sy = esc(cx.sym), u = esc(cx.unit);
  panel.innerHTML = `
    <p class="say">${isFreq ? 'Metti le linee su due <b>picchi</b> e conta gli intervalli tra i due.' : 'Metti le linee su due punti <b>uguali</b> dell\'onda (due creste) e conta i periodi tra i due.'}</p>
    <div class="ncount"><span>N =</span><button class="btn btn-small" data-n="-1">−</button><b>${r.n}</b><button class="btn btn-small" data-n="1">＋</button><span>${isFreq ? 'intervalli' : r.n === 1 ? 'periodo' : 'periodi'}</span></div>
    <div class="calcbox">
      ${isFreq
        ? `<div>f₀ = <span class="frac"><span>Δ${sy}</span><span>N</span></span> = <span class="frac"><span>${num(d, 4)} ${u}</span><span>${r.n}</span></span> = <b>${num(T, 4)} ${u}</b></div>`
        : `<div>T = <span class="frac"><span>Δ${sy}</span><span>N</span></span> = <span class="frac"><span>${num(d, 4)} ${u}</span><span>${r.n}</span></span> = <b>${num(T, 4)} ${u}</b></div>
           ${isFinite(f) ? `<div>f = <span class="frac"><span>1</span><span>T</span></span> = <b>${num(f, f < 10 ? 3 : 1)} Hz</b></div>` : ''}`}
    </div>
    <p class="hint">Più periodi abbracci, più la misura è precisa: l'errore di lettura si divide per N.</p>
    <div class="tool-actions"><button class="btn btn-small btn-go" data-act="save">＋ Salva</button></div>`;
  panel.querySelectorAll('[data-n]').forEach((b) => b.addEventListener('click', () => { r.n = Math.max(1, r.n + +b.dataset.n); renderRuler(box, v); }));
  panel.querySelector('[data-act="save"]').addEventListener('click', () => saveAnalysis(box, v, isFreq
    ? { kind: 'ruler', title: 'Righello sullo spettro', main: { label: 'distanza tra armoniche f₀', value: T, sigma: NaN, unit: cx.unit },
        detail: `${num(lo, 4)}–${num(hi, 4)} ${cx.unit}, N = ${r.n}`, eq: `f₀ = Δ${cx.sym}/N = ${num(d, 4)}/${r.n} ${cx.unit}`, span: { x1: lo, x2: hi }, spanLabel: `f₀ = ${num(T, 4)} ${cx.unit}` }
    : { kind: 'ruler', title: 'Righello', main: { label: 'periodo T', value: T, sigma: NaN, unit: cx.unit },
        detail: `${num(lo, 4)}–${num(hi, 4)} ${cx.unit}, N = ${r.n}${isFinite(f) ? `; f = ${num(f, 2)} Hz` : ''}`,
        eq: `T = Δ${cx.sym}/N = ${num(d, 4)}/${r.n} ${cx.unit}${isFinite(f) ? ` → f = ${num(f, 2)} Hz` : ''}`,
        physics: isFinite(f) ? [{ label: 'periodo T', value: T, sigma: NaN, unit: cx.unit }, { label: 'frequenza f', value: f, sigma: NaN, unit: 'Hz' }] : [],
        span: { x1: lo, x2: hi }, spanLabel: `T = ${num(T, 4)} ${cx.unit}` }));
  drawBox(box, v);
}

// ----- tangente -----
function updateTangent(box, v) {
  const { x, y } = v.data;
  const i = v.tangent;
  const cx = colInfo(box, box.xKey), cy = colInfo(box, box.yKey);
  // parabola per i punti vicini (3 per lato, ordinati per ascissa)
  const idx = x.map((xi, k) => k).filter((k) => isFinite(x[k]) && isFinite(y[k])).sort((a, b) => x[a] - x[b]);
  const pos = idx.indexOf(i);
  const h = 3, lo = Math.max(0, pos - h), hi = Math.min(idx.length - 1, pos + h);
  const near = idx.slice(lo, hi + 1);
  const f = near.length >= 3 ? polyfit(near.map((k) => x[k]), near.map((k) => y[k]), 2, x[i]) : null;
  const panel = $('.tool-panel', v.el);
  if (!f) { panel.innerHTML = TOOL_HELP.tangent + '<p class="calc-err">Servono almeno 3 punti vicini.</p>'; return; }
  const m = f.coef[1], P = { x: x[i], y: y[i] };
  const su = slopeUnit(cy.unit, cx.unit), mean = slopeMeaning(box);
  const [x0, x1] = v.group.currentRange();
  const dx = niceStep((x1 - x0) * 0.25);
  const Q = { x: P.x + dx, y: P.y + m * dx };
  v.current = {
    kind: 'tangent', m, P, overlays: [
      { type: 'segment', x1: P.x - dx * 1.6, y1: P.y - m * dx * 1.6, x2: P.x + dx * 1.6, y2: P.y + m * dx * 1.6, color: css('--green'), width: 2.4 },
      { type: 'triangle', x1: P.x, y1: P.y, x2: Q.x, y2: Q.y, color: css('--rosa-d'), dxLabel: `Δ${cx.sym} = ${num(dx)} ${cx.unit}`, dyLabel: `Δ${cy.sym} = ${num(m * dx)} ${cy.unit}` },
      { type: 'anchor', id: 'P', x: P.x, y: P.y, label: 'P', color: css('--rosa-d') },
    ],
  };
  panel.innerHTML = `
    <div class="calcbox">
      <div>m = <span class="frac"><span>Δ${esc(cy.sym)}</span><span>Δ${esc(cx.sym)}</span></span> = <span class="frac"><span>${num(m * dx)}</span><span>${num(dx)}</span></span> = <b>${n4(m)} ${esc(su)}</b></div>
    </div>
    ${mean ? `<p class="meaning">${esc(mean[0].toUpperCase() + mean.slice(1))} istantanea in ${esc(cx.sym)} = ${num(P.x)} ${esc(cx.unit)}: <b>${n4(m)} ${esc(su)}</b></p>` : ''}
    <details class="why"><summary>Come si calcola?</summary>
      <p>Una curva misurata non ha una formula: l'app prende i ${near.length} punti misurati più vicini a P e ci fa passare la parabola che li approssima meglio. La tangente è la retta che tocca quella parabola in P. Il triangolo mostra la pendenza: di quanto sale ${esc(cy.sym)} quando ${esc(cx.sym)} aumenta di ${num(dx)} ${esc(cx.unit)}.</p></details>
    <div class="tool-actions">
      <button class="btn btn-small btn-go" data-act="save">＋ Salva</button>
    </div>`;
  panel.querySelector('[data-act="save"]').addEventListener('click', () => saveAnalysis(box, v, {
    kind: 'tangent', title: `Tangente in ${cx.sym} = ${num(P.x)} ${cx.unit}`,
    main: { label: mean ? `${mean} istantanea` : 'pendenza della tangente', value: m, sigma: NaN, unit: su },
    detail: `P = (${num(P.x)}; ${num(P.y)}); parabola sui ${near.length} punti vicini`,
    eq: `pendenza = ${n4(m)} ${su}`,
    seg: { x1: P.x - dx, y1: P.y - m * dx, x2: P.x + dx, y2: P.y + m * dx },
  }));
  drawBox(box, v);
}

function niceStep(v) {
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(v) || 1)));
  const n = v / mag;
  return (n < 1.5 ? 1 : n < 3.5 ? 2 : n < 7.5 ? 5 : 10) * mag;
}

// ----- fit -----
function renderFitMenu(box, v) {
  const q = box.xKey === 't' ? QUANTITIES[box.yKey] : null;
  const suggested = q?.models || [];
  const others = MODEL_ORDER.filter((id) => !suggested.includes(id));
  const panel = $('.tool-panel', v.el);
  const btn = (id, cls = '') => `<button class="btn btn-small ${cls}${v.fitModel === id ? ' active' : ''}" data-model="${id}" title="${esc(MODELS[id].formula)}">${esc(MODELS[id].label)}</button>`;
  panel.innerHTML = `${TOOL_HELP.fit}
    <div class="fit-row">${suggested.length ? `<span class="fit-row-label">Consigliati</span>${suggested.map((id) => btn(id, 'btn-suggest')).join('')}` : ''}</div>
    <details class="fit-more"${suggested.length ? '' : ' open'}><summary>Altri modelli</summary><div class="fit-row">${others.map((id) => btn(id)).join('')}</div></details>
    <div class="fit-out"></div>`;
  panel.querySelectorAll('[data-model]').forEach((b) => b.addEventListener('click', () => runFitTool(box, v, b.dataset.model)));
  if (v.fitModel) runFitTool(box, v, v.fitModel);
}

function runFitTool(box, v, id) {
  v.fitModel = id;
  v.el.querySelectorAll('[data-model]').forEach((b) => b.classList.toggle('active', b.dataset.model === id));
  const { x, y } = v.data;
  const [a, b] = v.selection ?? [-Infinity, Infinity];
  const tt = [], yy = [];
  x.forEach((xi, i) => { if (isFinite(xi) && isFinite(y[i]) && xi >= a && xi <= b) { tt.push(xi); yy.push(y[i]); } });
  const order = tt.map((_, i) => i).sort((i, j) => tt[i] - tt[j]);
  const T = order.map((i) => tt[i]), Y = order.map((i) => yy[i]);
  const cx = colInfo(box, box.xKey), cy = colInfo(box, box.yKey);
  const fit = runModel(id, T, Y, { x: cx.unit, y: cy.unit, xs: cx.sym, ys: cy.sym });
  const out = $('.fit-out', v.el);
  if (fit.error) { out.innerHTML = `<p class="calc-err">${esc(fit.error)}</p>`; v.current = null; drawBox(box, v); return; }
  const q = box.xKey === 't' ? QUANTITIES[box.yKey] : null;
  const phys = (q?.physics?.[id] || []).map((p) => { const [val, s] = p.calc(fit); return { label: p.label, unit: p.unit, value: val, sigma: s }; });
  const N = 300, cxs = [], cys = [];
  for (let i = 0; i <= N; i++) { const t = fit.t1 + ((fit.t2 - fit.t1) * i) / N; cxs.push(t); cys.push(fit.curve(t)); }
  v.current = { kind: 'fit', fit, phys, overlays: [{ type: 'curve', x: cxs, y: cys, color: css('--rosa-d'), width: 2.8, dash: [7, 4] }] };
  const p0 = fit.params[0];
  const main = phys[0] || { label: p0.sym, value: p0.value, sigma: p0.sigma, unit: p0.unit };
  const rows = (list) => list.map((p) => `<tr><th>${esc(p.label ?? p.sym)}</th><td>${p.key === 'sd' ? `${n4(p.value)} ${esc(p.unit)}` : formatMeasure(p.value, p.sigma, p.unit)}</td></tr>`).join('');
  const isLine = id === 'lin';
  out.innerHTML = `
    <p class="eqline big">${esc(fit.eq)}</p>
    ${phys.length ? `<table class="res phys">${rows(phys)}</table>` : `<table class="res phys">${rows([fit.params[0]])}</table>`}
    <p class="unc"><b>±</b> perché i punti oscillano di circa <b>${fmt(fit.s, 2)} ${esc(cy.unit)}</b> intorno alla curva.</p>
    <p class="hint">${fit.n} punti · ${num(fit.t1, 3)}–${num(fit.t2, 3)} ${esc(cx.unit)}</p>
    <details class="why"><summary>Tutti i parametri del modello</summary><p class="formula">${esc(MODELS[id].formula)}</p><table class="res">${rows(fit.params)}</table></details>
    <details class="why"><summary>L'incertezza: termini e formule</summary>
      <p><b>Deviazione standard dei dati</b> (o scarto quadratico medio), s = ${n4(fit.s)} ${esc(cy.unit)}: quanto oscillano i punti intorno alla curva. Si calcola dai residui r (dato − curva): s = √( Σr² / (n − p) ), con n punti e p parametri del modello.</p>
      <p><b>Incertezza tipo</b> (o errore standard) di un parametro: il numero dopo il ±. Dipende da s e da quanti e quanto distribuiti sono i punti.${isLine ? ` Per la pendenza della retta: σ<sub>m</sub> = s / √Σ(${esc(cx.sym)} − ${esc(cx.sym)}̄)². Più largo è il tratto sull'asse orizzontale, più piccola è l'incertezza.` : ' Per i modelli non lineari si ricava dalla stessa s, tenendo conto di quanto ogni parametro "sposta" la curva.'}</p>
      <p>Prova a confrontarla con il <b>ventaglio</b> della retta a occhio: è la stessa idea, fatta a mano.</p>
    </details>
    <details class="why"><summary>Che cos'è R² = ${isFinite(fit.r2) ? fit.r2.toLocaleString('it-IT', { maximumFractionDigits: 5 }) : '—'}?</summary>
      <p>R² dice quale frazione della variazione dei dati è spiegata dal modello: <b>1</b> = i punti stanno tutti sulla curva, <b>0</b> = il modello non spiega nulla. Attenzione: un R² alto non basta a dire che il modello è giusto (una retta su un tratto di parabola può dare R² = 0,99). Per questo c'è la verifica dei residui.</p></details>
    <div class="tool-actions">
      <button class="btn btn-small btn-go" data-act="save">＋ Salva</button>
      <button class="btn btn-small" data-act="resid">Il modello è giusto?</button>
    </div>
    <div class="resid-out"></div>`;
  out.querySelector('[data-act="save"]').addEventListener('click', () => saveAnalysis(box, v, {
    kind: 'fit', title: `Fit: ${MODELS[id].label}`, model: id,
    main: { label: main.label, value: main.value, sigma: main.sigma, unit: main.unit },
    detail: `${fit.n} punti, ${num(fit.t1, 3)}–${num(fit.t2, 3)} ${cx.unit}; R² = ${isFinite(fit.r2) ? fit.r2.toFixed(5) : '—'}`,
    eq: fit.eq, r2: fit.r2, n: fit.n, t1: fit.t1, t2: fit.t2,
    params: fit.params.map(({ key, sym, value, sigma, unit }) => ({ key, sym, value, sigma, unit })),
    physics: phys,
    curve: { x: cxs.filter((_, i) => i % 3 === 0), y: cys.filter((_, i) => i % 3 === 0) },
  }));
  out.querySelector('[data-act="resid"]').addEventListener('click', () => showResiduals(box, v, fit, T));
  drawBox(box, v);
}

function showResiduals(box, v, fit, T) {
  const out = $('.resid-out', v.el);
  const rt = runsTest(fit.residuals);
  const cy = colInfo(box, box.yKey);
  const verdict = rt.verdict === 'sistematici'
    ? `<p class="verdict bad">✗ I residui hanno un <b>andamento sistematico</b>: cambiano segno solo ${rt.runs} volte, mentre per dati casuali ce ne aspetteremmo circa ${num(rt.mu, 0)}. I punti stanno "a pancia" rispetto alla curva: <b>il modello non descrive bene questo tratto</b>. Prova un altro modello o un altro tratto.</p>`
    : rt.verdict === 'casuali'
      ? `<p class="verdict ok">✓ I residui sono <b>sparsi a caso</b> intorno a zero: cambiano segno ${rt.runs} volte (per dati casuali ce ne aspettiamo circa ${num(rt.mu, 0)}). Il modello è <b>adeguato</b> per questo tratto.</p>`
      : '<p class="verdict">Troppo pochi punti per un verdetto.</p>';
  out.innerHTML = `<div class="resid-head"><b>Residui = dato − modello</b></div><div class="resid-cell"><canvas aria-label="Grafico dei residui"></canvas></div>${verdict}
    <details class="why"><summary>Come funziona la verifica?</summary><p>Se il modello è giusto, ogni punto sta sopra o sotto la curva "a caso", come lanciando una moneta: i segni dei residui cambiano spesso. Se il modello è sbagliato, ci sono lunghi tratti tutti sopra e poi tutti sotto. L'app conta i cambi di segno e li confronta con quelli attesi per il caso (<i>test delle successioni</i> di Wald–Wolfowitz: verdetto negativo se il numero di successioni è più di 2 deviazioni standard sotto l'atteso).</p></details>`;
  const g = new ChartGroup({ includeZero: false });
  const c = g.add(new Chart($('canvas', out), { compact: false }));
  c.setData({ series: [
    { x: T, y: fit.residuals, mode: 'points', color: css('--rosa-d'), label: 'r' },
    { x: [fit.t1, fit.t2], y: [0, 0], mode: 'line', color: css('--axis'), width: 1.2 },
  ], xLabel: axisLabel(colInfo(box, box.xKey)), yLabel: cy.unit ? `r (${cy.unit})` : 'r' });
  v.residGroup?.clear(); v.residGroup = g;
}

// ---------------------------------------------------------------------------
// Analisi salvate
// ---------------------------------------------------------------------------
function saveAnalysis(box, v, a) {
  box.analyses.push({ ...a, id: Date.now(), xKey: box.xKey, yKey: box.yKey, axes: `${colInfo(box, box.yKey).sym}(${colInfo(box, box.xKey).sym})` });
  persist(box);
  renderSaved(box, v);
  drawBox(box, v);
  toastFn('Analisi salvata nel riquadro.');
}

function renderSaved(box, v) {
  const el = $('.saved', v.el);
  if (!box.analyses.length) { el.innerHTML = ''; return; }
  el.innerHTML = `<h4>Analisi salvate</h4><ul class="analyses">${box.analyses.map((a, i) => `
    <li><div><b>${esc(a.title)}</b> <small>· ${esc(a.axes)}</small><br>
      <span class="aq">${esc(a.main.label)}: <b>${isFinite(a.main.sigma) ? formatMeasure(a.main.value, a.main.sigma, a.main.unit) : `${n4(a.main.value)} ${esc(a.main.unit)}`}</b></span><br>
      <small class="eqs">${esc(a.eq)}</small></div>
      <button class="btn btn-small btn-ghost" data-del="${i}" title="Elimina">✕</button></li>`).join('')}</ul>`;
  el.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    box.analyses.splice(+b.dataset.del, 1); persist(box); renderSaved(box, v); drawBox(box, v);
  }));
}

// ---------------------------------------------------------------------------
// Foglio dei dati: colonne affiancate, assi scelti dall'intestazione,
// nuove colonne calcolate con anteprima mentre scrivi la formula.
// ---------------------------------------------------------------------------
const fmtCell = (v) => (isFinite(v) ? (+v.toPrecision(6)).toLocaleString('it-IT', { maximumFractionDigits: 6 }) : '—');

function setAxis(box, v, ax, key) {
  if (ax === 'x') box.xKey = key; else box.yKey = key;
  $(ax === 'x' ? '.sx' : '.sy', v.el).value = key;
  persist(box);
  setTool(box, v, v.tool);
  renderSheet(box, v);
}

function renderSheet(box, v) {
  const wrap = $('.sheet-wrap', v.el);
  if (!wrap) return;
  const rows = computeRows(box);
  const cols = [...box.columns, ...box.computed];
  const isComp = (c) => box.computed.includes(c);
  const head = cols.map((c) => `
    <th class="${c.key === box.xKey ? 'isx' : ''} ${c.key === box.yKey ? 'isy' : ''}">
      <div class="ch-name">${esc(axisLabel(c))}</div>
      ${isComp(c) ? `<div class="ch-f" title="formula">= ${esc(c.formula)}</div>` : `<div class="ch-f muted">${esc(QUANTITIES[c.key]?.name || 'misurata')}</div>`}
      <div class="ch-btns">
        <button class="axbtn x" data-ax="x" data-key="${esc(c.key)}" title="Metti sull'asse orizzontale">x</button>
        <button class="axbtn y" data-ax="y" data-key="${esc(c.key)}" title="Metti sull'asse verticale">y</button>
        ${isComp(c) ? `<button class="axbtn del" data-del="${esc(c.key)}" title="Elimina la colonna">✕</button>` : ''}
      </div>
      ${c.error ? `<div class="ch-err">${esc(c.error)}</div>` : ''}
    </th>`).join('');
  const pend = v.pending;
  const newHead = pend
    ? `<th class="pending"><div class="pend-form">
        <input class="p-sym" placeholder="simbolo" value="${esc(pend.sym)}" aria-label="Simbolo della nuova colonna">
        <input class="p-unit" placeholder="unità" value="${esc(pend.unit)}" aria-label="Unità">
        <input class="p-formula" placeholder="formula, es. x^2" value="${esc(pend.formula)}" aria-label="Formula">
        <div class="p-err"></div>
        <div class="p-btns"><button class="btn btn-small btn-go p-ok">✓ Aggiungi</button><button class="btn btn-small btn-ghost p-no">Annulla</button></div>
      </div></th>`
    : '<th class="newcol"><button class="btn btn-small add-col">＋ Nuova colonna</button></th>';
  const body = rows.map((r, i) => `<tr>${cols.map((c) => `<td class="${c.key === box.xKey ? 'isx' : ''} ${c.key === box.yKey ? 'isy' : ''}">${fmtCell(r[c.key])}</td>`).join('')}<td class="pcell" data-i="${i}"></td></tr>`).join('');
  wrap.innerHTML = `<table class="sheet"><thead><tr>${head}${newHead}</tr></thead><tbody>${body}</tbody></table>`;

  wrap.querySelectorAll('.axbtn[data-ax]').forEach((b) => b.addEventListener('click', () => setAxis(box, v, b.dataset.ax, b.dataset.key)));
  wrap.querySelectorAll('.axbtn[data-del]').forEach((b) => b.addEventListener('click', () => deleteComputed(box, v, b.dataset.del)));
  wrap.querySelector('.add-col')?.addEventListener('click', () => { v.pending = { sym: '', unit: '', formula: '' }; renderSheet(box, v); wrap.querySelector('.p-sym').focus(); });
  if (pend) {
    const upd = () => {
      pend.sym = wrap.querySelector('.p-sym').value.trim();
      pend.unit = wrap.querySelector('.p-unit').value.trim();
      pend.formula = wrap.querySelector('.p-formula').value;
      const err = wrap.querySelector('.p-err');
      const cells = wrap.querySelectorAll('.pcell');
      if (!pend.formula.trim()) { err.textContent = 'Scrivi una formula: mentre scrivi vedi qui sotto il risultato.'; cells.forEach((td) => (td.textContent = '')); return; }
      try {
        const { fn } = compile(pend.formula, cols.map((c) => c.key));
        err.textContent = '';
        cells.forEach((td) => (td.textContent = fmtCell(fn(rows[+td.dataset.i]))));
      } catch (e2) { err.textContent = e2.message; cells.forEach((td) => (td.textContent = '')); }
    };
    wrap.querySelectorAll('.pend-form input').forEach((inp) => inp.addEventListener('input', upd));
    wrap.querySelector('.p-formula').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') addComputed(box, v); });
    wrap.querySelector('.p-ok').addEventListener('click', () => addComputed(box, v));
    wrap.querySelector('.p-no').addEventListener('click', () => { v.pending = null; renderSheet(box, v); });
    upd();
  }
}

function addComputed(box, v) {
  const p = v.pending; if (!p) return;
  const err = $('.p-err', v.el);
  const existing = [...box.columns, ...box.computed].map((c) => c.key);
  if (!p.sym) { err.textContent = 'Dai un simbolo alla colonna (es. y, x2, lnT).'; return; }
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(p.sym)) { err.textContent = 'Il simbolo può contenere solo lettere, cifre e _ e deve iniziare con una lettera.'; return; }
  if (existing.includes(p.sym)) { err.textContent = `Esiste già una colonna «${p.sym}».`; return; }
  try { compile(p.formula, existing); } catch (e) { err.textContent = e.message; return; }
  box.computed.push({ key: p.sym, sym: p.sym, unit: p.unit, formula: p.formula.trim() });
  v.pending = null;
  persist(box);
  rebuildBox(box, v, true);
  toastFn(`Colonna «${p.sym}» aggiunta: premi «y» o «x» nella sua intestazione per metterla sul grafico.`);
}

function deleteComputed(box, v, key) {
  const c = box.computed.find((k) => k.key === key);
  if (!c || !confirm(`Eliminare la colonna «${c.sym} = ${c.formula}»?`)) return;
  box.computed = box.computed.filter((k) => k !== c);
  if (box.xKey === key) box.xKey = 't';
  if (box.yKey === key) box.yKey = box.columns.find((k) => k.key !== 't')?.key || 't';
  persist(box);
  rebuildBox(box, v, true);
}

/** Ridisegna il riquadro (servono i menu degli assi aggiornati), riaprendo il foglio. */
function rebuildBox(box, v, openSheet) {
  const el = v.el, fresh = renderBox(box);
  v.group.clear(); el.replaceWith(fresh);
  if (openSheet) { const nv = views.get(box.id); nv.el.querySelector('.box-data').open = true; renderSheet(box, nv); }
}

// ---------------------------------------------------------------------------
// Export dei riquadri spuntati: un foglio per riquadro + Riepilogo + Analisi
// ---------------------------------------------------------------------------
function sheetName(title, used) {
  const base = String(title).replace(/[[\]:*?/\\]/g, ' ').slice(0, 28).trim() || 'Riquadro';
  let name = base, k = 2;
  while (used.has(name.toLowerCase())) name = `${base.slice(0, 26)} ${k++}`;
  used.add(name.toLowerCase());
  return name;
}

function exportChecked() {
  const sel = boxes.filter((b) => b.checked);
  if (!sel.length) return;
  const used = new Set(['riepilogo', 'analisi']);
  const summary = [['Riquadro', 'Foglio', 'Lab', 'Misura di origine', 'Da', 'A', 'Unità', 'Punti', 'Note', 'Colonne calcolate']];
  const analyses = [['Riquadro', 'Analisi', 'Grafico', 'Grandezza', 'Valore', 'Incertezza σ', 'Unità', 'Equazione', 'Dettagli']];
  const sheets = [];
  for (const b of sel) {
    const name = sheetName(b.title, used);
    const cols = [...b.columns, ...b.computed];
    const rows = computeRows(b);
    sheets.push({ name, rows: [cols.map(axisLabel), ...rows.map((r) => cols.map((c) => r[c.key]))] });
    summary.push([b.title, name, b.expTitle, b.sessionName || '', b.t1, b.t2, b.tUnit || 's', b.rows.length, b.subtitle || '', b.computed.map((c) => `${c.sym} = ${c.formula}`).join('; ')]);
    for (const a of b.analyses) {
      analyses.push([b.title, a.title, a.axes, a.main.label, a.main.value, isFinite(a.main.sigma) ? a.main.sigma : '', a.main.unit, a.eq, a.detail]);
      for (const p of a.physics?.slice(1) || []) analyses.push([b.title, a.title, a.axes, p.label, p.value, isFinite(p.sigma) ? p.sigma : '', p.unit, '', '']);
      for (const p of a.params || []) analyses.push([b.title, a.title, a.axes, `parametro ${p.sym}`, p.value, isFinite(p.sigma) ? p.sigma : '', p.unit, '', '']);
    }
  }
  const all = [{ name: 'Riepilogo', rows: summary }, ...(analyses.length > 1 ? [{ name: 'Analisi', rows: analyses }] : []), ...sheets];
  const d = new Date(), p2 = (n) => String(n).padStart(2, '0');
  download(toXLSX(all), `mosaicus_elaborazione_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}-${p2(d.getMinutes())}.xlsx`);
  toastFn(`Esportati ${sel.length} riquadri in un unico file Excel.`);
}
