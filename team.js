// Std-Protokoll – Team: Kollegen sehen gegenseitig ihre Stundenzettel des laufenden Monats und des Vormonats
// (Einträge lassen sich in den eigenen Zettel übernehmen). Speicher: Cloudflare-Worker mit D1-Datenbank in der EU
// (cloudflare/team-worker.js). Wer mit Team-Code und Konto beigetreten ist, lädt seine Zettel automatisch hoch und
// sieht die der anderen; Älteres als der Vormonat löscht der Worker.
//
// Eigener Speicher (nicht in der Sicherung): { code, member, token, sent, seen, cache: { month, members, prevMonth, prevMembers, posts, at } }
// seen: Zeitpunkt der zuletzt gesehenen Teammeeting-Nachricht (Zahl am Teammeeting-Knopf)

const TEAM_URL = 'https://std-protokoll-team.std-protokoll.workers.dev';
const TEAM_KEY = 'stdprotokoll.team.v1';

// Wird vor app.js geladen: hier nur Browser-Funktionen, alles andere erst beim Aufruf
let team = null;
try {
  team = JSON.parse(localStorage.getItem(TEAM_KEY) || 'null');
} catch {}
const saveTeam = () => {
  try {
    if (team) localStorage.setItem(TEAM_KEY, JSON.stringify(team));
    else localStorage.removeItem(TEAM_KEY);
  } catch {}
};
/** Im Team steht nur der Vorname (erstes Wort des Namens) */
const teamFirstName = (name) => String(name ?? '').trim().split(/\s+/)[0];
const teamMonth = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

