// Mosaicus — logica principale: pagina Misura, collegamento, Quaderno delle misure,
// navigazione verso la pagina Elaborazione (workbench.js).
import { EXPERIMENTS, TOPICS, byId, defaultParams, QUANTITIES } from './experiments.js';
import { Chart, ChartGroup } from './chart.js';
import { SerialLink, serialSupported } from './serial.js';
import { SimulatedLink } from './simulator.js';
import { PhoneLink, phoneSupport } from './phone.js';
import { saveSession, getSession, deleteSession, listSessions } from './storage.js';
import { toCSV, toXLSX, download } from './export.js';
import { initWorkbench, addBox, boxesForSession, focusBox, refreshStyle as wbRefreshStyle } from './workbench.js';
import { createScope } from './scope.js';
import { createSynth, onGeneratorChange, generatorState, stopGenerator } from './synth.js';
import { audioSupported } from './audio.js';

// versione: la stessa di version.json (letta dalla pagina del sito) e di CACHE in sw.js
const APP_VERSION = '0.10.0';
const FIRMWARE_VERSION = '0.2';   // firmware atteso su Arduino
const $ = (s) => document.querySelector(s);

const state = {
  exp: null,
  params: {},
  link: null,
  ready: false,
  fw: null,
  running: false,
  raw: [],          // campi numerici grezzi ricevuti, es. [t_ms, adc]
  rows: [],         // campioni convertiti + grandezze derivate
  visible: [],      // grafici mostrati (id delle viste)
  view: null,       // grafico attivo (bordo verde)
  selection: null,  // [t1, t2]
  session: null,    // { id?, name, created, source, fw }
  simSignal: 'mic', // segnale del simulatore per l'oscilloscopio elettrico
};
let instr = null;   // pannello dello strumento attivo (oscilloscopio, generatore, strumento musicale)

// Grafici impilati: condividono asse dei tempi, zoom, selezione e mirino.
const group = new ChartGroup({
  onSelect: (sel) => { state.selection = sel; updateSelectionUI(); },
  onActivate: (chart) => setActive(chart.viewId),
});

// ---------------- utilità ----------------
/** Avviso in basso. Con `action` ({ label, run }) diventa anche un pulsante: es. «Vai a Elaborazione →». */
/** Confronta due versioni "a.b.c": <0 se a è più vecchia di b. */
function cmpVersion(a, b) {
  const x = String(a).split('.').map(Number), y = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i++) { const d = (x[i] || 0) - (y[i] || 0); if (d) return d; }
  return 0;
}

