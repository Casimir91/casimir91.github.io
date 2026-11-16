/* Radial ("pie") menu for keys: hold a key (or flick it), the hidden keys fan out above the thumb,
   slide towards one and release. A short tap is left alone, so the key's own click handler still runs.
   attachRadial(button, [{ l: "<html label>", aria, ...anything }], (item) => ...)                    */

const ARC = { 1: [0], 2: [-26, 26], 3: [-48, 0, 48] };      // degrees around the "up" direction
let overlay = null;

function buzz(ms) { try { if (navigator.vibrate) navigator.vibrate(ms); } catch (e) {} }

export function attachRadial(btn, items, onPick, opts = {}) {
  const HOLD = opts.hold ?? 220, R = opts.radius ?? 74, FLICK = 14;
  btn.classList.add("has-alt");
  btn.dataset.alts = String(items.length);
  let st = null, skipClick = false;

  btn.addEventListener("contextmenu", (e) => e.preventDefault());       // no long-press menu, no text callout
  btn.addEventListener("click", (e) => {                                 // a gesture that picked a petal must not also press the key
    if (skipClick) { skipClick = false; e.stopImmediatePropagation(); e.preventDefault(); }
  }, true);

  const centre = () => { const r = btn.getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; };

  function open() {
    if (!st || st.open) return;
    clearTimeout(st.timer);
    st.open = true; st.c = centre();
    const vw = window.innerWidth;
    let shift = 0;                                                       // near a screen edge: lean the fan inwards
    if (st.c.x < R + 28) shift = 42; else if (st.c.x > vw - R - 28) shift = -42;
    const arc = ARC[Math.min(3, items.length)] || ARC[3];
    st.angles = arc.slice(0, items.length).map((a) => a + shift);        // 0 = straight up
    overlay = document.createElement("div");
    overlay.className = "radial";
    overlay.setAttribute("aria-hidden", "true");
    st.petals = items.map((it, i) => {
      const a = (st.angles[i] - 90) * Math.PI / 180;
      const x = Math.max(30, Math.min(vw - 30, st.c.x + R * Math.cos(a)));
      const y = Math.max(30, st.c.y + R * Math.sin(a));
      const p = document.createElement("div");
      p.className = "petal"; p.innerHTML = it.l;
      p.style.left = x + "px"; p.style.top = y + "px"; p.style.animationDelay = i * 25 + "ms";
      overlay.appendChild(p);
      return p;
    });
    const ring = document.createElement("div");
    ring.className = "radial-origin"; ring.style.left = st.c.x + "px"; ring.style.top = st.c.y + "px";
    overlay.appendChild(ring);
    document.body.appendChild(overlay);
    btn.classList.add("radial-open");
    buzz(10);
  }

  function select(e) {
    const dx = e.clientX - st.c.x, dy = e.clientY - st.c.y, d = Math.hypot(dx, dy);
    let sel = -1;
    st.cancel = d > 210;
    if (d > 26 && !st.cancel) {
      const ang = Math.atan2(dx, -dy) * 180 / Math.PI;                    // 0 = up, positive = right
      let best = 999;
      st.angles.forEach((a, i) => {
        const diff = Math.abs(((ang - a + 540) % 360) - 180);
        if (diff < best) { best = diff; sel = i; }
      });
      if (best > 50) sel = -1;
    }
    if (sel !== st.sel) {
      st.sel = sel; buzz(6);
      st.petals.forEach((p, i) => p.classList.toggle("on", i === sel));
    }
    overlay.classList.toggle("cancel", st.cancel);
  }

  function finish(commit) {
    if (!st) return;
    clearTimeout(st.timer);
    const s = st; st = null;
    try { btn.releasePointerCapture(s.id); } catch (e) {}
    if (!s.open) return;
    if (overlay) { overlay.remove(); overlay = null; }
    btn.classList.remove("radial-open");
    if (commit && s.sel >= 0 && !s.cancel) {
      skipClick = true; setTimeout(() => { skipClick = false; }, 450);
      onPick(items[s.sel]);
    } else if (!commit || s.cancel) {
      skipClick = true; setTimeout(() => { skipClick = false; }, 450);   // cancelled: nothing is typed
    }
    /* released on the key itself: the normal click goes through */
  }

  btn.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    st = { id: e.pointerId, x: e.clientX, y: e.clientY, open: false, sel: -1 };
    st.timer = setTimeout(open, HOLD);
    try { btn.setPointerCapture(e.pointerId); } catch (err) {}
  });
  btn.addEventListener("pointermove", (e) => {
    if (!st || e.pointerId !== st.id) return;
    if (!st.open) {
      if (Math.hypot(e.clientX - st.x, e.clientY - st.y) < FLICK) return;
      open();
    }
    select(e);
  });
  btn.addEventListener("pointerup", (e) => { if (st && e.pointerId === st.id) finish(true); });
  btn.addEventListener("pointercancel", (e) => { if (st && e.pointerId === st.id) finish(false); });
}