async function teamRequest(method, path, body, code = team && team.code) {
  // /sync: alles im Inhalt (Team-Code, Konto, Token), keine eigenen Header – der Server verlangt es so
  const sync = path === '/sync';
  // mit diesem Prüfwert gesendet (Antworten auf ältere Anfragen nach einem Passwortwechsel zählen nicht)
  const sentAuth = (body && body.auth) || (account && account.auth);
  const res = await fetch(TEAM_URL + path, {
    method,
    // mit Konto immer dabei (Lesen verlangt es); Name kodiert, Header erlauben keine kyrillischen Buchstaben.
    // X-Token: Konten mit Abgleich brauchen zusätzlich das Token eines ihrer Geräte
    headers: sync
      ? { 'Content-Type': 'text/plain;charset=utf-8' }
      : {
          'X-Team-Code': code,
          ...(account && account.auth ? { 'X-User': encodeURIComponent(account.user), 'X-Auth': account.auth } : {}),
          ...(team && team.token ? { 'X-Token': team.token } : {}),
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
    body: body ? JSON.stringify(sync ? { code, ...body } : body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    window.serverFehler?.(method, path + (body && (body.action || body.task) ? ` ${body.action || body.task}` : ''), res.status, data.error);
    teamAccessError(res.status, data.error, sentAuth);
    throw Object.assign(new Error(data.error || 'fehler'), { status: res.status, data });
  }
  return data;
}

/** Antworten, die für das ganze Gerät gelten: abgemeldet → Daten löschen, Team auf einem anderen Gerät verlassen, kein
 *  Gerät des Kontos (mehr), Passwort anderswo geändert, Passwort abgelehnt bzw. Konto gelöscht. sentAuth: Prüfwert der
 *  Anfrage – ist er inzwischen ein anderer (eigener Passwortwechsel übernommen), gilt die Antwort nicht mehr */
function teamAccessError(status, error, sentAuth) {
  if (status === 403 && error === 'removed') return deviceWipe();
  if (status === 403 && error === 'left' && team) {
    teamLeftRemember();
    return leaveTeamLocal('Team auf einem anderen Gerät verlassen');
  }
  if (status === 403 && error === 'device' && team) return leaveTeamLocal('Auf einem anderen Gerät angemeldet');
  if (!account || !account.ok || (sentAuth && sentAuth !== account.auth)) return;
  if (status === 403 && error === 'pwchanged') accountPwChanged();
  // nicht von selbst wiederholen: jede Anfrage zählte als Fehlversuch und sperrte das Konto (auch für die anderen Geräte)
  else if ((status === 403 && error === 'auth') || (status === 404 && error === 'unknown')) {
    account.ok = false;
    account.error = accountError({ message: error });
    saveAccount();
    accountRerender();
  }
}

// ───────── KI (Workers AI über den Team-Server, nur im Team) ─────────
// Speicher (nicht in der Sicherung): spell: { Eintrag: Ergebnis (KI, danach Wörterbuch des Servers) }, spellV: Stand des
// Wörterbuchs (ändert er sich, wird neu geprüft), sites: { key, groups: [[Schreibweisen]] },
// tr: { de: { Text: Übersetzung }, ru: { … } } – Einträge russisch schreibender Kollegen fürs PDF bzw. die Anzeige

const AI_KEY = 'stdprotokoll.ai.v1';
let aiStore = { spell: {}, sites: null, tr: { de: {}, ru: {} } };
try {
  Object.assign(aiStore, JSON.parse(localStorage.getItem(AI_KEY) || '{}'));
} catch {}
/** Ergebnisse nur aus dem Wörterbuch (die KI hat nicht geantwortet): zeigen, aber beim nächsten Mal wieder fragen */
let aiSpellTemp = {};
/** Neuer Stand von Anweisung oder Wörterbuch auf dem Server: alles Gemerkte verwerfen */
function aiSpellReset(v) {
  aiStore = { ...aiStore, spell: {}, spellV: v };
  aiSpellTemp = {};
}
const saveAi = () => {
  try {
    localStorage.setItem(AI_KEY, JSON.stringify(aiStore));
  } catch {}
};
const aiNorm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
const aiReady = () => !!(team && team.member && team.token && navigator.onLine !== false);
const teamAi = (task, data) => teamRequest('POST', '/ai', { member: team.member, token: team.token, task, ...data });

/** Rechtschreibung der Einträge prüfen lassen, die noch nicht geprüft sind; Ergebnis: true = neue Antworten da */
const aiSpellBusy = new Set();
async function aiSpellCheck(items) {
  if (!aiReady()) return false;
  const todo = [...new Set(items.map(aiNorm))].filter((t) => t && !(t in aiStore.spell) && !aiSpellBusy.has(t));
  if (!todo.length) return false;
  todo.forEach((t) => aiSpellBusy.add(t));
  try {
    const { out, v } = await teamAi('spell', { items: todo });
    // Wörterbuch oder Anweisung geändert: alles Gemerkte neu prüfen lassen
    if (v && v !== aiStore.spellV) aiSpellReset(v);
    for (const [t, fixed, checked] of out || []) {
      if (!checked) {
        aiSpellTemp[t] = fixed;
        continue;
      }
      aiSpellRemember(t, fixed);
      delete aiSpellTemp[t];
      // die Korrektur selbst ist richtig geschrieben: nach dem Übernehmen nicht noch einmal fragen
      if (fixed && fixed !== t) aiSpellRemember(aiNorm(fixed), aiNorm(fixed));
    }
    // Speicher begrenzen: die ältesten Einträge zuerst raus (neu gemerkte stehen hinten)
    const keys = Object.keys(aiStore.spell);
    for (const k of keys.slice(0, Math.max(0, keys.length - 2000))) delete aiStore.spell[k];
    saveAi();
    return true;
  } catch {
    return false;
  } finally {
    todo.forEach((t) => aiSpellBusy.delete(t));
  }
}
/** Merken und dabei ans Ende stellen, damit beim Begrenzen wirklich die ältesten wegfallen */
function aiSpellRemember(t, fixed) {
  delete aiStore.spell[t];
  aiStore.spell[t] = fixed;
}
/** Korrektur der KI für einen Eintrag, nur wenn sie etwas ändert */
function aiSpellFix(t) {
  const k = aiNorm(t);
  const fixed = aiStore.spell[k] ?? aiSpellTemp[k];
  return fixed && fixed !== k ? fixed : null;
}

/** Welche Baustellen-Schreibweisen dieselbe meinen, einmal je Namensliste fragen (der Server merkt sich die Antwort auch) */
let aiSitesAsked = '';
function aiSitesRequest(names) {
  const list = [...new Set(names.map(aiNorm))].filter(Boolean).sort();
  const key = list.join('\n');
  if (list.length < 2 || (aiStore.sitesList || []).some((x) => x.key === key) || aiStore.sites?.key === key || aiSitesAsked === key || !aiReady()) return;
  aiSitesAsked = key;
  teamAi('sites', { names: list })
    .then(({ groups }) => {
      const changed = JSON.stringify(aiStore.sites?.groups || []) !== JSON.stringify(groups || []);
      aiStore.sites = { key, groups: groups || [] };
      // die letzten vier Antworten (z. B. laufender Monat und Vormonat)
      aiStore.sitesList = [aiStore.sites, ...(aiStore.sitesList || []).filter((x) => x.key !== key)].slice(0, 4);
      saveAi();
      if (!changed) return;
      teamSitesKey = null;
      teamRefreshSoon();
    })
    .catch(() => {
      // beim nächsten Mal wieder fragen (z. B. schlechter Empfang)
      if (aiSitesAsked === key) aiSitesAsked = '';
    });
}

/** Übersetzung nötig? Ins Deutsche nur Kyrillisches, ins Russische nur lateinisch Geschriebenes (Zahlen allein nie) */
const aiTrNorm = (t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
const aiTrNeeded = (t, to) => (to === 'de' ? hasCyrillic(t) : /[A-Za-zÄÖÜäöüß]/.test(t) && !hasCyrillic(t));
/** Ein Text in Stücke, die einzeln übersetzt werden: je Zeile, lange Zeilen satzweise bis 900 Zeichen
 *  (der Server nimmt höchstens 1000; so bleiben Zeilenumbrüche und lange Monatsberichte ganz) */
function aiTrPieces(t) {
  const out = [];
  // Ein Satz über 900 Zeichen (Aufzählung mit Kommas): an Komma/Semikolon, sonst an Leerzeichen teilen, zur Not hart
  const split = (s) => {
    if (s.length <= 900) return [s];
    const parts = s.match(/[^,;]+[,;]*\s*/g) || [s];
    if (parts.length === 1) return (s.match(/\S+\s*/g) || [s]).flatMap((w) => (w.length > 900 ? w.match(/[\s\S]{1,900}/g) : [w]));
    return parts.flatMap(split);
  };
  for (const line of String(t ?? '').split('\n')) {
    let cur = '';
    for (const s of (line.match(/[^.!?]+[.!?]*\s*/g) || [line]).flatMap(split)) {
      if (cur && (cur + s).length > 900) out.push(cur), (cur = '');
      cur += s;
    }
    out.push(cur);
  }
  return out;
}
const aiTrBusy = new Set();
/** Was die KI nicht übersetzt hat, erst nach 10 min wieder fragen (sonst bei jedem Laden des Teams erneut) */
const aiTrFailed = new Map();
const AI_TR_RETRY = 10 * 60000;
/** Einträge übersetzen lassen (to: 'de' oder 'ru'), was noch nicht gemerkt ist; Ergebnis: true = neue Übersetzungen da */
async function aiTranslate(items, to) {
  if (!aiReady()) return false;
  aiStore.tr = aiStore.tr || {};
  const store = (aiStore.tr[to] = aiStore.tr[to] || {});
  const now = Date.now();
  const todo = [...new Set(items.flatMap(aiTrPieces).map(aiTrNorm))].filter(
    (t) => t && aiTrNeeded(t, to) && !(t in store) && !aiTrBusy.has(`${to}|${t}`) && !(now - (aiTrFailed.get(`${to}|${t}`) || 0) < AI_TR_RETRY)
  );
  if (!todo.length) return false;
  todo.forEach((t) => aiTrBusy.add(`${to}|${t}`));
  let fresh = false;
  try {
    for (let i = 0; i < todo.length; i += 20) {
      const { out } = await teamAi('tr', { to, items: todo.slice(i, i + 20) });
      // ins Deutsche: noch kyrillisch (Name nicht umgeschrieben) ist keine Übersetzung – später noch einmal fragen
      for (const [t, x] of out || []) if (typeof x === 'string' && x.trim() && !(to === 'de' && hasCyrillic(x))) (store[t] = x), (fresh = true);
    }
  } catch {
  } finally {
    todo.forEach((t) => {
      aiTrBusy.delete(`${to}|${t}`);
      if (!(t in store)) aiTrFailed.set(`${to}|${t}`, Date.now());
    });
  }
  // Speicher begrenzen: die ältesten zuerst raus
  const keys = Object.keys(store);
  for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) delete store[k];
  if (fresh) saveAi();
  return fresh;
}
/** Gemerkte Übersetzung (sonst der Text selbst); zusammengesetzt aus den Stücken, nur wenn alle übersetzt sind */
function aiTr(t, to) {
  if (!t || !aiTrNeeded(String(t), to)) return t;
  const store = (aiStore.tr && aiStore.tr[to]) || {};
  const lines = [];
  let line = [];
  let missing = false;
  const pieces = aiTrPieces(t);
  // Stücke wieder zu Zeilen: aiTrPieces trennt Zeilen immer, Sätze nur bei langen Zeilen
  for (const line0 of String(t).split('\n')) {
    const n = aiTrPieces(line0).length;
    line = pieces.splice(0, n).map((p) => {
      const k = aiTrNorm(p);
      if (!k || !aiTrNeeded(k, to)) return p.trim();
      if (!store[k]) missing = true;
      return store[k] || p.trim();
    });
    lines.push(line.join(' '));
  }
  return missing ? t : lines.join('\n');
}
/** Kopie mit deutschen Texten fürs PDF (Kyrillisch im PDF wäre „?“; übersetzt, soweit schon gemerkt) */
function deDeep(v) {
  if (typeof v === 'string') return hasCyrillic(v) ? aiTr(v, 'de') : v;
  if (Array.isArray(v)) return v.map(deDeep);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = deDeep(x);
    return o;
  }
  return v;
}
/** Alle kyrillischen Texte einer Seite (Zettel, Woche, Abrechnung …) vorab übersetzen lassen */
function aiTranslateDeep(v, to = 'de') {
  const texts = [];
  const walk = (x) => {
    if (typeof x === 'string') {
      if (aiTrNeeded(x, to)) texts.push(x);
    } else if (Array.isArray(x)) x.forEach(walk);
    else if (x && typeof x === 'object') Object.values(x).forEach(walk);
  };
  if (to === 'de' && !hasCyrillic(JSON.stringify(v))) return Promise.resolve(false);
  walk(v);
  return texts.length ? aiTranslate(texts, to) : Promise.resolve(false);
}
/** Für den PDF-Bau: nur kopieren/übersetzen, wenn überhaupt Kyrillisch vorkommt; sonst unverändert */
const pdfDe = (v) => (hasCyrillic(JSON.stringify(v)) ? deDeep(v) : v);
/** Text eines Kollegen in der eingestellten Sprache */
const teamTr = (t) => aiTr(t, LANG);
/** Einträge und Nachrichten der Kollegen in die eingestellte Sprache übersetzen lassen; danach neu zeichnen */
function teamTranslateAll() {
  const texts = [];
  for (const m of teamMembersAll()) for (const s of m.sheets || []) for (const d of s.days || []) for (const r of d.rows || []) if (r.work) texts.push(r.work);
  for (const p of teamPosts()) texts.push(p.text);
  aiTranslate(texts, LANG).then((fresh) => fresh && teamRefreshSoon());
}
/** Zuletzt gewischt (Zettelreihen auf der Team-Seite) */
let teamTouchAt = 0;
/** Neu zeichnen, aber nicht mitten im Wischen (sonst bricht es ab und die Reihen springen) */
function teamRefreshSoon() {
  if (Date.now() - teamTouchAt < 1500) setTimeout(teamRefreshSoon, 800);
  else teamRefreshView();
}

// ───────── Eigene Zettel hochladen ─────────

/** App-Version („std-protokoll-v30“) für die Server-Seite: aus der aktuellen sw.js, nicht aus dem Offline-Speicher
 *  (der hat beim ersten Start nach einem Update noch die alte Version, der Code ist aber schon neu) */
let teamAppVersion = '';
// window.stdAppVersion kommt aus fehlerbericht.js (lädt sw.js nur einmal)
if (window.stdAppVersion)
  window.stdAppVersion().then((v) => {
    if (v && v !== teamAppVersion) {
      teamAppVersion = v;
      teamQueueUpload(1000);
    }
  });

/** Zettel des laufenden Monats und des Vormonats (nachträgliche Änderungen), ohne Angaben, die nur dieses iPhone betreffen */
function teamPayload() {
  const now = new Date();
  const pm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  // nur, was die Kollegen sehen: ohne Zeilen-IDs, leere Zeilen und „So lassen“ (spart drei Viertel der Daten)
  const day = (d) => ({
    pause: d.pause ?? null,
    ...(d.status ? { status: d.status } : {}),
    ...(d.credit != null ? { credit: d.credit } : {}),
    ...(d.manual ? { manual: true } : {}),
    rows: (d.rows || []).filter((r) => !rowIsEmpty(r)).map((r) => ({ start: r.start, end: r.end, site: r.site || '', work: r.work || '' })),
  });
  const pick = (d) =>
    savedSheets()
      .filter((s) => s.year === d.getFullYear() && s.month === d.getMonth() + 1)
      .map((s) => ({ weekStart: s.weekStart, year: s.year, month: s.month, days: s.days.map(day) }));
  return {
    member: team.member,
    token: team.token,
    name: teamFirstName(settings.name),
    month: teamMonth(now),
    version: teamAppVersion,
    sheets: pick(now),
    prev: { month: teamMonth(pm), sheets: pick(pm) },
  };
}

let teamUploadTimer = 0;
let teamUploading = false;
/** Während eines Uploads kam eine Änderung: danach noch einmal (sonst ginge sie erst beim nächsten Anlass hoch) */
let teamUploadAgain = false;
/** Nach jeder Änderung: kurz warten (mehrere Änderungen auf einmal), dann hochladen, falls sich etwas geändert hat */
function teamQueueUpload(delay = 3000) {
  if (!team || !TEAM_URL) return;
  clearTimeout(teamUploadTimer);
  teamUploadTimer = setTimeout(teamUpload, delay);
}
/** Ergebnis: true = der Server hat den aktuellen Stand */
async function teamUpload() {
  // app.js (settings, Zettel) ist beim ersten Start nach einem Update teils noch nicht geladen, wenn die
  // Zeitgeber aus team.js schon ablaufen (langsames Netz): dann etwas später noch einmal
  if (typeof settings === 'undefined') return teamQueueUpload(1000), false;
  // Passwort auf einem anderen Gerät geändert: erst neu anmelden
  if (!team || !TEAM_URL || !navigator.onLine || accountRestorePending() || (account && account.pwchanged)) return false;
  // Abgleich mehrerer Geräte: nur mit aktuellem Stand (sonst überschriebe ein Gerät mit altem Stand den gemeinsamen Eintrag);
  // ohne Namen hat ein neues Gerät noch nichts vom bisherigen (die Kollegen sähen „?“ und leere Zettel)
  if (!syncCurrent() || (account && account.sync && !settings.name.trim())) return false;
  if (teamUploading) {
    teamUploadAgain = true;
    return false;
  }
  const payload = teamPayload();
  const text = JSON.stringify(payload);
  if (team.sent === text) return true;
  teamUploading = true;
  let ok = false;
  try {
    await teamRequest('PUT', '/me', payload);
    if (team) {
      team.sent = text;
      saveTeam();
    }
    ok = true;
  } catch (e) {
    // Falscher Code (z. B. geändert): neu beitreten; sonst beim nächsten Anlass erneut versuchen
    if (e.status === 401 && team) leaveTeamLocal('Team-Code ungültig');
    // Mit demselben Konto auf einem anderen iPhone angemeldet: dort gilt jetzt der Eintrag
    else if (e.status === 403 && e.message === 'token' && team) leaveTeamLocal('Auf einem anderen iPhone angemeldet');
  } finally {
    teamUploading = false;
    if (teamUploadAgain) {
      teamUploadAgain = false;
      teamQueueUpload(500);
    }
  }
  return ok;
}

// ───────── Beitreten / Verlassen ─────────

/** Beitreten nur mit Konto (konto.js): der Server prüft es und gibt den Team-Eintrag des Kontos zurück
 *  (nach einer Neuinstallation derselbe wie vorher, keine Doppelten) */
async function joinTeam(code) {
  code = code.trim();
  if (!code || !account) return;
  // Header erlauben nur einfache Zeichen; ein kyrillisches „е“ o. Ä. ergäbe sonst „Keine Verbindung“
  if (/[^\x21-\x7e]/.test(code)) return toast('Team-Code ungültig');
  // Neues Konto braucht einen Namen; beim Anmelden kommt er mit der Sicherung zurück
  if (account.mode !== 'login' && !settings.name.trim()) {
    toast('Bitte zuerst deinen Namen eintragen');
    return;
  }
  const btn = app.querySelector('[data-team="join"]');
  if (btn) btn.disabled = true;
  const token = uid() + uid();
  let out;
  try {
    out = await accountJoin(code, uid(), token);
  } catch (e) {
    // Gerät abgemeldet: Daten werden gelöscht, die App startet neu
    if (e.message === 'removed') return;
    toast(accountError(e));
    // Name vergeben, Passwort falsch …: steht dann auch auf der Konto-Seite
    if (e.status && e.status !== 401) {
      account.error = accountError(e);
      saveAccount();
    }
    if (btn) btn.disabled = false;
    return;
  }
  let seen = 0;
  try {
    seen = Number(localStorage.getItem(TEAM_SEEN_KEY)) || 0;
  } catch {}
  team = { code, member: out.member, token, sent: '', seen };
  saveTeam();
  syncSoon(0);
  // Angemeldet, aber ohne Namen und ohne Sicherung (die ihn zurückbrächte): die Kollegen sähen „?“
  if (!settings.name.trim() && !(out.backups || []).length) toast('Bitte zuerst deinen Namen eintragen');
  haptic();
  renderTeamBody();
  teamLoad();
  adminCheck(code);
  // Sicherung auf dem Server: erst fragen, dann den eigenen Stand hochladen
  if (accountRestorePending()) accountOfferRestore(out.backups);
  else {
    teamUpload();
    accountBackup(true);
  }
}

const TEAM_SEEN_KEY = 'stdprotokoll.teamseen.v1';
function leaveTeamLocal(message) {
  adminForget();
  // zuletzt gesehene Nachricht behalten (nach erneutem Beitreten sonst bis zu 300 „neue“)
  try {
    if (team && team.seen) localStorage.setItem(TEAM_SEEN_KEY, String(team.seen));
  } catch {}
  team = null;
  saveTeam();
  teamData = null;
  teamPrevOpen = false;
  teamPinOpen = false;
  // Übersetzungen und Baustellen-Gruppen enthalten Texte der Kollegen: nicht auf dem iPhone lassen
  aiStore.tr = { de: {}, ru: {} };
  aiStore.sites = null;
  aiStore.sitesList = [];
  saveAi();
  if (currentView === 'team') renderTeam();
  else if (currentView === 'teamSheet') location.replace('#/team');
  if (message) toast(message);
}

function leaveTeam() {
  // Konto mit Abgleich: der Server nimmt alle Geräte des Kontos mit heraus (sonst legten sie den Eintrag gleich wieder an)
  const all = !!(account && account.sync);
  confirmDialog(all ? 'Auf allen Geräten verlassen?' : 'Team verlassen?', 'Deine Zettel werden für das Team gelöscht.', 'Verlassen', async () => {
    // Inzwischen schon draußen (z. B. Code ungültig): nichts mehr zu tun
    if (!team) return;
    try {
      await teamRequest('DELETE', '/me', { member: team.member, token: team.token });
    } catch (e) {
      // Code ungültig oder der Eintrag gehört inzwischen einem anderen iPhone (dasselbe Konto) bzw. schon auf einem
      // anderen Gerät verlassen: hier nur noch austreten
      if (e.status !== 401 && !(e.status === 403 && ['token', 'left', 'device'].includes(e.message))) {
        toast('Keine Verbindung');
        return;
      }
    }
    if (team) {
      if (all) teamLeftRemember();
      leaveTeamLocal();
    }
  }, true);
}
/** Team mit Abgleich verlassen: Code und Token merken – damit erfährt das Gerät später noch, ob es abgemeldet wurde
 *  (accountLeftCheck) */
function teamLeftRemember() {
  if (!account || !account.sync || !team) return;
  account.left = { code: team.code, token: team.token };
  saveAccount();
}

// ───────── Team-Seite: je Person eine Karte mit ihren Zetteln des Monats (gleiche KW untereinander) ─────────

/** Zuletzt geladene Einträge der Kollegen (null = noch nichts geladen) */
let teamData = null;
let teamLoading = false;
/** Während eines Ladens erneut angefragt (z. B. nach dem Senden einer Nachricht): danach noch einmal laden */
let teamLoadAgain = false;
/** Teammeeting offen (statt der Zettel), Scrollstand, waagerechter Stand der Zettelreihen (null = laufende Woche zeigen) */
let teamPinOpen = false;
/** Team-Seite zeigt den Vormonat statt des laufenden Monats */
let teamPrevOpen = false;
let teamScroll = 0;
let teamX = null;
/** Woche, in der teamX gemerkt wurde (in einer neuen Woche wieder die laufende zeigen) */
let teamXWeek = '';
/** Angefangene Nachricht fürs Teammeeting */
let teamDraft = '';
let teamPosting = false;

/** Einträge der anderen nur in bekannter Form übernehmen (jeder mit dem Code kann dort schreiben) */
function teamCleanPosts(posts) {
  return (Array.isArray(posts) ? posts : [])
    .filter((p) => p && typeof p.text === 'string' && p.text.trim())
    .map((p) => ({
      id: Number(p.id) || 0,
      member: String(p.member ?? '').slice(0, 64),
      name: teamFirstName(String(p.name ?? '').slice(0, 80)),
      text: p.text.slice(0, 500),
      created: typeof p.created === 'number' && isFinite(p.created) ? p.created : 0,
    }));
}

function teamClean(members) {
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const str = (v, n) => String(v ?? '').slice(0, n);
  return (Array.isArray(members) ? members : []).map((m) => ({
    member: str(m.member, 64),
    name: teamFirstName(str(m.name, 80)),
    updated: num(m.updated) || 0,
    // höchstens 12 Zettel je Person und Monat, 30 Zeilen je Tag (wie der Server): sonst füllte ein Eintrag den Speicher aller
    sheets: (Array.isArray(m.sheets) ? m.sheets : [])
      .filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s.weekStart) && Array.isArray(s.days) && s.days.length === 7)
      .slice(0, 12)
      .map((s) => ({
        weekStart: s.weekStart,
        year: num(s.year),
        month: num(s.month),
        days: s.days.map((d) => ({
          status: Object.hasOwn(DAY_STATUS_SHORT, d && d.status) ? d.status : undefined,
          credit: num(d && d.credit),
          manual: d && d.manual === true ? true : undefined,
          pause: num(d && d.pause),
          rows: (Array.isArray(d && d.rows) ? d.rows : []).slice(0, 30).map((r) => ({
            start: num(r && r.start),
            end: num(r && r.end),
            site: str(r && r.site, 200),
            work: str(r && r.work, 400),
          })),
        })),
      })),
  }));
}

