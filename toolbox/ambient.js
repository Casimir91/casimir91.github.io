/* Toolbox ambient scenes: falling leaves, rain, sea, snow, with synthesized sound.

   Why not CSS: the interactive whiteboards (LIM) run old Android WebViews that
   ignore color-mix() and `inset`, and often report prefers-reduced-motion. Here
   everything is drawn on a <canvas> with plain 2D calls, colours are fixed per
   scene, and the scene is an explicit choice of the teacher, so reduced-motion
   is deliberately not applied.

   Sound is generated with the Web Audio API (no audio files):
   - rain   = pink noise band-limited 500-7000 Hz + random "near drops"
   - sea    = brown noise through a low-pass filter whose cut-off follows the swell
   - leaves = wind (band-passed brown noise) modulated by gusts + rustle bursts
   - snow   = soft low wind only
   The same functions wind(t) and swell(t) drive both picture and sound, so a
   gust bends the leaves when you hear it and the surf rises with the sea level.

   Usage: <body data-ambient> ... <script src="ambient.js"></script> before </body>.
   Written in ES2017 without optional chaining etc. on purpose (old WebViews). */
(function () {
  "use strict";
  var root = document.documentElement, body = document.body;
  if (!body) return;

  function get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function rnd(a, b) { return a + Math.random() * (b - a); }
  function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
  function clamp(x, a, b) { return x < a ? a : x > b ? b : x; }
  function now() { return (window.performance && performance.now ? performance.now() : Date.now()) / 1000; }

  var SCENES = ["off", "leaves", "rain", "sea", "snow"];
  var LABELS = { off: "Scene: off", leaves: "🍂 Leaves", rain: "🌧 Rain", sea: "🌊 Sea", snow: "❄ Snow" };
  var SOUND_ICONS = ["🔇", "🔈", "🔊"];
  var SOUND_NAMES = ["off", "low", "high"];
  var SOUND_LEVELS = [0, 0.35, 0.9];

  var scene = get("toolbox-scene", "off");
  if (SCENES.indexOf(scene) < 0) scene = "off";
  var level = parseInt(get("toolbox-sound", "0"), 10) || 0;
  if (level < 0 || level > 2) level = 0;

  /* ---------- shared "weather" (seconds -> value) ---------- */
  // Quasi-periodic wind: three incommensurate sines, so the pattern never visibly repeats.
  function wind(t) { return 0.55 * Math.sin(t * 0.13) + 0.3 * Math.sin(t * 0.37 + 1.3) + 0.15 * Math.sin(t * 0.91 + 0.4); }
  function gust(t) { return clamp((wind(t) + 0.2) / 1.2, 0, 1); }
  var SWELL_T = 9; // period of the slow rise and fall of the sea, in seconds
  function swell(t) { return Math.sin(2 * Math.PI * t / SWELL_T); }

  /* ---------- canvas ---------- */
  var style = document.createElement("style");
  style.textContent =
    "#ambient{position:fixed;left:0;top:0;width:100%;height:100%;z-index:-1;pointer-events:none;display:none}" +
    "body.done #ambient{display:none!important}" +
    /* a halo in the background colour keeps the digits readable over leaves and drops */
    "html[data-scene] .digits{text-shadow:0 0 .04em var(--bg),0 0 .1em var(--bg)}" +
    "html[data-scene] .setup label,html[data-scene] .status{color:var(--fg);text-shadow:0 0 3px var(--bg),0 0 6px var(--bg)}";
  document.head.appendChild(style);

  var cv = document.createElement("canvas");
  cv.id = "ambient";
  cv.setAttribute("aria-hidden", "true");
  body.insertBefore(cv, body.firstChild);
  var ctx = cv.getContext("2d");

  var W = 0, H = 0, S = 1, U = 1; // CSS size, backing-store scale, size unit
  function resize() {
    W = window.innerWidth; H = window.innerHeight;
    // Weak whiteboard GPUs: never render more than ~1920 px wide, the browser upscales.
    S = Math.min(window.devicePixelRatio || 1, 1.5);
    if (W * S > 1920) S = 1920 / W;
    cv.width = Math.max(1, Math.round(W * S));
    cv.height = Math.max(1, Math.round(H * S));
    U = clamp(Math.min(W, H) / 900, 0.5, 2);
  }

  var dark = false;
  function readTheme() {
    dark = root.getAttribute("data-mode") === "dark";
    var rgb = dark ? "255,255,255" : "95,130,170";
    snowSprite = makeFlake(rgb);
    crystalSprites = [makeCrystal(rgb, 0), makeCrystal(rgb, 1), makeCrystal(rgb, 2)];
  }

  /* ---------- sprites (pre-rendered once, then just copied: cheap) ---------- */
  var LEAF_COLORS = ["#c0392b", "#d35400", "#e67e22", "#e8a317", "#a04000", "#8e5a2b", "#b03a2e", "#c9a227"];
  // half outline of a maple leaf, normalised; mirrored for the other half
  var MAPLE = [[0, -1], [.13, -.6], [.4, -.8], [.33, -.4], [.85, -.5], [.6, -.18], [.93, .06],
               [.46, .13], [.52, .42], [.14, .3], [.05, .55]];
  function makeLeaf(color, maple) {
    var c = document.createElement("canvas"); c.width = c.height = 64;
    var g = c.getContext("2d"), i;
    g.translate(32, 32);
    g.fillStyle = color;
    g.beginPath();
    if (maple) {
      for (i = 0; i < MAPLE.length; i++) g.lineTo(MAPLE[i][0] * 28, MAPLE[i][1] * 28);
      for (i = MAPLE.length - 1; i >= 0; i--) g.lineTo(-MAPLE[i][0] * 28, MAPLE[i][1] * 28);
    } else {
      g.moveTo(0, 26);
      g.bezierCurveTo(22, 14, 20, -14, 0, -30);
      g.bezierCurveTo(-20, -14, -22, 14, 0, 26);
    }
    g.closePath(); g.fill();
    // soft light from the top-left
    g.globalCompositeOperation = "source-atop";
    var lg = g.createLinearGradient(-28, -28, 28, 28);
    lg.addColorStop(0, "rgba(255,255,220,.28)"); lg.addColorStop(1, "rgba(0,0,0,.18)");
    g.fillStyle = lg; g.fillRect(-32, -32, 64, 64);
    g.globalCompositeOperation = "source-over";
    // stem, midrib and veins
    g.strokeStyle = "rgba(70,30,0,.5)"; g.lineWidth = 1.6; g.lineCap = "round";
    g.beginPath(); g.moveTo(0, 31); g.lineTo(0, maple ? -24 : -26);
    if (maple) {
      var tips = [[11, -21], [22, -12], [24, 2], [13, 11]];
      for (i = 0; i < tips.length; i++) { g.moveTo(0, 12); g.lineTo(tips[i][0], tips[i][1]); g.moveTo(0, 12); g.lineTo(-tips[i][0], tips[i][1]); }
    } else {
      var vy = [14, 4, -6, -16], len = [11, 14, 12, 7];
      for (i = 0; i < vy.length; i++) { g.moveTo(0, vy[i]); g.lineTo(len[i], vy[i] - 9); g.moveTo(0, vy[i]); g.lineTo(-len[i], vy[i] - 9); }
    }
    g.stroke();
    return c;
  }
  var LEAF_SPRITES = [];
  for (var li = 0; li < LEAF_COLORS.length; li++) {
    LEAF_SPRITES.push(makeLeaf(LEAF_COLORS[li], false));
    LEAF_SPRITES.push(makeLeaf(LEAF_COLORS[li], true));
  }
  function makeFlake(rgb) {
    var c = document.createElement("canvas"); c.width = c.height = 32;
    var g = c.getContext("2d"), rg = g.createRadialGradient(16, 16, 0, 16, 16, 16);
    rg.addColorStop(0, "rgba(" + rgb + ",1)"); rg.addColorStop(0.35, "rgba(" + rgb + ",.85)"); rg.addColorStop(1, "rgba(" + rgb + ",0)");
    g.fillStyle = rg; g.fillRect(0, 0, 32, 32);
    return c;
  }
  /* A six-armed snow crystal (dendrite): 60° symmetry, side branches at 60° to each arm. */
  function makeCrystal(rgb, variant) {
    var c = document.createElement("canvas"); c.width = c.height = 128;
    var g = c.getContext("2d"), i, j;
    g.translate(64, 64);
    g.strokeStyle = "rgba(" + rgb + ",1)"; g.lineCap = "round";
    g.shadowColor = "rgba(" + rgb + ",.8)"; g.shadowBlur = 6;
    var branches = [[[0.35, 0.3], [0.62, 0.22], [0.82, 0.12]],
                    [[0.45, 0.38], [0.75, 0.2]],
                    [[0.3, 0.18], [0.5, 0.3], [0.7, 0.18]]][variant % 3];
    for (i = 0; i < 6; i++) {
      g.save(); g.rotate(i * Math.PI / 3);
      g.lineWidth = 5; g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -56); g.stroke();
      g.lineWidth = 3.5; g.beginPath();
      for (j = 0; j < branches.length; j++) {
        var y = -56 * branches[j][0], l = 56 * branches[j][1];
        g.moveTo(0, y); g.lineTo(l * 0.866, y - l * 0.5);
        g.moveTo(0, y); g.lineTo(-l * 0.866, y - l * 0.5);
      }
      g.stroke(); g.restore();
    }
    g.lineWidth = 3; g.beginPath();                 // small hexagon at the centre
    for (i = 0; i <= 6; i++) g.lineTo(13 * Math.sin(i * Math.PI / 3), -13 * Math.cos(i * Math.PI / 3));
    g.stroke();
    return c;
  }
  var snowSprite = null, crystalSprites = [];

  /* ---------- particle scenes ---------- */
  var parts = [], splashes = [], density = 1;
  function howMany(area, min, max) { return Math.round(clamp(W * H / area, min, max) * density); }
  function byDepth(a, b) { return a.z - b.z; } // far first, near last

  var SC = {};

  /* Leaves: a falling leaf reaches a low terminal velocity quickly, then sways
     side to side (pendulum-like "flutter") and flips over (tumbling). */
  SC.leaves = {
    init: function () {
      parts = [];
      for (var i = 0, n = howMany(60000, 8, 30); i < n; i++) {
        var z = rnd(0.45, 1);
        var p = { z: z, size: rnd(60, 105) * U * z, vy: rnd(40, 75) * U * (0.6 + 0.4 * z),
          a: rnd(15, 45) * U, w: rnd(0.8, 1.7), ph: rnd(0, 6.28), rot: rnd(0, 6.28), rv: rnd(-0.6, 0.6),
          fw: rnd(1, 2.6), fp: rnd(0, 6.28), img: pick(LEAF_SPRITES) };
        this.place(p, false); parts.push(p);
      }
      parts.sort(byDepth);
    },
    place: function (p, top) { p.x = rnd(-100, W + 100); p.y = top ? rnd(-H * 0.4, -50) : rnd(-50, H); },
    frame: function (dt, t) {
      var wv = wind(t) * 110 * U;
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i], sway = Math.sin(p.w * t + p.ph);
        p.x += (wv * p.z + p.a * p.w * Math.cos(p.w * t + p.ph)) * dt;
        p.y += p.vy * (1 + 0.35 * Math.abs(sway)) * dt;
        p.rot += p.rv * dt;
        if (p.y > H + 50 || p.x < -160 || p.x > W + 160) this.place(p, true);
        var ang = p.rot + 0.5 * sway, sx = Math.cos(p.fw * t + p.fp), k = p.size / 64;
        var c = Math.cos(ang) * k * S, s = Math.sin(ang) * k * S;
        ctx.globalAlpha = 0.5 + 0.45 * p.z;
        ctx.setTransform(c * sx, s * sx, -s, c, p.x * S, p.y * S);
        ctx.drawImage(p.img, -32, -32);
      }
    }
  };

  /* Rain: streaks whose length is speed x "exposure time" (motion blur), three
     depth layers for parallax, splashes (ring + two ballistic droplets) in front. */
  SC.rain = {
    init: function () {
      parts = []; splashes = [];
      for (var i = 0, n = howMany(9000, 60, 230); i < n; i++) {
        var p = { z: rnd(0.25, 1) }; p.v = rnd(900, 1300) * U * (0.45 + 0.55 * p.z);
        this.place(p, false); parts.push(p);
      }
    },
    place: function (p, top) {
      p.x = rnd(-0.25 * W, 1.1 * W); p.y = top ? rnd(-H * 0.3, 0) : rnd(0, H);
      p.floor = H - rnd(0, 0.18) * H * (1 - p.z);
    },
    frame: function (dt, t) {
      var slant = 0.12 + 0.18 * wind(t), i, p, L;
      for (i = 0; i < parts.length; i++) {
        p = parts[i]; p.x += slant * p.v * dt; p.y += p.v * dt;
        if (p.y > p.floor) {
          if (p.z > 0.6 && splashes.length < 160) splashes.push({ x: p.x, y: p.floor, z: p.z, age: 0,
            d: [{ x: p.x, y: p.floor, vx: rnd(30, 90) * U, vy: -rnd(120, 220) * U },
                { x: p.x, y: p.floor, vx: -rnd(30, 90) * U, vy: -rnd(120, 220) * U }] });
          this.place(p, true);
        }
      }
      var rgb = dark ? "200,222,255" : "45,75,115";
      var layers = [[0.25, 0.5, 0.9, 0.3], [0.5, 0.75, 1.4, 0.45], [0.75, 1.01, 2.1, 0.65]];
      ctx.setTransform(S, 0, 0, S, 0, 0); ctx.globalAlpha = 1; ctx.lineCap = "round";
      for (L = 0; L < layers.length; L++) {
        ctx.beginPath();
        for (i = 0; i < parts.length; i++) {
          p = parts[i]; if (p.z < layers[L][0] || p.z >= layers[L][1]) continue;
          var len = p.v * 0.03;
          ctx.moveTo(p.x, p.y); ctx.lineTo(p.x - slant * len, p.y - len);
        }
        ctx.lineWidth = layers[L][2] * U; ctx.strokeStyle = "rgba(" + rgb + "," + layers[L][3] + ")"; ctx.stroke();
      }
      ctx.lineWidth = 1.2 * U;
      for (i = splashes.length - 1; i >= 0; i--) {
        var s = splashes[i]; s.age += dt;
        if (s.age > 0.4) { splashes.splice(i, 1); continue; }
        var f = s.age / 0.4, r = (3 + 14 * f) * U * s.z;
        ctx.globalAlpha = (1 - f) * 0.6;
        ctx.strokeStyle = "rgb(" + rgb + ")"; ctx.fillStyle = ctx.strokeStyle;
        ctx.beginPath(); ctx.ellipse(s.x, s.y, r, r * 0.3, 0, 0, 6.2832); ctx.stroke();
        ctx.beginPath();
        for (var j = 0; j < 2; j++) {
          var d = s.d[j]; d.vy += 1400 * U * dt; d.x += d.vx * dt; d.y += d.vy * dt;
          ctx.moveTo(d.x + 1.6 * U, d.y); ctx.arc(d.x, d.y, 1.6 * U, 0, 6.2832);
        }
        ctx.fill();
      }
    }
  };

  /* Sea: four layers, each a sum of sinusoidal waves. Each component obeys the
     deep-water dispersion relation omega = sqrt(g k): long waves travel faster.
     The whole sea rises and falls with swell(t), which also drives the surf sound. */
  var SEA_WAVES = [[880, 16, 1], [470, 9, 1], [260, 5, -1], [150, 2.5, 1]]; // wavelength px, amplitude px, direction
  var G_EFF = 60; // "gravity" in px/s^2 chosen for a calm look (scales out of the omega formula)
  SC.sea = {
    init: function () { parts = []; },
    frame: function (dt, t) {
      var fills = dark
        ? ["rgba(80,140,190,.45)", "rgba(60,120,175,.6)", "rgba(42,98,152,.78)", "rgba(28,76,128,.92)"]
        : ["rgba(150,200,232,.6)", "rgba(100,165,210,.7)", "rgba(58,122,178,.8)", "rgba(30,86,140,.9)"];
      var sw = swell(t), step = 10, i, j, x;
      ctx.setTransform(S, 0, 0, S, 0, 0); ctx.globalAlpha = 1;
      for (i = 0; i < 4; i++) {
        var base = H * (0.66 + 0.085 * i) - 14 * U * sw * (0.6 + 0.13 * i);
        var amp = U * (0.6 + 0.25 * i), atot = 0, ys = [];
        for (j = 0; j < SEA_WAVES.length; j++) atot += SEA_WAVES[j][1] * amp;
        for (x = -step; x <= W + step; x += step) {
          var y = base;
          for (j = 0; j < SEA_WAVES.length; j++) {
            var lam = SEA_WAVES[j][0] * U, k = 2 * Math.PI / lam;
            var om = Math.sqrt(G_EFF * 2 * Math.PI / SEA_WAVES[j][0]) * (0.8 + 0.12 * i);
            y -= SEA_WAVES[j][1] * amp * Math.sin(k * x - SEA_WAVES[j][2] * om * t + i * 1.7 + j * 0.9);
          }
          ys.push(y);
        }
        ctx.beginPath(); ctx.moveTo(-step, H);
        for (j = 0; j < ys.length; j++) ctx.lineTo(-step + j * step, ys[j]);
        ctx.lineTo(W + step, H); ctx.closePath();
        ctx.fillStyle = fills[i]; ctx.fill();
        if (i >= 1) { // foam: a thin edge everywhere, thicker on the crests
          ctx.beginPath();
          for (j = 0; j < ys.length; j++) ctx.lineTo(-step + j * step, ys[j]);
          ctx.lineWidth = 1.2 * U; ctx.strokeStyle = "rgba(255,255,255," + (0.15 + 0.1 * i) + ")"; ctx.stroke();
          ctx.beginPath();
          for (j = 1; j < ys.length; j++) {
            if (base - ys[j] > 0.55 * atot && base - ys[j - 1] > 0.55 * atot) {
              ctx.moveTo(-step + (j - 1) * step, ys[j - 1]); ctx.lineTo(-step + j * step, ys[j]);
            }
          }
          ctx.lineWidth = (1.5 + i) * U; ctx.strokeStyle = "rgba(255,255,255," + (0.35 + 0.12 * i) + ")"; ctx.stroke();
        }
      }
    }
  };

  /* Snow: small flakes, slow terminal velocity, gentle sway, drift with the wind. */
  SC.snow = {
    init: function () {
      parts = [];
      for (var i = 0, n = howMany(14000, 40, 140); i < n; i++) {
        // about one in five is a big crystal in the foreground, the rest are distant dots
        var crystal = Math.random() < 0.2, z = crystal ? rnd(0.65, 1) : rnd(0.3, 1);
        var p = { z: z, crystal: crystal, kind: (Math.random() * 3) | 0,
          r: crystal ? rnd(20, 40) * U * z : rnd(2.5, 6) * U * (0.5 + 0.8 * z),
          vy: rnd(25, 55) * U * (0.4 + 0.6 * z) * (crystal ? 0.8 : 1),
          a: rnd(10, 35) * U, w: rnd(0.4, 1.2), ph: rnd(0, 6.28), rot: rnd(0, 6.28), rv: rnd(-0.5, 0.5) };
        this.place(p, false); parts.push(p);
      }
      parts.sort(byDepth);
    },
    place: function (p, top) { p.x = rnd(-60, W + 60); p.y = top ? rnd(-H * 0.3, -60) : rnd(-60, H); },
    frame: function (dt, t) {
      var wv = wind(t * 0.7) * 45 * U;
      ctx.setTransform(S, 0, 0, S, 0, 0);
      for (var i = 0; i < parts.length; i++) {
        var p = parts[i];
        p.x += (wv * p.z + p.a * p.w * Math.cos(p.w * t + p.ph)) * dt; p.y += p.vy * dt;
        if (p.y > H + 60 || p.x < -100 || p.x > W + 100) this.place(p, true);
        ctx.globalAlpha = 0.55 + 0.45 * p.z;
        if (p.crystal) {
          p.rot += p.rv * dt;
          var k = p.r / 64 * S, c = Math.cos(p.rot) * k, s = Math.sin(p.rot) * k;
          ctx.setTransform(c, s, -s, c, p.x * S, p.y * S);
          ctx.drawImage(crystalSprites[p.kind], -64, -64);
          ctx.setTransform(S, 0, 0, S, 0, 0);
        } else {
          ctx.drawImage(snowSprite, p.x - 2 * p.r, p.y - 2 * p.r, 4 * p.r, 4 * p.r);
        }
      }
    }
  };

  /* ---------- animation loop with automatic quality ---------- */
  var raf = window.requestAnimationFrame || function (f) { return setTimeout(f, 33); };
  var looping = false, lastT = now(), ema = 1 / 60, slowFor = 0;
  function frame() {
    if (scene === "off") { looping = false; return; }
    raf(frame);
    var t = now(), dt = Math.min(0.05, t - lastT); lastT = t;
    if (document.hidden || body.classList.contains("done")) return;
    // If the board cannot keep ~30 fps for 2 s, remove a quarter of the particles.
    ema = ema * 0.95 + dt * 0.05;
    if (ema > 0.034) { slowFor += dt; if (slowFor > 2 && density > 0.3) { density *= 0.75; SC[scene].init(); slowFor = 0; ema = 1 / 60; } }
    else slowFor = 0;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1;
    ctx.clearRect(0, 0, cv.width, cv.height);
    SC[scene].frame(dt, t);
  }

  function setScene(s) {
    scene = s; set("toolbox-scene", s);
    parts = []; splashes = []; density = 1;
    if (s === "off") { root.removeAttribute("data-scene"); cv.style.display = "none"; }
    else {
      root.setAttribute("data-scene", s); cv.style.display = "block";
      SC[s].init();
      if (!looping) { looping = true; lastT = now(); raf(frame); }
    }
    updateButtons(); updateAudio();
  }

  /* ---------- sound (Web Audio API) ---------- */
  var AC = window.AudioContext || window.webkitAudioContext;
  var ac = null, master = null, pinkBuf = null, brownBuf = null, cur = null, unlocked = false;

  function makeNoise(kind) {
    var len = ac.sampleRate * 6, buf = ac.createBuffer(1, len, ac.sampleRate), d = buf.getChannelData(0);
    var b0 = 0, b1 = 0, b2 = 0, last = 0;
    for (var i = 0; i < len; i++) {
      var w = Math.random() * 2 - 1;
      if (kind === "pink") { // Paul Kellet's filter: about -3 dB/octave
        b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913;
        d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.2;
      } else {               // brown (red) noise: integrated white noise, -6 dB/octave
        last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5;
      }
    }
    return buf;
  }
  function ensureAudio() {
    if (!AC) return false;
    if (!ac) {
      try { ac = new AC(); } catch (e) { AC = null; return false; }
      master = ac.createGain(); master.gain.value = 0; master.connect(ac.destination);
      pinkBuf = makeNoise("pink"); brownBuf = makeNoise("brown");
    }
    if (ac.state === "suspended" && ac.resume) ac.resume();
    return true;
  }
  function loopSrc(buf) { var s = ac.createBufferSource(); s.buffer = buf; s.loop = true; s.start(0, Math.random() * 5); return s; }
  function filt(type, f, q) { var b = ac.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; }
  function amp(v) { var g = ac.createGain(); g.gain.value = v; return g; }
  function chain() { for (var i = 0; i < arguments.length - 1; i++) arguments[i].connect(arguments[i + 1]); }
  // a short click of band-passed noise: a single drop, a crackling leaf
  function click(out, f, q, vol, at, dur) {
    var s = ac.createBufferSource(), g = amp(0); s.buffer = pinkBuf;
    chain(s, filt("bandpass", f, q), g, out);
    g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + 0.003);
    g.gain.exponentialRampToValueAtTime(0.001, at + dur);
    s.start(at, Math.random() * 5); s.stop(at + dur + 0.02);
  }

  var AUDIO = {
    rain: function (out) {
      var s1 = loopSrc(pinkBuf), s2 = loopSrc(brownBuf);
      chain(s1, filt("highpass", 500), filt("lowpass", 7000), amp(0.42), out);
      chain(s2, filt("lowpass", 220), amp(0.35), out);
      return { srcs: [s1, s2], tick: function () {
        var n = (Math.random() * 2.2) | 0, at = ac.currentTime + 0.02;
        for (var i = 0; i < n; i++) click(out, rnd(1800, 5200), 4, rnd(0.4, 1.4), at + rnd(0, 0.05), rnd(0.03, 0.07));
      } };
    },
    sea: function (out) {
      var s1 = loopSrc(brownBuf), s2 = loopSrc(pinkBuf), lp = filt("lowpass", 400, 0.7), g1 = amp(0.3), g2 = amp(0.02);
      chain(s1, lp, g1, out); chain(s2, filt("highpass", 2500), g2, out);
      return { srcs: [s1, s2], tick: function (t) {
        // the surf peaks a moment after the crest of the swell
        var u = Math.pow(0.5 + 0.5 * Math.sin(2 * Math.PI * t / SWELL_T - 0.6), 3), at = ac.currentTime;
        lp.frequency.setTargetAtTime(250 + 1500 * u, at, 0.15);
        g1.gain.setTargetAtTime(0.25 + 1.1 * u, at, 0.15);
        g2.gain.setTargetAtTime(0.02 + 0.3 * u, at, 0.15);
      } };
    },
    leaves: function (out) {
      var s1 = loopSrc(brownBuf), s2 = loopSrc(pinkBuf), bp = filt("bandpass", 400, 0.6), g1 = amp(0.3), g2 = amp(0);
      chain(s1, bp, g1, out); chain(s2, filt("highpass", 1500), filt("bandpass", 3500, 0.8), g2, out);
      return { srcs: [s1, s2], tick: function (t) {
        var g = gust(t), at = ac.currentTime;
        bp.frequency.setTargetAtTime(250 + 450 * g, at, 0.3);
        g1.gain.setTargetAtTime(0.35 + 1.4 * g, at, 0.3);
        if (Math.random() < 0.03 + 0.25 * g) { // a rustle burst, more frequent in a gust
          var a = at + rnd(0, 0.05), d = rnd(0.1, 0.4), v = rnd(0.3, 0.9) * (0.4 + g);
          g2.gain.cancelScheduledValues(a); g2.gain.setTargetAtTime(v, a, 0.02); g2.gain.setTargetAtTime(0, a + d, d * 0.4);
          for (var i = 0, n = 2 + ((Math.random() * 5) | 0); i < n; i++) click(out, rnd(2500, 6000), 1.5, rnd(0.3, 0.9), a + rnd(0, d), 0.025);
        }
      } };
    },
    snow: function (out) {
      var s1 = loopSrc(brownBuf), lp = filt("lowpass", 300, 0.5), g1 = amp(0.2);
      chain(s1, lp, g1, out);
      return { srcs: [s1], tick: function (t) {
        var g = gust(t * 0.7), at = ac.currentTime;
        lp.frequency.setTargetAtTime(200 + 250 * g, at, 0.4);
        g1.gain.setTargetAtTime(0.7 + 2.2 * g, at, 0.4);
      } };
    }
  };

  function updateAudio() {
    var want = level > 0 && scene !== "off" && !body.classList.contains("done");
    if (!ac) { if (!want || !unlocked || !ensureAudio()) return; }
    var at = ac.currentTime;
    if (cur && (cur.scene !== scene || scene === "off")) {
      var old = cur; cur = null;
      old.out.gain.setTargetAtTime(0, at, 0.3);
      setTimeout(function () {
        for (var i = 0; i < old.srcs.length; i++) { try { old.srcs[i].stop(); } catch (e) {} }
        old.out.disconnect();
      }, 1500);
    }
    if (want && !cur) {
      var out = amp(0); out.connect(master);
      var a = AUDIO[scene](out);
      cur = { scene: scene, out: out, srcs: a.srcs, tick: a.tick };
      out.gain.setTargetAtTime(1, at, 0.5);
    }
    // during the alarm the ambience drops out fast, so the beeps are clearly heard
    master.gain.setTargetAtTime(want ? SOUND_LEVELS[level] : 0, at, want ? 0.4 : 0.05);
  }
  setInterval(function () { if (ac && cur && level > 0) cur.tick(now()); }, 50);

  // Browsers only allow sound after a touch or key press: unlock on the first one.
  function unlock() {
    if (unlocked) return;
    unlocked = true;
    if (level > 0) { ensureAudio(); updateAudio(); }
  }
  ["pointerdown", "touchend", "mousedown", "keydown"].forEach(function (ev) {
    document.addEventListener(ev, unlock, true);
  });

  /* ---------- buttons in the theme bar ---------- */
  var sceneBtn = null, soundBtn = null;
  function updateButtons() {
    if (!sceneBtn) return;
    sceneBtn.textContent = LABELS[scene];
    sceneBtn.setAttribute("aria-pressed", String(scene !== "off"));
    soundBtn.textContent = SOUND_ICONS[level];
    soundBtn.setAttribute("aria-pressed", String(level > 0));
    soundBtn.setAttribute("aria-label", "Ambient sound: " + SOUND_NAMES[level]);
    soundBtn.title = "Ambient sound: " + SOUND_NAMES[level] + " (tap to change)";
  }
  function start() {
    var bar = document.getElementById("themebar");
    if (bar) {
      sceneBtn = document.createElement("button");
      sceneBtn.type = "button"; sceneBtn.className = "toggle";
      sceneBtn.title = "Animated background: off, leaves, rain, sea, snow (tap to change)";
      sceneBtn.onclick = function () { setScene(SCENES[(SCENES.indexOf(scene) + 1) % SCENES.length]); };
      soundBtn = document.createElement("button");
      soundBtn.type = "button"; soundBtn.className = "toggle";
      soundBtn.onclick = function () {
        level = (level + 1) % 3; set("toolbox-sound", String(level));
        unlocked = true; ensureAudio(); updateAudio(); updateButtons();
      };
      bar.appendChild(sceneBtn); bar.appendChild(soundBtn);
    }
    resize(); readTheme(); setScene(scene);

    var rt = null;
    window.addEventListener("resize", function () {
      clearTimeout(rt);
      rt = setTimeout(function () { resize(); if (scene !== "off") SC[scene].init(); }, 200);
    });
    if (window.MutationObserver) {
      new MutationObserver(readTheme).observe(root, { attributes: true, attributeFilter: ["data-mode", "data-palette"] });
      new MutationObserver(updateAudio).observe(body, { attributes: true, attributeFilter: ["class"] });
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  window.ToolboxAmbient = { setScene: setScene, scenes: SCENES };
})();
