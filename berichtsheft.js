'use strict';
// Berichtsheft (Ausbildungsnachweis nach den Vordrucken der Handwerkskammer): ein Heft je Ausbildungsjahr mit Wochen- und Monatsberichten.
// Einschalten in den Einstellungen; erreichbar über den Umschalter „Stundenzettel | Berichtsheft“ auf der Zettel-Seite.
// Wird vor app.js geladen: Hilfsfunktionen von app.js (settings, toast, svg …) erst beim Aufruf benutzen.

const BH_KEY = 'stdprotokoll.berichtsheft.v1';
// profile: Angaben fürs Deckblatt/Vorblatt (Datumsfelder als 'JJJJ-MM-TT')
// sigs: gespeicherte Unterschriften { azubi, eltern, ausbilder } ({ ratio, strokes } wie bei signaturePad)
// autoSign: jeder geschriebene Bericht trägt von selbst die Unterschrift des Azubis (Datum = letzte Änderung)
// profileAt: Angaben/Unterschriften zuletzt geändert (Abgleich: Uhrzeit im Konflikt-Fenster)
// hefte: [{ id, jahr, start, end, weeks: { Montag 'JJJJ-MM-TT': Woche }, months: { 'JJJJ-MM': Monat } }]
// Woche: { days: [{ lines: [{ t, h }] (bis 5 Zeilen: Tätigkeit, Einzelstunden), hours (Gesamtstunden),
//                   type (Tagesart wie im Stundenzettel: krank, urlaub, feiertag, frei; fehlt = Arbeit) }] × 6 (Mo–Sa),
//          Mit Tagesart bleiben Zeilen und Stunden gespeichert (zurück auf Arbeit sind sie wieder da), zählen aber nicht
//          signed: { azubi, eltern, ausbilder: 'JJJJ-MM-TT' }, updatedAt }
// Monat: { taet: { text, img }, schule: { text, img }, signed, updatedAt } – img: { id, w, h } (Bild in IndexedDB)
// updatedAt: zuletzt von Hand geändert (Abgleich: Uhrzeit im Konflikt-Fenster)
let bh = { profile: {}, sigs: {}, hefte: [] };
try {
  Object.assign(bh, JSON.parse(localStorage.getItem(BH_KEY)) || {});
} catch (e) {}

const BH_LINES = 5; // Zeilen je Tag im Vordruck
/** Höchstens 5 Zeilen: was darüber hinausgeht, kommt mit Komma in die letzte */
const capLines = (lines) =>
  lines.length <= BH_LINES ? lines : [...lines.slice(0, BH_LINES - 1), { t: lines.slice(BH_LINES - 1).map((l) => l.t).join(', '), h: '' }];
/** Tag eines Wochenberichts; frühere Fassung hatte statt Zeilen einen Text (jede Textzeile wird eine Zeile) */
function normDay(d) {
  const lines = Array.isArray(d?.lines)
    ? d.lines.map((l) => ({ t: String(l?.t || ''), h: String(l?.h || '') }))
    : String(d?.text || '').split('\n').map((s) => s.trim()).filter(Boolean).map((t) => ({ t, h: '' }));
  return { lines: capLines(lines), hours: d?.hours || '', ...(d?.type ? { type: d.type } : {}) };
}
function normWeek(w) {
  if (w) w.days = [0, 1, 2, 3, 4, 5].map((i) => normDay(w.days?.[i]));
  return w;
}
for (const h of bh.hefte) Object.values(h.weeks || {}).forEach(normWeek);
function saveBh() {
  try {
    localStorage.setItem(BH_KEY, JSON.stringify(bh));
  } catch (e) {
    window.fehlerMelden?.(e, 'speichern');
    toast('Speichern fehlgeschlagen – Speicher voll?');
  }
  // gespeichert wird bei jedem Tastendruck: erst nach einer Pause senden (beim Verlassen sofort)
  syncSoon(2000);
}
/** Bericht bzw. Angaben von Hand geändert (Uhrzeit für das Konflikt-Fenster beim Abgleich) */
const bhTouch = (e) => e && (e.updatedAt = Date.now());
const bhTouchProfile = () => (bh.profileAt = Date.now());

const bhOn = () => !!settings.bhOn;
const bhMode = () => (bhOn() && settings.listMode === 'heft' ? 'heft' : 'zettel');
const findHeft = (id) => bh.hefte.find((h) => h.id === id);
const hefteSorted = () => [...bh.hefte].sort((a, b) => b.jahr - a.jahr);
const BH_ROLES = [
  ['azubi', 'Auszubildender'],
  ['eltern', 'Erziehungsberechtigter'],
  ['ausbilder', 'Ausbilder'],
];

// ───────── Bilder (Monatsberichte): IndexedDB, zusätzlich im Speicher für PDF und Sicherung ─────────

const bhImages = new Map(); // id → JPEG als Base64
function bhDb() {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('stdprotokoll-bilder', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('img');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}
const bhImagesReady = bhDb()
  .then(
    (db) =>
      new Promise((resolve) => {
        const req = db.transaction('img').objectStore('img').openCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve();
          bhImages.set(c.key, c.value);
          c.continue();
        };
        req.onerror = () => resolve();
      })
  )
  .catch(() => (bhImagesBroken = true))
  .then(() => (bhImagesLoaded = true));
let bhImagesLoaded = false; // bis dahin fehlen Fotos in Monatsbericht und PDF
let bhImagesBroken = false; // IndexedDB geht nicht (Abgleich: fehlende Bilder sind dann nicht gelöscht)
function bhPutImage(id, data) {
  bhImages.set(id, data);
  return bhDb()
    .then((db) => db.transaction('img', 'readwrite').objectStore('img').put(data, id))
    .catch((e) => {
      window.fehlerMelden?.(e, 'bild speichern');
      toast('Bild konnte nicht gespeichert werden');
    });
}
function bhDeleteImage(id) {
  bhImages.delete(id);
  bhDb()
    .then((db) => db.transaction('img', 'readwrite').objectStore('img').delete(id))
    .catch(() => {});
}
/** Höchstens so viele Zeichen (Base64) je Bild: der Abgleich schickt jedes Bild in einer Anfrage (Server: 1 MB) */
const BH_IMG_MAX = 850_000;
const bhLoadImage = (src) =>
  new Promise((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = reject;
    i.src = src;
  });
/** Als JPEG (längste Seite höchstens max px); zu groß für BH_IMG_MAX → schlechtere Qualität, dann kleiner */
function bhEncodeImage(img, max = 1600) {
  let k = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
  for (let n = 0; ; n++) {
    const w = Math.round(img.naturalWidth * k);
    const h = Math.round(img.naturalHeight * k);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    for (const q of [0.82, 0.7, 0.58]) {
      const data = c.toDataURL('image/jpeg', q).split(',')[1];
      if (data.length <= BH_IMG_MAX || n >= 4) return { data, w, h };
    }
    k *= 0.8;
  }
}
/** Ältere, zu große Bilder einmal verkleinern (ID und Seitenverhältnis bleiben) – vor dem ersten Abgleich */
async function bhShrinkImages() {
  for (const [id, d] of bhImages)
    if (d.length > BH_IMG_MAX)
      try {
        await bhPutImage(id, bhEncodeImage(await bhLoadImage(`data:image/jpeg;base64,${d}`)).data);
      } catch (e) {
        window.fehlerMelden?.(e, 'bild verkleinern');
      }
}
/** Foto verkleinern (längste Seite 1600 px) und als JPEG speichern */
async function bhImportImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const { data, w, h } = bhEncodeImage(await bhLoadImage(url));
    const id = uid();
    await bhPutImage(id, data);
    return { id, w, h };
  } finally {
    URL.revokeObjectURL(url);
  }
}

// ───────── Zeiträume ─────────