function toast(msg, ms = 2800, action = null) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('has-action', !!action);
  if (action) {
    const b = document.createElement('button');
    b.className = 'btn btn-small toast-act'; b.textContent = action.label;
    b.addEventListener('click', () => { t.classList.remove('show'); action.run(); });
    t.append(b);
  }
  t.classList.add('show');
  clearTimeout(toast._h); toast._h = setTimeout(() => t.classList.remove('show'), action ? Math.max(ms, 6000) : ms);
}
const isPhone = () => window.matchMedia('(max-width: 700px)').matches;
const goElab = () => showPage('elab');
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage non disponibile */ } },
};
const stamp = (d = new Date()) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}`;
};
const fmtVal = (v, digits) => (isFinite(v) ? v.toLocaleString('it-IT', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—');
const escapeHTML = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---------------- pagine ----------------
function showPage(id) {
  document.querySelectorAll('.page').forEach((p) => (p.hidden = p.id !== `page-${id}`));
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('active', b.dataset.page === id));
  document.querySelectorAll('.bottom-nav [data-go]').forEach((b) => b.classList.toggle('active', b.dataset.go === id));
  store.set('mosaicus.page', id);
  window.scrollTo({ top: 0 });
}

// ---------------- esperimenti (albero per argomento) ----------------
function renderExperimentList() {
  const box = $('#expList'); box.innerHTML = '';
  for (const topic of TOPICS) {
    const det = document.createElement('details');
    det.className = 'topic'; det.open = true;
    det.innerHTML = `<summary>${topic}</summary>`;
    const list = document.createElement('div'); list.className = 'exp-list';
    for (const e of EXPERIMENTS.filter((x) => x.topic === topic)) {
      const b = document.createElement('button');
      b.className = 'exp-card'; b.dataset.id = e.id;
      b.innerHTML = `<span class="exp-icon" style="background:${e.iconBg}">${e.icon}</span><span><b>${e.title}</b><small>${e.subtitle}</small></span>`;
      b.addEventListener('click', () => {
        selectExperiment(e.id);
        // sul telefono l'elenco sta sopra: dopo la scelta porto in vista l'esperimento
        if (isPhone() && state.exp.id === e.id) document.querySelector('#page-misura .main').scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
      list.appendChild(b);
    }
    det.appendChild(list); box.appendChild(det);
  }
}

function selectExperiment(id, { keepData = false } = {}) {
  if (state.running) { toast('Ferma la misura prima di cambiare esperimento.'); return; }
  // generatore e strumento musicale sono confluiti nel sintetizzatore (v0.10)
  if (id === 'generator' || id === 'theremin') id = 'synth';
  state.exp = byId(id) || EXPERIMENTS[0];
  id = state.exp.id;
  state.params = { ...defaultParams(state.exp), ...store.get(`mosaicus.params.${id}`, {}) };
  store.set('mosaicus.lastExp', id);
  document.querySelectorAll('.exp-card').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  $('#wiring').innerHTML = state.exp.wiring;
  $('#btnZero').hidden = state.exp.lineType !== 'S';
  if (!keepData) { state.raw = []; state.session = null; $('#sessionName').value = ''; }
  const kind = state.exp.kind;
  instr?.destroy(); instr = null;
  document.body.dataset.kind = kind || '';
  $('#instrPanel').hidden = !kind;
  document.querySelectorAll('#page-misura .ts').forEach((e) => (e.hidden = !!kind));
  $('#paramCard').hidden = !!kind;
  $('#serialCard').hidden = state.exp.source === 'audio';
  state.selection = null; group.setSelection(null); group.fitAll();
  if (kind) {
    group.clear(); $('#chartStack').innerHTML = ''; state.rows = []; state.view = null;
    $('#instrPanel').innerHTML = '';
    instr = makeInstrument(state.exp);
  } else {
    renderParams();
    const saved = store.get(`mosaicus.visible.${id}`, null);
    state.visible = (saved || state.exp.defaultVisible || [state.exp.views[0].id]).filter((v) => state.exp.views.some((w) => w.id === v));
    if (!state.visible.length) state.visible = [state.exp.views[0].id];
    state.view = null;
    renderViewTabs();
    buildCharts();
    recompute();
    renderSavedSelections();
  }
  updateGenChip();
  // se il dispositivo collegato non è quello giusto per questo esperimento, lo scollego
  const needPhone = state.exp.source === 'phone';
  if (state.exp.source !== 'audio' && state.link && state.link.kind !== 'simulatore' && (state.link.kind === 'telefono') !== needPhone) {
    state.link.close();
    toast(needPhone ? 'Questo esperimento usa i sensori del telefono: ho scollegato Arduino.' : 'Questo esperimento usa Arduino: ho disattivato i sensori del telefono.', 4500);
  }
  if (state.link?.kind === 'simulatore' && state.ready) setStatus(simStatus(), 'pill-on');
  updateSourceUI();
}

/** Pannello di uno strumento (oscilloscopio, generatore, strumento musicale). */
function makeInstrument(exp) {
  const el = $('#instrPanel');
  const api = {
    mode: exp.source === 'arduino' ? 'arduino' : 'audio',
    toast,
    ready: () => !!state.link && state.ready,
    async send(cmd) {
      if (!state.link) return;
      if (state.link.kind === 'simulatore') { state.link.scenario = state.exp.sim; state.link.scopeSignal = state.simSignal; }
      await state.link.write(cmd);
    },
    async sendBox(data, msg) {
      await addBox({ experiment: exp.id, expTitle: exp.title, sessionId: null, sessionName: '', ...data });
      toast(msg, 6000, { label: 'Vai a Elaborazione →', run: goElab });
      pulseNav();
    },
    setSimSignal(sig) { state.simSignal = sig; if (state.link?.kind === 'simulatore') state.link.scopeSignal = sig; },
    openExperiment(id) { showPage('misura'); selectExperiment(id); },
  };
  if (exp.kind === 'scope') return createScope(el, api);
  if (exp.kind === 'synth') return createSynth(el, api);
  return null;
}

/** Spia del generatore acceso, visibile nelle altre pagine. */
function updateGenChip() {
  const G = generatorState(), chip = $('#genChip');
  chip.hidden = !G.on || state.exp?.id === 'synth';
  chip.querySelector('b').textContent = `${fmtVal(G.f, G.f < 100 ? 1 : 0)} Hz${G.two ? ` + ${fmtVal(G.f + G.df, 1)} Hz` : ''}`;
}

/** Pulsante e avvisi in base alla sorgente dei dati dell'esperimento (Arduino o telefono). */
function updateSourceUI() {
  const phone = state.exp.source === 'phone';
  const btn = $('#btnConnect');
  btn.textContent = phone ? 'Attiva sensori del telefono' : 'Collega Arduino';
  const sup = phoneSupport();
  const b = $('#banner');
  refreshButtons();
  if (state.exp.source === 'audio') {
    b.hidden = audioSupported();
    b.innerHTML = 'Questo browser non supporta l\'audio (Web Audio API): prova con Chrome, Edge, Firefox o Safari aggiornati.';
    return;
  }
  const ok = phone ? sup.motion || sup.sound : serialSupported();
  btn.disabled = !ok;
  if (!ok && state.exp.optionalLink) { b.hidden = true; return; }
  if (!ok) {
    b.hidden = false;
    b.innerHTML = phone
      ? 'Questo browser non dà accesso ai sensori. Apri Mosaicus sul telefono con <b>Chrome</b> (Android) o <b>Safari</b> (iPhone). Il simulatore funziona comunque.'
      : 'Questo browser non può comunicare con Arduino (manca la <b>Web Serial API</b>): serve <b>Chrome</b> o <b>Edge</b> su computer. Su questo dispositivo puoi usare gli esperimenti <b>Smartphone</b>, con i sensori del telefono, e il simulatore.';
  } else b.hidden = true;
}

function renderParams() {
  const form = $('#paramForm'); form.innerHTML = '';
  const basic = document.createElement('div'); basic.className = 'params';
  const adv = document.createElement('details'); adv.className = 'adv';
  adv.innerHTML = '<summary>Parametri avanzati</summary>';
  for (const p of state.exp.params) {
    const row = document.createElement('label'); row.className = 'param';
    let input;
    if (p.type === 'select') {
      input = document.createElement('select');
      for (const [v, l] of p.options) { const o = document.createElement('option'); o.value = v; o.textContent = l; input.appendChild(o); }
      input.value = state.params[p.key];
    } else {
      input = document.createElement('input'); input.type = 'number'; input.step = p.step ?? 'any';
      if (p.min != null) input.min = p.min;
      input.value = state.params[p.key];
    }
    input.id = `param-${p.key}`;
    input.addEventListener('change', () => {
      const v = p.type === 'select' ? input.value : parseFloat(input.value);
      if (p.type !== 'select' && !isFinite(v)) { input.value = state.params[p.key]; return; }
      state.params[p.key] = v;
      store.set(`mosaicus.params.${state.exp.id}`, state.params);
      recompute();
    });
    row.innerHTML = `<span>${p.label}${p.unit ? ` <em>(${p.unit})</em>` : ''}</span>`;
    row.appendChild(input);
    (p.advanced ? adv : basic).appendChild(row);
  }
  const reset = document.createElement('button');
  reset.type = 'button'; reset.className = 'btn btn-small'; reset.textContent = 'Ripristina valori predefiniti';
  reset.addEventListener('click', () => {
    state.params = defaultParams(state.exp); store.set(`mosaicus.params.${state.exp.id}`, state.params);
    renderParams(); recompute();
  });
  adv.appendChild(reset);
  form.append(basic, adv);
}

// ---------------- grafici impilati ----------------
function renderViewTabs() {
  const box = $('#viewTabs'); box.innerHTML = '';
  for (const v of state.exp.views) {
    const b = document.createElement('button');
    const on = state.visible.includes(v.id);
    b.className = `tab${on ? ' active' : ''}`; b.dataset.id = v.id; b.setAttribute('aria-pressed', String(on));
    b.innerHTML = `<span class="chk">${on ? '✓' : ''}</span>${v.label}`;
    b.addEventListener('click', () => toggleView(v.id));
    box.appendChild(b);
  }
}

function toggleView(id) {
  const on = state.visible.includes(id);
  if (on && state.visible.length === 1) { toast('Almeno un grafico deve restare visibile.'); return; }
  const order = state.exp.views.map((v) => v.id);
  state.visible = on ? state.visible.filter((v) => v !== id) : [...state.visible, id].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  store.set(`mosaicus.visible.${state.exp.id}`, state.visible);
  renderViewTabs();
  buildCharts();
  if (!on) setActive(id);
}

function buildCharts() {
  group.clear();
  const stack = $('#chartStack'); stack.innerHTML = '';
  state.visible.forEach((id, i) => {
    const cell = document.createElement('div');
    const last = i === state.visible.length - 1;
    cell.className = `chart-cell${last ? ' last' : ''}`; cell.dataset.id = id;
    const cv = document.createElement('canvas');
    const v = state.exp.views.find((w) => w.id === id);
    cv.setAttribute('aria-label', `Grafico ${v.label}`);
    cell.appendChild(cv); stack.appendChild(cell);
    const ch = group.add(new Chart(cv, { compact: !last }));
    ch.viewId = id;
  });
  if (!state.view || !state.visible.includes(state.view.id)) state.view = state.exp.views.find((v) => v.id === state.visible[0]);
  setActive(state.view.id, { force: true });
  updateChart();
}

/** Grafico attivo: è la grandezza che va sull'asse verticale quando salvi la selezione. */
function setActive(id, { force = false } = {}) {
  if (!force && state.view?.id === id) return;
  state.view = state.exp.views.find((v) => v.id === id);
  document.querySelectorAll('.chart-cell').forEach((c) => c.classList.toggle('active', c.dataset.id === id));
}

// ---------------- dati ----------------
function recompute() {
  const parsed = state.raw.map((f) => state.exp.parse(f, state.params)).filter(Boolean);
  state.rows = state.exp.derive(parsed, state.params);
  updateChart();
  updateReadouts();
  updateSelectionUI();
}

let pending = false;
function scheduleRecompute() {
  if (pending) return;
  pending = true;
  setTimeout(() => { pending = false; recompute(); }, 120);
}

function updateChart() {
  const rows = state.rows, t = rows.map((r) => r.t);
  const rawColor = getComputedStyle(document.documentElement).getPropertyValue('--raw').trim();
  for (const ch of group.charts) {
    const v = state.exp.views.find((w) => w.id === ch.viewId);
    if (!v) continue;
    ch.setData({
      series: [{ x: t, y: rows.map((r) => r[v.key]), label: v.sym, color: v.raw ? rawColor : undefined, mode: v.line ? 'both' : 'points' }],
      xLabel: state.exp.xLabel, yLabel: v.yLabel,
    });
  }
}

function updateReadouts() {
  const box = $('#readouts');
  const last = (key) => { for (let i = state.rows.length - 1; i >= 0; i--) if (isFinite(state.rows[i][key])) return state.rows[i][key]; return NaN; };
  const tEnd = state.rows.length ? state.rows[state.rows.length - 1].t : 0;
  // gerarchia: la prima grandezza è la principale (grande), il tempo e i punti sono un dettaglio (piccoli)
  box.innerHTML = state.exp.readouts.map((r, i) =>
    `<div class="ro${i === 0 ? ' ro-main' : ''}"><small>${r.label}</small><b>${fmtVal(last(r.key), r.digits)}</b><em>${r.unit}</em></div>`).join('') +
    `<div class="ro ro-minor"><small>Tempo · punti</small><b>${fmtVal(tEnd, 1)}</b><em>s · ${state.rows.length}</em></div>`;
}

// ---------------- selezione: salva, esporta, tabella ----------------
function selectedRows() {
  const [a, b] = state.selection ?? [-Infinity, Infinity];
  return state.rows.filter((r) => r.t >= a && r.t <= b);
}

function updateSelectionUI() {
  const has = !!state.selection;
  const rows = selectedRows();
  const info = $('#selInfo');
  if (!state.rows.length) info.innerHTML = 'Collega e premi <b>▶ Avvia</b>.';
  else if (has) info.innerHTML = `<b>${fmtVal(state.selection[0], 2)} – ${fmtVal(state.selection[1], 2)} s</b> · ${rows.length} punti`;
  else info.innerHTML = 'Trascina su un grafico per scegliere un tratto.';
  $('#btnSaveSel').textContent = has ? 'Invia il tratto a Elaborazione →' : 'Invia tutta la misura a Elaborazione →';
  document.querySelector('.selbar').classList.toggle('has-sel', has && !state.running);
  if (has) hideDragHint(true);
  $('#btnSaveSel').disabled = !state.rows.length || state.running;
  $('#exportLabel').textContent = has ? 'Esporta selezione' : 'Esporta tutto';
  if ($('#selTableBox').open) renderSelTable();
}

function renderSelTable() {
  const cols = state.exp.columns;
  const rows = selectedRows();
  const cell = (v) => (typeof v === 'boolean' ? (v ? '✓' : '✗') : isFinite(v) ? (+v.toPrecision(6)).toLocaleString('it-IT', { maximumFractionDigits: 6 }) : '—');
  const shown = rows.slice(0, 500);
  $('#dataTable').innerHTML =
    `<thead><tr>${cols.map((c) => `<th>${c.head}</th>`).join('')}</tr></thead>` +
    `<tbody>${shown.map((r) => `<tr>${cols.map((c) => `<td>${cell(r[c.key])}</td>`).join('')}</tr>`).join('') ||
      `<tr><td colspan="${cols.length}" class="hint">Ancora nessun dato.</td></tr>`}</tbody>`;
  $('#selTableNote').textContent = rows.length > 500 ? `Mostro le prime 500 righe di ${rows.length}: l'export le contiene tutte.` : '';
}

