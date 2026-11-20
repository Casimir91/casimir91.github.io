# Registra gli spezzoni video della guida (pagina ermesfrosi.it/mosaicus/) con Playwright e li codifica in MP4 con ffmpeg.
# Uso: python3 tools/registra_guida.py [misura elabora onde hero]   (serve: pip install playwright, Google Chrome, ffmpeg)
# I percorsi in alto (APP, RAW, OUT) vanno adattati al proprio computer.
# Registra gli spezzoni della guida di Mosaicus (temi chiaro e scuro) e li codifica in MP4.
import asyncio, subprocess, time, json, os, sys
from playwright.async_api import async_playwright

APP = 'http://localhost:8765/index.html'
RAW = '/home/claude/rec/raw'
OUT = '/home/claude/rec/out'
os.makedirs(RAW, exist_ok=True); os.makedirs(OUT, exist_ok=True)
VW, VH = 1280, 800

CURSOR = r"""
addEventListener('DOMContentLoaded', () => {
  const c = document.createElement('div');
  c.style.cssText = 'position:fixed;left:0;top:0;width:30px;height:30px;margin:-15px 0 0 -15px;border-radius:50%;' +
    'background:rgba(255,255,255,.55);border:2.5px solid #00302A;box-shadow:0 0 0 3px rgba(255,255,255,.6),0 4px 12px rgba(0,0,0,.35);' +
    'z-index:2147483647;pointer-events:none;transition:transform .1s ease-out;transform:translate(-200px,-200px)';
  document.documentElement.append(c);
  let x = -200, y = -200, s = 1;
  const upd = () => (c.style.transform = `translate(${x}px,${y}px) scale(${s})`);
  addEventListener('mousemove', (e) => { x = e.clientX; y = e.clientY; upd(); }, true);
  addEventListener('mousedown', () => { s = 0.72; upd(); }, true);
  addEventListener('mouseup', () => { s = 1; upd(); }, true);
});
"""

class Session:
    def __init__(self, pg, theme, tag):
        self.pg, self.theme, self.tag = pg, theme, tag
        self.t0 = time.time(); self.segs = []; self.cur = None
    def now(self): return time.time() - self.t0
    def begin(self, name, crop): self.cur = {'name': name, 'start': self.now(), 'crop': crop}
    def end(self): self.cur['end'] = self.now(); self.segs.append(self.cur); self.cur = None

def crop_at(x, y, w=960, h=600):
    x = max(0, min(VW - w, int(x))); y = max(0, min(VH - h, int(y)))
    return {'x': x, 'y': y, 'w': w, 'h': h}

async def box(pg, sel):
    return await pg.locator(sel).first.bounding_box()

async def glide(pg, x, y, steps=22):
    await pg.mouse.move(x, y, steps=steps); await pg.wait_for_timeout(120)

async def click(pg, sel, wait=500):
    b = await box(pg, sel)
    await glide(pg, b['x'] + b['width'] / 2, b['y'] + b['height'] / 2)
    await pg.mouse.down(); await pg.wait_for_timeout(90); await pg.mouse.up()
    await pg.wait_for_timeout(wait)

async def drag(pg, x1, y1, x2, y2, steps=30):
    await glide(pg, x1, y1)
    await pg.mouse.down(); await pg.wait_for_timeout(120)
    await pg.mouse.move(x2, y2, steps=steps); await pg.wait_for_timeout(120)
    await pg.mouse.up(); await pg.wait_for_timeout(300)

async def new_session(br, theme, tag, vw=VW, vh=VH):
    ctx = await br.new_context(viewport={'width': vw, 'height': vh}, device_scale_factor=1, color_scheme=theme,
                               record_video_dir=f'{RAW}/{tag}-{theme}', record_video_size={'width': vw, 'height': vh}, accept_downloads=True)
    await ctx.add_init_script(f"try{{localStorage.setItem('mosaicus.theme', JSON.stringify('{theme}'))}}catch(e){{}}")
    await ctx.add_init_script(CURSOR)
    pg = await ctx.new_page()
    s = Session(pg, theme, tag)
    await pg.goto(APP); await pg.wait_for_timeout(900)
    return ctx, pg, s

