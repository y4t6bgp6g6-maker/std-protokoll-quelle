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
/** Wörterbuch des Servers (richtige Schreibweisen, nach der KI) und KI-Verbrauch heute ({ day, neurons, limit }) */
let adminDict = null;
let adminAi = null;
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
  renderFehler(true);
  adminLoad();
  return true;
}

/** full: ganze Seite (beim Betreten); sonst nur der Inhalt unter der Überschrift, damit die Einblend-Animation
 *  nicht ein zweites Mal läuft, wenn kurz danach die frischen Daten kommen */
function renderFehler(full = false) {
  const body = !full && document.getElementById('fb-body');
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
  const html = `
    <div class="card fb-push">
      <span>Mitteilungen</span>
      <button class="link-btn" data-fb="${push ? 'push-off' : 'push-on'}" ${adminBusy ? 'disabled' : ''}>${push ? 'Ausschalten' : 'Einschalten'}</button>
    </div>
    ${adminPushPossible() ? '' : '<p class="footnote">Mitteilungen nur in der App vom Home-Bildschirm.</p>'}
    ${adminServerHTML()}
    ${adminStorageHTML(adminStorage)}
    ${adminAiHTML(adminAi)}
    ${adminDictHTML(adminDict)}
    ${adminTeamHTML(adminTeam)}
    <h2 class="section-title">Fehlerberichte</h2>
    <div class="fb-list">${list}</div>`;
  if (body) body.innerHTML = html;
  else app.innerHTML = `${nav}<div id="fb-body">${html}</div>`;
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

/** KI-Kontingent heute als Ring: Neuronen von den kostenlosen am Tag; neu ab 0 Uhr UTC (bei uns 1 bzw. 2 Uhr) */
function adminAiHTML(ai) {
  if (!ai || !ai.limit) return '';
  const used = Math.round(ai.neurons || 0);
  const share = Math.min(1, used / ai.limit);
  const r = 22;
  const len = 2 * Math.PI * r;
  const color = share >= 0.95 ? 'var(--danger)' : share >= 0.8 ? 'var(--warning)' : 'var(--accent)';
  const [y, m, d] = String(ai.day).split('-').map(Number);
  const reset = new Date(Date.UTC(y, m - 1, d + 1)).toLocaleTimeString('de-DE', { hour: 'numeric', minute: '2-digit' });
  return `<div class="card fb-store fb-ai">
      <svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="${r}" fill="none" stroke="var(--fill)" stroke-width="7"/>${
        used ? `<circle cx="28" cy="28" r="${r}" fill="none" stroke="${color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${len * share} ${len}" transform="rotate(-90 28 28)"/>` : ''
      }<text x="28" y="32" text-anchor="middle">${Math.round(share * 100)}%</text></svg>
      <div><div>KI heute</div><div class="fb-sub">${used.toLocaleString('de-DE')} von ${ai.limit.toLocaleString('de-DE')} Neuronen<br>neu um ${reset} Uhr</div></div>
    </div>`;
}

/** Wörterbuch: richtige Schreibweisen, die nach der KI gelten (gleiche Buchstaben, andere Schreibweise → ersetzt) */
function adminDictHTML(dict) {
  if (!dict) return '';
  return `<div class="card fb-store">
      <div class="fb-store-h"><span>Wörterbuch</span><span class="muted">${dict.length}</span></div>
      <form class="fb-dict-add" data-fb-form="dict"><input data-fb-word placeholder="Richtige Schreibweise" maxlength="80" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done"><button class="fb-dict-btn" aria-label="Hinzufügen">${ICON.plus}</button></form>
      ${dict.length ? `<div class="fb-chips">${dict.map((w) => `<span class="fb-chip">${escapeHtml(w)}<button data-fb="dict-del" data-word="${escapeHtml(w)}" aria-label="Löschen">${ICON.close}</button></span>`).join('')}</div>` : ''}
    </div>`;
}

async function adminDictChange(method, word) {
  word = String(word || '').replace(/\s+/g, ' ').trim();
  if (!word || adminBusy) return;
  adminBusy = true;
  try {
    adminDict = (await adminRequest(method, '/dict', { word })).dict || adminDict;
    haptic();
  } catch {
    toast('Keine Verbindung');
  }
  adminBusy = false;
  if (currentView === 'fehler' && admin) renderFehler();
}

async function adminLoad() {
  try {
    const t0 = performance.now();
    const data = await adminRequest('GET', '/errors');
    adminPing = Math.round(performance.now() - t0);
    adminErrors = data.errors || [];
    adminStorage = data.storage || null;
    adminTeam = data.team || null;
    adminDict = data.dict || [];
    adminAi = data.ai || null;
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
  if (adminBusy) return;
  if (!adminPushPossible()) return toast('Nur in der App vom Home-Bildschirm');
  adminSetBusy(true);
  try {
    if ((await Notification.requestPermission()) !== 'granted') throw Object.assign(new Error('perm'), { perm: true });
    const reg = await navigator.serviceWorker.ready;
    const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: adminKeyBytes(ADMIN_VAPID) }));
    await adminRequest('PUT', '/push', sub.toJSON());
    if (admin) {
      admin.push = true;
      saveAdmin();
    }
    haptic();
  } catch (e) {
    toast(e.perm ? 'Mitteilungen nicht erlaubt' : 'Keine Verbindung');
  }
  adminSetBusy(false);
}

async function adminPushOff() {
  if (adminBusy) return;
  adminSetBusy(true);
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (sub) {
      await adminRequest('DELETE', '/push', { endpoint: sub.endpoint });
      await sub.unsubscribe();
    }
    if (admin) {
      admin.push = false;
      saveAdmin();
    }
  } catch {
    toast('Keine Verbindung');
  }
  adminSetBusy(false);
}

/** Knopf sperren bzw. freigeben; neu zeichnen nur, wenn die Seite noch offen ist (man kann währenddessen zurückgehen) */
function adminSetBusy(on) {
  adminBusy = on;
  if (currentView === 'fehler' && admin) renderFehler();
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
    case 'dict-del':
      adminDictChange('DELETE', el.dataset.word);
      break;
  }
});
document.addEventListener('submit', (e) => {
  if (!e.target.matches('[data-fb-form="dict"]')) return;
  e.preventDefault();
  adminDictChange('PUT', e.target.querySelector('[data-fb-word]').value);
});
// Mitteilung angetippt, App war schon offen: der Service Worker schickt die Seite (ist sie schon offen, neu laden)
if ('serviceWorker' in navigator)
  navigator.serviceWorker.addEventListener('message', (e) => {
    if (!e.data || e.data.go !== '#/fehler') return;
    if (location.hash === '#/fehler' && currentView === 'fehler') adminLoad();
    else location.hash = '#/fehler';
  });