const addYears = (d, n) => new Date(d.getFullYear() + n, d.getMonth(), d.getDate());
/** Zeitraum des n-ten Ausbildungsjahres ab Ausbildungsbeginn; das letzte endet mit dem Ende der Ausbildung (z. B. nach 3½ Jahren) */
function bhYearRange(jahr) {
  const start = addYears(parseDate(bh.profile.beginn), jahr - 1);
  let end = isoDate(addDays(addYears(start, 1), -1));
  if (bh.profile.ende && bh.profile.ende >= isoDate(start) && bh.profile.ende < end) end = bh.profile.ende;
  return { start: isoDate(start), end };
}
/** Ausbildungsjahr von heute als Text (Heft-Nr.); leer ohne Beginn oder außerhalb der Ausbildung */
function bhYearToday() {
  if (!bh.profile.beginn) return '';
  const today = isoDate(new Date());
  for (let j = 1; j <= bhYearCount(); j++) {
    const r = bhYearRange(j);
    if (today >= r.start && today <= r.end) return String(j);
  }
  return '';
}
/** Anzahl der Ausbildungsjahre bis zum Ende der Ausbildung (angefangene zählen); ohne Ende 4 */
function bhYearCount() {
  if (!bh.profile.ende || !bh.profile.beginn || bh.profile.ende < bh.profile.beginn) return 4;
  let n = 1;
  while (isoDate(addYears(parseDate(bh.profile.beginn), n)) <= bh.profile.ende) n++;
  return n;
}
/** Wochen eines Hefts (Montage) mit mindestens einem Werktag (Mo–Fr) im Ausbildungsjahr; Nr. 1 = erste Woche */
function heftWeeks(h) {
  const out = [];
  const end = parseDate(h.end);
  let m = mondayOf(parseDate(h.start));
  if (addDays(m, 4) < parseDate(h.start)) m = addDays(m, 7);
  for (; m <= end; m = addDays(m, 7)) out.push(isoDate(m));
  return out;
}
/** Monate eines Hefts als 'JJJJ-MM' */
function heftMonths(h) {
  const out = [];
  const s = parseDate(h.start);
  const e = parseDate(h.end);
  for (let d = new Date(s.getFullYear(), s.getMonth(), 1); d <= e; d = new Date(d.getFullYear(), d.getMonth() + 1, 1))
    out.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}`);
  return out;
}
const inHeft = (h, d) => isoDate(d) >= h.start && isoDate(d) <= h.end;
/** Tage einer Woche (0 = Mo … 5 = Sa), die im Ausbildungsjahr liegen */
const weekDays = (h, monday) => [0, 1, 2, 3, 4, 5].filter((i) => inHeft(h, addDays(parseDate(monday), i)));
/** Monat, zu dem eine Woche in der Liste gehört (der des Donnerstags, wie bei der KW), begrenzt auf die Monate des Hefts:
 *  beginnt die Ausbildung z. B. an einem Freitag, dem 1., liegt der Donnerstag der ersten Woche noch im Vormonat */
const weekMonth = (h, monday) => {
  const t = addDays(parseDate(monday), 3);
  const ym = `${t.getFullYear()}-${pad(t.getMonth() + 1)}`;
  const first = h.start.slice(0, 7);
  const last = h.end.slice(0, 7);
  return ym < first ? first : ym > last ? last : ym;
};
const monthName = (ym) => `${MONTHS[Number(ym.slice(5)) - 1]} ${ym.slice(0, 4)}`;
/** Erster und letzter Werktag (Mo–Fr) eines Monats im Ausbildungsjahr */
function monthSpan(h, ym) {
  const y = Number(ym.slice(0, 4));
  const m = Number(ym.slice(5)) - 1;
  const days = [];
  for (let d = new Date(y, m, 1); d.getMonth() === m; d = addDays(d, 1)) if (d.getDay() % 6 && inHeft(h, d)) days.push(d);
  return days.length ? [days[0], days.at(-1)] : [new Date(y, m, 1), new Date(y, m + 1, 0)];
}
/** Zeitraum einer Woche fürs Blatt: Mo–Fr, mit Samstag nur wenn eingetragen; begrenzt aufs Ausbildungsjahr */
function weekSpan(h, monday, w) {
  const days = weekDays(h, monday).filter((i) => i < 5 || dayFilled(w?.days?.[5]));
  const mon = parseDate(monday);
  return days.length ? [addDays(mon, days[0]), addDays(mon, days.at(-1))] : [mon, addDays(mon, 4)];
}

// ───────── Inhalt und Stand ─────────

const emptyWeek = () => ({ days: [0, 1, 2, 3, 4, 5].map(() => ({ lines: [], hours: '' })), signed: {} });
const emptyMonth = () => ({ taet: { text: '' }, schule: { text: '' }, signed: {} });
const dayFilled = (d) => !!d?.type || !!d?.lines?.some((l) => l.t.trim());
const weekFilled = (w) => !!w && w.days?.some(dayFilled);
const monthFilled = (m) => !!m && ['taet', 'schule'].some((k) => (m[k]?.text || '').trim() || m[k]?.img);
/** Tagesarten im Berichtsheft: wie im Stundenzettel und zusätzlich Schule (Berufsschultag; nur hier) */
// (Funktion: berichtsheft.js lädt vor app.js, DAY_STATUS_SHORT gibt es erst beim Aufruf)
const bhTypes = () => ({ ...DAY_STATUS_SHORT, schule: 'Schule' });
/** Stunden einer Tagesart im Wochenbericht: Urlaub, Krank, Feiertag und Schule je ein voller Tag (8,00), Frei nichts */
const bhTypeHours = (type) => (type === 'frei' ? '' : fmtHours(Math.round(settings.hoursPerDay * 60)));
/** Tag eines Wochenberichts fertig: eine Zeile mit mindestens 2 Wörtern oder 10 Zeichen und Gesamtstunden.
 *  Andere Tagesarten (gewählt oder Zeile beginnt mit Urlaub, Krank, Frei, Feiertag, Schule) und gesetzliche Feiertage
 *  brauchen beides nicht. */
function dayComplete(d, date) {
  if (d?.type || holidayName(date)) return true;
  const texts = (d?.lines || []).map((l) => l.t.trim()).filter(Boolean);
  const types = Object.values(bhTypes()).map((t) => t.toLowerCase());
  if (texts.some((t) => types.includes(t.split(/[\s,.(]+/)[0].toLowerCase()))) return true;
  return texts.some((t) => t.length >= 10 || t.split(/\s+/).length >= 2) && parseNum(d.hours) > 0;
}
/** Woche fertig: jeder Werktag im Heft (Samstag nur, wenn dort etwas steht) */
function weekComplete(h, mon, w) {
  if (!weekFilled(w)) return false;
  const mo = parseDate(mon);
  return weekDays(h, mon)
    .filter((i) => i < 5 || dayFilled(w.days[5]))
    .every((i) => dayComplete(w.days[i], addDays(mo, i)));
}
/** Stand einer Woche: leer, offen (geschrieben), azubi (fertig und vom Azubi unterschrieben – ein Haken),
 *  fertig (vom Ausbilder abgezeichnet – zwei Haken). signed.frei: der Azubi hat per langem Drücken trotzdem
 *  unterschrieben, dann gilt der Haken auch für eine unfertige Seite */
function weekState(h, mon) {
  const w = h.weeks[mon];
  if (!weekFilled(w)) return 'leer';
  if (w.signed?.ausbilder) return 'fertig';
  return w.signed?.azubi && (w.signed.frei || weekComplete(h, mon, w)) ? 'azubi' : 'offen';
}
/** Monatsbericht fertig: Betriebliche Tätigkeit und Berufsschule zusammen mindestens 5 Wörter oder 30 Zeichen
 *  (eins von beiden reicht, Bilder egal) */
function monthComplete(m) {
  const t = ['taet', 'schule'].map((k) => (m?.[k]?.text || '').trim()).filter(Boolean).join(' ');
  return t.length >= 30 || t.split(/\s+/).filter(Boolean).length >= 5;
}
function monthState(h, ym) {
  const m = h.months[ym];
  if (!monthFilled(m)) return 'leer';
  if (m.signed?.ausbilder) return 'fertig';
  return m.signed?.azubi && (m.signed.frei || monthComplete(m)) ? 'azubi' : 'offen';
}
/** Fortschritt eines Hefts: nur Seiten mit mindestens einem Haken zählen */
function heftProgress(h) {
  bhAutoSignAll();
  const weeks = heftWeeks(h);
  const months = heftMonths(h);
  const done = (st) => st === 'azubi' || st === 'fertig';
  return {
    weeks: weeks.length,
    weeksDone: weeks.filter((k) => done(weekState(h, k))).length,
    months: months.length,
    monthsDone: months.filter((k) => done(monthState(h, k))).length,
  };
}
/** Unter 18 am Tag x? (dann zeichnet auch ein Erziehungsberechtigter ab) */
function bhMinor(date) {
  if (!bh.profile.geboren) return false;
  return addYears(parseDate(bh.profile.geboren), 18) > date;
}
const bhName = () => [bh.profile.vorname, bh.profile.name].filter(Boolean).join(' ') || settings.name;

// ───────── Zettel-Seite: Umschalter und Heft-Übersicht ─────────

function bhSwitchHTML() {
  if (!bhOn()) return '';
  const mode = bhMode();
  return `<div class="seg bh-switch" role="tablist">
    <button role="tab" class="${mode === 'zettel' ? 'on' : ''}" data-bh="mode" data-mode="zettel">Stundenzettel</button>
    <button role="tab" class="${mode === 'heft' ? 'on' : ''}" data-bh="mode" data-mode="heft">Berichtsheft</button>
  </div>`;
}

const fmtYearSpan = (h) => `${fmtShort(parseDate(h.start))} – ${fmtShort(parseDate(h.end))}`;

/** Logo der Handwerkskammer aus dem Deckblatt-Vordruck (JPEG) */
let bhLogoUrl = null;
const bhLogo = () => (bhLogoUrl ??= `data:image/jpeg;base64,${BH_TPL.objs.find((o) => o.d.includes('/Subtype /Image')).s}`);
/** Seiten hinter dem Deckblatt: je weiter hinten, desto weiter rechts und kürzer (2–7 Blätter, je nach Füllstand g) */
function heftPagesShadow(g) {
  const n = 2 + Math.round((5 * (g.weeksDone + g.monthsDone)) / Math.max(1, g.weeks + g.months));
  const s = [];
  for (let i = 1; i <= n; i++) s.push(`${(i * 1.6).toFixed(1)}px 0 0 -${(i * 0.7).toFixed(1)}px ${i % 2 ? '#d9d6ce' : '#fbfaf6'}`);
  return [...s, `${(n * 1.6).toFixed(1)}px 4px 12px rgba(0, 0, 0, 0.3)`].join(', ');
}
/** Umschlag eines Hefts: das Deckblatt des Vordrucks mit den Angaben, geheftet */
function heftCoverHTML(h, g) {
  const p = bh.profile;
  const f = (v, top) => `<span class="bh-dk-f" style="top:${top}%">${escapeHtml(v || '')}</span>`;
  return `<div class="bh-dk" style="box-shadow:${heftPagesShadow(g)}"><img src="${bhLogo()}" alt=""><b>Ausbildungsnachweis</b><span class="bh-dk-y">${
    h.jahr
  }. Ausbildungsjahr</span>${f(bhFullName(p), 47)}${f(p.beruf, 54)}${f(p.betrieb, 61)}</div>`;
}

/** Karte zu den Angaben (gelten für alle Hefte) */
function bhInfoCardHTML() {
  const p = bh.profile;
  const sub = p.beginn
    ? escapeHtml([bhName(), p.beruf].filter(Boolean).join(' · '))
    : '<span class="bh-missing">Ausbildungsbeginn fehlt</span>';
  return `<a class="card bh-info-card" href="#/heft-angaben"><span class="bh-info-icon">${ICON.doc}</span><span class="list-main"><span class="list-title">Angaben</span><span class="list-sub">${sub}</span></span><span class="list-chevron">${ICON.chevronRight}</span></a>`;
}

function heftProgressHTML(g) {
  const bar = (done, all) => `<span class="bh-bar"><i style="width:${all ? (100 * done) / all : 0}%"></i></span>`;
  return `<span class="bh-prog"><span>Wochen</span>${bar(g.weeksDone, g.weeks)}<span class="num">${g.weeksDone}/${g.weeks}</span></span>
    <span class="bh-prog"><span>Monate</span>${bar(g.monthsDone, g.months)}<span class="num">${g.monthsDone}/${g.months}</span></span>`;
}

function heftListHTML() {
  const list = hefteSorted();
  const add = `<button class="bh-add" data-bh="new">${ICON.plus}<span>Neues Berichtsheft</span></button>`;
  if (!list.length)
    return `${bhInfoCardHTML()}<div class="empty">
      <div class="empty-icon">${svg('<path d="M5 3h11a3 3 0 0 1 3 3v15H8a3 3 0 0 1-3-3z"/><path d="M5 18a3 3 0 0 1 3-3h11M9 7h6"/>', 44)}</div>
      <p><b>Noch kein Berichtsheft</b></p>
    </div>${add}`;
  return `${bhInfoCardHTML()}<div class="bh-rows">${list
    .map((h) => {
      const g = heftProgress(h);
      return `<button class="card bh-row" data-bh="open" data-id="${h.id}">${heftCoverHTML(h, g)}
      <span class="bh-info"><b>${h.jahr}. Ausbildungsjahr</b><span class="muted">${fmtYearSpan(h)}</span>${heftProgressHTML(g)}</span></button>`;
    })
    .join('')}</div>${add}`;
}

/** Neues Heft: Ausbildungsjahr wählen (vorgeschlagen das Jahr von heute); ohne Ausbildungsbeginn erst die Angaben */
function newHeftMenu() {
  if (!bh.profile.beginn) return toast('Erst den Ausbildungsbeginn in den Angaben eintragen');
  const have = new Set(bh.hefte.map((h) => h.jahr));
  const years = Array.from({ length: bhYearCount() }, (_, i) => i + 1).filter((j) => !have.has(j));
  if (!years.length) return toast('Alle Ausbildungsjahre sind angelegt – bei Verlängerung das Ende der Ausbildung ändern');
  actionSheet(
    years.map((j) => {
      const r = bhYearRange(j);
      return {
        label: `${j}. Ausbildungsjahr <span class="muted">${fmtShort(parseDate(r.start))} – ${fmtShort(parseDate(r.end))}</span>`,
        run: () => {
          const h = { id: uid(), jahr: j, start: r.start, end: r.end, weeks: {}, months: {} };
          bh.hefte.push(h);
          saveBh();
          location.hash = `#/heft/${h.id}`;
        },
      };
    })
  );
}

