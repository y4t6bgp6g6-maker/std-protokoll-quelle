// Offline-Cache: Mit Internet wird immer die neueste Version geladen, ohne Internet die gespeicherte.
const CACHE = 'yetizettel-v59';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'pdf.js',
  'holidays.js',
  'import.js',
  'lohn.js',
  'payslip.js',
  'manifest.webmanifest',
  'fonts/schibsted-grotesk.woff2',
  'fonts/plex-mono-600.woff2',
  'fonts/plex-mono-700.woff2',
  'icons/apple-touch-icon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Nur eigene alte Versionen löschen: andere Apps unter derselben Adresse (github.io) haben eigene Caches
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('yetizettel-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  event.respondWith(
    caches.open(CACHE).then(async (cache) => {
      try {
        const res = await fetch(req, { cache: 'no-cache' });
        if (res.ok) cache.put(req, res.clone());
        return res;
      } catch {
        return (await cache.match(req, { ignoreSearch: true })) || (await cache.match('./'));
      }
    })
  );
});
