/* Toolbox shared script: palette, light/dark mode, optional motion,
   Zen auto-hide of controls, zoom buttons, screen wake lock.
   Load it in <head> (no defer) so the theme is applied before first paint. */
(() => {
  const root = document.documentElement;
  const get = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  const PALETTES = ["light", "zen", "ocean", "amber"];
  const NAMES = { light: "Light", zen: "Zen", ocean: "Ocean", amber: "Amber" };

  let pal = get("toolbox-palette", "light");
  if (!PALETTES.includes(pal)) pal = "light";
  let mode = get("toolbox-mode", "light");
  if (mode !== "light" && mode !== "dark") mode = "light";
  let anim = get("toolbox-anim", "off") === "on";

  function apply() {
    root.dataset.palette = pal;
    root.dataset.mode = mode;
    if (anim) root.dataset.anim = "on"; else delete root.dataset.anim;
  }
  apply();

  document.addEventListener("DOMContentLoaded", () => {
    /* ---------- theme bar ---------- */
    const bar = document.getElementById("themebar");
    const dots = [];
    let modeBtn, animBtn;
    const refresh = () => {
      dots.forEach(d => d.setAttribute("aria-pressed", String(d.dataset.p === pal)));
      if (modeBtn) modeBtn.textContent = mode === "dark" ? "☾" : "☀";
      if (animBtn) animBtn.setAttribute("aria-pressed", String(anim));
    };
    if (bar) {
      PALETTES.forEach(p => {
        const b = document.createElement("button");
        b.className = "dot"; b.dataset.p = p; b.type = "button";
        b.title = NAMES[p]; b.setAttribute("aria-label", "Palette: " + NAMES[p]);
        b.onclick = () => { pal = p; set("toolbox-palette", p); apply(); refresh(); wake(); };
        dots.push(b); bar.appendChild(b);
      });
      modeBtn = document.createElement("button");
      modeBtn.className = "mode"; modeBtn.type = "button";
      modeBtn.title = "Switch light / dark";
      modeBtn.setAttribute("aria-label", "Switch between light and dark mode");
      modeBtn.onclick = () => { mode = mode === "dark" ? "light" : "dark"; set("toolbox-mode", mode); apply(); refresh(); wake(); };
      bar.appendChild(modeBtn);

      animBtn = document.createElement("button");
      animBtn.className = "toggle"; animBtn.type = "button"; animBtn.textContent = "Motion";
      animBtn.title = "Slow background and digit animation";
      animBtn.onclick = () => { anim = !anim; set("toolbox-anim", anim ? "on" : "off"); apply(); refresh(); wake(); };
      bar.appendChild(animBtn);
      refresh();
    }

    /* ---------- Zen: hide controls after a few seconds of inactivity ---------- */
    let idleTimer;
    function wake() {
      document.body.classList.remove("idle");
      clearTimeout(idleTimer);
      if (root.dataset.palette === "zen") {
        idleTimer = setTimeout(() => {
          if (!document.body.classList.contains("done")) document.body.classList.add("idle");
        }, 4000);
      }
    }
    ["pointermove", "pointerdown", "keydown", "touchstart", "focusin"].forEach(ev =>
      document.addEventListener(ev, wake, { passive: true }));
    wake();

    /* ---------- zoom buttons (CSS variable only) ---------- */
    const zin = document.getElementById("zoomIn"), zout = document.getElementById("zoomOut");
    if (zin && zout) {
      const max = parseFloat(document.body.dataset.zoomMax || "1.3");
      let zoom = 1;
      const setZoom = z => { zoom = Math.min(max, Math.max(0.4, z)); root.style.setProperty("--zoom", zoom); };
      zin.onclick = () => setZoom(zoom + 0.1);
      zout.onclick = () => setZoom(zoom - 0.1);
    }

    /* ---------- keep the screen awake (ignored if unsupported) ---------- */
    const lock = async () => { try { if ("wakeLock" in navigator) await navigator.wakeLock.request("screen"); } catch (e) {} };
    lock();
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible") lock(); });
  });
})();