// ───────── Seite eines Hefts ─────────

let bhHeftId = null;
const currentHeft = () => findHeft(bhHeftId);

/** Hash-Routen des Berichtshefts; Ergebnis false = nicht zuständig */
function bhRoute(hash) {
  if (hash === '#/heft-angaben') {
    currentView = 'bhInfo';
    renderBhInfo();
    return true;
  }
  const m = hash.match(/^#\/heft\/([^/]+)(?:\/(woche|monat)\/([\d-]+))?$/);
  if (!m) return false;
  bhHeftId = decodeURIComponent(m[1]);
  const h = currentHeft();
  if (!h) {
    location.replace('#/');
    return true;
  }
  if (m[2] === 'woche') {
    currentView = 'bhWeek';
    bhSatOpen = false; // aufgeklappter Samstag gilt nur für die Woche, in der er geöffnet wurde
    renderBhWeek(h, m[3]);
  } else if (m[2] === 'monat') {
    currentView = 'bhMonth';
    renderBhMonth(h, m[3]);
  } else {
    currentView = 'heft';
    renderHeft(h);
  }
  return true;
}

const BH_STATE_LABEL = { leer: '', offen: 'offen', azubi: 'unterschrieben', fertig: 'abgezeichnet' };
function stateHTML(state) {
  if (state === 'fertig') return `<span class="bh-state fertig">${ICON.check}${ICON.check}</span>`;
  if (state === 'azubi') return `<span class="bh-state azubi">${ICON.check}</span>`;
  return `<span class="bh-state ${state}">${BH_STATE_LABEL[state]}</span>`;
}

function renderHeft(h) {
  bhAutoSignAll();
  const today = isoDate(new Date());
  const weeks = heftWeeks(h);
  // Seiten bis heute (und spätere, falls schon etwas eingetragen ist), neueste zuerst wie in der Zettel-Liste
  const groups = new Map();
  const group = (ym) => groups.get(ym) || groups.set(ym, { month: null, weeks: [] }).get(ym);
  for (const ym of heftMonths(h)) if (`${ym}-01` <= today || monthFilled(h.months[ym])) group(ym).month = ym;
  weeks.forEach((mon, i) => {
    if (mon <= today || weekFilled(h.weeks[mon])) group(weekMonth(h, mon)).weeks.push({ mon, nr: i + 1 });
  });
  const keys = [...groups.keys()].filter((k) => k >= h.start.slice(0, 7) && k <= h.end.slice(0, 7)).sort().reverse();
  const weekRow = ({ mon, nr }) => {
    const w = h.weeks[mon];
    const [a, b] = weekSpan(h, mon, w);
    return `<a class="list-row bh-r bh-page" href="#/heft/${h.id}/woche/${mon}">
      <span class="list-kw">Nr. ${nr}</span>
      <span class="list-main"><span class="list-title">${fmtDayMonth(a)} – ${fmtDayMonth(b)}</span></span>
      ${stateHTML(weekState(h, mon))}
    </a>`;
  };
  const monthRow = (ym) => {
    const mo = h.months[ym];
    return `<a class="list-row bh-r bh-page" href="#/heft/${h.id}/monat/${ym}">
      <span class="list-kw bh-kw-month">Monat</span>
      <span class="list-main"><span class="list-title">Monatsbericht ${MONTHS[Number(ym.slice(5)) - 1]}</span></span>
      ${stateHTML(monthState(h, ym))}
    </a>`;
  };
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <button class="nav-btn" data-bh="heft-more" aria-label="Mehr">${ICON.more}</button>
    </header>
    <h1 class="large-title">${h.jahr}. Ausbildungsjahr</h1>
    <p class="bh-sub muted">${fmtYearSpan(h)}</p>
    <div class="card list">
      <button class="list-row bh-r" data-bh="pdf-all"><span class="list-main"><span class="list-title">Berichtsheft senden</span><span class="list-sub">Wochen und Monate als PDF</span></span><span class="bh-pdf-icon">${ICON.share}</span></button>
    </div>
    ${keys
      .map((ym) => {
        const g = groups.get(ym);
        // Je Seite des Monats ein Strich in der Farbe ihres Stands
        const states = [
          ...(g.month ? [monthState(h, ym)] : []),
          ...g.weeks.map(({ mon }) => weekState(h, mon)),
        ];
        return `<h2 class="section-title month-head"><span>${monthName(ym)}</span><span class="bh-segs">${states.map((st) => `<i class="${st}"></i>`).join('')}</span></h2>
        <div class="card list">${g.month ? monthRow(ym) : ''}${g.weeks.slice().reverse().map(weekRow).join('')}</div>`;
      })
      .join('')}
    ${keys.length ? '' : `<p class="footnote center">Das Ausbildungsjahr beginnt am ${fmtShort(parseDate(h.start))}.</p>`}`;
}

function heftMoreMenu() {
  const h = currentHeft();
  const open = [
    ...heftWeeks(h).filter((k) => weekState(h, k) === 'azubi').map((k) => h.weeks[k]),
    ...heftMonths(h).filter((k) => monthState(h, k) === 'azubi').map((k) => h.months[k]),
  ];
  actionSheet([
    ...(open.length
      ? [{ label: `Alle als Ausbilder abzeichnen (${open.length})`, run: () => withSignature('ausbilder', () => {
          open.forEach((e) => ((e.signed.ausbilder = isoDate(new Date())), bhTouch(e)));
          saveBh();
          renderHeft(h);
          toast(`${open.length} ${open.length === 1 ? 'Seite' : 'Seiten'} abgezeichnet`);
        }) }]
      : []),
    {
      label: 'Berichtsheft löschen',
      destructive: true,
      run: () =>
        confirmDialog(`${h.jahr}. Ausbildungsjahr löschen?`, 'Alle Wochen- und Monatsberichte dieses Hefts gehen verloren.', 'Löschen', () => {
          Object.values(h.months).forEach((mo) => ['taet', 'schule'].forEach((k) => mo[k]?.img && bhDeleteImage(mo[k].img.id)));
          bh.hefte = bh.hefte.filter((x) => x !== h);
          saveBh();
          location.replace('#/');
        }, true),
    },
  ]);
}

// ───────── Wochenbericht ─────────

/** Zeile so lang, dass sie im Vordruck stark verkleinert würde */
function lineLong(t) {
  const f = bhColumn(BH_FIELDS.woche, 76.2)[0];
  return measureText(String(t || '').trim(), 8) > (f.r[2] - f.r[0] - 4) * 1.3;
}
/** Einzelstunden fehlen: Zeile beschrieben, Tag hat Gesamtstunden (Urlaub, Krank usw. haben keine) */
const lineMissing = (l, d) => !!l.t.trim() && !l.h.trim() && !!String(d.hours || '').trim();
function lineHTML(i, k, l, d) {
  return `<div class="bh-line"><input class="bh-lt${lineLong(l.t) ? ' long' : ''}" data-bh-lt="${i}" data-k="${k}" value="${escapeHtml(l.t)}" placeholder="${
    k ? '' : 'Ausgeführte Arbeiten, Unterricht usw.'
  }" enterkeyhint="done"><input class="bh-lh${lineMissing(l, d) ? ' miss' : ''}" data-bh-lh="${i}" data-k="${k}" value="${escapeHtml(l.h)}" inputmode="decimal" placeholder="Std." enterkeyhint="done"></div>`;
}
const addLineHTML = (i) => `<button class="bh-addline" data-bh="add-line" data-i="${i}">${ICON.plus} Zeile</button>`;