async function teamLoad() {
  // Lesen nur mit Konto (Server prüft); ohne bestätigtes Konto nicht fragen, sonst zählen Fehlversuche bis zur Sperre
  if (!team || !TEAM_URL || !accountOk()) return;
  if (teamLoading) {
    teamLoadAgain = true;
    return;
  }
  teamLoading = true;
  const before = teamDrawnKey();
  try {
    const data = await teamRequest('GET', '/team');
    // Während des Ladens das Team verlassen: Ergebnis verwerfen
    if (!team) return;
    const old = team.cache;
    team.cache = {
      month: data.month,
      members: teamClean(data.members),
      prevMonth: data.prev?.month || '',
      prevMembers: teamClean(data.prev?.members),
      posts: teamCleanPosts(data.posts),
      at: Date.now(),
    };
    // Wörterbuch auf dem Server geändert: gemerkte Rechtschreib-Prüfungen verwerfen (werden beim nächsten Verlassen neu geprüft)
    if (data.spellV && data.spellV !== aiStore.spellV) {
      aiSpellReset(data.spellV);
      saveAi();
    }
    // Übersetzungs-Anweisung auf dem Server geändert: gemerkte Übersetzungen verwerfen
    if (data.trV && data.trV !== aiStore.trV) {
      aiStore.tr = { de: {}, ru: {} };
      aiStore.trV = data.trV;
      saveAi();
    }
    // Speichern (bis zu 200 KB) nur, wenn sich etwas geändert hat oder der Stand älter als 5 min ist (Teammeeting lädt alle 10 s)
    const same = old && JSON.stringify([old.month, old.members, old.prevMembers, old.posts]) === JSON.stringify([team.cache.month, team.cache.members, team.cache.prevMembers, team.cache.posts]);
    if (!same || !old.saved || Date.now() - old.saved > 300000) {
      team.cache.saved = Date.now();
      saveTeam();
    } else team.cache.saved = old.saved;
    teamData = team.cache;
    // Einträge der Kollegen in der eingestellten Sprache (russisch bzw. deutsch geschriebene)
    teamTranslateAll();
  } catch (e) {
    if (!team) return;
    if (e.status === 401) {
      leaveTeamLocal('Team-Code ungültig');
      return;
    }
    // Konto nicht im Team bekannt; Passwort abgelehnt, anderswo geändert oder Konto gelöscht (teamAccessError): neu anmelden
    // (Team-Seite zeigt „Erst anmelden“, auch im Teammeeting und in der Zettel-Ansicht eines Kollegen)
    if (account && account.ok && e.message === 'konto') {
      account.ok = false;
      account.error = accountError(e);
      saveAccount();
      accountRerender();
    }
    if (account && !account.ok && ['auth', 'unknown', 'konto', 'pwchanged'].includes(e.message)) {
      if (currentView === 'team') renderTeamBody();
      else if (currentView === 'teamSheet') location.replace('#/team');
    }
    teamData = { ...(team.cache || { members: [] }), offline: true };
  } finally {
    teamLoading = false;
  }
  // Nichts Neues: nicht neu zeichnen (sonst bricht z. B. ein laufendes Wischen ab)
  if (teamDrawnKey() !== before) teamRefreshView();
  if (teamLoadAgain) {
    teamLoadAgain = false;
    await teamLoad();
  }
}

