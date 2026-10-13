// Std-Protokoll – Team: Kollegen sehen gegenseitig ihre Stundenzettel des laufenden Monats (nur lesen).
// Speicher: Cloudflare-Worker mit D1-Datenbank in der EU (cloudflare/team-worker.js). Wer den Team-Code kennt,
// lädt seine Zettel des laufenden Monats automatisch hoch und sieht die der anderen. Beim Monatswechsel
// löscht der Worker die alten Einträge.
//
// Eigener Speicher (nicht in der Sicherung): { code, member, token, sent, seen, cache: { month, members, posts, at } }
// seen: Zeitpunkt der zuletzt gesehenen Pinnwand-Nachricht (Punkt am Reiter „Pinnwand“)

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
  else if (currentView === 'teamPerson' || currentView === 'teamSheet') location.replace('#/team');
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

// ───────── Team-Seite: Reiter „Heute“ (Kollegen zum Aufklappen) und „Woche“ (Stunden je Tag) ─────────

/** Zuletzt geladene Einträge der Kollegen (null = noch nichts geladen) */
let teamData = null;
let teamLoading = false;
/** Gewählter Reiter, Tag unter „Heute“ (ohne Wahl heute), Montag unter „Woche“, aufgeklappte Kollegen, Scrollstand */
let teamTab = 'heute';
let teamDay = null;
let teamWeek = null;
const teamOpen = new Set();
let teamScroll = 0;
/** Angefangene Nachricht für die Pinnwand */
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

/** Tag eines Kollegen am Datum (aus dem Zettel, zu dessen Monat das Datum gehört) */
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

function renderTeam() {
  app.innerHTML = `
    <header class="nav">
      <span class="nav-btn"></span>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title">Team</h1>
    <div id="team-body"></div>`;
  renderTeamBody();
  if (team) {
    teamUpload();
    teamLoad();
  }
}

const TEAM_COLORS = ['#2f9e74', '#8e5bd6', '#d2477a', '#2b84d6', '#b38a1e', '#e5793b'];
const TEAM_STATUS_LETTER = { krank: 'K', urlaub: 'U', feiertag: 'FT', frei: 'F' };

/** Kollegen ohne den eigenen Eintrag (Reihenfolge wie vom Server: nach Namen); vor dem ersten Laden der Zwischenspeicher */
const teamMembers = () => ((teamData || (team && team.cache) || {}).members || []).filter((m) => team && m.member !== team.member);
const teamInMonth = (d) => {
  const t = new Date();
  return d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear();
};
const teamDayHasContent = (x) => !!x && (!!x.d.status || (x.d.rows || []).some((r) => !rowIsEmpty(r)));

/** Kreis mit dem Anfangsbuchstaben; Farbe nach der Stelle in der Liste, damit sich keine zwei gleichen */
function teamAvatar(m, size = 34) {
  const k = Math.max(0, teamMembers().findIndex((x) => x.member === m.member));
  return `<span class="tm-av" style="--av:${TEAM_COLORS[k % TEAM_COLORS.length]};--s:${size}px">${escapeHtml(([...(m.name || '?')][0] || '?').toUpperCase())}</span>`;
}

/** Eine Zeile für den Tag: Baustelle (oder Anzahl), erste bis letzte Uhrzeit, Stunden */
function teamDaySummary(x) {
  const none = { sub: '<span class="muted">Kein Eintrag</span>', h: '', detail: false };
  if (!x) return none;
  const { d, i } = x;
  const rows = (d.rows || []).filter((r) => !rowIsEmpty(r));
  if (d.status && !holidayWork(d))
    return { sub: `<span class="tm-ink status-${d.status}">${ICON[d.status] || ''} ${DAY_STATUS_SHORT[d.status] || ''}</span>`, h: '', detail: false };
  if (!rows.length) return none;
  const sites = [...new Set(rows.map((r) => r.site.trim()).filter(Boolean))];
  const where = sites.length > 1 ? `${sites.length} Baustellen` : escapeHtml(sites[0] || rows[0].work || '');
  const from = rows[0].start, to = rows[rows.length - 1].end;
  const time = from != null && to != null ? `${fmtTime(from)}–${fmtTime(to)}` : '';
  return { sub: `<span class="muted">${[where, time].filter(Boolean).join(' · ')}</span>`, h: fmtH(dayTotal(d, i)), detail: true };
}