function renderBhWeek(h, mon) {
  if (bhEntry?.key !== mon) bhUnlocked = null;
  const weeks = heftWeeks(h);
  const nr = weeks.indexOf(mon) + 1;
  if (!nr) return location.replace(`#/heft/${h.id}`);
  const w = h.weeks[mon] || emptyWeek();
  // leere Zeilen fallen weg; so bleiben die Zeilen im Blatt ohne Lücken
  w.days.forEach((d) => (d.lines = d.lines.filter((l) => l.t.trim() || l.h.trim())));
  const [a, b] = weekSpan(h, mon, w);
  const days = weekDays(h, mon);
  const hasSheet = days.some((i) => sheetDayFor(addDays(parseDate(mon), i)));
  // vom Ausbilder abgezeichnet: nur lesen, bis der Azubi die Warnung bestätigt
  const locked = !!w.signed?.ausbilder && bhUnlocked !== mon;
  const dayCard = (i) => {
    const d = w.days[i];
    const date = addDays(parseDate(mon), i);
    if (i === 5 && !dayFilled(d) && !bhSatOpen)
      return `<button class="card bh-day bh-sat" data-bh="sat">${ICON.plus} Samstag ${fmtDayMonth(date)}</button>`;
    if (d.type)
      return `<section class="card bh-day bh-typed status-${d.type}" data-i="${i}">
      <div class="bh-day-head"><b>${WEEKDAYS[i]}</b> <span class="muted">${fmtDayMonth(date)}</span>${bhTypeBtn(i, d)}</div>
    </section>`;
    const lines = d.lines.length ? d.lines : [{ t: '', h: '' }];
    return `<section class="card bh-day" data-i="${i}">
      <div class="bh-day-head"><b>${WEEKDAYS[i]}</b> <span class="muted">${fmtDayMonth(date)}</span>${bhTypeBtn(i, d)}
        <label class="bh-hours"><input data-bh-hours="${i}" inputmode="decimal" placeholder="0,00" value="${escapeHtml(d.hours || '')}" enterkeyhint="done"><span>Std.</span></label>
      </div>
      <div class="bh-lines">${lines.map((l, k) => lineHTML(i, k, l, d)).join('')}${lines.length < BH_LINES ? addLineHTML(i) : ''}</div>
    </section>`;
  };
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <button class="nav-btn" data-bh="pdf-page" aria-label="PDF">${ICON.share}</button>
    </header>
    <h1 class="large-title">Woche Nr. ${nr}</h1>
    <p class="bh-sub muted">${fmtDayMonth(a)} – ${fmtShort(b)} · KW ${isoWeek(parseDate(mon))}</p>
    <div class="${locked ? 'bh-locked' : ''}">
      ${hasSheet ? `<button class="bh-add bh-import" data-bh="from-sheets">${ICON.doc}<span>Aus Stundenzettel übernehmen</span></button>` : ''}
      <div class="bh-days">${days.map(dayCard).join('')}</div>
    </div>
    ${signCardHTML(w, b)}
    ${pdfThumbHTML('Bericht')}`;
  bhEntry = { kind: 'woche', h, key: mon };
  if (locked) app.querySelectorAll('.bh-locked input').forEach((x) => (x.readOnly = true));
  fitRowTexts();
  updatePdfThumb(true);
}
/** Tagesart-Knopf wie im Stundenzettel (nur Mo–Fr) */
const bhTypeLabel = (type, date) => (type === 'feiertag' ? holidayName(date) || 'Feiertag' : bhTypes()[type]);
const bhTypeBtn = (i, d) =>
  i < 5
    ? `<button class="chip-btn status-btn bh-type ${d.type ? `set status-tag status-${d.type}` : ''}" data-bh="type" data-i="${i}">${
        d.type ? `${ICON[d.type]} ${bhTypes()[d.type]}${bhTypeHours(d.type) ? ` · ${bhTypeHours(d.type)} h` : ''}` : 'Arbeit'
      } ▾</button>`
    : '';
/** Tagesart wählen; Zeilen und Stunden bleiben dabei gespeichert */
function bhChooseType(i) {
  const { h, key } = bhEntry;
  const d = bhCurrent(false)?.days[i];
  const set = (type) => {
    const w = bhCurrent();
    if (type) w.days[i].type = type;
    else delete w.days[i].type;
    bhBreakSeal(w);
    bhWeekChanged(w);
    saveBh();
    renderBhWeek(h, key);
  };
  actionSheet([
    { label: `${d?.type ? '' : '✓ '}Arbeit`, run: () => set(null) },
    ...Object.entries(bhTypes()).map(([k, label]) => ({ label: `${d?.type === k ? '✓ ' : ''}${label}`, run: () => set(k) })),
  ]);
}
let bhSatOpen = false;
let bhEntry = null; // { kind, h, key } der geöffneten Seite
let bhUnlocked = null; // Montag der abgezeichneten Woche, die der Azubi trotzdem ändern will

/** Abgezeichnete Seite antippen: warnen; nach der Bestätigung lässt sie sich ändern */
function bhUnlockAsk() {
  const { kind, h, key } = bhEntry;
  const title = kind === 'woche' ? 'Woche ist abgezeichnet' : 'Monatsbericht ist abgezeichnet';
  confirmDialog(title, 'Eine Änderung entfernt die Unterschrift des Ausbilders. Er muss dann noch einmal unterschreiben.', 'Trotzdem ändern', () => {
    bhUnlocked = key;
    kind === 'woche' ? renderBhWeek(h, key) : renderBhMonth(h, key);
  });
}
/** Erste Änderung an einer abgezeichneten Seite: Unterschrift des Ausbilders fällt weg */
function bhBreakSeal(w) {
  if (!w.signed?.ausbilder) return;
  delete w.signed.ausbilder;
  bhRefreshSigns();
}
/** Woche geändert: automatische Unterschrift nach dem neuen Stand, Abzeichnen-Karte aktualisieren */
function bhWeekChanged(w) {
  bhTouch(w);
  const before = JSON.stringify(w.signed || {});
  bhAutoSign(w, weekComplete(bhEntry.h, bhEntry.key, w));
  if (JSON.stringify(w.signed || {}) !== before) bhRefreshSigns();
}
/** Monat geändert: wie bhWeekChanged */
function bhMonthChanged(mo) {
  bhTouch(mo);
  const before = JSON.stringify(mo.signed || {});
  bhAutoSign(mo, monthComplete(mo));
  if (JSON.stringify(mo.signed || {}) !== before) bhRefreshSigns();
}
/** Abzeichnen-Karte neu zeichnen, ohne die Seite (und den Fokus im Feld) zu verlieren */
function bhRefreshSigns() {
  const el = document.querySelector('.bh-signs');
  if (!el || !bhEntry) return;
  const { kind, h, key } = bhEntry;
  const e = bhCurrent(false);
  const tmp = document.createElement('div');
  tmp.innerHTML = signCardHTML(e, kind === 'woche' ? weekSpan(h, key, e)[1] : monthSpan(h, key)[1]);
  el.replaceWith(tmp.querySelector('.bh-signs'));
}

/** Eintrag der geöffneten Seite (legt ihn beim ersten Schreiben an) */
function bhCurrent(create = true) {
  const { kind, h, key } = bhEntry;
  const store = kind === 'woche' ? h.weeks : h.months;
  if (!store[key] && create) store[key] = kind === 'woche' ? emptyWeek() : emptyMonth();
  return store[key];
}

/** Stundenzettel-Tag fürs Berichtsheft: jede Tätigkeit eine Zeile (Überlauf in die letzte), Tagesarten als Wort.
 *  Einzelstunden bleiben leer: die Pause gehört zum ganzen Tag und lässt sich keiner Tätigkeit zuordnen. */
function sheetDayReport(d, date) {
  if (!d) return null;
  if (d.status && !canWork(d)) return { type: d.status };
  const parts = [];
  for (const r of d.rows) for (const p of String(r.work || '').split(',')) if (p.trim() && !parts.some((x) => sameKey(x) === sameKey(p))) parts.push(p.trim());
  const holiday = d.status === 'feiertag' ? holidayName(date) || 'Feiertag' : '';
  if (!parts.length) return holiday ? { lines: [holiday], hours: '' } : null;
  const net = workedNet(d);
  return { lines: [holiday, ...parts].filter(Boolean), hours: net ? fmtHours(net) : '' };
}

function weekFromSheets() {
  const { h, key } = bhEntry;
  const run = () => {
    const w = bhCurrent();
    let n = 0;
    for (const i of weekDays(h, key)) {
      const date = addDays(parseDate(key), i);
      const r = sheetDayReport(sheetDayFor(date), date);
      if (!r) continue;
      // Tagesart: was dort schon steht, bleibt gespeichert (zurück auf Arbeit ist es wieder da)
      w.days[i] = r.type ? { ...w.days[i], type: r.type } : { lines: capLines(r.lines.map((t) => ({ t, h: '' }))), hours: r.hours };
      n++;
    }
    if (n) bhBreakSeal(w);
    bhTouch(w);
    bhAutoSign(w, weekComplete(h, key, w));
    saveBh();
    renderBhWeek(h, key);
    toast(n ? `${n} ${n === 1 ? 'Tag' : 'Tage'} übernommen` : 'Im Stundenzettel steht für diese Woche nichts');
  };
  if (weekFilled(h.weeks[key])) confirmDialog('Einträge ersetzen?', 'Die Tage aus dem Stundenzettel überschreiben, was hier schon steht.', 'Ersetzen', run);
  else run();
}

// ───────── Monatsbericht ─────────

const BH_PARTS = [
  ['taet', 'Betriebliche Tätigkeit', 'Textfeld 1'],
  ['schule', 'Berufsschule', 'Beschriftungsfeld 2'],
];
/** Hinweis, wenn der Text im Vordruck stark verkleinert werden müsste */
function monthFitHTML(key, part) {
  const t = (part?.text || '').trim();
  if (!t) return '';
  const f = bhField(BH_FIELDS.monat, BH_PARTS.find((p) => p[0] === key)[2]);
  let [x1, y1, x2, y2] = f.r;
  if (part.img) y1 = y2 - (y2 - y1) * 0.4;
  const lines = wrapText(t, x2 - x1 - 8, 9).length;
  return lines * 9 * 1.17 > y2 - y1 - 6 ? 'Zu viel Text – passt nicht gut aufs Blatt' : '';
}

function renderBhMonth(h, ym) {
  if (bhEntry?.key !== ym) bhUnlocked = null;
  if (!heftMonths(h).includes(ym)) return location.replace(`#/heft/${h.id}`);
  const mo = h.months[ym] || emptyMonth();
  const locked = !!mo.signed?.ausbilder && bhUnlocked !== ym;
  const [a, b] = monthSpan(h, ym);
  // Fotos werden beim Start noch geladen: dann sobald sie da sind neu zeichnen
  if (!bhImagesLoaded)
    bhImagesReady.then(() => currentView === 'bhMonth' && bhEntry?.h === h && bhEntry.key === ym && renderBhMonth(h, ym));
  const part = ([key, title]) => {
    const p = mo[key] || {};
    const src = p.img && bhImages.get(p.img.id);
    return `<h2 class="section-title">${title}</h2>
    <section class="card bh-part" data-part="${key}">
      <textarea class="txt bh-text bh-long" data-bh-mtext="${key}" rows="4" placeholder="${key === 'taet' ? 'Was hast du im Betrieb gemacht?' : 'Was wurde in der Schule behandelt?'}">${escapeHtml(p.text || '')}</textarea>
      ${src ? `<div class="bh-photo"><img src="data:image/jpeg;base64,${src}" alt=""><button class="bh-photo-del" data-bh="img-del" data-part="${key}" aria-label="Bild entfernen">${ICON.close}</button></div>` : ''}
      ${!p.img ? `<label class="link-btn bh-photo-add">${ICON.plus} Bild<input type="file" accept="image/*" data-bh-img="${key}" hidden></label>` : ''}
      <p class="bh-over">${monthFitHTML(key, p)}</p>
    </section>`;
  };
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <button class="nav-btn" data-bh="pdf-page" aria-label="PDF">${ICON.share}</button>
    </header>
    <h1 class="large-title">${monthName(ym)}</h1>
    <p class="bh-sub muted">Monatsbericht · ${fmtDayMonth(a)} – ${fmtShort(b)}</p>
    <div class="${locked ? 'bh-locked' : ''}">${BH_PARTS.map(part).join('')}</div>
    ${signCardHTML(mo, b)}
    ${pdfThumbHTML('Bericht')}`;
  bhEntry = { kind: 'monat', h, key: ym };
  if (locked) app.querySelectorAll('.bh-locked textarea').forEach((x) => (x.readOnly = true));
  fitRowTexts();
  updatePdfThumb(true);
}

// ───────── Abzeichnen ─────────

function signCardHTML(e, lastDay) {
  const signed = e?.signed || {};
  const roles = BH_ROLES.filter(([r]) => r !== 'eltern' || bhMinor(lastDay) || signed.eltern);
  return `<h2 class="section-title">Abzeichnen</h2>
  <div class="card list bh-signs">${roles
    .map(([r, label]) => {
      const d = signed[r];
      return `<button class="list-row bh-r bh-sign" data-bh="sign" data-role="${r}">
        <span class="list-main"><span class="list-title">${label}</span>${d ? `<span class="list-sub">am ${fmtShort(parseDate(d))}</span>` : ''}</span>
        ${d && bh.sigs[r] ? signatureSVG(bh.sigs[r], 30) : `<span class="bh-sign-btn">${d ? '' : 'Abzeichnen'}</span>`}
      </button>`;
    })
    .join('')}</div>`;
}

/** Unterschrift für eine Rolle festlegen (seit v91 nur noch selbst unterschreiben, die Einstellungen haben keine mehr) */
function pickSignature(role, done) {
  signaturePad(done, BH_ROLES.find((r) => r[0] === role)[1]);
}
/** Gespeicherte Unterschrift der Rolle benutzen; fehlt sie, erst festlegen */
function withSignature(role, then) {
  if (bh.sigs[role]) return then();
  pickSignature(role, (sig) => {
    bh.sigs[role] = sig;
    bhTouchProfile();
    saveBh();
    then();
  });
}
/** Automatische Azubi-Unterschrift: fertiger Bericht (Woche: jeder Tag ausgefüllt, siehe weekComplete) trägt sie mit dem Tag
 *  der letzten Änderung, unfertiger verliert sie.
 *  Nach der Abzeichnung des Ausbilders bleibt sie, wie sie ist (sonst stünde das Azubi-Datum nach dem des Ausbilders). */
function bhAutoSign(e, filled) {
  if (!e || !bh.autoSign || !bh.sigs.azubi || e.signed?.ausbilder) return;
  if (filled) e.signed = { ...e.signed, azubi: isoDate(new Date()) };
  else if (e.signed?.azubi && !e.signed.frei) delete e.signed.azubi;
}

/** Automatische Unterschrift für alle Seiten nach den Regeln von heute (einmal je Start, ältere Wochen bekamen sie schon
 *  beim ersten Wort) bzw. beim Einschalten des Schalters */
let bhAutoChecked = false;
function bhAutoSignAll(force = false) {
  if ((bhAutoChecked && !force) || !bh.autoSign) return;
  bhAutoChecked = true;
  let changed = false;
  for (const h of bh.hefte) {
    // nur fehlende ergänzen bzw. unfertigen wegnehmen; vorhandene behalten ihr Datum
    for (const [mon, w] of Object.entries(h.weeks)) {
      const done = weekComplete(h, mon, w);
      if (done !== !!w.signed?.azubi && !w.signed?.ausbilder && !w.signed?.frei) bhAutoSign(w, done), (changed = true);
    }
    for (const m of Object.values(h.months)) {
      const done = monthComplete(m);
      if (done !== !!m.signed?.azubi && !m.signed?.ausbilder && !m.signed?.frei) bhAutoSign(m, done), (changed = true);
    }
  }
  if (changed) saveBh();
}

/** Unterschreiben bzw. Abzeichnung entfernen; force (3 s lang gedrückt): auch eine unfertige Seite unterschreiben */
function signTap(role, force = false) {
  const { kind, h, key } = bhEntry;
  const e = bhCurrent(false);
  const filled = kind === 'woche' ? weekFilled(e) : monthFilled(e);
  const rerender = () => (kind === 'woche' ? renderBhWeek(h, key) : renderBhMonth(h, key));
  if (e?.signed?.[role]) {
    actionSheet([
      {
        label: 'Abzeichnung entfernen',
        destructive: true,
        run: () => {
          delete e.signed[role];
          if (role === 'azubi') delete e.signed.frei;
          bhTouch(e);
          saveBh();
          rerender();
        },
      },
    ]);
    return;
  }
  const complete = kind === 'woche' ? weekComplete(h, key, e) : monthComplete(e);
  if (!filled || (!complete && !force)) return toast('Erst den Bericht schreiben');
  withSignature(role, () => {
    const cur = bhCurrent();
    cur.signed = { ...cur.signed, [role]: isoDate(new Date()) };
    if (role === 'azubi' && !complete) cur.signed.frei = true;
    bhTouch(cur);
    saveBh();
    rerender();
  });
}

// ───────── Angaben (Deckblatt, Vorblatt) und Unterschriften ─────────

const BH_PROFILE_FIELDS = [
  ['name', 'Name', 'family-name'],
  ['vorname', 'Vorname', 'given-name'],
  ['geboren', 'Geboren am', 'date'],
  ['strasse', 'Straße', 'address-line1'],
  ['wohnort', 'Wohnort', 'address-level2'],
  ['beruf', 'Ausbildungsberuf', ''],
  ['fachrichtung', 'Fachrichtung / Schwerpunkt', ''],
  ['betrieb', 'Ausbildungsbetrieb', 'organization'],
  ['abteilung', 'Ausbildungsabteilung', ''],
  ['beginn', 'Beginn der Ausbildung', 'date'],
  ['ende', 'Ende der Ausbildung', 'date'],
];

function renderBhInfo() {
  const p = bh.profile;
  // Name aus den Einstellungen vorschlagen („Max Muster“ → Vorname Max, Name Muster) – nur solange beide nie eingetragen
  // waren; selbst geleerte Felder bleiben leer
  if (p.name == null && p.vorname == null && (settings.name || '').trim()) {
    const parts = settings.name.trim().split(/\s+/);
    p.name = parts.pop();
    p.vorname = parts.join(' ');
    saveBh();
  }
  const field = ([k, label, ac]) =>
    ac === 'date'
      ? `<label class="field"><span>${label}</span><input type="date" data-bh-p="${k}" value="${escapeHtml(p[k] || '')}"></label>`
      : `<label class="field bh-tf"><span>${label}</span><textarea data-bh-p="${k}" rows="1" ${ac ? `autocomplete="${ac}"` : ''} enterkeyhint="done">${escapeHtml(p[k] || '')}</textarea></label>`;
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title">Angaben</h1>
    <div class="s-page">
    <div class="card form bh-form">${BH_PROFILE_FIELDS.slice(0, 5).map(field).join('')}</div>
    <div class="card form bh-form">${BH_PROFILE_FIELDS.slice(5).map(field).join('')}</div>
    <p class="footnote">Für Deckblatt, Vorblatt und jede Seite des Berichtshefts.</p>
    <h2 class="section-title">Unterschriften</h2>
    <div class="card list">${BH_ROLES.map(
      ([r, label]) => `<button class="list-row bh-r bh-sign" data-bh="sig-edit" data-role="${r}">
        <span class="list-main"><span class="list-title">${label}</span></span>
        ${bh.sigs[r] ? signatureSVG(bh.sigs[r], 30) : '<span class="bh-sign-btn">Hinzufügen</span>'}
      </button>${
        r === 'azubi'
          ? `<label class="list-row bh-r bh-auto"><span class="list-main"><span class="list-title">Automatisch unterschreiben</span></span><input type="checkbox" class="toggle" data-bh-auto ${
              bh.autoSign && bh.sigs.azubi ? 'checked' : ''
            } ${bh.sigs.azubi ? '' : 'disabled'}></label>`
          : ''
      }`
    ).join('')}</div>
    </div>
    ${pdfThumbHTML('Vorblatt')}`;
  app.querySelectorAll('.bh-tf textarea').forEach(bhFitField);
  updatePdfThumb(true);
}

