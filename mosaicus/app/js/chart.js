// Mosaicus — grafici su <canvas>, senza librerie esterne.
//
// ChartGroup collega più grafici impilati che condividono l'asse dei tempi:
// stesso intervallo visibile (zoom), stessa selezione, stesso mirino.
// Interazioni: trascinare = selezionare un intervallo · doppio clic = annullare
// la selezione · pizzico sul trackpad / due dita sulla LIM / Ctrl+rotella = zoom
// · scorrimento orizzontale o due dita = spostarsi lungo il tempo.
//
// Strumenti (pagina Elaborazione): con chart.tool = 'pick' un clic sceglie il punto
// misurato più vicino (onPick) e i punti già scelti si possono trascinare (onAnchorMove),
// sempre agganciati ai dati. chart.overlays disegna rette, triangoli Δy/Δx, punti, curve.

const PAD = { l: 64, r: 18, t: 14, b: 46 };
const PAD_COMPACT_B = 10;
const FONT = "'Plus Jakarta Sans', system-ui, -apple-system, 'Segoe UI', sans-serif";

// =====================================================================
export class ChartGroup {
  constructor({ onSelect, onActivate, includeZero = true } = {}) {
    this.charts = [];
    this.includeZero = includeZero;
    this.xRange = null;     // null = adatta ai dati
    this.selection = null;  // [t1, t2]
    this.hoverT = null;
    this.onSelect = onSelect;
    this.onActivate = onActivate;
    const loop = () => {
      for (const c of this.charts) if (c._dirty) c.draw();
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  add(chart) { this.charts.push(chart); chart.group = this; return chart; }
  clear() { for (const c of this.charts) c.destroy(); this.charts = []; }
  invalidate() { for (const c of this.charts) c.invalidate(); }
  refreshStyle() { for (const c of this.charts) c.refreshStyle(); }

  /** Estensione dei tempi di tutti i dati (con lo 0 incluso, come in partenza). */
  dataExtent() {
    let x0 = Infinity, x1 = -Infinity;
    for (const c of this.charts) for (const s of c.series) for (const x of s.x) {
      if (isFinite(x)) { if (x < x0) x0 = x; if (x > x1) x1 = x; }
    }
    if (!isFinite(x0)) return [0, 10];
    if (this.includeZero) x0 = Math.min(0, x0);
    if (x1 - x0 < 1e-9) x1 = x0 + 1;
    return [x0, x1];
  }
  currentRange() { return this.xRange ?? this.dataExtent(); }

  setRange(a, b) {
    const [d0, d1] = this.dataExtent();
    const span = d1 - d0;
    let w = b - a;
    if (w >= span * 1.001) { this.xRange = null; this.invalidate(); return; }
    w = Math.max(w, span * 1e-4, 1e-6);
    // non uscire dai dati
    if (a < d0) { a = d0; } if (a + w > d1) { a = d1 - w; }
    this.xRange = [a, a + w];
    this.invalidate();
  }
  zoomAt(t, factor) {
    const [a, b] = this.currentRange();
    const f = (t - a) / (b - a);
    const w = (b - a) * factor;
    this.setRange(t - f * w, t - f * w + w);
  }
  zoomCenter(factor) { const [a, b] = this.currentRange(); this.zoomAt((a + b) / 2, factor); }
  pan(dt) { const [a, b] = this.currentRange(); this.setRange(a + dt, b + dt); }
  fitAll() { this.xRange = null; this.invalidate(); }
  zoomToSelection() {
    if (!this.selection) return false;
    const [a, b] = this.selection, m = (b - a) * 0.05;
    this.setRange(a - m, b + m);
    return true;
  }
  setSelection(sel, notify = false) {
    this.selection = sel; this.invalidate();
    if (notify && this.onSelect) this.onSelect(sel);
  }
  setHover(t) { this.hoverT = t; this.invalidate(); }
}

// =====================================================================
export class Chart {
  constructor(canvas, { compact = false } = {}) {
    this.c = canvas;
    this.ctx = canvas.getContext('2d');
    this.compact = compact;     // grafico intermedio della pila: niente etichette dell'asse t
    this.series = [];
    this.fit = null;
    this.xLabel = '';
    this.yLabel = '';
    this.group = null;
    this.overlays = [];      // disegni sopra i dati: segment, triangle, anchor, curve
    this.tool = 'select';    // 'select' | 'pick'
    this.onPick = null;      // (indice del punto) => void
    this.onAnchorMove = null;// (id dell'ancora, indice del punto) => void   — ancore agganciate ai dati
    this.onAnchorDrag = null;// (id dell'ancora, x, y) => void               — ancore libere (free: true)
    this.onClickXY = null;   // (x, y) => void: clic sul grafico in coordinate dei dati (se definito, sostituisce onPick)
    this.hover = null;
    this._drag = null;
    this._pointers = new Map();
    this._pinch = null;
    this._bounds = null;
    this._dirty = true;
    this._css = getComputedStyle(document.documentElement);
    this.refreshStyle(false);

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
    canvas.addEventListener('pointerdown', (e) => this._down(e));
    canvas.addEventListener('pointermove', (e) => this._move(e));
    canvas.addEventListener('pointerup', (e) => this._up(e));
    canvas.addEventListener('pointercancel', (e) => this._up(e));
    canvas.addEventListener('pointerleave', () => { this.hover = null; this.group?.setHover(null); });
    canvas.addEventListener('dblclick', () => { if (this.tool === 'select') this.group?.setSelection(null, true); });
    canvas.addEventListener('wheel', (e) => this._wheel(e), { passive: false });
    this.resize();
    document.fonts?.ready.then(() => this.invalidate()); // ridisegna quando il font è pronto
  }

  destroy() { this._ro.disconnect(); this._dead = true; }

  /** Scala testi e margini con la dimensione del font della radice (modalità LIM). */
  refreshStyle(redraw = true) {
    const k = (parseFloat(this._css.fontSize) || 15) / 15;
    this.k = k;
    this.pad = { l: PAD.l * k, r: PAD.r * k, t: PAD.t * k, b: (this.compact ? PAD_COMPACT_B : PAD.b) * k };
    if (redraw) this.resize();
  }

  color(name) { return this._css.getPropertyValue(name).trim() || '#333'; }

  resize() {
    const r = this.c.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * dpr));
    this.c.height = Math.max(1, Math.round(r.height * dpr));
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    this.invalidate();
  }