async function saveSelection() {
  if (state.running) { toast('Ferma la misura prima di salvare un tratto.'); return; }
  const rows = selectedRows().filter((r) => r.ok !== false);
  if (rows.length < 3) { toast('Il tratto contiene troppo pochi punti validi.'); return; }
  // le colonne vuote (es. sensore assente) non vengono portate in Elaborazione
  if (!state.session?.id) await autosave(true);
  // in Elaborazione vanno solo le grandezze fisiche (t, x, v, a, T…), non i dati tecnici del sensore
  const keys = state.exp.columns.map((c) => c.key).filter((k) => k !== 'ok' && !QUANTITIES[k]?.raw && rows.some((r) => isFinite(r[k])));
  const columns = keys.map((k) => ({ key: k, sym: QUANTITIES[k]?.sym ?? k, unit: QUANTITIES[k]?.unit ?? '', name: QUANTITIES[k]?.name ?? k }));
  const yView = state.view && !state.view.raw ? state.view : state.exp.views.find((v) => !v.raw);
  const t1 = rows[0].t, t2 = rows[rows.length - 1].t;
  const box = await addBox({
    title: `${state.exp.title} · ${fmtVal(t1, 2)}–${fmtVal(t2, 2)} s`,
    experiment: state.exp.id, expTitle: state.exp.title,
    sessionId: state.session?.id ?? null, sessionName: $('#sessionName').value.trim() || state.session?.name || '',
    t1, t2, columns, yKey: keys.includes(yView.key) ? yView.key : keys.find((k) => k !== 't'), xKey: 't',
    rows: rows.map((r) => Object.fromEntries(keys.map((k) => [k, isFinite(r[k]) ? r[k] : NaN]))),
  });
  renderSavedSelections();
  toast(`Tratto inviato (${rows.length} punti).`, 6000, { label: 'Vai a Elaborazione →', run: goElab });
  pulseNav(box.id);
}

