// Mosaicus — taratura del termometro (termistore NTC) a due punti.
// Ghiaccio fondente (0 °C) + un secondo bagno letto con un termometro di riferimento.
// Il modello fisico (Beta) dà la "temperatura letta"; la taratura trova la retta
//   T_vera = a · T_letta + b
// che la porta sui due valori di riferimento. Tra i due punti è un'interpolazione, fuori è un'estrapolazione.
// Questo file contiene la matematica (testata in tests/calibration.test.mjs) e il pannello a passi.

import { thermistorR, thermistorC } from './experiments.js';

// ---------- matematica ----------

/** Retta per due punti {meas, ref}: ref = a·meas + b. */
export function fitTwoPoint(p1, p2) {
  const dm = p2.meas - p1.meas;
  if (!isFinite(dm) || Math.abs(dm) < 1e-9) return null;
  const a = (p2.ref - p1.ref) / dm;
  return { a, b: p1.ref - a * p1.meas };
}

/** Incertezza tipo di lettura di un termometro con divisione δ: distribuzione rettangolare, u = δ/√12. */
export const uReading = (division) => division / Math.sqrt(12);

/**
 * Incertezza tipo della temperatura tarata in T (°C) con i punti p1, p2 (ognuno con meas e u del riferimento).
 * T_vera = ref₁ + (ref₂ − ref₁)·λ, con λ = (T_letta − m₁)/(m₂ − m₁): propagando solo le incertezze dei riferimenti
 * u² = u₁²(1 − λ)² + u₂² λ². Agli estremi vale u, a metà u/√2; fuori dai punti cresce (estrapolazione).
 */
export function uncertaintyAt(Tmeas, p1, p2) {
  const lam = (Tmeas - p1.meas) / (p2.meas - p1.meas);
  return Math.sqrt((p1.u * (1 - lam)) ** 2 + (p2.u * lam) ** 2);
}

/**
 * Stato dell'ultimo tratto di letture: media, deviazione standard dei residui dalla retta, pendenza (°C/min).
 * buf = [{t (ms), Tc}], si usano i campioni degli ultimi `windowMs`.
 */
export function trend(buf, windowMs = 10000) {
  if (!buf.length) return { n: 0, mean: NaN, sd: NaN, slope: NaN };
  const tEnd = buf[buf.length - 1].t;
  const w = buf.filter((s) => tEnd - s.t <= windowMs && isFinite(s.Tc));
  const n = w.length;
  if (n < 3) return { n, mean: n ? w.reduce((s, x) => s + x.Tc, 0) / n : NaN, sd: NaN, slope: NaN };
  const mt = w.reduce((s, x) => s + x.t, 0) / n, my = w.reduce((s, x) => s + x.Tc, 0) / n;
  let sxx = 0, sxy = 0;
  for (const x of w) { sxx += (x.t - mt) ** 2; sxy += (x.t - mt) * (x.Tc - my); }
  const m = sxx > 0 ? sxy / sxx : 0;                      // °C/ms
  const res = w.map((x) => x.Tc - (my + m * (x.t - mt)));
  const sd = Math.sqrt(res.reduce((s, r) => s + r * r, 0) / (n - 2));
  return { n, mean: my, sd, slope: m * 60000 };
}

export const STABLE_SD = 0.2;        // °C: rumore residuo accettabile
export const STABLE_SLOPE = 2;       // °C/min: oltre, il sensore sta ancora raggiungendo la temperatura del bagno
export const isStable = (t) => t.n >= 8 && t.sd <= STABLE_SD && Math.abs(t.slope) <= STABLE_SLOPE;

/** Controlli sui due punti registrati. Restituisce un messaggio di errore o null. */
export function checkPoints(p1, p2) {
  if (Math.abs(p2.ref - p1.ref) < 15) return `I due riferimenti sono troppo vicini (${fmt(Math.abs(p2.ref - p1.ref), 1)} °C): serve una differenza di almeno 15 °C.`;
  if ((p2.meas - p1.meas) * (p2.ref - p1.ref) <= 0) return 'Le letture del termometro vanno nel verso opposto ai riferimenti: controlla di non aver scambiato i bagni.';
  return null;
}
/** Avviso (non blocca) se la pendenza è lontana da 1. */
export const slopeWarning = (a) => (a < 0.9 || a > 1.1
  ? `La pendenza a = ${fmt(a, 3)} è lontana da 1: controlla il termometro di riferimento e il circuito (resistenza fissa da 10 kΩ, termistore NTC).` : null);