/** Voriger/nächster Tag im laufenden Monat; Sa/So nur, wenn jemand etwas eingetragen hat */
function teamStepDay(dir) {
  const members = teamMembers();
  for (let d = addDays(teamDay, dir); teamInMonth(d); d = addDays(d, dir)) {
    const wd = (d.getDay() + 6) % 7;
    if (wd < 5 || members.some((m) => teamDayHasContent(teamMemberDay(m, d)))) return d;
  }
  return null;
}

function teamTodayHTML(members) {
  const today = startOfDay(new Date());
  if (!teamDay || !teamInMonth(teamDay)) teamDay = today;
  const prev = teamStepDay(-1);
  const next = teamStepDay(1);
  const wd = (teamDay.getDay() + 6) % 7;
  const label = `${sameDay(teamDay, today) ? 'Heute · ' : ''}${WEEKDAYS[wd]}, ${fmtDayMonth(teamDay)}`;
  const arrow = (d, dir) =>
    `<button class="tm-arrow" data-team="day" ${d ? `data-date="${isoDate(d)}"` : 'disabled'} aria-label="${dir < 0 ? 'Tag zurück' : 'Tag vor'}">${dir < 0 ? ICON.chevronLeft : ICON.chevronRight}</button>`;
  const rows = members
    .map((m) => {
      const x = teamMemberDay(m, teamDay);
      const { sub, h, detail } = teamDaySummary(x);
      const open = teamOpen.has(m.member);
      return `<div class="tm-acc${open ? ' open' : ''}">
        <button class="list-row plain tm-person" data-team="toggle" data-member="${escapeHtml(m.member)}">${teamAvatar(m)}<span class="tm-mid"><b>${escapeHtml(m.name || '?')}</b>${sub}</span><span class="tm-h">${h}</span><span class="tm-chev">${ICON.chevronRight}</span></button>
        ${open ? `<div class="tm-acc-body">${detail ? teamDayHTML(x) : ''}<a class="tm-all" href="#/team/${encodeURIComponent(m.member)}">Alle Zettel von ${escapeHtml(m.name || '?')} ${ICON.chevronRight}</a></div>` : ''}
      </div>`;
    })
    .join('');
  return `<div class="tm-dayhead">${arrow(prev, -1)}<span>${label}</span>${arrow(next, 1)}</div>
    <div class="card tm-list">${rows}</div>`;
}