async def finish(ctx, pg, s):
    await pg.wait_for_timeout(300)
    await ctx.close()
    path = await pg.video.path()
    return {'video': path, 'theme': s.theme, 'segs': s.segs}

# ---------------------------------------------------------------- Misura
async def misura(br, theme):
    ctx, pg, s = await new_session(br, theme, 'misura')
    # M1 scegli l'esperimento
    s.begin('m1', crop_at(0, 64))
    await glide(pg, 200, 300, 10)
    await click(pg, '.exp-card[data-id="cooling"]', 900)
    await click(pg, '.exp-card[data-id="scope"]', 1000)
    await click(pg, '.exp-card[data-id="harmonic"]', 1100)
    s.end()
    # M2 collega
    sim = await box(pg, '#btnSim')
    s.begin('m2', crop_at(VW - 960, 0))
    await glide(pg, sim['x'] - 120, sim['y'] + 200, 10)
    await click(pg, '#btnSim', 1600)
    s.end()
    # M3 start e stop
    main = await box(pg, '#page-misura .main')
    s.begin('m3', crop_at(main['x'] - 12, main['y'] - 8))
    await click(pg, '#btnStart', 5200)
    await click(pg, '#btnStop', 1800)
    s.end()
    # M4 scegli un tratto
    cell = await box(pg, '#chartStack .chart-cell')
    s.begin('m4', crop_at(main['x'] - 12, cell['y'] - 140))
    await drag(pg, cell['x'] + cell['width'] * 0.3, cell['y'] + cell['height'] * 0.5, cell['x'] + cell['width'] * 0.82, cell['y'] + cell['height'] * 0.55, 34)
    await pg.wait_for_timeout(1400)
    s.end()
    # M5 invialo
    await pg.locator('#btnSaveSel').scroll_into_view_if_needed(); await pg.wait_for_timeout(300)
    sb = await box(pg, '#btnSaveSel')
    s.begin('m5', {'x': 0, 'y': 0, 'w': VW, 'h': VH})
    await click(pg, '#btnSaveSel', 900)
    await click(pg, '.toast-act', 1800)
    s.end()
    return await finish(ctx, pg, s)

# ---------------------------------------------------------------- Elabora (moto rettilineo, piano inclinato)
JS_CHART_PX = """([t1, t2]) => { const c = window.__mosaicus.group.charts[0]; const r = c.c.getBoundingClientRect();
  return [r.left + c.sx(t1), r.left + c.sx(t2), r.top + r.height / 2]; }"""

