'use strict';

// ───────────────────────── Datum & Formate ─────────────────────────

const WEEKDAYS = ['Montag', 'Dienstag', 'Mittwoch', 'Donnerstag', 'Freitag', 'Samstag', 'Sonntag'];
const WEEKDAYS_SHORT = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];

const pad = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const parseDate = (s) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d);
};
const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
const mondayOf = (d) => addDays(startOfDay(d), -((d.getDay() + 6) % 7));
const sameDay = (a, b) => isoDate(a) === isoDate(b);

/** 14.09.26 */
const fmtShort = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${String(d.getFullYear()).slice(2)}`;
/** 14.09. */
const fmtDayMonth = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
/** Minuten als Dezimalstunden: 90 → 1,50 */
const fmtDec = (minutes) => (minutes / 60).toFixed(2).replace('.', ',');
/** Stunden im PDF: dezimal, ohne Einheit („8,50“) */
const fmtHours = fmtDec;
/** Stunden in der App: dezimal mit Einheit („8,50 h“) */
const fmtH = (minutes) => `${fmtDec(minutes)} h`;
/** Minuten seit Mitternacht: 480 → 08:00 */
const fmtTime = (m) => `${pad(Math.floor(m / 60) % 24)}:${pad(m % 60)}`;

function isoWeek(date) {
  const t = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  t.setUTCDate(t.getUTCDate() + 3 - ((t.getUTCDay() + 6) % 7));
  const jan4 = new Date(Date.UTC(t.getUTCFullYear(), 0, 4));
  return 1 + Math.round(((t - jan4) / 86400000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
}

const uid = () =>
  globalThis.crypto && crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);

/** Vergleich: Groß-/Kleinschreibung und Art des Apostrophs egal („Bäcker's Eck“ = „Bäcker’s eck“) */
const sameKey = (s) => String(s ?? '').trim().toLowerCase().replace(/[’‘`´ʼ′]/g, "'");
/** Suche: zusätzlich ohne Apostrophe, Leerzeichen, Kommas, Bindestriche und Punkte („Bäckerseck“ findet „Bäcker's Eck“) */
const searchKey = (s) => sameKey(s).replace(/['\s,.\-–]/g, '');
/** Höchstlängen, damit der Text im PDF in drei Zeilen der kleineren Schriftstufe passt (ohne Zähler) */
const MAX_LEN = { site: 60, work: 100 };
/** Reisekosten: Reiseorte bzw. Tätigkeiten je Kasten höchstens zwei Zeilen im PDF */
const TRIP_MAX_LEN = 100;
const escapeHtml = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ───────────────────────── Datenmodell ─────────────────────────
// Zettel: { id, weekStart: 'YYYY-MM-DD' (Montag), year, month, name, days[7], sentAt, createdAt, updatedAt }
// Tag:    { pause: Minuten (null = noch nicht eingetragen), status?: 'krank'|'urlaub'|'feiertag'|'frei',
//           rows: [{ id, start, end, site, work, report?: Arbeitsschein-ID, typoOk?: { Feld: Text } („So lassen“) }],
//           credit?: Minuten der Tagesart (nur von Hand gesetzt, sonst 8 h bzw. Frei und Sa/So 0), manual?: true (Tagesart von Hand, siehe chooseStatusHold) }
//         (start/end: Minuten seit 00:00; bei gesetztem status zählen die Zeilen nicht, bleiben aber erhalten – außer am Feiertag:
//          dort kommt die Arbeit zu den 8 Stunden dazu)

const DAY_STATUS = {
  krank: 'Krankheitstag',
  urlaub: 'Urlaubstag',
  feiertag: 'Gesetzlicher Feiertag',
  frei: 'Frei',
};
const DAY_STATUS_SHORT = { krank: 'Krank', urlaub: 'Urlaub', feiertag: 'Feiertag', frei: 'Frei' };

const emptyRow = () => ({ id: uid(), start: null, end: null, site: '', work: '' });
const rowIsEmpty = (r) => r.start == null && r.end == null && !r.site && !r.work;
/** Ende als Minuten: 00:00 nach einem Beginn am Tag ist Mitternacht am Ende des Tages (24:00) */
const rowEnd = (r) => (r.end === 0 && r.start > 0 ? 1440 : r.end);
const rowMinutes = (r) => (r.start == null || r.end == null ? null : r.end >= r.start ? r.end - r.start : r.end + 1440 - r.start);
const dayWorked = (d) => d.rows.reduce((s, r) => s + (rowMinutes(r) || 0), 0);
/** Krank, Urlaub und Feiertag zählen 8 Stunden, Frei und jede Tagesart am Sa/So (i = Wochentag 0–6) zählen 0 */
const statusCredit = (status, i) => (status === 'frei' || i >= 5 ? 0 : Math.round(settings.hoursPerDay * 60));
/** An einem Feiertag kann trotzdem gearbeitet werden (z. B. Notdienst): die Stunden kommen zu den 8 gutgeschriebenen dazu */
const canWork = (d) => !d.status || d.status === 'feiertag';
const workedNet = (d) => Math.max(0, dayWorked(d) - (d.pause || 0));
/** Stunden der Tagesart an diesem Tag: von Hand gewählt (8 h oder 0) oder die Vorgabe */
const dayCredit = (d, i) => (d.credit != null ? d.credit : statusCredit(d.status, i));
const dayTotal = (d, i) => (d.status ? dayCredit(d, i) + (canWork(d) ? workedNet(d) : 0) : workedNet(d));
const dayHasTimes = (d) => d.rows.some((r) => r.start != null || r.end != null);
/** Am Tag wurde schon etwas eingetragen, aber noch keine Pause (nur neue Zettel haben pause: null), auch bei Arbeit am Feiertag */
const pauseMissing = (d) => canWork(d) && d.pause == null && d.rows.some((r) => !rowIsEmpty(r));
/** Am Tag wurde schon etwas eingetragen (Zeit, Baustelle, Art der Arbeit oder eine Pause) */
const dayStarted = (d) => canWork(d) && (d.pause > 0 || d.rows.some((r) => !rowIsEmpty(r)));
/** Feiertag, an dem zusätzlich gearbeitet wurde */
const holidayWork = (d) => d.status === 'feiertag' && dayStarted(d);
/** Zeilen, die zeitlich nicht zueinander passen: Beginn vor dem Beginn einer Zeile darüber – beide werden markiert */
function rowsOutOfOrder(d) {
  const bad = new Set();
  const timed = d.rows.filter((r) => r.start != null);
  for (let a = 0; a < timed.length; a++)
    for (let b = a + 1; b < timed.length; b++)
      if (timed[b].start < timed[a].start) bad.add(timed[a].id).add(timed[b].id);
  return bad;
}
/** Zeilen mit Lücke oder Überschneidung zur zeitlich nächsten Zeile – beide werden markiert */
function rowsGapOrOverlap(d) {
  const bad = new Set();
  const timed = d.rows.filter((r) => r.start != null && r.end != null && rowEnd(r) > r.start).sort((a, b) => a.start - b.start);
  for (let k = 1; k < timed.length; k++) {
    if (timed[k].start !== rowEnd(timed[k - 1])) bad.add(timed[k - 1].id).add(timed[k].id);
  }
  return bad;
}
/** Ende liegt vor dem Beginn (Ende 00:00 = Mitternacht zählt nicht dazu) */
const endBeforeStart = (r) => r.start != null && r.end != null && rowEnd(r) < r.start;
/** Beginn und Ende sind gleich (0 Stunden) */
const sameStartEnd = (r) => r.start != null && r.start === r.end;
/** Feld der Zeile fehlt, sobald am Tag etwas eingetragen ist */
const fieldMissing = (d, r, field) =>
  dayStarted(d) && (field === 'start' || field === 'end' ? r[field] == null : !String(r[field] || '').trim());
/** Tag hat irgendwo ein Warnzeichen (fehlende Angabe, Pause, Reihenfolge, Ende vor Beginn) */
const dayHasWarning = (d) =>
  canWork(d) &&
  (pauseMissing(d) || d.rows.some((r) => timeWarning(d, r) || fieldMissing(d, r, 'site') || fieldMissing(d, r, 'work')));
/** Leerer Werktag (Mo–Fr, kein Feiertag) in einem gesendeten Zettel – in offenen Zetteln sind leere Tage normal */
const emptySentWorkday = (s, i) =>
  !!s.sentAt && i < 5 && !s.days[i].status && !dayStarted(s.days[i]) && !holidayName(sheetDate(s, i));
/** Tagesart passt nicht zum Kalender (Mo–Fr): Feiertag an einem Tag ohne Feiertag, erkannter Feiertag mit anderer Tagesart */
const statusWarning = (s, i) => {
  const d = s.days[i];
  if (!sheetIsActive(s, i) || i >= 5 || d.manual) return '';
  const holiday = holidayName(sheetDate(s, i));
  if (d.status === 'feiertag') return holiday ? '' : 'kein gesetzlicher Feiertag';
  return holiday ? `${holiday} nicht als Feiertag eingetragen` : '';
};
const statusWarnHTML = (s, i) => (statusWarning(s, i) ? ` <span class="day-warn" aria-label="Tagesart prüfen">⚠️</span>` : '');
/** Warnzeichen für einen Tag des Zettels: unvollständige Angaben, leerer Werktag im gesendeten Zettel, Tagesart passt nicht */
const sheetDayWarning = (s, i) => dayHasWarning(s.days[i]) || emptySentWorkday(s, i) || !!statusWarning(s, i);
const sheetHasWarning = (s) => sheetActiveDays(s).some((i) => sheetDayWarning(s, i));
const timeWarning = (d, r) =>
  fieldMissing(d, r, 'start') || fieldMissing(d, r, 'end') || endBeforeStart(r) || sameStartEnd(r) || rowsOutOfOrder(d).has(r.id) || rowsGapOrOverlap(d).has(r.id);
/** Mindestanzahl Zeilen im PDF: Mo–Fr 5, Sa/So 1 */
const pdfMinRows = (i) => (i < 5 ? 5 : 1);

/** Neuer Zettel für die Woche des angetippten Tages; dessen Monat bestimmt den Zettel. */
function newSheet(anchor, name) {
  const a = startOfDay(anchor);
  return {
    id: uid(),
    weekStart: isoDate(mondayOf(a)),
    year: a.getFullYear(),
    month: a.getMonth() + 1,
    name,
    days: WEEKDAYS.map(() => ({ pause: null, rows: [emptyRow()] })),
    sentAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

const sheetDate = (s, i) => addDays(parseDate(s.weekStart), i);
const sheetIsActive = (s, i) => {
  const d = sheetDate(s, i);
  return d.getFullYear() === s.year && d.getMonth() + 1 === s.month;
};
/** Tage des Zettels im eigenen Monat – hängt nur von Woche und Monat ab, daher gemerkt (nicht verändern!) */
const activeDaysCache = new Map();
const sheetActiveDays = (s) => {
  const k = `${s.weekStart}|${s.year}|${s.month}`;
  let v = activeDaysCache.get(k);
  if (!v) activeDaysCache.set(k, (v = Object.freeze([0, 1, 2, 3, 4, 5, 6].filter((i) => sheetIsActive(s, i)))));
  return v;
};
const sheetFirstDate = (s) => sheetDate(s, sheetActiveDays(s)[0] ?? 0);
const sheetLastDate = (s) => sheetDate(s, sheetActiveDays(s).at(-1) ?? 6);
const sheetTitle = (s) => `Stundenzettel ${fmtShort(sheetFirstDate(s))} - ${fmtShort(sheetLastDate(s))}`;
const sheetTotal = (s) => sheetActiveDays(s).reduce((t, i) => t + dayTotal(s.days[i], i), 0);
const sheetOvertime = (s, targetHours) => Math.max(0, sheetTotal(s) - Math.round(targetHours * 60));
/** Soll des Zettels in Stunden: anteilig je Werktag Mo–Fr des Monats oder das volle Wochen-Soll */
const sheetTarget = (s) => (settings.target / 5) * sheetActiveDays(s).filter((i) => i < 5).length;
/** Woche und Monat, zu denen ein Tag gehört (wie newSheet), als Schlüssel „weekStart|Jahr|Monat“ */
const anchorKey = (anchor) => {
  const a = startOfDay(anchor);
  return `${isoDate(mondayOf(a))}|${a.getFullYear()}|${a.getMonth() + 1}`;
};

// ───────────────────────── Speicher ─────────────────────────

const STORE_KEY = 'stdprotokoll.sheets.v1';
const SETTINGS_KEY = 'stdprotokoll.settings.v1';
const DEFAULT_SETTINGS = {
  name: '',
  target: 40,
  hoursPerDay: 8,
  minuteStep: 30,
  state: 'NI',
  hiddenSuggestions: { site: [], work: [] },
  // Lohn (nur auf diesem iPhone): Stundenlohn, feste Zulage, Steuerklasse, Kirchensteuer, Kinder,
  // Zusatzbeitrag der Krankenkasse, Eigenbeitrag Betriebsrente (Entgeltumwandlung)
  wage: '',
  bonus: '',
  taxClass: '1',
  church: false,
  children: '0',
  kvExtra: '',
  otPct: '25',
  bav: '',
  vacationDays: 30, // Urlaubsanspruch im Jahr (Karte „Urlaub“ in der Übersicht)
  ovCards: null, // Inhalt der Karten in der Übersicht (karten.js), null = Vorgabe
  theme: 'auto', // Darstellung: auto (wie iPhone), light, dark
  encryptBackup: false, // Sicherungen mit Passwort verschlüsseln (Schlüssel nur auf diesem iPhone, nie in der Sicherung)
};

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

let sheets = readJson(STORE_KEY, []);
let settings = { ...DEFAULT_SETTINGS, ...readJson(SETTINGS_KEY, {}) };
settings.hiddenSuggestions = { site: [], work: [], ...settings.hiddenSuggestions };
delete settings.recipient; // frühere Einstellungen, werden nicht mehr verwendet
delete settings.pdfFrame;
delete settings.accountStart;
delete settings.dayBar;
// Fest vorgegeben (keine Einstellung mehr): 40 Stunden pro Woche, 8 Stunden pro Tag, Niedersachsen
settings.target = 40;
settings.hoursPerDay = 8;
settings.state = 'NI';
// Ebenfalls fest: Stunden in App und PDF dezimal; Überstunden immer, bei Teilwochen anteilig;
// Krank/Urlaub/Feiertag zählen 8 Stunden (Sa/So 0), Frei 0
delete settings.hourFormat;
delete settings.prorateTarget;
delete settings.credit;
delete settings.overtime;
settings.minuteStep = 30; // Zeitauswahl immer in 30-Minuten-Schritten
// Seit v93 keine Sicherung mehr in Google Drive (so gewünscht): Schalter und gemerkter Stand weg
if ('autoBackup' in settings) {
  delete settings.autoBackup;
  queueMicrotask(() => saveSettings());
}
try {
  localStorage.removeItem('stdprotokoll.drive.v1');
  localStorage.removeItem('stdprotokoll.guide-key');
} catch {}
// Seit v91: Ort und Unterschrift stehen in jeder Reisekostenabrechnung selbst, nicht mehr in den Einstellungen
// (so gewünscht; die nächste Sicherung enthält sie nicht mehr)
if ('place' in settings || 'signature' in settings) {
  delete settings.place;
  delete settings.signature;
  queueMicrotask(() => saveSettings());
}
// Sa/So: keine wählbare Tagesart mehr (nur automatisch eingetragene Feiertage).
// Erst speichern, wenn app.js ganz geladen ist: saveSheets braucht currentView und editorPending, die weiter unten stehen
// (sonst bricht der Start ab und die App bleibt leer, z. B. wenn ein Feiertag am Wochenende nachgetragen wird)
if (sheets.map(fixWeekend).some(Boolean)) queueMicrotask(() => saveSheets());

/** Urlaubs- und Krankheitstage je Jahr (nach Datum des Tages) */
function absenceStats() {
  const years = new Map();
  const today = startOfDay(new Date());
  for (const s of sheets) {
    s.days.forEach((d, i) => {
      const kind = absenceKind(s, i);
      // genommen: nur bis heute (geplanter Urlaub zählt erst an seinem Tag)
      if (!kind || sheetDate(s, i) > today) return;
      const y = sheetDate(s, i).getFullYear();
      if (!years.has(y)) years.set(y, { urlaub: 0, krank: 0 });
      years.get(y)[kind]++;
    });
  }
  return years;
}
/**
 * Urlaubs- bzw. Krankheitstag für alle Zählungen (Karten, Jahresseite, Lohnvergleich): von Hand gesetzt (3 s drücken)
 * zählt immer, sonst nur Mo–Fr ohne gesetzlichen Feiertag (ein Feiertag verbraucht keinen Urlaubstag). Sonst null.
 */
function absenceKind(s, i) {
  const d = s.days[i];
  if ((d.status !== 'urlaub' && d.status !== 'krank') || !sheetIsActive(s, i)) return null;
  return d.manual || (i < 5 && !holidayName(sheetDate(s, i))) ? d.status : null;
}

/**
 * Überstunden-Konto je Monat: Ist − Soll, Tag für Tag – nur Tage, an denen schon etwas eingetragen ist: mindestens
 * eine Zeile mit Anfangs- und Enduhrzeit oder Urlaub/Krank/Feiertag/Frei. Leere Tage (auch heute, solange noch nichts
 * eingetragen ist) und Wochen ohne Zettel kommen in der Rechnung nicht vor.
 * Soll: jeder Werktag Mo–Fr mit Wochen-Soll ÷ 5; Tage nach heute zählen noch nicht.
 * Ist: „Stunden Gesamt“ des Tages (inkl. gutgeschriebener Stunden für Urlaub, Krankheit, Feiertag).
 * Ergebnis: Map Jahr → Map Monat (1–12) → Saldo in Minuten; mit `worked` stattdessen das Ist (Stunden Gesamt)
 */
function overtimeAccount(worked = false) {
  return overtimeAccounts()[worked ? 'worked' : 'ot'];
}
/** Beide Konten in einem Durchgang: worked (gearbeitete Minuten) und ot (Saldo gegen das Soll), je Jahr → Monat */
function overtimeAccounts() {
  const worked = new Map();
  const ot = new Map();
  const dailySoll = Math.round((settings.target * 60) / 5);
  const today = startOfDay(new Date());
  const add = (acc, y, m, v) => {
    if (!acc.has(y)) acc.set(y, new Map());
    const months = acc.get(y);
    months.set(m, (months.get(m) || 0) + v);
  };
  for (const s of sheets) {
    s.days.forEach((d, i) => {
      const date = sheetDate(s, i);
      if (!sheetIsActive(s, i) || date > today) return;
      if (!d.status && !d.rows.some((r) => r.start != null && r.end != null)) return;
      const soll = i < 5 ? dailySoll : 0;
      const y = date.getFullYear();
      const m = date.getMonth() + 1;
      const total = dayTotal(d, i);
      add(worked, y, m, total);
      add(ot, y, m, total - soll);
    });
  }
  return { worked, ot };
}

const yearBalance = (months) => [...months.values()].reduce((a, b) => a + b, 0);

// ───────────────────────── Lohn ─────────────────────────

/** Zahl aus einem Eingabefeld („12,50“), leer = 0 */
const parseNum = (v) => {
  let t = String(v ?? '').replace(/\s/g, '').replace(/[−–—]/g, '-');
  // Minus hinten wie auf der Abrechnung („12,34-“)
  const neg = /^-/.test(t) || /\d-$/.test(t);
  t = t.replace(/-/g, '');
  // Mit Komma sind Punkte Tausendertrennung („1.234,56“)
  if (t.includes(',')) t = t.replace(/\./g, '').replace(',', '.');
  const n = parseFloat(t);
  return Number.isFinite(n) ? (neg ? -n : n) : 0;
};
const hasWage = () => parseNum(settings.wage) > 0;
/** Faktor für Überstunden: 1 + Zuschlag aus den Einstellungen (leer = 0 %) */
const otFactor = () => 1 + parseNum(settings.otPct) / 100;
/** Bezahlte Soll-Stunden eines Monats (Minuten): jeder Werktag Mo–Fr mit 8 Stunden, Feiertage eingeschlossen */
function monthSollMinutes(year, month) {
  let days = 0;
  for (const d = new Date(year, month - 1, 1); d.getMonth() === month - 1; d.setDate(d.getDate() + 1)) {
    if (d.getDay() >= 1 && d.getDay() <= 5) days++;
  }
  return days * Math.round(settings.hoursPerDay * 60);
}
/**
 * Lohn eines Monats: Soll-Stunden × Stundenlohn, Überstunden mit Zuschlag, feste Zulage; Minusstunden mindern
 * den Grundlohn. Für den laufenden Monat ist das die Prognose (restliche Tage wie Soll). null ohne Stundenlohn.
 */
function monthPay(year, month, otMin, minusMin = 0) {
  if (!hasWage()) return null;
  const wage = monthValue(year, month, 'rate', parseNum(settings.wage));
  // Jede Lohnart wie auf der Abrechnung einzeln auf Cent runden (cents)
  const base = cents(((monthSollMinutes(year, month) + Math.min(0, otMin) - minusMin) / 60) * wage);
  const ot = cents((Math.max(0, otMin) / 60) * wage * otFactor());
  // Monat mit Abrechnung: deren Betriebsrente und Zulage – eine spätere Änderung der Einstellungen gilt nicht rückwirkend
  const slip = payslips[payKey(year, month)];
  const bonus = slip && slip.zulage != null ? slip.zulage : parseNum(settings.bonus);
  const bav = slip && slip.bav != null ? slip.bav : parseNum(settings.bav);
  return nettoMonat(base + ot + bonus, lohnOpts(bav, year, month, undefined, slipTarif(year, month)));
}
/**
 * Wert eines Monats aus den eingelesenen Lohnabrechnungen (Stundenlohn „rate“, Zusatzbeitrag „kvZusatz“):
 * die Abrechnung des Monats, sonst die letzte davor; vor der ersten Abrechnung deren Wert. Monate nach der letzten
 * Abrechnung rechnen mit den Einstellungen (fallback) – so gilt eine Lohnerhöhung ab dort. Der Zusatzbeitrag ändert
 * sich zum Jahreswechsel, er kommt daher nur aus Abrechnungen desselben Jahres.
 */
function monthValue(year, month, key, fallback) {
  const list = Object.values(payslips)
    .filter((p) => p && p.year && p.month && p[key] > 0 && (key !== 'kvZusatz' || p.year === year))
    .sort((a, b) => a.year * 12 + a.month - (b.year * 12 + b.month));
  if (!list.length) return fallback;
  const ym = year * 12 + month;
  const last = list.at(-1);
  if (ym > last.year * 12 + last.month && key !== 'kvZusatz') return fallback;
  const before = list.filter((p) => p.year * 12 + p.month <= ym).at(-1);
  return (before || list[0])[key];
}
/** „1.234 €“ bzw. mit Cent „1.234,56 €“ */
const fmtMoney = (v, cents = false) =>
  `${v.toLocaleString('de-DE', { minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: cents ? 2 : 0 })} €`;

// ───────────────────────── Lohnabrechnungen ─────────────────────────
// Eingelesene Abrechnungen je Monat („2026-08“ → Werte aus parsePayslipText). Nur Zahlen, kein Foto, keine Namen.

const PAYSLIP_KEY = 'stdprotokoll.payslips.v1';
let payslips = readJson(PAYSLIP_KEY, {});
function savePayslips() {
  try {
    localStorage.setItem(PAYSLIP_KEY, JSON.stringify(payslips));
  } catch (e) {
    window.fehlerMelden?.(e, 'speichern');
    toast('Speichern fehlgeschlagen!');
  }
}
const payKey = (year, month) => `${year}-${pad(month)}`;
// Früher eingelesene Abrechnungen: falsch gelesene Summen einmal nachträglich aus den übrigen Werten ergänzen (danach
// nie wieder – ein von Hand geleertes Feld bliebe sonst nicht leer)
{
  const before = JSON.stringify(payslips);
  Object.values(payslips).forEach((p) => {
    if (!p || !p.pay) return;
    if (!p.repaired) repairPayslip(p);
    p.repaired = true;
    // vor v109 eingelesen: Überstunden-Faktor aus den Einstellungen (für die Prüfung „Stunden × Stundenlohn“)
    if (p.otFactor == null) p.otFactor = otFactor();
  });
  if (JSON.stringify(payslips) !== before) savePayslips();
}
const HOUR_KINDS = [
  ['arbeit', 'Arbeitsstunden'],
  ['ueber', 'Überstunden'],
  ['urlaub', 'Urlaub'],
  ['krank', 'Krankheit'],
  ['feiertag', 'Feiertage'],
];
/** Auf Cent runden (kaufmännisch, ohne Gleitkomma-Fehler) – wie beim Einlesen */
const cents = psR2;
/** Angaben für die Netto-Rechnung eines Monats (Steuertarif des Jahres, Zusatzbeitrag wie auf der Abrechnung) */
/** PV-Zuschlag für Kinderlose: erst nach dem Monat, in dem man 23 wird (§ 55 SGB XI) – Geburtsdatum aus dem
 *  Berichtsheft; ohne Geburtsdatum immer */
function pvKinderlosZuschlag(year, month) {
  const g = typeof bh !== 'undefined' && bh.profile?.geboren;
  if (!g) return true;
  const b = parseDate(g);
  // 23. Lebensjahr vollendet am Tag vor dem 23. Geburtstag
  const done = addDays(new Date(b.getFullYear() + 23, b.getMonth(), b.getDate()), -1);
  const now = new Date();
  const ym = (year || now.getFullYear()) * 12 + (year ? month : now.getMonth() + 1);
  return ym > done.getFullYear() * 12 + done.getMonth() + 1;
}
/** Zusatzbeitrag aus den Einstellungen; leer = undefined (dann der Durchschnitt des Jahres) */
const kvExtraSetting = () => (String(settings.kvExtra ?? '').trim() === '' ? undefined : parseNum(settings.kvExtra));
const lohnOpts = (bav, year, month, zusatz, tarif) => ({
  // Steuer- und beitragsfreie Bezüge (z. B. Inflationsprämie) wie auf der Abrechnung des Monats
  stFrei: (year && payslips[payKey(year, month)]?.stFrei) || 0,
  svFrei: (year && payslips[payKey(year, month)]?.svFrei) || 0,
  // Weihnachts-/Urlaubsgeld (sonstiger Bezug) wie auf der Abrechnung des Monats
  stSonst: (year && payslips[payKey(year, month)]?.stSonst) || 0,
  pvZuschlag: pvKinderlosZuschlag(year, month),
  klasse: parseNum(settings.taxClass) || 1,
  kirche: !!settings.church,
  kinder: parseNum(settings.children),
  // leer = durchschnittlicher Zusatzbeitrag des Jahres (lohn.js)
  zusatz: zusatz ?? (year ? monthValue(year, month, 'kvZusatz', kvExtraSetting()) : kvExtraSetting()),
  bav,
  // Steuertarif: von Hand auf der Abrechnung gewählt (z. B. Nachberechnung fürs Vorjahr); Sozialabgaben nach dem Jahr
  year,
  tarif: tarif || undefined,
  month,
});
/** Von Hand gewählter Steuertarif der Abrechnung eines Monats, sonst null */
const slipTarif = (year, month) => payslips[payKey(year, month)]?.tarif || null;
/** Steuertarif eines Jahres fehlt in der App: Hinweistext, sonst null */
function tarifWarning(year) {
  if (!year || lohnJahrBekannt(year)) return null;
  const used = year < LOHN_ERSTES ? LOHN_ERSTES : LOHN_LETZTES;
  return {
    title: `Steuertarif ${year} unbekannt`,
    text: `Die App kennt die Steuer- und Beitragswerte für ${year} ${year > used ? 'noch nicht' : 'nicht'} und rechnet mit denen von ${used}. Die Werte der Abrechnung selbst sind davon nicht betroffen, aber Lohnsteuer und Netto im Vergleich können abweichen.`,
  };
}
const tarifWarningHTML = (year) => {
  const w = tarifWarning(year);
  return w ? `<div class="card ps-warncard"><b>⚠️ ${w.title}</b><p>${w.text}</p></div>` : '';
};
/** Hinweis auf der Abrechnungsseite, wenn im Monat Werktage ohne Eintrag sind */
const gapWarningHTML = (p) => {
  const n = monthGaps(p.year, p.month).length;
  return n
    ? `<div class="card ps-warncard"><b>⚠️ Monat unvollständig</b><p>${n} ${n === 1 ? 'Werktag hat' : 'Werktage haben'} noch keinen Eintrag. Der Vergleich mit der Abrechnung ist erst aussagekräftig, wenn alle Tage eingetragen sind.</p></div>`
    : '';
};

/**
 * Stunden eines Monats aus den Zetteln, aufgeteilt wie auf der Lohnabrechnung (in Stunden):
 * Feiertage nach Kalender (Mo–Fr), Urlaub und Krankheit aus den Zetteln, Überstunden wie in der Übersicht,
 * Arbeitsstunden = Soll − Feiertage − Urlaub − Krankheit − Werktage ohne Eintrag (Minusstunden ziehen ab):
 * es zählt nur, was eingetragen ist. missing: Werktage ohne Eintrag (wie „Monat unvollständig“).
 * planMinus: Minuten, die künftige Tage mit Tagesart unter dem Soll bleiben (geplant „Frei“) – für die Hochrechnung.
 */
function monthHoursSplit(year, month) {
  const byDate = new Map();
  for (const s of sheets) for (const i of sheetActiveDays(s)) byDate.set(isoDate(sheetDate(s, i)), s.days[i]);
  const h = { arbeit: 0, ueber: 0, urlaub: 0, krank: 0, feiertag: 0 };
  const missing = monthGaps(year, month);
  const day = settings.hoursPerDay;
  const today = startOfDay(new Date());
  let weekendCredit = 0; // von Hand gesetzte Tagesart an Sa/So: steht im Überstunden-Konto schon als Plus
  let planMinus = 0;
  for (const d = new Date(year, month - 1, 1); d.getMonth() === month - 1; d.setDate(d.getDate() + 1)) {
    const entry = byDate.get(isoDate(d));
    const wd = (d.getDay() + 6) % 7;
    if (entry?.status && d >= today && wd < 5 && !holidayName(d)) planMinus += Math.max(0, day * 60 - dayCredit(entry, wd));
    // von Hand gesetzt (3 s drücken): zählt, was eingetragen ist – auch an Sa/So und an Feiertagen
    if (entry && entry.manual) {
      if (['urlaub', 'krank', 'feiertag'].includes(entry.status)) {
        h[entry.status] += dayCredit(entry, wd) / 60;
        if (wd >= 5 && d <= today) weekendCredit += dayCredit(entry, wd) / 60;
      }
      continue;
    }
    if (wd >= 5) continue;
    if (holidayName(d)) h.feiertag += day;
    else if (!entry) continue;
    else if (entry.status === 'urlaub') h.urlaub += dayCredit(entry, wd) / 60;
    else if (entry.status === 'krank') h.krank += dayCredit(entry, wd) / 60;
  }
  // Tagesart von Hand an Sa/So zählt nur einmal: als ihre Art, nicht zusätzlich als Überstunden
  const ot = ((overtimeAccount().get(year) || new Map()).get(month) || 0) / 60 - weekendCredit;
  h.ueber = Math.max(0, ot);
  h.arbeit = monthSollMinutes(year, month) / 60 - h.feiertag - h.urlaub - h.krank - missing.length * day + Math.min(0, ot);
  return { hours: h, missing, planMinus };
}

/** Lohn mit den Stunden der Abrechnung, nach der Rechnung der App (jede Lohnart auf Cent gerundet) */
function payWithSlipHours(p) {
  const rate = p.rate || monthValue(p.year, p.month, 'rate', parseNum(settings.wage));
  const h = p.hours;
  // Je gelesener Zeile mit ihrem Prozentsatz (Überstunden 25 % und 50 %); ältere Abrechnungen je Art
  const brutto = p.lines?.length
    ? p.lines.reduce((t, x) => t + cents(x.hours * rate * x.f), 0) + (p.zulage || 0)
    : cents(h.arbeit * rate) + cents(h.urlaub * rate) + cents(h.feiertag * rate) + cents(h.krank * rate) +
      cents((h.sonst || 0) * rate) + cents(h.ueber * rate * otFactor()) + (p.zulage || 0);
  return nettoMonat(cents(brutto), lohnOpts(p.bav || 0, p.year, p.month, p.kvZusatz, p.tarif));
}

/** Vergleich einer Abrechnung mit den Zetteln und der Lohnrechnung der App */
function payslipCompare(p) {
  const { hours, missing } = monthHoursSplit(p.year, p.month);
  // Unterschiede immer aus Sicht der Abrechnung: −3 h = auf der Abrechnung 3 Stunden weniger als auf den Zetteln
  const hourDiff = Object.fromEntries(HOUR_KINDS.map(([k]) => [k, Math.round(((p.hours[k] || 0) - hours[k]) * 100) / 100]));
  const otMin = (overtimeAccount().get(p.year) || new Map()).get(p.month) || 0;
  // Lohn nur für eingetragene Tage: Werktage ohne Eintrag zählen nicht
  const app = monthPay(p.year, p.month, otMin, missing.length * settings.hoursPerDay * 60);
  // Netto inkl. Abschlag, ohne Betriebsrente; ohne gelesenes Netto kein Vergleich (statt 0 €)
  const slipNet = p.netto == null ? null : cents(p.netto - (p.bav || 0));
  const withSlip = p.rate || monthValue(p.year, p.month, 'rate', parseNum(settings.wage)) ? payWithSlipHours(p) : null;
  // Bezahlte Grundstunden (ohne Überstunden) gleich, nur anders verbucht – z. B. Urlaub als Stundenlohn abgerechnet
  const baseDiff = Math.round(['arbeit', 'urlaub', 'krank', 'feiertag'].reduce((a, k) => a + hourDiff[k], 0) * 100) / 100;
  const shifted = Math.abs(baseDiff) < 0.01 && ['arbeit', 'urlaub', 'krank', 'feiertag'].some((k) => Math.abs(hourDiff[k]) >= 0.01);
  return {
    hours,
    missing,
    hourDiff,
    shifted,
    hoursOk: Math.abs(baseDiff) < 0.01 && Math.abs(hourDiff.ueber) < 0.01,
    app,
    slipNet,
    withSlip,
    netDiff: app && slipNet != null ? cents(slipNet - app.netto) : null,
    calcDiff: withSlip && slipNet != null ? cents(withSlip.netto - slipNet) : null,
  };
}

/** „+3,00 h“, „−8,00 h“, „0,00 h“ */
const fmtHDiff = (h) => (Math.abs(h) < 0.005 ? '0,00 h' : `${h > 0 ? '+' : '−'}${fmtDec(Math.abs(h) * 60)} h`);
const fmtEuroDiff = (v) => (Math.abs(v) < 0.005 ? '0,00 €' : `${v > 0 ? '+' : '−'}${fmtMoney(Math.abs(v), true)}`);

/** Zeile einer Vergleichstabelle: Bezeichnung | Zettel/App | Abrechnung | Unterschied (+ grün, − rot, 0 grau) */
function psRow(label, a, b, diff, cls = '', neutral = false) {
  const tone = neutral ? 'ok' : diff.startsWith('+') ? 'plus' : diff.startsWith('−') ? 'minus' : diff === '' || diff === '–' ? '' : 'ok';
  return `<div class="ps-row ${cls}"><span>${label}</span><span class="ov-n">${a}</span><span class="ov-n">${b}</span><b class="ov-n ${tone}">${diff}</b></div>`;
}

/**
 * Vergleichstabellen: passt ein Betrag nicht in seine Spalte (z. B. Jahressummen wie 12.345,67 €), Tabelle eine bzw.
 * zwei Stufen kleiner setzen. Gemessen wird die Textbreite selbst – rechtsbündige Spalten laufen nach links über,
 * das zeigt scrollWidth nicht an.
 */
function fitPsTables() {
  const tooWide = (x) => {
    const r = document.createRange();
    r.selectNodeContents(x);
    const cs = getComputedStyle(x);
    return r.getBoundingClientRect().width > x.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight) - 2;
  };
  for (const t of document.querySelectorAll('.ps-table')) {
    t.classList.remove('tight', 'tighter');
    if ([...t.querySelectorAll('.ov-n')].some(tooWide)) t.classList.add('tight');
    if ([...t.querySelectorAll('.ov-n')].some(tooWide)) t.classList.add('tighter');
  }
}

function payslipCompareHTML(p) {
  const c = payslipCompare(p);
  const hRows = HOUR_KINDS.map(([k, label]) => {
    const d = c.hourDiff[k];
    return psRow(label, fmtH(c.hours[k] * 60), fmtH((p.hours[k] || 0) * 60), fmtHDiff(d));
  }).join('');
  const sum = (o) => HOUR_KINDS.reduce((a, [k]) => a + (o[k] || 0), 0);
  const sumDiff = Math.round((sum(p.hours) - sum(c.hours)) * 100) / 100;
  const money = (label, appV, slipV) =>
    appV == null || slipV == null
      ? psRow(label, appV == null ? '–' : fmtMoney(appV, true), slipV == null ? '–' : fmtMoney(slipV, true), appV == null ? '–' : '')
      : psRow(label, fmtMoney(appV, true), fmtMoney(slipV, true), fmtEuroDiff(cents(slipV - appV)), '', Math.abs(appV - slipV) < 0.05);
  // Prüfung der Lohnrechnung: mit den Stunden der Abrechnung muss die App auf dasselbe Netto kommen
  const check =
    c.calcDiff == null
      ? ''
      : Math.abs(c.calcDiff) < 0.05
      ? `<p class="ps-verdict ok">${ICON.check} Mit den Stunden der Abrechnung rechnet die App dasselbe Netto.</p>`
      : `<p class="ps-verdict diff">Mit den Stunden der Abrechnung rechnet die App ${fmtEuroDiff(c.calcDiff)} Netto anders.</p>`;
  const a = c.app;
  // Unvollständiger Monat: Lohn aus den Zetteln wäre nur eine halbe Rechnung (z. B. nur die Zulage) – „–“ statt Zahlen
  const gap = c.missing.length > 0;
  return `
    <div class="card ps-table">
      <div class="ps-row ov-head"><span>Stunden</span><span class="ov-n">Zettel</span><span class="ov-n">Abrechnung</span><span class="ov-n">Unterschied</span></div>
      ${hRows}
      ${psRow('Gesamt', fmtH(sum(c.hours) * 60), fmtH(sum(p.hours) * 60), fmtHDiff(sumDiff), 'ov-sum')}
    </div>
    <div class="card ps-table">
      <div class="ps-row ov-head"><span>Lohn</span><span class="ov-n">Zettel</span><span class="ov-n">Abrechnung</span><span class="ov-n">Unterschied</span></div>
      ${a ? money('Brutto', gap ? null : a.brutto, p.brutto) + money('Abgaben', gap ? null : cents(a.lohnsteuer + a.soli + a.kirchensteuer + a.kv + a.rv + a.av + a.pv), p.steuer == null || p.sv == null ? null : cents(p.steuer + p.sv)) + money('Netto', gap ? null : a.netto, c.slipNet) : '<div class="ps-row"><span class="muted">Stundenlohn in den Einstellungen eintragen</span></div>'}
    </div>
    ${check}`;
}

/** Eingabefeld für einen Wert der Abrechnung (Zahl mit Komma) */
function psField(label, path, value, unit, signed = false) {
  const v = value == null ? '' : String(Math.round(value * 100) / 100).replace('.', ',');
  // Mit Vorzeichen: Zahlentastatur ohne Minus reicht nicht
  return `<label class="field"><span>${label}</span><input data-ps="${path}" inputmode="${signed ? 'text' : 'decimal'}" value="${v}" placeholder="–" enterkeyhint="done"><span class="unit">${unit}</span></label>`;
}

function renderPayslip(key) {
  const p = payslips[key];
  if (!p) {
    const [y, m] = key.split('-').map(Number);
    if (y > 2000 && m >= 1 && m <= 12) renderMonthNoSlip(y, m);
    else location.replace('#/uebersicht');
    return;
  }
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title">${MONTHS[p.month - 1]} ${p.year}</h1>
    <p class="ps-sub">Lohnabrechnung im Vergleich</p>
    ${gapWarningHTML(p)}${tarifWarningHTML(p.tarif || p.year)}
    <div id="ps-compare">${payslipCompareHTML(p)}</div>

    <h2 class="section-title">Werte der Abrechnung</h2>
    <div class="card form">
      <label class="field"><span>Monat</span><select data-ps="month">${MONTHS.map((m, i) => `<option value="${i + 1}" ${p.month === i + 1 ? 'selected' : ''}>${m}</option>`).join('')}</select></label>
      ${psField('Jahr', 'year', p.year, '')}
      <label class="field"><span>Steuertarif</span><select data-ps="tarif">${[...new Set([p.year, ...Object.keys(LOHN_JAHRE).map(Number)])]
        .sort((x, y) => y - x)
        .map((y) =>
          y === p.year
            ? `<option value="" ${p.tarif ? '' : 'selected'}>${y} (wie Jahr)</option>`
            : `<option value="${y}" ${p.tarif === y ? 'selected' : ''}>${y}</option>`
        )
        .join('')}</select></label>
      ${psField('Stundenlohn', 'rate', p.rate, '€')}
      ${HOUR_KINDS.map(([k, label]) => psField(k === 'krank' ? 'Krankheit (Entgeltfortzahlung)' : label, `hours.${k}`, p.hours[k], 'h')).join('')}
      ${psField('Zulagen', 'zulage', p.zulage, '€')}
      ${psField('Gesamt-Brutto', 'brutto', p.brutto, '€')}
      ${psField('Steuern', 'steuer', p.steuer, '€')}
      ${psField('Sozialabgaben', 'sv', p.sv, '€')}
      ${psField('Netto-Verdienst', 'netto', p.netto, '€')}
      ${psField('Abschlag (bereits erhalten)', 'abschlag', p.abschlag, '€')}
      ${psField('Betriebsrente', 'bav', p.bav, '€')}
      ${psField('Weitere Netto-Be-/Abzüge (+/−)', 'nettoSonst', p.nettoSonst || 0, '€', true)}
      ${psField('Auszahlung', 'auszahlung', p.auszahlung, '€')}
      ${psField('Zusatzbeitrag Krankenkasse', 'kvZusatz', p.kvZusatz, '%')}
      ${psField('Gesamt-Brutto im Jahr', 'ytd', p.ytd, '€')}
    </div>
    <ul class="ps-checks" id="ps-checks">${psChecksHTML(p)}</ul>
    <button class="list-btn destructive card ps-delete" data-act="payslip-delete" data-key="${key}">Lohnabrechnung löschen</button>`;
  // Nicht gelesen, sondern ergänzt: orange (nur Werte, die „Berechnet statt gelesen“ nennt)
  app.querySelectorAll('input[data-ps]').forEach((i) => PS_FIELD_NAMES[i.dataset.ps] && psGuess(p, i.dataset.ps) && i.closest('.field').classList.add('ps-guess'));
  fitPsTables();
}

/** Monat ohne Lohnabrechnung: Stunden und Lohn laut Zetteln, Spalte „Abrechnung“ leer, dazu Einlesen */
function renderMonthNoSlip(year, month) {
  const now = new Date();
  const current = year === now.getFullYear() && month === now.getMonth() + 1;
  const { hours, missing, planMinus } = monthHoursSplit(year, month);
  // Wie in der Übersicht: der laufende Monat gilt nie als unvollständig, unvollständige Monate rechnen keinen Lohn
  const gap = !current && missing.length > 0;
  const otMin = (overtimeAccount().get(year) || new Map()).get(month) || 0;
  // Hochrechnung: geplante Tage unter dem Soll (z. B. „Frei“) ziehen ab
  const a = gap ? null : monthPay(year, month, otMin, missing.length * settings.hoursPerDay * 60 + planMinus);
  const sum = HOUR_KINDS.reduce((t, [k]) => t + (hours[k] || 0), 0);
  const money = (label, v) => psRow(label, v == null ? '–' : fmtMoney(v, true), '–', '');
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title">${MONTHS[month - 1]} ${year}</h1>
    <p class="ps-sub">Noch keine Lohnabrechnung</p>
    ${
      current
        ? '<div class="card ps-warncard info"><b>ℹ️ Laufender Monat</b><p>Stunden und Lohn sind bis zum Monatsende hochgerechnet: Werktage ab heute ohne Eintrag zählen mit je 8 Std., Überstunden nur aus eingetragenen Tagen.</p></div>'
        : gapWarningHTML({ year, month })
    }
    <div class="card ps-table">
      <div class="ps-row ov-head"><span>Stunden</span><span class="ov-n">Zettel</span><span class="ov-n">Abrechnung</span><span class="ov-n">Unterschied</span></div>
      ${HOUR_KINDS.map(([k, label]) => psRow(label, fmtH((hours[k] || 0) * 60), '–', '')).join('')}
      ${psRow('Gesamt', fmtH(sum * 60), '–', '', 'ov-sum')}
    </div>
    <div class="card ps-table">
      <div class="ps-row ov-head"><span>Lohn</span><span class="ov-n">Zettel</span><span class="ov-n">Abrechnung</span><span class="ov-n">Unterschied</span></div>
      ${
        hasWage()
          ? money('Brutto', a && a.brutto) +
            money('Abgaben', a && cents(a.lohnsteuer + a.soli + a.kirchensteuer + a.kv + a.rv + a.av + a.pv)) +
            money('Netto', a && a.netto)
          : '<div class="ps-row"><span class="muted">Stundenlohn in den Einstellungen eintragen</span></div>'
      }
    </div>
    <div class="card list ps-import">
      <label class="list-btn">Lohnabrechnung einlesen …<input type="file" accept="image/*" data-act-change="payslip-import" hidden></label>
    </div>`;
  fitPsTables();
}

/** Jahresübersicht: Jahr nach Stundenzetteln (Stunden, Tage, Lohn) und alle Abrechnungen zusammen im Vergleich */
function renderYear(year) {
  const now = new Date();
  const acc = overtimeAccounts();
  const worked = acc.worked.get(year) || new Map();
  const months = acc.ot.get(year) || new Map();
  const st = absenceStats().get(year) || { urlaub: 0, krank: 0 };
  const isCurrent = (m) => year === now.getFullYear() && m === now.getMonth() + 1;
  // Monate wie in der Übersicht: ab Januar bis zum letzten abgeschlossenen (ohne den laufenden)
  const used = [...Array(12).keys()].map((i) => i + 1).filter((m) => worked.has(m) || payslips[payKey(year, m)]);
  const lastDone = year < now.getFullYear() ? 12 : year === now.getFullYear() ? now.getMonth() : 0;
  const range = used.length ? [...Array(12).keys()].map((i) => i + 1).filter((m) => m <= lastDone) : [];
  const missing = range.filter((m) => !worked.has(m));
  const partial = range.filter((m) => worked.has(m) && monthGaps(year, m).length);
  const noSlip = range.filter((m) => !payslips[payKey(year, m)]);
  // Vollständige Monate: nur dort rechnet die App einen Lohn, nur dort wird verglichen
  const complete = range.filter((m) => worked.has(m) && !monthGaps(year, m).length);
  const ot = yearBalance(countedOvertime(year, months));
  const pays = complete.map((m) => monthPay(year, m, months.get(m) || 0)).filter(Boolean);
  const total = (list, f) => cents(list.reduce((t, x) => t + f(x), 0));
  const abg = (a) => a.lohnsteuer + a.soli + a.kirchensteuer + a.kv + a.rv + a.av + a.pv;
  const line = (label, v) => `<div class="yr-row"><span>${label}</span><b>${v}</b></div>`;
  // Abrechnungen vollständiger Monate zusammen (wie der Satz unter „Gesamt“ in der Übersicht)
  const slips = complete.map((m) => payslips[payKey(year, m)]).filter(Boolean);
  const cs = slips.map((p) => ({ p, c: payslipCompare(p) }));
  const hz = (k) => cs.reduce((t, { c }) => t + (c.hours[k] || 0), 0);
  const ha = (k) => cs.reduce((t, { p }) => t + (p.hours[k] || 0), 0);
  const hRow = (label, z, a, cls = '') => psRow(label, fmtH(z * 60), fmtH(a * 60), fmtHDiff(Math.round((a - z) * 100) / 100), cls);
  // Jahressummen in ganzen Euro – mit Cent passen fünfstellige Beträge nur in sehr kleiner Schrift in die Spalten
  const euroDiff = (d) => (Math.abs(d) < 0.5 ? '0 €' : `${d > 0 ? '+' : '−'}${fmtMoney(Math.abs(d))}`);
  const money = (label, z, a) =>
    psRow(label, z == null ? '–' : fmtMoney(z), a == null ? '–' : fmtMoney(a), z == null || a == null ? '–' : euroDiff(cents(a - z)), '', z != null && a != null && Math.abs(a - z) < 0.5);
  const withApp = cs.every(({ c }) => c.app);
  const sumKinds = (f) => HOUR_KINDS.reduce((t, [k]) => t + f(k), 0);
  const compare = cs.length
    ? `<h2 class="section-title"><span>Monate in diesem Vergleich:</span> ${slips.map((p) => `<span>${MONTHS[p.month - 1].slice(0, 3)}</span>`).join(', ')}</h2>
    <div class="card ps-table">
      <div class="ps-row ov-head"><span>Stunden</span><span class="ov-n">Zettel</span><span class="ov-n">Abrechnung</span><span class="ov-n">Unterschied</span></div>
      ${HOUR_KINDS.map(([k, label]) => hRow(label, hz(k), ha(k))).join('')}
      ${hRow('Gesamt', sumKinds(hz), sumKinds(ha), 'ov-sum')}
    </div>
    <div class="card ps-table">
      <div class="ps-row ov-head"><span>Lohn</span><span class="ov-n">Zettel</span><span class="ov-n">Abrechnung</span><span class="ov-n">Unterschied</span></div>
      ${
        withApp
          ? money('Brutto', total(cs, ({ c }) => c.app.brutto), cs.every(({ p }) => p.brutto != null) ? total(cs, ({ p }) => p.brutto) : null) +
            money('Abgaben', total(cs, ({ c }) => abg(c.app)), cs.every(({ p }) => p.steuer != null && p.sv != null) ? total(cs, ({ p }) => p.steuer + p.sv) : null) +
            money('Netto', total(cs, ({ c }) => c.app.netto), cs.every(({ c }) => c.slipNet != null) ? total(cs, ({ c }) => c.slipNet) : null)
          : '<div class="ps-row"><span class="muted">Stundenlohn in den Einstellungen eintragen</span></div>'
      }
    </div>`
    : '';
  // Hinweis oben: unvollständige Monate, Monate ganz ohne Zettel, Monate ohne Abrechnung – in jeder Kombination
  const names = (list) => {
    const n = list.map((m) => MONTHS[m - 1]);
    return n.length > 1 ? `${n.slice(0, -1).join(', ')} und ${n.at(-1)}` : n[0];
  };
  // Erst was fehlt (je Art eine Zeile), dann in einem eigenen Absatz, was daraus folgt
  const facts = [
    partial.length ? `Unvollständig: ${names(partial)}` : '',
    missing.length ? `Ohne Stundenzettel: ${names(missing)}` : '',
    noSlip.length ? `Ohne Lohnabrechnung: ${names(noSlip)}` : '',
  ].filter(Boolean);
  const effects = [
    'Der Vergleich zählt nur vollständige Monate mit Stundenzetteln und Lohnabrechnung.',
    partial.length || missing.length ? 'Unter „Nach Stundenzetteln“ zählen Überstunden und Lohn nur vollständige Monate.' : '',
  ].filter(Boolean);
  const warn = facts.length
    ? `<div class="card ps-warncard"><b>⚠️ ${partial.length || missing.length ? 'Jahr unvollständig' : 'Abrechnungen fehlen'}</b><p>${facts.join('<br>')}</p><p>${effects.join(' ')}</p></div>`
    : '';
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title">${year}</h1>
    <p class="ps-sub">Jahresübersicht</p>
    ${warn}${hasWage() ? tarifWarningHTML(year) : ''}${compare}
    <h2 class="section-title">Nach Stundenzetteln</h2>
    <div class="card yr-card">
      ${line('Std. Gesamt', fmtH(yearBalance(worked)))}
      ${line('davon Überstunden', `<span class="${balanceClass(ot)}">${fmtSigned(ot)}</span>`)}
      ${line('Tage Urlaub genommen', fmtNum(st.urlaub))}
      ${line('Krankheitstage', fmtNum(st.krank))}
      ${
        pays.length
          ? line('Brutto', fmtMoney(total(pays, (a) => a.brutto), true)) +
            line('Steuern', fmtMoney(total(pays, (a) => a.lohnsteuer + a.soli + a.kirchensteuer), true)) +
            line('Sozialabgaben', fmtMoney(total(pays, (a) => a.kv + a.rv + a.av + a.pv), true)) +
            line('Netto', fmtMoney(total(pays, (a) => a.netto), true))
          : ''
      }
    </div>`;
  fitPsTables();
}

/** Wert aus dem Eingabefeld übernehmen und den Vergleich neu zeigen (die Felder selbst bleiben stehen) */
function updatePayslipField(input) {
  const key = location.hash.replace('#/lohn/', '');
  const p = payslips[key];
  if (!p) return;
  const path = input.dataset.ps;
  const v = path === 'month' ? Number(input.value) : input.value.trim() === '' ? null : parseNum(input.value);
  if (path === 'tarif') {
    // Steuertarif: Warnkarte und Vergleich hängen davon ab – Seite neu zeigen
    // Tarif des eigenen Jahres ist dasselbe wie „wie Jahr“
    p.tarif = v && v !== p.year ? v : null;
    savePayslips();
    renderPayslip(key);
    return;
  }
  if (path === 'month' || path === 'year') {
    // Anderer Monat: unter dem neuen Schlüssel speichern – eine vorhandene Abrechnung dort nur nach Rückfrage ersetzen
    const year = path === 'year' ? v : p.year;
    const month = path === 'month' ? v : p.month;
    const undo = () => (input.value = path === 'year' ? p.year : p.month);
    if (!(year > 2000 && year < 2100) || !Number.isInteger(year)) return undo();
    const nk = payKey(year, month);
    if (nk === key) return;
    const move = () => {
      p.year = year;
      p.month = month;
      if (p.tarif === year) p.tarif = null;
      if (p.fixed) p.fixed = p.fixed.filter((k) => k !== path);
      delete payslips[key];
      payslips[nk] = p;
      savePayslips();
      location.replace(`#/lohn/${nk}`);
    };
    if (payslips[nk])
      confirmDialog(
        `${MONTHS[month - 1]} ${year} ersetzen?`,
        `Für ${MONTHS[month - 1]} ${year} gibt es schon eine Lohnabrechnung. Sie wird durch diese ersetzt.`,
        'Ersetzen',
        move,
        true,
        'Abbrechen',
        undo
      );
    else move();
    return;
  }
  if (path.startsWith('hours.')) p.hours[path.slice(6)] = v || 0;
  else p[path] = v;
  // Stunden oder Stundenlohn von Hand: Beträge und Zeilen der Lohnarten daraus neu (sonst rechneten Vergleich und
  // Prüfung mit den eingelesenen Werten weiter)
  if ((path.startsWith('hours.') || path === 'rate') && p.rate && p.pay) {
    const f = (k) => (k === 'ueber' ? p.lines?.find((x) => x.kind === 'ueber')?.f || p.otFactor || otFactor() : 1);
    p.lines = HOUR_KINDS.map(([k]) => k)
      .filter((k) => p.hours[k])
      .map((k) => ({ kind: k, hours: p.hours[k], f: f(k), amount: cents(p.hours[k] * p.rate * f(k)) }));
    for (const [k] of HOUR_KINDS) p.pay[k] = p.lines.find((x) => x.kind === k)?.amount || 0;
  }
  // Von Hand eingetragen: gilt nicht mehr als ergänzt
  if (p.fixed) p.fixed = p.fixed.filter((k) => k !== path);
  input.closest('.field')?.classList.remove('ps-guess');
  savePayslips();
  document.getElementById('ps-compare').innerHTML = payslipCompareHTML(p);
  fitPsTables();
  document.getElementById('ps-checks').innerHTML = psChecksHTML(p);
}

/** Wert der Abrechnung nicht gelesen, sondern aus den übrigen ergänzt */
const psGuess = (p, path) => (p.fixed || []).includes(path);
/** Abrechnung des Vormonats (für die Prüfung der Jahressumme) */
const prevPayslip = (p) => (p && p.year && p.month ? payslips[payKey(p.month === 1 ? p.year - 1 : p.year, p.month === 1 ? 12 : p.month - 1)] || null : null);
/** Prüfungen der Abrechnung mit den beiden Vormonaten (Jahressumme) */
const psChecks = (p) => payslipChecks(p, prevPayslip(p), prevPayslip(prevPayslip(p)));
/** Prüfungen der Abrechnung als Liste (✓ grün, ✕ rot, – ohne Wertung) */
function psChecksHTML(p) {
  return psChecks(p)
    .map((c) => `<li class="${c.ok ? 'ok' : c.ok === null ? 'skip' : 'bad'}">${c.ok ? '✓' : c.ok === null ? '–' : '✕'} <span>${escapeHtml(c.text)}</span></li>`)
    .join('');
}

/** Foto einer Lohnabrechnung einlesen (Kamera oder Mediathek) */
async function importPayslip(input) {
  const file = input.files && input.files[0];
  input.value = '';
  if (!file) return;
  // Fenster lässt sich nicht wegtippen: das Einlesen liefe sonst unsichtbar weiter
  const modal = openModal(
    `<div class="ps-progress"><b>Lohnabrechnung wird gelesen …</b><div class="ps-bar"><i style="width:3%"></i></div><p class="muted" id="ps-step">Texterkennung wird geladen</p><ul class="ps-checks ps-live" id="ps-live"></ul></div>`,
    'alert ps-modal',
    false
  );
  // Bis zur Antwort im Ergebnis bleibt das Fenster stehen; andere (z. B. „Sicherung einlesen?“) warten
  holdModal(true);
  const close = () => {
    holdModal(false);
    closeModal(true);
  };
  const bar = modal.querySelector('.ps-bar i');
  const step = modal.querySelector('#ps-step');
  const live = modal.querySelector('#ps-live');
  // Bekannte Werte als Gegenprobe: Stundenlöhne, Betriebsrente, Abschlag der letzten Abrechnung
  const known = Object.values(payslips).filter((x) => x && x.year);
  const latest = known.sort((a, b) => b.year * 12 + b.month - (a.year * 12 + a.month))[0];
  const opts = {
    rates: [...new Set([parseNum(settings.wage), ...known.map((x) => x.rate)].filter((v) => v > 0))],
    bav: latest ? latest.bav : parseNum(settings.bav),
    abschlag: latest ? latest.abschlag : 0,
    otFactor: otFactor(),
  };
  // when: Monat und Jahr, falls von Hand gewählt. Steuern und Sozialabgaben werden zum Vergleich nachgerechnet
  // (Tarif des Jahres, Zusatzbeitrag von der Abrechnung, steuer- und beitragsfreie Bezüge wie gelesen) – ohne bekannten
  // Tarif des Jahres nicht (würde falsche Werte bevorzugen)
  const parse = (text, when = null) => {
    const calc = (brutto, zusatz, r) => {
      const { year, month } = when || r;
      if (!year || !lohnJahrBekannt(year)) return null;
      const n = nettoMonat(brutto, { ...lohnOpts(r.bav, year, month, zusatz ?? undefined), stFrei: r.stFrei, svFrei: r.svFrei, stSonst: r.stSonst });
      // „Steuern“ der Abrechnung sind alle steuerrechtlichen Abzüge
      return { lohnsteuer: cents(n.lohnsteuer + n.soli + n.kirchensteuer), sv: cents(n.kv + n.rv + n.av + n.pv) };
    };
    return Object.assign(parsePayslipText(text, { ...opts, calc }), when);
  };
  // Abbrechen beendet die Texterkennung; Laden und jeder Durchgang haben ein Zeitlimit
  const CANCEL = {};
  let cancel;
  const cancelled = new Promise((resolve) => (cancel = resolve)).then(() => Promise.reject(CANCEL));
  cancelled.catch(() => {});
  modal.insertAdjacentHTML('beforeend', '<div class="alert-buttons single ps-cancel"><button data-c="cancel">Abbrechen</button></div>');
  modal.querySelector('[data-c="cancel"]').addEventListener('click', () => cancel(), { once: true });
  const guard = (promise, ms, message) => {
    // Ein abgebrochener Auftrag scheitert später noch einmal – das ist dann kein Fehler mehr
    promise.catch(() => {});
    return Promise.race([promise, cancelled, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);
  };
  let reader = null;
  let text = '';
  let p = null;
  try {
    reader = await guard(payslipReader(), 120000, 'Texterkennung konnte nicht geladen werden (Internet?)');
    // Drei Durchgänge mit verschiedener Bildaufbereitung; nach jedem stehen die Prüfungen im Fenster. Scheitert ein
    // späterer Durchgang, gilt das Ergebnis der früheren
    const texts = [];
    for (let pass = 1; pass <= PAYSLIP_PASSES; pass++) {
      try {
        texts.push(
          await guard(
            reader.read(file, pass, (v) => {
              bar.style.width = `${Math.round(5 + ((pass - 1 + v) / PAYSLIP_PASSES) * 95)}%`;
              step.textContent = `Durchgang ${pass} von ${PAYSLIP_PASSES}: ${Math.round(v * 100)} %`;
            }),
            180000,
            'Texterkennung dauert zu lange'
          )
        );
      } catch (err) {
        if (err === CANCEL || !texts.length) throw err;
        window.fehlerMelden?.(err, 'lohnabrechnung');
        break;
      }
      text = texts.join(PS_SEP);
      p = parse(text);
      if (p.brutto != null || p.netto != null) live.innerHTML = psChecksHTML(p);
    }
  } catch (err) {
    close();
    if (err === CANCEL) return;
    // Netzfehler (auch als Text von Tesseract) sind kein Fehler der App
    const msg = typeof err === 'string' ? err : err?.message || String(err);
    const net = typeof err === 'string' || /Internet|network|load failed|fetch/i.test(msg);
    if (!net) window.fehlerMelden?.(err, 'lohnabrechnung');
    infoDialog('Einlesen nicht möglich', escapeHtml(net ? 'Texterkennung konnte nicht geladen werden (Internet?)' : msg));
    return;
  } finally {
    reader?.close();
  }
  modal.querySelector('.ps-cancel')?.remove();
  if (!p.rate && !p.brutto && !p.netto) {
    close();
    infoDialog('Einlesen nicht möglich', 'Auf dem Foto wurde keine Lohnabrechnung erkannt.');
    return;
  }
  // Fertig: Ergebnis im selben Fenster – Monat, die wichtigsten Beträge, Prüfungen und was unsicher ist. Stimmt nicht
  // alles, Empfehlung zum neuen Foto mit Knopf dafür; „Ansehen“ öffnet die Abrechnung
  const ok = psChecks(p).every((c) => c.ok !== false) && p.month && p.year;
  const sumRow = (label, k) =>
    `<span>${label}</span><b class="${psGuess(p, k) || p[k] == null ? 'ps-unsure' : ''}">${p[k] == null ? '?' : fmtMoney(p[k], true)}</b>`;
  bar.style.width = '100%';
  modal.querySelector('.ps-progress > b').textContent = p.month && p.year ? `${MONTHS[p.month - 1]} ${p.year}` : 'Monat nicht lesbar';
  step.textContent = ok ? 'Alle Prüfungen stimmen' : 'Nicht alles sicher gelesen';
  step.className = ok ? 'ps-done ok' : 'ps-done bad';
  live.innerHTML = psChecksHTML(p);
  live.insertAdjacentHTML('beforebegin', `<div class="ps-sum">${sumRow('Brutto', 'brutto')}${sumRow('Netto', 'netto')}${sumRow('Auszahlung', 'auszahlung')}</div>`);
  if (!ok)
    live.insertAdjacentHTML(
      'afterend',
      `<p class="ps-tip">Am besten neu fotografieren: ganze Seite gerade von oben, gutes Licht, ohne Schatten.</p>`
    );
  modal.insertAdjacentHTML(
    'beforeend',
    ok
      ? '<div class="alert-buttons stacked"><button data-c="yes" class="strong">Ansehen</button><button data-c="no">Nicht übernehmen</button></div>'
      : '<div class="alert-buttons stacked"><label class="ps-again">Neu einlesen<input type="file" accept="image/*" hidden></label><button data-c="yes">Trotzdem ansehen</button><button data-c="no">Nicht übernehmen</button></div>'
  );
  const again = modal.querySelector('.ps-again input');
  const choice = await new Promise((resolve) => {
    modal.querySelector('[data-c="yes"]').addEventListener('click', () => resolve('show'), { once: true });
    modal.querySelector('[data-c="no"]').addEventListener('click', () => resolve('drop'), { once: true });
    again?.addEventListener('change', () => again.files?.length && resolve('again'), { once: true });
  });
  // Neu einlesen: das neue Fenster ersetzt dieses (wartende Fenster warten weiter)
  holdModal(false);
  if (choice === 'again') return importPayslip(again);
  closeModal(true);
  if (choice === 'drop') return;
  p.importedAt = Date.now();
  p.repaired = true; // fertig gelesen: beim Start nicht mehr ergänzen
  const store = (year, month) => {
    // Von Hand gewählter Monat: mit dem Tarif dieses Jahres noch einmal gegenprüfen
    if (p.year !== year || p.month !== month) p = Object.assign(parse(text, { year, month }), { importedAt: p.importedAt, repaired: true });
    const key = payKey(year, month);
    const save = () => {
      payslips[key] = p;
      savePayslips();
      const done = () => {
        const w = tarifWarning(year);
        if (w) infoDialog(`⚠️ ${w.title}`, w.text);
      };
      const target = `#/lohn/${key}`;
      // Seite schon offen (Monat ohne Abrechnung): selbst neu zeigen – derselbe Hash löst kein hashchange aus.
      // Sonst erst nach dem Seitenwechsel melden (route() schließt offene Fenster)
      if (location.hash === target) {
        route();
        done();
      } else {
        window.addEventListener('hashchange', done, { once: true });
        location.hash = target;
      }
    };
    // Schon vorhanden: ersetzen – oder den Monat selbst wählen (falls er falsch erkannt wurde)
    if (payslips[key])
      confirmDialog(
        `${MONTHS[month - 1]} ${year} ersetzen?`,
        'Für diesen Monat gibt es schon eine Lohnabrechnung. Ist es ein anderer Monat, wähle ihn selbst.',
        'Ersetzen',
        save,
        false,
        'Anderer Monat',
        () => askPayslipMonth(month, store, year, true)
      );
    else save();
  };
  if (p.year && p.month) store(p.year, p.month);
  else askPayslipMonth(p.month, store);
}

/**
 * Monat der Abrechnung nicht (sicher) erkannt oder selbst gewählt: nachfragen statt raten.
 * month/year = erkannter Monat bzw. erkanntes Jahr oder null; chosen = Monat soll selbst gewählt werden
 */
function askPayslipMonth(month, done, year = null, chosen = false) {
  const now = new Date();
  const prev = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const m = month || prev.getMonth() + 1;
  // Jahr: das erkannte, sonst das letzte, in dem dieser Monat schon vorbei ist
  const y = year || (m <= now.getMonth() ? now.getFullYear() : now.getFullYear() - 1);
  const years = [];
  for (let k = now.getFullYear(); k >= Math.min(now.getFullYear() - 5, y); k--) years.push(k);
  const modal = openModal(
    `<div class="alert-body"><b>Für welchen Monat ist die Abrechnung?</b>
      <div class="alert-msg">${chosen ? 'Wähle den Monat, für den die Abrechnung gilt.' : month ? 'Das Jahr war auf dem Foto nicht lesbar.' : 'Monat und Jahr waren auf dem Foto nicht lesbar.'}</div>
      <div class="ps-when">
        <select id="ps-m">${MONTHS.map((n, i) => `<option value="${i + 1}" ${i + 1 === m ? 'selected' : ''}>${n}</option>`).join('')}</select>
        <select id="ps-y">${years.map((k) => `<option ${k === y ? 'selected' : ''}>${k}</option>`).join('')}</select>
      </div></div>
    <div class="alert-buttons"><button data-c="no">Abbrechen</button><button data-c="yes" class="strong">Übernehmen</button></div>`,
    'alert',
    // nicht wegtippbar: das Eingelesene ginge sonst ohne Rückfrage verloren
    false
  );
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    const mm = Number(modal.querySelector('#ps-m').value);
    const yy = Number(modal.querySelector('#ps-y').value);
    closeModal();
    if (b.dataset.c === 'yes') done(yy, mm);
  });
}
/** „+3,50 h“ / „−2,00 h“ */
const fmtSigned = (min) => (min > 0 ? '+' : min < 0 ? '−' : '') + fmtH(Math.abs(min));

/** Sa/So: Tagesart lässt sich nicht wählen – nur ein Feiertag, den die App selbst einträgt (zählt 0 Stunden, im PDF wie Arbeit),
 *  oder eine von Hand gesetzte (3 s drücken, manual), die bleibt.
 *  Andere Tagesarten (aus älteren Fassungen oder eingelesenen Dateien) werden entfernt, ebenso die frühere Tagesart
 *  „Schule“ (kurz in v2–v4). true = geändert */
function fixWeekend(s) {
  let changed = false;
  for (const d of s.days) {
    if (d.status === 'schule') {
      delete d.status;
      changed = true;
    }
  }
  for (const i of [5, 6]) {
    const d = s.days[i];
    if (d.status && !d.manual && !(d.status === 'feiertag' && holidayName(sheetDate(s, i)))) {
      delete d.status;
      changed = true;
    }
  }
  // Mo–Fr nur in offenen Zetteln (gesendete bleiben, wie sie verschickt wurden): die Tagesart Feiertag ist nicht mehr wählbar
  const before = s.days.map((d) => d.status).join();
  markHolidays(s, !!s.sentAt);
  return changed || before !== s.days.map((d) => d.status).join();
}

/** Feiertage eines Zettels als „Feiertag“ markieren, nur an Tagen ohne Einträge (Sa/So zählen dann 0 Stunden)
 *  und nicht an Tagen, deren Tagesart von Hand gesetzt wurde (langes Drücken) */
function markHolidays(s, weekendOnly) {
  s.days.forEach((d, i) => {
    if ((weekendOnly && i < 5) || !sheetIsActive(s, i) || d.status || d.manual || dayHasTimes(d) || d.rows.some((r) => r.site || r.work)) return;
    if (holidayName(sheetDate(s, i))) d.status = 'feiertag';
  });
}

/** Hinweise vor dem Senden: unvollständige Zeilen, Überschneidungen, fehlende Angaben, leere Werktage */
function sheetProblems(s) {
  const problems = [];
  if (!String(s.name || '').trim()) problems.push('Name fehlt (in den Einstellungen)');
  else if (pdfCharHint(s.name)) problems.push(`Name: ${pdfCharHint(s.name)}`);
  s.days.forEach((d, i) => {
    const sw = statusWarning(s, i);
    if (sw) problems.push(`${WEEKDAYS[i]}: ${sw}`);
    if (!sheetIsActive(s, i) || !canWork(d)) return;
    const day = WEEKDAYS[i];
    const timed = [];
    d.rows.forEach((r, k) => {
      const where = d.rows.length > 1 ? `${day}, Zeile ${k + 1}` : day;
      const missing = [
        ['start', 'Beginn'],
        ['end', 'Ende'],
        ['site', 'Baustelle'],
        ['work', 'Art der Arbeit'],
      ]
        .filter(([f]) => fieldMissing(d, r, f))
        .map(([, label]) => label);
      if (endBeforeStart(r)) problems.push(`${where}: Ende ${fmtTime(r.end)} liegt vor Beginn ${fmtTime(r.start)}`);
      if (sameStartEnd(r)) problems.push(`${where}: Beginn und Ende sind gleich (${fmtTime(r.start)})`);
      if (missing.length) problems.push(`${where}: ${missing.join(', ')} ${missing.length > 1 ? 'fehlen' : 'fehlt'}`);
      for (const [f, label] of [['site', 'Baustelle'], ['work', 'Art der Arbeit']]) {
        const h = pdfCharHint(r[f]);
        if (h) problems.push(`${where}, ${label}: ${h}`);
      }
      if (r.start != null && r.end != null && rowEnd(r) > r.start) timed.push(r);
    });
    if (rowsOutOfOrder(d).size) problems.push(`${day}: Zeilen nicht in zeitlicher Reihenfolge`);
    timed.sort((a, b) => a.start - b.start);
    for (let k = 1; k < timed.length; k++) {
      const a = timed[k - 1];
      const b = timed[k];
      if (b.start < rowEnd(a)) {
        problems.push(`${day}: ${fmtTime(a.start)}–${fmtTime(a.end)} und ${fmtTime(b.start)}–${fmtTime(b.end)} überschneiden sich`);
      } else if (b.start > rowEnd(a)) {
        problems.push(`${day}: Lücke von ${fmtTime(a.end)} bis ${fmtTime(b.start)}`);
      }
    }
    if (pauseMissing(d)) problems.push(`${day}: Pause fehlt`);
    if (i < 5 && !d.status && !dayStarted(d)) problems.push(`${day}: kein Eintrag`);
  });
  return problems;
}

/**
 * Gespeicherter Stand des offenen Zettels: Änderungen an den Tagen gelten erst nach „Eintrag speichern“.
 * Bis dahin landen sie nicht im Speicher, nicht in der Sicherung und nicht beim Team (savedSheets()).
 */
let editorSaved = null; // { id, days, dayJson: [...] }
const editorSnapshot = (s) => (s ? { id: s.id, days: structuredClone(s.days), dayJson: s.days.map((d) => JSON.stringify(d)) } : null);
const editorPending = () => {
  const s = editorSaved && findSheet(editorSaved.id);
  return s && s.days.some((d, i) => JSON.stringify(d) !== editorSaved.dayJson[i]) ? s : null;
};
const editorDayDirty = (s, i) => !!editorSaved && s.id === editorSaved.id && JSON.stringify(s.days[i]) !== editorSaved.dayJson[i];
/** Ein Zettel im gespeicherten Stand */
const savedSheet = (s) => (s && editorPending() === s ? { ...s, days: editorSaved.days } : s);
/** Alle Zettel, beim offenen Zettel mit den zuletzt gespeicherten Tagen */
function savedSheets() {
  const p = editorPending();
  return p ? sheets.map((s) => (s === p ? { ...s, days: editorSaved.days } : s)) : sheets;
}

/** Speichert alle Zettel; ein geänderter Zettel bekommt den Zeitstempel „zuletzt geändert“. */
function saveSheets(changed) {
  if (changed) changed.updatedAt = Date.now();
  if (currentView === 'editor') updateSaveBar();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(savedSheets()));
  } catch (e) {
    window.fehlerMelden?.(e, 'speichern');
    toast('Speichern fehlgeschlagen!');
  }
  teamQueueUpload();
}
function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch (e) {
    window.fehlerMelden?.(e, 'speichern');
    toast('Speichern fehlgeschlagen!');
  }
  teamQueueUpload();
}

// Speicher als dauerhaft markieren, damit iOS ihn nicht aufräumt
if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});

const findSheet = (id) => sheets.find((s) => s.id === id);
const existingSheet = (anchor, excludeId) => {
  const k = anchorKey(anchor);
  return sheets.find((s) => s.id !== excludeId && `${s.weekStart}|${s.year}|${s.month}` === k);
};

function openOrCreate(anchor) {
  const found = existingSheet(anchor);
  if (found) return found.id;
  const s = newSheet(anchor, settings.name);
  markHolidays(s);
  sheets.push(s);
  saveSheets();
  return s.id;
}

/** Bisher verwendete Einträge, die häufigsten zuerst. */
/** Deutsche Sortierung (ein Collator für alle Vergleiche – localeCompare mit Sprache legt in Safari je Vergleich einen an) */
const deCollator = new Intl.Collator('de');
function collectSuggestions(field) {
  const counts = new Map();
  for (const s of sheets)
    for (const d of s.days)
      for (const r of d.rows) {
        // Art der Arbeit: „Spachteln, Schleifen“ ergibt zwei Vorschläge
        const parts = field === 'work' ? (r[field] || '').split(',') : [r[field] || ''];
        for (const part of parts) {
          const v = part.trim();
          if (!v) continue;
          // Verschiedene Apostrophe / Groß- und Kleinschreibung ergeben einen Vorschlag
          const key = sameKey(v);
          if (!counts.has(key)) counts.set(key, { total: 0, spellings: new Map() });
          const c = counts.get(key);
          c.total++;
          c.spellings.set(v, (c.spellings.get(v) || 0) + 1);
        }
      }
  // Ausgeblendete Vorschläge (langes Drücken in der Leiste) bleiben weg, bis sie wiederhergestellt werden
  const hidden = new Set(settings.hiddenSuggestions[field].map(sameKey));
  return [...counts]
    .filter(([key]) => !hidden.has(key))
    // angezeigt wird die häufigste Schreibweise
    .map(([, c]) => [[...c.spellings].sort((a, b) => b[1] - a[1])[0][0], c.total])
    .sort((a, b) => b[1] - a[1] || deCollator.compare(a[0], b[0]))
    .map(([v]) => v);
}

/** Wie oft welche Art der Arbeit an welcher Baustelle eingetragen wurde: Baustelle → (Tätigkeit → Anzahl), klein geschrieben */
function collectWorkBySite() {
  const map = new Map();
  for (const s of sheets)
    for (const d of s.days)
      for (const r of d.rows) {
        const site = sameKey(r.site);
        if (!site) continue;
        if (!map.has(site)) map.set(site, new Map());
        const works = map.get(site);
        for (const part of (r.work || '').split(',')) {
          const w = sameKey(part);
          if (w) works.set(w, (works.get(w) || 0) + 1);
        }
      }
  return map;
}

// ───────────────────────── Arbeitsscheine ─────────────────────────
// Arbeitsscheine aus der Arbeitsbericht-App des Tablets (.odt): abgeholt über ein Google-Skript im eigenen Postfach
// (Abholadresse in den Einstellungen) oder per „Sicherung einlesen“. Am Tag erscheint dann eine Kapsel; antippen zeigt
// den Schein und trägt ihn auf Wunsch als Zeile ein.

const REPORT_KEY = 'stdprotokoll.reports.v1';
// items: Scheine; since: Zeitpunkt der neuesten abgeholten Mail; at: letztes Abholen
let reportStore = { items: [], since: 0, at: 0, ...readJson(REPORT_KEY, {}) };
if (reportStore.items.some((r) => !r.v)) reportStore.since = 0;
const reports = () => reportStore.items;
function saveReports() {
  try {
    localStorage.setItem(REPORT_KEY, JSON.stringify(reportStore));
  } catch (e) {
    window.fehlerMelden?.(e, 'speichern');
    toast('Speichern fehlgeschlagen!');
  }
}
/** Neue Scheine übernehmen, gleiche Nummer ersetzt den alten (nachträglich geänderter Schein) mit allen Teilen –
 *  die Zahl der Zeitzeilen und damit die IDs („123“, „123#1“ …) kann sich ändern; Rückgabe: Anzahl neue */
function addReports(list) {
  let n = 0;
  const nos = new Set(list.map((r) => r.no).filter(Boolean));
  const ids = new Set(list.map((r) => r.id));
  const known = new Set(reportStore.items.filter((r) => nos.has(r.no)).map((r) => r.no));
  reportStore.items = reportStore.items.filter((r) => !nos.has(r.no) || ids.has(r.id));
  for (const rep of list) {
    const i = reportStore.items.findIndex((r) => r.id === rep.id);
    if (i >= 0) reportStore.items[i] = rep;
    else {
      reportStore.items.push(rep);
      if (!known.has(rep.no)) n++;
    }
  }
  saveReports();
  return n;
}
const reportsOn = (date) =>
  reports()
    .filter((r) => r.date === isoDate(date))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));

/** Text einer ODT-Tabellenzelle; Zeilenumbrüche bleiben als \n */
function odtText(node) {
  let t = '';
  for (const c of node.childNodes) {
    if (c.nodeType === 3) t += c.nodeValue;
    else if (c.nodeName === 'text:line-break') t += '\n';
    else if (c.nodeName === 'text:s') t += ' '.repeat(Number(c.getAttribute('text:c')) || 1);
    else if (c.nodeName === 'text:tab') t += ' ';
    else {
      t += odtText(c);
      if (c.nodeName === 'text:p' || c.nodeName === 'text:h') t += '\n';
    }
  }
  return t;
}

/**
 * Arbeitsschein aus meta.xml und content.xml: Kunde/Adresse/Nummer aus den Benutzerfeldern, Datum/Zeiten/Mitarbeiter
 * aus der Tabelle „Datum | Mitarbeiter | Arbeitsanfang | Arbeitsende | Fahrzeit | Fahrstrecke | Pause | Arbeitszeit“,
 * Arbeiten aus der Tabelle „Arbeit“. Je Zeitzeile ein Schein (meist genau eine).
 */
function parseWorkReport(metaXml, contentXml) {
  const parse = (xml) => new DOMParser().parseFromString(xml, 'application/xml');
  const meta = parse(metaXml);
  const field = (name) => {
    for (const el of meta.getElementsByTagName('meta:user-defined')) if (el.getAttribute('meta:name') === name) return el.textContent.trim();
    return '';
  };
  const no = field('report_id').replace(/^-/, '');
  if (!no) throw new Error('kein Arbeitsschein');
  const tables = [...parse(contentXml).getElementsByTagName('table:table')].map((tb) =>
    [...tb.getElementsByTagName('table:table-row')].map((row) => [...row.getElementsByTagName('table:table-cell')].map((c) => odtText(c).trim()))
  );
  const table = (head) => tables.find((rows) => rows[0] && rows[0][0] === head) || [];
  const clean = (s) => s.replace(/\s+/g, ' ').trim();
  const time = (s) => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(clean(s || ''));
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const workLines = table('Arbeit')
    .slice(1)
    .map((r) => clean(r.join(' ')))
    .filter(Boolean);
  const work = workLines.join(' ');
  const flat = table('Pauschale')
    .slice(1)
    .map((r) => ({ name: clean(r[0] || ''), qty: clean(r[1] || ''), note: clean(r[2] || '') }))
    .filter((x) => x.name || x.note);
  const material = table('Material')
    .slice(1)
    .map((r) => ({ name: clean(r[0] || ''), qty: clean(r[1] || ''), unit: clean(r[2] || '') }))
    .filter((x) => x.name);
  const rows = table('Datum')
    .slice(1)
    .filter((r) => /^\d{1,2}\.\d{1,2}\.\d{4}$/.test(clean(r[0] || '')));
  if (!rows.length) throw new Error('keine Zeiten im Arbeitsschein');
  const customer = clean(field('project_name') || field('bill_name'));
  return rows.map((r, i) => {
    const [d, m, y] = clean(r[0]).split('.').map(Number);
    return {
      v: 2,
      id: rows.length > 1 ? `${no}#${i + 1}` : no,
      no,
      created: clean(field('create_date')),
      billName: clean(field('bill_name')),
      email: clean(field('project_extra1')),
      date: isoDate(new Date(y, m - 1, d)),
      customer,
      street: clean(field('bill_street')),
      zip: clean(field('bill_zip')),
      city: clean(field('bill_city')),
      start: time(r[2]),
      end: time(r[3]),
      pause: time(r[6]) || 0,
      travel: time(r[4]),
      km: clean(r[5] || ''),
      worked: time(r[7]),
      staff: (r[1] || '').split('\n').map(clean).filter(Boolean),
      work,
      workLines,
      flat,
      material,
    };
  });
}

/** .odt-Datei (ArrayBuffer) → Scheine */
async function readWorkReportFile(buf) {
  const zip = readZip(buf);
  const text = async (name) => {
    if (!zip.has(name)) throw new Error('kein Arbeitsschein');
    return utf8.decode(await zip.get(name)());
  };
  return parseWorkReport(await text('meta.xml'), await text('content.xml'));
}

/** Neue Scheine über die Abholadresse holen (höchstens alle 5 Minuten, außer „Jetzt abholen“) */
let reportFetching = false;
async function fetchReports(manual = false) {
  const url = (settings.reportUrl || '').trim();
  if (reportFetching || (!manual && Date.now() - reportStore.at < 5 * 60e3)) return;
  // Scheine aus der Arbeitsschein-App über den Team-Server (konto.js); die Abholadresse (Google) läuft daneben weiter
  if (!url) {
    if (!team || !accountOk()) return;
    reportFetching = true;
    const n = await accountFetchReports();
    reportStore.at = Date.now();
    saveReports();
    reportFetching = false;
    if (manual) toast(n ? `${n} neue${n === 1 ? 'r' : ''} Arbeitsschein${n === 1 ? '' : 'e'}` : 'Keine neuen Arbeitsscheine');
    if (n && currentView === 'reports') renderReportList();
    else if (n && currentView === 'editor' && !typingField() && !layer.classList.contains('open')) refreshAll();
    return;
  }
  reportFetching = true;
  let n = await accountFetchReports();
  try {
    const res = await fetch(`${url}${url.includes('?') ? '&' : '?'}since=${reportStore.since || 0}`);
    const data = await res.json();
    if (data.error) throw new Error(data.error === 'key' ? 'Schlüssel in der Abholadresse falsch' : data.error);
    for (const f of data.files || []) {
      try {
        n += addReports(parseWorkReport(f.meta, f.content));
      } catch {
        // keine Arbeitsschein-Datei – übergehen
      }
      reportStore.since = Math.max(reportStore.since || 0, f.time || 0);
    }
    reportStore.at = Date.now();
    saveReports();
    if (manual) toast(n ? `${n} neue${n === 1 ? 'r' : ''} Arbeitsschein${n === 1 ? '' : 'e'}` : 'Keine neuen Arbeitsscheine');
  } catch (e) {
    if (manual) infoDialog('Abholen fehlgeschlagen', escapeHtml((e && e.message) || 'Keine Verbindung'));
  } finally {
    reportFetching = false;
  }
  if (n && currentView === 'reports') renderReportList();
  if (document.getElementById('report-status')) {
    const el = document.getElementById('report-status');
    if (el) el.textContent = reportStatusText();
  } else if (n && currentView === 'editor' && !typingField() && !layer.classList.contains('open')) refreshAll();
}
const reportStatusText = () =>
  `${reports().length} Arbeitsschein${reports().length === 1 ? '' : 'e'}${
    reportStore.at ? ` · abgeholt ${fmtDayMonth(new Date(reportStore.at))} ${fmtTime(new Date(reportStore.at).getHours() * 60 + new Date(reportStore.at).getMinutes())}` : ''
  }`;

// ───────────────────────── Verschlüsselte Sicherung ─────────────────────────
// AES-256-GCM, Schlüssel aus dem Passwort des Kontos (PBKDF2-SHA256, siehe konto.js). Der Schlüssel liegt nur auf diesem iPhone
// (stdprotokoll.crypt.v1, nicht in der Sicherung), damit die automatische Sicherung ohne Eingabe läuft.
// Beim Einlesen einer verschlüsselten Datei fragt die App nach dem Passwort.

const CRYPT_KEY = 'stdprotokoll.crypt.v1';
const PBKDF2_ITER = 310000;
let cryptStore = readJson(CRYPT_KEY, null); // { salt, key } als Base64

function toB64(buf) {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromB64(str) {
  const s = atob(str);
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}
async function passwordKey(pw, salt, iter = PBKDF2_ITER) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: iter, hash: 'SHA-256' }, base, { name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}
async function rememberKey(key, salt) {
  cryptStore = { salt: toB64(salt), key: toB64(await crypto.subtle.exportKey('raw', key)) };
  try {
    localStorage.setItem(CRYPT_KEY, JSON.stringify(cryptStore));
  } catch (e) {
    // nach einem Neustart fehlte der Schlüssel: Sicherungen gingen nicht mehr (sealBackup verweigert dann)
    window.fehlerMelden?.(e, 'speichern');
    toast('Speichern fehlgeschlagen – Speicher voll?', 4000);
  }
}

/** Verschlüsselt wird mit Konto (konto.js) – oder wie früher per Schalter, solange noch kein Konto eingerichtet ist */
const backupEncrypted = () => !!(cryptStore && (account || settings.encryptBackup));
/** Sicherung zum Speichern/Senden: verschlüsselt, wenn ein Konto (bzw. der frühere Schalter) da ist */
async function sealBackup(plain) {
  // früherer Schalter an, Schlüssel fehlt: nicht stillschweigend unverschlüsselt sichern
  if (!account && settings.encryptBackup && !cryptStore) throw new Error('Passwort fehlt – unter Einstellungen → Konto anmelden.');
  // Konto ohne gespeicherten Schlüssel (z. B. Speicher voll beim Anmelden): nicht still unverschlüsselt sichern
  if (account && !cryptStore) throw new Error('Schlüssel fehlt – unter Einstellungen → Konto abmelden und neu anmelden.');
  if (!backupEncrypted()) return plain;
  const key = await crypto.subtle.importKey('raw', fromB64(cryptStore.key), 'AES-GCM', false, ['encrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
  return JSON.stringify({ app: 'std-protokoll', enc: 'AES-256-GCM', kdf: 'PBKDF2-SHA256', iter: PBKDF2_ITER, salt: cryptStore.salt, iv: toB64(iv), data: toB64(data) });
}

/** Verschlüsselte Sicherung öffnen: nach dem Passwort fragen, bis es passt oder abgebrochen wird */
const openedKeys = new Map(); // salt → Schlüssel, damit mehrere Dateien mit demselben Passwort nur einmal fragen
async function openSealedBackup(obj, fileName) {
  const salt = fromB64(obj.salt);
  const tryKey = async (key) => {
    try {
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(obj.iv) }, key, fromB64(obj.data));
      return JSON.parse(utf8.decode(plain));
    } catch {
      return null;
    }
  };
  // Gleiches Salz heißt nicht gleiches Passwort (Salz hängt am Benutzernamen, „Passwort ändern“ behält es): beide probieren
  const known = [
    openedKeys.get(obj.salt),
    cryptStore && cryptStore.salt === obj.salt ? await crypto.subtle.importKey('raw', fromB64(cryptStore.key), 'AES-GCM', true, ['decrypt']) : null,
  ].filter(Boolean);
  for (const key of known) {
    const data = await tryKey(key);
    if (data) return data;
  }
  document.getElementById('toast').classList.remove('show');
  for (let wrong = false; ; wrong = true) {
    const pw = await askPassword(wrong ? 'Passwort falsch' : 'Passwort', `${noTrHTML(fileName)} ist verschlüsselt.`);
    if (pw == null) throw new Error('kein Passwort');
    const key = await passwordKey(pw, salt, obj.iter || PBKDF2_ITER);
    const data = await tryKey(key);
    if (!data) continue;
    openedKeys.set(obj.salt, key);
    // Frisches iPhone: Schlüssel übernehmen, damit weitere Sicherungen gleich verschlüsselt werden
    if (!cryptStore) await rememberKey(key, salt);
    return data;
  }
}

/** Passwortfenster; liefert das Passwort oder null (Abbrechen) */
function askPassword(title, message, confirm = false) {
  return new Promise((resolve) => {
    const modal = openModal(
      `<div class="alert-body"><b>${title}</b><div class="alert-msg">${message}</div>
        <input type="password" class="pw-input" data-pw="1" placeholder="Passwort" autocomplete="${confirm ? 'new-password' : 'current-password'}">
        ${confirm ? '<input type="password" class="pw-input" data-pw="2" placeholder="Wiederholen" autocomplete="new-password">' : ''}
      </div>
      <div class="alert-buttons"><button data-c="no">Abbrechen</button><button data-c="yes" class="strong">OK</button></div>`,
      'alert'
    );
    const done = (v) => {
      closeModal();
      resolve(v);
    };
    modal.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b) return;
      if (b.dataset.c === 'no') return done(null);
      const p1 = modal.querySelector('[data-pw="1"]').value;
      const p2 = confirm ? modal.querySelector('[data-pw="2"]').value : p1;
      const msg = modal.querySelector('.alert-msg');
      if (confirm && p1.length < PW_MIN) msg.textContent = `Mindestens ${PW_MIN} Zeichen.`;
      else if (p1 !== p2) msg.textContent = 'Die beiden Passwörter sind verschieden.';
      else if (p1) done(p1);
    });
    modal.previousElementSibling.addEventListener('click', () => resolve(null));
  });
}

// Rechtsformen und Allerweltswörter zählen beim Wiedererkennen eines Kunden nicht
const LEGAL_FORMS = new Set(['gmbh', 'mbh', 'se', 'ag', 'kg', 'ohg', 'ug', 'co', 'co.', '&', '+', 'e.k.', 'e.v.', 'gbr', '(haftungsbeschränkt)']);
const GENERIC_WORDS = new Set(['bäckerei', 'fleischerei', 'metzgerei', 'restaurant', 'hotel', 'café', 'cafe', 'eiscafé', 'kaffee', 'gaststätte', 'pizzeria', 'imbiss', 'markt', 'supermarkt', 'praxis', 'firma', 'autohaus', 'industries', 'gruppe']);

/** Kunde ohne Rechtsform: „Muster Kälte GmbH & Co. KG“ → „Muster Kälte“ */
const shortCustomer = (name) =>
  String(name || '')
    .split(/\s+/)
    .filter((w) => w && !LEGAL_FORMS.has(w.toLowerCase()))
    .join(' ')
    .replace(/[,&+\s]+$/, '');
const customerWords = (name) =>
  (sameKey(shortCustomer(name)).match(/[a-zäöüß0-9]{4,}/g) || []).filter((w) => !GENERIC_WORDS.has(w));

/** Schon im Tag eingetragen: Zeile aus diesem Schein oder mit dem Kunden in der Baustelle */
function reportEntered(day, rep) {
  const words = customerWords(rep.customer);
  return day.rows.some((r) => r.report === rep.id || words.some((w) => sameKey(r.site).includes(w)));
}

/** Baustelle: eigene frühere Schreibweise des Kunden, sonst „Kunde, Ort“ */
function reportSite(rep) {
  const short = shortCustomer(rep.customer);
  const words = customerWords(rep.customer);
  const known = collectSuggestions('site').find((site) => {
    const k = sameKey(site);
    return k.includes(sameKey(short)) || words.includes(k.split(/[\s,]+/)[0]);
  });
  return (known || [short, rep.city].filter(Boolean).join(', ')).slice(0, MAX_LEN.site);
}

/** Art der Arbeit: eigene frühere Einträge mit Wörtern aus dem Schein, dazu der erste Satz des Scheins */
function reportWorkOptions(rep, site) {
  const stem = (w) => w.slice(0, 6);
  const text = sameKey(rep.work);
  const words = new Set((text.match(/[a-zäöüß]{4,}/g) || []).map(stem));
  const fault = /fehler|alarm|störung|defekt|ausgefallen|zeigt .* an/.test(text);
  const atSite = collectWorkBySite().get(sameKey(site));
  const scored = collectSuggestions('work')
    .map((w, i) => {
      const own = sameKey(w).match(/[a-zäöüß]{4,}/g) || [];
      const hits = own.filter((x) => words.has(stem(x))).length;
      if (!hits) return null;
      const bonus = (atSite && atSite.get(sameKey(w)) ? 3 : 0) + (fault && /störung/.test(sameKey(w)) ? 5 : 0);
      return { w, score: hits * 10 + bonus - i * 0.01 };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.w);
  const first = (rep.work.split(/(?<=[.!?])\s/)[0] || '').trim().replace(/\.$/, '').slice(0, MAX_LEN.work);
  return [...new Set([...scored.slice(0, 2), first].filter(Boolean))];
}

// ───────────────────────── Arbeitsscheine: Liste und Detailseite ─────────────────────────

/** Im Stundenzettel eingetragen (Tag des Scheins hat eine Zeile dazu) */
const reportDone = (rep) => {
  const day = sheetDayFor(parseDate(rep.date));
  return !!day && reportEntered(day, rep);
};
const reportTimes = (rep) => (rep.start != null ? `${fmtTime(rep.start)}–${rep.end != null ? fmtTime(rep.end) : '?'}` : '');
const fmtWeekday = (d) => `${WEEKDAYS_SHORT[(d.getDay() + 6) % 7]} ${fmtDayMonth(d)}`;

function renderReportList() {
  const groups = new Map();
  for (const rep of reports()) {
    const key = rep.date.slice(0, 7);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(rep);
  }
  const keys = [...groups.keys()].sort().reverse();
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title">Arbeitsscheine</h1>
    ${
      keys.length
        ? keys
            .map((k) => {
              const items = groups.get(k).sort((a, b) => b.date.localeCompare(a.date) || (b.start ?? 0) - (a.start ?? 0));
              return `<h2 class="section-title">${MONTHS[Number(k.slice(5)) - 1]} ${k.slice(0, 4)}</h2>
          <div class="card list">${items.map(reportRowHTML).join('')}</div>`;
            })
            .join('')
        : `<div class="empty">
      <div class="empty-icon">${svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>', 44)}</div>
      <p><b>Noch keine Arbeitsscheine</b></p>
    </div>`
    }`;
}

function reportRowHTML(rep) {
  const done = reportDone(rep);
  const onSite = rep.start != null && rep.end != null ? rep.end - rep.start - (rep.pause || 0) : null;
  return `<a draggable="false" class="list-row plain" href="#/arbeitsschein/${encodeURIComponent(rep.id)}">
    <span class="status ${done ? 'sent' : 'ws-open'}">${done ? ICON.check : ''}</span>
    <span class="list-main">
      <span class="list-title" translate="no">${escapeHtml(shortCustomer(rep.customer))}</span>
      <span class="list-sub">${fmtWeekday(parseDate(rep.date))}${reportTimes(rep) ? ` · ${reportTimes(rep)}` : ''}${rep.city ? ` · <span translate="no">${escapeHtml(rep.city)}</span>` : ''}</span>
    </span>
    <span class="list-hours">${onSite != null ? fmtH(onSite) : ''}</span>
    <span class="list-chevron">${ICON.chevronRight}</span>
  </a>`;
}

/** Ganzer Arbeitsschein */
function renderReport(id) {
  const rep = reports().find((r) => r.id === id);
  if (!rep) {
    location.replace('#/arbeitsscheine');
    return;
  }
  const date = parseDate(rep.date);
  const done = reportDone(rep);
  const row = (label, value) => (value ? `<div class="field ws-row"><span>${label}</span><span class="ws-val">${value}</span></div>` : '');
  const hm = (m) => (m == null ? '' : fmtTime(m));
  const lines = rep.workLines && rep.workLines.length ? rep.workLines : [rep.work].filter(Boolean);
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title ws-title" translate="no">${escapeHtml(rep.customer)}</h1>
    <p class="ws-sub" translate="no">${escapeHtml([rep.street, [rep.zip, rep.city].filter(Boolean).join(' ')].filter(Boolean).join(', '))}${
      rep.email ? `<br>${escapeHtml(rep.email)}` : ''
    }</p>

    <h2 class="section-title">Arbeits- und Fahrzeiten</h2>
    <div class="card form">
      ${row('Datum', `${WEEKDAYS[(date.getDay() + 6) % 7]}, ${fmtShort(date)}`)}
      ${row('Mitarbeiter', (rep.staff || []).map(escapeHtml).join('<br>'))}
      ${row('Arbeitsanfang', hm(rep.start))}
      ${row('Arbeitsende', hm(rep.end))}
      ${row('Pause', rep.pause != null ? fmtH(rep.pause) : '')}
      ${row('Arbeitszeit', rep.worked != null ? fmtH(rep.worked) : '')}
      ${row('Fahrzeit', rep.travel != null ? fmtH(rep.travel) : '')}
      ${row('Fahrstrecke', rep.km !== undefined && rep.km !== '' ? `${escapeHtml(rep.km)} km` : '')}
    </div>

    <h2 class="section-title">Durchgeführte Arbeiten</h2>
    <div class="card ws-work" translate="no">${lines.map((l) => `<p>${escapeHtml(l).replace(/\n/g, '<br>')}</p>`).join('') || '<p class="muted">–</p>'}</div>

    ${
      rep.flat && rep.flat.length
        ? `<h2 class="section-title">Pauschalen</h2>
    <div class="card form">${rep.flat
      .map((f) => row(escapeHtml([f.name, f.note].filter(Boolean).join(' · ')), escapeHtml(f.qty ? `${f.qty.replace('.', ',')}×` : '')) || `<div class="field ws-row"><span>${escapeHtml(f.name || f.note)}</span></div>`)
      .join('')}</div>`
        : ''
    }
    ${
      rep.material && rep.material.length
        ? `<h2 class="section-title">Material</h2>
    <div class="card form">${rep.material
      .map((m) => `<div class="field ws-row"><span>${escapeHtml(m.name)}</span><span class="ws-val">${escapeHtml([m.qty.replace(/\.0$/, '').replace('.', ','), m.unit].filter(Boolean).join(' '))}</span></div>`)
      .join('')}</div>`
        : ''
    }

    <h2 class="section-title">Stundenzettel</h2>
    <div class="card list">
      <div class="field ws-row"><span>${done ? `<span class="ws-done">${ICON.check} Eingetragen</span>` : 'Noch nicht eingetragen'}</span></div>
      <button class="list-btn" data-act="report-sheet" data-id="${escapeHtml(rep.id)}">Stundenzettel öffnen</button>
      <button class="list-btn destructive" data-act="report-delete" data-id="${escapeHtml(rep.id)}">Arbeitsschein löschen</button>
    </div>
    <p class="footnote">Nr. ${escapeHtml(rep.no)}${rep.created ? ` vom ${escapeHtml(rep.created)}` : ''}</p>`;
}

/** Kapsel neben dem Wochentag: blau, solange ein Schein fehlt; grau mit Haken, wenn alle eingetragen sind */
function reportChipHTML(s, i) {
  const day = s.days[i];
  if (day.status && day.status !== 'feiertag') return '';
  const list = reportsOn(sheetDate(s, i));
  if (!list.length) return '';
  const done = list.every((rep) => reportEntered(day, rep));
  return `<button class="ws-chip ${done ? 'done' : ''}" data-act="report" aria-label="Arbeitsschein">${ICON.doc}${done ? ICON.check : ''}</button>`;
}

/** Kapsel angetippt: ein Schein → gleich das Fenster, mehrere → erst auswählen */
function pickReport(el) {
  const { s, dayIndex, day } = rowContext(el);
  const list = reportsOn(sheetDate(s, dayIndex));
  if (list.length === 1) return openReport(list[0].id);
  actionSheet(
    list.map((rep) => ({
      label: `${reportEntered(day, rep) ? '✓ ' : ''}${escapeHtml(shortCustomer(rep.customer))} · ${fmtTime(rep.start)}–${fmtTime(rep.end)}`,
      run: () => setTimeout(() => openReport(rep.id), 280),
    }))
  );
}

/** Fenster mit dem Schein; draft = was eingetragen wird (bleibt beim Wechsel zum Uhrzeit-Rad erhalten) */
function openReport(id, draft = null) {
  const rep = reports().find((r) => r.id === id);
  const s = currentSheet();
  const dayIndex = [0, 1, 2, 3, 4, 5, 6].find((i) => isoDate(sheetDate(s, i)) === rep.date);
  const day = s.days[dayIndex];
  // Zeiten des Scheins (15-Minuten-Schritte) auf die Schritte des Zettels: Beginn früher, Ende später
  const step = settings.minuteStep;
  const down = (m) => (m == null ? m : Math.floor(m / step) * step);
  const up = (m) => (m == null ? m : Math.ceil(m / step) * step);
  if (!draft) {
    const site = reportSite(rep);
    draft = { start: down(rep.start), end: up(rep.end), site, work: reportWorkOptions(rep, site)[0] || '' };
  }
  const options = reportWorkOptions(rep, draft.site);
  const rounded = (rep.start != null && draft.start !== rep.start) || (rep.end != null && draft.end !== rep.end);
  const optSel = (o) => workParts(draft.work + ',').done.some((p) => sameKey(p) === sameKey(o));
  const done = reportEntered(day, rep);
  const me = sameKey(settings.name);
  const others = (rep.staff || []).filter((n) => sameKey(n) !== me);
  const fact = (label, value) => (value ? `<div class="ws-fact"><span>${label}</span><b>${value}</b></div>` : '');
  const time = (which, label) =>
    `<button class="time ${draft[which] == null ? 'empty' : ''}" data-w="${which}">${draft[which] == null ? label : fmtTime(draft[which])}</button>`;
  const onSite = rep.start != null && rep.end != null ? rep.end - rep.start - (rep.pause || 0) : null;
  const modal = openModal(
    `<div class="modal-head">
      <button class="modal-btn" data-m="cancel">Schließen</button>
      <b>Arbeitsschein</b>
      <span></span>
    </div>
    <div class="ws-body">
      <div class="ws-card">
        <div class="ws-cust" translate="no">${escapeHtml(rep.customer)}</div>
        <div class="ws-addr" translate="no">${escapeHtml([rep.street, [rep.zip, rep.city].filter(Boolean).join(' ')].filter(Boolean).join(', '))}</div>
        <div class="ws-facts">
          ${rep.start != null ? fact('Vor Ort', `${fmtTime(rep.start)} – ${rep.end != null ? fmtTime(rep.end) : '?'}${onSite != null ? ` · ${fmtH(onSite)}` : ''}`) : ''}
          ${fact('Pause', rep.pause ? fmtH(rep.pause) : '')}
          ${fact('Mit', `<span translate="no">${escapeHtml(others.join(', '))}</span>`)}
        </div>
        <div class="ws-label">Durchgeführte Arbeiten</div>
        <div class="ws-text" translate="no">${escapeHtml(rep.work) || '–'}</div>
        <div class="ws-no">Nr. ${escapeHtml(rep.no)}</div>
      </div>
      <div class="ws-label sec">${done ? `<span class="ws-done">${ICON.check} Schon eingetragen</span>` : 'Eintragen als'}</div>
      <div class="ws-form">
        <div class="row-times">${time('start', 'Beginn')}<span class="arrow">–</span>${time('end', 'Ende')}</div>
        ${rounded ? `<div class="ws-round">Gerundet, laut Schein ${reportTimes(rep)}</div>` : ''}
        <div class="ws-field"><span class="ws-icon">${ICON.pin}</span><textarea class="ws-in" data-f="site" rows="1" maxlength="${MAX_LEN.site}" placeholder="Ort" autocapitalize="sentences">${escapeHtml(draft.site)}</textarea></div>
        <div class="ws-field"><span class="ws-icon">${ICON.tool}</span><textarea class="ws-in" data-f="work" rows="1" maxlength="${MAX_LEN.work}" placeholder="Arbeit" autocapitalize="sentences">${escapeHtml(draft.work)}</textarea></div>
        ${
          options.length > 1
            ? `<div class="ws-opts">${options
                .map((o) => `<button class="ws-opt ${optSel(o) ? 'sel' : ''}" translate="no" data-o="${escapeHtml(o)}">${ICON.check}${escapeHtml(o)}</button>`)
                .join('')}</div>`
            : ''
        }
      </div>
    </div>
    <div class="ws-go-wrap"><button class="ws-go" data-m="ok">${done ? 'Trotzdem eintragen' : 'Eintragen'}</button></div>`,
    'sheet ws-sheet'
  );
  const read = () => {
    for (const el of modal.querySelectorAll('.ws-in')) draft[el.dataset.f] = el.value.replace(/\s*\n\s*/g, ' ');
  };
  const fit = () => modal.querySelectorAll('.ws-in').forEach(fitTextarea);
  fit();
  requestAnimationFrame(fit);
  const markOpts = () => {
    read();
    modal.querySelectorAll('.ws-opt').forEach((b) => b.classList.toggle('sel', optSel(b.dataset.o)));
  };
  modal.addEventListener('input', () => (fit(), markOpts()));
  modal.addEventListener('click', (e) => {
    const t = e.target.closest('[data-m],[data-w],[data-o]');
    if (!t) return;
    read();
    if (t.dataset.o != null) {
      // Mehrere Vorschläge wählbar: antippen hängt an bzw. nimmt wieder heraus, eigener Text bleibt
      const parts = workParts(draft.work + ',').done;
      const on = parts.some((p) => sameKey(p) === sameKey(t.dataset.o));
      const next = on ? parts.filter((p) => sameKey(p) !== sameKey(t.dataset.o)) : [...parts, t.dataset.o];
      if (next.join(', ').length > MAX_LEN.work) return toast('Kein Platz mehr in dieser Zeile');
      draft.work = next.join(', ');
      modal.querySelector('[data-f="work"]').value = draft.work;
      markOpts();
      fit();
    } else if (t.dataset.w) {
      const which = t.dataset.w;
      const reopen = () => setTimeout(() => openReport(id, draft), 280);
      timePicker(
        which === 'start' ? 'Beginn' : 'Ende',
        draft[which] ?? (which === 'start' ? 8 * 60 : 17 * 60),
        draft[which] != null,
        (v) => {
          draft[which] = v;
          reopen();
        },
        reopen
      );
    } else if (t.dataset.m === 'ok') {
      closeModal();
      enterReport(rep, s, dayIndex, draft);
    } else closeModal();
  });
}

/** Als Zeile eintragen: leere Zeile ersetzen, nach Beginn einsortieren */
function enterReport(rep, s, dayIndex, draft) {
  const day = s.days[dayIndex];
  const row = { ...emptyRow(), start: draft.start, end: draft.end, site: draft.site.trim(), work: draft.work.trim(), report: rep.id };
  const empty = day.rows.findIndex(rowIsEmpty);
  if (empty >= 0) day.rows.splice(empty, 1);
  let at = draft.start == null ? -1 : day.rows.findIndex((r) => r.start != null && r.start > draft.start);
  if (at < 0) at = day.rows.length;
  day.rows.splice(at, 0, row);
  expandedDays.add(`${s.id}:${dayIndex}`);
  saveSheets(s);
  refreshDay(dayIndex);
  toast('Eingetragen');
}

// ───────────────────────── Leiste unten, Darstellung ─────────────────────────

// Ziel, Beschriftung, Symbol und die Seiten, bei denen der Eintrag hervorgehoben ist (Unterseiten gehören zu ihrer Hauptseite)
const TABS = [
  ['#/uebersicht', 'Übersicht', 'tabStats', ['stats', 'payslip', 'year']],
  ['#/', 'Zettel', 'tabZettel', ['list', 'editor', 'trip', 'heft', 'bhWeek', 'bhMonth', 'bhInfo']],
  null,
  ['#/team', 'Team', 'tabTeam', ['team', 'teamSheet']],
  ['#/einstellungen', 'Optionen', 'tabGear', ['settings', 'settingsSub', 'reports', 'report']],
];
/** Unsichtbarer iOS-Schalter über jeder Taste: Der Finger legt ihn um, dabei gibt das iPhone einen Vibrations-Tick
 *  (Safari kennt navigator.vibrate nicht; ein Schalter tickt ab iOS 18). Der Klick geht weiter an die Taste. */
const HAPTIC_SWITCH = '<input type="checkbox" switch class="tap-haptic" tabindex="-1" aria-hidden="true">';
function tabbarHTML() {
  // Symbole in einer eigenen Reihe (die Linse blendet sie per Maske aus); das „+“ liegt darüber in der Mitte
  return `<nav class="tabbar" id="tabbar"><div class="tab-caps"><div class="tab-row">${TABS.map((t) =>
    t
      ? `<div class="tab" role="button" data-act="tab" data-hash="${t[0]}">${ICON[t[2]]}<span>${t[1]}</span>${HAPTIC_SWITCH}</div>`
      : '<span></span>'
  ).join('')}</div><div class="tab-add" role="button" data-act="new" aria-label="Neuer Stundenzettel">${ICON.tabAdd}${HAPTIC_SWITCH}</div></div></nav>`;
}
/** Leiste auf allen Seiten; die aktuelle (Haupt-)Seite hervorheben */
function updateTabbar() {
  const tab = TABS.find((t) => t && t[3].includes(currentView));
  document.body.classList.add('tabs');
  document.querySelectorAll('#tabbar .tab-row > .tab').forEach((b) => b.classList.toggle('on', !!tab && b.dataset.hash === tab[0]));
}

/** Darstellung: „Wie iPhone“ folgt dem Hell-/Dunkelmodus des iPhones */
// Schalter in den Einstellungen; ohne Wahl (auto) wie das iPhone
const isDarkTheme = () => {
  const mode = settings.theme || 'auto';
  return mode === 'dark' || (mode === 'auto' && matchMedia('(prefers-color-scheme: dark)').matches);
};
function applyTheme() {
  const dark = isDarkTheme();
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#02040b' : '#f2f0e9');
}

// ───────────────────────── Icons ─────────────────────────

const svg = (path, size = 22) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
/** Gefülltes Symbol; Löcher (Zeilen, Mitte des Zahnrads) über fill-rule evenodd */
const fillIcon = (d, size = 25) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" aria-hidden="true"><path d="${d}"/></svg>`;
const ICON = {
  plus: svg('<path d="M12 5v14M5 12h14"/>', 20),
  back: svg('<path d="M15 18l-6-6 6-6"/>', 24),
  more: svg('<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>'),
  send: svg('<path d="M4 4h16v16H4z" stroke="none"/><path d="M22 6l-10 7L2 6"/><rect x="2" y="4" width="20" height="16" rx="2"/>', 20),
  check: svg('<path d="M20 6L9 17l-5-5"/>', 14),
  close: svg('<path d="M18 6L6 18M6 6l12 12"/>', 16),
  chevronLeft: svg('<path d="M15 18l-6-6 6-6"/>', 20),
  chevronRight: svg('<path d="M9 18l6-6-6-6"/>', 20),
  chevronDown: svg('<path d="M6 9l6 6 6-6"/>', 16),
  search: svg('<circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>'),
  share: svg('<path d="M12 3v12M8 7l4-4 4 4"/><path d="M7 11H6a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1"/>'),
  up: svg('<path d="M12 19V5M5 12l7-7 7 7"/>', 22),
  pin: svg('<path d="M12 21s-6-5.3-6-10a6 6 0 0 1 12 0c0 4.7-6 10-6 10z"/><circle cx="12" cy="11" r="2.2"/>', 15),
  suitcaseSmall: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>', 16),
  yearCal: svg('<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4M7.5 14h2M11 14h2M14.5 14h2M7.5 17.5h2M11 17.5h2"/>', 22),
  suitcase: svg('<rect x="3" y="7" width="18" height="13" rx="2"/><path d="M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2M3 13h18"/>', 22),
  urlaub: svg('<path d="M12 4a8 8 0 0 1 8 8H4a8 8 0 0 1 8-8z"/><path d="M12 12v7a2 2 0 0 0 4 0"/>', 14),
  krank: svg('<path d="M14 14.8V5a2 2 0 0 0-4 0v9.8a4 4 0 1 0 4 0z"/>', 14),
  feiertag: svg('<path d="M12 3l2.6 5.3 5.9.9-4.3 4.1 1 5.8L12 16.4l-5.2 2.7 1-5.8-4.3-4.1 5.9-.9z"/>', 14),
  frei: svg('<path d="M4 9h12v4a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5z"/><path d="M16 10h1.5a2 2 0 0 1 0 4H16M8 4v2M12 4v2"/>', 14),
  // Berufsschule (nur Tagesart im Berichtsheft)
  schule: svg('<path d="M2 9l10-5 10 5-10 5z"/><path d="M6 11v5c3 2.5 9 2.5 12 0v-5M22 9v5"/>', 14),
  doc: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>', 15),
  // Leiste: gefüllte Symbole (Übersicht als Kacheln, Zettel als zwei Blätter)
  tabZettel: fillIcon('M8 2h10.5A2.5 2.5 0 0 1 21 4.5V17h-2V4.5a.5.5 0 0 0-.5-.5H8zM5.5 5.5h9A2 2 0 0 1 16.5 7.5v12.5a2 2 0 0 1-2 2h-9a2 2 0 0 1-2-2V7.5a2 2 0 0 1 2-2zM6.5 10.2h7v1.8h-7zM6.5 14h7v1.8h-7zM6.5 17.8h4.5v1.8H6.5z'),
  tabStats: fillIcon('M3 5.5A2.5 2.5 0 0 1 5.5 3h3A2.5 2.5 0 0 1 11 5.5v3A2.5 2.5 0 0 1 8.5 11h-3A2.5 2.5 0 0 1 3 8.5zM13 5.5A2.5 2.5 0 0 1 15.5 3h3A2.5 2.5 0 0 1 21 5.5v3a2.5 2.5 0 0 1-2.5 2.5h-3A2.5 2.5 0 0 1 13 8.5zM3 15.5A2.5 2.5 0 0 1 5.5 13h3a2.5 2.5 0 0 1 2.5 2.5v3A2.5 2.5 0 0 1 8.5 21h-3A2.5 2.5 0 0 1 3 18.5zM17 13a4 4 0 1 1 0 8 4 4 0 0 1 0-8z'),
  tabTeam: fillIcon('M9 3.5a3.8 3.8 0 1 1 0 7.6 3.8 3.8 0 0 1 0-7.6zM2 20.2c0-3.9 3.1-6.7 7-6.7s7 2.8 7 6.7v.8H2zM17 5.2a3 3 0 1 1 0 6 3 3 0 0 1 0-6zM17.6 13.6c2.6.3 4.4 2.5 4.4 5.4V21h-4.2v-.8c0-2.6-.8-4.8-2.2-6.4.6-.2 1.3-.3 2-.2z'),
  tabGear: fillIcon('M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1zM15.2 12a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 0 1 6.4 0z'),
  tabAdd: svg('<path d="M12 5v14M5 12h14"/>', 28),
  tool: svg('<path d="M14.7 6.3a4 4 0 0 0-5.4 5.4L3.6 17.4a1.4 1.4 0 0 0 2 2l5.7-5.7a4 4 0 0 0 5.4-5.4l-2.4 2.4-2-2z"/>', 15),
};

// ───────────────────────── Routing ─────────────────────────

const app = document.getElementById('app');
let listScroll = 0;
let currentView = '';
/** Suchbegriff in der Liste; null = Suche geschlossen */
let searchQuery = null;

let routedHash = null;
let routedLen = 0; // history.length beim letzten Seitenwechsel
let routeSkip = false; // nächster Seitenwechsel ist nur der Schritt zurück zum Zettel
function route() {
  if (routeSkip && location.hash === routedHash) {
    routeSkip = false;
    return;
  }
  routeSkip = false;
  // Zettel mit ungespeicherten Änderungen auf einem anderen Weg verlassen (Menü, Arbeitsschein …): erst fragen
  if (currentView === 'editor' && editorPending() && !backTarget && location.hash !== routedHash) {
    const target = location.hash;
    // Neuer Verlaufseintrag: wieder zurückgehen. Mit replaceState stünde der Zettel doppelt im Verlauf, und das
    // nächste Zurück bliebe auf dem doppelten Eintrag hängen (ohne hashchange, backTarget bliebe gesetzt).
    if (history.length > routedLen) {
      routeSkip = true;
      history.back();
    } else history.replaceState(history.state, '', routedHash);
    updateTabbar();
    confirmLeave(() => (location.hash = target));
    return;
  }
  const prevView = currentView;
  pdfPagesView = null; // Vorschau der neuen Seite beginnt beim ersten Blatt
  routedHash = location.hash;
  routedLen = history.length;
  if (backTarget) {
    const here = location.hash || '#/';
    if (here !== backTarget && history.state !== 'root') {
      history.back();
      return;
    }
    const target = backTarget;
    backTarget = null;
    if (here !== target) {
      location.replace(target);
      return;
    }
  }
  const hash = location.hash;
  const m = hash.match(/^#\/zettel\/(.+)$/);
  const tm = hash.match(/^#\/reise\/(.+)$/);
  const lm = hash.match(/^#\/lohn\/(\d{4}-\d{2})$/);
  const jm = hash.match(/^#\/jahr\/(\d{4})$/);
  const am = hash.match(/^#\/arbeitsschein\/(.+)$/);
  const pm = hash.match(/^#\/team\/([^/]+)(?:\/(\d{4}-\d{2}-\d{2}))?$/);
  if (currentView === 'list') listScroll = window.scrollY;
  if (currentView === 'team') teamScroll = window.scrollY;
  if (currentView === 'trip') dropEmptyTrip();
  closeModal(true);
  trimWorkInput(suggestInput);
  hideChips();
  if (tm) {
    currentView = 'trip';
    renderTrip(decodeURIComponent(tm[1]));
    syncNav();
    window.scrollTo(0, 0);
  } else if (m) {
    currentView = 'editor';
    const id = decodeURIComponent(m[1]);
    if (!editorSaved || editorSaved.id !== id || prevView !== 'editor') editorSaved = editorSnapshot(findSheet(id));
    renderEditor(id);
    fetchReports();
    teamLoadForEditor();
    syncNav();
    window.scrollTo(0, 0);
  } else if (/^#\/einstellungen(\/[a-z]+)?$/.test(hash)) {
    currentView = settingsSub() ? 'settingsSub' : 'settings';
    renderSettings();
    syncNav();
    window.scrollTo(0, 0);
  } else if (bhRoute(hash) || fehlerRoute(hash)) {
    syncNav();
    window.scrollTo(0, 0);
  } else if (hash === '#/team') {
    currentView = 'team';
    // Zurück vom Zettel eines Kollegen: an derselben Stelle weiter (auch seitlich); sonst die laufende Woche zeigen
    const back = prevView === 'teamSheet';
    if (!back) teamX = null;
    renderTeam();
    syncNav();
    window.scrollTo(0, back ? teamScroll : 0);
  } else if (pm) {
    // Früher gab es eine Seite mit allen Zetteln eines Kollegen; alte Verweise führen zur Team-Seite
    if (!pm[2]) {
      location.replace('#/team');
      return;
    }
    currentView = 'teamSheet';
    renderTeamSheet(decodeURIComponent(pm[1]), pm[2]);
    syncNav();
    window.scrollTo(0, 0);
  } else if (hash === '#/arbeitsscheine') {
    currentView = 'reports';
    renderReportList();
    syncNav();
    window.scrollTo(0, 0);
  } else if (am) {
    currentView = 'report';
    renderReport(decodeURIComponent(am[1]));
    syncNav();
    window.scrollTo(0, 0);
  } else if (jm) {
    currentView = 'year';
    renderYear(Number(jm[1]));
    syncNav();
    window.scrollTo(0, 0);
  } else if (lm) {
    currentView = 'payslip';
    renderPayslip(lm[1]);
    syncNav();
    window.scrollTo(0, 0);
  } else if (hash === '#/uebersicht') {
    currentView = 'stats';
    renderStats();
    ovcAnimate(document.querySelectorAll('#app [data-ovc]'), null, 120);
    syncNav();
    window.scrollTo(0, 0);
  } else {
    currentView = 'list';
    renderList();
    syncNav();
    window.scrollTo(0, listScroll);
  }
  if (currentView !== 'editor') editorSaved = null;
  updateTopButton();
  updateTabbar();
  pageAnim(prevView, currentView);
}
window.addEventListener('hashchange', route);

/** Ebene jeder Seite: tiefer = von rechts herein, höher = von links, gleich (Leiste) = leicht von unten */
const VIEW_DEPTH = { list: 0, stats: 0, team: 0, teamSheet: 1, settings: 0, settingsSub: 1, trips: 1, reports: 1, editor: 1, payslip: 1, year: 1, trip: 2, report: 2, heft: 1, bhWeek: 2, bhMonth: 2, bhInfo: 2 };
function pageAnim(from, to) {
  if (!from) return;
  const app = document.getElementById('app');
  const d = (VIEW_DEPTH[to] ?? 1) - (VIEW_DEPTH[from] ?? 1);
  app.classList.remove('pg-push', 'pg-pop', 'pg-fade');
  void app.offsetWidth; // Animation neu starten
  app.classList.add(d > 0 ? 'pg-push' : d < 0 ? 'pg-pop' : 'pg-fade');
  clearTimeout(pageAnim.timer);
  // Klasse wieder entfernen, sonst laufen neu gezeichnete Teile (z. B. nach einer Änderung) die Animation erneut
  pageAnim.timer = setTimeout(() => app.classList.remove('pg-push', 'pg-pop', 'pg-fade'), 400);
  if (to === 'stats') statsStagger('#app .ovc, #app .ov-month, #app .ov-totallink');
}
/** Übersicht: Karten bzw. Monatszeilen bauen sich nacheinander auf */
function statsStagger(selector) {
  document.querySelectorAll(selector).forEach((el, i) => {
    el.style.animationDelay = `${60 + i * 28}ms`;
    el.classList.add('stagger');
  });
}

/** Zahlen (Stunden) zählen nach einer Änderung sichtbar zum neuen Wert: vorher Texte merken, danach animieren */
function countSnapshot(selector) {
  const m = new Map();
  document.querySelectorAll(selector).forEach((el, i) => m.set(countKey(el, i), el.textContent));
  return { selector, m };
}
const countKey = (el, i) => {
  const d = el.closest('[data-day]');
  return d ? `d${d.dataset.day}` : `i${i}`;
};
function animateCounts({ selector, m }) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const num = (t) => t.match(/^(\D*?)(-?\d+(?:,\d+)?)(.*)$/s);
  document.querySelectorAll(selector).forEach((el, i) => {
    const before = m.get(countKey(el, i));
    const a = before && num(before);
    const b = num(el.textContent);
    if (!a || !b || a[2] === b[2]) return;
    const from = parseFloat(a[2].replace(',', '.'));
    const to = parseFloat(b[2].replace(',', '.'));
    const dec = (b[2].split(',')[1] || '').length;
    const start = performance.now();
    const step = (now) => {
      const u = Math.min(1, (now - start) / 420);
      const v = from + (to - from) * (1 - Math.pow(1 - u, 3));
      el.textContent = b[1] + v.toFixed(dec).replace('.', ',') + b[3];
      if (u < 1 && el.isConnected) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  });
}

/** Zeile weich aufklappen bzw. zusammenklappen */
/** Höhe samt Innen-/Außenabständen und Rändern: alles muss mitlaufen, sonst springt am Ende ein Rest */
function boxFrame(el) {
  const cs = getComputedStyle(el);
  return {
    height: `${el.offsetHeight}px`,
    paddingTop: cs.paddingTop,
    paddingBottom: cs.paddingBottom,
    marginTop: cs.marginTop,
    marginBottom: cs.marginBottom,
    borderTopWidth: cs.borderTopWidth,
    borderBottomWidth: cs.borderBottomWidth,
    opacity: 1,
  };
}
const ZERO_BOX = { height: '0px', paddingTop: '0px', paddingBottom: '0px', marginTop: '0px', marginBottom: '0px', borderTopWidth: '0px', borderBottomWidth: '0px', opacity: 0 };
function expandIn(el) {
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.style.boxSizing = 'border-box';
  el.style.overflow = 'hidden';
  el.animate([ZERO_BOX, boxFrame(el)], { duration: 300, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' }).onfinish = () => {
    el.style.boxSizing = '';
    el.style.overflow = '';
  };
}
function collapseOut(el, done) {
  if (!el || matchMedia('(prefers-reduced-motion: reduce)').matches) return done();
  el.style.boxSizing = 'border-box';
  el.style.overflow = 'hidden';
  el.animate([boxFrame(el), ZERO_BOX], { duration: 260, easing: 'cubic-bezier(0.4, 0, 0.2, 1)', fill: 'forwards' }).onfinish = done;
}
// Zurück auf einen Eintrag mit derselben Adresse (doppelte Seite) löst kein hashchange aus
window.addEventListener('popstate', () => backTarget && location.hash === routedHash && route());

/**
 * Zurück führt immer eine feste Ebene höher (Abrechnung → Übersicht → Stundenzettel), auch wenn sich im Verlauf
 * doppelte Seiten angesammelt haben (z. B. nach dem Löschen einer Abrechnung oder mehrmaligem Einlesen): route()
 * geht dann weiter zurück, bis die Zielseite erreicht ist. Andere Seiten (Reisekostenabrechnung) wie der Verlauf.
 */
const BACK_TARGETS = [
  [/^#\/(lohn|jahr)\//, '#/uebersicht'],
  [/^#\/arbeitsschein\//, '#/arbeitsscheine'],
  [/^#\/arbeitsscheine$/, '#/einstellungen/scheine'],
  [/^#\/(anleitung|einstellungen\/[a-z]+)$/, '#/einstellungen'], // #/anleitung gab es bis v92
  [/^#\/heft\/[^/]+\/.+$/, () => location.hash.replace(/^(#\/heft\/[^/]+)\/.*$/, '$1')],
  [/^#\/team\/[^/]+\/.+$/, '#/team'],
  [/^#\/fehler$/, '#/team'],
  [/^#\/heft-angaben$/, '#/'],
  [/^#\/(uebersicht|einstellungen|reisekosten|zettel\/.+|heft\/[^/]+)$/, '#/'], // #/reisekosten gab es bis v96
];
let backTarget = null;
function goBack() {
  const t = BACK_TARGETS.find(([re]) => re.test(location.hash));
  const target = t ? (typeof t[1] === 'function' ? t[1]() : t[1]) : null;
  if (history.length > 1 && history.state !== 'root') {
    backTarget = target;
    history.back();
  } else location.hash = target || '#/';
}

// ───────────────────────── Liste ─────────────────────────

function renderList() {
  const searching = searchQuery != null;
  app.innerHTML = `
    <header class="nav">
      ${
        searching
          ? `<div class="search-bar">
              <span class="search-field">${ICON.search}<input type="search" data-search placeholder="Baustelle, Urlaub oder Datum" value="${escapeHtml(searchQuery)}" autocomplete="off" enterkeyhint="search"></span>
              <button class="nav-btn" data-act="search-close">Abbrechen</button>
            </div>`
          : `<span class="nav-btn"></span>
            <span class="nav-title"></span>
            <span class="nav-btn"></span>`
      }
    </header>
    ${
      searching
        ? ''
        : `<div class="title-row"><h1 class="large-title">${bhMode() === 'heft' ? 'Berichtsheft' : 'Stundenzettel'}</h1>${
            sheets.length && bhMode() === 'zettel' ? `<button class="nav-btn" data-act="search" aria-label="Suchen">${ICON.search}</button>` : ''
          }</div>${bhSwitchHTML()}`
    }
    <div id="list-body">${bhMode() === 'heft' && !searching ? heftListHTML() : listBodyHTML()}</div>
    ${
      searching ? `<button class="to-top floating" data-act="to-top" aria-label="Nach oben">${ICON.up}</button>` : ''
    }`;
}

/**
 * Fehlende Zettel: Wochen bzw. Teilwochen (am Monatswechsel) mit Werktagen, für die es keinen Zettel gibt –
 * vom ersten Zettel bis zum letzten Zettel bzw. bis zur aktuellen Woche (die zählt noch nicht).
 * Teilwochen, deren Werktage alle Feiertage sind, fehlen nicht. Ergebnis: Zettel-Vorlagen (nicht gespeichert).
 */
function missingSheets() {
  if (!sheets.length) return [];
  const have = new Set(sheets.map((s) => `${s.weekStart}|${s.year}|${s.month}`));
  let first = sheetFirstDate(sheets[0]);
  for (const s of sheets) if (sheetFirstDate(s) < first) first = sheetFirstDate(s);
  // Nur vergangene Wochen können fehlen – auch wenn schon ein Zettel für später angelegt ist (z. B. Urlaub)
  const end = mondayOf(new Date());
  const out = [];
  for (let d = startOfDay(first); d < end; d = addDays(d, 1)) {
    if ((d.getDay() + 6) % 7 > 4) continue;
    const key = anchorKey(d);
    if (have.has(key)) continue;
    have.add(key);
    const n = newSheet(d, '');
    const workdays = sheetActiveDays(n).filter((i) => i < 5 && sheetDate(n, i) < end);
    if (workdays.length && workdays.every((i) => holidayName(sheetDate(n, i)))) continue;
    out.push(n);
  }
  return out;
}

/** Zeile für eine Lücke (eine oder mehrere fehlende Wochen hintereinander, neueste zuerst) */
function gapRowHTML(gap) {
  const newest = gap[0];
  const oldest = gap.at(-1);
  const partial = (n) => sheetActiveDays(n).length < 7;
  const kw = (n) => isoWeek(parseDate(n.weekStart));
  return `<button class="list-gap" data-act="gap" data-date="${isoDate(sheetFirstDate(oldest))}">
    <span class="list-kw">KW ${gap.length === 1 ? kw(newest) : `${kw(oldest)}–${kw(newest)}`}</span>
    <span class="list-main"><span class="list-title">${fmtDayMonth(sheetFirstDate(oldest))} – ${fmtDayMonth(sheetLastDate(newest))} ${
      gap.length === 1 ? `fehlt${partial(newest) ? ' (Teilwoche)' : ''}` : 'fehlen'
    }</span></span>
  </button>`;
}

function listBodyHTML() {
  const searching = searchQuery != null;
  const query = searching ? parseQuery(searchQuery) : null;
  const groups = new Map();
  const hits = new Map();
  const group = (key) => {
    if (!groups.has(key)) groups.set(key, []);
    return groups.get(key);
  };
  for (const s of sheets) {
    if (query) {
      const hit = searchSheet(s, query);
      if (!hit) continue;
      hits.set(s.id, hit);
    }
    group(s.year * 100 + s.month).push(s);
  }
  // Lücken nur in der normalen Liste, nicht in der Suche
  if (!searching) for (const n of missingSheets()) group(n.year * 100 + n.month).push({ ...n, missing: true });
  const keys = [...groups.keys()].sort((a, b) => b - a);

  if (keys.length) {
    return keys
      .map((k) => {
        const list = groups.get(k).sort((a, b) => sheetFirstDate(b) - sheetFirstDate(a));
        const monthTotal = list.filter((sh) => !sh.missing).reduce((t, sh) => t + sheetTotal(sh), 0);
        // aufeinanderfolgende fehlende Wochen zu einer Zeile zusammenfassen
        const rows = [];
        for (const sh of list) {
          if (sh.missing && Array.isArray(rows.at(-1))) rows.at(-1).push(sh);
          else rows.push(sh.missing ? [sh] : sh);
        }
        return `<h2 class="section-title month-head"><span>${MONTHS[(k % 100) - 1]} ${Math.floor(k / 100)}</span>${searching ? '' : `<span class="month-total">Gesamt ${fmtH(monthTotal)}</span>`}</h2>
        <div class="card list">${rows.map((r) => (Array.isArray(r) ? gapRowHTML(r) : listRowHTML(r, hits.get(r.id)))).join('')}</div>`;
      })
      .join('');
  }
  if (searching) {
    return query
      ? `<p class="search-empty muted">Keine Stundenzettel gefunden</p>`
      : `<p class="search-empty muted">Suche nach Baustelle, Tagesart oder Datum (z. B. „15.09.“).</p>`;
  }
  return `<div class="empty">
      <div class="empty-icon">${svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h5"/>', 44)}</div>
      <p><b>Noch keine Stundenzettel</b></p>
      <p class="muted">${settings.name.trim() ? 'Tippe unten auf „+“ und wähle eine Woche.' : 'Trag zuerst unter „Optionen“ deinen Namen ein.'}</p>
    </div>`;
}

/** Suchbegriff deuten: Datum „15.09.“ / „15.9.26“ / „15.09.2026“ oder Text */
function parseQuery(raw) {
  const q = raw.trim();
  if (!q) return null;
  const m = q.match(/^(\d{1,2})\.(\d{1,2})\.?(\d{2}|\d{4})?$/);
  if (m) {
    const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : null;
    return { day: Number(m[1]), month: Number(m[2]), year };
  }
  return { text: searchKey(q) };
}

/** Treffer in einem Zettel: { label } für die Zeile in der Liste, sonst null */
function searchSheet(s, query) {
  const days = sheetActiveDays(s);
  if (query.text) {
    const found = new Set();
    const statusHits = new Set();
    const dayNames = [];
    for (const i of days) {
      let dayHit = false;
      // Tagesart (Urlaub, Krank, …) zählt als Treffer, die Zeilen des Tages dann nicht
      const status = s.days[i].status;
      if (status) {
        // auch in der angezeigten Sprache („Отпуск“)
        const names = [DAY_STATUS_SHORT[status], DAY_STATUS[status]].flatMap((v) => (typeof tr === 'function' ? [v, tr(v)] : [v]));
        if (names.some((v) => searchKey(v).includes(query.text))) {
          statusHits.add(DAY_STATUS_SHORT[status]);
          dayHit = true;
        }
        // Am Feiertag zählen zusätzlich die Zeilen (Notdienst)
        if (!canWork(s.days[i])) {
          if (dayHit) dayNames.push(WEEKDAYS_SHORT[i]);
          continue;
        }
      }
      for (const r of s.days[i].rows) {
        for (const v of [r.site, r.work]) {
          if (v && searchKey(v).includes(query.text)) {
            found.add(v.trim());
            dayHit = true;
          }
        }
      }
      if (dayHit) dayNames.push(WEEKDAYS_SHORT[i]);
    }
    // Wochentage und Tagesarten werden übersetzt, Einträge nicht
    return found.size || statusHits.size
      ? {
          html: `${dayNames.map((n) => `<span>${n}</span>`).join(', ')} · ${[
            ...[...statusHits].map((v) => `<span>${escapeHtml(v)}</span>`),
            ...[...found].map((v) => `<span translate="no">${escapeHtml(v)}</span>`),
          ].join(', ')}`,
        }
      : null;
  }
  for (const i of days) {
    const d = sheetDate(s, i);
    if (d.getDate() === query.day && d.getMonth() + 1 === query.month && (query.year == null || d.getFullYear() === query.year)) {
      return { html: `<span>${WEEKDAYS[i]}</span>, ${fmtShort(d)}` };
    }
  }
  return null;
}

function refreshListBody() {
  const body = document.getElementById('list-body');
  if (!body) return;
  const key = JSON.stringify(parseQuery(searchQuery || ''));
  if (body.dataset.q === key) return;
  body.dataset.q = key;
  body.innerHTML = listBodyHTML();
}

/** Höhe der festen Kopfzeile, damit Sprungziele nicht darunter verschwinden */
const navHeight = () => document.querySelector('.nav')?.offsetHeight || 0;

/** Die Kopfzeile ist fest (position: fixed), weil iOS eine haftende Kopfzeile beim Nachfedern am Seitenende
 *  mit wegschiebt. Der Inhalt bekommt oben Platz in ihrer Höhe (--nav-h), auch wenn sie ihre Höhe ändert. */
const navResize = new ResizeObserver(() => document.documentElement.style.setProperty('--nav-h', `${navHeight()}px`));
function syncNav() {
  const nav = document.querySelector('.nav');
  document.documentElement.style.setProperty('--nav-h', `${navHeight()}px`);
  navResize.disconnect();
  // Rahmengröße beobachten: Der obere Rand (Uhrzeit, Dynamic Island) steckt im Innenabstand und kommt
  // beim Start teils erst nachträglich dazu – die reine Inhaltshöhe ändert sich dabei nicht
  if (nav) navResize.observe(nav, { box: 'border-box' });
}
new MutationObserver(syncNav).observe(app, { childList: true });

/** Knopf „nach oben“ erst zeigen, wenn weit genug gescrollt wurde */
function updateTopButton() {
  const btn = document.querySelector('.to-top');
  if (btn) btn.classList.toggle('show', window.scrollY > 300);
}
window.addEventListener('scroll', () => requestAnimationFrame(updateTopButton), { passive: true });

const fmtNum = (n) => String(Math.round(n * 10) / 10).replace('.', ',');

const balanceClass = (min) => (min > 0 ? 'plus' : min < 0 ? 'minus' : '');

/** In der Übersicht angezeigtes Jahr (null = laufendes Jahr); bleibt beim Zurückkehren erhalten, solange die App offen ist */
let statsYear = null;

function renderStats() {
  const stats = absenceStats();
  const account = overtimeAccount();
  const current = new Date().getFullYear();
  if (!stats.has(current)) stats.set(current, { urlaub: 0, krank: 0 });
  account.forEach((_, y) => { if (!stats.has(y)) stats.set(y, { urlaub: 0, krank: 0 }); });
  Object.values(payslips).forEach((p) => { if (!stats.has(p.year)) stats.set(p.year, { urlaub: 0, krank: 0 }); });
  const years = [...stats.keys()].sort((a, b) => b - a);
  if (!years.includes(statsYear)) statsYear = current;
  const y = statsYear;
  renderStats.years = years;
  app.innerHTML = `
    <header class="nav">
      <span class="nav-btn"></span>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <div class="title-row">
      <h1 class="large-title">Übersicht</h1>
      <button class="nav-btn ov-yearbtn" data-act="ov-years">${y}${ICON.chevronDown}</button>
    </div>
    ${ovcCardsHTML(y)}
    ${overtimeYearHTML(y, account.get(y) || new Map())}
    <div class="card list ps-import">
      <label class="list-btn">Lohnabrechnung einlesen …<input type="file" accept="image/*" data-act-change="payslip-import" hidden></label>
    </div>
    <p class="footnote">Foto der Abrechnung – sie wird mit deinen Zetteln verglichen.</p>
    ${hasWage() && !lohnJahrBekannt(y) ? `<p class="footnote">Netto geschätzt mit den Steuerwerten von ${y < LOHN_ERSTES ? LOHN_ERSTES : LOHN_LETZTES}.</p>` : ''}
    ${sheets.length ? `<p class="footnote">Überstunden: alles über ${fmtH(Math.round((settings.target * 60) / 5))} pro Werktag. Unvollständige Monate zählen nicht.</p>` : ''}`;
  ovcFit(app);
}

/**
 * Werktage (Mo–Fr ohne Feiertage) eines Monats bis gestern, für die noch nichts eingetragen ist – ein Tag zählt wie im
 * Überstunden-Konto erst mit einer Zeile mit Anfangs- und Enduhrzeit oder mit Urlaub, Krank, Feiertag oder Frei
 */
function monthGaps(year, month) {
  const done = new Set();
  for (const s of sheets) {
    if (s.year !== year || s.month !== month) continue;
    for (const i of sheetActiveDays(s)) {
      const d = s.days[i];
      if (d.status || d.rows.some((r) => r.start != null && r.end != null)) done.add(isoDate(sheetDate(s, i)));
    }
  }
  const today = startOfDay(new Date());
  const gaps = [];
  for (const d = new Date(year, month - 1, 1); d.getMonth() === month - 1 && d < today; d.setDate(d.getDate() + 1)) {
    if (d.getDay() === 0 || d.getDay() === 6 || holidayName(d) || done.has(isoDate(d))) continue;
    gaps.push(new Date(d));
  }
  return gaps;
}

/** Überstunden je Monat ohne die unvollständigen Monate – dort sind alle Stunden normale Arbeitsstunden; der laufende Monat zählt immer */
function countedOvertime(year, months) {
  const now = new Date();
  return new Map([...months].filter(([m]) => (year === now.getFullYear() && m === now.getMonth() + 1) || !monthGaps(year, m).length));
}

/**
 * Je Monat die gearbeiteten Stunden (Stunden Gesamt), die Überstunden und – mit Stundenlohn in den Einstellungen –
 * das geschätzte Netto als Tabelle, neuester Monat oben, darunter die Summe. Laufender Monat: Prognose („≈“).
 * Fehlen in einem Monat Einträge (auch ganze Monate ohne Zettel zwischen dem ersten und dem laufenden bzw. letzten
 * Monat), steht darunter ein Hinweis und das Netto bleibt leer – nur der laufende Monat bekommt die Prognose.
 * Monate mit eingelesener Lohnabrechnung bekommen darunter einen Satz: „Abrechnung stimmt“ oder wie viele Stunden
 * (alle Arten zusammen) und wie viel Netto die Abrechnung weniger bzw. mehr hat als die Zettel; Antippen öffnet den
 * Vergleich. Unter der Summe die Unterschiede aller Abrechnungen des Jahres als Zahlen in den Spalten.
 */
function overtimeYearHTML(year, months) {
  const worked = overtimeAccount(true).get(year) || new Map();
  const total = yearBalance(worked);
  const slips = Object.values(payslips).filter((p) => p.year === year);
  const used = [...new Set([...months.keys(), ...slips.map((p) => p.month)])];
  if (!used.length) return '';
  const now = new Date();
  const isCurrent = (m) => year === now.getFullYear() && m === now.getMonth() + 1;
  const isFuture = (m) => year * 12 + m > now.getFullYear() * 12 + now.getMonth() + 1;
  // Alle Monate des Jahres ab Januar – bis Dezember, im laufenden Jahr bis zum laufenden Monat –, auch solche ganz ohne Zettel
  const last = year < now.getFullYear() ? 12 : Math.max(...used, year === now.getFullYear() ? now.getMonth() + 1 : 0);
  const keys = [];
  for (let m = last; m >= 1; m--) keys.push(m);
  // Der laufende Monat gilt nie als unvollständig, er bekommt stattdessen „laufender Monat“
  const gaps = new Map(keys.map((m) => [m, isCurrent(m) ? [] : monthGaps(year, m)]));
  // Überstunden nur aus vollständigen Monaten (und dem laufenden)
  const ot = keys.reduce((a, m) => a + (gaps.get(m).length ? 0 : months.get(m) || 0), 0);
  const withPay = hasWage();
  /** „3 Werktage ohne Eintrag“ (mit „›“, wenn eine Abrechnung zum Antippen da ist) */
  const gapLine = (m) => {
    const n = gaps.get(m).length;
    return n ? `<div class="ov-verdict gap">${n} ${n === 1 ? 'Werktag' : 'Werktage'} ohne Eintrag</div>` : '';
  };
  const cls = 'ov-row';
  /** „3“, „3,5“, „7,75“ Stunden */
  const hrs = (h) => fmtDec(Math.abs(h) * 60).replace(/,00$/, '').replace(/(,\d)0$/, '$1');
  const ok = (d) => Math.abs(d.h) < 0.01 && Math.abs(d.e) < 0.5;
  /**
   * „zu wenig 3 Std. · 39 € Netto“ bzw. „zu viel …“ – Abrechnung gegenüber den Zetteln; gehen Stunden und Netto in
   * verschiedene Richtungen: „zu wenig 3 Std. · zu viel 39 € Netto“
   */
  const diffText = (d) => {
    const h = Math.abs(d.h) >= 0.01 ? { neg: d.h < 0, t: `${hrs(d.h)} Std.` } : null;
    const e = withPay && Math.abs(d.e) >= 0.5 ? { neg: d.e < 0, t: `${fmtMoney(Math.abs(d.e))} Netto` } : null;
    const word = (x) => `<span>${x.neg ? 'zu wenig' : 'zu viel'}</span>`;
    if (h && e) return h.neg === e.neg ? `${word(h)} ${h.t} · ${e.t}` : `${word(h)} ${h.t} · ${word(e)} ${e.t}`;
    const x = h || e;
    return x ? `${word(x)} ${x.t}` : '';
  };
  const sum = { h: 0, e: 0 };
  const rows = keys
    .map((m) => {
      const v = months.get(m) || 0;
      const slip = payslips[payKey(year, m)];
      let line = '';
      // Unvollständiger Monat: kein Vergleich mit der Abrechnung (Antippen öffnet ihn trotzdem, mit Hinweis)
      // erst nach Monatsende (wie die Jahresseite): im laufenden Monat fehlen noch Tage
      if (slip && !gaps.get(m).length && !isCurrent(m) && !isFuture(m)) {
        const c = payslipCompare(slip);
        const d = { h: HOUR_KINDS.reduce((a, [k]) => a + (slip.hours[k] || 0) - (c.hours[k] || 0), 0), e: c.netDiff || 0 };
        sum.h += d.h;
        sum.e += d.e;
        // Gesamtstunden gleich, aber anders verbucht: Überstunden (wegen des Zuschlags) orange, andere Arten grün
        const off = (k) => Math.abs(c.hourDiff[k]) >= 0.01;
        const euro = withPay && Math.abs(d.e) >= 0.5 ? ` · <span>${d.e < 0 ? 'zu wenig' : 'zu viel'}</span> ${fmtMoney(Math.abs(d.e))} Netto` : '';
        if (Math.abs(d.h) >= 0.01) line = `<div class="ov-verdict ${d.h < 0 || (withPay && d.e <= -0.5) ? 'neg' : 'ok'}">${diffText(d)}</div>`;
        else if (off('ueber')) line = `<div class="ov-verdict neg"><span>Überstunden falsch verbucht</span>${euro}</div>`;
        else if (HOUR_KINDS.some(([k]) => off(k)) || !ok(d))
          line = `<div class="ov-verdict ${d.e < 0 && euro ? 'neg' : 'ok'}"><span>Gesamtstunden stimmen</span>${euro}</div>`;
        else line = `<div class="ov-verdict ok">${ICON.check} Abrechnung stimmt</div>`;
      }
      return `<a draggable="false" href="#/lohn/${payKey(year, m)}" class="ov-month${gaps.get(m).length ? ' has-gap' : ''}">
        <div class="${cls}">
          <span>${MONTHS[m - 1]}</span>
          <span class="ov-n">${fmtH(worked.get(m) || 0)}</span>
          ${gaps.get(m).length ? '<b class="ov-n">–</b>' : `<b class="ov-n ${balanceClass(v)}">${fmtSigned(v)}</b>`}
        </div>
        ${isCurrent(m) ? '<div class="ov-verdict now">laufender Monat</div>' : gapLine(m)}${line}
        <span class="ov-chev">${ICON.chevronRight}</span>
      </a>`;
    })
    .join('');
  // Unter Gesamt nur Abrechnungen vollständiger Monate
  const n = slips.filter((p) => !(gaps.get(p.month) || []).length).length;
  // Unter Gesamt ein Satz über alle Abrechnungen: fehlt etwas orange, sonst (gleich oder mehr) grün
  const short = (withPay && sum.e <= -0.5) || sum.h <= -0.01;
  // „Insgesamt fehlen 10,5 Std. · 135 € Netto“ bzw. „Insgesamt 2 Std. · 30 € Netto mehr bezahlt“ / „Std. und Netto stimmen insgesamt“
  const parts = (pick) =>
    [
      pick(sum.h, 0.01) ? `${hrs(sum.h)} Std.` : '',
      withPay && pick(sum.e, 0.5) ? `${fmtMoney(Math.abs(sum.e))} Netto` : '',
    ].filter(Boolean).join(' · ');
  const less = parts((v, t) => v <= -t);
  const more = parts((v, t) => v >= t);
  const sumText = less
    ? `<span>Insgesamt fehlen</span> ${less}${more ? ` · ${more} <span>mehr</span>` : ''}`
    : more ? `<span>Insgesamt</span> ${more} <span>mehr bezahlt</span>` : withPay ? 'Std. und Netto stimmen insgesamt' : 'Std. stimmen insgesamt';
  const foot = n
    ? `<div class="ov-verdict ov-sumnote ${short ? 'neg' : 'ok'}">${short ? '' : ICON.check}${sumText}</div>`
    : '';
  return `<div class="card ov-months">
    <div class="${cls} ov-head"><span>Monat</span><span class="ov-n">Std.<br>Gesamt</span><span class="ov-n">davon<br>Überstd.</span></div>
    ${rows}
    <a draggable="false" href="#/jahr/${year}" class="ov-totallink">
      <div class="${cls} ov-sum ov-total"><span>Gesamt</span><span class="ov-n">${fmtH(total)}</span><b class="ov-n ${balanceClass(ot)}">${fmtSigned(ot)}</b></div>
      ${foot}
      <span class="ov-chev">${ICON.chevronRight}</span>
    </a>
  </div>`;
}

function listRowHTML(s, hit) {
  const sent = !!s.sentAt;
  return `<div class="swipe">
    <div class="swipe-track">
      <a draggable="false" class="list-row week-row" href="#/zettel/${encodeURIComponent(s.id)}">
        <span class="list-kw ${sent ? '' : 'open'}" aria-label="${sent ? 'gesendet' : 'offen'}">KW ${isoWeek(parseDate(s.weekStart))}</span>
        <span class="list-main">
          <span class="list-title">${fmtDayMonth(sheetFirstDate(s))} – ${fmtDayMonth(sheetLastDate(s))}${sheetHasWarning(s) ? `<span class="list-warn">⚠️</span>` : ''}${
            tripsForSheet(s).some((t) => t.dates.length) ? `<button class="list-trip" data-act="open-trip" data-id="${s.id}" aria-label="Reisekostenabrechnung öffnen">${ICON.suitcaseSmall}</button>` : ''
          }</span>
          ${hit ? `<span class="list-hit">${hit.html}</span>` : ''}
        </span>
        <span class="list-hours">${fmtH(sheetTotal(s))}</span>
      </a>
      <button class="swipe-del" data-act="delete" data-id="${s.id}">Löschen</button>
    </div>
  </div>`;
}

// ───────────────────────── Editor ─────────────────────────

let editorId = null;
let suggestions = { site: [], work: [] };
let workBySite = new Map();
/** Aufgeklappte Tage („Zettel-ID:Tag“): leere Sa/So und Feiertage mit „Arbeit eintragen“, nur solange die App offen ist */
const expandedDays = new Set();

function renderEditor(id) {
  const s = findSheet(id);
  if (!s) {
    location.replace('#/');
    return;
  }
  cancelDrags(false);
  editorId = id;
  refreshSuggestions();

  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <button class="nav-title" data-act="week" id="nav-title">${fmtShort(sheetFirstDate(s))} – ${fmtShort(sheetLastDate(s))}</button>
      <span class="nav-actions">
        <button class="nav-btn" data-act="share" aria-label="Als PDF senden">${ICON.share}</button>
        <button class="nav-btn" data-act="more" aria-label="Weitere Aktionen">${ICON.more}</button>
      </span>
      <div class="daybar" id="daybar">${dayBarHTML(s)}</div>
    </header>
    <div id="days">${daysHTML(s)}</div>
    <div class="sum-bar" id="summary">${summaryHTML(s)}</div>
    ${pdfThumbHTML('Zettel')}`;
  updateSaveBar();
  fitRowTexts();
  requestAnimationFrame(fitRowTexts);
  updatePdfThumb(true);
}

/** Kurze Stundenangabe für die Tagesleiste: „9,5“ */
const fmtTiny = (min) => String(Math.round((min / 60) * 100) / 100).replace('.', ',');

/** Tagesleiste: Mo–So mit Stunden, heute markiert */
function dayBarHTML(s) {
  const today = new Date();
  return `${s.days
    .map((d, i) => {
      if (!sheetIsActive(s, i)) return `<span class="db-day off"><span class="db-name">${WEEKDAYS_SHORT[i]}</span><span class="db-h"></span></span>`;
      const total = dayTotal(d, i);
      const cls = ['db-day', sameDay(sheetDate(s, i), today) ? 'today' : '', d.status ? `status-${d.status} has-status` : ''].join(' ');
      return `<button class="${cls}" data-act="jump" data-day="${i}">
        <span class="db-name">${WEEKDAYS_SHORT[i]}${sheetDayWarning(s, i) ? `<span class="db-warn">⚠️</span>` : ''}</span>
        <span class="db-h">${d.status && !holidayWork(d) ? DAY_STATUS_SHORT[d.status].slice(0, 2) + '.' : total ? fmtTiny(total) : '–'}</span>
      </button>`;
    })
    .join('')}`;
}

/** Alle Tage; zusammenhängende Tage des anderen Monats werden zu einer schmalen Zeile */
function daysHTML(s) {
  let html = '';
  for (let i = 0; i < 7; ) {
    if (sheetIsActive(s, i)) {
      html += dayHTML(s, i);
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < 7 && !sheetIsActive(s, j + 1)) j++;
    const range = i === j ? WEEKDAYS_SHORT[i] : `${WEEKDAYS_SHORT[i]} – ${WEEKDAYS_SHORT[j]}`;
    html += `<div class="other-month">${range} ${i === 0 ? 'vorheriger' : 'nächster'} Monat</div>`;
    i = j + 1;
  }
  return html;
}

/** Leerer Sa/So ohne Tagesart wird eingeklappt angezeigt */
const dayCollapsed = (s, i) => {
  const d = s.days[i];
  return i >= 5 && !d.status && !d.pause && d.rows.every(rowIsEmpty) && !expandedDays.has(`${s.id}:${i}`);
};

/** Tagesart-Kapsel: Knopf mit Auswahl (Mo–Fr ohne Feiertag) oder nur Anzeige; 3 s drücken geht immer (data-hold).
 *  tag = Etikett der kompakten Tagesart-Zeile (mit Symbol und Stunden) */
function statusChipHTML(s, i, tag) {
  const day = s.days[i];
  const cls = `chip-btn status-btn ${tag ? 'set status-tag' : day.status ? 'set status-' + day.status : ''}`;
  const text = tag
    ? `${ICON[day.status]} ${DAY_STATUS_SHORT[day.status]} · ${fmtH(dayCredit(day, i))}`
    : day.status ? DAY_STATUS_SHORT[day.status] : 'Arbeit';
  return i < 5 && day.status !== 'feiertag' && !holidayName(sheetDate(s, i))
    ? `<button class="${cls}" data-act="status" data-hold="status">${text} ▾</button>`
    : `<span class="${cls}" data-hold="status">${text}</span>`;
}

function dayHTML(s, i) {
  const day = s.days[i];
  const date = sheetDate(s, i);
  const head = `<div class="day-head">
      <div class="day-when"><b>${WEEKDAYS[i]}</b> <span class="muted">${fmtDayMonth(date)}</span>${statusWarnHTML(s, i)}${reportChipHTML(s, i)}${teamDayChipHTML(s, i)}</div>
      <div class="day-actions">${statusChipHTML(s, i, false)}</div>
    </div>`;
  if (dayCollapsed(s, i)) {
    return `<section class="day collapsed wd-${i}" data-day="${i}">
      ${head}
      <button class="link-btn expand-btn" data-act="expand">${ICON.plus} Arbeit eintragen</button>
    </section>`;
  }
  const rowsAndFoot = () => `${day.rows.map((r) => rowHTML(day, r)).join('')}
    <div class="day-foot">
      <button class="link-btn" data-act="addrow">${ICON.plus} Zeile</button>
      <button class="pill ${day.pause == null ? 'empty' : ''}" data-act="pause">Pause${day.pause == null ? '' : ` ${fmtH(day.pause)}`}${pauseMissing(day) ? ` <span class="pause-warn">⚠️</span>` : ''}</button>
      <span class="day-total">Gesamt <b>${fmtH(dayTotal(day, i))}</b></span>
    </div>`;
  if (day.status) {
    // Kompakte Zeile: Wochentag links, rechts farbiges Etikett (zugleich Auswahl der Tagesart)
    const holiday = day.status === 'feiertag' ? holidayName(date) : '';
    // Feiertag: darunter Arbeit eintragen (z. B. Notdienst), zählt zusätzlich zu den 8 Stunden
    const working = day.status === 'feiertag' && (holidayWork(day) || expandedDays.has(`${s.id}:${i}`));
    const extra =
      day.status !== 'feiertag'
        ? ''
        : working
          ? rowsAndFoot()
          : `<button class="link-btn expand-btn" data-act="expand">${ICON.plus} Arbeit eintragen (z. B. Notdienst)</button>`;
    return `<section class="day status-day status-${day.status} wd-${i}${working ? ' has-work' : ''}" data-day="${i}">
      <div class="day-head status-head">
        <div class="status-when"><div class="status-day-line"><b>${WEEKDAYS[i]}</b> <span class="muted">${fmtDayMonth(date)}</span>${statusWarnHTML(s, i)}${reportChipHTML(s, i)}${teamDayChipHTML(s, i)}</div>${holiday ? `<div class="status-sub">${escapeHtml(holiday)}</div>` : ''}</div>
        ${statusChipHTML(s, i, true)}
      </div>
      ${extra}
    </section>`;
  }
  return `<section class="day wd-${i}" data-day="${i}">
    ${head}
    ${rowsAndFoot()}
  </section>`;
}

/** Tagesart wählen (Antippen): Feiertage trägt die App selbst ein – an einem Feiertag gibt es keine Auswahl,
 *  sonst ist Feiertag nicht dabei. Von Hand gesetzte Stunden und „von Hand“ fallen damit weg */
function chooseStatus(btn) {
  const { s, dayIndex, day } = rowContext(btn);
  if (dayIndex >= 5 || holidayName(sheetDate(s, dayIndex))) return;
  const set = (status) => {
    if (status) day.status = status;
    else delete day.status;
    delete day.credit;
    delete day.manual;
    saveSheets(s);
    refreshDay(dayIndex);
  };
  const plain = day.credit == null;
  actionSheet([
    { label: `${day.status || !plain ? '' : '✓ '}Arbeit`, run: () => set(null) },
    ...Object.entries(DAY_STATUS_SHORT)
      .filter(([key]) => key !== 'feiertag')
      .map(([key, label]) => ({
        label: `${day.status === key && plain ? '✓ ' : ''}${label}`,
        run: () => set(key),
      })),
  ]);
}

/** Für den Notfall (nicht sichtbar): Kapsel 3 s drücken → jede Tagesart, auch Feiertag, je mit 8 Stunden und ohne,
 *  auch an Sa/So. Der Tag gilt dann als von Hand gesetzt: kein automatischer Feiertag, keine Warnung, an Sa/So bleibt sie */
function chooseStatusHold(el) {
  const { s, dayIndex, day } = rowContext(el);
  const full = Math.round(settings.hoursPerDay * 60);
  const set = (status, credit) => {
    if (status) day.status = status;
    else delete day.status;
    if (status) day.credit = credit;
    else delete day.credit;
    day.manual = true;
    saveSheets(s);
    refreshDay(dayIndex);
  };
  const cur = (status, credit) => (day.status || null) === status && (!status || dayCredit(day, dayIndex) === credit);
  actionSheet([
    { label: `${cur(null) ? '✓ ' : ''}Arbeit`, run: () => set(null) },
    ...Object.entries(DAY_STATUS_SHORT).flatMap(([key, label]) =>
      [full, 0].map((credit) => ({
        label: `${cur(key, credit) ? '✓ ' : ''}${label} <span class="muted">· ${fmtH(credit)}</span>`,
        run: () => set(key, credit),
      }))
    ),
  ]);
}

// Tagesart-Kapsel 3 Sekunden drücken → Auswahl mit allen Tagesarten (chooseStatusHold); nichts davon sichtbar
const STATUS_HOLD = 3000;
let statusPress = null; // { el, x, y, timer }
let statusPressDone = false;
const statusPressEnd = () => {
  if (!statusPress) return;
  clearTimeout(statusPress.timer);
  statusPress = null;
};
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest?.('[data-hold="status"]');
  if (!el || e.button > 0) return;
  statusPressEnd();
  statusPress = {
    el,
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(() => {
      statusPress = null;
      statusPressDone = true;
      haptic();
      chooseStatusHold(el);
    }, STATUS_HOLD),
  };
});
document.addEventListener('pointermove', (e) => {
  if (statusPress && Math.hypot(e.clientX - statusPress.x, e.clientY - statusPress.y) > 10) statusPressEnd();
});
['pointerup', 'pointercancel'].forEach((t) =>
  document.addEventListener(t, () => {
    statusPressEnd();
    // der click zum Loslassen kommt erst danach – egal wie lange gedrückt wurde
    if (statusPressDone) setTimeout(() => (statusPressDone = false), 400);
  })
);
window.addEventListener('scroll', statusPressEnd, { passive: true });
// Nach dem langen Drücken nicht noch die normale Auswahl öffnen
document.addEventListener('click', (e) => {
  if (statusPressDone && (e.target.closest?.('[data-hold="status"]') || layer.contains(e.target))) (e.preventDefault(), e.stopPropagation());
}, true);
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest?.('[data-hold="status"]')) e.preventDefault();
});

function rowHTML(day, r) {
  const rowCount = day.rows.length;
  const m = rowMinutes(r);
  const timeBtn = (which, label) => {
    const v = r[which];
    return `<button class="time ${v == null ? 'empty' : ''}" data-act="time" data-which="${which}">${v == null ? label : fmtTime(v)}</button>`;
  };
  return `<div class="row" data-row="${r.id}">
    <div class="row-times">
      ${timeBtn('start', 'Beginn')}
      <span class="arrow">–</span>
      ${timeBtn('end', 'Ende')}
      <span class="time-warn ${timeWarning(day, r) ? 'show' : ''}" aria-label="Zeit prüfen">⚠️</span>
      <span class="row-hours">${m == null ? '' : fmtH(m)}</span>
      ${rowCount > 1 ? `<button class="row-del" data-act="delrow" aria-label="Zeile löschen">${ICON.close}</button>` : '<span class="row-del-space"></span>'}
    </div>
    <div class="suggest-wrap ${fieldMissing(day, r, 'site') ? 'missing' : ''}"><span class="field-icon">${ICON.pin}</span><span class="warn" aria-label="fehlt">⚠️</span><textarea class="txt" data-f="site" rows="1" placeholder="Ort" maxlength="${MAX_LEN.site}" autocomplete="off" autocapitalize="sentences" enterkeyhint="next">${escapeHtml(r.site)}</textarea></div>
    ${typoHintHTML('site', r)}
    <div class="suggest-wrap ${fieldMissing(day, r, 'work') ? 'missing' : ''}"><span class="field-icon">${ICON.tool}</span><span class="warn" aria-label="fehlt">⚠️</span><textarea class="txt" data-f="work" rows="1" placeholder="Arbeit" maxlength="${MAX_LEN.work}" autocomplete="off" autocapitalize="sentences" enterkeyhint="done">${escapeHtml(r.work)}</textarea></div>
    ${typoHintHTML('work', r)}
  </div>`;
}

function summaryHTML(s) {
  const target = sheetTarget(s);
  return `<div class="sum-pill"><span class="sum-label">Stunden Gesamt</span><b>${fmtH(sheetTotal(s))}</b></div>
    <div class="sum-pill"><span class="sum-label">davon Überstunden</span><span class="sum-value"><b>${fmtH(sheetOvertime(s, target))}</b><span class="sum-sub">ab ${fmtH(Math.round(target * 60))}</span></span></div>`;
}

const currentSheet = () => findSheet(editorId);

function refreshDay(i) {
  cancelDrags(true);
  const s = currentSheet();
  const el = document.querySelector(`.day[data-day="${i}"]`);
  const snap = countSnapshot('.day-total b');
  if (el) el.outerHTML = dayHTML(s, i);
  animateCounts(snap);
  fitRowTexts();
  refreshSummary();
  updateSaveBar();
}

/**
 * Geänderter Tag: weißer Rahmen und „Speichern“ in der Fußzeile an der Stelle von „Gesamt“ (die Summe steht
 * oben in der Tagesleiste). Tage ohne Fußzeile (Urlaub, Krank …) bekommen den Knopf im Kopf.
 */
const daySaveHTML = () => `<button class="day-save-btn" data-act="save-day" aria-label="Eintrag speichern">${ICON.check}<span>Speichern</span></button>`;
function updateSaveBar() {
  const s = currentSheet();
  for (const el of document.querySelectorAll('#days .day')) {
    const dirty = !!s && editorDayDirty(s, Number(el.dataset.day));
    el.classList.toggle('unsaved', dirty);
    const btn = el.querySelector('.day-save-btn');
    if (dirty && !btn) (el.querySelector('.day-foot') || el.querySelector('.day-head')).insertAdjacentHTML('beforeend', daySaveHTML());
    else if (!dirty && btn) btn.remove();
  }
}

/** Getauschte Tage gehören zusammen: „Speichern“ an einem speichert beide (sonst stünde die Arbeit doppelt oder gar nicht da) */
function linkDays(a, b) {
  if (!editorSaved) return;
  const g = (editorSaved.group ||= [0, 1, 2, 3, 4, 5, 6]);
  const from = g[b];
  for (let k = 0; k < 7; k++) if (g[k] === from) g[k] = g[a];
}

/** Einen Tag übernehmen (die anderen Tage bleiben, wie sie sind – außer mit ihm getauschte) */
function saveDay(i) {
  if (document.activeElement && document.activeElement.matches('.txt')) document.activeElement.blur();
  const s = currentSheet();
  if (!s || !editorSaved) return;
  const g = editorSaved.group;
  const days = g ? [0, 1, 2, 3, 4, 5, 6].filter((k) => g[k] === g[i]) : [i];
  for (const k of days) {
    editorSaved.days[k] = structuredClone(s.days[k]);
    editorSaved.dayJson[k] = JSON.stringify(s.days[k]);
    if (g) g[k] = k;
  }
  saveSheets(s);
  refreshSuggestions();
  haptic();
  updateSaveBar();
  updatePdfThumb(true);
}

/** Vorschläge neu sammeln (nach dem Speichern: neue Einträge gleich vorschlagen) */
function refreshSuggestions() {
  suggestions = { site: collectSuggestions('site'), work: collectSuggestions('work') };
  workBySite = collectWorkBySite();
}

/** Alle geänderten Tage übernehmen (vor dem Senden) */
function saveSheetNow() {
  if (document.activeElement && document.activeElement.matches('.txt')) document.activeElement.blur();
  const s = currentSheet();
  if (!s) return;
  editorSaved = editorSnapshot(s);
  saveSheets(s);
  refreshSuggestions();
  haptic();
  updateSaveBar();
  updatePdfThumb(true);
}

/** PDF senden: ungespeicherte Änderungen erst speichern, damit das PDF dem gespeicherten Zettel entspricht */
function sendSheet(s) {
  if (s && editorPending() === s)
    confirmDialog('Erst speichern?', '', 'Speichern und senden', () => {
      saveSheetNow();
      sendWithCheck(s);
    });
  else sendWithCheck(s);
}

/** Ungespeicherte Änderungen verwerfen: zurück zum gespeicherten Stand */
function discardSheet() {
  const s = editorPending();
  if (s) s.days = structuredClone(editorSaved.days);
}

/** Vor dem Verlassen des Zettels mit ungespeicherten Änderungen fragen; go() führt den Weg danach aus */
function confirmLeave(go) {
  confirmDialog('Änderungen verwerfen?', '', 'Verwerfen', () => {
    discardSheet();
    if (currentView === 'editor') refreshAll();
    go();
  }, true, 'Weiter bearbeiten', () => updateTabbar());
}
function refreshSummary() {
  const s = currentSheet();
  const el = document.getElementById('summary');
  const snap = countSnapshot('#summary b, #daybar .db-h');
  if (el) el.innerHTML = summaryHTML(s);
  const bar = document.getElementById('daybar');
  if (bar) bar.innerHTML = dayBarHTML(s);
  animateCounts(snap);
}

/** Warnzeichen eines Tages neu setzen, ohne die Eingabefelder neu zu zeichnen (Fokus bleibt) */
function updateDayWarnings(dayEl, day) {
  if (!dayEl) return;
  for (const rowEl of dayEl.querySelectorAll('.row')) {
    const r = day.rows.find((x) => x.id === rowEl.dataset.row);
    if (!r) continue;
    rowEl.querySelector('.time-warn').classList.toggle('show', timeWarning(day, r));
    for (const f of ['site', 'work']) {
      rowEl.querySelector(`[data-f="${f}"]`).closest('.suggest-wrap').classList.toggle('missing', fieldMissing(day, r, f));
    }
  }
  const pill = dayEl.querySelector('[data-act="pause"]');
  if (pill && day.pause == null) pill.innerHTML = `Pause${pauseMissing(day) ? ` <span class="pause-warn">⚠️</span>` : ''}`;
  const bar = document.getElementById('daybar');
  if (bar) bar.innerHTML = dayBarHTML(currentSheet());
}

/** Zum Tag scrollen, ohne dass er unter der festen Kopfzeile verschwindet */
function jumpToDay(i) {
  const el = document.querySelector(`.day[data-day="${i}"]`);
  if (el) window.scrollTo({ top: el.getBoundingClientRect().top + window.scrollY - navHeight() - 8, behavior: 'smooth' });
}
function refreshAll() {
  const y = window.scrollY;
  renderEditor(editorId);
  window.scrollTo(0, y);
}

function rowContext(el) {
  const s = currentSheet();
  const dayEl = el.closest('.day');
  const rowEl = el.closest('.row');
  const dayIndex = dayEl ? Number(dayEl.dataset.day) : null;
  const day = dayIndex != null ? s.days[dayIndex] : null;
  const rowIndex = rowEl && day ? day.rows.findIndex((r) => r.id === rowEl.dataset.row) : -1;
  return { s, dayIndex, day, rowIndex, row: rowIndex >= 0 ? day.rows[rowIndex] : null };
}

function editTime(btn) {
  const { s, dayIndex, day, rowIndex, row } = rowContext(btn);
  const which = btn.dataset.which;
  let initial = row[which];
  if (initial == null) {
    if (which === 'start') {
      const prev = day.rows.slice(0, rowIndex).reverse().find((r) => r.end != null);
      initial = prev ? prev.end : 8 * 60;
    } else {
      initial = row.start != null ? (row.start + 60) % 1440 : 17 * 60;
    }
  }
  timePicker(which === 'start' ? 'Arbeitsbeginn' : 'Arbeitsende', initial, row[which] != null, (value) => {
    row[which] = value;
    // Ende übernimmt die nächste Zeile automatisch als Beginn
    if (which === 'end' && value != null) {
      const next = day.rows[rowIndex + 1];
      if (next && next.start == null) next.start = value;
    }
    saveSheets(s);
    refreshDay(dayIndex);
  });
  return s;
}

function editPause(btn) {
  const { s, dayIndex, day } = rowContext(btn);
  const step = settings.minuteStep;
  const values = Array.from({ length: 240 / step + 1 }, (_, i) => i * step);
  // wie das Rad: nächstliegender Wert, bei Gleichstand der kleinere
  const nearest = (p) => values.reduce((b, v) => (Math.abs(v - p) < Math.abs(b - p) ? v : b), values[0]);
  const set = (v) => {
    day.pause = v;
    saveSheets(s);
    refreshDay(dayIndex);
  };
  wheelPicker(
    'Pause',
    [{ values, label: (v) => `${fmtH(v)}` }],
    [day.pause],
    // Nicht gedreht: eine Pause außerhalb des Rasters (z. B. eingelesen 0,75 h) bleibt
    ([v]) => set(day.pause != null && !values.includes(day.pause) && v === nearest(day.pause) ? day.pause : v),
    day.pause != null ? `<button class="modal-wide destructive" data-m="extra">Pause löschen</button>` : '',
    () => set(null)
  );
}

/** Woche geändert: Feiertage, die die App eingetragen hatte, bleiben nicht am alten Wochentag stehen; die Feiertage der
 *  neuen Woche gelten auch an Tagen mit Einträgen (wie „Arbeit eintragen“ am Feiertag). Von Hand gesetzte bleiben */
function moveHolidays(s, days, oldStart) {
  days.forEach((d, i) => {
    if (d.manual) return;
    const now = sheetIsActive(s, i) && holidayName(sheetDate(s, i));
    if (d.status === 'feiertag' && !now && holidayName(addDays(parseDate(oldStart), i))) delete d.status;
    else if (!d.status && now) d.status = 'feiertag';
  });
}

function changeWeek() {
  const s = currentSheet();
  weekPicker(sheetFirstDate(s), s.id, (anchor) => {
    if (existingSheet(anchor, s.id)) {
      toast('Für diese Woche gibt es schon einen Stundenzettel');
      return;
    }
    const n = newSheet(anchor, '');
    const moved = { ...s, weekStart: n.weekStart, year: n.year, month: n.month };
    // Tage mit Einträgen, die in der neuen Woche zum anderen Monat gehörten, wären unsichtbar
    const saved = editorSaved && editorSaved.id === s.id ? editorSaved.days : s.days;
    const lost = [0, 1, 2, 3, 4, 5, 6].filter((i) => !sheetIsActive(moved, i) && (dayHasContent(s.days[i]) || dayHasContent(saved[i])));
    if (lost.length) {
      toast(`${lost.map((i) => WEEKDAYS_SHORT[i]).join(', ')}: Einträge lägen im anderen Monat`);
      return;
    }
    const oldStart = s.weekStart;
    s.weekStart = n.weekStart;
    s.year = n.year;
    s.month = n.month;
    moveHolidays(s, s.days, oldStart);
    // Die neue Woche gilt sofort, also auch ihre Feiertage im gespeicherten Stand (sonst stünden sie als ungespeichert da)
    if (editorSaved && editorSaved.id === s.id) {
      moveHolidays(s, editorSaved.days, oldStart);
      editorSaved.dayJson = editorSaved.days.map((d) => JSON.stringify(d));
    }
    saveSheets(s);
    refreshAll();
  });
}

function moreMenu() {
  const s = currentSheet();
  actionSheet([
    { label: 'Als PDF senden', run: () => sendSheet(s) },
    { label: 'Reisekostenabrechnung', run: () => openTripMenu(s) },
    s.sentAt
      ? { label: 'Als offen markieren', run: () => { s.sentAt = null; saveSheets(s); refreshAll(); toast('Als offen markiert'); } }
      : { label: 'Als gesendet markieren', run: () => { s.sentAt = Date.now(); saveSheets(s); refreshAll(); toast('Als gesendet markiert'); } },
    { label: 'Stundenzettel löschen', destructive: true, run: () => askDelete(s.id, true) },
  ]);
}

function sendWithCheck(s) {
  aiTranslateDeep(s);
  const problems = sheetProblems(s);
  if (!problems.length) return sharePdf(s, true);
  // „Trotzdem senden“ ist ein eigenes Antippen – nötig für Zwischenablage und Teilen-Menü
  confirmDialog(
    'Bitte prüfen',
    `<ul class="problem-list">${problems.slice(0, 12).map((p) => `<li>${escapeHtml(p)}</li>`).join('')}${problems.length > 12 ? `<li>… und ${problems.length - 12} weitere</li>` : ''}</ul>`,
    'Trotzdem senden',
    () => sharePdf(s, true),
    false,
    'Zurück'
  );
}

function askDelete(id, leave, onCancel = null) {
  const s = findSheet(id);
  if (!s) return;
  // Abrechnungen sind nur über ihre Zettel erreichbar: eine, zu der danach kein Zettel mehr führt, geht mit
  const orphans = tripsForSheet(s).filter((t) => !sheets.some((x) => x !== s && tripsForSheet(x).includes(t)));
  const withTrip = orphans.some((t) => t.dates.length);
  confirmDialog('Stundenzettel löschen?', `${sheetTitle(s)} wird endgültig gelöscht${withTrip ? ', mit Reisekostenabrechnung' : ''}.`, 'Löschen', () => {
    sheets = sheets.filter((x) => x.id !== id);
    saveSheets();
    if (orphans.length) {
      trips = trips.filter((t) => !orphans.includes(t));
      saveTrips();
    }
    if (leave) goBack();
    else renderList();
  }, true, 'Abbrechen', onCancel);
}

// ───────────────────────── PDF & Senden ─────────────────────────

/** Kyrillische Texte einer Seite vorab übersetzen lassen; kommt Neues, die Vorschau neu zeichnen */
const pdfTranslateKick = (v) => aiTranslateDeep(v).then((fresh) => fresh && updatePdfThumb(true));
/** Dateiname eines PDFs: Art, Name, Rest („Stundenzettel_Max_Muster_13.04.26-19.04.26.pdf“) – beim Arbeitgeber sind die
 *  Zettel der Kollegen so zu unterscheiden. Name wie im PDF (Kyrillisches übersetzt), ohne Zeichen, die in Dateinamen stören;
 *  Unterstriche statt Leerzeichen, Bindestriche ohne Leerzeichen drumherum */
function pdfFileName(kind, name, rest) {
  const n = String(pdfDe({ n: name || '' }).n || '').replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
  const base = [kind, n, rest].filter(Boolean).join(' ').replace(/\s*[-–]\s*/g, '-').trim().replace(/\s+/g, '_');
  return `${base}.pdf`;
}
function pdfFileFor(s) {
  pdfTranslateKick(s);
  const blob = buildTimesheetPdf(pdfDe(s), sheetTarget(s));
  const name = pdfFileName('Stundenzettel', s.name, `${fmtShort(sheetFirstDate(s))} - ${fmtShort(sheetLastDate(s))}`);
  return new File([blob], name, { type: 'application/pdf' });
}

// ───────────────────────── Kein Zoomen ─────────────────────────
// iOS ignoriert „user-scalable=no“ teilweise: Zwei-Finger-Zoom der Seite überall abfangen. Die PDF-Vorschau zoomt
// über eigene Touch-Steuerung und ist davon nicht betroffen.
for (const type of ['gesturestart', 'gesturechange', 'gestureend']) document.addEventListener(type, (e) => e.preventDefault(), { passive: false });
document.addEventListener('touchmove', (e) => e.touches.length > 1 && e.preventDefault(), { passive: false });

// ───────────────────────── PDF-Vorschau ─────────────────────────
// Am Ende des Zettels bzw. der Reisekostenabrechnung eine kleine Vorschau des PDFs (iOS zeigt PDFs direkt als Bild an);
// Antippen öffnet sie groß. Senden geht bewusst nicht aus der Vorschau heraus.

let pdfUrl = null;
let pdfThumbTimer = 0;
/** Mehrere Blätter (je ein PDF mit einer Seite, z. B. Deckblatt und Vorblatt): Adressen und angezeigtes Blatt */
let pdfUrls = [];
let pdfPage = 0;
let pdfPagesView = null;
/** Vorschau neu erzeugen – nach Änderungen kurz gewartet, damit nicht bei jedem Tastendruck ein PDF entsteht */
function updatePdfThumb(now = false) {
  clearTimeout(pdfThumbTimer);
  const run = () => {
    pdfThumbTimer = 0;
    const img = document.getElementById('pdf-thumb');
    if (!img) return;
    if (pdfPagesView !== currentView) (pdfPage = 0), (pdfPagesView = currentView);
    let file = null;
    if (currentView === 'bhInfo') return showPdfPages(img, bhInfoFiles());
    if (currentView === 'trip') {
      const t = currentTrip();
      if (t && t.dates.length) file = tripPdfFile(t);
    } else if (currentView === 'bhWeek' || currentView === 'bhMonth') file = bhPageFile();
    // Zettel: Vorschau zeigt den gespeicherten Stand, Änderungen erst nach „Eintrag speichern“
    else if (currentSheet()) file = pdfFileFor(savedSheet(currentSheet()));
    // Abrechnung ohne Reisetage: noch keine Vorschau
    showPdfPages(img, file ? [file] : []);
  };
  if (now) run();
  else pdfThumbTimer = setTimeout(run, 400);
}
/** Blätter in die Vorschau; bei mehreren mit Pfeilen zum Durchblättern */
function showPdfPages(img, files) {
  const box = img.closest('.pv-box');
  box.hidden = !files.length;
  if (!files.length) return;
  // Alte Vorschau erst später freigeben: lädt sie noch, gäbe es sonst einen Ladefehler
  const old = pdfUrls;
  if (old.length) setTimeout(() => old.forEach((u) => URL.revokeObjectURL(u)), 10000);
  pdfUrls = files.map((f) => URL.createObjectURL(f));
  pdfPage = Math.min(pdfPage, files.length - 1);
  showPdfPage();
}
function showPdfPage() {
  const img = document.getElementById('pdf-thumb');
  if (!img || !pdfUrls.length) return;
  pdfUrl = pdfUrls[pdfPage];
  img.src = pdfUrl;
  const pager = img.closest('.pv-box').querySelector('.pv-pager');
  pager.hidden = pdfUrls.length < 2;
  pager.querySelector('.pv-n').textContent = `${pdfPage + 1} / ${pdfUrls.length}`;
  pager.querySelector('[data-act="pdf-prev"]').disabled = pdfPage === 0;
  pager.querySelector('[data-act="pdf-next"]').disabled = pdfPage === pdfUrls.length - 1;
}

const pdfThumbHTML = (what, wide = false) => `<div class="pv-box">
      <button class="pv-thumb ${wide ? 'wide' : ''}" data-act="pdf-preview" aria-label="PDF-Vorschau vergrößern">
        <img id="pdf-thumb" alt="">
        <span><b>PDF-Vorschau</b><span class="muted">Antippen zum Vergrößern</span></span>
      </button>
      <div class="pv-pager" hidden>
        <button class="pv-arrow" data-act="pdf-prev" aria-label="Vorheriges Blatt">${ICON.chevronLeft}</button>
        <span class="pv-n"></span>
        <button class="pv-arrow" data-act="pdf-next" aria-label="Nächstes Blatt">${ICON.chevronRight}</button>
      </div>
    </div>`;

/**
 * Große Vorschau: Seite auf Breite. Zoomen (zwei Finger, Doppeltipp) und Ziehen (ein Finger, mit Schwung) laufen
 * komplett über eigene Touch-Steuerung per transform – kein Scrollen des Browsers dazwischen, daher kein Zittern.
 */
function openPdfPreview() {
  if (currentView !== 'editor' || pdfThumbTimer || !pdfUrl) updatePdfThumb(true);
  const wide = currentView === 'trip'; // Reisekosten: A4 quer
  const modal = openModal(
    `<div class="pv-head"><span></span><b>Vorschau</b><button class="modal-btn strong" data-m="ok">Fertig</button></div>
    <div class="pv-scroll"><img class="pv-page" src="${pdfUrl}" alt="PDF-Vorschau" draggable="false"></div>`,
    'pv-modal'
  );
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-m="ok"]')) closeModal();
  });
  const box = modal.querySelector('.pv-scroll');
  const page = modal.querySelector('.pv-page');
  const PAD = 12;
  const MAX = 4;
  let vw = 0;
  let vh = 0;
  let w0 = 0; // Seitenbreite bei Zoom 1
  let h0 = 0;
  let s = 1;
  let tx = PAD;
  let ty = PAD;
  // Gezeichnete Größe: Während der Geste wird nur per transform skaliert (flüssig, aber unscharf);
  // danach zeichnet iOS die Seite in der neuen Größe neu (scharf), siehe sharpen()
  let drawn = 1;

  // Grenzen: kleiner als der Ausschnitt → waagerecht mittig, oben bündig; größer → kein Rand ins Leere ziehen
  const bounds = (scale) => {
    const w = w0 * scale;
    const h = h0 * scale;
    const x = w + 2 * PAD <= vw ? [(vw - w) / 2, (vw - w) / 2] : [vw - w - PAD, PAD];
    const y = h + 2 * PAD <= vh ? [PAD, PAD] : [vh - h - PAD, PAD];
    return { x, y };
  };
  const clampTo = (v, [a, b]) => Math.min(b, Math.max(a, v));
  const apply = () => (page.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${s / drawn})`);
  let sharpTimer = 0;
  const sharpen = () => {
    clearTimeout(sharpTimer);
    sharpTimer = setTimeout(() => {
      if (g || Math.abs(drawn - s) < 0.01) return;
      drawn = s;
      page.style.width = `${w0 * s}px`;
      apply();
    }, 120);
  };
  const layout = () => {
    vw = box.clientWidth;
    vh = box.clientHeight;
    w0 = vw - 2 * PAD;
    const ratio = page.naturalWidth ? page.naturalHeight / page.naturalWidth : wide ? 595 / 842 : 842 / 595;
    h0 = w0 * ratio;
    page.style.width = `${w0 * drawn}px`;
    const b = bounds(s);
    tx = clampTo(tx, b.x);
    ty = clampTo(ty, b.y);
    apply();
  };
  page.addEventListener('load', layout);
  requestAnimationFrame(layout);
  const onResize = () => (box.isConnected ? layout() : window.removeEventListener('resize', onResize));
  window.addEventListener('resize', onResize);
  // Fenster zu: Listener gleich abmelden
  new MutationObserver((_, obs) => {
    if (box.isConnected) return;
    window.removeEventListener('resize', onResize);
    obs.disconnect();
  }).observe(layer, { childList: true });

  /** Weich zu einem Zustand gleiten (nach dem Loslassen, Doppeltipp) */
  let anim = 0;
  const animateTo = (ns, nx, ny) => {
    cancelAnimationFrame(anim);
    const [s1, x1, y1] = [s, tx, ty];
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 220);
      const e = 1 - (1 - k) ** 3;
      s = s1 + (ns - s1) * e;
      tx = x1 + (nx - x1) * e;
      ty = y1 + (ny - y1) * e;
      apply();
      if (k < 1) anim = requestAnimationFrame(step);
      else sharpen();
    };
    anim = requestAnimationFrame(step);
  };
  const settle = () => {
    const ns = Math.min(MAX, Math.max(1, s));
    // Beim Zurückfedern des Zooms bleibt die Mitte des Ausschnitts an ihrer Stelle
    const cx = vw / 2;
    const cy = vh / 2;
    let nx = cx - ((cx - tx) / s) * ns;
    let ny = cy - ((cy - ty) / s) * ns;
    const b = bounds(ns);
    nx = clampTo(nx, b.x);
    ny = clampTo(ny, b.y);
    if (ns !== s || nx !== tx || ny !== ty) animateTo(ns, nx, ny);
    else sharpen();
  };

  // Touch: ein Finger zieht, zwei Finger zoomen (Punkt zwischen den Fingern bleibt unter den Fingern)
  let g = null;
  let vel = { x: 0, y: 0, t: 0 };
  let lastTap = { t: 0, x: 0, y: 0 };
  const pt = (e, i) => {
    const r = box.getBoundingClientRect();
    return { x: e.touches[i].clientX - r.left, y: e.touches[i].clientY - r.top };
  };
  const start = (e) => {
    cancelAnimationFrame(anim);
    if (e.touches.length >= 2) {
      const a = pt(e, 0);
      const b = pt(e, 1);
      g = { pinch: true, d: Math.hypot(a.x - b.x, a.y - b.y) || 1, m: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, s, tx, ty, moved: true };
    } else {
      const a = pt(e, 0);
      g = { pinch: false, x: a.x, y: a.y, tx, ty, sx: a.x, sy: a.y, moved: false };
      vel = { x: 0, y: 0, t: performance.now() };
    }
  };
  box.addEventListener(
    'touchstart',
    (e) => {
      e.preventDefault();
      start(e);
    },
    { passive: false }
  );
  box.addEventListener(
    'touchmove',
    (e) => {
      e.preventDefault();
      if (!g) return;
      if (g.pinch && e.touches.length >= 2) {
        const a = pt(e, 0);
        const b = pt(e, 1);
        const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
        // Über die Grenzen hinaus nur gedämpft
        let ns = (g.s * Math.hypot(a.x - b.x, a.y - b.y)) / g.d;
        if (ns > MAX) ns = MAX + (ns - MAX) * 0.3;
        if (ns < 1) ns = 1 - (1 - ns) * 0.3;
        tx = m.x - ((g.m.x - g.tx) / g.s) * ns;
        ty = m.y - ((g.m.y - g.ty) / g.s) * ns;
        s = ns;
        apply();
      } else if (!g.pinch) {
        const a = pt(e, 0);
        if (Math.hypot(a.x - g.sx, a.y - g.sy) > 6) g.moved = true;
        const now = performance.now();
        const dt = Math.max(1, now - vel.t);
        vel = { x: (a.x - g.x) / dt, y: (a.y - g.y) / dt, t: now };
        const b = bounds(s);
        // Am Rand gedämpft weiterziehen
        const soft = (v, [lo, hi]) => (v < lo ? lo - (lo - v) * 0.35 : v > hi ? hi + (v - hi) * 0.35 : v);
        tx = soft(tx + a.x - g.x, b.x);
        ty = soft(ty + a.y - g.y, b.y);
        g.x = a.x;
        g.y = a.y;
        apply();
      }
    },
    { passive: false }
  );
  const end = (e) => {
    e.preventDefault();
    if (!g) return;
    // Von zwei auf einen Finger: nahtlos mit Ziehen weitermachen
    if (e.touches.length === 1) {
      const wasPinch = g.pinch;
      start(e);
      g.moved = wasPinch || g.moved;
      return;
    }
    if (e.touches.length) return;
    const tap = !g.pinch && !g.moved;
    const wasPan = !g.pinch && g.moved;
    g = null;
    if (tap) {
      const now = performance.now();
      const p = { x: e.changedTouches[0].clientX - box.getBoundingClientRect().left, y: e.changedTouches[0].clientY - box.getBoundingClientRect().top };
      if (now - lastTap.t < 320 && Math.hypot(p.x - lastTap.x, p.y - lastTap.y) < 30) {
        // Doppeltipp: an der Stelle auf 2,5-fach, bzw. zurück auf ganze Seite
        lastTap.t = 0;
        const ns = s > 1.05 ? 1 : 2.5;
        const b = bounds(ns);
        animateTo(ns, clampTo(p.x - ((p.x - tx) / s) * ns, b.x), clampTo(p.y - ((p.y - ty) / s) * ns, b.y));
        return;
      }
      lastTap = { t: now, ...p };
      return;
    }
    // Schwung nach dem Ziehen
    if (wasPan && performance.now() - vel.t < 80 && Math.hypot(vel.x, vel.y) > 0.2) {
      let vx = vel.x * 16;
      let vy = vel.y * 16;
      const glide = () => {
        const b = bounds(s);
        tx += vx;
        ty += vy;
        vx *= 0.94;
        vy *= 0.94;
        const out = tx < b.x[0] || tx > b.x[1] || ty < b.y[0] || ty > b.y[1];
        apply();
        if (!out && Math.hypot(vx, vy) > 0.3) anim = requestAnimationFrame(glide);
        else settle();
      };
      anim = requestAnimationFrame(glide);
      return;
    }
    settle();
  };
  box.addEventListener('touchend', end, { passive: false });
  box.addEventListener('touchcancel', end, { passive: false });
  // Gesten des Browsers (Seitenzoom) innerhalb der Vorschau abfangen
  for (const type of ['gesturestart', 'gesturechange', 'gestureend']) box.addEventListener(type, (e) => e.preventDefault());
  // Ohne Touch (Mac): Doppelklick zoomt
  box.addEventListener('dblclick', (e) => {
    const r = box.getBoundingClientRect();
    const p = { x: e.clientX - r.left, y: e.clientY - r.top };
    const ns = s > 1.05 ? 1 : 2.5;
    const b = bounds(ns);
    animateTo(ns, clampTo(p.x - ((p.x - tx) / s) * ns, b.x), clampTo(p.y - ((p.y - ty) / s) * ns, b.y));
  });
}

/** Datei teilen (Teilen-Menü, ohne title/text – in der Mail steht nur der Anhang), sonst herunterladen.
 *  false = im Teilen-Menü abgebrochen */
async function shareOrDownload(file) {
  if (!(navigator.canShare && navigator.canShare({ files: [file] }))) {
    downloadFile(file);
    return true;
  }
  // Doppeltipp (auch auf Knöpfe eines Fensters, das gerade schließt): das zweite Teilen nicht starten
  if (shareOrDownload.busy) return false;
  shareOrDownload.busy = true;
  try {
    await navigator.share({ files: [file] });
  } catch (e) {
    // abgebrochen bzw. es teilt schon: nichts gesendet, nichts herunterladen
    if (e && (e.name === 'AbortError' || e.name === 'InvalidStateError')) return false;
    downloadFile(file);
  } finally {
    shareOrDownload.busy = false;
  }
  return true;
}
function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

async function sharePdf(s, isSend) {
  let file;
  try {
    file = pdfFileFor(s);
  } catch (e) {
    window.fehlerMelden?.(e, 'pdf');
    toast('PDF konnte nicht erstellt werden');
    return;
  }
  // Eine Web-App kann den Mail-Betreff nicht direkt setzen; der Titel kommt in die Zwischenablage.
  if (isSend && navigator.clipboard) {
    navigator.clipboard.writeText(sheetTitle(s)).then(
      () => toast('Betreff kopiert – in Mail bei „Betreff“ einsetzen', 4000),
      () => {}
    );
  }
  if (!(await shareOrDownload(file))) return;
  if (isSend && !s.sentAt) {
    confirmDialog('Wurde der Stundenzettel gesendet?', 'Dann ist die KW in der Liste nicht mehr orange.', 'Ja, gesendet', () => {
      s.sentAt = Date.now();
      saveSheets(s);
      if (currentView === 'editor' && currentSheet() === s) refreshAll();
    });
  }
}

// ───────────────────────── Reisekosten ─────────────────────────
// Abrechnung: { id, sheetId, dates: ['YYYY-MM-DD'], over: { Datum: { start, end, places, works, meal } }, from, to (angezeigte Tage),
//   place, signDate, name, sentAt, createdAt, updatedAt }. Ohne Eintrag in „over“ kommt der Wert aus dem Stundenzettel.

const TRIP_KEY = 'stdprotokoll.trips.v1';
let trips = readJson(TRIP_KEY, []);
let tripId = null;

function saveTrips(changed) {
  if (changed) changed.updatedAt = Date.now();
  if (currentView === 'trip') updatePdfThumb();
  try {
    localStorage.setItem(TRIP_KEY, JSON.stringify(trips));
  } catch (e) {
    window.fehlerMelden?.(e, 'speichern');
    toast('Speichern fehlgeschlagen!');
  }
}
const findTrip = (id) => trips.find((t) => t.id === id);
const currentTrip = () => findTrip(tripId);
const fmtClock = (m) => (m === 1440 ? '24:00' : fmtTime(m));
const fmtEuro = (v) => `${v.toFixed(2).replace('.', ',')} €`;
const fmtStd = (m) => `${String(Math.round((m / 60) * 100) / 100).replace('.', ',')} Std.`;

/** Tag aus dem passenden Stundenzettel (oder null) */
function sheetDayFor(date) {
  const s = existingSheet(date);
  const i = (date.getDay() + 6) % 7;
  return s && sheetIsActive(s, i) ? s.days[i] : null;
}

/** Baustellen zusammenfassen: „Muster GmbH, Nordstadt“ + „Muster GmbH, Südstadt“ → „Muster GmbH, Nordstadt, Südstadt“ */
function joinSites(sites) {
  const groups = [];
  for (const site of sites) {
    const m = site.match(/^([^,]+),\s*(.+)$/);
    const last = groups.at(-1);
    if (m && last && sameKey(last.prefix) === sameKey(m[1])) last.rest.push(m[2].trim());
    else groups.push(m ? { prefix: m[1].trim(), rest: [m[2].trim()] } : { prefix: site, rest: [] });
  }
  return groups.map((g) => [g.prefix, ...g.rest].join(', ')).join(', ');
}
const uniqueTexts = (list) => {
  const seen = new Set();
  return list.filter((v) => v && !seen.has(sameKey(v)) && seen.add(sameKey(v)));
};

/** Reiseanlass aus dem Stundenzettel: Reiseorte (Baustellen) und Tätigkeiten (Art der Arbeit) */
function tripTextFor(day) {
  if (!day || !canWork(day)) return { places: '', works: '' };
  const sites = uniqueTexts(day.rows.map((r) => (r.site || '').trim()));
  const works = uniqueTexts(day.rows.flatMap((r) => (r.work || '').split(',').map((w) => w.trim())));
  return { places: joinSites(sites), works: works.join(', ') };
}

/** Automatische Werte: erster Tag ab Arbeitsbeginn bis 24:00, mittlere Tage ganz, letzter Tag bis Arbeitsende */
function tripAuto(trip, iso) {
  const date = parseDate(iso);
  const prev = trip.dates.includes(isoDate(addDays(date, -1)));
  const next = trip.dates.includes(isoDate(addDays(date, 1)));
  const day = sheetDayFor(date);
  const rows = day && canWork(day) ? day.rows : [];
  const starts = rows.map((r) => r.start).filter((v) => v != null);
  const ends = rows.map((r) => r.end).filter((v) => v != null);
  return {
    start: prev ? 0 : starts.length ? Math.min(...starts) : null,
    end: next ? 1440 : ends.length ? Math.max(...ends) : null,
    ...tripTextFor(day),
    // Nur mehrtägige Reisen: An- und Abreisetag 14 €, volle Tage 28 €
    meal: prev && next ? 28 : prev || next ? 14 : 0,
  };
}

/** Alle Reisetage mit den gültigen Werten (eigene Änderungen vor Werten aus dem Stundenzettel) */
function tripRows(trip) {
  return [...trip.dates].sort().map((iso) => {
    const auto = tripAuto(trip, iso);
    const over = { ...(trip.over[iso] || {}) };
    // Frühere Fassung: ein gemeinsames Textfeld „text“ (Reiseorte, Zeilenumbruch, Tätigkeiten)
    if ('text' in over && !('places' in over) && !('works' in over)) {
      const [first, ...rest] = String(over.text || '').split('\n');
      over.places = first;
      over.works = rest.join(' ');
    }
    const pick = (k) => (k in over ? over[k] : auto[k]);
    const start = pick('start');
    const end = pick('end');
    const places = pick('places') || '';
    const works = pick('works') || '';
    // Im PDF: Reiseorte, darunter die Tätigkeiten
    const text = [places.trim(), works.trim()].filter(Boolean).join('\n');
    const meal = pick('meal') || 0;
    const minutes = start != null && end != null ? (end >= start ? end - start : end + 1440 - start) : null;
    return { iso, date: parseDate(iso), start, end, minutes, places, works, text, meal, auto, over };
  });
}
const tripTotal = (rows) => rows.reduce((t, r) => t + r.meal, 0);
const tripTitle = (trip) => {
  const d = [...trip.dates].sort();
  return d.length ? `Reisekostenabrechnung ${fmtShort(parseDate(d[0]))} - ${fmtShort(parseDate(d.at(-1)))}` : 'Reisekostenabrechnung';
};

/** Abrechnungen, die Tage dieses Stundenzettels enthalten oder von ihm aus angelegt wurden */
function tripsForSheet(s) {
  const dates = new Set(sheetActiveDays(s).map((i) => isoDate(sheetDate(s, i))));
  return trips.filter((t) => t.sheetId === s.id || t.dates.some((d) => dates.has(d)));
}

/** Neue, noch leere Abrechnung anlegen und öffnen; angezeigt werden zunächst die Tage from–to */
function createTrip(from, to, sheet) {
  const t = {
    id: uid(),
    sheetId: sheet ? sheet.id : null,
    dates: [],
    over: {},
    from: isoDate(from),
    to: isoDate(to),
    place: '',
    signDate: isoDate(new Date()),
    name: (sheet && sheet.name) || settings.name,
    sentAt: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  trips.push(t);
  saveTrips();
  location.hash = `#/reise/${t.id}`;
}

function openTripMenu(s) {
  const list = tripsForSheet(s).filter((t) => t.dates.length);
  const create = () => createTrip(sheetFirstDate(s), sheetLastDate(s), s);
  if (!list.length) return create();
  actionSheet([
    ...list.map((t) => ({ label: escapeHtml(tripTitle(t)), run: () => (location.hash = `#/reise/${t.id}`) })),
    { label: 'Neue Reisekostenabrechnung', run: create },
  ]);
}

/** Leere Abrechnungen (kein Tag angetippt) beim Verlassen wieder entfernen */
function dropEmptyTrip() {
  const t = currentTrip();
  if (t && !t.dates.length) {
    trips = trips.filter((x) => x !== t);
    saveTrips();
  }
}

function askDeleteTrip(t) {
  confirmDialog('Abrechnung löschen?', `${escapeHtml(tripTitle(t))} wird endgültig gelöscht.`, 'Löschen', () => {
    trips = trips.filter((x) => x !== t);
    saveTrips();
    goBack();
  }, true, 'Abbrechen');
}

function renderTrip(id) {
  const t = findTrip(id);
  if (!t) {
    location.replace('#/');
    return;
  }
  tripId = id;
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title">Reisekosten</span>
      <span class="nav-actions">
        <button class="nav-btn" data-act="trip-share" aria-label="Als PDF senden">${ICON.share}</button>
        <button class="nav-btn" data-act="trip-more" aria-label="Weitere Aktionen">${ICON.more}</button>
      </span>
    </header>
    <div id="trip-body">${tripBodyHTML(t)}</div>
    ${pdfThumbHTML('Abrechnung', true)}`;
  fitTripTexts();
  updatePdfThumb(true);
}

/** Textfelder so hoch wie ihr Text (auch nach dem Öffnen und beim Drehen des Geräts) */
function fitTripTexts() {
  const fit = () => document.querySelectorAll('.trip-text').forEach(fitTextarea);
  fit();
  requestAnimationFrame(fit);
}
window.addEventListener('resize', () => currentView === 'trip' && fitTripTexts());

function tripBodyHTML(t) {
  const rows = tripRows(t);
  const selected = new Set(t.dates);
  // Angezeigte Tage: Bereich der Abrechnung, mindestens alle angetippten Tage
  const sorted = [...t.dates].sort();
  let from = parseDate(sorted[0] && sorted[0] < t.from ? sorted[0] : t.from);
  const to = parseDate(sorted.at(-1) && sorted.at(-1) > t.to ? sorted.at(-1) : t.to);
  const picks = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const iso = isoDate(d);
    const day = sheetDayFor(d);
    const info = !day ? '' : day.status ? DAY_STATUS_SHORT[day.status] : joinSites(uniqueTexts(day.rows.map((r) => (r.site || '').trim())));
    picks.push(`<button class="trip-pick ${selected.has(iso) ? 'on' : ''}" data-act="trip-toggle" data-date="${iso}">
        <span class="trip-check">${selected.has(iso) ? ICON.check : ''}</span>
        <span class="trip-pick-day">${WEEKDAYS_SHORT[(d.getDay() + 6) % 7]} ${fmtDayMonth(d)}</span>
        <span class="trip-pick-info muted" translate="no">${escapeHtml(info) || '–'}</span>
      </button>`);
  }
  const sig = isSignature(t.signature);
  return `
    <h2 class="section-title">Reisetage</h2>
    <div class="card list">${picks.join('')}</div>
    <div class="trip-range">
      <button class="link-btn" data-act="trip-range" data-dir="-1">${ICON.chevronLeft} Woche davor</button>
      <button class="link-btn" data-act="trip-range" data-dir="1">Woche danach ${ICON.chevronRight}</button>
    </div>
    <p class="footnote">Reisetage antippen.</p>
    ${rows.map(tripDayHTML).join('')}
    ${
      rows.length
        ? `<h2 class="section-title">Abschluss</h2>
    <div class="card form">
      <label class="field"><span>Ort</span><input data-tp="place" placeholder="z. B. Firmensitz" value="${escapeHtml(t.place || '')}" enterkeyhint="done"></label>
      ${pdfHintHTML(t.place)}
      <label class="field"><span>Datum</span><input type="date" data-tp="signDate" value="${t.signDate || ''}"></label>
      ${sig ? `<div class="field sig-field"><span>Unterschrift</span>${signatureSVG(t.signature)}</div>` : ''}
      <button class="list-btn" data-act="trip-sign">${sig ? 'Neu unterschreiben …' : 'Unterschreiben …'}</button>
    </div>
    <div class="card summary"><div class="sum-row"><span>Gesamtsumme</span><b id="trip-total">${fmtEuro(tripTotal(rows))}</b></div></div>`
        : ''
    }`;
}

function tripDayHTML(r) {
  const wd = WEEKDAYS[(r.date.getDay() + 6) % 7];
  const timeBtn = (which, label) =>
    `<button class="time ${r[which] == null ? 'empty' : ''}" data-act="trip-time" data-which="${which}">${r[which] == null ? label : fmtClock(r[which])}</button>`;
  return `<section class="day trip-day wd-${(r.date.getDay() + 6) % 7}" data-date="${r.iso}">
    <div class="day-head"><div><b>${wd}</b> <span class="muted">${fmtDayMonth(r.date)}</span></div><span class="muted trip-std">${r.minutes == null ? '' : fmtStd(r.minutes)}</span></div>
    <div class="row">
      <div class="row-times">
        ${timeBtn('start', 'Beginn')}
        <span class="arrow">–</span>
        ${timeBtn('end', 'Ende')}
        ${r.start == null || r.end == null || tripDayIssues(r).length ? `<span class="time-warn show">⚠️</span>` : ''}
      </div>
      ${tripDayIssues(r)
        .map((x) => `<p class="trip-issue">⚠️ ${escapeHtml(x)}</p>`)
        .join('')}
      <div class="trip-field"><span class="field-icon">${ICON.pin}</span><textarea class="trip-text" data-t="places" rows="1" maxlength="${TRIP_MAX_LEN}" placeholder="Reiseorte (Baustellen)" autocapitalize="sentences">${escapeHtml(r.places)}</textarea></div>
      ${pdfHintHTML(r.places)}
      <div class="trip-field"><span class="field-icon">${ICON.tool}</span><textarea class="trip-text" data-t="works" rows="1" maxlength="${TRIP_MAX_LEN}" placeholder="Tätigkeiten" autocapitalize="sentences">${escapeHtml(r.works)}</textarea></div>
      ${pdfHintHTML(r.works)}
    </div>
    <div class="day-foot">
      <span>Verpflegung</span>
      <label class="trip-meal"><input data-t="meal" type="text" inputmode="decimal" value="${r.meal ? r.meal.toFixed(2).replace('.', ',') : ''}" placeholder="0,00" enterkeyhint="done"> €</label>
    </div>
  </section>`;
}

/** Ansicht neu aufbauen, Scroll-Position bleibt */
function refreshTrip() {
  const t = currentTrip();
  const body = document.getElementById('trip-body');
  if (!t || !body) return;
  const y = window.scrollY;
  body.innerHTML = tripBodyHTML(t);
  fitTripTexts();
  window.scrollTo(0, y);
}
/** Baustelle / Art der Arbeit: Feld so hoch wie sein Text (mehrzeilig statt rechts abgeschnitten) */
const fitRowTexts = () => document.querySelectorAll('textarea.txt').forEach(fitTextarea);
window.addEventListener('resize', () => currentView === 'editor' && fitRowTexts());
const fitTextarea = (el) => {
  el.style.height = 'auto';
  // + Rahmen (Linie unten), weil die Höhe den Rahmen mit einschließt
  el.style.height = `${el.scrollHeight + el.offsetHeight - el.clientHeight}px`;
};

function setTripOver(t, iso, key, value) {
  t.over[iso] = { ...(t.over[iso] || {}), [key]: value };
  saveTrips(t);
}

function editTripTime(btn) {
  const t = currentTrip();
  const iso = btn.closest('[data-date]').dataset.date;
  const which = btn.dataset.which;
  const r = tripRows(t).find((x) => x.iso === iso);
  const initial = r[which] ?? (which === 'start' ? 6 * 60 : 18 * 60);
  const step = settings.minuteStep;
  const hours = Array.from({ length: 25 }, (_, i) => i);
  const minutes = Array.from({ length: 60 / step }, (_, i) => i * step);
  wheelPicker(
    which === 'start' ? 'Reisebeginn' : 'Reiseende',
    [
      { values: hours, label: pad },
      { values: minutes, label: pad, sep: ':' },
    ],
    [Math.floor(initial / 60), initial % 60],
    ([h, m]) => {
      setTripOver(t, iso, which, Math.min(h * 60 + m, 1440));
      refreshTrip();
    },
    which in r.over ? `<button class="modal-wide" data-m="extra">Wie im Stundenzettel</button>` : '',
    () => {
      delete t.over[iso][which];
      saveTrips(t);
      refreshTrip();
    }
  );
}

function toggleTripDay(iso) {
  const t = currentTrip();
  if (t.dates.includes(iso)) t.dates = t.dates.filter((d) => d !== iso);
  else t.dates.push(iso);
  saveTrips(t);
  refreshTrip();
}

function shiftTripRange(dir) {
  const t = currentTrip();
  if (dir < 0) t.from = isoDate(addDays(parseDate(t.from), -7));
  else t.to = isoDate(addDays(parseDate(t.to), 7));
  saveTrips(t);
  refreshTrip();
}

function tripMoreMenu() {
  const t = currentTrip();
  actionSheet([
    { label: 'Als PDF senden', run: () => sendTripWithCheck(t) },
    {
      label: 'Neu aus Stundenzettel übernehmen',
      run: () =>
        confirmDialog('Neu übernehmen?', 'Deine Änderungen an Uhrzeiten, Reiseanlass und Verpflegung werden verworfen.', 'Übernehmen', () => {
          t.over = {};
          saveTrips(t);
          refreshTrip();
        }),
    },
    t.sentAt
      ? { label: 'Als offen markieren', run: () => { t.sentAt = null; saveTrips(t); toast('Als offen markiert'); } }
      : { label: 'Als gesendet markieren', run: () => { t.sentAt = Date.now(); saveTrips(t); toast('Als gesendet markiert'); } },
    {
      label: 'Abrechnung löschen',
      destructive: true,
      run: () => askDeleteTrip(t),
    },
  ]);
}

/**
 * Widersprüche eines Reisetags zum Stundenzettel: kein Zettel / kein Eintrag / Urlaub, Krank, Frei an dem Tag;
 * Reise beginnt nach dem Arbeitsbeginn bzw. endet vor dem Arbeitsende (nur An- und Abreisetag, 0:00/24:00 zählt nicht).
 */
function tripDayIssues(r) {
  const day = sheetDayFor(r.date);
  if (!day) return ['Kein Stundenzettel für diesen Tag'];
  if (!canWork(day)) return [`Im Stundenzettel als ${DAY_STATUS_SHORT[day.status]} eingetragen`];
  const rows = day.rows.filter((x) => !rowIsEmpty(x));
  if (!rows.length) return ['Im Stundenzettel kein Eintrag'];
  const issues = [];
  const starts = rows.map((x) => x.start).filter((v) => v != null);
  const ends = rows.map((x) => x.end).filter((v) => v != null);
  const workStart = starts.length ? Math.min(...starts) : null;
  const workEnd = ends.length ? Math.max(...ends) : null;
  if (r.start != null && r.start > 0 && workStart != null && r.start > workStart)
    issues.push(`Reise beginnt ${fmtClock(r.start)}, Arbeit laut Zettel schon ${fmtTime(workStart)}`);
  if (r.end != null && r.end < 1440 && workEnd != null && r.end < workEnd)
    issues.push(`Reise endet ${fmtClock(r.end)}, Arbeit laut Zettel erst ${fmtTime(workEnd)}`);
  return issues;
}

function tripProblems(t) {
  const problems = [];
  if (!(t.name || settings.name).trim()) problems.push('Name fehlt (in den Einstellungen)');
  for (const r of tripRows(t)) {
    const day = `${WEEKDAYS_SHORT[(r.date.getDay() + 6) % 7]} ${fmtDayMonth(r.date)}`;
    const missing = [r.start == null && 'Beginn', r.end == null && 'Ende', !r.text.trim() && 'Reiseanlass'].filter(Boolean);
    if (missing.length) problems.push(`${day}: ${missing.join(', ')} ${missing.length > 1 ? 'fehlen' : 'fehlt'}`);
    for (const issue of tripDayIssues(r)) problems.push(`${day}: ${issue}`);
    for (const [f, label] of [['places', 'Reiseorte'], ['works', 'Tätigkeiten']]) {
      const h = pdfCharHint(r[f]);
      if (h) problems.push(`${day}, ${label}: ${h}`);
    }
  }
  if (!(t.place || '').trim()) problems.push('Ort fehlt');
  if (pdfCharHint(t.place)) problems.push(`Ort: ${pdfCharHint(t.place)}`);
  if (pdfCharHint(t.name || settings.name)) problems.push(`Name: ${pdfCharHint(t.name || settings.name)}`);
  if (!isSignature(t.signature)) problems.push('Unterschrift fehlt');
  return problems;
}

function sendTripWithCheck(t) {
  if (!t.dates.length) return toast('Bitte zuerst die Reisetage antippen');
  const problems = tripProblems(t);
  if (!problems.length) return shareTripPdf(t);
  confirmDialog(
    'Bitte prüfen',
    `<ul class="problem-list">${problems.map((p) => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`,
    'Trotzdem senden',
    () => shareTripPdf(t),
    false,
    'Zurück'
  );
}

function tripPdfFile(t) {
  const rows = tripRows(t);
  const sorted = rows.map((r) => r.date);
  pdfTranslateKick({ t, rows, name: settings.name });
  const blob = buildTravelPdf(pdfDe({
    title: tripTitle(t),
    name: t.name || settings.name,
    from: fmtShort(sorted[0]),
    to: fmtShort(sorted.at(-1)),
    rows,
    total: tripTotal(rows),
    place: (t.place || '').trim(),
    signDate: t.signDate ? fmtShort(parseDate(t.signDate)) : '',
    signature: isSignature(t.signature) ? t.signature : null,
  }));
  return new File([blob], pdfFileName('Reisekostenabrechnung', t.name || settings.name, tripTitle(t).replace(/^Reisekostenabrechnung ?/, '')), { type: 'application/pdf' });
}

async function shareTripPdf(t) {
  let file;
  try {
    file = tripPdfFile(t);
  } catch (e) {
    window.fehlerMelden?.(e, 'pdf');
    toast('PDF konnte nicht erstellt werden');
    return;
  }
  if (navigator.clipboard) {
    navigator.clipboard.writeText(tripTitle(t)).then(
      () => toast('Betreff kopiert – in Mail bei „Betreff“ einsetzen', 4000),
      () => {}
    );
  }
  if (!(await shareOrDownload(file))) return;
  if (!t.sentAt) {
    confirmDialog('Wurde die Abrechnung gesendet?', 'Dann wird sie als gesendet markiert.', 'Ja, gesendet', () => {
      t.sentAt = Date.now();
      saveTrips(t);
    });
  }
}

// ───────────────────────── Unterschrift ─────────────────────────
// Gespeichert als Linienzüge: { ratio: Höhe/Breite, strokes: [[[x, y], …], …] } mit x, y zwischen 0 und 1

function signatureSVG(sig, height = 44) {
  const ratio = sig.ratio || 0.35;
  const paths = sig.strokes
    .map((st) => `<polyline points="${st.map(([x, y]) => `${(x * 100).toFixed(1)},${(y * ratio * 100).toFixed(1)}`).join(' ')}"/>`)
    .join('');
  return `<svg class="sig-preview" viewBox="0 0 100 ${(ratio * 100).toFixed(1)}" height="${height}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
}

/** Gültige Unterschrift? { ratio, strokes: [[[x, y], …], …] } */
const isSignature = (sig) =>
  !!sig && typeof sig.ratio === 'number' && Array.isArray(sig.strokes) && sig.strokes.length > 0 &&
  sig.strokes.every((st) => Array.isArray(st) && st.length > 0 && st.every((p) => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite)));

/** Unterschreiben; onSave bekommt die Unterschrift */
function signaturePad(onSave, title = 'Unterschrift') {
  const modal = openModal(
    `${modalHead(title)}
    <div class="sig-wrap"><canvas class="sig-canvas"></canvas><div class="sig-line"></div><span class="sig-hint muted">Mit dem Finger unterschreiben</span></div>
    <button class="modal-wide" data-m="clear">Neu beginnen</button>`,
    'sheet'
  );
  const canvas = modal.querySelector('canvas');
  const hint = modal.querySelector('.sig-hint');
  const w = modal.querySelector('.sig-wrap').clientWidth;
  const h = Math.round(w * 0.4);
  const dpr = window.devicePixelRatio || 1;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  // feste Größe: dreht man das iPhone, verzerrt sich die Unterschrift sonst (Breite folgte dem Fenster, ratio nicht)
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.lineWidth = 2.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = getComputedStyle(document.body).color;
  let strokes = [];
  let current = null;
  let finger = null; // nur ein Finger zeichnet (ein aufliegender Daumen nicht)
  const point = (e) => {
    const r = canvas.getBoundingClientRect();
    return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
  };
  canvas.addEventListener('pointerdown', (e) => {
    if (current) return;
    canvas.setPointerCapture(e.pointerId);
    finger = e.pointerId;
    const p = point(e);
    current = [p];
    strokes.push(current);
    hint.hidden = true;
    // Punkt gleich zeigen (i-Punkt, Antippen) – wie später im PDF
    ctx.beginPath();
    ctx.arc(p[0] * w, p[1] * h, ctx.lineWidth / 2, 0, Math.PI * 2);
    ctx.fillStyle = ctx.strokeStyle;
    ctx.fill();
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!current || e.pointerId !== finger) return;
    const p = point(e);
    const last = current.at(-1);
    current.push(p);
    ctx.beginPath();
    ctx.moveTo(last[0] * w, last[1] * h);
    ctx.lineTo(p[0] * w, p[1] * h);
    ctx.stroke();
  });
  const stop = (e) => {
    if (e.pointerId === finger) current = finger = null;
  };
  canvas.addEventListener('pointerup', stop);
  canvas.addEventListener('pointercancel', stop);
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    if (b.dataset.m === 'clear') {
      strokes = [];
      current = finger = null;
      ctx.clearRect(0, 0, w, h);
      hint.hidden = false;
      return;
    }
    if (b.dataset.m === 'ok' && strokes.length) {
      // Nur Antippen ist keine Unterschrift
      if (!strokes.some((st) => st.length > 1)) {
        hint.hidden = false;
        return;
      }
      const round = (v) => Math.round(v * 1000) / 1000;
      // Ein Punkt wird zu einem kurzen Strich: so zeigen ihn Vorschau (SVG) und PDF gleich
      const sig = { ratio: round(h / w), strokes: strokes.map((st) => (st.length > 1 ? st : [st[0], [st[0][0] + 0.004, st[0][1]]]).map(([x, y]) => [round(x), round(y)])) };
      closeModal();
      return onSave(sig);
    }
    closeModal();
  });
}

// ───────────────────────── Einstellungen ─────────────────────────

/** Symbole der Einstellungen: weiße Zeichen auf farbigem Quadrat (wie in den iPhone-Einstellungen) */
const SET_ICON = {
  contrast: '<circle cx="12" cy="12" r="8" fill="none" stroke="#fff" stroke-width="2"/><path d="M12 4a8 8 0 0 1 0 16z"/>',
  person: '<circle cx="12" cy="8.5" r="3.6"/><path d="M5 19.5c.9-3.6 3.7-5.5 7-5.5s6.1 1.9 7 5.5z"/>',
  face: '<path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 15.5c1.4 1.2 3.6 1.2 5 0" fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round"/>',
  euro: '<path d="M17 6.5A6.5 6.5 0 0 0 7.2 10M17 17.5A6.5 6.5 0 0 1 7.2 14M4.5 10.5h9M4.5 13.5h8" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  case: '<path d="M9 6V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v1h4a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2zm2 0h2V5h-2z"/>',
  text: '<path d="M4 6h16M4 11h16M4 16h10" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>',
  doc: '<path d="M7 3h7l5 5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zm6 1.5V9h4.5"/>',
  cloud: '<path d="M7 19a5 5 0 0 1-.6-9.96A6.5 6.5 0 0 1 19 10.5a4.25 4.25 0 0 1-.5 8.5z"/>',
  book: '<path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5a1.5 1.5 0 0 0 0 3H19M8 7h7" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round"/>',
  globe: '<circle cx="12" cy="12" r="8" fill="none" stroke="#fff" stroke-width="1.8"/><path d="M4 12h16M12 4c2.5 2.3 2.5 13.7 0 16M12 4c-2.5 2.3-2.5 13.7 0 16" fill="none" stroke="#fff" stroke-width="1.6"/>',
};
const SET_COLOR = { indigo: '#5856d6', green: '#34c759', blue: '#2f6bff', orange: '#ff9500', teal: '#30b0c7', purple: '#af52de', gray: '#8e8e93' };
const setIcon = (name, color) => `<span class="s-ico" style="background:${SET_COLOR[color]}"><svg viewBox="0 0 24 24" fill="#fff">${SET_ICON[name]}</svg></span>`;
const setLink = (hash, icon, color, label, value = '') =>
  `<a draggable="false" class="s-row" href="${hash}">${setIcon(icon, color)}<span class="s-label">${label}</span><span class="s-val">${escapeHtml(value)}</span><span class="s-chev">${ICON.chevronRight}</span></a>`;
const setToggle = (icon, color, label, attrs) =>
  `<label class="s-row">${setIcon(icon, color)}<span class="s-label">${label}</span><input type="checkbox" class="toggle" ${attrs}></label>`;

/** Unterseiten der Einstellungen: #/einstellungen/<name> */
const SETTINGS_PAGES = {
  lohn: 'Lohn',
  vorschlaege: 'Vorschläge',
  scheine: 'Arbeitsscheine',
  sicherung: 'Datensicherung',
  konto: 'Konto',
};
const settingsSub = () => {
  const s = (location.hash.match(/^#\/einstellungen\/([a-z]+)$/) || [])[1] || '';
  return SETTINGS_PAGES[s] ? s : '';
};

/** Kurze Zusammenfassung rechts in der Übersicht */
function settingsSummary() {
  const roman = ['I', 'II', 'III', 'IV', 'V', 'VI'][Number(settings.taxClass || 1) - 1] || 'I';
  const url = (settings.reportUrl || '').trim();
  const n = reports().length;
  return {
    lohn: settings.wage ? `${settings.wage} € · Kl. ${roman}` : `Klasse ${roman}`,
    vorschlaege: ((n) => (n ? `${n} von 3 aus` : 'alles an'))(['typoHints', 'suggestBar', 'warnSigns'].filter((k) => settings[k] === false).length),
    scheine: url ? `${n}${reportStore.at ? ` · ${sameDay(new Date(reportStore.at), new Date()) ? 'heute' : fmtDayMonth(new Date(reportStore.at))} abgeholt` : ''}` : 'nicht eingerichtet',
    sicherung: ['von Hand', backupEncrypted() ? 'verschlüsselt' : ''].filter(Boolean).join(' · '),
    konto: account ? account.user : 'Nicht angemeldet',
  };
}

function renderSettings() {
  const sub = settingsSub();
  if (sub && SETTINGS_PAGES[sub]) return renderSettingsPage(sub);
  const name = settings.name.trim();
  const initials = name ? name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase() : '?';
  const sum = settingsSummary();
  app.innerHTML = `
    <header class="nav">
      <span class="nav-btn"></span>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title">Einstellungen</h1>
    <div class="card s-group s-me">
      <div class="s-profile">
        <span class="s-avatar">${escapeHtml(initials)}</span>
        <label class="s-pname s-namefield">
          <input data-s="name" placeholder="Name eintragen" value="${escapeHtml(settings.name)}" autocomplete="name" enterkeyhint="done">
          <span>Steht auf jedem neuen Stundenzettel</span>
        </label>
        ${pdfHintHTML(settings.name)}
      </div>
      ${setLink('#/einstellungen/konto', 'person', 'gray', 'Konto', sum.konto)}
    </div>
    <div class="card s-group">
      <div class="s-row">${setIcon('contrast', 'indigo')}<span class="s-label">Design</span>
        <span class="s-seg">${[['light', 'Hell'], ['dark', 'Dunkel']]
          .map(([v, l]) => `<button data-act="theme-set" data-v="${v}" class="${(isDarkTheme() ? 'dark' : 'light') === v ? 'on' : ''}">${l}</button>`)
          .join('')}</span></div>
      <div class="s-row">${setIcon('globe', 'blue')}<span class="s-label">Sprache</span>
        <span class="s-seg" translate="no">${[['de', 'Deutsch'], ['ru', 'Русский']]
          .map(([v, l]) => `<button data-act="lang-set" data-v="${v}" class="${LANG === v ? 'on' : ''}">${l}</button>`)
          .join('')}</span></div>
      ${lockAvailable() ? setToggle('face', 'green', 'Mit Face ID sperren', `data-lock-switch ${lockOn() ? 'checked' : ''}`) : ''}
    </div>
    <div class="card s-group">
      ${setLink('#/einstellungen/lohn', 'euro', 'blue', 'Lohn', sum.lohn)}
      ${setLink('#/einstellungen/vorschlaege', 'text', 'teal', 'Vorschläge', sum.vorschlaege)}
      ${setToggle('book', 'green', 'Berichtsheft', `data-s="bhOn" ${settings.bhOn ? 'checked' : ''}`)}
    </div>
    <div class="card s-group">
      ${setLink('#/einstellungen/scheine', 'doc', 'purple', 'Arbeitsscheine', sum.scheine)}
      ${setLink('#/einstellungen/sicherung', 'cloud', 'blue', 'Datensicherung', sum.sicherung)}
    </div>`;
}

function renderSettingsPage(sub) {
  const body = {
    lohn: `
    <div class="card form">
      <label class="field"><span>Stundenlohn</span><input data-s="wage" inputmode="decimal" placeholder="0,00" value="${escapeHtml(settings.wage)}" enterkeyhint="done"><span class="unit">€</span></label>
      <label class="field"><span>Feste Zulage im Monat</span><input data-s="bonus" inputmode="decimal" placeholder="0,00" value="${escapeHtml(settings.bonus)}" enterkeyhint="done"><span class="unit">€</span></label>
      <label class="field"><span>Steuerklasse</span><select data-s="taxClass">${[1, 2, 3, 4, 5, 6]
        .map((k) => `<option value="${k}" ${String(settings.taxClass) === String(k) ? 'selected' : ''}>${['I', 'II', 'III', 'IV', 'V', 'VI'][k - 1]}</option>`)
        .join('')}</select></label>
      <label class="field"><span>Kirchensteuer</span><input type="checkbox" class="toggle" data-s="church" ${settings.church ? 'checked' : ''}></label>
      <label class="field"><span>Kinder</span><select data-s="children">${[0, 1, 2, 3, 4, 5]
        .map((k) => `<option value="${k}" ${String(settings.children) === String(k) ? 'selected' : ''}>${k === 5 ? '5 oder mehr' : k}</option>`)
        .join('')}</select></label>
      <label class="field"><span>Zuschlag Überstunden</span><input data-s="otPct" inputmode="decimal" placeholder="0" value="${escapeHtml(settings.otPct ?? '')}" enterkeyhint="done"><span class="unit">%</span></label>
      <label class="field"><span>Zusatzbeitrag Krankenkasse</span><input data-s="kvExtra" inputmode="decimal" placeholder="Ø ${fmtDec(lohnJahr(new Date().getFullYear()).zusatzSchnitt * 60)}" value="${escapeHtml(settings.kvExtra)}" enterkeyhint="done"><span class="unit">%</span></label>
      <label class="field"><span>Betriebsrente (dein Beitrag)</span><input data-s="bav" inputmode="decimal" placeholder="0,00" value="${escapeHtml(settings.bav)}" enterkeyhint="done"><span class="unit">€</span></label>
    </div>
    <p class="footnote">Für das geschätzte Netto in der Übersicht.</p>

`,
    vorschlaege: hiddenSuggestionsHTML().replace('<h2 class="section-title">Vorschläge</h2>', ''),
    scheine: `
    <div class="card form">
      <label class="field"><span>Abholadresse</span><input data-s="reportUrl" placeholder="Link einfügen" value="${escapeHtml(settings.reportUrl || '')}" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done"></label>
      <button class="list-btn" data-act="reports-fetch">Jetzt abholen</button>
      <button class="list-btn" data-act="reports-open">Alle Arbeitsscheine</button>
    </div>
    <p class="footnote" id="report-status">${reportStatusText()}</p>

`,
    konto: kontoPageHTML(),
    sicherung: `
    <div class="card list">
      <button class="list-btn" data-act="backup-export">Sicherung speichern …</button>
      <label class="list-btn">Sicherung einlesen …<input type="file" multiple accept="${IMPORT_ACCEPT}" data-act-change="backup-import" hidden></label>
    </div>
    ${account ? '' : '<p class="footnote">Deine Daten sind nur auf diesem iPhone – sichere sie ab und zu.</p>'}
    <p class="footnote">Einlesen geht auch mit Numbers- oder PDF-Zetteln und Arbeitsscheinen.</p>
    <p class="footnote center muted">${sheets.length} Stundenzettel gespeichert</p>`,
  }[sub];
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title">${SETTINGS_PAGES[sub]}</h1>
    <div class="s-page">${body}</div>`;
}

function hiddenSuggestionsHTML() {
  const items = ['site', 'work'].flatMap((field) => settings.hiddenSuggestions[field].map((value) => ({ field, value })));
  return `<h2 class="section-title">Vorschläge</h2>
    <div class="card form typo-demo-card">
      <label class="field"><span>Korrektur</span><input type="checkbox" class="toggle" data-s="typoHints" ${settings.typoHints !== false ? 'checked' : ''}></label>
      ${typoDemoHTML()}
    </div>
    <div class="card form">
      <label class="field"><span>Warnzeichen <span class="warn-demo-sign" aria-hidden="true">⚠️</span></span><input type="checkbox" class="toggle" data-s="warnSigns" ${settings.warnSigns !== false ? 'checked' : ''}></label>
    </div>
    <div class="card form typo-demo-card">
      <label class="field"><span>Vorschläge über der Tastatur</span><input type="checkbox" class="toggle" data-s="suggestBar" ${settings.suggestBar !== false ? 'checked' : ''}></label>
      ${suggestDemoHTML()}
    </div>
    ${
      items.length
        ? `<div class="card form">${items
            .map(
              ({ field, value }) => `<div class="field hidden-row"><span class="hidden-sugg"><span class="field-icon-inline">${field === 'site' ? ICON.pin : ICON.tool}</span><span translate="no">${escapeHtml(value)}</span></span>
          <button class="link-btn" data-act="unhide" data-field="${field}" data-value="${escapeHtml(value)}">Wiederherstellen</button></div>`
            )
            .join('')}</div>`
        : ''
    }
    <p class="footnote">Lange drücken blendet einen Vorschlag aus.</p>`;
}
/** Beispiel für „Vorschläge über der Tastatur“: nur die Kapseln */
const suggestDemoHTML = () => `<div class="typo-demo" aria-hidden="true">
      <div class="sugg-demo" translate="no"><span class="chip">Heizung warten</span><span class="chip">Heizkörper montiert</span></div>
    </div>`;
/** Warnzeichen im Stundenzettel (Liste, Wochenleiste, Tage, Zeilen) ein-/ausblenden */
const applyWarnSigns = () => document.documentElement.classList.toggle('no-warn', settings.warnSigns === false);
/** Beispiel für den Schalter „Korrektur“: nur der Hinweis, wie er im Zettel unter einem Tippfehler steht */
const typoDemoHTML = () => `<div class="typo-demo" aria-hidden="true">
      <div class="typo-hint"><span class="typo-text">Meintest du <b class="typo-demo-fix" translate="no">„Heizkörper montiert“</b>?</span><span class="typo-x">✕</span></div>
    </div>`;

const backupJson = (indent) =>
  JSON.stringify({ app: 'stundenzettel', version: 1, exportedAt: new Date().toISOString(), sheets: savedSheets(), trips, settings, payslips, reports: reports(), berichtsheft: bhBackup() }, null, indent);

async function exportBackup() {
  let data;
  try {
    data = await sealBackup(backupJson(2));
  } catch (e) {
    window.fehlerMelden?.(e, 'sicherung');
    infoDialog('Sicherung nicht möglich', escapeHtml(e.message));
    return;
  }
  const file = new File([data], `Std-Protokoll-Sicherung ${isoDate(new Date())}.json`, { type: 'application/json' });
  if (!(navigator.canShare && navigator.canShare({ files: [file] }))) return downloadFile(file);
  const share = () =>
    navigator.share({ files: [file] }).catch((e) => {
      if (!e || e.name !== 'AbortError') downloadFile(file);
    });
  try {
    await navigator.share({ files: [file] });
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    // Verschlüsseln hat zu lange gedauert, Safari erlaubt Teilen nur direkt nach dem Antippen: noch einmal tippen lassen
    if (e && e.name === 'NotAllowedError') confirmDialog('Sicherung bereit', 'Zum Speichern auf „Teilen“ tippen.', 'Teilen', share);
    else downloadFile(file);
  }
}

/** Inhalt eines Tages zum Vergleichen und Anzeigen: „07:00–16:00 Ort · Arbeit; Pause 0,50 h“ bzw. „Urlaub“ */
function dayText(d) {
  const rows = d.rows
    .filter((r) => !rowIsEmpty(r))
    .map((r) => {
      const time = r.start != null || r.end != null ? `${r.start != null ? fmtTime(r.start) : '?'}–${r.end != null ? fmtTime(r.end) : '?'}` : '';
      return [time, [(r.site || '').trim(), (r.work || '').trim()].filter(Boolean).join(' · ')].filter(Boolean).join(' ');
    });
  // Von Hand gesetzte Stunden einer Tagesart (3 s drücken) gehören zum Vergleich, ebenso Pause 0 an einem Tag mit Zeiten.
  // Die Rückfragen zeigen die Zeile mit translate="no" (Einträge bleiben, wie sie sind): Tagesart und Pause hier übersetzen
  const status = d.status ? tr(DAY_STATUS_SHORT[d.status]) + (d.credit != null ? ` · ${tr(fmtH(d.credit))}` : '') : '';
  if (d.status && !canWork(d)) return status;
  const parts = [...(status ? [status] : []), ...rows];
  if (d.pause || (d.pause === 0 && dayHasTimes(d))) parts.push(`${tr('Pause')} ${tr(fmtH(d.pause))}`);
  return parts.join('; ') || '–';
}
/** Tage, an denen sich zwei Fassungen desselben Zettels unterscheiden: [{ i, mine, theirs }] */
function sheetDiff(mine, theirs) {
  return sheetActiveDays(mine)
    .map((i) => ({ i, mine: dayText(mine.days[i]), theirs: dayText(theirs.days[i] || { rows: [] }) }))
    .filter((x) => x.mine !== x.theirs);
}
/** Ein Reisetag als Text für den Vergleich; „–“, wenn der Tag nicht zur Abrechnung gehört */
function tripDayText(r) {
  if (!r) return '–';
  const time = r.start != null || r.end != null ? `${r.start != null ? fmtClock(r.start) : '?'}–${r.end != null ? fmtClock(r.end) : '?'}` : '';
  return [time, [r.places.trim(), r.works.trim()].filter(Boolean).join(' · '), r.meal ? fmtEuro(r.meal) : ''].filter(Boolean).join(' ') || '–';
}
/** Unterschiede zweier Fassungen derselben Abrechnung: [{ label, mine, theirs }] (Tage, dazu Ort/Datum der Unterschrift) */
function tripDiff(mine, theirs) {
  const a = new Map(tripRows(mine).map((r) => [r.iso, r]));
  const b = new Map(tripRows(theirs).map((r) => [r.iso, r]));
  const out = [...new Set([...a.keys(), ...b.keys()])].sort().map((iso) => {
    const d = parseDate(iso);
    return { label: `${WEEKDAYS_SHORT[(d.getDay() + 6) % 7]} ${fmtDayMonth(d)}`, mine: tripDayText(a.get(iso)), theirs: tripDayText(b.get(iso)) };
  });
  const sign = (t) => [(t.place || '').trim(), t.signDate ? fmtShort(parseDate(t.signDate)) : ''].filter(Boolean).join(', ') || '–';
  out.push({ label: 'Ort, Datum', mine: sign(mine), theirs: sign(theirs) });
  return out.filter((x) => x.mine !== x.theirs);
}
/** Wörter eines Tagestexts; Satzzeichen am Wortende („getauscht;“) und der Strich zwischen zwei Uhrzeiten zählen extra */
const diffWords = (t) =>
  t.split(' ').flatMap((w) => (/.[;,]$/.test(w) ? [w.slice(0, -1), w.slice(-1)] : [w]).flatMap((v) => v.split(/(?<=\d)(–)(?=[\d?])|(?<=\?)(–)/).filter(Boolean)));
/** Längste gemeinsame Wortfolge zweier Wortlisten: [Indizes in x, Indizes in y], die gleich bleiben */
function commonWords(x, y) {
  const L = Array.from({ length: x.length + 1 }, () => Array(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--)
    for (let j = y.length - 1; j >= 0; j--) L[i][j] = x[i] === y[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const keepA = new Set();
  const keepB = new Set();
  for (let i = 0, j = 0; i < x.length && j < y.length; )
    if (x[i] === y[j]) keepA.add(i++), keepB.add(j++);
    else if (L[i + 1][j] >= L[i][j + 1]) i++;
    else j++;
  return [keepA, keepB];
}
/** Wortliste als HTML, Wörter außerhalb von keep in <mark> */
const wordsHTML = (w, keep) =>
  w
    .map((t, i) => (i && !/^[;,–]$/.test(t) && w[i - 1] !== '–' ? ' ' : '') + (keep.has(i) ? escapeHtml(t) : `<mark>${escapeHtml(t)}</mark>`))
    .join('')
    .replace(/<\/mark>( ?)<mark>/g, '$1');
/** Zwei Fassungen eines Tages wortweise vergleichen: HTML beider Zeilen, abweichende Wörter in <mark> */
function wordDiffHTML(a, b) {
  const x = diffWords(a);
  const y = diffWords(b);
  const [keepA, keepB] = commonWords(x, y);
  const changed = (w, keep) => w.filter((t, i) => !keep.has(i)).join(' ');
  return { mine: wordsHTML(x, keepA), theirs: wordsHTML(y, keepB), spelling: onlySpelling(changed(x, keepA), changed(y, keepB)) };
}
/** Mehrere Fassungen eines Tages: je Fassung HTML, markiert ist jedes Wort, das in einer anderen Fassung fehlt */
function wordsMultiHTML(texts) {
  const words = texts.map(diffWords);
  return words.map((x, k) => {
    const keep = new Set(x.keys());
    words.forEach((y, j) => {
      if (j === k) return;
      const [kx] = commonWords(x, y);
      for (const i of [...keep]) if (!kx.has(i)) keep.delete(i);
    });
    return wordsHTML(x, keep);
  });
}
/**
 * Nur Schreibweise anders (wie beim Tippfehler-Hinweis): gleiche Zahlen, sonst nur Groß-/Kleinschreibung,
 * Leer-/Satzzeichen oder bei 5–9 Zeichen 1, ab 10 Zeichen 2 Buchstaben
 */
function onlySpelling(a, b) {
  if (a.replace(/\D/g, '') !== b.replace(/\D/g, '')) return false;
  const ka = searchKey(a);
  const kb = searchKey(b);
  const len = Math.max(ka.length, kb.length);
  return editDistance(ka, kb) <= (len >= 10 ? 2 : len >= 5 ? 1 : 0);
}
const weekKey = (s) => `${s.weekStart}|${s.year}|${s.month}`;
/** Dateiname, Name oder Eintrag in Meldungen: nie übersetzen (i18n.js) */
const noTrHTML = (t) => `<span translate="no">${escapeHtml(t)}</span>`;
/** Teile einer Rückmeldung je in eigenem Element, damit jeder für sich übersetzt wird */
const partsHTML = (parts) => parts.map((p) => `<span>${p}</span>`).join(', ');
/** „12.10.26, 14:03“ */
const fmtStamp = (ms) => (ms ? `${fmtShort(new Date(ms))}, ${fmtTime(new Date(ms).getHours() * 60 + new Date(ms).getMinutes())}` : 'unbekannt');

/**
 * Sicherung (JSON) übernehmen. Neue Zettel kommen dazu; gibt es die Woche schon, wird verglichen:
 * gleich → nichts, verschieden → Rückfrage (conflicts, wird in importBackup entschieden).
 */
function mergeBackup(data) {
  const incoming = Array.isArray(data) ? data : data.sheets;
  if (!Array.isArray(incoming) || !incoming.every((s) => s && s.id && s.weekStart && Array.isArray(s.days))) throw new Error('format');
  let added = 0;
  let same = 0;
  const conflicts = [];
  // Neues Gerät (noch kein Name eingetragen, z. B. nach dem Neu-Anlegen auf dem Home-Bildschirm):
  // Einstellungen aus der Sicherung übernehmen – Name, ausgeblendete Vorschläge, Sprache, Darstellung usw.
  // Die fest vorgegebenen Werte (Wochenstunden, Bundesland, Zeitschritte) bleiben unverändert.
  let settingsRestored = false;
  if (!settings.name.trim() && data.settings && typeof data.settings === 'object' && String(data.settings.name || '').trim()) {
    const fixed = ['target', 'hoursPerDay', 'state', 'minuteStep', 'signature', 'place'];
    for (const [k, v] of Object.entries(data.settings)) if (!fixed.includes(k)) settings[k] = v;
    settings.hiddenSuggestions = { site: [], work: [], ...settings.hiddenSuggestions };
    saveSettings();
    settingsRestored = true;
  }
  const myName = settings.name.trim();
  let renamed = 0;
  for (const s of incoming) {
    fixWeekend(s);
    // Eigener Name aus den Einstellungen statt des Namens in der Sicherung
    if (myName && s.name !== myName) {
      s.name = myName;
      renamed++;
    }
    // Abgleich nur über die Woche: „Woche ändern“ behält die ID, ID und Woche können also auseinanderlaufen
    const current = sheets.find((x) => weekKey(x) === weekKey(s));
    if (!current) {
      if (sheets.some((x) => x.id === s.id)) s.id = uid(); // ID gehört hier schon einem Zettel einer anderen Woche
      sheets.push(s);
      added++;
    } else if (sheetDiff(current, s).length) conflicts.push({ existing: current, incoming: s, stamp: s.updatedAt, stampLabel: 'geändert', backup: true });
    else same++;
  }
  saveSheets();
  // Reisekostenabrechnungen (gleiche ID): gleich → nichts, verschieden → Rückfrage wie bei den Zetteln
  let tripsAdded = 0;
  let tripsSame = 0;
  if (Array.isArray(data.trips)) {
    for (const raw of data.trips) {
      if (!raw || !raw.id || !Array.isArray(raw.dates)) continue;
      const t = { over: {}, ...raw, ...(myName ? { name: myName } : {}) };
      // Gleiche ID, sonst dieselben Tage (Abrechnung in der App gelöscht und neu angelegt)
      const cur = findTrip(t.id) || (t.dates.length ? trips.find((x) => [...x.dates].sort().join() === [...t.dates].sort().join()) : null);
      if (!cur) {
        trips.push(t);
        tripsAdded++;
      } else if (tripDiff(cur, t).length) conflicts.push({ trip: true, existing: cur, incoming: t, stamp: t.updatedAt, stampLabel: 'geändert', backup: true });
      else tripsSame++;
    }
    saveTrips();
  }
  // Lohnabrechnungen: fehlende Monate übernehmen, vorhandene bleiben
  let payslipsAdded = 0;
  if (data.payslips && typeof data.payslips === 'object') {
    for (const [k, p] of Object.entries(data.payslips)) {
      if (!payslips[k] && p && p.year && p.month && p.hours) {
        payslips[k] = p.pay ? Object.assign(repairPayslip(p), { repaired: true }) : p;
        payslipsAdded++;
      }
    }
    if (payslipsAdded) savePayslips();
  }
  // Arbeitsscheine: nur fehlende (gleiche Nummer = schon da, auch wenn die Sicherung eine ältere Fassung hat)
  const reportsAdded = Array.isArray(data.reports)
    ? addReports(data.reports.filter((r) => r && r.id && r.date && !reports().some((x) => x.id === r.id || (r.no && x.no === r.no))))
    : 0;
  // Berichtsheft: fehlende Hefte und Seiten übernehmen
  const bhAdded = data.berichtsheft ? bhMerge(data.berichtsheft) : 0;
  return { added, same, conflicts, renamed, tripsAdded, tripsSame, settingsRestored, payslipsAdded, reportsAdded, bhAdded };
}

/** Dateitypen für „Einlesen“ (nur diese, damit iOS keine Kamera/Fotos anbietet) */
const IMPORT_ACCEPT =
  '.json,.numbers,.pdf,.odt,application/json,application/pdf,application/vnd.apple.numbers,application/x-iwork-numbers-sffnumbers,application/vnd.oasis.opendocument.text';

/** Dateiauswahl zum Einlesen öffnen – muss direkt im Antippen laufen, sonst blockiert Safari sie */
function pickImportFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.accept = IMPORT_ACCEPT;
  input.hidden = true;
  input.addEventListener('change', () => {
    importBackup(input);
    input.remove();
  });
  document.body.append(input);
  input.click();
}

/** Eine oder mehrere Dateien einlesen: Sicherung (.json), Stundenzettel als Numbers-Datei oder PDF, Arbeitsschein (.odt) */
async function importBackup(input) {
  const files = [...(input.files || [])];
  input.value = '';
  if (!files.length) return;
  const lines = [];
  const conflicts = [];
  let total = 0;
  let tripCount = 0;
  let reportCount = 0;
  let payslipCount = 0;
  let bhCount = 0;
  let failed = 0; // Dateien, die nicht gelesen werden konnten (accountRestore lädt dann nichts hoch)
  // Herkunft der in diesem Durchgang neu eingelesenen Zettel/Abrechnungen (Rückfrage zeigt dann „aus Datei …“)
  const origin = new Map();
  const added = new Map(); // erst durch dieses Einlesen angelegt → { file, stamp, stampLabel }
  const sameFiles = new Map(); // angelegter Zettel → weitere Dateien mit genau dieser Fassung
  const known = new Set([...sheets, ...trips]);
  const markNew = (file, json) => {
    for (const x of [...sheets, ...trips])
      if (!known.has(x)) {
        known.add(x);
        origin.set(x, file.name);
        added.set(x, json ? { file: file.name, stamp: x.updatedAt, stampLabel: 'geändert', backup: true } : { file: file.name, stamp: file.lastModified, stampLabel: 'Datei vom' });
      }
  };
  toast(files.length > 1 ? `${files.length} Dateien werden eingelesen …` : 'Wird eingelesen …', 10000);
  // Neue Zettel aus Dateien erst gesammelt speichern (bei vielen Dateien sonst jedes Mal alle), spätestens vor einer Rückfrage
  let unsaved = false;
  const saveNew = () => {
    if (unsaved) saveSheets();
    unsaved = false;
  };
  for (const file of files) {
    const label = `<b translate="no">${escapeHtml(file.name)}</b>`;
    let json = false;
    try {
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 1))[0];
      if (/\.json$/i.test(file.name) || head === 0x7b || head === 0x5b) {
        json = true;
        let parsed = JSON.parse(utf8.decode(buf));
        if (parsed && parsed.enc) {
          saveNew(); // Passwortfenster: vorher speichern
          parsed = await openSealedBackup(parsed, file.name);
        }
        const r = mergeBackup(parsed);
        total += r.added;
        tripCount += r.tripsAdded;
        r.conflicts.forEach((c) => conflicts.push({ ...c, file: file.name }));
        const sheetConf = r.conflicts.filter((c) => !c.trip).length;
        const tripConf = r.conflicts.length - sheetConf;
        const parts = [`${r.added} Stundenzettel neu`];
        if (r.same) parts.push(`${r.same} schon vorhanden (gleich)`);
        if (sheetConf) parts.push(`${sheetConf} mit Unterschieden`);
        if (r.tripsAdded || r.tripsSame || tripConf) {
          const tp = [`${r.tripsAdded} Reisekostenabrechnung${r.tripsAdded === 1 ? '' : 'en'} neu`];
          if (r.tripsSame) tp.push(`${r.tripsSame} schon vorhanden (gleich)`);
          if (tripConf) tp.push(`${tripConf} mit Unterschieden`);
          parts.push(partsHTML(tp));
        }
        if (r.payslipsAdded) parts.push(`${r.payslipsAdded} Lohnabrechnung${r.payslipsAdded === 1 ? '' : 'en'} neu`);
        if (r.reportsAdded) parts.push(`${r.reportsAdded} Arbeitsschein${r.reportsAdded === 1 ? '' : 'e'} neu`);
        if (r.bhAdded) parts.push(`${r.bhAdded} Berichtsheft-Seite${r.bhAdded === 1 ? '' : 'n'} neu`);
        payslipCount += r.payslipsAdded;
        reportCount += r.reportsAdded;
        bhCount += r.bhAdded;
        if (r.settingsRestored) parts.push('Einstellungen übernommen');
        if (r.renamed) parts.push(`Name bei ${r.renamed} auf „${noTrHTML(settings.name.trim())}“ geändert`);
        lines.push(`${label}: ${partsHTML(parts)}`);
        continue;
      }
      // Arbeitsschein (.odt der Arbeitsbericht-App)
      if (/\.odt$/i.test(file.name)) {
        const list = await readWorkReportFile(buf);
        const n = addReports(list);
        reportCount += n;
        lines.push(`${label}: Arbeitsschein ${noTrHTML(shortCustomer(list[0].customer))}, ${fmtShort(parseDate(list[0].date))}${n ? '' : ' (schon vorhanden)'}`);
        continue;
      }
      // Woche über ein Monatsende: ein Zettel je Monat
      for (const s of await importTimesheetFile(file.name, buf, (stated, options) => (saveNew(), askImportDate(file.name, stated, options)))) {
        const existing = existingSheet(sheetFirstDate(s));
        const other = s.importedName && s.importedName.trim() !== s.name;
        const yearFixed = s.yearFixed;
        delete s.importedName;
        delete s.yearFixed;
        if (existing) {
          const range = `${fmtShort(sheetFirstDate(s))} – ${fmtShort(sheetLastDate(s))}`;
          // War die Woche vorher nicht in der App, stammt „vorhanden“ aus einer anderen Datei dieses Einlesens
          const from = added.get(existing);
          if (!sheetDiff(existing, s).length) {
            lines.push(`${label}: ${range} ${from ? `gleich wie in ${noTrHTML(from.file)}` : 'schon vorhanden (gleich)'}`);
            if (from) sameFiles.set(existing, [...(sameFiles.get(existing) || []), file.name]);
          } else {
            conflicts.push({ existing, incoming: s, stamp: file.lastModified, stampLabel: 'Datei vom', file: file.name });
            lines.push(`${label}: ${range} ${from ? `auch in ${noTrHTML(from.file)}, mit Unterschieden` : 'schon vorhanden, mit Unterschieden'}`);
          }
          continue;
        }
        s.sentAt = Date.now(); // eingelesene Zettel gelten als schon gesendet
        sheets.push(s);
        unsaved = true;
        total++;
        lines.push(
          `${label}: ${fmtShort(sheetFirstDate(s))} – ${fmtShort(sheetLastDate(s))}, ${fmtH(sheetTotal(s))}${other ? ` · <span>Name auf „</span>${noTrHTML(s.name)}<span>“ geändert</span>` : ''}${yearFixed ? ` · im Zettel stand ${yearFixed}` : ''}`
        );
      }
    } catch (e) {
      failed++;
      // Programmfehler melden; erwartete Fälle (Format, Passwort, kein Stundenzettel) und SyntaxError nicht (JSC nennt darin Dateiinhalt)
      if (e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError) window.fehlerMelden?.(e, 'einlesen');
      if (e && e.message === 'skip') lines.push(`${label}: nicht eingelesen`);
      else lines.push(`${label}: konnte nicht gelesen werden${e && e.message && e.message !== 'format' ? ` (<span>${escapeHtml(e.message)}</span>)` : ''}`);
    } finally {
      markNew(file, json);
    }
  }
  saveNew();
  document.getElementById('toast').classList.remove('show');
  // Zettel und Abrechnungen mit Unterschieden: selbst entscheiden.
  // Gab es sie vorher nicht in der App, sondern nur in mehreren Dateien: eine Fassung wählen (ohne „für alle“, das ginge nicht).
  // Sonst Vergleich mit der App (einzeln oder für alle gleich); verglichen wird immer mit dem aktuellen Stand,
  // eine schon abgelehnte Fassung wird nicht noch einmal gefragt.
  const version = (c, x) => JSON.stringify([...versionTexts(c, x)]);
  const items = [];
  for (const c of conflicts) {
    const from = added.get(c.existing);
    if (!from) {
      items.push(c);
      continue;
    }
    let item = items.find((x) => x.choose && x.existing === c.existing);
    if (!item) {
      item = { choose: true, trip: c.trip, existing: c.existing, versions: [] };
      // Jede Fassung merkt sich, ob sie aus einer Sicherung stammt (dann ganz übernehmen, sonst nur Tage und Name)
      item.versions.push({ data: { ...c.existing }, files: [from.file, ...(sameFiles.get(c.existing) || [])], stamp: from.stamp, stampLabel: from.stampLabel, backup: !!from.backup });
      items.push(item);
    }
    const v = version(c, c.incoming);
    const same = item.versions.find((x) => version(c, x.data) === v);
    if (same) same.files.push(c.file);
    else item.versions.push({ data: c.incoming, files: [c.file], stamp: c.stamp, stampLabel: c.stampLabel, backup: !!c.backup });
  }
  let all = null;
  const rejected = new Map(); // Zettel/Abrechnung → Texte der abgelehnten Fassungen
  for (let k = 0; k < items.length; k++) {
    const c = items[k];
    const title = `<b>${escapeHtml(conflictTitle(c))}</b>`;
    if (c.choose) {
      const pick = await askVersions(c);
      const v = c.versions[pick];
      if (pick > 0) c.trip ? replaceTrip({ existing: c.existing, incoming: v.data }) : replaceSheet({ existing: c.existing, incoming: v.data, backup: v.backup });
      lines.push(`${title}: Fassung aus ${noTrHTML(v.files.join(', '))} übernommen`);
      continue;
    }
    if (!(c.trip ? tripDiff(c.existing, c.incoming) : sheetDiff(c.existing, c.incoming)).length) {
      lines.push(`${title}: ${noTrHTML(c.file)} gleich wie die übernommene Fassung`);
      continue;
    }
    if (rejected.get(c.existing)?.has(version(c, c.incoming))) {
      lines.push(`${title}: Fassung in der App behalten`);
      continue;
    }
    // Stammt die Fassung in der App selbst aus diesem Einlesen, gilt „für alle“ nicht – sonst gewänne still die letzte Datei
    c.existingFile = origin.get(c.existing);
    const left = items.slice(k).filter((x) => !x.choose).length;
    const choice = (!c.existingFile && all) || (await askConflict(c, left));
    if (choice === 'replaceAll' || choice === 'keepAll') all = choice;
    const replace = choice === 'replace' || choice === 'replaceAll';
    if (replace) {
      if (c.trip) replaceTrip(c);
      else replaceSheet(c);
      // Nur einmal zählen, auch wenn dieselbe Woche aus mehreren Dateien ersetzt wird
      if (!c.existingFile) c.trip ? tripCount++ : total++;
      origin.set(c.existing, c.file);
    } else {
      if (!rejected.has(c.existing)) rejected.set(c.existing, new Set());
      rejected.get(c.existing).add(version(c, c.incoming));
    }
    lines.push(`${title}: ${replace ? `Fassung aus ${noTrHTML(c.file)} übernommen` : 'Fassung in der App behalten'}`);
  }
  if (conflicts.some((c) => !c.trip)) saveSheets();
  if (conflicts.some((c) => c.trip)) saveTrips();
  importRerender();
  const done = [
    total ? `${total} Stundenzettel` : '',
    tripCount ? `${tripCount} Reisekostenabrechnung${tripCount === 1 ? '' : 'en'}` : '',
    reportCount ? `${reportCount} Arbeitsschein${reportCount === 1 ? '' : 'e'}` : '',
    payslipCount ? `${payslipCount} Lohnabrechnung${payslipCount === 1 ? '' : 'en'}` : '',
    bhCount ? `${bhCount} Berichtsheft-Seite${bhCount === 1 ? '' : 'n'}` : '',
  ].filter(Boolean);
  const title = done.length ? `${done.slice(0, -1).join(', ')}${done.length > 1 ? ' und ' : ''}${done.at(-1)} eingelesen` : 'Nichts eingelesen';
  // Sprache aus der Sicherung übernommen: gilt erst nach dem Neuladen (i18n.js liest sie beim Start)
  const reload = () => (teamUploading ? setTimeout(reload, 500) : location.reload());
  infoDialog(title, `<ul class="problem-list">${lines.map((l) => `<li>${l}</li>`).join('')}</ul>`, (settings.lang === 'ru' ? 'ru' : 'de') !== LANG ? reload : null);
  return !failed;
}

/** Nach dem Einlesen (geht von jeder Seite aus): übernommene Einstellungen anwenden, die offene Seite neu zeichnen */
function importRerender() {
  applyTheme();
  applyWarnSigns();
  const y = window.scrollY;
  // Reisekosten: route() verwürfe eine noch leere Abrechnung (dropEmptyTrip), deshalb nur neu zeichnen
  const tm = currentView === 'trip' && location.hash.match(/^#\/reise\/(.+)$/);
  if (tm) renderTrip(decodeURIComponent(tm[1]));
  else route();
  window.scrollTo(0, y);
}

/** Neue Fassung übernehmen; der Zettel behält seine ID (Verknüpfung zu Reisekosten), aus Dateien auch den Status */
function replaceSheet(c) {
  const { existing, incoming } = c;
  if (c.backup) {
    Object.assign(existing, { ...incoming, id: existing.id });
  } else {
    existing.days = incoming.days;
    existing.name = incoming.name;
  }
  existing.updatedAt = Date.now();
  // Zettel gerade im Editor offen: der eingelesene Stand gilt als gespeichert (sonst schriebe savedSheets den alten)
  if (editorSaved && editorSaved.id === existing.id) editorSaved = editorSnapshot(existing);
}

/** Neue Fassung einer Abrechnung übernehmen (ID bleibt) */
function replaceTrip(c) {
  Object.assign(c.existing, { ...c.incoming, id: c.existing.id });
  c.existing.updatedAt = Date.now();
}

/** „06.07.26 – 10.07.26“ (Zettel) bzw. „Reisekostenabrechnung 06.07.26 - 08.07.26“ */
const conflictTitle = (c) =>
  c.trip ? tripTitle(c.existing) : `${fmtShort(sheetFirstDate(c.existing))} – ${fmtShort(sheetLastDate(c.existing))}`;

/** Scrollleiste rechts in einer Rückfrage, nur wenn die Unterschiede nicht ins Fenster passen (iOS blendet die eigene aus) */
function scrollBar(modal) {
  const msg = modal.querySelector('.alert-msg');
  const thumb = modal.querySelector('.cf-bar i');
  const updateBar = () => {
    const max = msg.scrollHeight - msg.clientHeight;
    msg.parentElement.classList.toggle('can', max > 1);
    if (max <= 1) return;
    const h = Math.max(28, (msg.clientHeight * msg.clientHeight) / msg.scrollHeight);
    thumb.style.height = `${h}px`;
    thumb.style.transform = `translateY(${(Math.min(Math.max(msg.scrollTop, 0), max) / max) * (msg.clientHeight - h)}px)`;
  };
  msg.addEventListener('scroll', updateBar, { passive: true });
  updateBar();
  setTimeout(updateBar, 300);
}

/** „Woche von“ ist kein Montag (Jahr oder Monat vertippt): einen der Vorschläge (options, 1–2) wählen, wie im Zettel lassen
 *  oder nicht einlesen. Ergebnis: Datum für „Woche von“ oder null */
function askImportDate(fileName, stated, options) {
  return new Promise((resolve) => {
    const range = (d) => `${fmtShort(d)} – ${fmtShort(addDays(d, 6))}`;
    const asIs = mondayOf(stated);
    document.getElementById('toast').classList.remove('show'); // „Wird eingelesen …“ ausblenden, solange gefragt wird
    const modal = openModal(
      `<div class="alert-body"><b>Datum prüfen</b><div class="alert-msg">
        <p><b translate="no">${escapeHtml(fileName)}</b></p>
        <p>Im Zettel steht ${range(stated)}. Der ${fmtShort(stated)} ist aber ein ${WEEKDAYS[(stated.getDay() + 6) % 7]}.</p>
      </div></div>
      <div class="alert-buttons stacked">
        ${options
          .map((d, k) => `<button data-c="${k}"${k ? '' : ' class="strong"'}><span class="ad-hint">${k ? 'Auch möglich' : 'Wahrscheinlich gemeint'}</span>${range(d)}</button>`)
          .join('')}
        <button data-c="asis"><span class="ad-hint">Weniger wahrscheinlich</span>${range(asIs)}</button>
        <button data-c="skip">Nicht einlesen</button>
      </div>`,
      'alert'
    );
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeModal();
      setTimeout(() => resolve(v), 280);
    };
    modal.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (b) finish(b.dataset.c === 'asis' ? asIs : b.dataset.c === 'skip' ? null : options[+b.dataset.c]);
    });
    modal.previousElementSibling.addEventListener('click', () => finish(null));
  });
}

/** Rückfrage bei einem doppelten Zettel (oder einer Abrechnung) mit Unterschieden; Ergebnis: 'keep' | 'replace' | 'keepAll' | 'replaceAll' */
function askConflict(c, remaining) {
  return new Promise((resolve) => {
    const { existing: mine, incoming: theirs } = c;
    const sentLabel = (s) => (s.sentAt ? 'gesendet' : 'offen');
    const sum = (x) => (c.trip ? fmtEuro(tripTotal(tripRows(x))) : fmtH(sheetTotal(x)));
    const diffs = c.trip
      ? tripDiff(mine, theirs)
      : sheetDiff(mine, theirs).map((d) => ({ ...d, label: `${WEEKDAYS_SHORT[d.i]} ${fmtDayMonth(sheetDate(mine, d.i))}` }));
    const diff = diffs
      .map((d) => {
        const w = wordDiffHTML(d.mine, d.theirs);
        const hint = w.spelling ? '<span class="cf-spell">nur Schreibweise</span>' : '';
        return `<li><b>${d.label}</b>${hint}
          <span class="cf-line"><span class="cf-tag app">App</span><span class="cf-txt" translate="no">${w.mine}</span></span>
          <span class="cf-line"><span class="cf-tag new">Neu</span><span class="cf-txt" translate="no">${w.theirs}</span></span></li>`;
      })
      .join('');
    const allSpelling = diffs.every((d) => wordDiffHTML(d.mine, d.theirs).spelling);
    const modal = openModal(
      `<div class="alert-body cf">
        <b>${c.trip ? 'Reisekostenabrechnung doppelt' : 'Stundenzettel doppelt'}</b>
        <div class="cf-scroll"><div class="alert-msg">
          <p class="cf-intro"><b>${escapeHtml(conflictTitle(c))}</b> gibt es schon, ${allSpelling ? 'nur die Schreibweise ist anders' : 'aber mit Unterschieden'}.</p>
          <div class="cf-versions">
            <div><span class="cf-tag app">App</span>${c.existingFile ? `eben eingelesen · ${sum(mine)}<br><span class="muted">aus ${noTrHTML(c.existingFile)}</span>` : `geändert ${fmtStamp(mine.updatedAt)} · ${sum(mine)} · ${sentLabel(mine)}`}</div>
            <div><span class="cf-tag new">Neu</span>${escapeHtml(c.stampLabel)} ${fmtStamp(c.stamp)} · ${sum(theirs)}${c.backup ? ` · ${sentLabel(theirs)}` : ''}<br><span class="muted">aus ${noTrHTML(c.file)}</span></div>
          </div>
          <ul class="cf-diff">${diff}</ul>
        </div><div class="cf-bar"><i></i></div></div>
      </div>
      ${remaining > 1 ? `<label class="cf-all"><span>Für alle ${remaining} gleich entscheiden</span><input type="checkbox" class="cf-switch"></label>` : ''}
      <div class="alert-buttons stacked">
        <button data-c="replace">Neue Fassung übernehmen</button>
        <button data-c="keep" class="strong">Fassung in der App behalten</button>
      </div>`,
      'alert wide'
    );
    scrollBar(modal);
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      closeModal();
      // Nächste Rückfrage erst, wenn diese ganz geschlossen ist
      setTimeout(() => resolve(v), 280);
    };
    modal.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      // Schalter „Für alle gleich entscheiden“ (steht anfangs immer auf aus)
      if (b) finish(modal.querySelector('.cf-switch')?.checked ? `${b.dataset.c}All` : b.dataset.c);
    });
    // Antippen neben das Fenster: Fassung in der App behalten
    modal.previousElementSibling.addEventListener('click', () => finish('keep'));
  });
}

/** Texte einer Fassung je Zeile der Rückfrage: Map Bezeichnung → Text (Tage des Zettels bzw. der Abrechnung) */
function versionTexts(c, x) {
  if (!c.trip) return new Map(sheetActiveDays(c.existing).map((i) => [`${WEEKDAYS_SHORT[i]} ${fmtDayMonth(sheetDate(c.existing, i))}`, dayText(x.days[i] || { rows: [] })]));
  const m = new Map(
    tripRows(x).map((r) => {
      const d = parseDate(r.iso);
      return [`${WEEKDAYS_SHORT[(d.getDay() + 6) % 7]} ${fmtDayMonth(d)}`, tripDayText(r)];
    })
  );
  m.set('Ort, Datum', [(x.place || '').trim(), x.signDate ? fmtShort(parseDate(x.signDate)) : ''].filter(Boolean).join(', ') || '–');
  return m;
}

/**
 * Rückfrage, wenn ein Zettel (oder eine Abrechnung) vorher nicht in der App war, aber in mehreren Dateien
 * unterschiedlich vorkommt: Fassung 1, 2, 3 … nebeneinander, abweichende Wörter markiert. Ergebnis: Index der Fassung.
 * Kein „für alle“ und kein Schließen neben dem Fenster – jede Woche wird einzeln entschieden.
 */
function askVersions(c) {
  return new Promise((resolve) => {
    const sum = (x) => (c.trip ? fmtEuro(tripTotal(tripRows(x))) : fmtH(sheetTotal(x)));
    const texts = c.versions.map((v) => versionTexts(c, v.data));
    const labels = [...new Set(texts.flatMap((t) => [...t.keys()]))];
    const diff = labels
      .map((l) => texts.map((t) => t.get(l) ?? '–'))
      .map((own, n) => ({ label: labels[n], own }))
      .filter((d) => new Set(d.own).size > 1)
      .map(
        (d) => `<li><b>${d.label}</b>
          ${wordsMultiHTML(d.own)
            .map((h, k) => `<span class="cf-line"><span class="cf-tag ver">${k + 1}</span><span class="cf-txt" translate="no">${h}</span></span>`)
            .join('')}</li>`
      )
      .join('');
    const modal = openModal(
      `<div class="alert-body cf">
        <b>${c.trip ? 'Reisekostenabrechnung mehrfach' : 'Stundenzettel mehrfach'}</b>
        <div class="cf-scroll"><div class="alert-msg">
          <p class="cf-intro"><b>${escapeHtml(conflictTitle(c))}</b> gibt es in ${c.versions.length} Fassungen. Welche soll gelten?</p>
          <div class="cf-versions">
            ${c.versions
              .map(
                (v, k) =>
                  `<div><span class="cf-tag ver">${k + 1}</span>${escapeHtml(v.stampLabel)} ${fmtStamp(v.stamp)} · ${sum(v.data)}<br><span class="muted">aus ${noTrHTML(v.files.join(', '))}</span></div>`
              )
              .join('')}
          </div>
          <ul class="cf-diff">${diff}</ul>
        </div><div class="cf-bar"><i></i></div></div>
      </div>
      <div class="alert-buttons stacked">
        ${c.versions.map((v, k) => `<button data-v="${k}">Fassung ${k + 1} übernehmen</button>`).join('')}
      </div>`,
      'alert wide',
      false
    );
    scrollBar(modal);
    let done = false;
    modal.addEventListener('click', (e) => {
      const b = e.target.closest('[data-v]');
      if (!b || done) return;
      done = true;
      closeModal();
      setTimeout(() => resolve(+b.dataset.v), 280);
    });
  });
}

/** onClose: läuft nach OK bzw. Antippen daneben */
function infoDialog(title, message, onClose = null) {
  const modal = openModal(
    `<div class="alert-body"><b>${title}</b><div class="alert-msg">${message}</div></div>
    <div class="alert-buttons single"><button data-c="ok" class="strong">OK</button></div>`,
    'alert',
    !onClose
  );
  const close = () => {
    closeModal();
    if (onClose) onClose();
  };
  modal.addEventListener('click', (e) => {
    if (e.target.closest('[data-c]')) close();
  });
  if (onClose) modal.previousElementSibling.addEventListener('click', close);
}

// ───────────────────────── Modale Fenster ─────────────────────────

const layer = document.getElementById('modal-layer');
let modalGen = 0;

/** outsideCloses = false: Antippen neben das Fenster schließt es nicht (Rückfragen, die eine Antwort brauchen) */
function openModal(html, className = '', outsideCloses = true) {
  // Hintergrund und Fenster zusammen (modal.previousElementSibling ist der Hintergrund – auch solange es wartet)
  const box = document.createElement('div');
  box.innerHTML = `<div class="backdrop"></div><div class="modal ${className}" role="dialog" aria-modal="true">${html}</div>`;
  const modal = box.lastElementChild;
  if (outsideCloses) modal.previousElementSibling.addEventListener('click', () => closeModal());
  // Ein festgehaltenes Fenster (Einlesen der Lohnabrechnung) wird nicht ersetzt: andere warten, bis es zu ist
  if (modalHeld) {
    // im Dokument (unsichtbar), damit getElementById im Fenster schon jetzt geht
    box.hidden = true;
    document.body.append(box);
    modalQueue.push(box);
  } else showModal(box);
  return modal;
}
function showModal(box) {
  const gen = ++modalGen;
  layer.replaceChildren(...box.childNodes);
  box.remove();
  layer.classList.add('open');
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  requestAnimationFrame(() => requestAnimationFrame(() => gen === modalGen && layer.classList.add('show')));
}
/** Fenster festhalten: andere Fenster warten, closeModal schließt es nicht (nur holdModal(false) und danach closeModal) */
let modalHeld = false;
const modalQueue = [];
function holdModal(on) {
  modalHeld = on;
}
/** Wartende Fenster erst zeigen, wenn eine Weile keins offen ist (Folge-Rückfragen des festgehaltenen gehen vor) */
function showQueuedModal() {
  setTimeout(() => {
    if (!modalHeld && modalQueue.length && !layer.classList.contains('open')) showModal(modalQueue.shift());
  }, 400);
}

/** Bei offenem Fenster scrollt nichts im Hintergrund: Ziehen zählt nur in Bereichen des Fensters, die selbst scrollen
 *  (Uhrzeit-Räder, lange Hinweise). Eigene Gesten wie das Monats-Ziehen im Kalender laufen weiter über ihre Touch-Ereignisse. */
function scrollableIn(el) {
  for (; el && el !== layer; el = el.parentElement) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 1) return el;
  }
  return null;
}
layer.addEventListener(
  'touchmove',
  (e) => {
    if (!scrollableIn(e.target)) e.preventDefault();
  },
  { passive: false }
);

function closeModal(immediate = false) {
  if (modalHeld) return;
  const gen = ++modalGen;
  layer.classList.remove('show');
  const clear = () => {
    if (gen !== modalGen) return;
    layer.classList.remove('open');
    layer.innerHTML = '';
    if (modalQueue.length) showQueuedModal();
  };
  if (immediate) clear();
  else setTimeout(clear, 260);
}

function modalHead(title, okLabel = 'Fertig') {
  return `<div class="modal-head">
    <button class="modal-btn" data-m="cancel">Abbrechen</button>
    <b>${title}</b>
    <button class="modal-btn strong" data-m="ok">${okLabel}</button>
  </div>`;
}

/** Scroll-Räder wie bei iOS. columns: [{ values, label }], initial: Werte je Spalte */
function wheelPicker(title, columns, initial, onDone, extraHTML = '', onExtra = null, onCancel = null) {
  const ITEM = 40;
  const modal = openModal(
    `${modalHead(title)}
    <div class="wheels">
      ${columns
        .map(
          (col, ci) => `${ci > 0 && col.sep ? `<div class="wheel-sep">${col.sep}</div>` : ''}
        <div class="wheel" data-col="${ci}"><div class="wheel-list">${col.values
          .map((v) => `<div class="wheel-item">${col.label(v)}</div>`)
          .join('')}</div></div>`
        )
        .join('')}
      <div class="wheel-band"></div>
    </div>
    ${extraHTML}`,
    'sheet'
  );
  if (onCancel) modal.previousElementSibling.addEventListener('click', onCancel);
  const lists = [...modal.querySelectorAll('.wheel-list')];
  const indexOf = (list) => Math.max(0, Math.min(list.children.length - 1, Math.round(list.scrollTop / ITEM)));
  const mark = (list) => {
    const idx = indexOf(list);
    [...list.children].forEach((el, i) => el.classList.toggle('sel', i === idx));
  };
  lists.forEach((list, ci) => {
    const col = columns[ci];
    let idx = col.values.indexOf(initial[ci]);
    if (idx < 0) {
      // nächstliegenden Wert wählen
      idx = col.values.reduce((best, v, i) => (Math.abs(v - initial[ci]) < Math.abs(col.values[best] - initial[ci]) ? i : best), 0);
    }
    list.scrollTop = idx * ITEM;
    mark(list);
    let raf = 0;
    list.addEventListener('scroll', () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => mark(list));
    });
    list.addEventListener('click', (e) => {
      const item = e.target.closest('.wheel-item');
      if (item) list.scrollTo({ top: [...list.children].indexOf(item) * ITEM, behavior: 'smooth' });
    });
  });
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (!b) return;
    if (b.dataset.m === 'ok') {
      const vals = lists.map((list, ci) => columns[ci].values[indexOf(list)]);
      closeModal();
      onDone(vals);
    } else if (b.dataset.m === 'cancel') {
      closeModal();
      if (onCancel) onCancel();
    } else if (b.dataset.m === 'extra' && onExtra) {
      closeModal();
      onExtra();
    }
  });
}

function timePicker(title, initial, hasValue, onDone, onCancel = null) {
  const hours = Array.from({ length: 24 }, (_, i) => i);
  const step = settings.minuteStep;
  const minutes = Array.from({ length: 60 / step }, (_, i) => i * step);
  const shown = initial % 1440; // eingelesenes 24:00 steht auf 00:00
  const snapped = Math.floor(shown / 60) * 60 + Math.floor((shown % 60) / step) * step;
  wheelPicker(
    title,
    [
      { values: hours, label: pad },
      { values: minutes, label: pad, sep: ':' },
    ],
    [Math.floor(shown / 60), snapped % 60],
    // Nicht gedreht: ein Wert außerhalb des Rasters (z. B. eingelesen 07:45) bleibt, wie er ist
    ([h, m]) => onDone(hasValue && h * 60 + m === snapped ? initial : h * 60 + m),
    hasValue ? `<button class="modal-wide destructive" data-m="extra">Zeit löschen</button>` : '',
    () => onDone(null),
    onCancel
  );
}

/** Wochenwahl; withImport: darunter „Datei einlesen …“ (beim „+“) */
function weekPicker(initial, excludeId, onPick, withImport = false) {
  let selected = startOfDay(initial);
  let month = new Date(selected.getFullYear(), selected.getMonth(), 1);
  const modal = openModal(`${modalHead('Woche wählen', 'Übernehmen')}<div class="wp"></div>`, 'sheet wp-sheet');
  const wp = modal.querySelector('.wp');
  if (withImport) wp.insertAdjacentHTML('afterend', `<button class="modal-wide wp-import" data-wp="import">${ICON.doc} Datei einlesen …</button>`);
  const openedAt = Date.now();

  // Wochen, für die es schon einen Zettel gibt: Montag → 'sent' oder 'open' (offen hat Vorrang)
  const known = new Map();
  const mark = (monday, sent) => {
    const k = isoDate(mondayOf(monday));
    known.set(k, known.get(k) === 'open' || !sent ? 'open' : 'sent');
  };
  for (const sh of sheets) if (sh.id !== excludeId) mark(parseDate(sh.weekStart), !!sh.sentAt);

  /** Ein Monat als Raster: Kopfzeile, KW-Spalte, Tage – immer 6 Wochen, damit der Kalender beim Blättern gleich hoch bleibt */
  function gridHTML(m) {
    const preview = newSheet(selected, '');
    const weeks = [0, 1, 2, 3, 4, 5].map((k) => addDays(mondayOf(m), 7 * k));
    const today = new Date();
    return `<div class="wp-grid">
        <div class="wp-h">KW</div>${WEEKDAYS_SHORT.map((d) => `<div class="wp-h">${d}</div>`).join('')}
        ${weeks
          .map((w) => {
            const inWeek = isoDate(w) === preview.weekStart;
            return `<div class="wp-kw ${known.get(isoDate(w)) || ''}"><span>${isoWeek(w)}</span></div>${[0, 1, 2, 3, 4, 5, 6]
              .map((i) => {
                const d = addDays(w, i);
                const cls = [
                  'wp-day',
                  d.getMonth() !== m.getMonth() ? 'out' : '',
                  inWeek ? 'in-week' : '',
                  inWeek && d.getMonth() + 1 === preview.month && d.getFullYear() === preview.year ? 'in-sheet' : '',
                  sameDay(d, selected) ? 'sel' : '',
                  sameDay(d, today) ? 'today' : '',
                  holidayName(d) ? 'holiday' : '',
                ].join(' ');
                return `<button class="${cls}" data-date="${isoDate(d)}"><span class="wp-num">${d.getDate()}</span></button>`;
              })
              .join('')}`;
          })
          .join('')}
      </div>`;
  }

  // Vormonat, Monat und Folgemonat liegen nebeneinander; beim Wischen wird der Streifen mit dem Finger verschoben
  let strip = null;
  let viewport = null;
  function draw() {
    const preview = newSheet(selected, '');
    const exists = existingSheet(selected, excludeId);
    const prevMonth = new Date(month.getFullYear(), month.getMonth() - 1, 1);
    const nextMonth = new Date(month.getFullYear(), month.getMonth() + 1, 1);

    wp.innerHTML = `
      <div class="wp-nav">
        <button class="icon-btn" data-wp="prev" aria-label="Voriger Monat">${ICON.chevronLeft}</button>
        <b>${MONTHS[month.getMonth()]} ${month.getFullYear()}</b>
        <button class="icon-btn" data-wp="next" aria-label="Nächster Monat">${ICON.chevronRight}</button>
      </div>
      <div class="wp-viewport"><div class="wp-strip">${gridHTML(prevMonth)}${gridHTML(month)}${gridHTML(nextMonth)}</div></div>
      <div class="wp-preview">
        <b>${sheetTitle(preview)}</b>
        <span class="muted">${exists ? (excludeId ? 'Für diese Woche gibt es schon einen Zettel' : 'Gibt es schon – wird geöffnet') : 'Ausgegraute Tage gehören zum anderen Monat'}</span>
        ${holidaysLine()}
      </div>`;
    viewport = wp.querySelector('.wp-viewport');
    strip = wp.querySelector('.wp-strip');
  }
  /** Feiertage der gewählten Woche: „Feiertag: Fr 03.10. Tag der Deutschen Einheit“ (Platz für zwei Zeilen) */
  function holidaysLine() {
    const monday = mondayOf(selected);
    const list = [0, 1, 2, 3, 4, 5, 6]
      .map((i) => addDays(monday, i))
      .filter((d) => holidayName(d))
      .map((d) => `${WEEKDAYS_SHORT[(d.getDay() + 6) % 7]} ${fmtDayMonth(d)} ${escapeHtml(holidayName(d))}`);
    // Zeile ist immer da (auch leer), damit der Kalender beim Auswählen nicht springt
    return `<span class="wp-hol-line">${list.length ? `Feiertag: ${list.join(', ')}` : ''}</span>`;
  }

  const POS = { '-1': '0%', 0: '-33.3333%', 1: '-66.6667%' };
  let animating = false;
  /** Streifen einrasten lassen: dir −1 = Vormonat, 0 = zurück, 1 = Folgemonat */
  function settle(dir) {
    animating = true;
    strip.style.transition = 'transform 0.28s cubic-bezier(0.25, 0.8, 0.3, 1)';
    strip.style.transform = `translateX(${POS[dir]})`;
    setTimeout(() => {
      animating = false;
      if (dir) {
        month = new Date(month.getFullYear(), month.getMonth() + dir, 1);
        draw();
      }
    }, 290);
  }
  const shiftMonth = (dir) => !animating && settle(dir);
  draw();

  // Monat mit dem Finger ziehen (wie das Wischen zum Löschen)
  let drag = null;
  let draggedAt = 0;
  wp.addEventListener(
    'touchstart',
    (e) => {
      drag =
        !animating && e.touches.length === 1 && e.target.closest('.wp-viewport')
          ? { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now(), dx: 0, active: false, dead: false }
          : null;
    },
    { passive: true }
  );
  wp.addEventListener(
    'touchmove',
    (e) => {
      if (!drag || drag.dead) return;
      const dx = e.touches[0].clientX - drag.x;
      const dy = e.touches[0].clientY - drag.y;
      if (!drag.active) {
        if (Math.abs(dy) > 10 && Math.abs(dy) >= Math.abs(dx)) return void (drag.dead = true);
        if (Math.abs(dx) < 10 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        drag.active = true;
        drag.x = e.touches[0].clientX;
        strip.style.transition = 'none';
        return;
      }
      drag.dx = dx;
      strip.style.transform = `translateX(calc(-33.3333% + ${dx}px))`;
    },
    { passive: true }
  );
  const endDrag = () => {
    const d = drag;
    drag = null;
    if (!d || !d.active) return;
    draggedAt = Date.now();
    const fast = Math.abs(d.dx) / Math.max(1, Date.now() - d.t) > 0.5 && Math.abs(d.dx) > 30;
    settle(Math.abs(d.dx) > viewport.offsetWidth * 0.25 || fast ? (d.dx < 0 ? 1 : -1) : 0);
  };
  wp.addEventListener('touchend', endDrag, { passive: true });
  wp.addEventListener('touchcancel', endDrag, { passive: true });

  modal.addEventListener('click', (e) => {
    const t = e.target.closest('[data-wp],[data-date],[data-m]');
    if (!t) return;
    if (t.dataset.wp === 'prev') return shiftMonth(-1);
    if (t.dataset.wp === 'next') return shiftMonth(1);
    if (t.dataset.date) {
      if (animating || Date.now() - draggedAt < 350) return; // nach dem Ziehen keinen Tag auswählen
      selected = parseDate(t.dataset.date);
    }
    else if (t.dataset.m === 'cancel') return closeModal();
    else if (t.dataset.wp === 'import') {
      // Kurz nach dem Öffnen nicht (zweites Antippen des „+“ liegt an derselben Stelle)
      if (Date.now() - openedAt < 600) return;
      // Dateiauswahl direkt im Antippen öffnen (sonst blockiert Safari sie)
      pickImportFile();
      return closeModal();
    } else if (t.dataset.m === 'ok') {
      closeModal();
      onPick(selected);
      return;
    }
    draw();
  });
}

function actionSheet(actions) {
  const modal = openModal(
    `<div class="action-group">${actions
      .map((a, i) => `<button class="action ${a.destructive ? 'destructive' : ''}" data-i="${i}">${a.label}</button>`)
      .join('')}</div>
    <button class="action cancel" data-i="-1">Abbrechen</button>`,
    'actions'
  );
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-i]');
    if (!b) return;
    closeModal();
    const a = actions[Number(b.dataset.i)];
    // sofort ausführen: Zwischenablage und Teilen-Menü funktionieren in Safari nur direkt beim Antippen
    if (a) a.run();
  });
}

function confirmDialog(title, message, okLabel, onOk, destructive = false, cancelLabel = 'Abbrechen', onCancel = null) {
  const modal = openModal(
    `<div class="alert-body"><b>${title}</b><div class="alert-msg">${message}</div></div>
    <div class="alert-buttons">
      <button data-c="no">${cancelLabel}</button>
      <button data-c="yes" class="${destructive ? 'destructive' : 'strong'}">${okLabel}</button>
    </div>`,
    'alert'
  );
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    closeModal();
    if (b.dataset.c === 'yes') onOk();
    else if (onCancel) onCancel();
  });
  // Antippen neben das Fenster zählt wie Abbrechen
  if (onCancel) modal.previousElementSibling.addEventListener('click', onCancel);
}

let toastTimer = 0;
function toast(text, ms = 2200) {
  const el = document.getElementById('toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

// ───────────────────────── Vorschläge (Baustelle / Art der Arbeit) ─────────────────────────

/** Feste Leiste direkt über der Tastatur, zeigt die Vorschläge zum gerade bearbeiteten Feld */
const suggestBar = document.createElement('div');
suggestBar.id = 'suggest-bar';
suggestBar.innerHTML = '<div class="suggest-grid"></div>';
document.body.appendChild(suggestBar);
const suggestGrid = suggestBar.firstChild;
/** Abstand zweier Texte: Buchstaben einfügen, löschen, ersetzen oder zwei benachbarte vertauschen zählt je 1 */
function editDistance(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[a.length][b.length];
}

/**
 * Tippfehler bei Baustelle / Art der Arbeit: Ein Eintrag, den es so in keiner anderen Zeile gibt, der aber fast einem
 * Eintrag gleicht, der schon in mindestens zwei anderen Zeilen steht (bei einmal gegen einmal ist unklar, was richtig ist).
 * Als Tippfehler zählen: Leerzeichen („Kühl Haus“/„Kühlhaus“), Groß-/Kleinschreibung im Text und 1–2 Buchstaben
 * je Wort (Wörter unter 5 Zeichen nie, unter 10 Zeichen höchstens 1, erster Buchstabe gleich). Nicht: nur Satzzeichen oder großer Anfangsbuchstabe,
 * Mehrzahl und Endungen („Klimaanlage“/„Klimaanlagen“), Vorsilben („abgebaut“/„aufgebaut“, „Zelle“/„TK-Zelle“), andere Zahlen.
 * Ergebnis: { part, suggestion } oder null. „So lassen“ (✕) merkt sich der Eintrag in row.typoOk.
 */
function typoFor(field, row) {
  const value = row[field] || '';
  if (settings.typoHints === false || !value.trim() || (row.typoOk && row.typoOk[field] === value)) return null;
  // Schreibweisen aus allen anderen Zeilen mit Anzahl
  const known = new Map();
  for (const sh of sheets)
    for (const d of sh.days)
      for (const r of d.rows) {
        if (r === row) continue;
        for (const part of field === 'work' ? (r[field] || '').split(',') : [r[field] || '']) {
          const v = part.trim();
          if (v) known.set(v, (known.get(v) || 0) + 1);
        }
      }
  const hidden = new Set(settings.hiddenSuggestions[field].map(sameKey));
  // Schreibweisen, die die KI schon korrigiert hat, sind kein Vorbild (sonst schlagen beide abwechselnd das Gegenteil vor)
  const aiWrong = (v) => typeof aiSpellFix === 'function' && !!aiSpellFix(v);
  const candidates = [...known].filter(([v, n]) => n >= 2 && !hidden.has(sameKey(v)) && !aiWrong(v));
  // Ohne Satzzeichen, Anfangsbuchstabe klein: was hier gleich ist, ist kein Tippfehler
  const loose = (x) => {
    const t = x.trim().replace(/[’‘`´ʼ′]/g, "'").replace(/[.,'\-–]/g, ' ').replace(/\s+/g, ' ').trim();
    return t.charAt(0).toLowerCase() + t.slice(1);
  };
  const words = (x) => sameKey(x).replace(/[.,'\-–]/g, ' ').split(/\s+/).filter(Boolean);
  // Zahlen einzeln vergleichen: „1-3“ und „13“ sind verschiedene Hausnummern
  const numbers = (x) => (x.match(/\d+/g) || []).join(' ');
  for (const raw of field === 'work' ? value.split(',') : [value]) {
    const part = raw.trim();
    if (!part || known.has(part)) continue; // genau so schon benutzt
    const key = searchKey(part);
    let hit = null;
    for (const [v, n] of candidates) {
      if (loose(v) === loose(part)) continue;
      // Andere Zahlen („Halle 3“ / „Halle 4“, „Markt 12“ / „Markt 13“) sind kein Tippfehler
      if (numbers(v) !== numbers(part)) continue;
      let dist = 0;
      if (searchKey(v) !== key) {
        const a = words(part);
        const b = words(v);
        if (a.length !== b.length) continue;
        for (let i = 0; i < a.length && dist !== Infinity; i++) {
          if (a[i] === b[i]) continue;
          const max = a[i].length >= 10 ? 2 : a[i].length >= 5 ? 1 : 0;
          // Ein Tippfehler ändert kaum den ersten Buchstaben („Tiefkühlzelle“/„Bierkühlzelle“ sind zwei Wörter)
          const d = max && a[i][0] === b[i][0] && !sameStem(a[i], b[i]) ? editDistance(a[i], b[i]) : Infinity;
          dist = d <= max ? dist + d : Infinity;
        }
        if (dist === Infinity) continue;
      }
      if (!hit || dist < hit.dist || (dist === hit.dist && n > hit.n)) hit = { v, n, dist };
    }
    if (hit) return { part, suggestion: hit.v };
  }
  return null;
}
/** Rechtschreibfehler laut KI (team.js, nur im Team und nach dem Verlassen des Feldes geprüft): { part, suggestion } oder null */
function aiTypoFor(field, row) {
  const value = row[field] || '';
  if (settings.typoHints === false || !value.trim() || (row.typoOk && row.typoOk[field] === value)) return null;
  for (const raw of field === 'work' ? value.split(',') : [value]) {
    const part = raw.trim();
    const fix = part && aiSpellFix(part);
    if (fix) return { part, suggestion: fix };
  }
  return null;
}
/** Feld verlassen: Einträge von der KI prüfen lassen und den Hinweis zeigen, sobald die Antwort da ist */
function aiCheckField(input) {
  if (settings.typoHints === false) return;
  // die Prüfung ist deutsch: kyrillisch geschriebene Teile nicht
  const parts = (input.dataset.f === 'work' ? input.value.split(',') : [input.value]).filter((p) => !hasCyrillic(p));
  aiSpellCheck(parts).then((fresh) => {
    if (fresh && input.isConnected && document.activeElement !== input && currentSheet()) refreshTypoHint(input);
  });
}
const TYPO_PREFIXES = ['', 'ab', 'an', 'auf', 'aus', 'be', 'ein', 'ent', 'ge', 'mit', 'nach', 'um', 'ver', 'vor', 'weg', 'zer', 'zu'];
/** Beugungsendungen: „Alter“/„Alten“, „Einbauen“/„Einbauten“ sind dasselbe Wort */
const TYPO_ENDINGS = ['', 'e', 'n', 'r', 's', 't', 'en', 'er', 'es', 'em', 'te', 'ten', 'st'];
/** Zwei Wörter, die sich nur in Endung (Mehrzahl, Beugung, Umlaut) oder Vorsilbe unterscheiden – so gewollt, kein Tippfehler */
function sameStem(a, b) {
  const fold = (w) => w.replace(/ä/g, 'a').replace(/ö/g, 'o').replace(/ü/g, 'u');
  const [s, l] = [fold(a), fold(b)].sort((x, y) => x.length - y.length);
  if (s === l || l.endsWith(s) || (l.startsWith(s) && l.length - s.length <= 3)) return true;
  // gleicher Anfang (mind. 4 Buchstaben), nur die Endung anders
  let p = 0;
  while (p < s.length && s[p] === l[p]) p++;
  if (p >= 4 && TYPO_ENDINGS.includes(s.slice(p)) && TYPO_ENDINGS.includes(l.slice(p))) return true;
  // gleiches Ende (mind. 3 Buchstaben, z. B. „bau“, „zug“), nur die Vorsilbe anders („Aufbau“/„Ausbau“)
  let k = 0;
  while (k < s.length && s[s.length - 1 - k] === l[l.length - 1 - k]) k++;
  return k >= 3 && TYPO_PREFIXES.includes(s.slice(0, s.length - k)) && TYPO_PREFIXES.includes(l.slice(0, l.length - k));
}
/** Hinweis, wenn ein Text Zeichen enthält, die im PDF als „?“ erscheinen; sonst '' */
function pdfCharHint(text) {
  // Kyrillisch übersetzt die KI fürs PDF ins Deutsche (siehe deDeep); erst ohne Übersetzung bleibt der Hinweis
  const miss = pdfMissingChars(hasCyrillic(text) ? aiTr(text, 'de') : text);
  if (!miss.length) return '';
  if (miss.some((ch) => /\p{Script=Cyrillic}/u.test(ch))) return 'Kyrillisch wird im PDF zu „?“';
  return `„${miss.join(' ')}“ ${miss.length > 1 ? 'werden' : 'wird'} im PDF zu „?“`;
}
const pdfHintHTML = (text) => {
  const h = pdfCharHint(text);
  return h ? `<div class="typo-hint pdf-hint">⚠️ ${escapeHtml(h)}</div>` : '';
};
/** Hinweis unter Feldern außerhalb der Zettel-Zeilen (Reisekosten, Name) nach dem Verlassen neu setzen */
function refreshPdfHint(input) {
  const box = input.closest('.trip-field, .field, .s-namefield');
  if (!box) return;
  const old = box.nextElementSibling;
  if (old && old.classList.contains('pdf-hint')) old.remove();
  box.insertAdjacentHTML('afterend', pdfHintHTML(input.value));
}
const typoHintHTML = (field, row) => {
  // Zeichen, die im PDF fehlen, gehen dem Tippfehler-Hinweis vor
  const pdf = pdfHintHTML(row[field]);
  if (pdf) return pdf.replace('class="typo-hint pdf-hint"', `class="typo-hint pdf-hint" data-typo="${field}"`);
  const t = typoFor(field, row) || aiTypoFor(field, row);
  return t
    ? `<div class="typo-hint" data-typo="${field}"><span class="typo-text">Meintest du <button data-act="typo-fix" data-f="${field}" data-v="${escapeHtml(t.suggestion)}" data-p="${escapeHtml(t.part)}" translate="no">„${escapeHtml(t.suggestion)}“</button>?</span><button class="typo-x" data-act="typo-ok" data-f="${field}" aria-label="So lassen">✕</button></div>`
    : '';
};
/** Hinweis eines Feldes neu setzen (nach dem Verlassen des Feldes); beim Tippen ausblenden */
function refreshTypoHint(input, show = true) {
  const { row } = rowContext(input);
  const wrap = input.closest('.suggest-wrap');
  if (!wrap) return; // Arbeitsschein-Fenster: keine Hinweise
  const old = wrap.nextElementSibling;
  if (old && old.classList.contains('typo-hint')) old.remove();
  if (show && row) wrap.insertAdjacentHTML('afterend', typoHintHTML(input.dataset.f, row));
}

let suggestInput = null;

/** Art der Arbeit: Teile vor dem letzten Komma (fertig) und der Text dahinter (Suchbegriff) */
function workParts(value) {
  const parts = value.split(',');
  const last = parts.pop().trim();
  return { done: parts.map((p) => p.trim()).filter(Boolean), last };
}
const isKnown = (field, text) => suggestions[field].some((v) => sameKey(v) === sameKey(text));

function suggestionsFor(input) {
  const field = input.dataset.f;
  let q = input.value;
  let used = [];
  if (field === 'work') {
    const { done, last } = workParts(input.value);
    used = done.map(sameKey);
    // Ein vollständiger Eintrag am Ende gilt als ausgewählt, danach wird alles Übrige vorgeschlagen
    if (last && isKnown('work', last)) {
      used.push(sameKey(last));
      q = '';
    } else {
      q = last;
    }
  }
  // Vergleich ohne Apostrophe, Leerzeichen usw.: „bäckerseck“ findet „Bäcker's Eck“
  const match = (query) =>
    suggestions[field].filter((v) => {
      const k = sameKey(v);
      return k !== sameKey(query) && !used.includes(k) && (!searchKey(query) || searchKey(v).includes(searchKey(query)));
    });
  let list = match(q);
  // Art der Arbeit: Passt eigener Text zu keinem Vorschlag, trotzdem alle zum Anhängen zeigen
  if (field === 'work' && q && !list.length) list = match('');
  if (field === 'work') {
    // Was an der Baustelle dieser Zeile schon gemacht wurde, steht vorne (die häufigsten zuerst)
    const siteInput = input.closest('.row, .ws-form')?.querySelector('[data-f="site"]');
    const counts = workBySite.get(sameKey(siteInput ? siteInput.value : ''));
    if (counts) {
      const n = (v) => counts.get(sameKey(v)) || 0;
      list = [...list.filter((v) => n(v)).sort((a, b) => n(b) - n(a)), ...list.filter((v) => !n(v))];
    }
  }
  // Was mit dem getippten Text beginnt, steht vor dem, was ihn nur irgendwo enthält (Reihenfolge sonst wie oben)
  const typed = searchKey(q);
  if (typed) list = [...list.filter((v) => searchKey(v).startsWith(typed)), ...list.filter((v) => !searchKey(v).startsWith(typed))];
  return list;
}

/** Vorschlag aus der Leiste ausblenden (nach langem Drücken) */
function askHideSuggestion(text) {
  const input = suggestInput;
  if (!input || input.closest('#modal-layer')) return;
  const field = input.dataset.f;
  confirmDialog(
    'Vorschlag ausblenden?',
    `„${escapeHtml(text)}“ erscheint nicht mehr in der Leiste.`,
    'Ausblenden',
    () => {
      settings.hiddenSuggestions[field].push(text);
      saveSettings();
      suggestions[field] = suggestions[field].filter((v) => sameKey(v) !== sameKey(text));
      toast('Vorschlag ausgeblendet');
    }
  );
}

function showChips(input) {
  if (settings.suggestBar === false) return hideChips();
  suggestInput = input;
  const list = suggestionsFor(input).slice(0, 30);
  // Zwei unabhängige Reihen, jede Kapsel so breit wie ihr Text: der nächste Vorschlag kommt in die
  // kürzere Reihe (geschätzt nach Zeichen), so bleiben beide etwa gleich lang und man sieht mehr Vorschläge
  const rows = [[], []];
  const len = [0, 0];
  for (const v of list) {
    const r = len[0] <= len[1] ? 0 : 1;
    rows[r].push(v);
    len[r] += v.length + 4;
  }
  suggestGrid.innerHTML = rows
    .filter((r) => r.length)
    .map((r) => `<div class="suggest-row">${r.map((v) => `<button class="chip" data-chip="${escapeHtml(v)}" translate="no">${escapeHtml(v)}</button>`).join('')}</div>`)
    .join('');
  suggestGrid.scrollLeft = 0;
  suggestBar.classList.toggle('show', list.length > 0);
  suggestBar.classList.toggle('in-modal', !!input.closest('#modal-layer'));
  placeSuggestBar();
}
/** Art der Arbeit: ein Komma am Ende (von der letzten Auswahl) wieder entfernen */
function trimWorkInput(input) {
  if (!input || input.dataset.f !== 'work') return;
  const trimmed = input.value.replace(/[\s,]+$/, '');
  if (trimmed === input.value) return;
  input.value = trimmed;
  input.dispatchEvent(new Event('input', { bubbles: true }));
}
function hideChips() {
  suggestInput = null;
  suggestBar.classList.remove('show');
}

/** Leiste an die Oberkante der Tastatur setzen; beim Öffnen und Tippen das Feld darüber sichtbar halten */
function placeSuggestBar(keepVisible = true) {
  if (!suggestBar.classList.contains('show')) return;
  const vv = window.visualViewport;
  const bottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
  const top = bottom - suggestBar.offsetHeight;
  suggestBar.style.transform = `translate3d(0, ${top}px, 0)`;
  if (keepVisible && suggestInput) {
    const r = suggestInput.getBoundingClientRect();
    if (r.bottom > top - 8) window.scrollBy(0, r.bottom - top + 16);
  }
}
/** Eingabefeld, in dem gerade getippt wird */
const typingField = () => {
  const el = document.activeElement;
  return el && el.matches('input, textarea') ? el : null;
};
/** Tastatur offen: der sichtbare Ausschnitt ist deutlich kleiner als das Fenster */
const keyboardOpen = () => !!window.visualViewport && window.innerHeight - visualViewport.height > 120;
/** Bei offener Tastatur verschiebt iOS den sichtbaren Ausschnitt; die feste Kopfzeile (z. B. die Suche) bleibt oben im Bild.
 *  Nur dann – beim Nachfedern am Seitenende verschiebt iOS den Ausschnitt ebenfalls, da soll die Kopfzeile stehen bleiben. */
function placeNav() {
  const nav = document.querySelector('.nav');
  const y = typingField() && keyboardOpen() ? Math.max(0, visualViewport.offsetTop) : 0;
  if (nav) nav.style.transform = y ? `translate3d(0, ${y}px, 0)` : '';
}
// Nach dem Schließen der Tastatur kommen die letzten Meldungen von iOS teils noch während der Animation:
// Position mehrmals nachprüfen, damit die Kopfzeile nicht verschoben stehen bleibt
document.addEventListener('focusout', () => {
  requestAnimationFrame(placeNav);
  for (const ms of [150, 350, 700, 1200]) setTimeout(placeNav, ms);
});
/** Wie in iOS-Apps: Ziehen am Inhalt schließt die Tastatur (mit Tastatur würden die festen Leisten beim Scrollen zittern).
 *  Langsames Ziehen meldet iOS teils kaum über touchmove – daher zählt auch jedes Scrollen, solange der Finger aufliegt. */
let scrollTouch = null; // { y, target }
function dismissKeyboardOnScroll() {
  const el = typingField();
  if (!scrollTouch || drag || !el) return;
  if (scrollTouch.target === el || scrollTouch.target.closest?.('#suggest-bar')) return;
  scrollTouch = null;
  el.blur();
}
document.addEventListener(
  'touchstart',
  (e) => {
    scrollTouch = e.touches.length === 1 ? { y: e.touches[0].clientY, target: e.target } : null;
    // In der Suche schließt schon das Berühren der Ergebnisliste die Tastatur (vor dem Scrollen, das iOS
    // auf Listeneinträgen bei langsamem Start nicht zuverlässig meldet)
    const el = typingField();
    if (el && el.matches('[data-search]') && !e.target.closest('.nav')) el.blur();
  },
  { passive: true }
);
document.addEventListener(
  'touchmove',
  (e) => {
    if (scrollTouch && Math.abs(e.touches[0].clientY - scrollTouch.y) > 6) dismissKeyboardOnScroll();
  },
  { passive: true }
);
// Nur touchend beendet die Geste: Bei langsamem Start auf einem Listeneintrag (Link) bricht iOS die Berührung
// mit touchcancel ab, scrollt aber weiter, solange der Finger aufliegt
document.addEventListener('touchend', () => (scrollTouch = null), { passive: true });
// Wechsel ins nächste Feld (Pfeile über der Tastatur) scrollt ebenfalls – das soll die Tastatur nicht schließen
document.addEventListener('focusin', () => (scrollTouch = null));
window.addEventListener('scroll', dismissKeyboardOnScroll, { passive: true });
if (window.visualViewport) visualViewport.addEventListener('scroll', dismissKeyboardOnScroll);

/** Beginnt die Berührung im Feld, in dem gerade geschrieben wird (z. B. lange drücken für den Cursor),
 *  scrollt die Seite nicht: Ziehen wird unterbunden und ein trotzdem ausgelöstes Scrollen zurückgesetzt. */
let fieldTouch = null; // { y: Scrollstand beim Berühren }
document.addEventListener(
  'touchstart',
  (e) => {
    const el = typingField();
    fieldTouch = el && e.touches.length === 1 && e.target === el && keyboardOpen() ? { y: window.scrollY } : null;
  },
  { passive: true }
);
document.addEventListener(
  'touchmove',
  (e) => {
    if (fieldTouch && e.cancelable) e.preventDefault();
  },
  { passive: false }
);
window.addEventListener(
  'scroll',
  () => {
    if (fieldTouch && window.scrollY !== fieldTouch.y) window.scrollTo(0, fieldTouch.y);
  },
  { passive: true }
);
document.addEventListener('touchend', () => (fieldTouch = null), { passive: true });
document.addEventListener('touchcancel', () => (fieldTouch = null), { passive: true });
document.addEventListener('focusout', () => (fieldTouch = null));

/** Antippen eines Textfelds: iOS scrollt die Seite sonst beim Fokussieren, auch wenn das Feld über der Tastatur
 *  sichtbar bliebe. Darum selbst fokussieren, ohne zu scrollen, und den Cursor an die angetippte Stelle setzen
 *  (den Klick danach unterdrücken, sonst scrollt iOS doch). Verdeckt die Tastatur oder die
 *  Vorschlagsleiste das Feld, schiebt es `revealField` bzw. `placeSuggestBar` nur so weit wie nötig nach oben. */
const TAP_FIELDS = 'textarea, input:not([type]), input[type="text"]';
let tapStart = null; // { x, y, at }
document.addEventListener(
  'touchstart',
  (e) => (tapStart = e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY, at: Date.now() } : null),
  { passive: true }
);
document.addEventListener(
  'touchend',
  (e) => {
    const el = e.target.closest?.(TAP_FIELDS);
    const t = e.changedTouches[0];
    if (!el || el === document.activeElement || el.disabled || el.readOnly || !tapStart) return;
    if (Math.hypot(t.clientX - tapStart.x, t.clientY - tapStart.y) > 10) return;
    // Langes Drücken: iOS setzt den Cursor selbst dorthin, wo die Lupe stand
    if (Date.now() - tapStart.at > 400) return;
    const pos = caretAt(el, t.clientX, t.clientY);
    // Ohne den folgenden Klick, der iOS sonst doch noch scrollen lässt
    if (e.cancelable) e.preventDefault();
    el.focus({ preventScroll: true });
    el.setSelectionRange(pos, pos);
  },
  { passive: false }
);
/** Textstelle unter einem Punkt im Feld: Text in einer unsichtbaren Kopie mit gleicher Schrift und Breite nachmessen.
 *  Wie bei iOS landet der Cursor am Wortende bzw. -anfang, nicht mitten im Wort. */
function caretAt(el, x, y) {
  const text = el.value;
  const cs = getComputedStyle(el);
  const r = el.getBoundingClientRect();
  const m = document.createElement('div');
  for (const p of ['fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'wordSpacing', 'textIndent', 'lineHeight', 'textAlign', 'boxSizing'])
    m.style[p] = cs[p];
  for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
    m.style[`padding${side}`] = cs[`padding${side}`];
    m.style[`border${side}Width`] = cs[`border${side}Width`];
  }
  // Unsichtbar (durchsichtige Schrift), aber kurz oben auf, damit die Abfrage die Kopie trifft
  Object.assign(m.style, {
    position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
    whiteSpace: el.tagName === 'TEXTAREA' ? 'pre-wrap' : 'pre', overflowWrap: 'break-word', overflow: 'hidden',
    color: 'transparent', background: 'none', borderStyle: 'solid', borderColor: 'transparent', zIndex: '2147483647',
    webkitUserSelect: 'text', userSelect: 'text',
  });
  m.textContent = text;
  document.body.appendChild(m);
  const hit = document.caretRangeFromPoint?.(x, y);
  const pos = hit && hit.startContainer === m.firstChild ? hit.startOffset : text.length;
  m.remove();
  // Wie iOS: im Wort an dessen Anfang oder Ende, je nachdem, was näher liegt
  const before = text.slice(0, pos).search(/\S*$/);
  const after = pos + text.slice(pos).search(/\s|$/);
  return pos - before <= after - pos ? before : after;
}
/** Feld, in dem geschrieben wird, über der Tastatur halten (mit Vorschlägen übernimmt das `placeSuggestBar`) */
function revealField() {
  const el = typingField();
  if (!el || !keyboardOpen() || suggestBar.classList.contains('show') || el.closest('.nav, #modal-layer')) return;
  const bottom = visualViewport.offsetTop + visualViewport.height;
  const r = el.getBoundingClientRect();
  if (r.bottom > bottom - 8) window.scrollBy(0, r.bottom - bottom + 16);
}

if (window.visualViewport) {
  // Beim Scrollen nur mitziehen, sofort und ohne die Seite zu verschieben (sonst zittert die Leiste)
  visualViewport.addEventListener('resize', () => {
    placeSuggestBar();
    revealField();
    placeNav();
  });
  visualViewport.addEventListener('scroll', () => {
    placeSuggestBar(false);
    placeNav();
  });
}

/** Vorschlag übernehmen: Baustelle ersetzt und schließt, Art der Arbeit hängt mit Komma an */
function pickChip(text) {
  const input = suggestInput;
  if (!input) return;
  if (input.dataset.f === 'work') {
    const { done, last } = workParts(input.value);
    // Angefangener Text wird durch den Vorschlag ersetzt, ein fertiger Eintrag bleibt stehen
    if (last && isKnown('work', last)) done.push(last);
    else if (last && !searchKey(text).includes(searchKey(last))) done.push(last);
    done.push(text);
    // Passt der Vorschlag nicht mehr in die Zeile (Zeichengrenze), wird er nicht angehängt
    if (done.join(', ').length > MAX_LEN.work) return toast('Kein Platz mehr in dieser Zeile');
    // Komma und Leerzeichen gleich mitsetzen, damit direkt weitergeschrieben werden kann
    input.value = `${done.join(', ')}, `.slice(0, MAX_LEN.work);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  } else {
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    hideChips();
    input.blur();
  }
}

// Antippen ohne Fokusverlust: Auswahl beim Loslassen, Wischen zum Blättern bleibt möglich
// Lange drücken (600 ms) blendet den Vorschlag aus
let chipTouch = null;
suggestBar.addEventListener('touchstart', (e) => {
  const t = e.touches[0];
  const chip = e.target.closest('[data-chip]');
  const touch = { x: t.clientX, y: t.clientY, chip, long: false };
  if (chip) {
    touch.timer = setTimeout(() => {
      touch.long = true;
      askHideSuggestion(chip.dataset.chip);
    }, 600);
  }
  chipTouch = touch;
}, { passive: true });
suggestBar.addEventListener('touchmove', (e) => {
  const t = e.touches[0];
  if (chipTouch && (Math.abs(t.clientX - chipTouch.x) > 10 || Math.abs(t.clientY - chipTouch.y) > 10)) clearTimeout(chipTouch.timer);
}, { passive: true });
suggestBar.addEventListener('touchend', (e) => {
  const t = e.changedTouches[0];
  const start = chipTouch;
  chipTouch = null;
  e.preventDefault(); // kein Klick danach, das Eingabefeld behält den Fokus
  if (start) clearTimeout(start.timer);
  if (start && start.chip && !start.long && Math.abs(t.clientX - start.x) < 10 && Math.abs(t.clientY - start.y) < 10) {
    pickChip(start.chip.dataset.chip);
  }
}, { passive: false });
suggestBar.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const chip = e.target.closest('[data-chip]');
  if (chip && !('ontouchstart' in window)) askHideSuggestion(chip.dataset.chip);
});
suggestBar.addEventListener('mousedown', (e) => e.preventDefault());
suggestBar.addEventListener('click', (e) => {
  const chip = e.target.closest('[data-chip]');
  if (chip) pickChip(chip.dataset.chip);
});

// ───────────────────────── Ereignisse ─────────────────────────

// Zettel mit ungespeicherten Änderungen über Zurück, die Leiste unten oder „+“ verlassen: erst fragen
document.addEventListener(
  'click',
  (e) => {
    const el = e.target.closest('[data-act="back"], [data-act="tab"], [data-act="new"]');
    if (!el || layer.contains(el) || currentView !== 'editor' || !editorPending()) return;
    if (el.dataset.act === 'tab' && (location.hash || '#/') === el.dataset.hash) return;
    e.preventDefault();
    e.stopPropagation();
    confirmLeave(() => el.click());
  },
  true
);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (!el || layer.contains(el)) return;
  const act = el.dataset.act;
  switch (act) {
    case 'settings':
      location.hash = '#/einstellungen';
      break;
    case 'tab': {
      // Antippen der aktiven Seite: nach oben; sonst Seite wechseln (ohne neuen Verlaufseintrag)
      haptic();
      if ((location.hash || '#/') === el.dataset.hash) {
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      }
      const from = document.querySelector('#tabbar .tab-row > .tab.on');
      if (!from || from === el) {
        location.replace(el.dataset.hash);
        break;
      }
      // Seite kurz nach dem Antippen wechseln (TAB_PAGE_DELAY), während die Linse schon gleitet
      animateTabLens(from, el);
      from.classList.remove('on');
      el.classList.add('on');
      const hash = el.dataset.hash;
      setTimeout(() => location.replace(hash), TAB_PAGE_DELAY);
      break;
    }
    case 'new':
      // Wochenauswahl mit „Datei einlesen …“
      weekPicker(new Date(), null, (anchor) => {
        location.hash = `#/zettel/${encodeURIComponent(openOrCreate(anchor))}`;
      }, true);
      break;
    case 'gap': {
      // Fehlende Woche: einlesen oder neu erstellen (dann immer erst die Wochenauswahl, bei der ersten fehlenden Woche)
      const date = parseDate(el.dataset.date);
      actionSheet([
        { label: 'Stundenzettel einlesen …', run: pickImportFile },
        {
          label: 'Neuen Stundenzettel erstellen',
          run: () => weekPicker(date, null, (anchor) => (location.hash = `#/zettel/${encodeURIComponent(openOrCreate(anchor))}`)),
        },
      ]);
      break;
    }
    case 'delete':
      clearTimeout(swipeTimer); // offen lassen, solange die Rückfrage angezeigt wird
      askDelete(el.dataset.id, false, closeSwipe);
      break;
    case 'back':
      goBack();
      break;
    case 'ov-years':
      actionSheet(
        renderStats.years.map((v) => ({
          label: `${v}${v === statsYear ? ` <span class="ovc-check">${ICON.check}</span>` : ''}`,
          run: () => {
            if (v === statsYear) return;
            const snap = ovcSnapshot();
            statsYear = v;
            const top = window.scrollY;
            renderStats();
            window.scrollTo(0, top);
            ovcAnimate(document.querySelectorAll('#app [data-ovc]'), snap);
            // Monatsliste baut sich wie beim Öffnen der Seite neu auf (die Karten zählen stattdessen um)
            statsStagger('#app .ov-month, #app .ov-totallink');
          },
        }))
      );
      break;
    case 'week':
      changeWeek();
      break;
    case 'more':
      moreMenu();
      break;
    case 'share':
      // direkt im Antippen ausführen: Teilen-Menü und Zwischenablage gehen in Safari sonst nicht; Doppeltipp nur einmal
      if (Date.now() - (sendSheet.at || 0) < 1000) break;
      sendSheet.at = Date.now();
      sendSheet(currentSheet());
      break;
    case 'time':
      editTime(el);
      break;
    case 'pause':
      editPause(el);
      break;
    case 'status':
      chooseStatus(el);
      break;
    case 'report':
      pickReport(el);
      break;
    case 'team-day': {
      const { s, dayIndex } = rowContext(el);
      teamDayWindow(isoDate(sheetDate(s, dayIndex)));
      break;
    }
    case 'reports-open':
      location.hash = '#/arbeitsscheine';
      break;
    case 'report-sheet': {
      const rep = reports().find((r) => r.id === el.dataset.id);
      location.hash = `#/zettel/${encodeURIComponent(openOrCreate(parseDate(rep.date)))}`;
      break;
    }
    case 'report-delete': {
      const id = el.dataset.id;
      confirmDialog('Arbeitsschein löschen?', '', 'Löschen', () => {
        reportStore.items = reportStore.items.filter((r) => r.id !== id);
        saveReports();
        goBack();
      }, true);
      break;
    }
    case 'reports-fetch':
      fetchReports(true);
      break;
    case 'addrow': {
      const { s, dayIndex, day } = rowContext(el);
      // Neue Zeile beginnt dort, wo die vorherige geendet hat
      const row = emptyRow();
      const prev = day.rows.at(-1);
      if (prev && prev.end != null) row.start = prev.end;
      day.rows.push(row);
      saveSheets(s);
      refreshDay(dayIndex);
      expandIn(document.querySelector(`.row[data-row="${row.id}"]`));
      break;
    }
    case 'typo-fix': {
      // Vorgeschlagene Schreibweise übernehmen (bei Art der Arbeit nur den betroffenen Teil)
      const input = el.closest('.row').querySelector(`[data-f="${el.dataset.f}"]`);
      input.value =
        el.dataset.f === 'work'
          ? input.value
              .split(',')
              .map((p) => (p.trim() === el.dataset.p ? el.dataset.v : p.trim()))
              .filter(Boolean)
              .join(', ')
          : el.dataset.v;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      break;
    }
    case 'typo-ok': {
      // „So lassen“: Hinweis für genau diesen Text nicht mehr zeigen
      const { s, dayIndex, row } = rowContext(el);
      const f = el.dataset.f;
      row.typoOk = { ...row.typoOk, [f]: row[f] };
      // Gilt sofort, auch im gespeicherten Stand (sonst stünde der Tag als ungespeichert da)
      const saved = editorSaved && editorSaved.id === s.id && editorSaved.days[dayIndex].rows.find((r) => r.id === row.id);
      if (saved && saved[f] === row[f]) {
        saved.typoOk = { ...saved.typoOk, [f]: row[f] };
        editorSaved.dayJson[dayIndex] = JSON.stringify(editorSaved.days[dayIndex]);
      }
      saveSheets(s);
      el.closest('.typo-hint').remove();
      break;
    }
    case 'pdf-preview':
      openPdfPreview();
      break;
    case 'pdf-prev':
    case 'pdf-next':
      pdfPage = Math.max(0, Math.min(pdfUrls.length - 1, pdfPage + (act === 'pdf-next' ? 1 : -1)));
      showPdfPage();
      break;
    case 'delrow': {
      const { s, dayIndex, day, row } = rowContext(el);
      const rowEl = el.closest('.row');
      if (!row || rowEl.dataset.removing) break;
      // Die Zeile erst beim Löschen suchen (die Position kann sich bis dahin ändern); doppeltes Antippen löscht nur einmal
      const remove = () => {
        if (rowEl.dataset.removing) return;
        rowEl.dataset.removing = '1';
        collapseOut(rowEl, () => {
          const k = day.rows.indexOf(row);
          if (k < 0) return;
          day.rows.splice(k, 1);
          if (!day.rows.length) day.rows.push(emptyRow());
          saveSheets(s);
          refreshDay(dayIndex);
        });
      };
      if (rowIsEmpty(row)) remove();
      else confirmDialog('Zeile löschen?', 'Die Einträge dieser Zeile gehen verloren.', 'Löschen', remove, true);
      break;
    }
    case 'lang-set':
      // Sprache gilt ab dem nächsten Start der Seite (i18n.js liest sie vor allem anderen)
      if (el.dataset.v === LANG) break;
      settings.lang = el.dataset.v;
      saveSettings();
      location.reload();
      break;
    case 'theme-set': {
      settings.theme = el.dataset.v;
      saveSettings();
      applyTheme();
      const y = window.scrollY;
      renderSettings();
      window.scrollTo(0, y);
      break;
    }
    case 'backup-export':
      exportBackup();
      break;
    case 'payslip-delete': {
      const key = el.dataset.key;
      const p = payslips[key];
      if (!p) break;
      confirmDialog(`Lohnabrechnung ${MONTHS[p.month - 1]} ${p.year} löschen?`, 'Die eingelesenen Werte gehen verloren.', 'Löschen', () => {
        delete payslips[key];
        savePayslips();
        location.replace('#/uebersicht');
      }, true);
      break;
    }
    case 'open-trip': {
      e.preventDefault(); // nicht den Stundenzettel öffnen (Knopf liegt in dessen Zeile)
      const s = findSheet(el.dataset.id);
      const list = s ? tripsForSheet(s).filter((t) => t.dates.length) : [];
      if (list.length === 1) location.hash = `#/reise/${list[0].id}`;
      else if (list.length) actionSheet(list.map((t) => ({ label: escapeHtml(tripTitle(t)), run: () => (location.hash = `#/reise/${t.id}`) })));
      break;
    }
    case 'unhide': {
      const list = settings.hiddenSuggestions[el.dataset.field];
      settings.hiddenSuggestions[el.dataset.field] = list.filter((v) => v !== el.dataset.value);
      saveSettings();
      renderSettings();
      toast('Vorschlag wiederhergestellt');
      break;
    }
    case 'trip-toggle':
      toggleTripDay(el.dataset.date);
      break;
    case 'trip-range':
      shiftTripRange(Number(el.dataset.dir));
      break;
    case 'trip-time':
      editTripTime(el);
      break;
    case 'trip-more':
      tripMoreMenu();
      break;
    case 'trip-share':
      // direkt im Antippen ausführen: Teilen-Menü und Zwischenablage gehen in Safari sonst nicht
      sendTripWithCheck(currentTrip());
      break;
    case 'trip-sign': {
      // Unterschrift je Abrechnung (seit v91 nicht mehr aus den Einstellungen)
      const t = currentTrip();
      if (!t) break;
      signaturePad((sig) => {
        t.signature = sig;
        saveTrips(t);
        const y = window.scrollY;
        renderTrip(t.id);
        window.scrollTo(0, y);
      });
      break;
    }
    case 'search':
      searchQuery = '';
      renderList();
      window.scrollTo(0, 0);
      document.querySelector('[data-search]').focus();
      break;
    case 'search-close':
      searchQuery = null;
      renderList();
      window.scrollTo(0, 0);
      break;
    case 'to-top':
      window.scrollTo({ top: 0, behavior: 'smooth' });
      break;
    case 'jump':
      jumpToDay(Number(el.dataset.day));
      break;
    case 'save-day':
      saveDay(Number(el.closest('.day').dataset.day));
      break;
    case 'expand': {
      const { s, dayIndex } = rowContext(el);
      expandedDays.add(`${s.id}:${dayIndex}`);
      refreshDay(dayIndex);
      break;
    }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.ps && t.dataset.ps !== 'month' && t.dataset.ps !== 'year') {
    updatePayslipField(t);
    return;
  }
  if (t.dataset.f) {
    const s = currentSheet();
    if (!s) return;
    // Ein Eintrag bleibt eine Zeile Text (eingefügte Zeilenumbrüche werden zu Leerzeichen); das Feld wächst mit
    if (/\n/.test(t.value)) {
      const pos = t.value.slice(0, t.selectionStart).replace(/\s*\n\s*/g, ' ').length;
      t.value = t.value.replace(/\s*\n\s*/g, ' ');
      t.setSelectionRange(pos, pos);
    }
    if (t.matches('textarea')) fitTextarea(t);
    const { row, day } = rowContext(t);
    if (row) {
      row[t.dataset.f] = t.value;
      updateDayWarnings(t.closest('.day'), day);
      // Tippfehler-Hinweis erst nach dem Verlassen des Feldes (nicht während des Tippens)
      if (document.activeElement === t) refreshTypoHint(t, false);
      else refreshTypoHint(t);
    }
    // Nur am aktiven Feld (übernommener Korrekturvorschlag öffnet keine Vorschläge ohne Tastatur)
    if (document.activeElement === t) showChips(t);
    // Gespeichert wird erst mit „Speichern“ (savedSheets) – hier nur Rahmen und Knopf des Tages
    if (row) updateSaveBar();
  } else if (t.dataset.t) {
    const trip = currentTrip();
    const iso = t.closest('[data-date]').dataset.date;
    if (t.dataset.t === 'places' || t.dataset.t === 'works') {
      // Jeder Kasten im PDF ist eine Textzeile (höchstens zweizeilig umbrochen): keine Zeilenumbrüche
      if (/\n/.test(t.value)) t.value = t.value.replace(/\s*\n\s*/g, ' ');
      // Beide Felder speichern, damit eine alte gemeinsame Fassung („text“) nicht mehr gilt
      const dayEl = t.closest('.trip-day');
      const o = { ...(trip.over[iso] || {}) };
      delete o.text;
      o.places = dayEl.querySelector('[data-t="places"]').value;
      o.works = dayEl.querySelector('[data-t="works"]').value;
      trip.over[iso] = o;
      saveTrips(trip);
      fitTextarea(t);
    } else {
      const v = parseFloat(t.value.replace(',', '.'));
      setTripOver(trip, iso, 'meal', Number.isNaN(v) ? 0 : Math.max(0, v));
      document.getElementById('trip-total').textContent = fmtEuro(tripTotal(tripRows(trip)));
    }
  } else if (t.dataset.tp) {
    const trip = currentTrip();
    trip[t.dataset.tp] = t.value;
    saveTrips(trip);
  } else if (t.dataset.search != null) {
    searchQuery = t.value;
    refreshListBody();
  } else if (t.dataset.lockSwitch != null) {
    toggleLock(t, () => {
      const y = window.scrollY;
      renderSettings();
      window.scrollTo(0, y);
    });
  } else if (t.dataset.themeSwitch != null) {
    settings.theme = t.checked ? 'dark' : 'light';
    saveSettings();
    applyTheme();
  } else if (t.dataset.s) {
    settings[t.dataset.s] = t.type === 'checkbox' ? t.checked : t.value;
    saveSettings();
    if (t.dataset.s === 'theme') applyTheme();
    if (t.dataset.s === 'warnSigns') applyWarnSigns();
  }
});

document.addEventListener('change', (e) => {
  if (e.target.dataset.actChange === 'backup-import') importBackup(e.target);
  else if (e.target.dataset.actChange === 'payslip-import') importPayslip(e.target);
  else if (e.target.dataset.ps === 'month' || e.target.dataset.ps === 'year') updatePayslipField(e.target);
  else if (e.target.dataset.s === 'name') renameAll(e.target.value);
});

// iOS beendet die App im Hintergrund teils, ohne dass das Feld verlassen wurde – dann käme „change“ nie
document.addEventListener('visibilitychange', () => {
  if (document.hidden && document.activeElement?.matches?.('[data-s="name"]')) document.activeElement.blur();
});

/** Neuer Name aus den Einstellungen gilt für alle gespeicherten Zettel und Abrechnungen (beim Verlassen des Feldes) */
function renameAll(value) {
  const name = value.trim();
  if (!name) return;
  const now = Date.now();
  let n = 0;
  for (const s of sheets) {
    if (s.name === name) continue;
    s.name = name;
    s.updatedAt = now;
    n++;
  }
  let t = 0;
  for (const trip of trips) {
    if (trip.name === name) continue;
    trip.name = name;
    trip.updatedAt = now;
    t++;
  }
  if (n) saveSheets();
  if (t) saveTrips();
  if (n || t) toast(`Name in ${n} Stundenzettel${n === 1 ? '' : 'n'}${t ? ` und ${t} Abrechnung${t === 1 ? '' : 'en'}` : ''} geändert`);
}

document.addEventListener('focusin', (e) => {
  // Vorschläge nur für Baustelle und Arbeit (die Textfelder im Berichtsheft haben auch .txt, aber keine Vorschläge)
  if (e.target.matches('.txt[data-f], .ws-in[data-f]')) showChips(e.target);
});
document.addEventListener('focusout', (e) => {
  if (e.target.matches('.ws-in')) {
    trimWorkInput(e.target);
    if (suggestInput === e.target) hideChips();
    return;
  }
  if (!e.target.matches('.txt')) return;
  trimWorkInput(e.target);
  if (suggestInput === e.target) hideChips();
  if (e.target.dataset.f && currentSheet()) {
    refreshTypoHint(e.target);
    aiCheckField(e.target);
  }
});
// Kyrillisch eingetragen (Zettel, Berichtsheft, Reisekosten, Name …): gleich fürs PDF ins Deutsche übersetzen lassen
document.addEventListener('focusout', (e) => {
  const t = e.target;
  if (!t.matches || !t.matches('input, textarea') || t.matches('[data-team], [data-fb-word], [data-search]') || !hasCyrillic(t.value)) return;
  aiTranslate([t.value], 'de').then((fresh) => {
    if (!fresh) return;
    updatePdfThumb(true);
    if (!t.isConnected || document.activeElement === t) return;
    if (t.dataset.f && currentSheet()) refreshTypoHint(t);
    else if (t.matches('textarea.trip-text, [data-tp="place"], [data-s="name"]')) refreshPdfHint(t);
  });
});
document.addEventListener('focusout', (e) => {
  if (e.target.matches('textarea.trip-text, [data-tp="place"], [data-s="name"]')) refreshPdfHint(e.target);
});
document.addEventListener('keydown', (e) => {
  // Reisekosten: Return schließt die Tastatur (kein Zeilenumbruch im Kasten)
  if (e.key === 'Enter' && e.target.matches('textarea.trip-text')) {
    e.target.blur();
    e.preventDefault();
    return;
  }
  if (e.key === 'Enter' && e.target.matches('input:not([type=checkbox]), textarea.txt') && !e.target.form) {
    // „Weiter“ springt zum nächsten Feld der Zeile
    if (e.target.dataset.f === 'site') {
      const work = e.target.closest('.row').querySelector('[data-f="work"]');
      work.focus();
      // Mehrzeilige Felder setzen den Cursor sonst an den Anfang
      work.setSelectionRange(work.value.length, work.value.length);
    } else e.target.blur();
    e.preventDefault();
  }
});

// ───────────────────────── Wischen zum Löschen ─────────────────────────
// Eintrag in der Liste nach links ziehen: erst bei deutlich waagerechter Bewegung, „Löschen“ bleibt erst ab 70 px stehen.
// Die Option schließt nach 3 Sekunden, beim Berühren einer anderen Stelle und nach „Abbrechen“ in der Rückfrage.

const SWIPE_W = 92;
const SWIPE_OPEN = 70;
let swipeOpen = null;
let swipeTimer = 0;
let swipeDrag = null;
let swipeDraggedAt = 0;

function closeSwipe() {
  clearTimeout(swipeTimer);
  if (swipeOpen) swipeOpen.querySelector('.swipe-track').style.transform = '';
  swipeOpen = null;
}
function openSwipe(el) {
  if (swipeOpen && swipeOpen !== el) closeSwipe();
  swipeOpen = el;
  el.querySelector('.swipe-track').style.transform = `translateX(${-SWIPE_W}px)`;
  clearTimeout(swipeTimer);
  swipeTimer = setTimeout(closeSwipe, 3000);
}
document.addEventListener(
  'touchstart',
  (e) => {
    const el = e.target.closest('.swipe');
    if (swipeDrag && swipeDrag.active) endSwipe();
    if (swipeOpen && el !== swipeOpen) closeSwipe();
    swipeDrag =
      el && e.touches.length === 1 && !e.target.closest('.swipe-del')
        ? { el, x: e.touches[0].clientX, y: e.touches[0].clientY, base: el === swipeOpen ? -SWIPE_W : 0, active: false, dead: false, pos: 0 }
        : null;
  },
  { passive: true }
);
document.addEventListener(
  'touchmove',
  (e) => {
    const d = swipeDrag;
    if (!d || d.dead) return;
    const dx = e.touches[0].clientX - d.x;
    const dy = e.touches[0].clientY - d.y;
    if (!d.active) {
      // Senkrecht: normales Scrollen, die Zeile bleibt stehen
      if (Math.abs(dy) > 8 && Math.abs(dy) * 1.2 >= Math.abs(dx)) {
        d.dead = true;
        return;
      }
      if (Math.abs(dx) < 18 || Math.abs(dx) < Math.abs(dy) * 2) return;
      d.active = true;
      d.x = e.touches[0].clientX; // ab hier folgt die Zeile dem Finger, ohne Sprung
      clearTimeout(swipeTimer);
      d.track = d.el.querySelector('.swipe-track');
      d.track.classList.add('dragging');
      return;
    }
    d.pos = Math.max(-SWIPE_W - 24, Math.min(0, d.base + dx));
    d.track.style.transform = `translateX(${d.pos}px)`;
  },
  { passive: true }
);
const endSwipe = () => {
  const d = swipeDrag;
  swipeDrag = null;
  if (!d || !d.active) return;
  swipeDraggedAt = Date.now();
  d.track.classList.remove('dragging');
  if (d.pos <= -SWIPE_OPEN) openSwipe(d.el);
  else {
    if (swipeOpen === d.el) swipeOpen = null;
    clearTimeout(swipeTimer);
    d.track.style.transform = '';
  }
};
document.addEventListener('touchend', endSwipe, { passive: true });
document.addEventListener('touchcancel', endSwipe, { passive: true });
// Nach dem Ziehen nicht den Zettel öffnen; bei offener Option schließt ein Tipp auf den Eintrag sie nur
document.addEventListener(
  'click',
  (e) => {
    const sw = e.target.closest('.swipe');
    if (!sw || e.target.closest('.swipe-del')) return;
    if (Date.now() - swipeDraggedAt < 400 || sw === swipeOpen) {
      e.preventDefault();
      e.stopPropagation();
      closeSwipe();
    }
  },
  true
);

// ───────────────────────── Zeilen verschieben ─────────────────────────
// Lange auf eine Zeile drücken (nicht auf ein Textfeld – dort kommt die Lupe), dann nach oben oder unten ziehen.

let press = null; // { rowEl, timer, x, y, id }
let drag = null; // { rowEl, dayEl, grab, id }

/** Der Finger, der das Ziehen begonnen hat (ein zweiter Finger zählt nicht) */
const ownTouch = (list, id) => [...list].find((t) => t.identifier === id);

/** Ziehen abbrechen, ohne etwas zu ändern: iOS bricht die Berührung ab oder der Zettel wird neu gezeichnet
 *  (danach kämen keine Ereignisse des Fingers mehr an). restore: umsortierte Zeilen wieder richtig zeigen */
function cancelDrags(restore) {
  if (press) clearTimeout(press.timer);
  if (dayPress) clearTimeout(dayPress.timer);
  press = dayPress = null;
  if (drag) {
    const { rowEl, dayEl } = drag;
    drag = null;
    rowEl.classList.remove('dragging');
    rowEl.style.transform = '';
    dayEl.classList.remove('reordering');
    if (restore && dayEl.isConnected) refreshDay(Number(dayEl.dataset.day));
  }
  if (dayDrag) {
    const d = dayDrag;
    dayDrag = null;
    clearInterval(d.scroll);
    d.ghost.remove();
    d.dayEl.classList.remove('day-lifted');
    for (const el of document.querySelectorAll('#days .day-drop')) el.classList.remove('day-drop', 'day-target');
  }
}

function startDrag() {
  const { rowEl, target, id, y } = press;
  const dayEl = rowEl.closest('.day');
  press = null;
  if (!dayEl || dayEl.querySelectorAll('.row').length < 2) return;
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  // Hat das Verlassen des Feldes die berührte Stelle neu gezeichnet (Tippfehler-Hinweis), kämen keine Ereignisse mehr an
  if (!target.isConnected) return;
  drag = { rowEl, dayEl, grab: y - rowEl.getBoundingClientRect().top, id };
  rowEl.classList.add('dragging');
  dayEl.classList.add('reordering');
}

function moveDrag(y) {
  const { rowEl, grab } = drag;
  const prev = rowEl.previousElementSibling;
  const next = rowEl.nextElementSibling;
  if (prev && prev.classList.contains('row')) {
    const r = prev.getBoundingClientRect();
    if (y - grab < r.top + r.height / 2) prev.before(rowEl);
  }
  if (next && next.classList.contains('row')) {
    const r = next.getBoundingClientRect();
    if (y - grab + rowEl.offsetHeight > r.top + r.height / 2) next.after(rowEl);
  }
  rowEl.style.transform = '';
  const natural = rowEl.getBoundingClientRect().top;
  rowEl.style.transform = `translateY(${y - grab - natural}px)`;
}

function endDrag() {
  const { rowEl, dayEl } = drag;
  drag = null;
  rowEl.classList.remove('dragging');
  rowEl.style.transform = '';
  dayEl.classList.remove('reordering');
  const s = currentSheet();
  const i = Number(dayEl.dataset.day);
  const day = s.days[i];
  const order = [...dayEl.querySelectorAll('.row')].map((el) => el.dataset.row);
  const before = day.rows.map((r) => r.id).join();
  day.rows.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  if (day.rows.map((r) => r.id).join() !== before) saveSheets(s);
  refreshDay(i);
}

document.addEventListener(
  'touchstart',
  (e) => {
    const rowEl = e.target.closest('.day .row');
    if (!rowEl || e.touches.length > 1 || e.target.closest('input, textarea, .typo-hint')) return;
    const t = e.touches[0];
    press = { rowEl, target: e.target, id: t.identifier, x: t.clientX, y: t.clientY, timer: setTimeout(startDrag, 450) };
  },
  { passive: true }
);
document.addEventListener(
  'touchmove',
  (e) => {
    if (drag) {
      e.preventDefault(); // Seite scrollt beim Ziehen nicht mit
      const t = ownTouch(e.touches, drag.id);
      if (t) moveDrag(t.clientY);
      return;
    }
    const t = press && ownTouch(e.touches, press.id);
    if (t && (Math.abs(t.clientX - press.x) > 8 || Math.abs(t.clientY - press.y) > 8)) {
      clearTimeout(press.timer);
      press = null;
    }
  },
  { passive: false }
);
const endPress = (e) => {
  // Nur das Loslassen des ziehenden Fingers beendet das Ziehen
  if (drag && !ownTouch(e.changedTouches, drag.id)) return;
  if (press) clearTimeout(press.timer);
  press = null;
  if (drag) {
    e.preventDefault(); // kein Klick auf Uhrzeit oder Löschen nach dem Loslassen
    endDrag();
  }
};
document.addEventListener('touchend', endPress, { passive: false });
document.addEventListener('touchcancel', () => cancelDrags(true), { passive: true });
// Kein Kontextmenü beim langen Drücken auf eine Zeile
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('.day .row') && !e.target.closest('input, textarea')) e.preventDefault();
});

// ───────────────────────── Tage tauschen ─────────────────────────
// Lange auf eine Tageskarte drücken (nicht auf eine Zeile – die zieht man einzeln), dann auf einen anderen Tag der Woche
// ziehen: beide tauschen Zeilen, Pause und Tagesart. Feiertage bleiben an ihrem Datum; Urlaub, Krank … nicht auf Sa/So
// und nicht auf einen Feiertag. Wie jede Änderung: danach haben beide Tage „Speichern“ – eins davon speichert beide (linkDays).
// Elemente mit eigenem langem Drücken (data-hold, z. B. die Tagesart-Kapsel) starten das Ziehen nicht.

let dayPress = null; // { dayEl, timer, x, y, id }
let dayDrag = null; // { from, ghost, target, scroll, id }

/** Was am Tag mitwandert (ein automatischer Feiertag gehört zum Datum, ein von Hand gesetzter wandert mit) */
const dayMoveStatus = (d) => (d.status && (d.status !== 'feiertag' || d.manual) ? d.status : undefined);
const dayHasContent = (d) => !!dayMoveStatus(d) || d.pause != null || d.rows.some((r) => !rowIsEmpty(r));
/** Ziel erlaubt? Anderer Tag dieses Monats; keine Tagesart (außer Feiertag) auf Sa/So – von Hand gesetzte dürfen dorthin.
 *  Keine Tagesart auf einen automatischen Feiertag: der bleibt am Datum, die Tagesart ginge verloren */
function daySwapOk(s, a, b) {
  if (a === b || !sheetIsActive(s, b)) return false;
  const toWeekend = (d) => dayMoveStatus(d) && !d.manual;
  const autoHoliday = (d) => d.status === 'feiertag' && !d.manual;
  const A = s.days[a];
  const B = s.days[b];
  if ((autoHoliday(B) && dayMoveStatus(A)) || (autoHoliday(A) && dayMoveStatus(B))) return false;
  return !((b >= 5 && toWeekend(A)) || (a >= 5 && toWeekend(B)));
}
function swapDays(s, a, b) {
  const A = s.days[a];
  const B = s.days[b];
  // Stunden und „von Hand“ wandern mit der Tagesart; „von Hand“ ohne Tagesart (kein Auto-Feiertag) bleibt am Datum
  const take = (d) => {
    const status = dayMoveStatus(d);
    return { rows: d.rows, pause: d.pause, status, credit: status ? d.credit : undefined, manual: !!status && d.manual };
  };
  const put = (d, x) => {
    d.rows = x.rows.length ? x.rows : [emptyRow()];
    d.pause = x.pause;
    if (d.status === 'feiertag' && !d.manual) return;
    const dateManual = d.manual && !d.status;
    if (x.status) d.status = x.status;
    else delete d.status;
    if (x.credit != null) d.credit = x.credit;
    else delete d.credit;
    if (x.manual || dateManual) d.manual = true;
    else delete d.manual;
  };
  const ta = take(A);
  put(A, take(B));
  put(B, ta);
}

function startDayDrag() {
  const { dayEl, x, y, id } = dayPress;
  dayPress = null;
  const s = currentSheet();
  const from = Number(dayEl.dataset.day);
  if (!s || !dayHasContent(s.days[from])) return;
  document.activeElement && document.activeElement.blur && document.activeElement.blur();
  const ghost = document.createElement('div');
  ghost.className = 'day-ghost';
  ghost.textContent = `${WEEKDAYS_SHORT[from]} ${fmtDayMonth(sheetDate(s, from))}`;
  document.body.append(ghost);
  dayEl.classList.add('day-lifted');
  for (const el of document.querySelectorAll('#days .day')) if (daySwapOk(s, from, Number(el.dataset.day))) el.classList.add('day-drop');
  dayDrag = { from, dayEl, ghost, target: null, y, y0: y, id, scroll: setInterval(dayDragScroll, 30) };
  moveDayDrag(x, y);
  haptic();
}
/** Am oberen/unteren Rand mitscrollen (die Woche ist länger als der Bildschirm) */
function dayDragScroll() {
  // Erst wenn der Finger zum Rand gezogen wurde – beginnt das Drücken schon unten, scrollt sonst sofort alles weg
  if (!dayDrag || Math.abs(dayDrag.y - dayDrag.y0) < 20) return;
  const edge = 90;
  const y = dayDrag.y;
  const v = y < edge ? -(edge - y) / 4 : y > innerHeight - edge - 60 ? (y - (innerHeight - edge - 60)) / 4 : 0;
  if (v) {
    window.scrollBy(0, v);
    moveDayDrag(dayDrag.x, y);
  }
}
function moveDayDrag(x, y) {
  const d = dayDrag;
  d.x = x;
  d.y = y;
  d.ghost.style.transform = `translate(${x}px, ${y}px) translate(-50%, -130%)`;
  d.ghost.style.visibility = 'hidden';
  const el = document.elementFromPoint(x, y)?.closest('#days .day.day-drop') || null;
  d.ghost.style.visibility = '';
  if (el === d.target) return;
  d.target?.classList.remove('day-target');
  el?.classList.add('day-target');
  d.target = el;
  if (el) haptic();
}
function endDayDrag() {
  const d = dayDrag;
  dayDrag = null;
  clearInterval(d.scroll);
  d.ghost.remove();
  d.dayEl.classList.remove('day-lifted');
  for (const el of document.querySelectorAll('#days .day-drop')) el.classList.remove('day-drop', 'day-target');
  const s = currentSheet();
  if (!s || !d.target) return;
  const to = Number(d.target.dataset.day);
  if (!daySwapOk(s, d.from, to)) return;
  swapDays(s, d.from, to);
  linkDays(d.from, to);
  saveSheets(s);
  refreshDay(d.from);
  refreshDay(to);
  toast(`${WEEKDAYS_SHORT[d.from]} und ${WEEKDAYS_SHORT[to]} getauscht`);
}

document.addEventListener(
  'touchstart',
  (e) => {
    const dayEl = e.target.closest('#days .day');
    if (!dayEl || e.touches.length > 1 || e.target.closest('.row, input, textarea, button, a, select, [data-hold]')) return;
    const t = e.touches[0];
    dayPress = { dayEl, id: t.identifier, x: t.clientX, y: t.clientY, timer: setTimeout(startDayDrag, 450) };
  },
  { passive: true }
);
document.addEventListener(
  'touchmove',
  (e) => {
    if (dayDrag) {
      e.preventDefault();
      const t = ownTouch(e.touches, dayDrag.id);
      if (t) moveDayDrag(t.clientX, t.clientY);
      return;
    }
    const t = dayPress && ownTouch(e.touches, dayPress.id);
    if (t && (Math.abs(t.clientX - dayPress.x) > 8 || Math.abs(t.clientY - dayPress.y) > 8)) {
      clearTimeout(dayPress.timer);
      dayPress = null;
    }
  },
  { passive: false }
);
const endDayPress = (e) => {
  // Nur das Loslassen des ziehenden Fingers tauscht
  if (dayDrag && !ownTouch(e.changedTouches, dayDrag.id)) return;
  if (dayPress) clearTimeout(dayPress.timer);
  dayPress = null;
  if (dayDrag) {
    e.preventDefault();
    endDayDrag();
  }
};
document.addEventListener('touchend', endDayPress, { passive: false });
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest('#days .day') && !e.target.closest('input, textarea')) e.preventDefault();
});

// ───────────────────────── Leiste: Glas-Linse beim Umschalten, Vibration ─────────────────────────
// Wie die Leiste unter iOS 26: Beim Antippen wird die Markierung zur klaren Glas-Linse, bläht sich über die Leiste hinaus
// auf, gleitet in Bewegungsrichtung gedehnt zum neuen Symbol und schrumpft dort wieder zur Markierung. Unter der Linse
// sind die Symbole vergrößert, zum Rand der Linse hin immer stärker (gebogenes Glas); am Rand helle Kante mit Farbsäumen.
// Die echten Symbole unter der Linse blendet eine mitlaufende Maske aus (keine Dopplungen). Bewegt wird alles über die
// Web Animations API.

const LENS_MAG = 1.22; // Vergrößerung in der Mitte der Linse
/** Verzögerung (ms) zwischen Antippen einer Taste der Leiste und dem Seitenwechsel */
const TAB_PAGE_DELAY = 50;
const LENS_EDGE = 0.3; // wie stark der Rand der Linse den Inhalt zusätzlich verbiegt (0 = gar nicht)
const LENS_CHROMA = 0.03; // Farbsäume am Rand (Unterschied der Brechung von Rot und Blau)

function tabLens() {
  const caps = document.querySelector('#tabbar .tab-caps');
  caps.insertAdjacentHTML('beforeend', '<div class="tab-lens" aria-hidden="true"><canvas class="tab-lens-canvas"></canvas><div class="tab-lens-rim"></div></div>');
}

/** Symbole und Beschriftungen der Leiste in Akzentfarbe einmal scharf in ein Bild zeichnen (Vorlage für die Linse) */
function lensSource() {
  const caps = document.querySelector('#tabbar .tab-caps');
  const cr = caps.getBoundingClientRect();
  // zweifache Auflösung reicht für die kurze Bewegung und hält jedes Bild schnell
  const dpr = Math.min(2, devicePixelRatio || 1);
  const key = `${cr.width}x${cr.height}x${dpr}x${document.documentElement.dataset.theme}`;
  if (lensSource.key === key) return lensSource.data;
  const c = document.createElement('canvas');
  c.width = Math.round(cr.width * dpr);
  c.height = Math.round(cr.height * dpr);
  const ctx = c.getContext('2d');
  ctx.scale(dpr, dpr);
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim();
  ctx.fillStyle = accent;
  for (const tab of caps.querySelectorAll('.tab-row > .tab')) {
    const svgEl = tab.querySelector('svg');
    const sr = svgEl.getBoundingClientRect();
    ctx.save();
    ctx.translate(sr.left - cr.left, sr.top - cr.top);
    ctx.scale(sr.width / 24, sr.height / 24);
    for (const path of svgEl.querySelectorAll('path')) ctx.fill(new Path2D(path.getAttribute('d')), 'evenodd');
    ctx.restore();
    const label = tab.querySelector('span');
    const lr = label.getBoundingClientRect();
    const cs = getComputedStyle(label);
    ctx.font = `600 ${cs.fontSize} ${cs.fontFamily}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label.textContent, lr.left - cr.left + lr.width / 2, lr.top - cr.top + lr.height / 2 + 0.5);
  }
  lensSource.key = key;
  lensSource.data = { px: ctx.getImageData(0, 0, c.width, c.height), dpr, w: c.width, h: c.height };
  return lensSource.data;
}

/** Ein Bild der Linse zeichnen: Inhalt unter der Linse vergrößert, zum Rand hin stärker verbogen, mit Farbsäumen.
 *  cx = Mitte der Linse (in der Leiste), lw/lh = Größe, H = Höhe der Leiste */
function lensPaint(canvas, cx, lw, lh, H) {
  const src = lensSource();
  const dpr = src.dpr;
  const cw = Math.max(1, Math.round(lw * dpr));
  const ch = Math.max(1, Math.round(lh * dpr));
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  const ctx = canvas.getContext('2d');
  const out = ctx.createImageData(cw, ch);
  const o = out.data;
  const o32 = new Uint32Array(o.buffer);
  const s = src.px.data;
  const s32 = src.u32 || (src.u32 = new Uint32Array(s.buffer));
  const sw = src.w;
  const sh = src.h;
  const r = lh / 2;
  const half = lw / 2;
  const flat = half - r;
  const inv = 1 / LENS_MAG;
  const scx = cx * dpr;
  const scy = (H / 2) * dpr;
  for (let y = 0; y < ch; y++) {
    const ly = (y + 0.5) / dpr - r; // zur Mitte der Linse
    const ly2 = ly * ly;
    let i = y * cw;
    for (let x = 0; x < cw; x++, i++) {
      const lx = (x + 0.5) / dpr - half;
      // Abstand zum Rand der Kapsel: 0 = Mitte, 1 = Rand
      const ax = lx > flat ? lx - flat : lx < -flat ? -lx - flat : 0;
      let q = (ax * ax + ly2) / (r * r);
      if (q > 1) q = 1;
      const q2 = q * q;
      // zum Rand hin Inhalt von weiter innen holen: dort stärker vergrößert und verbogen
      const f = (1 - LENS_EDGE * q2) * inv;
      if (q < 0.45) {
        // Mitte: ohne Farbsäume, ein Lesezugriff
        const sx = (scx + lx * f * dpr) | 0;
        const sy = (scy + ly * f * dpr) | 0;
        if (sx >= 0 && sy >= 0 && sx < sw && sy < sh) o32[i] = s32[sy * sw + sx];
        continue;
      }
      const d = LENS_CHROMA * q;
      let a = 0;
      for (let k = 0; k < 3; k++) {
        const fk = f * (1 + (k - 1) * d) * dpr;
        const sx = (scx + lx * fk) | 0;
        const sy = (scy + ly * fk) | 0;
        if (sx < 0 || sy < 0 || sx >= sw || sy >= sh) continue;
        const j = (sy * sw + sx) * 4;
        o[i * 4 + k] = s[j + k];
        if (s[j + 3] > a) a = s[j + 3];
      }
      o[i * 4 + 3] = a;
    }
  }
  ctx.putImageData(out, 0, 0);
}

/** Linse von einem Eintrag zum anderen gleiten lassen; Ablauf und Tempo wie in den Aufnahmen von iOS 26.
 *  Jedes Bild setzt Lage und Größe der Linse, zeichnet ihren Inhalt und spart die echten Symbole darunter aus –
 *  alles im selben Schritt, daher immer deckungsgleich. */
function animateTabLens(from, to) {
  const caps = document.querySelector('#tabbar .tab-caps');
  const tabRow = caps.querySelector('.tab-row');
  const lens = caps.querySelector('.tab-lens');
  const canvas = lens.firstChild;
  const cr = caps.getBoundingClientRect();
  const H = cr.height;
  const fr = from.getBoundingClientRect();
  const center = (el) => {
    const r = el.getBoundingClientRect();
    return r.left - cr.left + r.width / 2;
  };
  const a = center(from);
  const b = center(to);
  const slots = Math.round(Math.abs(b - a) / fr.width);
  // Ruhegröße = Markierung, aufgebläht etwas breiter und über die Leiste hinaus
  const w0 = fr.width;
  const h0 = fr.height;
  const w1 = fr.width * 1.06;
  const h1 = H + 8;
  lensSource();

  // Zeiten (ms): aufblähen, gleiten (je weiter, desto länger – lange Wege aber nur wenig länger,
  // die Linse fährt dort schneller), noch im Gleiten schrumpfen und verblassen, während die
  // Markierung am Ziel erscheint
  const T_GROW = 110;
  const T_MOVE = 245 + 35 * Math.log2(Math.max(1, slots));
  const T_SETTLE = 205;
  // Schrumpfen beginnt schon, wenn die Linse fast am Ziel ist (letztes Viertel des Gleitens)
  const T_SETTLE_AT = T_GROW + T_MOVE * 0.75;
  const total = T_SETTLE_AT + T_SETTLE;
  const easeOut = (u) => 1 - Math.pow(1 - u, 3);
  // Gleiten: weich an- und auslaufen, ohne Ruck (easeInOutSine)
  const glide = (u) => 0.5 - 0.5 * Math.cos(Math.PI * u);
  const at = (ms) => a + (b - a) * glide(Math.min(1, Math.max(0, (ms - T_GROW * 0.5) / T_MOVE)));

  cancelAnimationFrame(animateTabLens.raf);
  caps.classList.add('lens-moving', 'lens-anim');
  clearTimeout(animateTabLens.timer);
  // Die Markierung blendet ein, sobald die Linse am Ziel schrumpft
  animateTabLens.timer = setTimeout(() => caps.classList.remove('lens-moving'), T_SETTLE_AT);
  const start = performance.now();
  const frame = (now) => {
    const ms = Math.min(total, now - start);
    const x = at(ms);
    const v = Math.abs(at(ms + 8) - at(ms - 8)) / 16 / w0; // Markierungsbreiten je ms
    const grow = easeOut(Math.min(1, ms / T_GROW));
    const settle = Math.min(1, Math.max(0, (ms - T_SETTLE_AT) / T_SETTLE));
    const size = grow * (1 - easeOut(settle)); // 0 = Markierung, 1 = aufgebläht
    const stretch = Math.min(0.16, v * 12);
    const lw = (w0 + (w1 - w0) * size) * (1 + stretch);
    const lh = (h0 + (h1 - h0) * size) * (1 - stretch * 0.35);
    lens.style.cssText = `opacity:${Math.min(1, ms / 30) * (1 - easeOut(settle))};left:${x - lw / 2}px;top:${(H - lh) / 2}px;width:${lw}px;height:${lh}px`;
    lensPaint(canvas, x, lw, lh, H);
    // Loch in den echten Symbolen, so groß wie die Linse; beim Verblassen schrumpft es mit
    const hole = 1 - settle;
    tabRow.style.setProperty('--lens-x', `${x}px`);
    tabRow.style.setProperty('--lens-rx', `${(lw / 2 + 1) * hole}px`);
    tabRow.style.setProperty('--lens-ry', `${(lh / 2 + 1) * hole}px`);
    if (ms < total) animateTabLens.raf = requestAnimationFrame(frame);
    else {
      tabRow.style.setProperty('--lens-x', '-500px');
      caps.classList.remove('lens-anim');
    }
  };
  frame(start);
  return T_GROW + T_MOVE;
}

/** Kurzer Vibrations-Tick, wo es navigator.vibrate gibt (Android); auf dem iPhone tickt HAPTIC_SWITCH */
function haptic() {
  if (navigator.vibrate) navigator.vibrate(8);
}

// ───────────────────────── Glas der Leiste ─────────────────────────
// Klares Glas über Safaris eigenem Glasfilter (backdrop-filter, läuft auf der Grafikkarte) mit dünner heller Randlinie.
// Keine Kopien der Seite: die liefen auf dem iPhone gegen den Inhalt weg, setzten beim Nachfedern aus und ließen die
// Symbole zittern.
function glassBar() {
  document.querySelector('#tabbar .tab-caps').insertAdjacentHTML('afterbegin', '<div class="glass-clip" aria-hidden="true"></div>');
}

// ───────────────────────── Start ─────────────────────────

if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
history.replaceState('root', '', location.hash || '#/');
applyTheme();
applyWarnSigns();
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', applyTheme);
document.body.insertAdjacentHTML('beforeend', tabbarHTML());
showLock();
route();
// iOS 26 startet die Home-Bildschirm-App teils um den oberen Rand verschoben (scrollY negativ); nach dem ersten
// Seitenwechsel stünde alles höher. Gleich auf 0 setzen, damit Überschriften immer an derselben Stelle stehen.
for (const ms of [50, 300, 900]) setTimeout(() => window.scrollY < 0 && window.scrollTo(0, 0), ms);
tabLens();
glassBar();
// Vorlage der Linse vorab zeichnen, damit das erste Umschalten nicht stockt
setTimeout(() => document.querySelector('#tabbar .tab-caps').offsetWidth && lensSource(), 800);

fetchReports();
accountBackup();
accountLink();
accountResumeRestore();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  fetchReports();
});
// iOS bitten, die Daten nie von selbst zu löschen (z. B. bei knappem Speicher)
navigator.storage?.persist?.().catch(() => {});

if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
