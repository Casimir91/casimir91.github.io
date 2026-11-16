/* Groovebox · Song: a multitrack timeline (like the playlist of ACID or FL Studio) built on the 4-bar loops.
   Six lanes (Drums, Bass, Guitar, Chords, Low, Arp); a block = one loop repeated for 1…N cycles of 4 bars.
   The scheduler asks `cycle(t)` at every 4-bar line and the loops of that cycle are queued, so everything stays in time. */
const LANE_COL = { drums: '#d9742b', bass: '#3f8fd2', guitar: '#c4a22a', kchords: '#8b5cc7', klow: '#35a089', keys: '#d0507e', lpads: '#2fb5c7', lkeys: '#8fcf3a' };
const MAXLEN = 32, ZOOMS = [3.2, 4.2, 5.4, 7, 9];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export function initSong(api) {
  const { $, $$, store, SLOTS, CLIPS, CLIP_BY_ID, SCENES, SL, S, TRACKS, SLOT_OF } = api, LANES = api.LANES || SLOTS;
  const KEYS = LANES.map(([k]) => k), NAME = Object.fromEntries(LANES), isLive = (k) => k === 'lpads' || k === 'lkeys';

  // ------------------------------------------------------------ data
  const SONG = { len: 8, lanes: Object.fromEntries(KEYS.map((k) => [k, []])), mute: {}, loop: true, zoom: 2, cursor: 0 };
  try {
    const v = store.get('song1', null);
    if (v && typeof v === 'object') {
      SONG.len = clamp(v.len | 0 || 8, 1, MAXLEN); SONG.loop = v.loop !== false; SONG.zoom = clamp(v.zoom | 0, 0, ZOOMS.length - 1); SONG.cursor = clamp(v.cursor | 0, 0, SONG.len - 1); Object.assign(SONG.mute, v.mute || {});
      for (const k of KEYS) SONG.lanes[k] = (v.lanes?.[k] || []).filter((x) => CLIP_BY_ID[x.id] && x.s >= 0 && x.n >= 1 && x.s + x.n <= MAXLEN).map((x) => ({ s: x.s | 0, n: x.n | 0, id: x.id }));
    }
  } catch (e) { /* a damaged save is ignored */ }
  const save = () => store.set('song1', SONG);
  const lane = (k) => SONG.lanes[k];
  const at = (k, c) => lane(k).find((x) => c >= x.s && c < x.s + x.n);
  const clipAt = (k, c) => (SONG.mute[k] ? null : at(k, c)?.id ?? null);
  const free = (k, s, n, except) => s >= 0 && s + n <= MAXLEN && !lane(k).some((x) => x !== except && x.s < s + n && x.s + x.n > s);
  const usedEnd = () => Math.max(0, ...KEYS.flatMap((k) => lane(k).map((x) => x.s + x.n)));
  function clearRange(k, s, e) { // makes room: items inside go away, the ones that stick out are trimmed or split
    const out = [];
    for (const x of lane(k)) {
      const xe = x.s + x.n;
      if (xe <= s || x.s >= e) out.push(x);
      else { if (x.s < s) out.push({ ...x, n: s - x.s }); if (xe > e) out.push({ ...x, s: e, n: xe - e }); }
    }
    SONG.lanes[k] = out;
  }
  function place(k, s, n, id) { clearRange(k, s, s + n); const it = { s, n, id }; lane(k).push(it); lane(k).sort((a, b) => a.s - b.s); if (s + n > SONG.len) SONG.len = s + n; return it; }

  // ------------------------------------------------------------ playback hooks
  const run = { on: false, from: 0, pos: 0, cur: 0, t0: 0, loop: true };
  const cycleSecs = () => 960 / S.bpm;                       // 4 bars of 16 steps: 64 steps × 15/bpm seconds
  function cycle(T) {                                         // called by the scheduler at every 4-bar line
    if (!run.on) return;
    if (run.pos >= SONG.len || run.pos >= (run.end ?? SONG.len)) {
      if (run.loop) run.pos = run.from;
      else { run.on = false; for (const k of KEYS) SL[k].next = SL[k].cur ? null : undefined; setTimeout(() => api.stop(), Math.max(0, (T - api.now()) * 1000)); return; }
    }
    for (const k of KEYS) { const id = clipAt(k, run.pos); SL[k].next = id === SL[k].cur ? undefined : id; }
    run.cur = run.pos; run.t0 = T; run.pos++;
  }
  const stopped = () => { run.on = false; };
  function firstDrums(from) { for (let c = from; c < SONG.len; c++) { const id = clipAt('drums', c); if (id) return id; } return null; }
  function playSong(opts = {}) {
    if (!api.audioSupported()) return;
    if (api.isPlaying()) api.stop();
    run.on = true; run.from = opts.from ?? SONG.cursor; run.pos = run.from; run.loop = opts.loop ?? SONG.loop; run.end = opts.end;
    const d = firstDrums(run.from); if (d) api.setTempoFromClip(d);
    api.play(); paintBar();
  }
  const stopSong = () => { if (api.isPlaying()) api.stop(); run.on = false; paintBar(); };
  async function renderSong() {
    const end = usedEnd(); if (!end) { api.status('The timeline is empty: place some loops first'); return; }
    if (api.isPlaying()) api.stop();
    run.on = true; run.from = 0; run.pos = 0; run.loop = false; run.end = end;
    const d = firstDrums(0); if (d) api.setTempoFromClip(d);
    await api.startExport(end * 4); paintBar();
  }

  // ------------------------------------------------------------ UI state
  let selLane = KEYS[0], sel = null, armed = null, drag = null;
  const root = $('#songRoot'), lanesEl = $('#songLanes'), headsEl = $('#songHeads'), binEl = $('#songBin'), actEl = $('#songAct'), scroll = $('#songScroll');
  const css = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || '#888';

  function paintBar() {
    const playingSong = run.on && api.isPlaying();
    $('#songPlay').setAttribute('aria-pressed', String(playingSong)); $('#songPlay').textContent = playingSong ? '■ Stop song' : '▶ Play song';
    $('#songLoop').setAttribute('aria-pressed', String(SONG.loop));
    const bars = SONG.len * 4, sec = Math.round(SONG.len * cycleSecs());
    $('#songInfo').textContent = `${SONG.len} cycles · ${bars} bars · ${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')} at ${S.bpm} bpm · start at bar ${SONG.cursor * 4 + 1}`;
    $('#songZoomOut').disabled = SONG.zoom === 0; $('#songZoomIn').disabled = SONG.zoom === ZOOMS.length - 1;
    $('#songLess').disabled = SONG.len <= Math.max(1, usedEnd()); $('#songMore').disabled = SONG.len >= MAXLEN;
  }
  function thumb(cv, k, id, n) {
    const w = cv.clientWidth, h = cv.clientHeight, d = window.devicePixelRatio || 1; if (!w) return;
    cv.width = Math.round(w * d); cv.height = Math.round(h * d); const g = cv.getContext('2d'); g.scale(d, d);
    const c = CLIP_BY_ID[id]; if (!c) return; const fg = css('--fg'), cyc = w / n, sw = cyc / 64;
    g.fillStyle = fg; g.strokeStyle = fg;
    if (c.ev) { // a loop you recorded: pads = one row per pad, keys = pitch
      const rows = k === 'lkeys' ? null : [...new Set(c.ev.map((e) => e.m))].sort((a, b) => a - b); let lo = 1e9, hi = -1e9; if (!rows) for (const e of c.ev) { lo = Math.min(lo, e.m); hi = Math.max(hi, e.m); }
      for (let rep = 0; rep < n; rep++) {
        const x0 = rep * cyc; g.globalAlpha = 0.22; g.lineWidth = 1; for (let b = 1; b < 4; b++) { g.beginPath(); g.moveTo(x0 + b * 16 * sw, 0); g.lineTo(x0 + b * 16 * sw, h); g.stroke(); }
        if (rep) { g.globalAlpha = 0.4; g.beginPath(); g.moveTo(x0, 0); g.lineTo(x0, h); g.stroke(); }
        g.globalAlpha = 0.9; for (const e of c.ev) { const y = rows ? 4 + (rows.indexOf(e.m) / Math.max(1, rows.length - 1)) * (h - 11) : 4 + (1 - (e.m - lo) / Math.max(1, hi - lo)) * (h - 11); g.fillRect(x0 + e.p * sw, y, Math.max(1.5, (rows ? 1 : e.d) * sw - 0.6), 3); }
      }
      g.globalAlpha = 1; return;
    }
    let lo = 99, hi = -99; if (k === 'bass') for (const o of c.bars) for (const r of o.b) if (r >= 0) { lo = Math.min(lo, r); hi = Math.max(hi, r); }
    const used = k === 'bass' ? [] : TRACKS.map((t, ti) => ti).filter((ti) => SLOT_OF[ti] === k && c.bars.some((bb) => bb[ti] && bb[ti].some((v) => v))), band = (h - 8) / Math.max(1, used.length);
    for (let rep = 0; rep < n; rep++) {
      const x0 = rep * cyc;
      g.globalAlpha = 0.22; g.lineWidth = 1; for (let b = 1; b < 4; b++) { g.beginPath(); g.moveTo(x0 + b * 16 * sw, 0); g.lineTo(x0 + b * 16 * sw, h); g.stroke(); }
      if (rep) { g.globalAlpha = 0.4; g.beginPath(); g.moveTo(x0, 0); g.lineTo(x0, h); g.stroke(); }
      for (let b = 0; b < 4; b++) {
        const o = c.bars[b % c.bars.length];
        if (k === 'bass') { for (let i = 0; i < 16; i++) if (o.b[i] >= 0) { const y = 4 + (1 - (o.b[i] - lo) / Math.max(1, hi - lo)) * (h - 12); g.globalAlpha = 0.9; g.fillRect(x0 + (b * 16 + i) * sw, y, Math.max(1.5, (o.l[i] || 1) * sw - 0.6), 3); } }
        else used.forEach((ti, j) => { const row = o[ti]; if (!row) return; for (let i = 0; i < 16; i++) if (row[i]) { g.globalAlpha = row[i] === 2 ? 0.35 : 0.92; g.fillRect(x0 + (b * 16 + i) * sw, 4 + j * band + 0.5, Math.max(1.5, sw * 0.75), Math.max(2, band - 1.5)); } });
      }
    }
    g.globalAlpha = 1;
  }
  function renderHeads() {
    headsEl.innerHTML = '<div class="sg-corner"></div>' + KEYS.map((k) => `<div class="sg-head${k === selLane ? ' on' : ''}" data-slot="${k}" style="--lc:${LANE_COL[k]}"><b>${NAME[k]}</b><button class="m" data-mute="${k}" aria-pressed="${!!SONG.mute[k]}" aria-label="Mute ${NAME[k]}" title="Mute the lane">M</button></div>`).join('');
  }
  function render() {
    root.style.setProperty('--cw', ZOOMS[SONG.zoom] + 'rem'); root.style.setProperty('--len', SONG.len);
    renderHeads();
    const rul = Array.from({ length: SONG.len }, (_, c) => `<div class="sg-rc${c === SONG.cursor ? ' cur' : ''}" data-c="${c}"><span>${c * 4 + 1}</span></div>`).join('');
    lanesEl.innerHTML = `<div class="sg-ruler" data-ruler>${rul}</div>` + KEYS.map((k) => `<div class="sg-lane${SONG.mute[k] ? ' muted' : ''}${k === selLane ? ' on' : ''}${armed && armed.k === k ? ' armed' : ''}" data-slot="${k}" style="--lc:${LANE_COL[k]}">${lane(k).map((x, i) => `<div class="sg-clip${sel && sel.k === k && sel.it === x ? ' sel' : ''}" data-i="${i}" style="left:calc(var(--cw)*${x.s});width:calc(var(--cw)*${x.n})"><canvas class="sg-th"></canvas><span class="nm">${CLIP_BY_ID[x.id].name}</span><i class="rh" title="Drag to lengthen"></i></div>`).join('')}</div>`).join('') + '<div class="sg-cursor" id="sgCursor"></div><div class="sg-head-line" id="sgHeadLine"></div>';
    $$('.sg-lane', lanesEl).forEach((el) => { const k = el.dataset.slot; $$('.sg-clip', el).forEach((c) => { const x = lane(k)[+c.dataset.i]; thumb($('canvas', c), k, x.id, x.n); }); });
    placeCursor(); renderBin(); renderAct(); paintBar();
  }
  function renderBin() {
    const a = armed && armed.k === selLane ? armed.id : null;
    const items = CLIPS[selLane] || [], live = isLive(selLane), nm = selLane === 'lpads' ? 'Pads' : 'Keys';
    binEl.innerHTML = `<h3>${NAME[selLane]} loops <small>${live ? 'the loops you recorded live and saved: ' : ''}tap one, then tap or drag in the ${NAME[selLane]} lane to place it</small></h3>` +
      (live && !items.length ? `<p class="note">Nothing saved yet. Record a loop in <b>${nm}</b> with ● Rec, then press <b>＋ Save in Song</b>.</p>` : `<div class="chips">${items.map((c) => `<button data-clip="${c.id}" aria-pressed="${c.id === a}">${c.name}</button>`).join('')}</div>`) +
      (live && items.length ? `<div class="chips"><button data-lib="rename" ${a ? '' : 'disabled'}>✎ Rename</button><button data-lib="del" ${a ? '' : 'disabled'}>🗑 Delete this loop</button></div>` : '');
  }
  function renderAct() {
    if (!sel) { actEl.innerHTML = '<span class="note">Tap a block to move, lengthen, copy or delete it. Drag its right edge to repeat the loop for more cycles.</span>'; return; }
    const x = sel.it, c = CLIP_BY_ID[x.id];
    actEl.innerHTML = `<b>${c.name}</b> <span class="note">${NAME[sel.k]} · cycle${x.n > 1 ? 's' : ''} ${x.s + 1}${x.n > 1 ? '–' + (x.s + x.n) : ''}</span>
      <button data-act="left" aria-label="Move earlier">◀</button><button data-act="right" aria-label="Move later">▶</button><button data-act="shorter" ${x.n < 2 ? 'disabled' : ''}>− cycle</button><button data-act="longer">+ cycle</button>
      <button data-act="copy">Copy →</button><button data-act="swap" ${armed && armed.k === sel.k ? '' : 'disabled'} title="Replace with the loop picked below">Replace</button><button data-act="del">Delete</button>`;
  }
  const cellPx = () => lanesEl.getBoundingClientRect().width / SONG.len;
  function placeCursor() { const el = $('#sgCursor'); if (el) el.style.transform = `translateX(${SONG.cursor * cellPx()}px)`; }
  function select(k, it) { sel = k ? { k, it } : null; if (k) selLane = k; }

  // ------------------------------------------------------------ pointer: place / select / move / resize
  lanesEl.addEventListener('pointerdown', (e) => {
    const rc = e.target.closest('.sg-rc'); if (rc) { SONG.cursor = +rc.dataset.c; save(); $$('.sg-rc', lanesEl).forEach((r) => r.classList.toggle('cur', r === rc)); placeCursor(); paintBar(); return; }
    const laneEl = e.target.closest('.sg-lane'); if (!laneEl) return;
    const k = laneEl.dataset.slot, r = laneEl.getBoundingClientRect(), cw = r.width / SONG.len, cell = (ev) => clamp(Math.floor((ev.clientX - r.left) / cw), 0, MAXLEN - 1);
    const clipEl = e.target.closest('.sg-clip');
    if (clipEl) {
      const it = lane(k)[+clipEl.dataset.i]; select(k, it); laneEl.setPointerCapture(e.pointerId);
      drag = { mode: e.target.classList.contains('rh') ? 'resize' : 'move', k, it, x0: e.clientX, s0: it.s, n0: it.n, cw, moved: false, el: clipEl, r };
      $$('.sg-clip.sel', lanesEl).forEach((c) => c.classList.remove('sel')); clipEl.classList.add('sel'); selLane = k; renderBin(); renderAct(); $$('.sg-head', headsEl).forEach((h) => h.classList.toggle('on', h.dataset.slot === k));
      if (e.pointerType === 'mouse') e.preventDefault(); return;
    }
    selLane = k; $$('.sg-head', headsEl).forEach((h) => h.classList.toggle('on', h.dataset.slot === k));
    if (armed && armed.k === k) { // paint with the picked loop; dragging along the lane paints more cycles
      const c = cell(e); if (c >= SONG.len && c >= MAXLEN) return; const it = place(k, c, 1, armed.id); select(k, it); laneEl.setPointerCapture(e.pointerId);
      drag = { mode: 'paint', k, it, last: c, cw, r }; save(); render(); return;
    }
    select(null); renderBin(); renderAct(); $$('.sg-clip.sel', lanesEl).forEach((c) => c.classList.remove('sel'));
  });
  lanesEl.addEventListener('pointermove', (e) => {
    if (!drag) return; const dx = e.clientX - drag.x0, d = drag, it = d.it;
    if (d.mode === 'move') { if (Math.abs(dx) > 5) d.moved = true; const s = clamp(Math.round(d.s0 + dx / d.cw), 0, MAXLEN - it.n); if (d.moved && s !== it.s && free(d.k, s, it.n, it)) { it.s = s; d.el.style.left = `calc(var(--cw)*${s})`; } }
    else if (d.mode === 'resize') { d.moved = true; const n = clamp(Math.round(d.n0 + dx / d.cw), 1, MAXLEN - it.s); if (n !== it.n && free(d.k, it.s, n, it)) { it.n = n; d.el.style.width = `calc(var(--cw)*${n})`; } }
    else if (d.mode === 'paint') {
      const c = clamp(Math.floor((e.clientX - d.r.left) / d.cw), 0, MAXLEN - 1); if (c <= d.last || c - d.last > 6) return;
      for (let q = d.last + 1; q <= c; q++) { if (!free(d.k, q, 1)) continue; if (q === d.it.s + d.it.n) d.it.n++; else d.it = place(d.k, q, 1, armed.id); }
      d.last = c; if (d.it.s + d.it.n > SONG.len) SONG.len = d.it.s + d.it.n; select(d.k, d.it); render();
    }
  });
  const end = () => { if (!drag) return; const d = drag; drag = null; if (d.it.s + d.it.n > SONG.len) SONG.len = d.it.s + d.it.n; lane(d.k).sort((a, b) => a.s - b.s); save(); render(); };
  lanesEl.addEventListener('pointerup', end); lanesEl.addEventListener('pointercancel', end);

  headsEl.addEventListener('click', (e) => {
    const m = e.target.closest('[data-mute]'); if (m) { SONG.mute[m.dataset.mute] = !SONG.mute[m.dataset.mute]; save(); render(); return; }
    const h = e.target.closest('.sg-head'); if (h) { selLane = h.dataset.slot; render(); }
  });
  binEl.addEventListener('click', (e) => {
    const lb = e.target.closest('[data-lib]');
    if (lb && armed) {
      const c = CLIP_BY_ID[armed.id];
      if (lb.dataset.lib === 'rename') { const v = prompt('Name of this loop', c.name); if (v && v.trim()) { api.libOp.rename(armed.id, v.trim()); save(); render(); } }
      else if (confirm(`Delete “${c.name}”? Its blocks leave the timeline too.`)) { const id = armed.id; api.libOp.remove(id); for (const k of KEYS) SONG.lanes[k] = lane(k).filter((x) => x.id !== id); armed = null; select(null); save(); render(); }
      return;
    }
    const b = e.target.closest('[data-clip]'); if (!b) return;
    armed = armed && armed.id === b.dataset.clip ? null : { k: selLane, id: b.dataset.clip }; render();
    if (armed) api.status(`Picked “${CLIP_BY_ID[armed.id].name}”: tap or drag in the ${NAME[armed.k]} lane`);
  });
  actEl.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]'); if (!b || !sel) return; const { k, it } = sel, a = b.dataset.act;
    if (a === 'left' && free(k, it.s - 1, it.n, it)) it.s--;
    else if (a === 'right' && free(k, it.s + 1, it.n, it)) it.s++;
    else if (a === 'shorter' && it.n > 1) it.n--;
    else if (a === 'longer' && free(k, it.s, it.n + 1, it)) it.n++;
    else if (a === 'copy') { const s = it.s + it.n; if (s < MAXLEN) { const nx = place(k, s, it.n, it.id); select(k, nx); } }
    else if (a === 'swap' && armed && armed.k === k) it.id = armed.id;
    else if (a === 'del') { SONG.lanes[k] = lane(k).filter((x) => x !== it); select(null); }
    if (it.s + it.n > SONG.len) SONG.len = it.s + it.n; lane(k).sort((x, y) => x.s - y.s); save(); render();
  });
  document.addEventListener('keydown', (e) => { if (root.closest('[hidden]') || !sel || /input|select|textarea/i.test(e.target.tagName)) return; if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); actEl.querySelector('[data-act=del]')?.click(); } });

  // ------------------------------------------------------------ toolbar and scene helpers
  $('#songPlay').addEventListener('click', () => (run.on && api.isPlaying() ? stopSong() : playSong()));
  $('#songLoop').addEventListener('click', () => { SONG.loop = !SONG.loop; run.loop = SONG.loop; save(); paintBar(); });
  $('#songZoomIn').addEventListener('click', () => { SONG.zoom = Math.min(ZOOMS.length - 1, SONG.zoom + 1); save(); render(); });
  $('#songZoomOut').addEventListener('click', () => { SONG.zoom = Math.max(0, SONG.zoom - 1); save(); render(); });
  $('#songMore').addEventListener('click', () => { SONG.len = Math.min(MAXLEN, SONG.len + 4); save(); render(); });
  $('#songLess').addEventListener('click', () => { SONG.len = Math.max(Math.max(1, usedEnd()), SONG.len - 1); SONG.cursor = Math.min(SONG.cursor, SONG.len - 1); save(); render(); });
  $('#songClear').addEventListener('click', () => { if (!usedEnd() || confirm('Remove every loop from the timeline?')) { for (const k of KEYS) SONG.lanes[k] = []; select(null); save(); render(); } });
  $('#songRender').addEventListener('click', () => renderSong());
  const sceneNames = Object.keys(SCENES);
  $('#songScenes').innerHTML = '<span>Add</span>' + sceneNames.map((n) => `<button data-sc="${n}">${n}</button>`).join('') + '<button data-sc="@now" title="The loops that are playing right now">＋ Current loops</button>';
  $('#songScenes').addEventListener('click', (e) => {
    const b = e.target.closest('[data-sc]'); if (!b) return; const c = SONG.cursor;
    if (b.dataset.sc === '@now') KEYS.forEach((k) => { const id = SL[k].cur; if (id && id !== 'mine' && CLIP_BY_ID[id]) place(k, c, 1, id); });
    else { const sc = SCENES[b.dataset.sc]; KEYS.forEach((k, i) => { const id = sc.c[i]; if (id && CLIP_BY_ID[id]) place(k, c, 1, id); }); }
    SONG.cursor = Math.min(MAXLEN - 1, c + 1); if (SONG.cursor >= SONG.len) SONG.len = SONG.cursor + 1; save(); render();
    api.status(`Placed at bar ${c * 4 + 1}: the cursor moves to the next cycle`);
  });

  // ------------------------------------------------------------ playhead
  function frame() {
    requestAnimationFrame(frame);
    if (root.closest('[hidden]')) return;
    const hl = $('#sgHeadLine'); if (!hl) return; const cw = cellPx(), on = run.on && api.isPlaying();
    hl.style.display = on ? 'block' : 'none';
    if (on) {
      const p = run.cur + clamp((api.now() - run.t0) / cycleSecs(), 0, 1), x = p * cw; hl.style.transform = `translateX(${x}px)`;
      $$('.sg-rc', lanesEl).forEach((r, i) => r.classList.toggle('now', i === run.cur));
      const l = scroll.scrollLeft, w = scroll.clientWidth - 90; if (!drag && (x < l || x > l + w)) scroll.scrollLeft = Math.max(0, x - w * 0.2);
    } else $$('.sg-rc.now', lanesEl).forEach((r) => r.classList.remove('now'));
    const pb = $('#songPlay'), pr = on ? 'true' : 'false'; if (pb.getAttribute('aria-pressed') !== pr) paintBar();
  }
  requestAnimationFrame(frame);
  window.addEventListener('resize', () => { if (!root.closest('[hidden]')) render(); });

  return { cycle, stopped, show() { render(); }, SONG };
}
