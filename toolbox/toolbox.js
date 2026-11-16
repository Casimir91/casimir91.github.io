/* Toolbox shared script: light/dark theme (Zen green / Lime), optional motion,
   zoom buttons, screen wake lock.
   Load it in <head> (no defer) so the theme is applied before first paint. */
(() => {
  const root = document.documentElement;
  const get = (k, d) => { try { return localStorage.getItem(k) || d; } catch (e) { return d; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch (e) {} };

  let mode = get("toolbox-mode", "dark");   // dark (lime) is the default; a choice made with the ☀/☾ button is remembered
  if (mode !== "light" && mode !== "dark") mode = "dark";
  let anim = get("toolbox-anim", "off") === "on";

  function apply() {
    root.dataset.palette = mode === "dark" ? "lime" : "zen"; // kept for old selectors
    root.dataset.mode = mode;
    if (anim) root.dataset.anim = "on"; else delete root.dataset.anim;
  }
  apply();

  document.addEventListener("DOMContentLoaded", () => {
    /* ---------- theme bar ---------- */
    const bar = document.getElementById("themebar");
    let modeBtn, animBtn;
    const refresh = () => {
      if (modeBtn) modeBtn.textContent = mode === "dark" ? "☾" : "☀";
      if (animBtn) animBtn.setAttribute("aria-pressed", String(anim));
    };
    if (bar) {
      modeBtn = document.createElement("button");
      modeBtn.className = "mode"; modeBtn.type = "button";
      modeBtn.title = "Switch light (green) / dark (lime)";
      modeBtn.setAttribute("aria-label", "Switch between light and dark mode");
      modeBtn.onclick = () => { mode = mode === "dark" ? "light" : "dark"; set("toolbox-mode", mode); apply(); refresh(); };
      bar.appendChild(modeBtn);

      // Pages with ambient.js (data-ambient on <body>) have canvas scenes instead of CSS Motion.
      if (!document.body.hasAttribute("data-ambient")) {
        animBtn = document.createElement("button");
        animBtn.className = "toggle"; animBtn.type = "button"; animBtn.textContent = "Motion";
        animBtn.title = "Slow background and digit animation";
        animBtn.onclick = () => { anim = !anim; set("toolbox-anim", anim ? "on" : "off"); apply(); refresh(); };
        bar.appendChild(animBtn);
      }
      refresh();
    }

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
