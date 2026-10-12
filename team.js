// Std-Protokoll – Team: Kollegen sehen gegenseitig ihre Stundenzettel des laufenden Monats (nur lesen).
// Speicher: Cloudflare-Worker mit D1-Datenbank in der EU (cloudflare/team-worker.js). Wer den Team-Code kennt,
// lädt seine Zettel des laufenden Monats automatisch hoch und sieht die der anderen. Beim Monatswechsel
// löscht der Worker die alten Einträge.
//
// Eigener Speicher (nicht in der Sicherung): { code, member, token, sent, cache: { month, members, at } }

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
    name: settings.name.trim(),
    month: teamMonth(now),
    sheets: sheets
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

// ───────── Team-Seite: ein Tag, darunter alle Kollegen ─────────

/** Zuletzt geladene Einträge der Kollegen (null = noch nichts geladen) */
let teamData = null;
let teamLoading = false;
/** Gewählter Tag (Datum); ohne Wahl heute */
let teamDay = null;

/** Einträge der anderen nur in bekannter Form übernehmen (jeder mit dem Code kann dort schreiben) */
function teamClean(members) {
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  const str = (v, n) => String(v ?? '').slice(0, n);
  return (Array.isArray(members) ? members : []).map((m) => ({
    member: str(m.member, 64),
    name: str(m.name, 80),
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
    team.cache = { month: data.month, members: teamClean(data.members), at: Date.now() };
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
  if (currentView === 'team') renderTeamBody();
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

  const today = startOfDay(new Date());
  // Nur Tage des laufenden Monats; Wechsel des Monats setzt die Wahl zurück
  if (!teamDay || teamDay.getMonth() !== today.getMonth() || teamDay.getFullYear() !== today.getFullYear()) teamDay = today;
  const inMonth = (d) => d.getMonth() === today.getMonth() && d.getFullYear() === today.getFullYear();
  const mon = mondayOf(teamDay);
  const members = ((teamData && teamData.members) || []).filter((m) => m.member !== team.member);
  // Sa/So nur, wenn gewählt oder jemand etwas eingetragen hat
  const used = (i) =>
    members.some((m) => {
      const x = teamMemberDay(m, addDays(mon, i));
      return x && (x.d.status || (x.d.rows || []).some((r) => !rowIsEmpty(r)));
    });
  const days = [0, 1, 2, 3, 4, 5, 6].filter((i) => i < 5 || sameDay(addDays(mon, i), teamDay) || used(i));
  const bar = days
    .map((i) => {
      const d = addDays(mon, i);
      if (!inMonth(d)) return `<span class="db-day off"><span class="db-name">${WEEKDAYS_SHORT[i]}</span><span class="db-h">${d.getDate()}.</span></span>`;
      return `<button class="db-day${sameDay(d, teamDay) ? ' on' : ''}${sameDay(d, today) ? ' today' : ''}" data-team="day" data-date="${isoDate(d)}"><span class="db-name">${WEEKDAYS_SHORT[i]}</span><span class="db-h">${d.getDate()}.</span></button>`;
    })
    .join('');
  const canPrev = inMonth(addDays(mon, -1));
  const canNext = inMonth(addDays(mon, 7));
  const wd = (teamDay.getDay() + 6) % 7;

  let list;
  if (!teamData) list = `<p class="tm-msg muted">Wird geladen …</p>`;
  else if (!members.length) list = `<p class="tm-msg muted">Noch keine Zettel von Kollegen</p>`;
  else
    list = members
      .map(
        (m) => `<h2 class="section-title tm-name"><span>${escapeHtml(m.name || '?')}</span><span>${teamAgo(m.updated)}</span></h2>
        <div class="card tm-day">${teamDayHTML(teamMemberDay(m, teamDay))}</div>`
      )
      .join('');

  body.innerHTML = `
    <div class="tm-week">
      <button class="tm-arrow" data-team="week" data-dir="-1" ${canPrev ? '' : 'disabled'} aria-label="Woche zurück">${ICON.chevronLeft}</button>
      <span>KW ${isoWeek(teamDay)} · ${WEEKDAYS[wd]}, ${fmtDayMonth(teamDay)}</span>
      <button class="tm-arrow" data-team="week" data-dir="1" ${canNext ? '' : 'disabled'} aria-label="Woche vor">${ICON.chevronRight}</button>
    </div>
    <div class="daybar tm-bar">${bar}</div>
    ${teamData && teamData.offline ? `<p class="tm-msg muted">Offline${teamData.at ? ` – Stand ${teamAgo(teamData.at)}` : ''}</p>` : ''}
    ${list}
    <div class="center"><button class="link-btn tm-leave" data-team="leave">Team verlassen</button></div>`;
}

/** Nächster bzw. vorheriger Wochentag im laufenden Monat (gleicher Wochentag, sonst der erste/letzte des Monats) */
function teamMoveWeek(dir) {
  const today = new Date();
  let d = addDays(teamDay, 7 * dir);
  if (d.getMonth() !== today.getMonth()) d = dir > 0 ? new Date(today.getFullYear(), today.getMonth() + 1, 0) : new Date(today.getFullYear(), today.getMonth(), 1);
  teamDay = startOfDay(d);
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
    case 'day':
      haptic();
      teamDay = parseDate(el.dataset.date);
      renderTeamBody();
      break;
    case 'week':
      haptic();
      teamMoveWeek(Number(el.dataset.dir));
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
});

// Beim Öffnen der App und bei Rückkehr: hochladen, Team-Seite neu laden
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible' || !team) return;
  teamQueueUpload(500);
  if (currentView === 'team') teamLoad();
});
window.addEventListener('online', () => teamQueueUpload(500));
setTimeout(() => teamQueueUpload(0), 2000);
