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

/** Zuletzt geladene Berichte (null = noch nicht geladen) */
let adminErrors = null;
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
    <h1 class="large-title">Fehlerberichte</h1>`;
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
    <div class="fb-list">${list}</div>`;
}

async function adminLoad() {
  try {
    adminErrors = (await adminRequest('GET', '/errors')).errors || [];
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