/** Was die Team-Seiten zeigen (ohne Ladezeitpunkt), dazu die laufende Woche */
function teamDrawnKey() {
  const src = teamData || (team && team.cache);
  return JSON.stringify([src ? [src.members, src.prevMembers, src.posts, !!src.offline] : null, isoDate(mondayOf(new Date()))]);
}

const teamAgo = (ms) => {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 60) return min < 1 ? 'gerade eben' : `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return `vor ${d} Tag${d > 1 ? 'en' : ''}`;
};

const TEAM_COLORS = ['#2f9e74', '#8e5bd6', '#d2477a', '#2b84d6', '#b38a1e', '#e5793b'];

/** Monat der Team-Ansicht („2026-10“): laufender oder – prev – Vormonat */
const teamShownMonth = (prev = false) => {
  const n = new Date();
  return teamMonth(prev ? new Date(n.getFullYear(), n.getMonth() - 1, 1) : n);
};
/** Kollegen ohne den eigenen Eintrag (Reihenfolge wie vom Server: nach Namen); vor dem ersten Laden der Zwischenspeicher.
 *  Nach Monat ausgewählt: offline nach dem Monatswechsel stünde sonst der alte Monat in den Spalten des neuen */
const teamMembers = (prev = false) => {
  const src = teamData || (team && team.cache) || {};
  const want = teamShownMonth(prev);
  const list = !src.month ? src[prev ? 'prevMembers' : 'members'] : src.month === want ? src.members : src.prevMonth === want ? src.prevMembers : [];
  return (list || []).filter((m) => team && m.member !== team.member);
};
/** Kollegen mit den Zetteln beider Monate (Vormonat zuerst bzw. wie gewählt): für Zettel-Ansicht, Team im Zettel, Übersetzung */
function teamMembersAll(prevFirst = false) {
  const lists = prevFirst ? [teamMembers(true), teamMembers()] : [teamMembers(), teamMembers(true)];
  const out = new Map();
  for (const m of lists.flat()) {
    const x = out.get(m.member);
    if (x) x.sheets = [...x.sheets, ...(m.sheets || [])];
    else out.set(m.member, { ...m, sheets: [...(m.sheets || [])] });
  }
  return [...out.values()];
}
const teamDayRows = (d) => (d.rows || []).filter((r) => !rowIsEmpty(r));
/** Tag mit Tagesart (Urlaub, krank …) statt Arbeit; Arbeit am Feiertag zählt als Arbeit */
const teamDayOff = (d) => d.status && !holidayWork(d);

/** Kreis mit dem Anfangsbuchstaben; Farbe nach der Stelle in der Liste, damit sich keine zwei gleichen */
function teamAvatar(m, size = 34) {
  if (m.me) return `<span class="tm-av tm-av-me" style="--s:${size}px">D</span>`;
  const k = Math.max(0, teamMembersAll().findIndex((x) => x.member === m.member));
  return `<span class="tm-av" style="--av:${TEAM_COLORS[k % TEAM_COLORS.length]};--s:${size}px">${escapeHtml(([...(m.name || '?')][0] || '?').toUpperCase())}</span>`;
}

// Baustellen: gleiche Baustelle trotz anderer Schreibweise erkennen (für Farbe und Wahl der Tagesbaustelle)

/** Klein, ohne Akzente und Sonderzeichen, „Straße“ = „Str.“; nur der Teil vor dem Komma zählt (danach steht meist der Ort).
 *  Buchstaben jeder Schrift (auch kyrillisch). nums: Hausnummern samt Buchstabe („3a“) und einzelne Kennbuchstaben
 *  („Halle B“) – sie müssen passen; letters: alle übrigen Buchstaben, ends: wo in letters ein Wort endet,
 *  words: die einzelnen Wörter (der Ort kann auch vorne stehen) */
const TEAM_SITE_ID = /\d+\s?\p{L}(?![\p{L}\p{N}])|\d+|(?<![\p{L}\p{N}])\p{L}(?![\p{L}\p{N}])/gu;
function teamSiteParts(name) {
  const s = String(name).toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/['’`´]/g, '').replace(/strasse/g, 'str');
  const core = s.split(',')[0];
  const rest = core.replace(TEAM_SITE_ID, ' ');
  let n = 0;
  return {
    letters: rest.replace(/[^\p{L}]/gu, ''),
    ends: (rest.match(/\p{L}+/gu) || []).map((w) => (n += w.length)),
    words: [...new Set(rest.split(/[^\p{L}]+/u).filter((w) => w.length >= 2))],
    nums: (core.match(TEAM_SITE_ID) || []).map((x) => x.replace(/\s/g, '')).join(' '),
  };
}
/** Abstand zweier Texte: Einfügen, Löschen, Ersetzen je 1, ohne Vertauschen (wie dictFuzzy im Worker; für die Server-Seite) */
function teamEditDistance(a, b) {
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
/** Gleiche Wörter? gleich oder ein Tippfehler, auch zwei vertauschte Buchstaben (editDistance aus app.js);
 *  nicht „Anfang von“: sonst wäre „Markt“ = „Marktplatz“ */
const teamSameWord = (x, y) => x === y || (Math.min(x.length, y.length) >= 5 && editDistance(x, y) <= 1);
/** Gleiche Baustelle? Hausnummern müssen passen; sonst gleich, ganze Wörter am Anfang der anderen (Ort fehlt am Ende;
 *  „Markt“ ≠ „Marktplatz“), ein Tippfehler (ab 12 Buchstaben zwei; „Kirchweg“ ≠ „Kirchberg“)
 *  oder alle Wörter der kürzeren stecken in der längeren (Ort fehlt vorne, z. B. „Roma“ = „Musterstadt Roma“) */
function teamSameSite(a, b) {
  if (a.nums && b.nums && a.nums !== b.nums) return false;
  if (!a.letters || !b.letters) return a.letters === b.letters && a.nums === b.nums;
  if (a.letters === b.letters) return true;
  const [x, y] = a.letters.length <= b.letters.length ? [a, b] : [b, a];
  const n = x.letters.length;
  if (n >= 4 && y.letters.startsWith(x.letters) && y.ends.includes(n)) return true;
  if (editDistance(x.letters, y.letters) <= (n >= 12 ? 2 : n >= 5 ? 1 : 0)) return true;
  const [few, many] = a.words.length <= b.words.length ? [a.words, b.words] : [b.words, a.words];
  return few.join('').length >= 4 && few.every((w) => many.some((v) => teamSameWord(w, v)));
}
/** Schreibweise → Nummer der Baustelle (nach erstem Auftreten); neu gebildet, sobald sich die Schreibweisen ändern */
let teamSites = new Map();
let teamSitesKey = null;
function teamGroupSites(people) {
  const names = [];
  for (const p of people)
    for (const s of p.sheets || [])
      for (const d of s.days) for (const r of d.rows || []) if (r.site && r.site.trim() && !names.includes(r.site.trim())) names.push(r.site.trim());
  const key = names.join('\n');
  if (key === teamSitesKey) return;
  teamSitesKey = key;
  aiSitesRequest(names);
  // Zusammenfassen nur, wenn jede Schreibweise der einen Gruppe zu jeder der anderen passt
  // (sonst würden z. B. „Musterstadt“, „Musterstadt Roma“ und „Musterstadt Rathaus“ über den Ort zu einer Baustelle)
  const parts = names.map(teamSiteParts);
  const groups = names.map((_, i) => [i]);
  const of = names.map((_, i) => i);
  for (let i = 0; i < names.length; i++)
    for (let j = 0; j < i; j++) {
      const a = of[i], b = of[j];
      if (a === b || !groups[a].every((x) => groups[b].every((y) => teamSameSite(parts[x], parts[y])))) continue;
      for (const x of groups[a]) of[x] = b;
      groups[b].push(...groups[a]);
      groups[a] = [];
    }
  // Dazu, was die KI als dieselbe Baustelle erkannt hat (andere Schreibweise, Abkürzung, Ort/Kunde dabei);
  // auch eine ältere Antwort gilt für die Namen, die sie kennt. Verschiedene Hausnummern bleiben getrennt –
  // zwischen allen Schreibweisen der beiden Gruppen, nicht nur den beiden aus der Antwort
  const numsFit = (x, y) => !parts[x].nums || !parts[y].nums || parts[x].nums === parts[y].nums;
  const index = new Map(names.map((n, i) => [aiNorm(n), i]));
  for (const g of (aiStore.sitesList?.length ? aiStore.sitesList : [aiStore.sites]).flatMap((x) => x?.groups || [])) {
    const ii = g.map((n) => index.get(aiNorm(n))).filter((i) => i != null);
    for (const i of ii.slice(1)) {
      const a = of[i], b = of[ii[0]];
      if (a === b || !groups[a].every((x) => groups[b].every((y) => numsFit(x, y)))) continue;
      for (const x of groups[a]) of[x] = b;
      groups[b].push(...groups[a]);
      groups[a] = [];
    }
  }
  const ids = new Map();
  teamSites = new Map(names.map((n, i) => [n, ids.has(of[i]) ? ids.get(of[i]) : (ids.set(of[i], ids.size), ids.size - 1)]));
}
const teamSiteId = (name) => teamSites.get(String(name).trim()) ?? -1;
/** Textmarker-Farben; in einer KW bekommt jede markierte Baustelle eine andere */
const TEAM_MARKERS = ['#ffd84a', '#7fe0a0', '#ff9cc2', '#8ec9ff', '#ffb46b', '#c9a8ff', '#7fe8e0', '#ff7a7a'];

/** Baustelle des Tages: zuerst eine, die an dem Tag auch bei jemand anderem steht (bekommt den Textmarker); sonst meiste Stunden;
 *  bei Gleichstand die, auf der an dem Tag mehr Leute waren; dann alphabetisch. crew(id): wie viele Leute die Baustelle an dem Tag haben */
function teamMainSite(d, crew) {
  const sites = new Map();
  for (const r of teamDayRows(d)) {
    const name = r.site.trim();
    if (!name) continue;
    const id = teamSiteId(name);
    const e = sites.get(id) || { id, name, m: 0 };
    e.m += rowMinutes(r) || 0; // auch über Mitternacht (wie im Zettel)
    sites.set(id, e);
  }
  if (!sites.size) return null;
  return [...sites.values()]
    .map((e) => ({ ...e, n: crew(e.id) }))
    .sort((a, b) => (b.n > 1) - (a.n > 1) || b.m - a.m || b.n - a.n || a.name.localeCompare(b.name, 'de'))[0];
}

/** Wochen des laufenden Monats (ganze und Teilwochen) bis zur laufenden bzw. bis zur letzten mit einem Zettel */
/** Wochen des laufenden Monats bis heute (bzw. bis zum letzten Zettel) oder – prev – alle Wochen des Vormonats */
function teamWeeks(people, prev = false) {
  const now = new Date();
  const base = new Date(now.getFullYear(), now.getMonth() - (prev ? 1 : 0), 1);
  const first = base;
  const last = new Date(base.getFullYear(), base.getMonth() + 1, 0);
  const weeks = [];
  for (let d = mondayOf(first); d <= last; d = addDays(d, 7)) {
    const w = { mon: d, iso: isoDate(d), a: d < first ? first : d, b: addDays(d, 6) > last ? last : addDays(d, 6), now: !prev && sameDay(d, mondayOf(now)) };
    // Blätter zeigen Mo–Fr: eine Woche, in der vom Monat nur Sa/So liegt, bliebe leer (außer der laufenden)
    if (w.now || [0, 1, 2, 3, 4].some((i) => addDays(d, i) >= first && addDays(d, i) <= last)) weeks.push(w);
  }
  if (prev) return weeks;
  let end = weeks.findIndex((w) => w.now);
  weeks.forEach((w, k) => people.some((p) => (p.sheets || []).some((s) => s.weekStart === w.iso)) && (end = Math.max(end, k)));
  return weeks.slice(0, end + 1);
}

/** Ein Zettel als kleines Blatt: KW, Mo–Fr mit Baustelle, Gesamt; darunter 0–2 weitere Blätter wie auf einem Stapel.
 *  sites: Baustelle je Tag (aus teamMainSite); marker(i, id): Textmarker-Farbe, wenn dieselbe Baustelle an diesem Tag auch bei jemand anderem steht */
function teamPaperHTML(p, s, w, sites, marker) {
  const rows = [0, 1, 2, 3, 4]
    .map((i) => {
      const day = `<u>${WEEKDAYS_SHORT[i]}</u>`;
      if (!sheetIsActive(s, i)) return `<i class="off">${day}<span></span></i>`;
      const d = s.days[i];
      if (teamDayOff(d)) return `<i class="st-${d.status}">${day}<span><em>${DAY_STATUS_SHORT[d.status] || ''}</em></span></i>`;
      const site = sites[i];
      const name = site ? `<span translate="no">${escapeHtml(site.name)}</span>` : '';
      const mk = site && marker(i, site.id);
      return `<i>${day}<span>${mk ? `<mark style="--mk:${mk}">${name}</mark>` : name}</span></i>`;
    })
    .join('');
  // Stapel: fest je Person und Woche, damit nichts springt
  const seed = isoWeek(w.mon) * 7 + [...String(p.member)].reduce((t, c) => t + c.charCodeAt(0), 0);
  const lay = [[-1, -1.5, 3], [0.8, 2, 2], [-0.6, 1.5, 3], [1.2, -1.5, 3], [-1.3, 1, 3], [0.6, -2, 2]];
  const under = Array.from({ length: seed % 3 }, (_, k) => {
    const [r, x, y] = lay[(seed + k * 2) % lay.length];
    return `<i class="tm-z-under" style="--r:${r}deg;--x:${x}px;--y:${y}px"></i>`;
  }).join('');
  return `<a class="tm-z${w.now ? ' now' : ''}" href="#/team/${encodeURIComponent(p.member)}/${s.weekStart}"><span class="tm-z-bg">${under}<i class="tm-z-paper"></i><i class="tm-z-flap"></i></span><span class="tm-z-top"><small>Stundenzettel</small><b>KW ${isoWeek(w.mon)}</b><small class="tm-z-range">${w.a.getDate()}.–${w.b.getDate()}.</small></span>
    <span class="tm-z-t">${rows}</span>
    <span class="tm-z-f"><small>Gesamt</small><b>${fmtDec(sheetTotal(s))} h</b></span></a>`;
}

/** Man selbst wie ein Kollege: eigene gespeicherte Zettel des laufenden Monats */
/** Eigene Zettel: laufender Monat, Vormonat (prev true) oder beide (prev null) */
function teamMe(prev = false) {
  const now = new Date();
  const months = [now, new Date(now.getFullYear(), now.getMonth() - 1, 1)].filter((_, k) => prev == null || k === (prev ? 1 : 0));
  return { member: team.member, name: 'Du', me: true, sheets: savedSheets().filter((s) => months.some((d) => s.year === d.getFullYear() && s.month === d.getMonth() + 1)) };
}

function teamSheetsHTML(members, prev = false) {
  // Die eigene Reihe steht immer ganz unten
  const people = [...members, teamMe(prev)];
  teamGroupSites(people);
  const weeks = teamWeeks(people, prev);
  const nowCol = weeks.findIndex((w) => w.now);
  const sheetOf = (p, w) => (p.sheets || []).find((x) => x.weekStart === w.iso);
  const workDay = (s, i) => sheetIsActive(s, i) && !teamDayOff(s.days[i]);
  // Wer an welchem Tag welche Baustelle auf dem Zettel hat (alle Einträge, auch kurze)
  const crew = new Map();
  for (const p of people)
    for (const w of weeks) {
      const s = sheetOf(p, w);
      if (!s) continue;
      for (let i = 0; i < 5; i++) {
        if (!workDay(s, i)) continue;
        for (const r of teamDayRows(s.days[i])) {
          if (!r.site.trim()) continue;
          const key = `${isoDate(sheetDate(s, i))}|${teamSiteId(r.site)}`;
          crew.set(key, (crew.get(key) || new Set()).add(p.member));
        }
      }
    }
  const count = (date, id) => (crew.get(`${date}|${id}`) || new Set()).size;
  const shared = (date, id) => count(date, id) > 1;
  // Baustelle je Person, Woche und Tag; dazu, in welchen KW eine Baustelle markiert wird (für die Farben)
  const shown = new Map();
  const weeksOf = new Map();
  for (const w of weeks)
    for (const p of people) {
      const s = sheetOf(p, w);
      if (!s) continue;
      const sites = [0, 1, 2, 3, 4].map((i) => {
        if (!workDay(s, i)) return null;
        const date = isoDate(sheetDate(s, i));
        const x = teamMainSite(s.days[i], (id) => count(date, id));
        if (x && shared(date, x.id)) weeksOf.set(x.id, (weeksOf.get(x.id) || new Set()).add(w.iso));
        return x;
      });
      shown.set(`${p.member}|${w.iso}`, sites);
    }
  // Farben nur für markierte Baustellen: in einer KW nie dieselbe Farbe für verschiedene Baustellen, sonst möglichst wenig benutzte
  const colorOf = new Map();
  const used = TEAM_MARKERS.map(() => 0);
  for (const [id, wks] of weeksOf) {
    const taken = new Set([...colorOf].filter(([other]) => [...weeksOf.get(other)].some((w) => wks.has(w))).map(([, c]) => c));
    const free = TEAM_MARKERS.map((_, c) => c).filter((c) => !taken.has(c));
    const pick = (free.length ? free : TEAM_MARKERS.map((_, c) => c)).sort((a, b) => used[a] - used[b] || a - b)[0];
    colorOf.set(id, pick);
    used[pick]++;
  }
  const cards = people
    .map((p) => {
      let total = 0;
      const slots = weeks
        .map((w, k) => {
          const s = sheetOf(p, w);
          if (!s) return `<span class="tm-z-slot gap"></span>`;
          total += sheetTotal(s);
          const marker = (i, id) => (shared(isoDate(sheetDate(s, i)), id) ? TEAM_MARKERS[colorOf.get(id)] : '');
          return `<span class="tm-z-slot" style="--tilt:${[-0.3, 0.2, -0.1, 0.35, -0.2, 0.15][(k + p.name.length) % 6]}deg">${teamPaperHTML(p, s, w, shown.get(`${p.member}|${w.iso}`), marker)}</span>`;
        })
        .join('');
      return `<div class="card tm-pcard${p.me ? ' me' : ''}"><div class="tm-pcard-h">${teamAvatar(p, 30)}<b${p.me ? '' : ' translate="no"'}>${escapeHtml(p.name || '?')}</b><span>${total ? fmtH(total) : ''}</span></div>
        <div class="tm-z-scroll"><div class="tm-z-row" data-now="${nowCol}" style="--n:${weeks.length}">${slots}</div></div></div>`;
    })
    .join('');
  return `${members.length ? '' : '<p class="tm-msg muted">Noch keine Zettel von Kollegen</p>'}${cards}`;
}

/** Zettelreihen auf den gemerkten Stand bzw. so, dass die laufende Woche rechts zu sehen ist */
function teamPlaceRows() {
  if (teamXWeek !== isoDate(mondayOf(new Date()))) teamX = null;
  document.querySelectorAll('.tm-z-scroll').forEach((o) => {
    if (teamX != null) {
      o.scrollLeft = teamX;
      return;
    }
    const row = o.firstElementChild;
    const k = Number(row.dataset.now);
    const col = row.children[0] ? row.children[0].getBoundingClientRect().width + 10 : 0;
    o.scrollLeft = Math.max(0, (k < 0 ? row.children.length - 1 : k - 2) * col);
  });
}

// ───────── Teammeeting ─────────

const teamPosts = () => (teamData || (team && team.cache) || {}).posts || [];
/** Neue Nachrichten anderer seit dem letzten Blick ins Teammeeting (Zahl am Knopf) */
const teamUnread = () => teamPosts().filter((p) => p.member !== team.member && p.created > (team.seen || 0)).length;

function teamPostsHTML() {
  const posts = teamPosts();
  if (!posts.length) return `<p class="tm-msg muted">Noch keine Nachrichten</p>`;
  return posts
    .map((p) => {
      const me = p.member === team.member;
      return `<div class="tm-post${me ? ' me' : ''}">${me ? '' : teamAvatar(p, 30)}<div class="tm-bubble"${me ? ` data-team="post-del" data-id="${p.id}"` : ''}><div class="tm-post-h"><b${me ? '' : ' translate="no"'}>${me ? 'Du' : escapeHtml(p.name || '?')}</b><span>${teamAgo(p.created)}</span></div><span translate="no">${escapeHtml(me ? p.text : teamTr(p.text))}</span></div></div>`;
    })
    .join('');
}

function teamBoardHTML() {
  return `<div class="card tm-compose"><input data-team="post-text" placeholder="Nachricht ans Team" maxlength="500" enterkeyhint="send" autocomplete="off" value="${escapeHtml(teamDraft)}"><button class="tm-send" data-team="post" aria-label="Senden" ${teamPosting ? 'disabled' : ''}>${ICON.chevronRight}</button></div>
    <div class="tm-posts" id="tm-posts">${teamPostsHTML()}</div>
    <p class="footnote center">Die letzten 300 Nachrichten bleiben.</p>`;
}

function teamMarkSeen() {
  const newest = teamPosts()[0];
  if (newest && newest.created > (team.seen || 0)) {
    team.seen = newest.created;
    saveTeam();
  }
}

async function teamSendPost() {
  const input = app.querySelector('[data-team="post-text"]');
  const text = (input ? input.value : teamDraft).trim();
  if (!text || teamPosting || !team) return;
  teamPosting = true;
  const btn = app.querySelector('[data-team="post"]');
  if (btn) btn.disabled = true;
  const send = () => teamRequest('POST', '/post', { member: team.member, token: team.token, text });
  try {
    try {
      await send();
    } catch (e) {
      // Noch kein Eintrag in diesem Monat (z. B. gleich nach dem Monatswechsel): erst die Zettel hochladen – über
      // teamUpload (nicht bei offenem „Sicherung einlesen?“, merkt sich, was wirklich gesendet wurde)
      if (e.message !== 'join') throw e;
      team.sent = '';
      if (!(await teamUpload())) throw e;
      await send();
    }
    teamDraft = '';
    if (input) input.value = '';
    haptic();
    await teamLoad();
  } catch (e) {
    if (e.status === 403 && e.message === 'token' && team) leaveTeamLocal('Auf einem anderen iPhone angemeldet');
    else toast(e.status === 429 ? 'Zu viele Nachrichten heute' : e.message === 'konto' ? 'Erst anmelden' : 'Keine Verbindung');
  } finally {
    teamPosting = false;
    const b2 = app.querySelector('[data-team="post"]');
    if (b2) b2.disabled = false;
  }
}

function teamDeletePost(id) {
  confirmDialog('Nachricht löschen?', '', 'Löschen', async () => {
    try {
      await teamRequest('DELETE', '/post', { member: team.member, token: team.token, id: Number(id) });
      await teamLoad();
    } catch {
      toast('Keine Verbindung');
    }
  }, true);
}

/** Sprechblase für den Teammeeting-Knopf (svg() kommt aus app.js, das erst nach team.js geladen wird) */
const teamChatIcon = () => svg('<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.6A8 8 0 1 1 21 12z"/>', 22);

function renderTeam() {
  app.innerHTML = `
    <header class="nav" id="team-nav"></header>
    <div class="title-row"><h1 class="large-title" id="team-title"></h1><span id="team-month"></span></div>
    <div id="team-body"></div>`;
  renderTeamBody();
  if (team) {
    teamUpload();
    if (!team.cache || !team.cache.at || Date.now() - team.cache.at > 15000) teamLoad();
    accountLink();
  }
}

/** Kopf: Teammeeting-Knopf (mit Zahl neuer Nachrichten) bzw. im Teammeeting der Weg zurück */
function renderTeamNav() {
  const nav = document.getElementById('team-nav');
  if (!nav) return;
  // gesperrt (ohne Konto): keine Knöpfe
  const on = !!(team && accountOk());
  const n = on ? teamUnread() : 0;
  nav.innerHTML =
    on && teamPinOpen
      ? `<button class="nav-btn back" data-team="pin-close" aria-label="Zurück">${ICON.back}</button><span class="nav-title"></span><span class="nav-btn"></span>`
      : `${on && admin ? `<button class="nav-btn" data-team="fehler" aria-label="Fehlerberichte">${adminIcon()}</button>` : '<span class="nav-btn"></span>'}<span class="nav-title"></span>${
          on ? `<button class="nav-btn tm-pin" data-team="pin" aria-label="Teammeeting">${teamChatIcon()}${n ? `<i class="tm-badge">${n}</i>` : ''}</button>` : '<span class="nav-btn"></span>'
        }`;
  document.getElementById('team-title').textContent = on && teamPinOpen ? 'Teammeeting' : 'Team';
  // Monat wählen: laufender Monat oder Vormonat (Kapsel wie das Jahr auf der Übersicht)
  const mon = document.getElementById('team-month');
  if (!mon) return;
  if (!on || teamPinOpen) {
    mon.innerHTML = '';
    return;
  }
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth() - (teamPrevOpen ? 1 : 0), 1);
  const chev = (p) => svg(`<path d="${p}"/>`, 18);
  mon.innerHTML = `<span class="nav-btn ov-yearbtn tm-month">
      <button data-team="month-prev" aria-label="Vormonat" ${teamPrevOpen ? 'disabled' : ''}>${chev('M15 5l-7 7 7 7')}</button>
      <span>${MONTHS[d.getMonth()]}</span>
      <button data-team="month-next" aria-label="Laufender Monat" ${teamPrevOpen ? '' : 'disabled'}>${chev('M9 5l7 7-7 7')}</button>
    </span>`;
}