/** Langer Wert: Bezeichnung klein darüber, Wert darunter mit Umbruch – so ist immer alles zu sehen */
function bhFitField(ta) {
  const row = ta.closest('.bh-tf');
  row.classList.remove('stack');
  ta.style.height = 'auto';
  if (ta.scrollHeight > parseFloat(getComputedStyle(ta).lineHeight) * 1.5 + 24) row.classList.add('stack');
  ta.style.height = 'auto';
  ta.style.height = `${ta.scrollHeight}px`;
}

function editSignature(role) {
  const label = BH_ROLES.find((r) => r[0] === role)[1];
  const set = (sig) => {
    bh.sigs[role] = sig;
    bhTouchProfile();
    saveBh();
    renderBhInfo();
  };
  if (!bh.sigs[role]) return pickSignature(role, set);
  actionSheet([
    { label: 'Neu unterschreiben', run: () => signaturePad(set, label) },
    {
      label: 'Unterschrift löschen',
      destructive: true,
      run: () => {
        delete bh.sigs[role];
        bhTouchProfile();
        saveBh();
        renderBhInfo();
      },
    },
  ]);
}

/** Ausbildungsbeginn geändert: Zeiträume aller Hefte neu berechnen (Einträge bleiben an ihren Daten) */
function bhRecalcYears() {
  if (!bh.profile.beginn) return;
  for (const h of bh.hefte) Object.assign(h, bhYearRange(h.jahr));
}

