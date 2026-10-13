// Std-Protokoll – Team: Kollegen sehen gegenseitig ihre Stundenzettel des laufenden Monats (nur lesen).
// Speicher: Cloudflare-Worker mit D1-Datenbank in der EU (cloudflare/team-worker.js). Wer den Team-Code kennt,
// lädt seine Zettel des laufenden Monats automatisch hoch und sieht die der anderen. Beim Monatswechsel
// löscht der Worker die alten Einträge.
//
// Eigener Speicher (nicht in der Sicherung): { code, member, token, sent, seen, cache: { month, members, posts, at } }
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
  const res = await fetch(TEAM_URL + path, {
    method,
    headers: { 'X-Team-Code': code, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    cache: 'no-store',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'fehler'), { status: res.status });
  return data;
}

// ───────── Eigene Zettel hochladen ─────────

/** Zettel des laufenden Monats, ohne Angaben, die nur dieses iPhone betreffen */
function teamPayload() {
  const now = new Date();
  return {
    member: team.member,
    token: team.token,
    name: teamFirstName(settings.name),
    month: teamMonth(now),
    sheets: savedSheets()
      .filter((s) => s.year === now.getFullYear() && s.month === now.getMonth() + 1)
      .map((s) => ({ weekStart: s.weekStart, year: s.year, month: s.month, days: s.days })),
  };
}

let teamUploadTimer = 0;
let teamUploading = false;
/** Nach jeder Änderung: kurz warten (mehrere Änderungen auf einmal), dann hochladen, falls sich etwas geändert hat */
function teamQueueUpload(delay = 3000) {
  if (!team || !TEAM_URL) return;
  clearTimeout(teamUploadTimer);
  teamUploadTimer = setTimeout(teamUpload, delay);
}
async function teamUpload() {
  if (!team || !TEAM_URL || teamUploading || !navigator.onLine) return;
  const payload = teamPayload();
  const text = JSON.stringify(payload);
  if (team.sent === text) return;
  teamUploading = true;
  try {
    await teamRequest('PUT', '/me', payload);
    if (team) {
      team.sent = text;
      saveTeam();
    }
  } catch (e) {
    // Falscher Code (z. B. geändert): neu beitreten; sonst beim nächsten Anlass erneut versuchen
    if (e.status === 401 && team) leaveTeamLocal('Team-Code ungültig');
  } finally {
    teamUploading = false;
  }
}

// ───────── Beitreten / Verlassen ─────────

async function joinTeam(code) {
  code = code.trim();
  if (!code) return;
  if (!settings.name.trim()) {
    toast('Bitte zuerst deinen Namen eintragen');
    return;
  }
  const btn = app.querySelector('[data-team="join"]');
  if (btn) btn.disabled = true;
  const next = { code, member: uid(), token: uid() + uid(), sent: '' };
  const prev = team;
  team = next;
  try {
    await teamRequest('PUT', '/me', teamPayload());
    team.sent = JSON.stringify(teamPayload());
    saveTeam();
    haptic();
    renderTeamBody();
    teamLoad();
  } catch (e) {
    team = prev;
    toast(e.status === 401 ? 'Falscher Team-Code' : 'Keine Verbindung');
    if (btn) btn.disabled = false;
  }
}

function leaveTeamLocal(message) {
  team = null;
  saveTeam();
  teamData = null;
  if (currentView === 'team') renderTeam();
  else if (currentView === 'teamSheet') location.replace('#/team');
  if (message) toast(message);
}

function leaveTeam() {
  confirmDialog('Team verlassen?', 'Deine Zettel werden für das Team gelöscht.', 'Verlassen', async () => {
    try {
      await teamRequest('DELETE', '/me', { member: team.member, token: team.token });
    } catch (e) {
      if (e.status !== 401) {
        toast('Keine Verbindung');
        return;
      }
    }
    leaveTeamLocal();
  }, true);
}