async def elabora(br, theme):
    ctx, pg, s = await new_session(br, theme, 'elabora', 1160, 725)
    await pg.click('.exp-card[data-id="motion"]'); await pg.click('#btnSim'); await pg.wait_for_selector('.pill-on')
    await pg.click('#btnStart'); await pg.wait_for_timeout(4200); await pg.click('#btnStop'); await pg.wait_for_timeout(500)
    rows = await pg.evaluate("window.__mosaicus.state.rows.map(r => [r.t, r.x, r.v])")
    xs = [r for r in rows if r[1] is not None]
    xmax = max(r[1] for r in xs); t_stop = next(r[0] for r in xs if r[1] >= xmax - 0.005)
    t1, t2 = 1.25, max(1.6, t_stop - 0.25)
    X1, X2, Y = await pg.evaluate(JS_CHART_PX, [t1, t2])
    await pg.mouse.move(X1, Y); await pg.mouse.down(); await pg.mouse.move(X2, Y, steps=10); await pg.mouse.up()
    await pg.click('#btnSaveSel'); await pg.wait_for_timeout(300)
    await pg.click('.nav-btn[data-page="elab"]'); await pg.wait_for_timeout(700)
    await pg.evaluate("window.scrollTo(0, document.querySelector('.box').getBoundingClientRect().top + scrollY - 8)"); await pg.wait_for_timeout(300)
    crop = {'x': 0, 'y': 0, 'w': 1160, 'h': 725}
    # E1 il riquadro: cambio la grandezza sull'asse y
    s.begin('e1', crop)
    sy = await box(pg, '.box .sy')
    await glide(pg, sy['x'] + sy['width'] / 2, sy['y'] + sy['height'] / 2)
    for k in ['v', 'a', 'x']:
        await pg.mouse.down(); await pg.mouse.up()
        await pg.select_option('.box .sy', k); await pg.wait_for_timeout(1300)
    s.end()
    # E2 retta a occhio su v(t)
    await pg.select_option('.box .sy', 'v'); await pg.wait_for_timeout(500)
    s.begin('e2', crop)
    await click(pg, '.box [data-tool="line"]', 600)
    info = await pg.evaluate("""() => { const { box, v } = document.querySelector('.box').__mz; const c = v.chart, r = c.c.getBoundingClientRect();
      const pts = box.rows.filter(q => isFinite(q[box.xKey]) && isFinite(q[box.yKey])).map(q => [q[box.xKey], q[box.yKey]]);
      const n = pts.length, sx = pts.reduce((a, p) => a + p[0], 0), sy = pts.reduce((a, p) => a + p[1], 0);
      const sxx = pts.reduce((a, p) => a + p[0] * p[0], 0), sxy = pts.reduce((a, p) => a + p[0] * p[1], 0);
      const m = (n * sxy - sx * sy) / (n * sxx - sx * sx), q = (sy - m * sx) / n;
      const x0 = pts[0][0], x1 = pts[n - 1][0];
      const P = (x, y) => [r.left + c.sx(x), r.top + c.sy(y)];
      const e = v.eye;
      const ta = x0 + 0.2 * (x1 - x0), tb = x0 + 0.8 * (x1 - x0);
      return { h1: P(e.h1.x, e.h1.y), h2: P(e.h2.x, e.h2.y), g1: P(ta, m * ta + q + 0.004), g2: P(tb, m * tb + q - 0.003),
               c1: P(x0 + 0.15 * (x1 - x0), m * (x0 + 0.15 * (x1 - x0)) + q), c2: P(x0 + 0.85 * (x1 - x0), m * (x0 + 0.85 * (x1 - x0)) + q) }; }""")
    await drag(pg, *info['h1'], *info['g1'], 26)
    await drag(pg, *info['h2'], *info['g2'], 26)
    await pg.wait_for_timeout(500)
    await click(pg, '.box [data-act="next"]', 600)
    for k in ['c1', 'c2']:
        X, Y = info[k]; await glide(pg, X, Y); await pg.mouse.down(); await pg.mouse.up(); await pg.wait_for_timeout(600)
    await click(pg, '.box [data-act="cmp"]', 2200)
    s.end()
    # E3 fit: x(t) con la parabola
    await pg.select_option('.box .sy', 'x'); await pg.wait_for_timeout(500)
    s.begin('e3', crop)
    await click(pg, '.box [data-tool="fit"]', 700)
    await click(pg, '.box [data-model="poly2"]', 2600)
    s.end()
    return await finish(ctx, pg, s)

# ---------------------------------------------------------------- Righello, salva, esporta + apertura (oscilloscopio)
async def hero(br, theme):
    ctx, pg, s = await new_session(br, theme, 'hero')
    await pg.click('.exp-card[data-id="scope"]'); await pg.wait_for_timeout(400)
    sc = await box(pg, '#instrPanel')
    # apertura: suoni diversi sulla stessa nota
    s.begin('hero', crop_at(sc['x'] - 12, sc['y'] - 8))
    await click(pg, '[data-src="ex"]', 1700)
    await click(pg, '[data-ex="voce"]', 1600)
    await click(pg, '[data-ex="clarinetto"]', 1600)
    await click(pg, '[data-ex="violino"]', 1300)
    s.end()
    return await finish(ctx, pg, s)