// ───────── PDF ─────────

const fmtLong = (iso) => (iso ? `${pad(parseDate(iso).getDate())}.${pad(parseDate(iso).getMonth() + 1)}.${parseDate(iso).getFullYear()}` : '');
function bhHeadFor(h, a, b) {
  const p = deDeep(bh.profile);
  return { name: p.name, vorname: p.vorname, beruf: p.beruf, abteilung: p.abteilung, von: fmtShort(a), bis: fmtShort(b), jahr: String(h.jahr) };
}
const bhSigsFor = (e) =>
  BH_ROLES.map(([r]) => (e?.signed?.[r] ? { sig: bh.sigs[r], date: fmtShort(parseDate(e.signed[r])) } : null));
const bhProfileForPdf = () => ({ ...deDeep(bh.profile), geboren: fmtLong(bh.profile.geboren), beginn: fmtLong(bh.profile.beginn), ende: fmtLong(bh.profile.ende) });

function addWeekPage(doc, h, mon) {
  const w = h.weeks[mon];
  const [a, b] = weekSpan(h, mon, w);
  const days = weekDays(h, mon);
  return bhWeekPage(doc, {
    nr: String(heftWeeks(h).indexOf(mon) + 1),
    head: bhHeadFor(h, a, b),
    days: [0, 1, 2, 3, 4, 5].map((i) => {
      if (!days.includes(i) || !w) return null;
      const d = w.days[i];
      // Tagesart: ihr Name (beim Feiertag der des Feiertags), Gesamtstunden 8,00 (Frei: keine)
      if (d.type) return { lines: [{ t: bhTypeLabel(d.type, addDays(parseDate(mon), i)), h: '' }], total: bhTypeHours(d.type) };
      return { lines: d.lines.filter((l) => l.t.trim() || l.h.trim()), total: d.hours || '' };
    }),
    sigs: bhSigsFor(w),
  });
}
function addMonthPage(doc, h, ym) {
  const mo = h.months[ym];
  const [a, b] = monthSpan(h, ym);
  const part = (k) => {
    const p = mo?.[k];
    if (!p) return {};
    const data = p.img && bhImages.get(p.img.id);
    return { text: p.text, img: data ? { jpeg: bhB64(data), w: p.img.w, h: p.img.h } : null };
  };
  bhMonthPage(doc, { monat: MONTHS[Number(ym.slice(5)) - 1], head: bhHeadFor(h, a, b), taet: part('taet'), schule: part('schule'), sigs: bhSigsFor(mo) });
}

