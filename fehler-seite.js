// Std-Protokoll – Fehlerberichte lesen und Mitteilungen dazu (nur für den Admin).
// Der Admin tritt mit dem Admin-Code statt dem Team-Code bei (der Server nimmt beide an); danach prüft die App still,
// ob der Code ein Admin-Code ist. Nur dann zeigt die Team-Seite oben links ein Symbol zur Seite #/fehler.
// Ohne Admin-Code (Secret ADMIN_CODE im Worker) liefert der Server nichts; nur angemeldete Geräte bekommen Mitteilungen.
//
// Eigener Speicher (nicht in der Sicherung): { code, push } – push: dieses Gerät ist für Mitteilungen angemeldet

const ADMIN_KEY = 'stdprotokoll.admin.v1';
/** Öffentlicher VAPID-Schlüssel (der private liegt als Secret VAPID_JWK im Worker) */
const ADMIN_VAPID = 'BHutxrRB0RgOWwrmIxMSdu53MLksisWtRgAiOZ-o5ohpzpeM1Tc5BGWMKMGSGXVxOOMoqLhL6f62BAkhLmWYgrc';

let admin = null;
try {
  admin = JSON.parse(localStorage.getItem(ADMIN_KEY) || 'null');
} catch {}
const saveAdmin = () => {
  try {
    if (admin) localStorage.setItem(ADMIN_KEY, JSON.stringify(admin));
    else localStorage.removeItem(ADMIN_KEY);
  } catch {}
};

/** Zuletzt geladene Berichte (null = noch nicht geladen) und Speicherbelegung des Servers */
let adminErrors = null;
let adminStorage = null;
/** Team diesen Monat ({ month, people: [{ name, version, updated, sheets }], posts }) und Antwortzeit des Servers in ms */
let adminTeam = null;
let adminPing = null;
let adminBusy = false;