function pulseNav() {
  const b = document.querySelector('.nav-btn[data-page="elab"]');
  b.classList.remove('pulse'); void b.offsetWidth; b.classList.add('pulse');
}

function renderSavedSelections() {
  const box = $('#savedSel');
  const list = state.session?.id ? boxesForSession(state.session.id) : [];
  $('#savedSelCount').textContent = list.length ? `(${list.length})` : '';
  if (!list.length) { box.innerHTML = '<p class="hint">Ancora nessuno.</p>'; return; }
  box.innerHTML = `<ul class="selist">${list.map((b) => `<li><span><b>${escapeHTML(b.title)}</b> <small>${b.rows.length} punti · ${b.analyses.length} analisi</small></span><button class="btn btn-small" data-open="${b.id}">Apri in Elaborazione →</button></li>`).join('')}</ul>`;
  box.querySelectorAll('[data-open]').forEach((btn) => btn.addEventListener('click', () => { showPage('elab'); setTimeout(() => focusBox(+btn.dataset.open), 50); }));
}

async function exportData(kind) {
  if (!state.rows.length) { toast('Non ci sono dati da esportare.'); return; }
  const cols = state.exp.columns;
  const headers = cols.map((c) => c.head);
  const sel = selectedRows();
  const rows = sel.map((r) => cols.map((c) => r[c.key]));
  const part = state.selection ? `_${fmtVal(state.selection[0], 2)}-${fmtVal(state.selection[1], 2)}s`.replace(/,/g, '.') : '';
  const base = `mosaicus_${state.exp.id}_${stamp(new Date(state.session?.created ?? Date.now()))}${part}`;
  if (kind === 'csv-it') return download(toCSV(headers, rows, { it: true }), `${base}_excel.csv`);
  if (kind === 'csv') return download(toCSV(headers, rows, { it: false }), `${base}.csv`);
  if (kind === 'png') return download(await stackPNG(), `${base}_grafici.png`);
  if (kind === 'xlsx') {
    const info = [
      ['Mosaicus', `v${APP_VERSION}`],
      ['Esperimento', `${state.exp.title} — ${state.exp.subtitle}`],
      ['Nome della misura', $('#sessionName').value || state.session?.name || ''],
      ['Data', new Date(state.session?.created ?? Date.now()).toLocaleString('it-IT')],
      ['Sorgente', state.session?.source === 'simulatore' ? 'simulatore' : `Arduino (firmware ${state.session?.fw ?? '?'})`],
      ['Tratto esportato', state.selection ? `${state.selection[0]} s – ${state.selection[1]} s` : 'tutta la misura'],
      [],
      ['Parametro', 'Valore', 'Unità'],
      ...state.exp.params.map((p) => [p.label, p.type === 'select' ? p.options.find((o) => o[0] === state.params[p.key])?.[1] : state.params[p.key], p.unit || '']),
    ];
    return download(toXLSX([{ name: 'Dati', rows: [headers, ...rows] }, { name: 'Info', rows: info }]), `${base}.xlsx`);
  }
}