/** Ganzes Heft (kind 'woche'/'monat'): Deckblatt, Vorblatt, Erläuterungen und alle Seiten bis heute; page: nur diese Seite */
function buildHeftPdf(h, kind, page = null) {
  // Kyrillisches deutsch (soweit schon übersetzt; sonst vorab anstoßen)
  pdfTranslateKick({ w: page ? (kind === 'monat' ? h.months[page] : h.weeks[page]) : h, p: bh.profile });
  h = { ...h, weeks: pdfDe(h.weeks), months: pdfDe(h.months) };
  const doc = new BhPdf();
  const monthly = kind === 'monat';
  const today = isoDate(new Date());
  if (!page) {
    bhDeckblatt(doc, monthly, bhProfileForPdf());
    bhVorblatt(doc, monthly, bhProfileForPdf(), String(h.jahr));
  }
  if (monthly) {
    for (const ym of page ? [page] : heftMonths(h).filter((k) => `${k}-01` <= today || monthFilled(h.months[k]))) addMonthPage(doc, h, ym);
  } else {
    for (const mon of page ? [page] : heftWeeks(h).filter((k) => k <= today || weekFilled(h.weeks[k]))) addWeekPage(doc, h, mon);
  }
  const [what, rest] = page
    ? monthly
      ? ['Monatsbericht', monthName(page)]
      : ['Wochenbericht', `Nr. ${heftWeeks(h).indexOf(page) + 1}`]
    : ['Berichtsheft', `${h.jahr}. Ausbildungsjahr – ${monthly ? 'Monate' : 'Wochen'}`];
  const blob = doc.output({ title: `${what} ${rest}`, author: bhName() });
  // Dateiname mit dem Namen des Azubis (beim Betrieb unterscheidbar)
  return new File([blob], pdfFileName(what, bhName(), rest), { type: 'application/pdf' });
}

/** Deckblatt und Vorblatt mit den Angaben, je als eigenes PDF (Vorschau auf der Seite „Angaben“ zum Durchblättern) */
function bhInfoFiles() {
  const one = (title, draw) => {
    const doc = new BhPdf();
    draw(doc);
    return new File([doc.output({ title, author: bhName() })], `${title}.pdf`, { type: 'application/pdf' });
  };
  return [one('Deckblatt', (doc) => bhDeckblatt(doc, false, bhProfileForPdf())), one('Vorblatt', (doc) => bhVorblatt(doc, false, bhProfileForPdf(), bhYearToday()))];
}

/** PDF der geöffneten Wochen- oder Monatsseite (für die Vorschau) */
const bhPageFile = () => (bhEntry && findHeft(bhEntry.h.id) ? buildHeftPdf(bhEntry.h, bhEntry.kind, bhEntry.key) : null);

async function shareBhPdf(files) {
  if (navigator.canShare && navigator.canShare({ files })) {
    try {
      await navigator.share({ files });
    } catch (e) {
      if (e && e.name !== 'AbortError') files.forEach(downloadFile);
    }
  } else files.forEach(downloadFile);
}

/** Eine Seite (page) oder ohne page das ganze Heft: Wochen und Monate als zwei PDFs, jedes mit seinem Deckblatt */
async function bhPdf(page) {
  const h = currentHeft();
  if (!bhImagesLoaded) await bhImagesReady;
  let files;
  try {
    files = page ? [buildHeftPdf(h, bhEntry.kind, page)] : [buildHeftPdf(h, 'woche'), buildHeftPdf(h, 'monat')];
  } catch (e) {
    window.fehlerMelden?.(e, 'pdf');
    toast('PDF konnte nicht erstellt werden');
    return;
  }
  shareBhPdf(files);
}

// ───────── Ereignisse ─────────

// Unterschreiben 3 s lang drücken: auch wenn die Seite nach unseren Regeln noch nicht fertig ist
const BH_FORCE_HOLD = 3000;
let bhPress = null; // { el, x, y, timer }
let bhSuppressClick = false;
function bhPressEnd() {
  if (!bhPress) return;
  clearTimeout(bhPress.timer);
  bhPress = null;
}
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest?.('[data-bh="sign"]');
  if (!el || e.button > 0 || layer.contains(el)) return;
  bhPressEnd();
  bhPress = { el, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
    const role = el.dataset.role;
    bhPressEnd();
    bhSuppressClick = true;
    setTimeout(() => (bhSuppressClick = false), 600);
    if (bhCurrent(false)?.signed?.[role]) return;
    haptic();
    signTap(role, true);
  }, BH_FORCE_HOLD) };
});
document.addEventListener('pointermove', (e) => {
  if (bhPress && Math.hypot(e.clientX - bhPress.x, e.clientY - bhPress.y) > 10) bhPressEnd();
});
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, bhPressEnd));
window.addEventListener('scroll', bhPressEnd, { passive: true });
document.addEventListener('click', (e) => {
  if (bhSuppressClick && e.target.closest?.('[data-bh="sign"]')) (e.preventDefault(), e.stopPropagation());
}, true);
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest?.('[data-bh="sign"]')) e.preventDefault();
});