async function adminRequest(method, path, body, code = admin && admin.code) {
  const res = await fetch(TEAM_URL + path, {
    method,
    headers: { 'X-Team-Code': (team && team.code) || '', 'X-Admin-Code': code || '', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'fehler'), { status: res.status });
  return data;
}

const adminPushPossible = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

/** Nach dem Beitreten: ist der Code auch ein Admin-Code? Für alle anderen still ohne Folgen */
async function adminCheck(code) {
  try {
    adminErrors = (await adminRequest('GET', '/errors', null, code)).errors || [];
    admin = { code, push: false };
    saveAdmin();
    if (currentView === 'team') renderTeamNav();
  } catch {}
}

/** Team verlassen: Admin-Rechte und Mitteilungen auf diesem Gerät beenden (der Server löscht die Anmeldung beim nächsten Versand) */
function adminForget() {
  if (!admin) return;
  if (admin.push && adminPushPossible())
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then((sub) => sub && sub.unsubscribe())
      .catch(() => {});
  admin = null;
  adminErrors = null;
  saveAdmin();
}

/** Symbol oben links auf der Team-Seite (Liste mit Warnzeichen) */
const adminIcon = () => svg('<path d="M12 3.8 2.6 20h18.8z"/><path d="M12 10v4.6"/><path d="M12 17.4v.1"/>', 22);

function fehlerRoute(hash) {
  if (hash !== '#/fehler') return false;
  // Ohne Admin-Code gibt es hier nichts zu sehen
  if (!admin || !team) {
    location.replace('#/team');
    return true;
  }
  currentView = 'fehler';
  renderFehler();
  adminLoad();
  return true;
}

function renderFehler() {
  const nav = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title">Server</h1>`;
  const push = admin.push && adminPushPossible() && Notification.permission === 'granted';
  const list =
    adminErrors == null
      ? `<p class="tm-msg muted">Wird geladen …</p>`
      : !adminErrors.length
        ? `<p class="tm-msg muted">Keine Fehler</p>`
        : adminErrors
            .map(
              (e) => `<div class="card fb-item">
                <div class="fb-h"><b>${escapeHtml(e.name || '?')}</b><span>${teamAgo(e.created)}</span></div>
                <div class="fb-msg">${escapeHtml(e.message)}</div>
                <div class="fb-meta">${escapeHtml(e.version || '–')} · ${escapeHtml(e.view || '')}${e.count > 1 ? ` · ${e.count}×` : ''}</div>
                ${e.stack ? `<details class="fb-stack"><summary>Codestelle</summary><pre>${escapeHtml(e.stack)}</pre></details>` : ''}
              </div>`
            )
            .join('');
  app.innerHTML = `${nav}
    <div class="card fb-push">
      <span>Mitteilungen</span>
      <button class="link-btn" data-fb="${push ? 'push-off' : 'push-on'}" ${adminBusy ? 'disabled' : ''}>${push ? 'Ausschalten' : 'Einschalten'}</button>
    </div>
    ${adminPushPossible() ? '' : '<p class="footnote">Mitteilungen nur in der App vom Home-Bildschirm.</p>'}
    ${adminServerHTML()}
    ${adminStorageHTML(adminStorage)}
    ${adminTeamHTML(adminTeam)}
    <h2 class="section-title">Fehlerberichte</h2>
    <div class="fb-list">${list}</div>`;
}

/** Antwortzeit beim letzten Laden: grün bis 400 ms, gelb bis 1,5 s, sonst rot */
function adminServerHTML() {
  if (adminPing == null) return '';
  const c = adminPing <= 400 ? 'var(--success)' : adminPing <= 1500 ? 'var(--warning)' : 'var(--danger)';
  return `<div class="card fb-row"><span>Antwortzeit</span><span class="fb-ping"><i style="background:${c}"></i>${adminPing.toLocaleString('de-DE')} ms</span></div>`;
}

/** Nummer aus „std-protokoll-v29“ (0 = unbekannt) */
const adminVer = (v) => Number(String(v || '').split('-v')[1]) || 0;

/** Team diesen Monat: Zahlen, Tag der Löschung, je Person App-Version (veraltete gelb) und letzter Upload */
function adminTeamHTML(tm) {
  if (!tm) return '';
  const people = tm.people || [];
  const sheets = people.reduce((n, p) => n + (p.sheets || 0), 0);
  const newest = Math.max(adminVer(teamAppVersion), ...people.map((p) => adminVer(p.version)));
  const [y, m] = String(tm.month).split('-').map(Number);
  const cleanup = y && m ? fmtDayMonth(new Date(y, m, 1)) : '';
  const rows = people
    .map((p) => {
      const v = adminVer(p.version);
      return `<div class="fb-person"><b>${escapeHtml(p.name || '?')}</b><span class="${v && v >= newest ? 'muted' : 'fb-old'}">${v ? `v${v}` : 'Version ?'}</span><span class="muted">${p.updated ? teamAgo(p.updated) : ''}</span></div>`;
    })
    .join('');
  return `<div class="card fb-store">
      <div class="fb-store-h"><span>Team diesen Monat</span><span class="muted">Löschung am ${cleanup}</span></div>
      <div class="fb-count"><span><b>${people.length}</b> ${people.length === 1 ? 'Person' : 'Personen'}</span><span><b>${sheets}</b> Zettel</span><span><b>${tm.posts || 0}</b> ${tm.posts === 1 ? 'Nachricht' : 'Nachrichten'}</span></div>
      ${rows}
    </div>`;
}

const adminBytes = (n) =>
  n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toLocaleString('de-DE', { maximumFractionDigits: n < 10240 ? 1 : 0 })} KB` : `${(n / 1048576).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB`;

/** Speicher des Servers: wie voll, und was ihn belegt (Zettel, Teammeeting, Fehlerberichte, Rest = Datenbank selbst) */
function adminStorageHTML(s) {
  if (!s || !s.total) return '';
  const parts = [
    ['Zettel', s.sheets, 'var(--accent)'],
    ['Teammeeting', s.posts, 'var(--success)'],
    ['Fehlerberichte', s.errors, 'var(--danger)'],
    ['Datenbank', Math.max(0, s.total - s.sheets - s.posts - s.errors), 'var(--muted)'],
  ];
  const legend = `<div class="fb-legend">${parts.map(([n, v, c]) => `<span><i style="background:${c}"></i>${n}<b>${adminBytes(v)}</b></span>`).join('')}</div>`;
  // Balken bis zum Limit; jeder belegte Teil mindestens 3 px breit, damit man ihn sieht
  return `<div class="card fb-store">
      <div class="fb-store-h"><span>Speicher</span><span class="muted">${adminBytes(s.total)} von ${adminBytes(s.limit)}</span></div>
      <div class="fb-bar">${parts.map(([, v, c]) => (v ? `<i style="width:max(3px, ${(v / s.limit) * 100}%);background:${c}"></i>` : '')).join('')}</div>
      ${legend}
    </div>`;
}

async function adminLoad() {
  try {
    const t0 = performance.now();
    const data = await adminRequest('GET', '/errors');
    adminPing = Math.round(performance.now() - t0);
    adminErrors = data.errors || [];
    adminStorage = data.storage || null;
    adminTeam = data.team || null;
  } catch (e) {
    if (e.status === 403) {
      adminForget();
      if (currentView === 'fehler') location.replace('#/team');
      return;
    }
    if (adminErrors == null) adminErrors = [];
  }
  if (currentView === 'fehler') renderFehler();
}

const adminKeyBytes = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));

/** Mitteilungen einschalten: muss direkt aus dem Antippen kommen (sonst fragt iOS nicht) */
async function adminPushOn() {
  if (!adminPushPossible()) return toast('Nur in der App vom Home-Bildschirm');
  adminBusy = true;
  try {
    if ((await Notification.requestPermission()) !== 'granted') throw Object.assign(new Error('perm'), { perm: true });
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: adminKeyBytes(ADMIN_VAPID) }));
    await adminRequest('PUT', '/push', sub.toJSON());
    admin.push = true;
    saveAdmin();
    haptic();
  } catch (e) {
    toast(e.perm ? 'Mitteilungen nicht erlaubt' : 'Keine Verbindung');
  }
  adminBusy = false;
  renderFehler();
}

async function adminPushOff() {
  adminBusy = true;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await adminRequest('DELETE', '/push', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    admin.push = false;
    saveAdmin();
  } catch {
    toast('Keine Verbindung');
  }
  adminBusy = false;
  renderFehler();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-fb]');
  if (!el || layer.contains(el)) return;
  switch (el.dataset.fb) {
    case 'push-on':
      adminPushOn();
      break;
    case 'push-off':
      adminPushOff();
      break;
  }
});
// Mitteilung angetippt, App war schon offen: der Service Worker schickt die Seite
if ('serviceWorker' in navigator)
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (e.data && e.data.go === '#/fehler') location.hash = '#/fehler';
  });
