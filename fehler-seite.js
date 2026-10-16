// Std-Protokoll – Fehlerberichte lesen und Mitteilungen dazu (nur für den Admin).
// Der Admin tritt mit dem Admin-Code statt dem Team-Code bei (der Server nimmt beide an); danach prüft die App still,
// ob der Code ein Admin-Code ist. Nur dann zeigt die Team-Seite oben links ein Symbol zur Seite #/fehler.
// Ohne Admin-Code (Secret ADMIN_CODE im Worker) liefert der Server nichts; nur angemeldete Geräte bekommen Mitteilungen.
//
// Eigener Speicher (nicht in der Sicherung): { code, push, dictIgnore } – push: dieses Gerät ist für Mitteilungen angemeldet;
// dictIgnore: verworfene Wörterbuch-Vorschläge (Schlüssel)

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
/** Team diesen Monat ({ month, people: [{ member, name, version, updated, sheets }], posts }) und Antwortzeit des Servers in ms */
let adminTeam = null;
let adminPing = null;
/** Wörterbuch des Servers (richtige Schreibweisen, nach der KI) und Tagesgrenzen von Cloudflare
 *  ({ day, requests, read, write, ai }, je [verbraucht, Grenze]; neu ab 0 Uhr UTC) */
let adminDict = null;
let adminUsage = null;
/** Konten: [{ user, name, fullname, last, bytes }] (letzte Sicherung, Größe aller Sicherungen) */
let adminAccounts = null;
/** Arbeitsscheine: Namen ohne eindeutiges Konto [{ key, name, n, last }] */
let adminOpen = null;
/** Team-Code der Kollegen (wie ihn der Server gerade annimmt) */
let adminCode = null;
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
    ${adminServerHTML()}
    ${adminStorageHTML(adminStorage)}
    ${adminUsageHTML(adminUsage)}
    ${adminTeamHTML(adminTeam, adminAccounts)}
    ${adminCodeHTML(adminCode)}
    ${adminOpenHTML(adminOpen)}
    <h2 class="section-title">Fehlerberichte</h2>
    <label class="card fb-row fb-push">
      <span>Mitteilungen</span>
      <input type="checkbox" class="toggle" data-fb-push ${push ? 'checked' : ''} ${adminBusy ? 'disabled' : ''}>
    </label>
    ${adminPushPossible() ? '' : '<p class="footnote">Mitteilungen nur in der App vom Home-Bildschirm.</p>'}
    <div class="fb-list">${list}</div>
    ${adminDictHTML(adminDict)}`;
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

/** Team diesen Monat mit den Konten: je Person App-Version (veraltete gelb) und letzter Upload, darunter Benutzername
 *  und letzte Sicherung bzw. „ohne Konto“ (orange); Konten ohne Eintrag in diesem Monat unten („nicht im Team“).
 *  Lang drücken → Menü: aus dem Team entfernen (z. B. doppelt nach Neuinstallation) bzw. Konto löschen */
function adminTeamHTML(tm, accounts) {
  if (!tm) return '';
  const people = tm.people || [];
  const list = accounts || [];
  const byMember = new Map(list.filter((a) => a.member).map((a) => [a.member, a]));
  const sheets = people.reduce((n, p) => n + (p.sheets || 0), 0);
  const newest = Math.max(adminVer(teamAppVersion), ...people.map((p) => adminVer(p.version)));
  const [y, m] = String(tm.month).split('-').map(Number);
  const cleanup = y && m ? fmtDayMonth(new Date(y, m, 1)) : '';
  const sub = (a) =>
    a
      ? `<span class="fb-sub"><span translate="no">${escapeHtml(a.user)}</span> · ${a.last ? `Sicherung ${teamAgo(a.last)}` : 'keine Sicherung'}</span>`
      : '<span class="fb-sub fb-noacc">ohne Konto</span>';
  const rows = people
    .map((p) => {
      const v = adminVer(p.version);
      const a = byMember.get(p.member);
      return `<div class="fb-person" data-fb-hold data-member="${escapeHtml(p.member || '')}" data-user="${escapeHtml(a ? a.user : '')}"><span><b>${escapeHtml(p.name || '?')}</b>${sub(a)}</span><span class="${v && v >= newest ? 'muted' : 'fb-old'}">${v ? `v${v}` : 'Version ?'}</span><span class="muted">${p.updated ? teamAgo(p.updated) : ''}</span></div>`;
    })
    .join('');
  const loose = list
    .filter((a) => !people.some((p) => p.member && p.member === a.member))
    .map(
      (a) =>
        `<div class="fb-person" data-fb-hold data-user="${escapeHtml(a.user)}"><span><b translate="no">${escapeHtml(a.name || a.fullname || a.user)}</b>${sub(a)}</span><span></span><span class="muted">nicht im Team</span></div>`
    )
    .join('');
  return `<div class="card fb-store">
      <div class="fb-store-h"><span>Team diesen Monat</span><span class="muted">Löschung am ${cleanup}</span></div>
      <div class="fb-count"><span><b>${people.length}</b> ${people.length === 1 ? 'Person' : 'Personen'}</span><span><b>${list.length}</b> ${list.length === 1 ? 'Konto' : 'Konten'}</span><span><b>${sheets}</b> Zettel</span><span><b>${tm.posts || 0}</b> ${tm.posts === 1 ? 'Nachricht' : 'Nachrichten'}</span></div>
      ${rows}${loose}
    </div>`;
}

/** Menü nach langem Drücken auf eine Person bzw. ein Konto */
function adminPersonMenu(el) {
  const member = el.dataset.member;
  const user = el.dataset.user;
  const actions = [];
  if (member)
    actions.push({
      label: 'Aus dem Team entfernen',
      destructive: true,
      run: () => confirmDialog('Aus dem Team entfernen?', 'Wird die App dort noch benutzt, kommt der Eintrag zurück.', 'Entfernen', () => adminPersonDelete(member), true),
    });
  if (user)
    actions.push({
      label: 'Konto löschen',
      destructive: true,
      run: () => confirmDialog('Konto löschen?', 'Die Sicherungen auf dem Server werden gelöscht.', 'Löschen', () => adminAccountDelete(user), true),
    });
  if (actions.length) actionSheet(actions);
}

/** Team-Code der Kollegen; Antippen → neuer Code. Gilt sofort, alle müssen ihn danach neu eingeben (der Admin-Code bleibt) */
function adminCodeHTML(code) {
  if (!code) return '';
  return `<button class="card fb-row fb-code" data-fb="code"><span>Team-Code</span><span class="fb-ping"><b translate="no">${escapeHtml(code)}</b>${ICON.chevronRight}</span></button>`;
}

function adminCodeChange() {
  if (adminBusy || !adminCode) return;
  const modal = openModal(
    `<div class="alert-body"><b>Neuer Team-Code</b><div class="alert-msg">Alle müssen danach den neuen Code eingeben.</div>
      <input class="pw-input" data-fb-code placeholder="Team-Code" maxlength="40" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
    </div>
    <div class="alert-buttons"><button data-c="no">Abbrechen</button><button data-c="yes" class="strong">Ändern</button></div>`,
    'alert'
  );
  const input = modal.querySelector('[data-fb-code]');
  const msg = modal.querySelector('.alert-msg');
  const send = async () => {
    const code = input.value.trim();
    if (!code || adminBusy) return;
    if (code.toLowerCase() === adminCode.toLowerCase()) return closeModal();
    if (!/^[\p{L}\p{N}._-]{6,40}$/u.test(code)) return (msg.textContent = 'Mindestens 6 Zeichen, ohne Leerzeichen');
    adminBusy = true;
    try {
      adminCode = (await adminRequest('PUT', '/code', { code })).code || code;
      closeModal();
      haptic();
    } catch (e) {
      msg.textContent = e.message === 'admin' ? 'Das ist der Admin-Code' : e.message === 'code' ? 'Mindestens 6 Zeichen, ohne Leerzeichen' : 'Keine Verbindung';
    }
    adminBusy = false;
    if (currentView === 'fehler' && admin) renderFehler();
  };
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    if (b.dataset.c === 'no') closeModal();
    else send();
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && send());
  setTimeout(() => input.focus(), 50);
}

/** Arbeitsscheine mit Namen, die keinem Konto eindeutig gehören; Antippen ordnet zu (wird gemerkt) */
function adminOpenHTML(list) {
  if (!list || !list.length) return '';
  return `<div class="card fb-store">
      <div class="fb-store-h"><span>Nicht zugeordnet</span><span class="muted">${list.length}</span></div>
      ${list
        .map(
          (o) => `<div class="fb-person" data-fb="open-assign" data-key="${escapeHtml(o.key)}"><b translate="no">${escapeHtml(o.name)}</b><span class="muted">${o.n} ${o.n === 1 ? 'Schein' : 'Scheine'}</span><span class="muted">${teamAgo(o.last)}</span></div>`
        )
        .join('')}
    </div>`;
}
function adminOpenAssign(key) {
  const o = (adminOpen || []).find((x) => x.key === key);
  if (!o || adminBusy) return;
  const send = async (method, body) => {
    adminBusy = true;
    try {
      await adminRequest(method, '/alias', body);
      adminOpen = adminOpen.filter((x) => x.key !== key);
      haptic();
    } catch {
      toast('Keine Verbindung');
    }
    adminBusy = false;
    if (currentView === 'fehler' && admin) renderFehler();
  };
  actionSheet([
    ...(adminAccounts || []).map((a) => ({
      label: `${escapeHtml(a.fullname || a.name || a.user)} <span class="muted">${escapeHtml(a.user)}</span>`,
      run: () => send('PUT', { key, user: a.user }),
    })),
    { label: 'Verwerfen', destructive: true, run: () => send('DELETE', { key }) },
  ]);
}

async function adminAccountDelete(user) {
  if (!user || adminBusy) return;
  adminBusy = true;
  try {
    await adminRequest('DELETE', '/account', { user });
    if (adminAccounts) adminAccounts = adminAccounts.filter((a) => a.user !== user);
    haptic();
  } catch {
    toast('Keine Verbindung');
  }
  adminBusy = false;
  if (currentView === 'fehler' && admin) renderFehler();
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
    ['Sicherungen', s.backups || 0, 'var(--warning)'],
    ['Datenbank', Math.max(0, s.total - s.sheets - s.posts - s.errors - (s.backups || 0)), 'var(--muted)'],
  ];
  const legend = `<div class="fb-legend">${parts.map(([n, v, c]) => `<span><i style="background:${c}"></i>${n}<b>${adminBytes(v)}</b></span>`).join('')}</div>`;
  // Balken bis zum Limit; jeder belegte Teil mindestens 3 px breit, damit man ihn sieht
  return `<div class="card fb-store">
      <div class="fb-store-h"><span>Speicher</span><span class="muted">${adminBytes(s.total)} von ${adminBytes(s.limit)}</span></div>
      <div class="fb-bar">${parts.map(([, v, c]) => (v ? `<i style="width:max(3px, ${(v / s.limit) * 100}%);background:${c}"></i>` : '')).join('')}</div>
      ${legend}
    </div>`;
}

/** Tagesgrenzen des kostenlosen Tarifs (Zahlen von Cloudflare): Anfragen, gelesene und geschriebene Zeilen, KI */
const ADMIN_USAGE = [
  ['requests', 'Anfragen'],
  ['read', 'Gelesen'],
  ['write', 'Geschrieben'],
  ['ai', 'KI'],
];
const adminShareColor = (share) => (share >= 0.95 ? 'var(--danger)' : share >= 0.8 ? 'var(--warning)' : 'var(--accent)');
/** Kurze Zahl: 1.234 → „1.234“, 100.000 → „100.000“, 5.000.000 → „5 Mio.“ */
const adminNum = (n) => (n >= 1e6 ? `${(n / 1e6).toLocaleString('de-DE', { maximumFractionDigits: 1 })} Mio.` : Math.round(n).toLocaleString('de-DE'));
/** Als Ringe im Raster, je Ring Anteil, Verbrauch und Grenze */
function adminUsageHTML(u) {
  if (!u) return '';
  const [y, m, d] = String(u.day).split('-').map(Number);
  const reset = new Date(Date.UTC(y, m - 1, d + 1)).toLocaleTimeString('de-DE', { hour: 'numeric', minute: '2-digit' });
  const items = ADMIN_USAGE.filter(([k]) => u[k]).map(([k, label]) => {
    const [used, limit] = u[k];
    const share = Math.min(1, used / limit);
    return { label, used, limit, share, color: adminShareColor(share) };
  });
  const head = `<div class="fb-store-h"><span>Heute</span><span class="muted">neu um ${reset} Uhr</span></div>`;
  const r = 22;
  const len = 2 * Math.PI * r;
  return `<div class="card fb-store">${head}<div class="fb-rings">${items
    .map(
      (it) => `<div class="fb-ring"><svg width="56" height="56" viewBox="0 0 56 56" aria-hidden="true"><circle cx="28" cy="28" r="${r}" fill="none" stroke="var(--fill)" stroke-width="7"/>${
        it.used ? `<circle cx="28" cy="28" r="${r}" fill="none" stroke="${it.color}" stroke-width="7" stroke-linecap="round" stroke-dasharray="${Math.max(0.5, len * it.share)} ${len}" transform="rotate(-90 28 28)"/>` : ''
      }<text x="28" y="32" text-anchor="middle">${it.share > 0 && it.share < 0.01 ? '<1' : Math.round(it.share * 100)}%</text></svg>
      <div><div>${it.label}</div><div class="fb-sub">${adminNum(it.used)}<br>von ${adminNum(it.limit)}</div></div></div>`
    )
    .join('')}</div></div>`;
}

/** Wörterbuch: richtige Schreibweisen, die nach der KI gelten (gleiche Buchstaben, andere Schreibweise → ersetzt) */
function adminDictHTML(dict) {
  if (!dict) return '';
  return `<div class="card fb-store">
      <div class="fb-store-h"><span>Wörterbuch</span><span class="muted">${dict.length}</span></div>
      <form class="fb-dict-add" data-fb-form="dict"><input data-fb-word placeholder="Richtige Schreibweise" maxlength="80" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done"><button class="fb-dict-btn" aria-label="Hinzufügen">${ICON.plus}</button></form>
      ${dict.length ? `<div class="fb-chips">${dict.map((w) => `<span class="fb-chip">${escapeHtml(w)}<button data-fb="dict-del" data-word="${escapeHtml(w)}" aria-label="Löschen">${ICON.close}</button></span>`).join('')}</div>` : ''}
      ${adminDictSuggestHTML()}
    </div>`;
}

// ───────── Vorschläge fürs Wörterbuch aus den Zetteln auf dem Server ─────────

/** Wie dictKey im Worker: nur Buchstaben und Ziffern, klein, ohne Akzente */
const adminDictKey = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
/** Abstand wie im Worker (ohne Vertauschen), damit nur vorgeschlagen wird, was das Wörterbuch dort auch ersetzt */
function adminDictDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return row[b.length];
}
/** Gleiche Regel wie dictFuzzy im Worker: ab 6 Buchstaben, erster Buchstabe und Ziffern gleich, ein Tippfehler (ab 12 zwei) */
function adminDictNear(a, b) {
  if (a.length < 6 || b.length < 6 || a[0] !== b[0] || a.replace(/\D/g, '') !== b.replace(/\D/g, '')) return false;
  const max = Math.min(a.length, b.length) >= 12 ? 2 : 1;
  return Math.abs(a.length - b.length) <= max && adminDictDistance(a, b) <= max;
}

/** Schreibweisen aus den Zetteln (laufender Monat und Vormonat), die sich nur in Groß-/Kleinschreibung, Satzzeichen
 *  oder einem Tippfehler unterscheiden. Vorschlag = die Schreibweise, die die meisten Personen benutzen (dann die
 *  häufigste). Nur Baustellen (als Ganzes, bis 4 Wörter) – bei Arbeiten kamen nur Beugungsformen heraus. Ohne, was schon im Wörterbuch steht
 *  oder verworfen wurde, und ohne Schreibweisen, die die KI-Prüfung schon richtig korrigiert (dieselbe Prüfung wie bei
 *  den Kollegen, Ergebnis gemerkt in aiStore; ungeprüfte werden nachgefragt, bis dahin fehlt der Vorschlag).
 *  → [{ word, others: [Schreibweisen], n }] */
const adminAiAsking = new Set();
/** Ohne Antwort der KI (Kontingent, Fehler): bis zum nächsten Start nicht neu fragen */
const adminAiNoAnswer = new Set();
function adminDictSuggest() {
  const c = team && team.cache;
  if (!c) return [];
  const forms = new Map(); // Schreibweise → { key, n, who }
  const add = (text, who) => {
    const t = String(text || '').replace(/\s+/g, ' ').replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
    const key = adminDictKey(t);
    if (key.length < 6 || !/\p{L}/u.test(key)) return;
    const f = forms.get(t) || { key, n: 0, who: new Set() };
    f.n++;
    f.who.add(who);
    forms.set(t, f);
  };
  for (const m of [...(c.members || []), ...(c.prevMembers || [])])
    for (const s of m.sheets || [])
      for (const d of s.days || [])
        for (const r of d.rows || []) if (r.site && r.site.trim().split(/\s+/).length <= 4) add(r.site, m.member);
  // Schreibweisen zu Gruppen verbinden (gleicher Schlüssel oder ein Tippfehler)
  const list = [...forms.entries()].map(([word, f]) => ({ word, ...f }));
  const keys = [...new Set(list.map((f) => f.key))];
  const parent = new Map(keys.map((k) => [k, k]));
  const root = (k) => (parent.get(k) === k ? k : root(parent.get(k)));
  for (let i = 0; i < keys.length; i++)
    for (let j = i + 1; j < keys.length; j++) if (adminDictNear(keys[i], keys[j])) parent.set(root(keys[i]), root(keys[j]));
  const groups = new Map();
  for (const f of list) {
    const g = groups.get(root(f.key)) || [];
    g.push(f);
    groups.set(root(f.key), g);
  }
  const known = new Set([...(adminDict || []), ...((admin && admin.dictIgnore) || [])].map(adminDictKey));
  const people = (f) => f.who.size;
  const cand = [...groups.values()]
    .filter((g) => g.length >= 2 && !g.some((f) => known.has(f.key)))
    .map((g) => g.sort((a, b) => people(b) - people(a) || b.n - a.n || a.word.localeCompare(b.word)))
    .map((g) => ({ word: g[0].word, others: g.slice(1).map((f) => f.word), n: g.reduce((x, f) => x + f.n, 0) }))
    .sort((a, b) => b.n - a.n);
  const ai = typeof aiStore !== 'undefined' && aiReady();
  const ask = [];
  const out = [];
  for (const x of cand) {
    if (out.length >= 8) break;
    if (ai) {
      const open = x.others.filter((w) => !(aiNorm(w) in aiStore.spell) && !adminAiAsking.has(aiNorm(w)) && !adminAiNoAnswer.has(aiNorm(w)));
      if (open.length) {
        // erst die KI fragen (höchstens 20 je Anfrage), danach neu zeichnen
        if (ask.length + open.length <= 20) ask.push(...open);
        continue;
      }
      if (x.others.some((w) => adminAiAsking.has(aiNorm(w)))) continue;
      // Ohne Antwort der KI (Kontingent, Fehler) bleibt die Schreibweise drin
      x.others = x.others.filter((w) => {
        const fixed = aiStore.spell[aiNorm(w)];
        return fixed == null || adminDictKey(fixed) !== adminDictKey(x.word);
      });
      if (!x.others.length) continue;
    }
    out.push(x);
  }
  if (ask.length) {
    const items = ask.map(aiNorm);
    items.forEach((t) => adminAiAsking.add(t));
    aiSpellCheck(items).finally(() => {
      // nicht beantwortet: nur hier merken (nicht in aiStore, das gilt auch für die eigenen Einträge)
      for (const t of items) {
        adminAiAsking.delete(t);
        if (!(t in aiStore.spell)) adminAiNoAnswer.add(t);
      }
      if (currentView === 'fehler' && admin) renderFehler();
    });
  }
  return out;
}

function adminDictSuggestHTML() {
  const list = adminDictSuggest();
  if (!list.length) return '';
  return `<div class="fb-sugg-h">Vorschläge</div>
    ${list
      .map(
        (x) => `<div class="fb-sugg"><span class="fb-sugg-t" data-fb="dict-edit" data-word="${escapeHtml(x.word)}"><b translate="no">${escapeHtml(x.word)}</b> <span class="muted">statt</span> <span class="muted" translate="no">${escapeHtml(x.others.join(', '))}</span></span>
          <button data-fb="dict-ignore" data-word="${escapeHtml(x.word)}" aria-label="Verwerfen">${ICON.close}</button>
          <button class="fb-sugg-add" data-fb="dict-take" data-word="${escapeHtml(x.word)}" aria-label="Hinzufügen">${ICON.plus}</button></div>`
      )
      .join('')}`;
}

/** Vorschlag vor dem Übernehmen anpassen (Antippen auf den Text) */
function adminDictEdit(word) {
  if (adminBusy) return;
  const modal = openModal(
    `<div class="alert-body"><b>Ins Wörterbuch</b>
      <input class="pw-input" data-fb-edit maxlength="80" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done">
    </div>
    <div class="alert-buttons"><button data-c="no">Abbrechen</button><button data-c="yes" class="strong">Hinzufügen</button></div>`,
    'alert'
  );
  const input = modal.querySelector('[data-fb-edit]');
  input.value = word;
  const send = () => {
    const w = input.value.replace(/\s+/g, ' ').trim();
    if (!w) return;
    closeModal();
    // anders geschrieben als vorgeschlagen: der Vorschlag ist damit erledigt
    if (adminDictKey(w) !== adminDictKey(word)) adminDictIgnore(word);
    adminDictChange('PUT', w);
  };
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    if (b.dataset.c === 'no') closeModal();
    else send();
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && send());
  setTimeout(() => input.focus(), 50);
}

/** Vorschlag verwerfen: wird auf diesem Gerät gemerkt (Schlüssel), kommt nicht wieder */
function adminDictIgnore(word) {
  if (!admin) return;
  admin.dictIgnore = [...new Set([...(admin.dictIgnore || []), adminDictKey(word)])].slice(-300);
  saveAdmin();
  renderFehler();
}

async function adminDictChange(method, word) {
  word = String(word || '').replace(/\s+/g, ' ').trim();
  if (!word || adminBusy) return;
  adminBusy = true;
  let failed = false;
  try {
    adminDict = (await adminRequest(method, '/dict', { word })).dict || adminDict;
    haptic();
  } catch {
    failed = true;
    toast('Keine Verbindung');
  }
  adminBusy = false;
  if (currentView !== 'fehler' || !admin) return;
  renderFehler();
  // ohne Verbindung das getippte Wort stehen lassen
  const input = failed && method === 'PUT' && document.querySelector('[data-fb-word]');
  if (input) input.value = word;
}

async function adminLoad() {
  try {
    // Antwortzeit an einer kleinen Anfrage wie die der Kollegen messen, nicht am großen Abruf hier
    const t0 = performance.now();
    const ping = adminRequest('GET', '/ping').then(
      () => (adminPing = Math.round(performance.now() - t0)),
      () => {}
    );
    const data = await adminRequest('GET', '/errors');
    await ping;
    adminErrors = data.errors || [];
    adminStorage = data.storage || null;
    adminTeam = data.team || null;
    adminDict = data.dict || [];
    adminUsage = data.usage || null;
    adminAccounts = data.accounts || null;
    adminOpen = data.open || null;
    adminCode = data.code || null;
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
  // nicht möglich: Schalter wieder ausschalten
  if (adminBusy || !adminPushPossible()) {
    if (!adminBusy) toast('Nur in der App vom Home-Bildschirm');
    return adminSetBusy(adminBusy);
  }
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
  if (adminBusy) return adminSetBusy(true);
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
async function adminPersonDelete(member) {
  if (!member || adminBusy) return;
  adminBusy = true;
  try {
    await adminRequest('DELETE', '/member', { member });
    if (adminTeam) adminTeam.people = (adminTeam.people || []).filter((p) => p.member !== member);
    haptic();
  } catch {
    toast('Keine Verbindung');
  }
  adminBusy = false;
  if (currentView === 'fehler' && admin) renderFehler();
}
function adminSetBusy(on) {
  adminBusy = on;
  if (currentView === 'fehler' && admin) renderFehler();
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-fb]');
  if (!el || layer.contains(el)) return;
  switch (el.dataset.fb) {
    case 'dict-del':
      adminDictChange('DELETE', el.dataset.word);
      break;
    case 'dict-take':
      adminDictChange('PUT', el.dataset.word);
      break;
    case 'dict-edit':
      adminDictEdit(el.dataset.word);
      break;
    case 'dict-ignore':
      adminDictIgnore(el.dataset.word);
      break;
    case 'code':
      adminCodeChange();
      break;
    case 'open-assign':
      adminOpenAssign(el.dataset.key);
      break;
  }
});
// Person bzw. Konto lang drücken → Menü (Antippen allein tut nichts, damit nichts aus Versehen gelöscht wird)
const ADMIN_HOLD = 450;
let adminPress = null; // { el, x, y, timer }
function adminPressEnd() {
  if (!adminPress) return;
  clearTimeout(adminPress.timer);
  adminPress.el.classList.remove('pressing');
  adminPress = null;
}
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest?.('[data-fb-hold]');
  if (!el || e.button > 0 || adminBusy) return;
  adminPressEnd();
  el.classList.add('pressing');
  adminPress = {
    el,
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(() => {
      adminPressEnd();
      haptic();
      adminPersonMenu(el);
    }, ADMIN_HOLD),
  };
});
document.addEventListener('pointermove', (e) => {
  if (adminPress && Math.hypot(e.clientX - adminPress.x, e.clientY - adminPress.y) > 10) adminPressEnd();
});
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, adminPressEnd));
window.addEventListener('scroll', adminPressEnd, { passive: true });
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest?.('[data-fb-hold]')) e.preventDefault();
});

// Schalter „Mitteilungen“: Einschalten muss direkt aus dem Antippen kommen (sonst fragt iOS nicht)
document.addEventListener('change', (e) => {
  if (!e.target.matches('[data-fb-push]')) return;
  if (e.target.checked) adminPushOn();
  else adminPushOff();
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
