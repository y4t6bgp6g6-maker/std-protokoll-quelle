// Offline-Cache: Mit Internet wird immer die neueste Version geladen, ohne Internet die gespeicherte.
const CACHE = 'std-protokoll-v96';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'i18n.js',
  'i18n-ru.js',
  'fehlerbericht.js',
  'fehler-seite.js',
  'pdf.js',
  'berichtsheft-vorlagen.js',
  'berichtsheft-pdf.js',
  'berichtsheft.js',
  'holidays.js',
  'import.js',
  'lohn.js',
  'payslip.js',
  'lock.js',
  'team.js',
  'konto.js',
  'karten.js',
  'fonts/special-elite.woff2',
  'manifest.webmanifest',
  'icons/apple-touch-icon.png?v=4',
  'icons/icon-192.png?v=4',
  'icons/icon-512.png?v=4',
  'icons/icon-maskable-512.png?v=4',
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

let slowUntil = 0;
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== location.origin) return;
  // Netz zuerst, bei schlechtem Empfang aber höchstens 2 s warten, dann die gespeicherte Version.
  // Kommt die Antwort später doch noch, landet sie trotzdem im Cache (gilt dann beim nächsten Start).
  let put = Promise.resolve();
  const net = fetch(req, { cache: 'no-cache' }).then((res) => {
    if (res.ok) {
      const copy = res.clone();
      put = caches.open(CACHE).then((c) => c.put(req, copy));
    }
    return res;
  });
  event.waitUntil(net.then(() => put).catch(() => {}));
  const cached = () => caches.open(CACHE).then(async (c) => (await c.match(req, { ignoreSearch: true })) || (await c.match('./')));
  event.respondWith(
    new Promise((resolve, reject) => {
      let done = false;
      const finish = (res) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        res ? resolve(res) : reject(new Error('offline'));
      };
      // Ohne gespeicherte Version weiter aufs Netz warten. War das Netz eben zu langsam, nicht erneut 2 s warten.
      const timer = setTimeout(() => {
        slowUntil = Date.now() + 10000;
        cached().then((res) => res && finish(res));
      }, Date.now() < slowUntil ? 0 : 2000);
      net.then(finish, () => cached().then(finish, () => finish(null)));
    })
  );
});

// Mitteilungen über neue Fehlerberichte (nur Admin-Geräte sind beim Server angemeldet)
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch {}
  event.waitUntil(self.registration.showNotification(d.title || 'Fehlerbericht', { body: d.body || '', tag: 'fehler', renotify: true }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      const win = list[0];
      if (win) {
        win.postMessage({ go: '#/fehler' });
        return win.focus();
      }
      return self.clients.openWindow(new URL('./#/fehler', self.registration.scope).href);
    })
  );
});