/** Un'unica immagine con tutti i grafici impilati, come si vedono a schermo. */
function stackPNG() {
  group.charts.forEach((c) => c.draw());
  const cvs = group.charts.map((c) => c.c);
  const gap = Math.round(6 * (window.devicePixelRatio || 1));
  const out = document.createElement('canvas');
  out.width = Math.max(...cvs.map((c) => c.width));
  out.height = cvs.reduce((s, c) => s + c.height, 0) + gap * (cvs.length - 1);
  const g = out.getContext('2d');
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--chart-bg').trim() || '#ffffff';
  g.fillRect(0, 0, out.width, out.height);
  let y = 0; for (const c of cvs) { g.drawImage(c, 0, y); y += c.height + gap; }
  return new Promise((res) => out.toBlob(res, 'image/png'));
}

// ---------------- collegamento ----------------
function setStatus(text, cls) { const s = $('#status'); s.textContent = text; s.className = `pill ${cls}`; }
const simStatus = () => `Simulatore pronto · ${state.exp.title.toLowerCase()}${state.exp.sim === 'cooling' ? ' · tempo ×30' : ''}`;

function refreshButtons() {
  const connected = !!state.link;
  const audioOnly = state.exp?.source === 'audio';
  $('#btnConnect').hidden = connected || audioOnly; $('#btnSim').hidden = connected || audioOnly; $('#btnDisconnect').hidden = !connected;
  $('#status').hidden = audioOnly && !connected;
  $('#btnStart').disabled = !state.ready || state.running;
  $('#btnStop').disabled = !state.running;
  document.querySelectorAll('.exp-card').forEach((b) => (b.disabled = state.running));
  updateSelectionUI();
}

