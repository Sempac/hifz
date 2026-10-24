// Cache de l'application pour qu'elle s'ouvre sans internet.
// Changer VERSION quand la liste SHELL change.
const VERSION = 'hifz-v4';
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
  const save = (res) => {
    if (res.ok) {
      const copy = res.clone();
      caches.open(VERSION).then((c) => c.put(e.request, copy));
    }
    return res;
  };
  if (url.origin === location.origin) {
    // Fichiers de l'application : toujours la dernière version si le réseau répond,
    // sinon la copie en cache (utilisation hors ligne).
    // (no-cache : revérifie auprès du serveur au lieu d'utiliser le cache HTTP de 10 min)
    e.respondWith(fetch(e.request.url, { cache: 'no-cache' }).then(save).catch(() => caches.match(e.request, { ignoreSearch: true })));
  } else if (url.hostname.endsWith('gstatic.com') || url.hostname === 'fonts.googleapis.com') {
    // Polices Google : mises en cache au premier chargement.
    e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).then(save)));
  }
});