// ───────── Team-Seite: je Person eine Karte mit ihren Zetteln des Monats (gleiche KW untereinander) ─────────

/** Zuletzt geladene Einträge der Kollegen (null = noch nichts geladen) */
let teamData = null;
let teamLoading = false;
/** Teammeeting offen (statt der Zettel), Scrollstand, waagerechter Stand der Zettelreihen (null = laufende Woche zeigen) */
let teamPinOpen = false;
let teamScroll = 0;
let teamX = null;
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
    sheets: (Array.isArray(m.sheets) ? m.sheets : [])
      .filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s.weekStart) && Array.isArray(s.days) && s.days.length === 7)
      .map((s) => ({
        weekStart: s.weekStart,
        year: num(s.year),
        month: num(s.month),
        days: s.days.map((d) => ({
          status: Object.hasOwn(DAY_STATUS_SHORT, d && d.status) ? d.status : undefined,
          pause: num(d && d.pause),
          rows: (Array.isArray(d && d.rows) ? d.rows : []).map((r) => ({
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
  if (!team || !TEAM_URL || teamLoading) return;
  teamLoading = true;
  try {
    const data = await teamRequest('GET', '/team');
    team.cache = { month: data.month, members: teamClean(data.members), posts: teamCleanPosts(data.posts), at: Date.now() };
    saveTeam();
    teamData = team.cache;
  } catch (e) {
    if (e.status === 401) {
      teamLoading = false;
      leaveTeamLocal('Team-Code ungültig');
      return;
    }
    teamData = { ...(team.cache || { members: [] }), offline: true };
  }
  teamLoading = false;
  teamRefreshView();
}

const teamAgo = (ms) => {
  const min = Math.round((Date.now() - ms) / 60000);
  if (min < 60) return min < 1 ? 'gerade eben' : `vor ${min} Min.`;
  const h = Math.round(min / 60);
  if (h < 24) return `vor ${h} Std.`;
  const d = Math.round(h / 24);
  return `vor ${d} Tag${d > 1 ? 'en' : ''}`;
};

/** Tag einer Person am Datum (aus dem Zettel, zu dessen Monat das Datum gehört) */
function teamMemberDay(m, date) {
  for (const s of m.sheets || []) {
    if (!Array.isArray(s.days) || s.days.length !== 7) continue;
    const i = Math.round((startOfDay(date) - parseDate(s.weekStart)) / 86400000);
    if (i >= 0 && i < 7 && sheetIsActive(s, i)) return { d: s.days[i], i };
  }
  return null;
}

function teamDayHTML(x) {
  if (!x) return `<div class="tm-none">Kein Eintrag</div>`;
  const { d, i } = x;
  if (d.status && !holidayWork(d)) return `<div class="tm-status status-${d.status}">${ICON[d.status] || ''} ${DAY_STATUS_SHORT[d.status] || ''}</div>`;
  const rows = (d.rows || []).filter((r) => !rowIsEmpty(r));
  if (!rows.length) return `<div class="tm-none">Kein Eintrag</div>`;
  const time = (m) => (m == null ? '–' : fmtTime(m));
  return `${d.status ? `<div class="tm-status status-${d.status}">${ICON[d.status] || ''} ${DAY_STATUS_SHORT[d.status] || ''}</div>` : ''}${rows
    .map(
      (r) => `<div class="tm-row"><span class="tm-time">${time(r.start)}–${time(r.end)}</span><span class="tm-text"><b>${escapeHtml(r.site)}</b><span>${escapeHtml(r.work)}</span></span></div>`
    )
    .join('')}
    <div class="tm-foot"><span>Pause ${d.pause == null ? '–' : fmtH(d.pause)}</span><span>Gesamt <b>${fmtH(dayTotal(d, i))}</b></span></div>`;
}

const TEAM_COLORS = ['#2f9e74', '#8e5bd6', '#d2477a', '#2b84d6', '#b38a1e', '#e5793b'];

/** Kollegen ohne den eigenen Eintrag (Reihenfolge wie vom Server: nach Namen); vor dem ersten Laden der Zwischenspeicher */
const teamMembers = () => ((teamData || (team && team.cache) || {}).members || []).filter((m) => team && m.member !== team.member);
const teamDayRows = (x) => (x ? (x.d.rows || []).filter((r) => !rowIsEmpty(r)) : []);
const teamDayHasContent = (x) => !!x && (!!x.d.status || teamDayRows(x).length > 0);

/** Kreis mit dem Anfangsbuchstaben; Farbe nach der Stelle in der Liste, damit sich keine zwei gleichen */
function teamAvatar(m, size = 34) {
  if (m.me) return `<span class="tm-av tm-av-me" style="--s:${size}px">D</span>`;
  const k = Math.max(0, teamMembers().findIndex((x) => x.member === m.member));
  return `<span class="tm-av" style="--av:${TEAM_COLORS[k % TEAM_COLORS.length]};--s:${size}px">${escapeHtml(([...(m.name || '?')][0] || '?').toUpperCase())}</span>`;
}

// Baustellen: gleiche Baustelle trotz anderer Schreibweise erkennen (für Farbe und Wahl der Tagesbaustelle)

/** Klein, ohne Akzente und Sonderzeichen, „Straße“ = „Str.“; nur der Teil vor dem Komma (danach steht meist der Ort); Hausnummern getrennt */
function teamSiteParts(name) {
  const s = String(name).toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/strasse/g, 'str');
  const core = s.split(',')[0];
  return { letters: core.replace(/[^a-z]/g, ''), nums: (core.match(/\d+/g) || []).join(' ') };
}
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
/** Gleiche Baustelle? Hausnummern müssen passen; sonst gleich, Anfang der anderen (Ort fehlt) oder ein bis zwei Tippfehler */
function teamSameSite(a, b) {
  if (a.nums && b.nums && a.nums !== b.nums) return false;
  if (!a.letters || !b.letters) return a.letters === b.letters && a.nums === b.nums;
  if (a.letters === b.letters) return true;
  const [x, y] = a.letters.length <= b.letters.length ? [a.letters, b.letters] : [b.letters, a.letters];
  if (x.length >= 4 && y.startsWith(x)) return true;
  return teamEditDistance(x, y) <= (x.length >= 8 ? 2 : x.length >= 5 ? 1 : 0);
}
/** Schreibweise → Nummer der Baustelle (nach erstem Auftreten); wird bei jedem Zeichnen neu gebildet */
let teamSites = new Map();
function teamGroupSites(people) {
  const names = [];
  for (const p of people)
    for (const s of p.sheets || [])
      for (const d of s.days) for (const r of d.rows || []) if (r.site && r.site.trim() && !names.includes(r.site.trim())) names.push(r.site.trim());
  const parts = names.map(teamSiteParts);
  const group = names.map((_, i) => i);
  const root = (i) => (group[i] === i ? i : (group[i] = root(group[i])));
  for (let i = 0; i < names.length; i++) for (let j = 0; j < i; j++) if (teamSameSite(parts[i], parts[j])) group[root(i)] = root(j);
  const ids = new Map();
  teamSites = new Map(names.map((n, i) => [n, ids.has(root(i)) ? ids.get(root(i)) : (ids.set(root(i), ids.size), ids.size - 1)]));
}
const teamSiteId = (name) => teamSites.get(String(name).trim()) ?? -1;
/** Textmarker-Farben, eine je Baustelle */
const TEAM_MARKERS = ['#ffd84a', '#7fe0a0', '#ff9cc2', '#8ec9ff', '#ffb46b', '#c9a8ff', '#9ee6e0', '#e6e07a'];

/** Baustelle des Tages: meiste Stunden; bei Gleichstand die, auf der an dem Tag mehr Leute waren; dann alphabetisch */
function teamMainSite(d, date, people) {
  const sites = new Map();
  for (const r of teamDayRows({ d })) {
    const name = r.site.trim();
    if (!name) continue;
    const id = teamSiteId(name);
    const e = sites.get(id) || { id, name, m: 0 };
    e.m += r.start != null && r.end != null ? Math.max(0, r.end - r.start) : 0;
    sites.set(id, e);
  }
  if (!sites.size) return null;
  const crew = (id) => people.filter((q) => teamDayRows(teamMemberDay(q, date)).some((r) => teamSiteId(r.site) === id)).length;
  return [...sites.values()]
    .map((e) => ({ ...e, n: crew(e.id) }))
    .sort((a, b) => b.m - a.m || b.n - a.n || a.name.localeCompare(b.name, 'de'))[0];
}

/** Wochen des laufenden Monats (ganze und Teilwochen) bis zur laufenden bzw. bis zur letzten mit einem Zettel */
function teamWeeks(people) {
  const now = new Date();
  const first = new Date(now.getFullYear(), now.getMonth(), 1);
  const last = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const weeks = [];
  for (let d = mondayOf(first); d <= last; d = addDays(d, 7))
    weeks.push({ mon: d, iso: isoDate(d), a: d < first ? first : d, b: addDays(d, 6) > last ? last : addDays(d, 6), now: sameDay(d, mondayOf(now)) });
  let end = weeks.findIndex((w) => w.now);
  weeks.forEach((w, k) => people.some((p) => (p.sheets || []).some((s) => s.weekStart === w.iso)) && (end = Math.max(end, k)));
  return weeks.slice(0, end + 1);
}

/** Ein Zettel als kleines Blatt: KW, Mo–Fr mit Baustelle, Gesamt; darunter 0–2 weitere Blätter wie auf einem Stapel.
 *  sites: Baustelle je Tag (aus teamMainSite); shared(i, id): steht dieselbe Baustelle an diesem Tag auch bei jemand anderem → Textmarker */
function teamPaperHTML(p, s, w, sites, shared) {
  const rows = [0, 1, 2, 3, 4]
    .map((i) => {
      const day = `<u>${WEEKDAYS_SHORT[i]}</u>`;
      if (!sheetIsActive(s, i)) return `<i class="off">${day}<span></span></i>`;
      const d = s.days[i];
      if (d.status && !holidayWork(d)) return `<i class="st-${d.status}">${day}<span><em>${DAY_STATUS_SHORT[d.status] || ''}</em></span></i>`;
      const site = sites[i];
      const name = site ? escapeHtml(site.name) : '';
      return `<i>${day}<span>${site && shared(i, site.id) ? `<mark style="--mk:${TEAM_MARKERS[site.id % TEAM_MARKERS.length]}">${name}</mark>` : name}</span></i>`;
    })
    .join('');
  // Stapel: fest je Person und Woche, damit nichts springt
  const seed = isoWeek(w.mon) * 7 + [...String(p.member)].reduce((t, c) => t + c.charCodeAt(0), 0);
  const lay = [[-1, -1.5, 3], [0.8, 2, 2], [-0.6, 1.5, 3], [1.2, -1.5, 3], [-1.3, 1, 3], [0.6, -2, 2]];
  const under = Array.from({ length: seed % 3 }, (_, k) => {
    const [r, x, y] = lay[(seed + k * 2) % lay.length];
    return `<i class="tm-z-under" style="--r:${r}deg;--x:${x}px;--y:${y}px"></i>`;
  }).join('');
  // Eigene Zettel nur ansehen (bearbeiten über „Zettel“), Zettel der Kollegen öffnen die Wochenansicht
  const tag = p.me ? 'div' : 'a';
  const href = p.me ? '' : ` href="#/team/${encodeURIComponent(p.member)}/${s.weekStart}"`;
  return `<${tag} class="tm-z${w.now ? ' now' : ''}"${href}><span class="tm-z-bg">${under}<i class="tm-z-paper"></i><i class="tm-z-flap"></i></span><span class="tm-z-top"><small>Stundenzettel</small><b>KW ${isoWeek(w.mon)}</b><small class="tm-z-range">${w.a.getDate()}.–${w.b.getDate()}.</small></span>
    <span class="tm-z-t">${rows}</span>
    <span class="tm-z-f"><small>Gesamt</small><b>${fmtDec(sheetTotal(s))} h</b></span></${tag}>`;
}

function teamSheetsHTML(members) {
  const now = new Date();
  const me = { member: team.member, name: 'Du', me: true, sheets: savedSheets().filter((s) => s.year === now.getFullYear() && s.month === now.getMonth() + 1) };
  // Die eigene Reihe steht immer ganz unten
  const people = [...members, me];
  teamGroupSites(people);
  const weeks = teamWeeks(people);
  const nowCol = weeks.findIndex((w) => w.now);
  // Baustelle je Person, Woche und Tag; dazu, wer an welchem Tag welche Baustelle auf dem Zettel stehen hat
  const sheetOf = (p, w) => (p.sheets || []).find((x) => x.weekStart === w.iso);
  const shown = new Map();
  const crew = new Map();
  for (const p of people)
    for (const w of weeks) {
      const s = sheetOf(p, w);
      if (!s) continue;
      const sites = [0, 1, 2, 3, 4].map((i) => (sheetIsActive(s, i) && !(s.days[i].status && !holidayWork(s.days[i])) ? teamMainSite(s.days[i], sheetDate(s, i), people) : null));
      shown.set(`${p.member}|${w.iso}`, sites);
      sites.forEach((x, i) => x && crew.set(`${isoDate(sheetDate(s, i))}|${x.id}`, (crew.get(`${isoDate(sheetDate(s, i))}|${x.id}`) || new Set()).add(p.member)));
    }
  const cards = people
    .map((p) => {
      let total = 0;
      const slots = weeks
        .map((w, k) => {
          const s = sheetOf(p, w);
          if (!s) return `<span class="tm-z-slot gap"></span>`;
          total += sheetTotal(s);
          const shared = (i, id) => (crew.get(`${isoDate(sheetDate(s, i))}|${id}`) || new Set()).size > 1;
          return `<span class="tm-z-slot" style="--tilt:${[-0.3, 0.2, -0.1, 0.35, -0.2, 0.15][(k + p.name.length) % 6]}deg">${teamPaperHTML(p, s, w, shown.get(`${p.member}|${w.iso}`), shared)}</span>`;
        })
        .join('');
      return `<div class="card tm-pcard${p.me ? ' me' : ''}"><div class="tm-pcard-h">${teamAvatar(p, 30)}<b>${escapeHtml(p.name || '?')}</b><span>${total ? fmtH(total) : ''}</span></div>
        <div class="tm-z-scroll"><div class="tm-z-row" data-now="${nowCol}" style="--n:${weeks.length}">${slots}</div></div></div>`;
    })
    .join('');
  return `<h2 class="section-title">${MONTHS[now.getMonth()]} ${now.getFullYear()}</h2>${members.length ? '' : '<p class="tm-msg muted">Noch keine Zettel von Kollegen</p>'}${cards}`;
}

/** Zettelreihen auf den gemerkten Stand bzw. so, dass die laufende Woche rechts zu sehen ist */
function teamPlaceRows() {
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
      return `<div class="tm-post${me ? ' me' : ''}">${me ? '' : teamAvatar(p, 30)}<div class="tm-bubble"${me ? ` data-team="post-del" data-id="${p.id}"` : ''}><div class="tm-post-h"><b>${me ? 'Du' : escapeHtml(p.name || '?')}</b><span>${teamAgo(p.created)}</span></div>${escapeHtml(p.text)}</div></div>`;
    })
    .join('');
}

function teamBoardHTML() {
  return `<div class="card tm-compose"><input data-team="post-text" placeholder="Nachricht ans Team" maxlength="500" enterkeyhint="send" autocomplete="off" value="${escapeHtml(teamDraft)}"><button class="tm-send" data-team="post" aria-label="Senden" ${teamPosting ? 'disabled' : ''}>${ICON.chevronRight}</button></div>
    <div class="tm-posts" id="tm-posts">${teamPostsHTML()}</div>
    <p class="footnote center">Nachrichten verschwinden am Monatsende.</p>`;
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
      // Noch kein Eintrag in diesem Monat (z. B. gleich nach dem Monatswechsel): erst die Zettel hochladen
      if (e.message !== 'join') throw e;
      team.sent = '';
      await teamRequest('PUT', '/me', teamPayload());
      team.sent = JSON.stringify(teamPayload());
      saveTeam();
      await send();
    }
    teamDraft = '';
    if (input) input.value = '';
    haptic();
    teamPosting = false;
    await teamLoad();
  } catch (e) {
    toast(e.status === 429 ? 'Zu viele Nachrichten in diesem Monat' : 'Keine Verbindung');
  }
  teamPosting = false;
  const b2 = app.querySelector('[data-team="post"]');
  if (b2) b2.disabled = false;
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
    <h1 class="large-title" id="team-title"></h1>
    <div id="team-body"></div>`;
  renderTeamBody();
  if (team) {
    teamUpload();
    teamLoad();
  }
}

/** Kopf: Teammeeting-Knopf (mit Zahl neuer Nachrichten) bzw. im Teammeeting der Weg zurück */
function renderTeamNav() {
  const nav = document.getElementById('team-nav');
  if (!nav) return;
  const n = team ? teamUnread() : 0;
  nav.innerHTML =
    team && teamPinOpen
      ? `<button class="nav-btn back" data-team="pin-close" aria-label="Zurück">${ICON.back}</button><span class="nav-title"></span><span class="nav-btn"></span>`
      : `<span class="nav-btn"></span><span class="nav-title"></span>${
          team ? `<button class="nav-btn tm-pin" data-team="pin" aria-label="Teammeeting">${teamChatIcon()}${n ? `<i class="tm-badge">${n}</i>` : ''}</button>` : '<span class="nav-btn"></span>'
        }`;
  document.getElementById('team-title').textContent = team && teamPinOpen ? 'Teammeeting' : 'Team';
}

function renderTeamBody() {
  const body = document.getElementById('team-body');
  if (!body) return;
  if (!team) teamPinOpen = false;
  if (teamPinOpen) teamMarkSeen();
  renderTeamNav();
  if (!team) {
    body.innerHTML = `
      <div class="team-empty">${svg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 19c.8-3.2 3-5 5.5-5s4.7 1.8 5.5 5"/><circle cx="17" cy="9" r="2.4"/><path d="M16 14.2c2.3.2 3.9 1.8 4.5 4.3"/>', 48)}<b>Zettel der Kollegen sehen</b></div>
      <div class="tm-join-form">
        <div class="card tm-join"><input data-team="code" placeholder="Team-Code" autocapitalize="none" autocomplete="off" autocorrect="off" spellcheck="false" enterkeyhint="go"></div>
        <button class="primary tm-join-btn" data-team="join">Beitreten</button>
      </div>
      <p class="footnote center">Deine Zettel des laufenden Monats sind dann für das Team sichtbar.</p>`;
    return;
  }
  const offline = teamData && teamData.offline ? `<p class="tm-msg muted">Offline${teamData.at ? ` – Stand ${teamAgo(teamData.at)}` : ''}</p>` : '';
  if (teamPinOpen) {
    body.innerHTML = offline + teamBoardHTML();
    return;
  }
  const content = !teamData && !team.cache ? `<p class="tm-msg muted">Wird geladen …</p>` : teamSheetsHTML(teamMembers());
  body.innerHTML = `${offline}${content}
    <div class="center"><button class="link-btn tm-leave" data-team="leave">Team verlassen</button></div>`;
  teamPlaceRows();
}

// ───────── Zettel eines Kollegen ─────────

const teamNav = () => `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>`;

/** Kollegen für die Unterseiten; ohne Team zurück zur Team-Seite, ohne geladene Daten nachladen */
function teamFindMember(id) {
  if (!team) {
    location.replace('#/team');
    return undefined;
  }
  if (!teamData) teamLoad();
  return teamMembers().find((m) => m.member === id) || null;
}

/** Ein Zettel (eine Woche) eines Kollegen, nur lesen */
function renderTeamSheet(id, weekStart) {
  const m = teamFindMember(id);
  if (m === undefined) return;
  const s = m && (m.sheets || []).find((x) => x.weekStart === weekStart);
  if (!s) {
    app.innerHTML = `${teamNav()}<p class="tm-msg muted">Nicht mehr verfügbar</p>`;
    return;
  }
  const days = sheetActiveDays(s)
    .filter((i) => i < 5 || teamDayHasContent({ d: s.days[i], i }))
    .map((i) => {
      const t = dayTotal(s.days[i], i);
      return `<h2 class="section-title tm-name"><span>${WEEKDAYS[i]}, ${fmtDayMonth(sheetDate(s, i))}</span><span>${t ? fmtH(t) : ''}</span></h2>
        <div class="card tm-day">${teamDayHTML({ d: s.days[i], i })}</div>`;
    })
    .join('');
  app.innerHTML = `${teamNav()}
    <div class="tm-sheet-head">${teamAvatar(m, 40)}<div><h1>KW ${isoWeek(parseDate(s.weekStart))}</h1>
      <span class="muted">${escapeHtml(m.name || '?')} · ${fmtDayMonth(sheetFirstDate(s))} – ${fmtDayMonth(sheetLastDate(s))}</span></div>
      <b>${fmtH(sheetTotal(s))}</b></div>
    ${days}`;
}

/** Nach dem Laden die gerade offene Team-Seite neu zeichnen */
function teamRefreshView() {
  // Teammeeting: nur die Nachrichten neu, damit Eingabefeld und Tastatur bleiben
  const list = currentView === 'team' && teamPinOpen && document.getElementById('tm-posts');
  if (list) {
    list.innerHTML = teamPostsHTML();
    teamMarkSeen();
  } else if (currentView === 'team') renderTeamBody();
  const pm = location.hash.match(/^#\/team\/([^/]+)\/(\d{4}-\d{2}-\d{2})$/);
  if (pm && currentView === 'teamSheet') renderTeamSheet(decodeURIComponent(pm[1]), pm[2]);
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
  }
});
// Alle Zettelreihen wischen gemeinsam (gleiche KW bleibt untereinander); Stand merken für das nächste Zeichnen.
// Nur die angefasste Reihe rastet ein, die anderen folgen ihr ohne eigenes Einrasten (sonst ruckeln sie)
let teamLead = null;
document.addEventListener(
  'touchstart',
  (e) => {
    const el = e.target instanceof Element && e.target.closest('.tm-z-scroll');
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
    if ((teamLead && teamLead.isConnected && el !== teamLead) || (teamX != null && Math.abs(el.scrollLeft - teamX) < 1)) return;
    teamX = el.scrollLeft;
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
  if (currentView === 'team') teamLoad();
});
window.addEventListener('online', () => teamQueueUpload(500));
// Teammeeting offen und App im Vordergrund: alle 10 Sekunden nach neuen Nachrichten sehen (fast wie ein Chat)
setInterval(() => {
  if (team && currentView === 'team' && teamPinOpen && document.visibilityState === 'visible' && navigator.onLine) teamLoad();
}, 10000);
setTimeout(() => teamQueueUpload(0), 2000);