async function connect(kind) {
  const link = kind === 'sim' ? new SimulatedLink() : state.exp.source === 'phone' ? new PhoneLink() : new SerialLink();
  if (kind === 'sim') { link.scenario = state.exp.sim; link.scopeSignal = state.simSignal; }
  link.onLine(handleLine);
  link.onClose(() => {
    if (state.link !== link) return;
    const wasRunning = state.running;
    state.link = null; state.ready = false; state.running = false;
    setStatus('Nessun dispositivo', 'pill-off'); refreshButtons();
    instr?.linkChanged?.();
    if (wasRunning) { toast('Arduino scollegato durante la misura: salvo i dati raccolti.'); autosave(); }
  });
  try {
    await link.open();
  } catch (err) {
    if (err?.name !== 'NotFoundError') toast(link.kind === 'telefono' ? `Sensori non disponibili: ${err.message}` : `Impossibile aprire la porta: ${err.message}`, 5000);
    return;
  }
  state.link = link; state.ready = false;
  setStatus(kind === 'sim' ? 'Simulatore: avvio…' : link.kind === 'telefono' ? 'Telefono: avvio…' : 'Arduino: attendo il firmware…', 'pill-wait');
  refreshButtons();
  // L'Uno si riavvia quando si apre la porta: diamo tempo al bootloader, poi chiediamo l'identità.
  setTimeout(() => { if (state.link === link && !state.ready) link.write('ID?'); }, 2200);
  setTimeout(() => {
    if (state.link === link && !state.ready) {
      setStatus('Firmware non trovato', 'pill-err');
      toast('Arduino risponde, ma non con il firmware Mosaicus. Caricalo con l\'IDE di Arduino (cartella firmware).', 7000);
    }
  }, 5000);
}

function handleLine(line) {
  logSerial(line);
  if (line.startsWith('#MOSAICUS')) {
    state.ready = true; state.fw = line.split(',')[1];
    const k = state.link?.kind;
    if (k !== 'simulatore' && k !== 'telefono' && state.fw && cmpVersion(state.fw, FIRMWARE_VERSION) < 0) {
      toast(`Su Arduino c'è il firmware v${state.fw}: aggiornalo alla v${FIRMWARE_VERSION} (file mosaicus_firmware.ino, da caricare con l'IDE di Arduino).`, 9000);
    }
    setStatus(k === 'simulatore' ? simStatus() : k === 'telefono' ? 'Sensori del telefono pronti' : `Arduino pronto · firmware ${state.fw}`, 'pill-on');
    refreshButtons();
    return;
  }
  if (line.startsWith('#ERR')) {
    toast(state.link?.kind === 'telefono' ? `Telefono: ${line.slice(5)}`
      : line.includes('SCOPE') ? 'Il firmware su Arduino è vecchio: ricarica mosaicus_firmware.ino (versione 0.2 o successiva) con l\'IDE di Arduino.'
        : `Arduino non ha capito il comando: ${line.slice(5)}`, 7000);
    return;
  }
  if (line.startsWith('#')) return;
  if (instr?.onLine?.(line)) return;
  if (!state.running) return;
  if (line[0] === state.exp.lineType && line[1] === ',') {
    // un sensore può mancare (es. telefono senza giroscopio): basta che il tempo sia valido
    const f = line.slice(2).split(',').map((v) => (v === 'nan' ? NaN : Number(v)));
    if (isFinite(f[0])) { state.raw.push(f); scheduleRecompute(); }
  }
}

const logLines = [];
function logSerial(line) {
  if (line.length > 140) line = `${line.slice(0, 120)}… (${line.split(',').length} valori)`;
  logLines.push(line); if (logLines.length > 60) logLines.shift();
  const el = $('#serialLog');
  if (el.closest('details').open) el.textContent = logLines.join('\n');
}

// ---------------- misura ----------------
async function start() {
  if (!state.ready) return;
  state.raw = []; state.selection = null; group.setSelection(null); group.fitAll();
  const name = $('#sessionName').value.trim() || `${state.exp.title} ${new Date().toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })}`;
  state.session = { name, created: Date.now(), source: state.link.kind, fw: state.fw };
  $('#sessionName').value = name;
  state.running = true; refreshButtons();
  recompute();
  renderSavedSelections();
  if (state.link.kind === 'simulatore') state.link.scenario = state.exp.sim;
  await state.link.write(state.exp.command(state.params));
}

async function stop() {
  if (!state.running) return;
  state.running = false; refreshButtons();
  try { await state.link?.write('STOP'); } catch { /* scollegato */ }
  recompute();
  await autosave();
  showDragHint();
}

