// Mosaicus — service worker: mette in cache l'app per l'uso offline.
// Quando pubblichi una nuova versione, cambia CACHE (es. 'mosaicus-v0.2').
const CACHE = 'mosaicus-v0.10.0';
const FILES = [
  './', './index.html', './manifest.webmanifest', './css/fonts.css', './css/style.css',
  './js/app.js', './js/analysis.js', './js/chart.js', './js/experiments.js', './js/fits.js',
  './js/serial.js', './js/simulator.js', './js/storage.js', './js/export.js', './js/formula.js', './js/workbench.js', './js/phone.js',
  './js/dsp.js', './js/audio.js', './js/screen.js', './js/scope.js', './js/synth.js',
  './icons/icon.svg', './icons/icon-dark.svg', './icons/icon-192.png', './icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('mosaicus-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Prima la cache (funziona senza rete), poi la rete per ciò che non è in cache.
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});