  invalidate() { if (!this._dead) this._dirty = true; }

  setData({ series, xLabel, yLabel }) {
    this.series = series; this.xLabel = xLabel; this.yLabel = yLabel;
    this.group ? this.group.invalidate() : this.invalidate();
  }
  setFit(fit) { this.fit = fit; this.invalidate(); }
  setOverlays(list) { this.overlays = list || []; this.invalidate(); }

  /** Indice del punto della prima serie più vicino (in pixel) a (px, py). */
  nearestIndex(px, py, maxDist = Infinity) {
    const s = this.series[0]; if (!s || !this._bounds) return -1;
    let best = -1, bd = maxDist * maxDist;
    for (let i = 0; i < s.x.length; i++) {
      if (!isFinite(s.x[i]) || !isFinite(s.y[i])) continue;
      const dx = this.sx(s.x[i]) - px, dy = this.sy(s.y[i]) - py, d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }

  // ---------- geometria ----------
  computeBounds() {
    const [x0, x1] = this.group ? this.group.currentRange() : [0, 1];
    let y0 = Infinity, y1 = -Infinity;
    for (const s of this.series) {
      for (let i = 0; i < s.x.length; i++) {
        const x = s.x[i], y = s.y[i];
        if (!isFinite(x) || !isFinite(y) || x < x0 || x > x1) continue;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (!isFinite(y0)) { y0 = 0; y1 = 1; }
    if (y1 - y0 < 1e-9) { const m = Math.abs(y0) * 0.05 || 0.5; y0 -= m; y1 += m; }
    const py = (y1 - y0) * 0.08;
    return { x0, x1, y0: y0 - py, y1: y1 + py };
  }
  plotW() { return this.w - this.pad.l - this.pad.r; }
  plotH() { return this.h - this.pad.t - this.pad.b; }
  sx(x) { const b = this._bounds; return this.pad.l + ((x - b.x0) / (b.x1 - b.x0)) * this.plotW(); }
  sy(y) { const b = this._bounds; return this.h - this.pad.b - ((y - b.y0) / (b.y1 - b.y0)) * this.plotH(); }
  ix(px) { const b = this._bounds; return b.x0 + ((px - this.pad.l) / this.plotW()) * (b.x1 - b.x0); }
  iy(py) { const b = this._bounds; return b.y0 + ((this.h - this.pad.b - py) / this.plotH()) * (b.y1 - b.y0); }
  /** Passo della griglia (in unità dei dati) sui due assi, come disegnata. */
  gridSteps() {
    const b = this._bounds, k = this.k;
    return {
      x: niceTicks(b.x0, b.x1, Math.max(3, Math.floor(this.plotW() / (90 * k)))).step,
      y: niceTicks(b.y0, b.y1, Math.max(2, Math.floor(this.plotH() / (42 * k)))).step,
    };
  }

  // ---------- disegno ----------
  draw() {
    this._dirty = false;
    if (this._dead || !this.w) return;
    const g = this.ctx, dpr = this.dpr, k = this.k;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, this.w, this.h);
    g.fillStyle = this.color('--chart-bg');
    g.fillRect(0, 0, this.w, this.h);
    const b = (this._bounds = this.computeBounds());
    const font = `500 ${12 * k}px ${FONT}`;
    g.font = font;
    const top = this.pad.t, bottom = this.h - this.pad.b;

    // selezione (condivisa)
    const sel = this.group?.selection;
    if (sel) {
      g.fillStyle = this.color('--sel');
      const a = this.sx(sel[0]), c = this.sx(sel[1]);
      g.fillRect(Math.min(a, c), top, Math.abs(c - a), bottom - top);
    }

    // griglia e tacche
    g.strokeStyle = this.color('--grid'); g.fillStyle = this.color('--muted'); g.lineWidth = 1;
    // margine sinistro adattivo: abbastanza largo per le etichette dell'asse verticale
    const yt = niceTicks(b.y0, b.y1, Math.max(2, Math.floor(this.plotH() / (42 * k))));
    const wLab = Math.max(...yt.values.map((v) => g.measureText(tickLabel(v, yt.step)).width), 0);
    this._wantL = Math.max(PAD.l * k, wLab + 46 * k);
    let L = this._wantL;
    if (this.group) {
      // nei grafici impilati il margine è uguale per tutti: i tempi restano allineati in verticale
      L = Math.max(...this.group.charts.map((c) => c._wantL || 0));
      if (L !== this._lastGroupL) { this._lastGroupL = L; this.group.charts.forEach((c) => { if (c !== this) c.invalidate(); }); }
    }
    this.pad.l = L;
    const xt = niceTicks(b.x0, b.x1, Math.max(3, Math.floor(this.plotW() / (90 * k))));
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const v of xt.values) {
      const X = Math.round(this.sx(v)) + 0.5;
      g.beginPath(); g.moveTo(X, top); g.lineTo(X, bottom); g.stroke();
      if (!this.compact) g.fillText(tickLabel(v, xt.step), X, bottom + 6 * k);
    }
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const v of yt.values) {
      const Y = Math.round(this.sy(v)) + 0.5;
      g.beginPath(); g.moveTo(this.pad.l, Y); g.lineTo(this.w - this.pad.r, Y); g.stroke();
      g.fillText(tickLabel(v, yt.step), this.pad.l - 8 * k, Y);
    }
    // cornice ed etichette degli assi
    g.strokeStyle = this.color('--axis'); g.lineWidth = 1.2;
    g.strokeRect(this.pad.l + 0.5, top + 0.5, this.plotW(), bottom - top);
    g.fillStyle = this.color('--ink');
    g.font = `500 ${13 * k}px ${FONT}`;
    if (!this.compact) {
      g.textAlign = 'center'; g.textBaseline = 'bottom';
      g.fillText(this.xLabel, this.pad.l + this.plotW() / 2, this.h - 6);
    }
    g.save(); g.translate(14 * k, top + (bottom - top) / 2); g.rotate(-Math.PI / 2);
    g.textAlign = 'center'; g.textBaseline = 'top'; g.fillText(this.yLabel, 0, 0); g.restore();

    // area dati (ritaglio)
    g.save();
    g.beginPath(); g.rect(this.pad.l, top, this.plotW(), bottom - top); g.clip();
    for (const s of this.series) {
      g.strokeStyle = g.fillStyle = s.color || this.color('--accent');
      if (s.mode !== 'points') {
        g.lineWidth = (s.width || 1.6) * Math.sqrt(k); g.beginPath();
        let pen = false;
        for (let i = 0; i < s.x.length; i++) {
          if (!isFinite(s.y[i]) || !isFinite(s.x[i])) { pen = false; continue; }
          const X = this.sx(s.x[i]), Y = this.sy(s.y[i]);
          pen ? g.lineTo(X, Y) : g.moveTo(X, Y); pen = true;
        }
        g.stroke();
      }
      if (s.mode !== 'line') {
        const visible = s.x.filter((x) => x >= b.x0 && x <= b.x1).length;
        const r = (visible > 1500 ? 1.4 : 2.6) * Math.sqrt(k);
        for (let i = 0; i < s.x.length; i++) {
          if (!isFinite(s.y[i]) || !isFinite(s.x[i]) || s.x[i] < b.x0 || s.x[i] > b.x1) continue;
          g.beginPath(); g.arc(this.sx(s.x[i]), this.sy(s.y[i]), r, 0, 2 * Math.PI); g.fill();
        }
      }
    }
    if (this.fit) {
      g.strokeStyle = this.color('--fit'); g.lineWidth = 2.8 * Math.sqrt(k); g.setLineDash([7, 4]);
      g.beginPath();
      this.fit.x.forEach((x, i) => { const X = this.sx(x), Y = this.sy(this.fit.y[i]); i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
      g.stroke(); g.setLineDash([]);
    }
    this._drawOverlays(g, b, k, top, bottom);
    // mirino condiviso: linea verticale all'istante sotto il puntatore
    const ht = this.group?.hoverT;
    if (ht != null && ht >= b.x0 && ht <= b.x1) {
      const X = Math.round(this.sx(ht)) + 0.5;
      g.strokeStyle = this.color('--ink'); g.globalAlpha = 0.35; g.lineWidth = 1; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(X, top); g.lineTo(X, bottom); g.stroke();
      g.setLineDash([]); g.globalAlpha = 1;
    }
    g.restore();

    // lettura del punto più vicino all'istante del mirino (su tutti i grafici)
    if (ht != null && this.series[0]) {
      const s = this.series[0];
      let best = -1, bd = Infinity;
      for (let i = 0; i < s.x.length; i++) {
        if (!isFinite(s.y[i])) continue;
        const d = Math.abs(s.x[i] - ht);
        if (d < bd) { bd = d; best = i; }
      }
      if (best >= 0 && Math.abs(this.sx(s.x[best]) - this.sx(ht)) < 30 * k) {
        const X = this.sx(s.x[best]), Y = this.sy(s.y[best]);
        g.strokeStyle = this.color('--ink'); g.lineWidth = 1.5;
        g.beginPath(); g.arc(X, Y, 5 * Math.sqrt(k), 0, 2 * Math.PI); g.stroke();
        const txt = this.hover ? `${this.xSym || 't'} = ${fmtNum(s.x[best])}   ${s.label || 'y'} = ${fmtNum(s.y[best])}` : `${s.label || 'y'} = ${fmtNum(s.y[best])}`;
        g.font = font;
        const tw = g.measureText(txt).width + 14 * k, th = 22 * k;
        let bx = X + 10 * k; if (bx + tw > this.w - this.pad.r) bx = X - 10 * k - tw;
        bx = Math.max(this.pad.l, bx);
        const by = Math.min(Math.max(top + 4, Y - th - 8 * k), bottom - th - 2);
        g.fillStyle = this.color('--tip-bg'); g.fillRect(bx, by, tw, th);
        g.fillStyle = this.color('--tip-ink'); g.textAlign = 'left'; g.textBaseline = 'middle';
        g.fillText(txt, bx + 7 * k, by + th / 2);
      }
    }
  }

  _drawOverlays(g, b, k, top, bottom) {
    const L = this.pad.l, R = this.w - this.pad.r;
    for (const o of this.overlays) {
      g.save();
      g.strokeStyle = g.fillStyle = o.color || this.color('--fit');
      g.lineWidth = (o.width || 2.2) * Math.sqrt(k);
      if (o.dash) g.setLineDash(o.dash);
      if (o.type === 'segment') {
        let { x1, y1, x2, y2 } = o;
        if (o.extend && x2 !== x1) {           // retta estesa a tutto il grafico
          const m = (y2 - y1) / (x2 - x1);
          const xa = b.x0, xb = b.x1;
          y1 = y1 + m * (xa - x1); x1 = xa; y2 = y1 + m * (xb - xa); x2 = xb;
        }
        g.beginPath(); g.moveTo(this.sx(x1), this.sy(y1)); g.lineTo(this.sx(x2), this.sy(y2)); g.stroke();
      } else if (o.type === 'curve') {
        g.beginPath();
        o.x.forEach((x, i) => { const X = this.sx(x), Y = this.sy(o.y[i]); i ? g.lineTo(X, Y) : g.moveTo(X, Y); });
        g.stroke();
      } else if (o.type === 'triangle') {
        // cateti del triangolo: Δx orizzontale, Δy verticale
        const X1 = this.sx(o.x1), Y1 = this.sy(o.y1), X2 = this.sx(o.x2), Y2 = this.sy(o.y2);
        g.setLineDash([]); g.lineWidth = 1.8 * Math.sqrt(k);
        g.beginPath(); g.moveTo(X1, Y1); g.lineTo(X2, Y1); g.lineTo(X2, Y2); g.stroke();
        g.font = `500 ${12.5 * k}px ${FONT}`;
        const pill = (txt, cx, cy, align) => {
          const tw = g.measureText(txt).width + 12 * k, th = 20 * k;
          let bx = align === 'center' ? cx - tw / 2 : align === 'left' ? cx : cx - tw;
          bx = Math.min(Math.max(bx, L + 2), R - tw - 2);
          const by = Math.min(Math.max(cy - th / 2, top + 2), bottom - th - 2);
          g.fillStyle = this.color('--card'); g.globalAlpha = 0.92; g.fillRect(bx, by, tw, th); g.globalAlpha = 1;
          g.strokeStyle = o.color || this.color('--fit'); g.lineWidth = 1; g.strokeRect(bx + 0.5, by + 0.5, tw - 1, th - 1);
          g.fillStyle = this.color('--ink'); g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(txt, bx + 6 * k, by + th / 2);
        };
        if (o.dxLabel) pill(o.dxLabel, (X1 + X2) / 2, Y1 + (Y2 < Y1 ? 14 : -14) * k, 'center');
        if (o.dyLabel) pill(o.dyLabel, X2 + (X2 >= X1 ? 8 : -8) * k, (Y1 + Y2) / 2, X2 >= X1 ? 'left' : 'right');
      } else if (o.type === 'vline') {
        // cursore verticale (righello): linea a tutta altezza, maniglia in basso, etichetta in alto
        const X = Math.round(this.sx(o.x)) + 0.5, r = 9 * Math.sqrt(k);
        g.setLineDash([]); g.lineWidth = 2 * Math.sqrt(k);
        g.beginPath(); g.moveTo(X, top); g.lineTo(X, bottom); g.stroke();
        g.globalAlpha = 0.18; g.beginPath(); g.arc(X, bottom - r * 1.6, r * 1.9, 0, 2 * Math.PI); g.fill(); g.globalAlpha = 1;
        g.beginPath(); g.arc(X, bottom - r * 1.6, r, 0, 2 * Math.PI); g.fill();
        g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.stroke();
        if (o.label) {
          g.font = `500 ${13 * k}px ${FONT}`; g.fillStyle = o.color || this.color('--fit');
          g.textAlign = X > R - 30 * k ? 'right' : 'left'; g.textBaseline = 'top';
          g.fillText(o.label, X + (g.textAlign === 'left' ? 5 : -5) * k, top + 4 * k);
        }
      } else if (o.type === 'span') {
        // intervallo tra due cursori con la freccia ↔ e la scritta
        const X1 = this.sx(o.x1), X2 = this.sx(o.x2), Y = top + 30 * k;
        g.globalAlpha = 0.12; g.fillRect(Math.min(X1, X2), top, Math.abs(X2 - X1), bottom - top); g.globalAlpha = 1;
        g.setLineDash([]); g.lineWidth = 1.6 * Math.sqrt(k);
        g.beginPath(); g.moveTo(X1, Y); g.lineTo(X2, Y); g.stroke();
        const ah = 6 * k, s = X2 >= X1 ? 1 : -1;
        g.beginPath(); g.moveTo(X1 + s * ah, Y - ah * 0.6); g.lineTo(X1, Y); g.lineTo(X1 + s * ah, Y + ah * 0.6); g.stroke();
        g.beginPath(); g.moveTo(X2 - s * ah, Y - ah * 0.6); g.lineTo(X2, Y); g.lineTo(X2 - s * ah, Y + ah * 0.6); g.stroke();
        if (o.label) {
          g.font = `500 ${12.5 * k}px ${FONT}`;
          const tw = g.measureText(o.label).width + 12 * k, th = 20 * k;
          const bx = Math.min(Math.max((X1 + X2) / 2 - tw / 2, L + 2), R - tw - 2), by = Y + 6 * k;
          g.fillStyle = this.color('--card'); g.globalAlpha = 0.92; g.fillRect(bx, by, tw, th); g.globalAlpha = 1;
          g.strokeStyle = o.color; g.lineWidth = 1; g.strokeRect(bx + 0.5, by + 0.5, tw - 1, th - 1);
          g.fillStyle = this.color('--ink'); g.textAlign = 'left'; g.textBaseline = 'middle'; g.fillText(o.label, bx + 6 * k, by + th / 2);
        }
      } else if (o.type === 'anchor' && o.handle) {
        const X = this.sx(o.x), Y = this.sy(o.y), r = 9 * Math.sqrt(k);
        g.setLineDash([]);
        g.fillStyle = o.color || this.color('--green'); g.globalAlpha = 0.18;
        g.beginPath(); g.arc(X, Y, r * 1.9, 0, 2 * Math.PI); g.fill(); g.globalAlpha = 1;
        g.beginPath(); g.arc(X, Y, r, 0, 2 * Math.PI); g.fill();
        g.strokeStyle = '#ffffff'; g.lineWidth = 2; g.stroke();
      } else if (o.type === 'anchor') {
        const X = this.sx(o.x), Y = this.sy(o.y), r = 7 * Math.sqrt(k);
        g.setLineDash([]);
        g.fillStyle = '#ffffff'; g.beginPath(); g.arc(X, Y, r, 0, 2 * Math.PI); g.fill();
        g.strokeStyle = o.color || this.color('--fit'); g.lineWidth = 3 * Math.sqrt(k);
        g.beginPath(); g.arc(X, Y, r, 0, 2 * Math.PI); g.stroke();
        if (o.label) {
          g.font = `500 ${13 * k}px ${FONT}`; g.fillStyle = o.color || this.color('--fit');
          g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText(o.label, X + r + 2, Y - r);
        }
      }
      g.restore();
    }
  }

  // ---------- interazione ----------
  _pos(e) { const r = this.c.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top }; }

  _down(e) {
    if (!this._bounds || !this.group) return;
    this.group.onActivate?.(this);
    const p = this._pos(e);
    this._pointers.set(e.pointerId, p);
    this.c.setPointerCapture(e.pointerId);
    if (this._pointers.size === 2) {
      // due dita: zoom e spostamento (annulla un'eventuale selezione in corso)
      this._drag = null;
      const [p1, p2] = [...this._pointers.values()];
      const mid = (p1.px + p2.px) / 2;
      this._pinch = { d0: Math.max(20, Math.abs(p1.px - p2.px)), t0: this.ix(mid), range0: this.group.currentRange() };
      return;
    }
    if (p.px < this.pad.l) return;
    if (this.tool === 'pick') {
      // vicino a un punto già scelto? allora lo si trascina
      const r = 22 * this.k; // generoso: si prende anche col dito
      const a = this.overlays.find((o) => o.type === 'anchor' && o.id && Math.hypot(this.sx(o.x) - p.px, this.sy(o.y) - p.py) < r)
        || this.overlays.find((o) => o.type === 'vline' && o.id && Math.abs(this.sx(o.x) - p.px) < r * 0.8);
      this._pick = { px: p.px, py: p.py, anchor: a ? a.id : null, free: !!a?.free || a?.type === 'vline', moved: false };
      return;
    }
    this._drag = { x: this.ix(p.px), moved: false };
  }

  _move(e) {
    const p = this._pos(e);
    if (this._pointers.has(e.pointerId)) this._pointers.set(e.pointerId, p);
    if (this._pinch && this._pointers.size === 2) {
      const [p1, p2] = [...this._pointers.values()];
      const d = Math.max(20, Math.abs(p1.px - p2.px));
      const [a0, b0] = this._pinch.range0;
      const w = (b0 - a0) * (this._pinch.d0 / d);
      const frac = ((p1.px + p2.px) / 2 - this.pad.l) / this.plotW();
      const a = this._pinch.t0 - frac * w;
      this.group.setRange(a, a + w);
      return;
    }
    this.hover = p;
    this.group?.setHover(p.px >= this.pad.l ? this.ix(p.px) : null);
    if (this._pick) {
      if (Math.hypot(p.px - this._pick.px, p.py - this._pick.py) > 4) this._pick.moved = true;
      if (this._pick.anchor && this._pick.moved) {
        if (this._pick.free && this.onAnchorDrag) {
          const px = Math.min(Math.max(p.px, this.pad.l), this.w - this.pad.r);
          const py = Math.min(Math.max(p.py, this.pad.t), this.h - this.pad.b);
          this.onAnchorDrag(this._pick.anchor, this.ix(px), this.iy(py));
        } else if (this.onAnchorMove) {
          const i = this.nearestIndex(p.px, p.py);
          if (i >= 0) this.onAnchorMove(this._pick.anchor, i);
        }
      }
      return;
    }
    if (this._drag) {
      const x = this.ix(p.px);
      if (Math.abs(this.sx(x) - this.sx(this._drag.x)) > 4) this._drag.moved = true;
      if (this._drag.moved) this.group.setSelection([this._drag.x, x]);
    }
  }

  _up(e) {
    this._pointers.delete(e.pointerId);
    if (this._pointers.size < 2) this._pinch = null;
    if (this._pick) {
      const pk = this._pick; this._pick = null;
      if (!pk.moved && !pk.anchor && this.onClickXY) { this.onClickXY(this.ix(pk.px), this.iy(pk.py)); return; }
      if (!pk.moved && !pk.anchor && this.onPick) {
        const i = this.nearestIndex(pk.px, pk.py, 60 * this.k);
        if (i >= 0) this.onPick(i);
      }
      return;
    }
    if (this._drag && this._drag.moved && this.group.selection) {
      const [a, b] = this.group.selection;
      this.group.setSelection([Math.min(a, b), Math.max(a, b)], true);
    }
    this._drag = null;
  }

  _wheel(e) {
    if (!this._bounds || !this.group) return;
    // Pizzico sul trackpad (arriva come rotella con ctrlKey) o Ctrl/Cmd + rotella: zoom.
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      const t = this.ix(this._pos(e).px);
      this.group.zoomAt(t, Math.exp(e.deltaY * 0.01));
      return;
    }
    // Scorrimento orizzontale (trackpad o Maiusc+rotella): spostamento nel tempo.
    const dx = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.shiftKey ? e.deltaY : 0;
    if (dx && this.group.xRange) {
      e.preventDefault();
      const [a, b] = this.group.currentRange();
      this.group.pan((dx / this.plotW()) * (b - a));
    }
    // altrimenti la rotella fa scorrere la pagina, come al solito
  }
}

// ---------- utilità ----------
export function niceTicks(lo, hi, maxTicks) {
  const span = hi - lo;
  const raw = span / Math.max(1, maxTicks);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 2.5 ? 2.5 : norm <= 5 ? 5 : 10) * mag;
  const values = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + step * 1e-9; v += step) values.push(Math.abs(v) < step * 1e-9 ? 0 : v);
  return { values, step };
}
function tickLabel(v, step) {
  const d = Math.max(0, -Math.floor(Math.log10(step)) + (step / Math.pow(10, Math.floor(Math.log10(step))) === 2.5 ? 1 : 0));
  return v.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d });
}
function fmtNum(x) {
  if (!isFinite(x)) return '—';
  const a = Math.abs(x);
  const d = a >= 100 ? 1 : a >= 10 ? 2 : 3;
  return x.toLocaleString('it-IT', { maximumFractionDigits: d });
}