/** Suggerimento animato «trascina qui» sul primo grafico: compare le prime volte, sparisce al primo tocco. */
function showDragHint() {
  if (!state.rows.length || state.selection || state.running || state.exp.kind) return;
  const n = store.get('mosaicus.hint.drag', 0);
  if (n >= 3) return;
  const cell = document.querySelector('#chartStack .chart-cell');
  if (!cell || cell.querySelector('.drag-hint')) return;
  const h = document.createElement('div');
  h.className = 'drag-hint'; h.setAttribute('aria-hidden', 'true');
  h.innerHTML = '<span class="dh-band"></span><span class="dh-hand">👆</span><span class="dh-txt">trascina per scegliere un tratto</span>';
  cell.append(h);
  store.set('mosaicus.hint.drag', n + 1);
}
function hideDragHint(done = false) {
  document.querySelectorAll('.drag-hint').forEach((h) => h.remove());
  if (done) store.set('mosaicus.hint.drag', 3);
}

async function autosave(quiet = false) {
  if (!state.raw.length || !state.session) return;
  const rec = {
    ...(state.session.id ? { id: state.session.id } : {}),
    name: $('#sessionName').value.trim() || state.session.name,
    experiment: state.exp.id, created: state.session.created, source: state.session.source, fw: state.session.fw,
    params: { ...state.params }, raw: state.raw, app: APP_VERSION,
  };
  try {
    const id = await saveSession(rec);
    state.session.id = rec.id ?? id;
    if (!quiet) toast(`Misura salvata nel Quaderno (${state.raw.length} punti).`);
    renderSessions();
    renderSavedSelections();
  } catch (err) { toast(`Salvataggio non riuscito: ${err.message}`, 5000); }
}

function zeroPosition() {
  const valid = state.rows.filter((r) => r.ok && isFinite(r.d)).slice(-10).map((r) => r.d).sort((a, b) => a - b);
  if (!valid.length) { toast('Nessuna distanza valida da usare come origine.'); return; }
  const med = valid[valid.length >> 1];
  state.params.origin = Math.round(med * 1000) / 1000;
  store.set(`mosaicus.params.${state.exp.id}`, state.params);
  const inp = $('#param-origin'); if (inp) inp.value = state.params.origin;
  recompute();
  toast(`Origine impostata a ${fmtVal(state.params.origin, 3)} m dal sensore.`);
}

// ---------------- Quaderno delle misure ----------------
async function renderSessions() {
  const ul = $('#sessionList');
  let list = [];
  try { list = await listSessions(); } catch { ul.innerHTML = '<li class="hint">Il quaderno non è disponibile in questo browser.</li>'; return; }
  if (!list.length) { ul.innerHTML = '<li class="hint">Ancora nessuna misura.</li>'; return; }
  ul.innerHTML = '';
  for (const s of list) {
    const e = byId(s.experiment);
    const li = document.createElement('li');
    li.innerHTML = `<div><b>${escapeHTML(s.name)}</b><small>${e?.title ?? ''} · ${new Date(s.created).toLocaleString('it-IT', { dateStyle: 'short', timeStyle: 'short' })} · ${s.n} punti</small></div>`;
    const open = document.createElement('button'); open.className = 'btn btn-small'; open.textContent = 'Apri';
    open.addEventListener('click', () => openSession(s.id));
    const del = document.createElement('button'); del.className = 'btn btn-small btn-ghost'; del.textContent = 'Elimina';
    del.addEventListener('click', async () => {
      if (!confirm(`Eliminare definitivamente «${s.name}» dal quaderno? I tratti già salvati in Elaborazione restano.`)) return;
      await deleteSession(s.id);
      if (state.session?.id === s.id) state.session.id = undefined;
      renderSessions();
    });
    const actions = document.createElement('span'); actions.className = 'actions'; actions.append(open, del);
    li.appendChild(actions); ul.appendChild(li);
  }
}

async function openSession(id) {
  if (state.running) { toast('Ferma la misura prima di aprire una misura del quaderno.'); return; }
  const s = await getSession(id);
  if (!s) return;
  state.raw = [];
  showPage('misura');
  selectExperiment(s.experiment, { keepData: true });
  state.params = { ...defaultParams(state.exp), ...s.params };
  state.raw = s.raw;
  state.session = { id: s.id, name: s.name, created: s.created, source: s.source, fw: s.fw };
  $('#sessionName').value = s.name;
  renderParams();
  recompute();
  renderSavedSelections();
  showDragHint();
  toast(`Aperta «${s.name}». Se cambi i parametri, i dati vengono ricalcolati.`);
}