function renderTeamBody() {
  const body = document.getElementById('team-body');
  if (!body) return;
  if (!team) teamPinOpen = false;
  if (teamPinOpen) teamMarkSeen();
  renderTeamNav();
  const icon = svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c2.3.2 3.9 1.8 4.5 4.3"/>', 48);
  // Ohne Konto kein Team (Pflicht); wer schon drin ist, sieht nichts, bis er angemeldet ist
  if (!team && !account) {
    body.innerHTML = `
      <div class="team-empty">${icon}<b>Zettel der Kollegen sehen</b></div>
      <div class="tm-join-form"><button class="primary tm-join-btn" data-team="login">Anmelden</button></div>
      <p class="footnote center">Fürs Team brauchst du ein Konto.</p>`;
    return;
  }
  if (team && !accountOk()) {
    body.innerHTML = `
      <div class="team-empty">${icon}<b>Erst anmelden</b></div>
      <div class="tm-join-form"><button class="primary tm-join-btn" data-team="login">${account ? (account.error ? 'Konto prüfen' : 'Wird geprüft …') : 'Anmelden'}</button></div>
      <p class="footnote center">${account && account.error ? escapeHtml(account.error) : 'Fürs Team brauchst du ein Konto.'}</p>
      <div class="center"><button class="link-btn tm-leave" data-team="leave">Team verlassen</button></div>`;
    return;
  }
  if (!team) {
    body.innerHTML = `
      <div class="team-empty">${icon}<b>Zettel der Kollegen sehen</b></div>
      <div class="tm-join-form">
        <div class="card tm-join"><input data-team="code" placeholder="Team-Code" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go"></div>
        <button class="primary tm-join-btn" data-team="join">Beitreten</button>
      </div>
      <p class="footnote center">Deine Zettel dieses und des letzten Monats sind dann für das Team sichtbar.</p>`;
    return;
  }
  const offline = teamData && teamData.offline ? `<p class="tm-msg muted">Offline${teamData.at ? ` – Stand ${teamAgo(teamData.at)}` : ''}</p>` : '';
  if (teamPinOpen) {
    body.innerHTML = offline + teamBoardHTML();
    return;
  }
  const content = !teamData && !team.cache ? `<p class="tm-msg muted">Wird geladen …</p>` : teamSheetsHTML(teamMembers(teamPrevOpen), teamPrevOpen);
  body.innerHTML = `${offline}${content}
    <div class="center"><button class="link-btn tm-leave" data-team="leave">Team verlassen</button></div>`;
  teamPlaceRows();
}