/** Woche: alle Kollegen (und man selbst) mit Stunden je Tag */
function teamWeekHTML(members) {
  const overlaps = (mon) => teamInMonth(mon) || teamInMonth(addDays(mon, 6));
  if (!teamWeek || !overlaps(teamWeek)) teamWeek = mondayOf(new Date());
  const iso = isoDate(teamWeek);
  const now = new Date();
  const own = sheets.find((s) => s.weekStart === iso && s.year === now.getFullYear() && s.month === now.getMonth() + 1);
  const people = [
    { name: 'Du', me: true, sheet: own },
    ...members.map((m) => ({ m, name: m.name || '?', sheet: (m.sheets || []).find((s) => s.weekStart === iso) })),
  ];
  const content = (s, i) => s && sheetIsActive(s, i) && teamDayHasContent({ d: s.days[i], i });
  // Nur Tage des laufenden Monats; Sa/So nur, wenn jemand etwas eingetragen hat
  const days = [0, 1, 2, 3, 4, 5, 6].filter((i) => teamInMonth(addDays(teamWeek, i)) && (i < 5 || people.some((p) => content(p.sheet, i))));
  const head = `<div class="tm-wk tm-wk-h"><span></span>${days
    .map((i) => `<span>${WEEKDAYS_SHORT[i]}<small>${addDays(teamWeek, i).getDate()}.</small></span>`)
    .join('')}<span>Σ</span></div>`;
  const line = (p) => {
    const s = p.sheet;
    const link = (inner, cls = '') =>
      p.me || !s ? `<span class="${cls}">${inner}</span>` : `<a class="${cls}" href="#/team/${encodeURIComponent(p.m.member)}/${iso}">${inner}</a>`;
    const cells = days
      .map((i) => {
        if (!s || !sheetIsActive(s, i)) return `<span class="muted">–</span>`;
        const d = s.days[i];
        if (d.status && !holidayWork(d)) return link(TEAM_STATUS_LETTER[d.status] || '?', `tm-st status-${d.status}`);
        const t = dayTotal(d, i);
        return t ? link(fmtDec(t)) : `<span class="muted">–</span>`;
      })
      .join('');
    const total = s ? sheetTotal(s) : 0;
    const name = p.me
      ? `<span class="tm-wk-n"><span class="tm-av tm-av-me" style="--s:24px">D</span>Du</span>`
      : `<a class="tm-wk-n" href="#/team/${encodeURIComponent(p.m.member)}">${teamAvatar(p.m, 24)}<span>${escapeHtml(p.name)}</span></a>`;
    return `<div class="tm-wk${p.me ? ' tm-me' : ''}">${name}${cells}<b>${total ? fmtDec(total) : '–'}</b></div>`;
  };
  const first = addDays(teamWeek, days[0] ?? 0);
  const last = addDays(teamWeek, days.at(-1) ?? 4);
  const canPrev = overlaps(addDays(teamWeek, -7));
  const canNext = overlaps(addDays(teamWeek, 7));
  return `<div class="tm-week">
      <button class="tm-arrow" data-team="week" data-dir="-1" ${canPrev ? '' : 'disabled'} aria-label="Woche zurück">${ICON.chevronLeft}</button>
      <span>KW ${isoWeek(teamWeek)} · ${fmtDayMonth(first)} – ${fmtDayMonth(last)}</span>
      <button class="tm-arrow" data-team="week" data-dir="1" ${canNext ? '' : 'disabled'} aria-label="Woche vor">${ICON.chevronRight}</button>
    </div>
    <div class="card tm-table${days.length > 5 ? ' wide' : ''}" style="--cols:${days.length}">${head}${people.map(line).join('')}</div>`;
}

// ───────── Pinnwand ─────────

const teamPosts = () => (teamData || (team && team.cache) || {}).posts || [];
/** Neue Nachrichten anderer seit dem letzten Blick auf die Pinnwand */
const teamUnread = () => teamPosts().some((p) => p.member !== team.member && p.created > (team.seen || 0));

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