// ---------------- modalità LIM ----------------
/** Tema chiaro/scuro. Senza una scelta salvata segue la preferenza del sistema. */
const darkQuery = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
function applyTheme(dark) {
  document.documentElement.classList.toggle('dark', dark);
  const b = $('#btnTheme');
  b.textContent = dark ? '☀' : '☾';
  b.setAttribute('aria-pressed', String(dark));
  b.setAttribute('aria-label', dark ? 'Tema chiaro' : 'Tema scuro');
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#05201B' : '#004D43');
  group.refreshStyle();
  wbRefreshStyle();
  instr?.refreshStyle?.();
}
const savedTheme = () => store.get('mosaicus.theme', null);

function setLim(on) {
  document.documentElement.classList.toggle('lim', on);
  const b = $('#btnLim'); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
  store.set('mosaicus.lim', on);
  group.refreshStyle();
  wbRefreshStyle();
}

// ---------------- avvio ----------------
async function init() {
  window.__mosaicus = { state, group };   // aggancio per le prove automatiche e la registrazione dei video della guida
  setLim(store.get('mosaicus.lim', false));
  document.querySelectorAll('.appver').forEach((e) => (e.textContent = `v${APP_VERSION}`));
  applyTheme(savedTheme() ? savedTheme() === 'dark' : !!darkQuery?.matches);
  $('#btnTheme').addEventListener('click', () => {
    const dark = !document.documentElement.classList.contains('dark');
    store.set('mosaicus.theme', dark ? 'dark' : 'light');
    applyTheme(dark);
  });
  darkQuery?.addEventListener?.('change', (e) => { if (!savedTheme()) applyTheme(e.matches); });
  $('#btnLim').addEventListener('click', () => setLim(!document.documentElement.classList.contains('lim')));
  document.querySelectorAll('.nav-btn').forEach((b) => b.addEventListener('click', () => showPage(b.dataset.page)));
  // barra in basso (telefono): Esperimenti porta all'elenco, Misura al pannello, Elaborazione all'altra pagina
  document.querySelectorAll('.bottom-nav [data-go]').forEach((b) => b.addEventListener('click', () => {
    const go = b.dataset.go;
    if (go === 'elab') { showPage('elab'); return; }
    showPage('misura');
    const target = go === 'exp' ? document.querySelector('#expList').closest('.card') : document.querySelector('#page-misura .main');
    target.scrollIntoView({ block: 'start' });
  }));
  $('#backToMisura').addEventListener('click', () => showPage('misura'));
  $('#chartStack').addEventListener('pointerdown', () => hideDragHint(), true);

  if (window.matchMedia('(max-width: 700px)').matches) {
    document.querySelectorAll('#page-misura .side details').forEach((d) => { if (!d.classList.contains('topic')) d.open = false; });
  }
  await initWorkbench({
    toast,
    onCount: (n) => { $('#elabCount').textContent = n ? `(${n})` : ''; $('#elabCount2').textContent = n || ''; renderSavedSelections(); },
  });
  renderExperimentList();
  // su un telefono che non può collegare Arduino si parte dai sensori del telefono
  selectExperiment(store.get('mosaicus.lastExp', serialSupported() ? 'motion' : 'phoneAcc'));
  renderSessions();
  refreshButtons();
  showPage(store.get('mosaicus.page', 'misura') === 'elab' ? 'elab' : 'misura');

  $('#btnConnect').addEventListener('click', () => connect('serial'));
  $('#btnSim').addEventListener('click', () => connect('sim'));
  $('#btnDisconnect').addEventListener('click', async () => { if (state.running) await stop(); await state.link?.close(); });
  $('#btnStart').addEventListener('click', start);
  $('#btnStop').addEventListener('click', stop);
  $('#btnZero').addEventListener('click', zeroPosition);
  $('#zoomIn').addEventListener('click', () => group.zoomCenter(0.6));
  $('#zoomOut').addEventListener('click', () => group.zoomCenter(1 / 0.6));
  $('#zoomFit').addEventListener('click', () => group.fitAll());
  $('#zoomSel').addEventListener('click', () => { if (!group.zoomToSelection()) toast('Prima seleziona un tratto trascinando su un grafico.'); });
  $('#btnSaveSel').addEventListener('click', saveSelection);
  $('#btnClearSel').addEventListener('click', () => group.setSelection(null, true));
  $('#selTableBox').addEventListener('toggle', () => { if ($('#selTableBox').open) renderSelTable(); });
  $('#sessionName').addEventListener('change', async () => { if (state.session?.id && !state.running) await autosave(true); });
  document.querySelectorAll('[data-export]').forEach((b) => b.addEventListener('click', () => { $('#exportMenu').open = false; exportData(b.dataset.export); }));
  document.querySelector('#serialLog').closest('details').addEventListener('toggle', () => { $('#serialLog').textContent = logLines.join('\n'); });

  updateSourceUI();
  onGeneratorChange(updateGenChip);
  $('#genChip .gc-open').addEventListener('click', () => { showPage('misura'); selectExperiment('synth'); });
  $('#genChip .gc-stop').addEventListener('click', () => stopGenerator());
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline non disponibile */ });
  }
  window.addEventListener('beforeunload', (e) => { if (state.running) { e.preventDefault(); e.returnValue = ''; } });
}

init();