// ───────── Zettel eines Kollegen ─────────

const teamNav = (title = '') => `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title">${title}</span>
      <span class="nav-btn"></span>
    </header>`;

/** Kollegen für die Unterseiten; ohne Team zurück zur Team-Seite, ohne geladene Daten nachladen */
function teamFindMember(id) {
  if (!team) {
    location.replace('#/team');
    return undefined;
  }
  if (id === team.member) return teamMe(null);
  if (!teamData) teamLoad();
  return teamMembersAll(teamPrevOpen).find((m) => m.member === id) || null;
}

/** Ein Zettel (eine Woche) eines Kollegen oder der eigene, nur lesen: eine Karte, je Tag links Tag und Datum, rechts alle Einträge, Pause und Stunden */
function renderTeamSheet(id, weekStart) {
  // Konto abgelaufen (Passwort anderswo geändert …): wie die Team-Seite nichts zeigen
  if (team && !accountOk()) return location.replace('#/team');
  const m = teamFindMember(id);
  if (m === undefined) return;
  // Woche über ein Monatsende: der Teil des angezeigten Monats (Blatt auf der Team-Seite), sonst der andere
  const [y, mo] = teamShownMonth(teamPrevOpen).split('-').map(Number);
  const parts = m ? (m.sheets || []).filter((x) => x.weekStart === weekStart) : [];
  const s = parts.find((x) => x.year === y && x.month === mo) || parts[0];
  if (!s) {
    app.innerHTML = `${teamNav()}<p class="tm-msg muted">Nicht mehr verfügbar</p>`;
    return;
  }
  const time = (v) => (v == null ? '–' : fmtTime(v));
  // Sa/So nur mit Einträgen (ein automatisch eingetragener Feiertag am Wochenende zählt nicht)
  const blocks = sheetActiveDays(s)
    .filter((i) => i < 5 || teamDayRows(s.days[i]).length > 0 || s.days[i].manual)
    .map((i) => {
      const d = s.days[i];
      const rows = teamDayRows(d);
      const status = d.status ? `<span class="tm-w-st status-${d.status}">${ICON[d.status] || ''} ${DAY_STATUS_SHORT[d.status] || ''}</span>` : '';
      let main;
      if (teamDayOff(d)) main = status;
      else if (!rows.length) main = `<span class="muted">Kein Eintrag</span>`;
      else
        main = `${status}${rows
          .map(
            (r) =>
              `<div class="tm-w-row"><span class="tm-w-time">${time(r.start)}–${time(r.end)}</span><span class="tm-w-text" translate="no"><b>${escapeHtml(r.site)}</b><span class="muted">${escapeHtml(teamTr(r.work))}</span></span></div>`
          )
          .join('')}<div class="tm-w-sum"><span>Pause ${d.pause == null ? '–' : fmtH(d.pause)}</span><b>${fmtH(dayTotal(d, i))}</b></div>`;
      return `<div class="tm-w-day"><div class="tm-w-date"><b>${WEEKDAYS_SHORT[i]}</b><span>${fmtDayMonth(sheetDate(s, i))}</span></div><div class="tm-w-main">${main}</div></div>`;
    })
    .join('');
  app.innerHTML = `${teamNav(`${fmtShort(sheetFirstDate(s))} – ${fmtShort(sheetLastDate(s))}`)}
    <div class="tm-w-who">${teamAvatar(m, 36)}<div><b${m.me ? '' : ' translate="no"'}>${escapeHtml(m.name || '?')}</b><span class="muted">KW ${isoWeek(parseDate(s.weekStart))}</span></div><b class="tm-w-total">${fmtH(sheetTotal(s))}</b></div>
    <div class="card tm-w">${blocks}</div>`;
}

