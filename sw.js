// Offline-Cache: Mit Internet wird immer die neueste Version geladen, ohne Internet die gespeicherte.
const CACHE = 'std-protokoll-v11';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'pdf.js',
  'berichtsheft-vorlagen.js',
  'berichtsheft-pdf.js',
  'berichtsheft.js',
  'holidays.js',
  'import.js',
  'lohn.js',
  'payslip.js',
  'guide.js',
  'lock.js',
  'team.js',
  'manifest.webmanifest',
  'icons/apple-touch-icon.png?v=2',
  'icons/icon-192.png?v=2',
  'icons/icon-512.png?v=2',
  'icons/icon-maskable-512.png?v=2',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      // Nur eigene alte Versionen löschen: andere Apps unter derselben Adresse (github.io) haben eigene Caches
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('std-protokoll-') && k !== CACHE).map((k) => caches.delete(k))))
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
