// Groovebox · service worker: the app works offline.
// Strategy "network first": online you always get the newest files (they are also stored); offline, or if the
// network is slower than 4 s, the stored copy is used. No version number to bump after a publish.
const CACHE = 'groovebox-app';
const FILES = [
  'groovebox.html', 'groovebox.js', 'gb-export.js', 'gb-song.js', 'gb-fx.js', 'lame.min.js', 'toolbox.css', 'toolbox.js', 'groovebox.webmanifest',
  '../mosaicus/app/js/audio.js', '../mosaicus/app/js/screen.js', '../mosaicus/app/js/dsp.js',
  '../img/groovebox-192.png', '../img/groovebox-512.png', '../img/groovebox-maskable-512.png', '../img/groovebox-apple-180.png',
].map((f) => new URL(f, self.location).href);
const KEY = (u) => u.origin + u.pathname;   // a query such as ?source=pwa must not create a second entry
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(FILES.map((u) => fetch(u, { cache: 'reload' }).then((r) => r.ok && c.put(u, r)).catch(() => {})))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => e.waitUntil(caches.keys().then((k) => Promise.all(k.filter((n) => n.startsWith('groovebox-') && n !== CACHE).map((n) => caches.delete(n)))).then(() => self.clients.claim())));

self.addEventListener('fetch', (e) => {
  const r = e.request, u = new URL(r.url);
  if (r.method !== 'GET' || u.origin !== self.location.origin || !FILES.includes(KEY(u))) return; // everything else goes straight to the network
  e.respondWith((async () => {
    const c = await caches.open(CACHE), key = KEY(u);
    const net = fetch(key + u.search, { cache: 'no-cache' }).then((res) => { if (res.ok) c.put(key, res.clone()); return res; });
    try { return await Promise.race([net, sleep(4000).then(() => { throw new Error('slow'); })]); }
    catch (err) { return (await c.match(key)) || net; }
  })());
});