/** Nach dem Laden die gerade offene Team-Seite neu zeichnen */
function teamRefreshView() {
  // Teammeeting: nur die Nachrichten neu, damit Eingabefeld und Tastatur bleiben
  const list = currentView === 'team' && teamPinOpen && document.getElementById('tm-posts');
  if (list) {
    list.innerHTML = teamPostsHTML();
    teamMarkSeen();
  } else if (currentView === 'team') renderTeamBody();
  teamChipsRefresh();
  const pm = location.hash.match(/^#\/team\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/);
  if (pm && currentView === 'teamSheet') renderTeamSheet(decodeURIComponent(pm[1]), pm[2]);
}

// ───────── Im Zettel: Kapsel je Tag mit den Einträgen der Kollegen (Fenster, keine eigene Seite) ─────────

/** Tag eines Kollegen zu einem Datum (auf dem Server liegen laufender Monat und Vormonat) */
function teamDayOf(m, iso) {
  for (const s of m.sheets || []) {
    const i = Math.round((parseDate(iso) - parseDate(s.weekStart)) / 86400000);
    if (i >= 0 && i < 7 && sheetIsActive(s, i)) return { s, i, d: s.days[i] };
  }
  return null;
}
/** Hat jemand zu dem Tag etwas geschrieben? Arbeit oder eine Tagesart wie Urlaub; ein von selbst eingetragener Feiertag zählt nicht */
const teamDayWritten = (d) => !!d && (teamDayRows(d).length > 0 || (!!d.status && (d.status !== 'feiertag' || !!d.manual)));
/** Kollegen mit einem Eintrag an diesem Tag */
const teamOnDay = (iso) => (team ? teamMembersAll().filter((m) => teamDayWritten(teamDayOf(m, iso)?.d)) : []);

function teamDayChipHTML(s, i) {
  if (!team || !accountOk()) return '';
  const people = teamOnDay(isoDate(sheetDate(s, i)));
  if (!people.length) return '';
  return `<button class="ws-chip tm-chip" data-act="team-day" aria-label="Einträge im Team">${ICON.tabTeam}<b>${people.length}</b></button>`;
}

/** Eine Zeile je Kollege: Baustelle bzw. Tagesart und Stunden */
function teamDaySummary(t) {
  const { d, i } = t;
  if (teamDayOff(d)) return { text: DAY_STATUS_SHORT[d.status] || '', hours: '' };
  const rows = teamDayRows(d);
  const sites = [...new Set(rows.map((r) => r.site.trim()).filter(Boolean))];
  return { text: sites.join(', ') || rows.map((r) => teamTr(r.work)).filter(Boolean).join(', '), hours: fmtH(dayTotal(d, i)), user: true };
}

/** Fenster: Liste der Kollegen mit Eintrag an dem Tag; Antippen zeigt im selben Fenster ihre Einträge */
/** Eigener Tag zum Übernehmen: im offenen Zettel, im Monat des Zettels, keine Tagesart außer Feiertag */
function teamTakeTarget(iso) {
  const s = currentView === 'editor' ? currentSheet() : null;
  if (!s) return null;
  const i = [0, 1, 2, 3, 4, 5, 6].find((k) => isoDate(sheetDate(s, k)) === iso);
  if (i == null || !sheetIsActive(s, i) || !canWork(s.days[i])) return null;
  return { s, i, day: s.days[i] };
}
/** Gleiche Zeile (schon übernommen): gleiche Zeiten, Baustelle und Arbeit */
const teamSameRow = (a, b) =>
  a.start === b.start && a.end === b.end && sameKey(a.site) === sameKey(b.site) && sameKey(a.work) === sameKey(b.work);

function teamDayWindow(iso) {
  const date = parseDate(iso);
  const title = `${WEEKDAYS[(date.getDay() + 6) % 7]}, ${fmtDayMonth(date)}`;
  const modal = openModal(`<div class="tm-dw"></div>`, 'sheet tm-dw-sheet');
  const body = modal.querySelector('.tm-dw');
  const head = (left, center) => `<div class="modal-head">${left}<b>${center}</b><button class="modal-btn strong tm-dw-close" data-m="close">Fertig</button></div>`;
  const list = () => {
    const people = teamOnDay(iso);
    body.innerHTML = `${head('<span></span>', title)}
      <div class="tm-dw-body"><div class="card list">${people
        .map((m) => {
          const sum = teamDaySummary(teamDayOf(m, iso));
          return `<button class="list-row tm-dw-person" data-p="${escapeHtml(m.member)}">${teamAvatar(m, 34)}
            <span class="list-main"><span class="list-title" translate="no">${escapeHtml(m.name || '?')}</span>${sum.text ? `<span class="list-sub"${sum.user ? ' translate="no"' : ''}>${escapeHtml(sum.text)}</span>` : ''}</span>
            ${sum.hours ? `<span class="tm-dw-h">${sum.hours}</span>` : ''}<span class="list-chevron">${ICON.chevronRight}</span></button>`;
        })
        .join('')}</div></div>`;
  };
  const person = (id) => {
    const m = teamMembersAll().find((x) => x.member === id);
    const t = m && teamDayOf(m, iso);
    if (!t) return list();
    const { d, i } = t;
    const time = (v) => (v == null ? '–' : fmtTime(v));
    const rows = teamDayRows(d);
    // Übernehmen in den eigenen Zettel (offener Zettel, gleicher Tag, an dem gearbeitet werden kann)
    const own = teamTakeTarget(iso);
    const canTake = !!own && !teamDayOff(d) && rows.length > 0;
    const have = (r) => own.day.rows.some((o) => teamSameRow(o, r));
    // Ganzer Tag schon übernommen: eigene Einträge und Pause sind genau die des Kollegen
    const allHave = canTake && teamDayRows(own.day).length === rows.length && rows.every(have) && own.day.pause === (d.pause ?? null);
    const status = d.status ? `<span class="tm-w-st status-${d.status}">${ICON[d.status] || ''} ${DAY_STATUS_SHORT[d.status] || ''}</span>` : '';
    const main = teamDayOff(d)
      ? status
      : `${status}${rows
          .map(
            (r, k) => `<div class="tm-w-row${canTake ? ' take' : ''}"><span class="tm-w-time">${time(r.start)}–${time(r.end)}</span><span class="tm-w-text" translate="no"><b>${escapeHtml(r.site)}</b><span class="muted">${escapeHtml(teamTr(r.work))}</span></span>${
              canTake ? `<button class="tm-take ${have(r) ? 'done' : ''}" data-take="${k}" aria-label="Übernehmen">${have(r) ? ICON.check : ICON.plus}</button>` : ''
            }</div>`
          )
          .join('')}<div class="tm-w-sum"><span>Pause ${d.pause == null ? '–' : fmtH(d.pause)}</span><b>${fmtH(dayTotal(d, i))}</b></div>`;
    body.innerHTML = `${head(`<button class="modal-btn tm-dw-back" data-m="back">${ICON.back}</button>`, title)}
      <div class="tm-dw-body">
        <div class="tm-dw-who">${teamAvatar(m, 36)}<b translate="no">${escapeHtml(m.name || '?')}</b></div>
        <div class="card tm-dw-day">${main}</div>
        ${canTake ? `<button class="tm-take-all ${allHave ? 'done' : ''}" data-take="all">${allHave ? `${ICON.check} Übernommen` : 'Ganzen Tag übernehmen'}</button>` : ''}
      </div>`;
    body.dataset.person = id;
  };
  /** Einzelner Eintrag: anhängen, nichts wird ersetzt (Überschneidungen zeigen die Warnzeichen).
   *  Ganzer Tag: ersetzt alle eigenen Einträge und die Pause durch die des Kollegen */
  const take = (which) => {
    const m = teamMembersAll().find((x) => x.member === body.dataset.person);
    const t = m && teamDayOf(m, iso);
    const own = teamTakeTarget(iso);
    if (!t || !own) return;
    const day = own.day;
    const copy = (r) => ({ ...emptyRow(), start: r.start, end: r.end, site: r.site || '', work: r.work || '' });
    let n;
    if (which === 'all') {
      const rows = teamDayRows(t.d);
      if (!rows.length) return;
      day.rows = rows.map(copy);
      day.pause = t.d.pause ?? null;
      n = rows.length;
    } else {
      const r = teamDayRows(t.d)[Number(which)];
      if (!r || day.rows.some((o) => teamSameRow(o, r))) return;
      day.rows = day.rows.filter((o) => !rowIsEmpty(o));
      const row = copy(r);
      let at = row.start == null ? -1 : day.rows.findIndex((o) => o.start != null && o.start > row.start);
      if (at < 0) at = day.rows.length;
      day.rows.splice(at, 0, row);
      n = 1;
    }
    expandedDays.add(`${own.s.id}:${own.i}`);
    saveSheets(own.s);
    refreshDay(own.i);
    haptic();
    toast(n === 1 ? 'Eintrag übernommen' : `${n} Einträge übernommen`);
    person(body.dataset.person);
  };
  list();
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-p],[data-m],[data-take]');
    if (!b) return;
    if (b.dataset.take) take(b.dataset.take);
    else if (b.dataset.p) person(b.dataset.p);
    else if (b.dataset.m === 'back') list();
    else closeModal();
  });
}

