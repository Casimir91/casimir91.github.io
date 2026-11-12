// Mosaicus — schermo da oscilloscopio (canvas): reticolo a divisioni, tracce luminose,
// etichette di scala. Usato per la forma d'onda e per lo spettro.

const FONT = '"Plus Jakarta Sans", system-ui, sans-serif';

export class Screen {
  constructor(canvas, { divX = 10, divY = 8 } = {}) {
    this.c = canvas; this.g = canvas.getContext('2d');
    this.divX = divX; this.divY = divY;
    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas);
    this.resize();
  }
  destroy() { this._ro.disconnect(); }
  resize() {
    const r = this.c.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    this.c.width = Math.max(1, Math.round(r.width * dpr)); this.c.height = Math.max(1, Math.round(r.height * dpr));
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    if (this.last) this.draw(this.last);
  }

  /**
   * frame = {
   *   x0, x1, y0, y1                  intervalli mostrati
   *   xLabel, yLabel                  es. '2 ms/div', 'u.a.'
   *   traces: [{ x, y, color, width, glow, fill }]
   *   markers: [{ x, label, color }]  tacche verticali (armoniche, cursori)
   *   note: testo in alto a destra
   * }
   */
  draw(frame) {
    this.last = frame;
    const { g, dpr } = this;
    if (!this.w) return;
    const k = (parseFloat(getComputedStyle(document.documentElement).fontSize) || 15) / 15;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = this.w, H = this.h;
    const pad = { l: 8 * k, r: 8 * k, t: 8 * k, b: 22 * k };
    const pw = W - pad.l - pad.r, ph = H - pad.t - pad.b;
    // fondo
    g.fillStyle = '#00302A'; g.fillRect(0, 0, W, H);
    const grd = g.createRadialGradient(W / 2, H / 2, 10, W / 2, H / 2, Math.max(W, H) * 0.7);
    grd.addColorStop(0, 'rgba(198,244,50,0.07)'); grd.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = grd; g.fillRect(0, 0, W, H);
    // reticolo
    g.strokeStyle = 'rgba(198,244,50,0.16)'; g.lineWidth = 1;
    for (let i = 0; i <= this.divX; i++) { const X = Math.round(pad.l + (pw * i) / this.divX) + 0.5; g.beginPath(); g.moveTo(X, pad.t); g.lineTo(X, pad.t + ph); g.stroke(); }
    for (let j = 0; j <= this.divY; j++) { const Y = Math.round(pad.t + (ph * j) / this.divY) + 0.5; g.beginPath(); g.moveTo(pad.l, Y); g.lineTo(pad.l + pw, Y); g.stroke(); }
    // assi centrali con tacchette fini
    g.strokeStyle = 'rgba(198,244,50,0.32)';
    const cx = Math.round(pad.l + pw / 2) + 0.5, cy = Math.round(pad.t + ph / 2) + 0.5;
    if (frame.centerX !== false) { g.beginPath(); g.moveTo(cx, pad.t); g.lineTo(cx, pad.t + ph); g.stroke(); }
    if (frame.centerY !== false) { g.beginPath(); g.moveTo(pad.l, cy); g.lineTo(pad.l + pw, cy); g.stroke(); }
    for (let i = 0; i <= this.divX * 5; i++) { const X = Math.round(pad.l + (pw * i) / (this.divX * 5)) + 0.5; g.beginPath(); g.moveTo(X, cy - 3); g.lineTo(X, cy + 3); g.stroke(); }

    const { x0, x1, y0, y1 } = frame;
    const sx = (x) => pad.l + ((x - x0) / (x1 - x0)) * pw;
    const sy = (y) => pad.t + ph - ((y - y0) / (y1 - y0)) * ph;
    this.map = { sx, sy, pad, pw, ph, ix: (px) => x0 + ((px - pad.l) / pw) * (x1 - x0) };

    g.save(); g.beginPath(); g.rect(pad.l, pad.t, pw, ph); g.clip();
    for (const m of frame.markers || []) {
      const X = sx(m.x); if (X < pad.l || X > pad.l + pw) continue;
      g.strokeStyle = m.color || 'rgba(255,255,255,0.5)'; g.setLineDash(m.dash || [3, 4]); g.lineWidth = m.width || 1;
      g.beginPath(); g.moveTo(X, pad.t); g.lineTo(X, pad.t + ph); g.stroke(); g.setLineDash([]);
      if (m.label) {
        g.font = `800 ${11 * k}px ${FONT}`; g.fillStyle = m.color || '#fff'; g.textAlign = 'center'; g.textBaseline = 'top';
        g.fillText(m.label, X, pad.t + 3 * k + (m.row || 0) * 13 * k);
      }
    }
    for (const t of frame.traces || []) {
      if (!t.x?.length) continue;
      g.lineJoin = 'round';
      g.strokeStyle = t.color; g.lineWidth = (t.width || 1.8) * Math.sqrt(k);
      if (t.glow) { g.shadowColor = t.color; g.shadowBlur = 8 * k; }
      g.beginPath();
      let pen = false;
      for (let i = 0; i < t.x.length; i++) {
        const X = sx(t.x[i]), Y = sy(t.y[i]);
        if (!isFinite(Y)) { pen = false; continue; }
        pen ? g.lineTo(X, Y) : g.moveTo(X, Y); pen = true;
      }
      g.stroke(); g.shadowBlur = 0;
      if (t.fill) {
        g.lineTo(sx(t.x[t.x.length - 1]), sy(y0)); g.lineTo(sx(t.x[0]), sy(y0)); g.closePath();
        g.fillStyle = t.fill; g.fill();
      }
    }
    g.restore();

    // scritte di scala
    g.font = `700 ${11.5 * k}px ${FONT}`; g.fillStyle = 'rgba(198,244,50,0.85)';
    g.textBaseline = 'middle';
    g.textAlign = 'left'; g.fillText(frame.xLabel || '', pad.l, H - pad.b / 2);
    g.textAlign = 'right'; g.fillText(frame.yLabel || '', W - pad.r, H - pad.b / 2);
    if (frame.note) { g.textAlign = 'center'; g.fillStyle = 'rgba(255,255,255,0.75)'; g.fillText(frame.note, W / 2, H - pad.b / 2); }
  }
}

/** Valori "da manopola" 1-2-5 per i volt/div e i ms/div. */
export function niceDiv(span, div) {
  const raw = span / div;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / mag;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * mag;
}

export const fmtIt = (v, d = 2) => (isFinite(v) ? v.toLocaleString('it-IT', { maximumFractionDigits: d }) : '—');
