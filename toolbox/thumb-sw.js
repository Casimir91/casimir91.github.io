// Thumb Calculator · service worker: the calculator works offline.
// Scope is only thumb.html (Groovebox has its own worker for the rest of /toolbox/).
// Strategy "network first": online you always get the newest files (they are also stored); offline, or if the
// network is slower than 4 s, the stored copy is used. No version number to bump after a publish.
const CACHE = 'thumb-app';
const FILES = [
  'thumb.html', 'thumb.js', 'thumb.css', 'thumb-edit.js', 'radial.js', 'radial.css', 'calculator-engine.js',
  'toolbox.css', 'toolbox.js', 'thumb.webmanifest',
  'vendor/mathlive/mathlive.min.mjs', 'vendor/mathlive/mathlive-fonts.css', 'vendor/mathlive/mathlive-static.css',
  '../img/thumb-192.png', '../img/thumb-512.png', '../img/thumb-maskable-512.png', '../img/thumb-apple-180.png',
].map((f) => new URL(f, self.location).href);
const FONTS_CSS = new URL('vendor/mathlive/mathlive-fonts.css', self.location).href;
const KEY = (u) => u.origin + u.pathname;   // a query such as ?source=pwa must not create a second entry
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const known = new Set(FILES);
const wanted = (u) => known.has(KEY(u)) || u.pathname.includes('/toolbox/vendor/mathlive/fonts/');

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    const put = (u) => fetch(u, { cache: 'reload' }).then((r) => { if (r.ok) return c.put(u, r.clone()).then(() => r); }).catch(() => {});
    await Promise.all(FILES.map(put));
    // the MathLive fonts are listed in its stylesheet: store them too, so the fractions look right offline
    try {
      const css = await (await c.match(FONTS_CSS)).text();
      const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map((m) => new URL(m[1].replace(/["']/g, ''), FONTS_CSS).href))];
      await Promise.all(urls.map(put));
    } catch (err) {}
    await self.skipWaiting();
  })());
});
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n.startsWith('thumb-') && n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin || !wanted(u)) return; // everything else goes straight to the network
  e.respondWith((async () => {
    const c = await caches.open(CACHE), key = KEY(u);
    const net = fetch(key + u.search, { cache: 'no-cache' }).then((res) => { if (res.ok) c.put(key, res.clone()); return res; });
    try { return await Promise.race([net, sleep(4000).then(() => { throw new Error('slow'); })]); }
    catch (err) { return (await c.match(key)) || net; }
  })());
});