/** Kapseln im offenen Zettel nach dem Laden auffrischen, ohne die Eingabefelder neu zu zeichnen */
function teamChipsRefresh() {
  if (currentView !== 'editor') return;
  const s = currentSheet();
  if (!s) return;
  for (const el of document.querySelectorAll('#days .day')) {
    const i = Number(el.dataset.day);
    const where = el.querySelector('.day-when, .status-day-line');
    if (!where) continue;
    const html = teamDayChipHTML(s, i);
    const old = where.querySelector('.tm-chip');
    if (old && old.outerHTML === html) continue;
    old?.remove();
    if (html) where.insertAdjacentHTML('beforeend', html);
  }
}

/** Im Zettel: Kollegen-Einträge höchstens jede Minute neu holen */
function teamLoadForEditor() {
  if (!team) return;
  if (team.cache && team.cache.at && Date.now() - team.cache.at < 60000) return;
  teamLoad();
}

// ───────── Ereignisse ─────────

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-team]');
  if (!el || layer.contains(el)) return;
  switch (el.dataset.team) {
    case 'join':
      e.preventDefault();
      joinTeam(app.querySelector('[data-team="code"]').value);
      break;
    case 'pin':
    case 'pin-close':
      haptic();
      teamPinOpen = el.dataset.team === 'pin';
      renderTeamBody();
      window.scrollTo(0, 0);
      break;
    case 'post':
      teamSendPost();
      break;
    case 'post-del':
      teamDeletePost(el.dataset.id);
      break;
    case 'leave':
      leaveTeam();
      break;
    case 'login':
      location.hash = '#/einstellungen/konto';
      break;
    case 'month-prev':
    case 'month-next':
      teamPrevOpen = el.dataset.team === 'month-prev';
      teamX = null;
      renderTeamBody();
      window.scrollTo(0, 0);
      break;
    case 'fehler':
      location.hash = '#/fehler';
      break;
  }
});
// Alle Zettelreihen wischen gemeinsam (gleiche KW bleibt untereinander); Stand merken für das nächste Zeichnen.
// Nur die angefasste Reihe rastet ein, die anderen folgen ihr ohne eigenes Einrasten (sonst ruckeln sie)
let teamLead = null;
document.addEventListener(
  'touchstart',
  (e) => {
    const el = e.target instanceof Element && e.target.closest('.tm-z-scroll');
    if (el) teamTouchAt = Date.now();
    if (!el || el === teamLead) return;
    if (teamLead) teamLead.classList.remove('lead');
    teamLead = el;
    el.classList.add('lead');
  },
  { passive: true, capture: true }
);
document.addEventListener(
  'scroll',
  (e) => {
    const el = e.target;
    if (!(el instanceof Element) || !el.classList.contains('tm-z-scroll')) return;
    teamTouchAt = Date.now();
    if ((teamLead && teamLead.isConnected && el !== teamLead) || (teamX != null && Math.abs(el.scrollLeft - teamX) < 1)) return;
    teamX = el.scrollLeft;
    teamXWeek = isoDate(mondayOf(new Date()));
    document.querySelectorAll('.tm-z-scroll').forEach((o) => o !== el && (o.scrollLeft = teamX));
  },
  true
);
// Return im Code-Feld (app.js schließt danach die Tastatur)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('[data-team="code"]')) joinTeam(e.target.value);
  if (e.key === 'Enter' && e.target.matches('[data-team="post-text"]')) teamSendPost();
});
document.addEventListener('input', (e) => {
  if (e.target.matches('[data-team="post-text"]')) teamDraft = e.target.value;
});

// Beim Öffnen der App und bei Rückkehr: hochladen, Team-Seite neu laden
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !team) return;
  teamQueueUpload(500);
  if (currentView === 'team' || currentView === 'teamSheet') teamLoad();
  else if (currentView === 'editor') teamLoadForEditor();
});
window.addEventListener('online', () => teamQueueUpload(500));
// Teammeeting offen und App im Vordergrund: alle 10 Sekunden nach neuen Nachrichten sehen (fast wie ein Chat)
setInterval(() => {
  if (team && currentView === 'team' && teamPinOpen && document.visibilityState === 'visible' && navigator.onLine) teamLoad();
}, 10000);
setTimeout(() => teamQueueUpload(0), 2000);