// Abgezeichnete Woche: Antippen warnt erst (Felder sind nur lesbar)
document.addEventListener(
  'click',
  (e) => {
    if (!e.target.closest?.('.bh-locked')) return;
    e.preventDefault();
    e.stopPropagation();
    document.activeElement?.blur();
    bhUnlockAsk();
  },
  true
);

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-bh]');
  if (!el || layer.contains(el)) return;
  switch (el.dataset.bh) {
    case 'mode':
      if (settings.listMode === el.dataset.mode) break;
      haptic();
      settings.listMode = el.dataset.mode;
      saveSettings();
      renderList();
      window.scrollTo(0, 0);
      break;
    case 'new':
      newHeftMenu();
      break;
    case 'open':
      location.hash = `#/heft/${el.dataset.id}`;
      break;
    case 'heft-more':
      heftMoreMenu();
      break;
    case 'pdf-all':
      bhPdf();
      break;
    case 'pdf-page':
      bhPdf(bhEntry.key);
      break;
    case 'from-sheets':
      weekFromSheets();
      break;
    case 'sat':
      bhSatOpen = true;
      renderBhWeek(bhEntry.h, bhEntry.key);
      document.querySelector('[data-bh-lt="5"]')?.focus();
      break;
    case 'add-line': {
      // nur eine Eingabezeile mehr; gespeichert wird sie erst beim Schreiben
      const box = el.closest('.bh-lines');
      const k = box.querySelectorAll('.bh-line').length;
      el.insertAdjacentHTML('beforebegin', lineHTML(Number(el.dataset.i), k, { t: '', h: '' }, {}));
      if (k + 1 >= BH_LINES) el.remove();
      box.querySelector(`[data-bh-lt][data-k="${k}"]`).focus();
      break;
    }
    case 'sign':
      signTap(el.dataset.role);
      break;
    case 'type':
      bhChooseType(Number(el.dataset.i));
      break;
    case 'sig-edit':
      editSignature(el.dataset.role);
      break;
    case 'img-del': {
      const mo = bhCurrent(false);
      const p = mo?.[el.dataset.part];
      if (!p?.img) break;
      confirmDialog('Bild entfernen?', '', 'Entfernen', () => {
        bhDeleteImage(p.img.id);
        delete p.img;
        bhTouch(mo);
        if (mo.signed?.ausbilder) delete mo.signed.ausbilder;
        bhAutoSign(mo, monthComplete(mo));
        saveBh();
        renderBhMonth(bhEntry.h, bhEntry.key);
      }, true);
      break;
    }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.bhLt != null || t.dataset.bhLh != null) {
    const w = bhCurrent();
    const d = w.days[Number(t.dataset.bhLt ?? t.dataset.bhLh)];
    const k = Number(t.dataset.k);
    while (d.lines.length <= k) d.lines.push({ t: '', h: '' });
    d.lines[k][t.dataset.bhLt != null ? 't' : 'h'] = t.value;
    const row = t.closest('.bh-line');
    row.querySelector('.bh-lh').classList.toggle('miss', lineMissing(d.lines[k], d));
    row.querySelector('.bh-lt').classList.toggle('long', lineLong(d.lines[k].t));
    bhBreakSeal(w);
    bhWeekChanged(w);
    saveBh();
    updatePdfThumb();
  } else if (t.dataset.bhHours != null) {
    const w = bhCurrent();
    const d = w.days[Number(t.dataset.bhHours)];
    d.hours = t.value;
    bhBreakSeal(w);
    bhWeekChanged(w);
    t.closest('.bh-day').querySelectorAll('.bh-lh').forEach((x) => x.classList.toggle('miss', !!d.lines[Number(x.dataset.k)] && lineMissing(d.lines[Number(x.dataset.k)], d)));
    saveBh();
    updatePdfThumb();
  } else if (t.dataset.bhMtext != null) {
    const mo = bhCurrent();
    const k = t.dataset.bhMtext;
    mo[k] = { ...mo[k], text: t.value };
    bhBreakSeal(mo);
    bhMonthChanged(mo);
    saveBh();
    t.closest('.bh-part').querySelector('.bh-over').textContent = monthFitHTML(k, mo[k]);
    updatePdfThumb();
  } else if (t.dataset.bhP != null) {
    if (t.tagName === 'TEXTAREA') {
      t.value = t.value.replace(/\n/g, ' ');
      bhFitField(t);
    }
    bh.profile[t.dataset.bhP] = t.value.trim();
    bhTouchProfile();
    if (t.dataset.bhP === 'beginn' || t.dataset.bhP === 'ende') bhRecalcYears();
    saveBh();
    updatePdfThumb();
  }
});

// Angaben: Eingabetaste schließt das Feld (kein Zeilenumbruch)
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches?.('.bh-tf textarea')) {
    e.preventDefault();
    e.target.blur();
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.bhHours != null || t.dataset.bhLh != null) {
    // Stunden einheitlich schreiben: „8“ → „8,00“
    const v = t.value.trim();
    if (v && Number.isFinite(parseFloat(v.replace(',', '.')))) {
      t.value = parseNum(v).toFixed(2).replace('.', ',');
      const w = bhCurrent();
      const d = w.days[Number(t.dataset.bhHours ?? t.dataset.bhLh)];
      if (t.dataset.bhHours != null) d.hours = t.value;
      else d.lines[Number(t.dataset.k)].h = t.value;
      bhTouch(w);
      saveBh();
      updatePdfThumb();
    }
  } else if (t.dataset.bhAuto != null) {
    bh.autoSign = t.checked;
    bhTouchProfile();
    // beim Einschalten bekommen alle fertigen Berichte ohne Azubi-Unterschrift sie sofort
    bhAutoSignAll(true);
    saveBh();
  } else if (t.dataset.bhImg != null && t.files?.[0]) {
    const k = t.dataset.bhImg;
    // Das Verkleinern dauert: das Bild gehört zur Seite, auf der es gewählt wurde, auch wenn man inzwischen weiter ist
    const { h, key } = bhEntry;
    try {
      const img = await bhImportImage(t.files[0]);
      const mo = h.months[key] || (h.months[key] = emptyMonth());
      mo[k] = { ...mo[k], img };
      bhTouch(mo);
      if (mo.signed?.ausbilder) delete mo.signed.ausbilder;
      bhAutoSign(mo, monthComplete(mo));
      saveBh();
      if (currentView === 'bhMonth' && bhEntry?.h === h && bhEntry.key === key) renderBhMonth(h, key);
    } catch (err) {
      window.fehlerMelden?.(err, 'bild lesen');
      toast('Bild konnte nicht gelesen werden');
    }
  }
});

// ───────── Sicherung ─────────

/** Berichtsheft samt Bildern für die Sicherung */
const bhBackup = () => ({ ...bh, images: Object.fromEntries(bhImages) });

/** Aus einer Sicherung: fehlende Hefte, Seiten, Angaben, Unterschriften und Bilder übernehmen (Vorhandenes bleibt) */
function bhMerge(data) {
  if (!data || !Array.isArray(data.hefte)) return 0;
  let n = 0;
  for (const [k, v] of Object.entries(data.profile || {})) if (!bh.profile[k] && v) bh.profile[k] = v;
  for (const [k, v] of Object.entries(data.sigs || {})) if (!bh.sigs[k] && isSignature(v)) bh.sigs[k] = v;
  if (bh.autoSign == null && typeof data.autoSign === 'boolean') bh.autoSign = data.autoSign;
  for (const inc of data.hefte) {
    if (!inc?.id || !inc.start) continue;
    const cur = findHeft(inc.id) || bh.hefte.find((h) => h.jahr === inc.jahr);
    if (!cur) {
      const weeks = inc.weeks || {};
      Object.values(weeks).forEach(normWeek);
      bh.hefte.push({ ...inc, weeks, months: inc.months || {} });
      n++;
      continue;
    }
    for (const [k, w] of Object.entries(inc.weeks || {})) if (!weekFilled(cur.weeks[k]) && weekFilled(normWeek(w))) (cur.weeks[k] = w), n++;
    for (const [k, m] of Object.entries(inc.months || {})) if (!monthFilled(cur.months[k]) && monthFilled(m)) (cur.months[k] = m), n++;
  }
  for (const [id, img] of Object.entries(data.images || {})) if (!bhImages.has(id) && typeof img === 'string') bhPutImage(id, img);
  saveBh();
  return n;
}