async def onde(br, theme):
    ctx, pg, s = await new_session(br, theme, 'onde', 1160, 725)
    await pg.click('.exp-card[data-id="scope"]'); await pg.wait_for_timeout(400)
    await pg.click('[data-src="ex"]'); await pg.wait_for_timeout(1500)
    await pg.click('.freeze'); await pg.wait_for_timeout(300)
    await pg.click('.send'); await pg.wait_for_timeout(400)
    await pg.click('.toast-act'); await pg.wait_for_timeout(800)
    await pg.click('[data-ex="violino"]') if False else None
    await pg.evaluate("window.scrollTo(0, document.querySelector('.box').getBoundingClientRect().top + scrollY - 8)"); await pg.wait_for_timeout(300)
    crop = {'x': 0, 'y': 0, 'w': 1160, 'h': 725}
    # E4 righello: due creste distanti 3 periodi
    info = await pg.evaluate("""() => { const { box, v } = document.querySelector('.box').__mz; const c = v.chart, r = c.c.getBoundingClientRect();
      const t = box.rows.map(q => q.t), y = box.rows.map(q => q[box.yKey]);
      const mx = Math.max(...y.filter(isFinite)); const crest = [];
      for (let i = 2; i < y.length - 2; i++) if (y[i] > 0.9 * mx && y[i] >= y[i - 1] && y[i] >= y[i + 1] && y[i] >= y[i - 2] && y[i] >= y[i + 2]) { if (!crest.length || t[i] - crest[crest.length - 1] > 1) crest.push(t[i]); }
      const R = v.ruler, mid = r.top + r.height * 0.5;
      const X = (x) => r.left + c.sx(x);
      return { a: [X(R.x1), mid], b: [X(R.x2), mid], c1: [X(crest[0]), mid], c2: [X(crest[3] ?? crest[crest.length - 1]), mid], n: Math.min(3, crest.length - 1) }; }""")
    s.begin('e4', crop)
    await drag(pg, *info['a'], *info['c1'], 26)
    await drag(pg, *info['b'], *info['c2'], 30)
    for _ in range(info['n'] - 1):
        await click(pg, '.box [data-n="1"]', 650)
    await pg.wait_for_timeout(1600)
    s.end()
    # E5 salva ed esporta
    await pg.evaluate("window.scrollTo(0, 0)"); await pg.wait_for_timeout(300)
    s.begin('e5', crop)
    await click(pg, '.box [data-act="save"]', 900)
    ck = await box(pg, '.box .box-check input')          # la spunta «Esporta» c'è già: la indico soltanto
    await glide(pg, ck['x'] + ck['width'] / 2, ck['y'] + ck['height'] / 2); await pg.wait_for_timeout(700)
    await click(pg, '#wbExport', 1500)
    s.end()
    await click(pg, '[data-ex="violino"]', 10) if False else None
    return await finish(ctx, pg, s)

def encode(meta):
    for seg in meta['segs']:
        name = f"{seg['name']}-{meta['theme']}"
        c = seg['crop']
        ss, dur = max(0, seg['start'] - 0.15), seg['end'] - seg['start'] + 0.15
        vf = f"crop={c['w']}:{c['h']}:{c['x']}:{c['y']},scale=800:-2:flags=lanczos,fps=25"
        mp4 = f"{OUT}/{name}.mp4"; jpg = f"{OUT}/{name}.jpg"
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-ss', f'{ss:.2f}', '-t', f'{dur:.2f}', '-i', meta['video'], '-vf', vf,
                        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', mp4], check=True)
        # poster: l'ultimo fotogramma (il risultato del passo)
        subprocess.run(['ffmpeg', '-y', '-loglevel', 'error', '-sseof', '-0.3', '-i', mp4, '-frames:v', '1', '-q:v', '5', jpg], check=True)
        print(name, os.path.getsize(mp4) // 1024, 'kB', f"{dur:.1f}s")

async def main():
    srv = subprocess.Popen(['python3', '-m', 'http.server', '8765', '--directory', os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'app')], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(1)
    which = sys.argv[1:] or ['misura', 'elabora', 'onde', 'hero']
    try:
        async with async_playwright() as p:
            br = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--autoplay-policy=no-user-gesture-required'])
            for theme in ['light', 'dark']:
                for fn in [f for f in (misura, elabora, onde, hero) if f.__name__ in which]:
                    meta = await fn(br, theme)
                    json.dump(meta, open(f"{RAW}/{fn.__name__}-{theme}.json", 'w'))
                    encode(meta)
            await br.close()
    finally:
        srv.terminate()

asyncio.run(main())
