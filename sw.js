// Cache de l'application pour qu'elle s'ouvre sans internet.
// Changer VERSION à chaque mise à jour des fichiers.
const VERSION = 'hifz-v3';
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'data/quran.json',
  'icons/icon.svg',
  'icons/icon-192.png',
  'icons/icon-512.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET') return;
  // L'audio est lu en direct, pas mis en cache.
  if (url.hostname === 'everyayah.com') return;
  e.respondWith(
    caches.match(e.request).then((hit) => hit || fetch(e.request).then((res) => {
      // Polices Google : mises en cache au premier chargement.
      if (res.ok && (url.origin === location.origin || url.hostname.endsWith('gstatic.com') || url.hostname === 'fonts.googleapis.com')) {
        const copy = res.clone();
        caches.open(VERSION).then((c) => c.put(e.request, copy));
      }
      return res;
    }))
  );
});