/** Neueste Nachricht oben auf „Heute“ */
function teamTeaserHTML() {
  const p = teamPosts()[0];
  if (!p) return '';
  const me = p.member === team.member;
  const n = teamPosts().length;
  return `<h2 class="section-title tm-name"><span>Pinnwand</span><button class="tm-more" data-team="tab" data-tab="pinnwand">${n} ${n === 1 ? 'Nachricht' : 'Nachrichten'} ›</button></h2>
    <button class="card tm-teaser" data-team="tab" data-tab="pinnwand">${me ? '<span class="tm-av tm-av-me" style="--s:30px">D</span>' : teamAvatar(p, 30)}<span><b>${me ? 'Du' : escapeHtml(p.name || '?')}</b> <span class="muted">${teamAgo(p.created)}</span><span class="tm-teaser-t">${escapeHtml(p.text)}</span></span></button>`;
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

function renderTeamBody() {
  const body = document.getElementById('team-body');
  if (!body) return;
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
  const members = teamMembers();
  let content;
  if (teamTab === 'pinnwand') {
    content = teamBoardHTML();
    teamMarkSeen();
  } else if (!teamData && !team.cache) content = `<p class="tm-msg muted">Wird geladen …</p>`;
  else if (!members.length) content = `${teamTeaserHTML()}<p class="tm-msg muted">Noch keine Zettel von Kollegen</p>`;
  else content = teamTab === 'woche' ? teamWeekHTML(members) : teamTeaserHTML() + teamTodayHTML(members);
  body.innerHTML = `
    <div class="seg tm-seg">${[
      ['heute', 'Heute'],
      ['woche', 'Woche'],
      ['pinnwand', 'Pinnwand'],
    ]
      .map(
        ([k, t]) =>
          `<button class="${teamTab === k ? 'on' : ''}" data-team="tab" data-tab="${k}">${t}${k === 'pinnwand' && teamTab !== k && teamUnread() ? '<i class="tm-dot"></i>' : ''}</button>`
      )
      .join('')}</div>
    ${teamData && teamData.offline ? `<p class="tm-msg muted">Offline${teamData.at ? ` – Stand ${teamAgo(teamData.at)}` : ''}</p>` : ''}
    ${content}
    <div class="center"><button class="link-btn tm-leave" data-team="leave">Team verlassen</button></div>`;
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

/** Alle verfügbaren Zettel eines Kollegen (laufender Monat), neueste zuerst */
function renderTeamPerson(id) {
  const m = teamFindMember(id);
  if (m === undefined) return;
  if (!m) {
    app.innerHTML = `${teamNav()}<p class="tm-msg muted">Nicht mehr verfügbar</p>`;
    return;
  }
  const list = [...(m.sheets || [])].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
  const total = list.reduce((t, s) => t + sheetTotal(s), 0);
  const now = new Date();
  const rows = list
    .map((s) => {
      const dots = [0, 1, 2, 3, 4]
        .map((i) => {
          const d = sheetIsActive(s, i) ? s.days[i] : null;
          const cls = !d || !teamDayHasContent({ d, i }) ? '' : d.status && !holidayWork(d) ? `st-${d.status}` : 'on';
          return `<i class="${cls}"></i>`;
        })
        .join('');
      return `<a class="list-row plain tm-wrow" href="#/team/${encodeURIComponent(m.member)}/${s.weekStart}">
        <span class="list-kw">KW ${isoWeek(parseDate(s.weekStart))}</span>
        <span class="list-main"><span class="list-title">${fmtDayMonth(sheetFirstDate(s))} – ${fmtDayMonth(sheetLastDate(s))}</span><span class="tm-dots">${dots}</span></span>
        <span class="list-hours">${fmtH(sheetTotal(s))}</span>
        <span class="tm-chev">${ICON.chevronRight}</span>
      </a>`;
    })
    .join('');
  app.innerHTML = `${teamNav()}
    <div class="tm-profile">${teamAvatar(m, 64)}<h1>${escapeHtml(m.name || '?')}</h1>
      <span class="muted">${MONTHS[now.getMonth()]} ${now.getFullYear()} · ${fmtH(total)} · ${teamAgo(m.updated)}</span></div>
    ${list.length ? `<div class="card tm-list">${rows}</div>` : `<p class="tm-msg muted">Noch keine Zettel</p>`}`;
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
  // Pinnwand: nur die Nachrichten neu, damit Eingabefeld und Tastatur bleiben
  const list = currentView === 'team' && teamTab === 'pinnwand' && document.getElementById('tm-posts');
  if (list) {
    list.innerHTML = teamPostsHTML();
    teamMarkSeen();
  } else if (currentView === 'team') renderTeamBody();
  const pm = location.hash.match(/^#\/team\/([^/]+)(?:\/(\d{4}-\d{2}-\d{2}))?$/);
  if (!pm) return;
  if (currentView === 'teamPerson') renderTeamPerson(decodeURIComponent(pm[1]));
  if (currentView === 'teamSheet') renderTeamSheet(decodeURIComponent(pm[1]), pm[2]);
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
    case 'tab':
      if (teamTab === el.dataset.tab) break;
      haptic();
      teamTab = el.dataset.tab;
      renderTeamBody();
      window.scrollTo(0, 0);
      break;
    case 'post':
      teamSendPost();
      break;
    case 'post-del':
      teamDeletePost(el.dataset.id);
      break;
    case 'toggle': {
      haptic();
      const id = el.dataset.member;
      if (!teamOpen.delete(id)) teamOpen.add(id);
      renderTeamBody();
      break;
    }
    case 'day':
      haptic();
      teamDay = parseDate(el.dataset.date);
      renderTeamBody();
      break;
    case 'week':
      haptic();
      teamWeek = addDays(teamWeek, 7 * Number(el.dataset.dir));
      renderTeamBody();
      break;
    case 'leave':
      leaveTeam();
      break;
  }
});
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
// Pinnwand offen und App im Vordergrund: alle 10 Sekunden nach neuen Nachrichten sehen (fast wie ein Chat)
setInterval(() => {
  if (team && currentView === 'team' && teamTab === 'pinnwand' && document.visibilityState === 'visible' && navigator.onLine) teamLoad();
}, 10000);
setTimeout(() => teamQueueUpload(0), 2000);