const fmt = (v, d = 2) => (isFinite(v) ? v.toLocaleString('it-IT', { minimumFractionDigits: d, maximumFractionDigits: d }) : '—');

// ---------- pannello a passi ----------

const SIM_BATHS = [{ T: 0, icon: '🧊', label: '0 °C' }, { T: 48, icon: '♨', label: '48 °C' }];

/**
 * Pannello «Tara il termometro». api: {
 *   params(): parametri del lab (modello e correzione manuale), isSim(): bool, setBath(T): bagno del simulatore,
 *   apply({a, b, info}): salva la taratura, close(): chiude il pannello, toast(msg)
 * }
 */
export function createCalibration(el, api) {
  const S = { phase: 'p1', buf: [], pts: [], division: 0.5, simBath: 0, warn: '', ref: { p1: '0.0', p2: '' } };
  let raf = 0, destroyed = false;
  const model = () => ({ ...api.params(), calA: 1, calB: 0, offset: 0 });   // la lettura grezza: niente correzioni

  const phaseDots = () => {
    const now = S.phase === 'p1' ? 1 : S.phase === 'p2' ? 2 : 3;
    return `<div class="coach-dots" aria-hidden="true">${[1, 2, 3].map((i) => `<i class="${i < now ? 'done' : i === now ? 'now' : ''}"></i>`).join('')}</div>`;
  };

  function chips() {
    return S.pts.map((p, i) => `<span class="cal-chip">${i === 0 ? '🧊' : '♨'} letta ${fmt(p.meas)} °C → riferimento ${fmt(p.ref, 1)} °C</span>`).join('');
  }

  function render() {
    if (destroyed) return;
    const head = `<div class="cal-head"><span class="cal-title">🌡 Tara il termometro</span>${phaseDots()}<button class="btn btn-small btn-ghost" data-c="exit">✕ Esci</button></div>`;
    let body = '';
    if (S.phase === 'p1' || S.phase === 'p2') {
      const first = S.phase === 'p1';
      const sim = api.isSim()
        ? `<div class="cal-sim">Simulatore · bagno a ${SIM_BATHS.map((b) => `<button class="btn btn-small${S.simBath === b.T ? ' active' : ''}" data-c="bath" data-T="${b.T}">${b.icon} ${b.label}</button>`).join('')}</div>` : '';
      body = `
        <p class="cal-do"><span class="cal-ico">${first ? '🧊' : '♨'}</span><span>${first
          ? '<b>Punto 1 · ghiaccio fondente.</b> Acqua con molto ghiaccio, il termistore al centro (non sul vetro), mescola piano.'
          : '<b>Punto 2 · acqua calda</b> (almeno 15 °C sopra il ghiaccio: meglio vicino alla temperatura a cui misurerai). Metti accanto al termistore il termometro di riferimento e mescola.'}</span></p>
        ${sim}
        <div class="cal-live">
          <div class="cal-big"><small>Il termometro legge</small><b data-live="val">—</b><em>°C</em></div>
          <div class="cal-state" data-live="state"></div>
          <svg class="cal-spark" viewBox="0 0 200 44" preserveAspectRatio="none" aria-hidden="true"><polyline data-live="spark" points="" fill="none" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>
        </div>
        <div class="cal-rec">
          <label class="cal-ref"><span>Termometro di riferimento</span><input type="number" step="0.1" inputmode="decimal" data-c="ref" value="${S.ref[S.phase]}" placeholder="${first ? '0,0' : 'es. 48,5'}"><em>°C</em></label>
          <button class="btn btn-go" data-c="rec" disabled>Registra il punto ${first ? 1 : 2}</button>
        </div>
        ${S.warn ? `<p class="cal-warn">${S.warn}</p>` : ''}
        <p class="hint cal-tip">${first ? 'Il riferimento del ghiaccio fondente è 0,0 °C: cambialo solo se hai un termometro che dice altro.' : 'Premi «Registra» mentre leggi il termometro di riferimento: i due sensori devono stare nello stesso bagno.'}</p>`;
    } else {
      const [p1, p2] = S.pts, f = fitTwoPoint(p1, p2);
      const mid = (p1.meas + p2.meas) / 2;
      const warn = slopeWarning(f.a);
      body = `
        <div class="cal-res">
          <div class="cal-eq"><small>La retta di taratura</small><b>T = ${fmt(f.a, 3)} · T<sub>letta</sub> ${f.b < 0 ? '−' : '+'} ${fmt(Math.abs(f.b), 2)}</b></div>
          <div class="cal-chips">${chips()}</div>
          <p class="cal-u">Incertezza della taratura: <b>± ${fmt(uncertaintyAt(mid, p1, p2), 2)} °C</b> tra i due punti${Math.abs(uncertaintyAt(p1.meas, p1, p2) - uncertaintyAt(mid, p1, p2)) > 0.005 ? ` (± ${fmt(uncertaintyAt(p1.meas, p1, p2), 2)} agli estremi)` : ''}.</p>
          ${warn ? `<p class="cal-warn">${warn}</p>` : ''}
        </div>
        <div class="cal-rec">
          <button class="btn btn-go" data-c="use">✓ Usa questa taratura</button>
          <button class="btn" data-c="redo">↺ Rifai</button>
        </div>
        <details class="cal-how"><summary>Come si calcola</summary>
          <p>Il termistore dà R(T); il modello Beta, 1/T = 1/T₀ + ln(R/R₀)/B, la trasforma in una temperatura letta. Con due bagni di temperatura nota si impone che la retta T = a·T<sub>letta</sub> + b passi per i due punti: a = (T₂ − T₁)/(m₂ − m₁), b = T₁ − a·m₁.</p>
          <p>L'incertezza viene dai due riferimenti: u = δ/√12 per la lettura sulla scala (divisione δ = <input class="cal-div" type="number" step="0.1" min="0.01" value="${S.division}" data-c="div"> °C), 0,1 °C per il ghiaccio fondente. Tra i due punti si propaga u² = u₁²(1 − λ)² + u₂²λ² con λ = (T<sub>letta</sub> − m₁)/(m₂ − m₁); fuori dai punti è un'estrapolazione e l'incertezza cresce.</p>
        </details>`;
    }
    el.innerHTML = `${head}<div class="cal-body">${body}</div>`;
    updateLive();
  }

  // aggiorna solo le parti "vive" (lettura, stato, sparkline, pulsante) senza ricostruire i campi
  function updateLive() {
    raf = 0;
    if (destroyed || (S.phase !== 'p1' && S.phase !== 'p2')) return;
    const q = (k) => el.querySelector(`[data-live="${k}"]`);
    const tr = trend(S.buf, 10000);
    const last = S.buf[S.buf.length - 1];
    const now = trend(S.buf, 2000);                            // la cifra grande è la lettura di adesso (ultimi 2 s), non la media di 10 s
    q('val').textContent = last ? fmt(now.n >= 2 ? now.mean : last.Tc) : '—';
    const st = q('state');
    if (tr.n < 8) { st.className = 'cal-state wait'; st.textContent = '… raccolgo i primi dati'; }
    else if (isStable(tr)) { st.className = 'cal-state ok'; st.textContent = '✓ stabile'; }
    else { st.className = 'cal-state wait'; st.textContent = Math.abs(tr.slope) > STABLE_SLOPE ? `⏳ si sta ancora assestando (${fmt(tr.slope, 1)} °C/min)` : '⏳ letture ancora rumorose'; }
    const win = S.buf.filter((s) => last && last.t - s.t <= 60000 && isFinite(s.Tc));
    if (win.length > 1) {
      const lo = Math.min(...win.map((s) => s.Tc)), hi = Math.max(...win.map((s) => s.Tc)), span = Math.max(0.5, hi - lo), mid = (hi + lo) / 2;
      const t0 = win[0].t, T = Math.max(20000, last.t - t0);
      q('spark').setAttribute('points', win.map((s) => `${(((s.t - t0) / T) * 200).toFixed(1)},${(22 - ((s.Tc - mid) / span) * 36).toFixed(1)}`).join(' '));
    }
    const rec = el.querySelector('[data-c="rec"]');
    if (rec) {
      rec.disabled = tr.n < 6;
      rec.classList.toggle('go-now', isStable(tr));
      rec.textContent = `${isStable(tr) || tr.n < 6 ? 'Registra' : 'Registra comunque'} il punto ${S.phase === 'p1' ? 1 : 2}`;
    }
  }
  const scheduleLive = () => { if (!raf) raf = setTimeout(updateLive, 250); };

  function record() {
    const input = el.querySelector('[data-c="ref"]');
    const ref = parseFloat(String(input.value).replace(',', '.'));
    if (!isFinite(ref)) { S.warn = 'Scrivi la temperatura del termometro di riferimento.'; render(); return; }
    // il valore registrato è la media degli ultimi 3 s: il riferimento si legge "adesso"
    const last = S.buf[S.buf.length - 1];
    const w = S.buf.filter((s) => last.t - s.t <= 3000 && isFinite(s.Tc));
    if (w.length < 3) { S.warn = 'Letture insufficienti: aspetta qualche secondo.'; render(); return; }
    const meas = w.reduce((s, x) => s + x.Tc, 0) / w.length;
    const sd = Math.sqrt(w.reduce((s, x) => s + (x.Tc - meas) ** 2, 0) / Math.max(1, w.length - 1));
    const point = { meas, ref, n: w.length, sd, u: 0 };
    point.u = S.pts.length === 0 && ref === 0 ? 0.1 : uReading(S.division);
    if (S.pts.length === 1) {
      const err = checkPoints(S.pts[0], point);
      if (err) { S.warn = err; render(); return; }
    }
    S.warn = '';
    S.pts.push(point);
    if (S.pts.length === 1) S.phase = 'p2'; else S.phase = 'res';
    render();
    if (S.phase === 'p2' && api.isSim()) setBath(48);
  }

  function use() {
    const [p1, p2] = S.pts, f = fitTwoPoint(p1, p2);
    const off = api.params().offset ?? 0;                      // la correzione manuale resta additiva: la taratura mira a ref − offset
    const a = f.a, b = f.b - off;
    const info = {
      when: Date.now(), a, b,
      points: S.pts.map((p) => ({ meas: +p.meas.toFixed(3), ref: p.ref, n: p.n, sd: +p.sd.toFixed(3), u: +p.u.toFixed(3) })),
      uMid: +uncertaintyAt((p1.meas + p2.meas) / 2, p1, p2).toFixed(3),
    };
    api.apply({ a: +a.toFixed(5), b: +b.toFixed(4), info });
    api.close();
  }

  function setBath(T) {
    S.simBath = T; api.setBath(T);
    S.ref[S.phase] = T.toFixed(1);                              // il simulatore "legge" il termometro di riferimento per lo studente
    const inp = el.querySelector('[data-c="ref"]'); if (inp) inp.value = S.ref[S.phase];
    el.querySelectorAll('[data-c="bath"]').forEach((b) => b.classList.toggle('active', +b.dataset.T === T));
  }

  el.addEventListener('click', (e) => {
    const c = e.target.closest('[data-c]')?.dataset.c;
    if (c === 'rec') record();
    else if (c === 'use') use();
    else if (c === 'redo') { S.pts = []; S.phase = 'p1'; S.warn = ''; S.ref = { p1: '0.0', p2: '' }; render(); if (api.isSim()) setBath(0); }
    else if (c === 'exit') api.close();
    else if (c === 'bath') setBath(+e.target.closest('[data-T]').dataset.T);
  });
  el.addEventListener('input', (e) => { if (e.target.dataset.c === 'ref') S.ref[S.phase] = e.target.value; });
  el.addEventListener('change', (e) => {
    if (e.target.dataset.c === 'div') { const v = parseFloat(e.target.value); if (v > 0) { S.division = v; S.pts.forEach((p, i) => { p.u = i === 0 && p.ref === 0 ? 0.1 : uReading(v); }); render(); } }
  });

  render();
  if (api.isSim()) setBath(0);

  return {
    onLine(line) {
      if (line[0] !== 'T' || line[1] !== ',') return false;
      const f = line.slice(2).split(',').map(Number);
      const R = thermistorR(f[1], model());
      S.buf.push({ t: performance.now(), adc: f[1], Tc: thermistorC(R, model()) });
      if (S.buf.length > 400) S.buf.splice(0, S.buf.length - 400);
      scheduleLive();
      return true;
    },
    destroy() { destroyed = true; clearTimeout(raf); el.innerHTML = ''; },
  };
}
