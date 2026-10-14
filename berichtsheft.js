'use strict';
// Berichtsheft (Ausbildungsnachweis nach den Vordrucken der Handwerkskammer): ein Heft je Ausbildungsjahr mit Wochen- und Monatsberichten.
// Einschalten in den Einstellungen; erreichbar über den Umschalter „Stundenzettel | Berichtsheft“ auf der Zettel-Seite.
// Wird vor app.js geladen: Hilfsfunktionen von app.js (settings, toast, svg …) erst beim Aufruf benutzen.

const BH_KEY = 'stdprotokoll.berichtsheft.v1';
// profile: Angaben fürs Deckblatt/Vorblatt (Datumsfelder als 'JJJJ-MM-TT')
// sigs: gespeicherte Unterschriften { azubi, eltern, ausbilder } wie settings.signature
// hefte: [{ id, jahr, start, end, weeks: { Montag 'JJJJ-MM-TT': Woche }, months: { 'JJJJ-MM': Monat } }]
// Woche: { days: [{ text, hours }] × 6 (Mo–Sa), signed: { azubi, eltern, ausbilder: 'JJJJ-MM-TT' } }
// Monat: { taet: { text, img }, schule: { text, img }, signed } – img: { id, w, h } (Bild in IndexedDB)
let bh = { profile: {}, sigs: {}, hefte: [] };
try {
  Object.assign(bh, JSON.parse(localStorage.getItem(BH_KEY)) || {});
} catch (e) {}
function saveBh() {
  try {
    localStorage.setItem(BH_KEY, JSON.stringify(bh));
  } catch (e) {
    toast('Speichern fehlgeschlagen – Speicher voll?');
  }
}

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
  .catch(() => {});
function bhPutImage(id, data) {
  bhImages.set(id, data);
  return bhDb()
    .then((db) => db.transaction('img', 'readwrite').objectStore('img').put(data, id))
    .catch(() => toast('Bild konnte nicht gespeichert werden'));
}
function bhDeleteImage(id) {
  bhImages.delete(id);
  bhDb()
    .then((db) => db.transaction('img', 'readwrite').objectStore('img').delete(id))
    .catch(() => {});
}
/** Foto verkleinern (längste Seite 1600 px) und als JPEG speichern */
async function bhImportImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const k = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const w = Math.round(img.naturalWidth * k);
    const h = Math.round(img.naturalHeight * k);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const data = c.toDataURL('image/jpeg', 0.82).split(',')[1];
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
  const days = weekDays(h, monday).filter((i) => i < 5 || (w?.days?.[5]?.text || '').trim());
  const mon = parseDate(monday);
  return days.length ? [addDays(mon, days[0]), addDays(mon, days.at(-1))] : [mon, addDays(mon, 4)];
}

// ───────── Inhalt und Stand ─────────

const emptyWeek = () => ({ days: [0, 1, 2, 3, 4, 5].map(() => ({ text: '', hours: '' })), signed: {} });
const emptyMonth = () => ({ taet: { text: '' }, schule: { text: '' }, signed: {} });
const weekFilled = (w) => !!w && w.days?.some((d) => (d?.text || '').trim());
const monthFilled = (m) => !!m && ['taet', 'schule'].some((k) => (m[k]?.text || '').trim() || m[k]?.img);
const isSigned = (e) => !!e && Object.values(e.signed || {}).some(Boolean);
/** Stand einer Seite: leer, offen (geschrieben), azubi (vom Azubi abgezeichnet), fertig (vom Ausbilder abgezeichnet) */
function pageState(e, filled) {
  if (!filled) return 'leer';
  if (e.signed?.ausbilder) return 'fertig';
  if (e.signed?.azubi) return 'azubi';
  return 'offen';
}
function heftProgress(h) {
  const weeks = heftWeeks(h);
  const months = heftMonths(h);
  return {
    weeks: weeks.length,
    weeksDone: weeks.filter((k) => weekFilled(h.weeks[k])).length,
    months: months.length,
    monthsDone: months.filter((k) => monthFilled(h.months[k])).length,
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

const BH_COLORS = ['#2c4a9e', '#2f7d5b', '#9c3a3a', '#6b4fa0', '#5d6670'];
const fmtYearSpan = (h) => `${fmtShort(parseDate(h.start))} – ${fmtShort(parseDate(h.end))}`;

/** Umschlag eines Hefts: farbiger Karton mit Heftrücken und Etikett */
function heftCoverHTML(h) {
  return `<div class="bh-cover" style="--heft:${BH_COLORS[(h.jahr - 1) % BH_COLORS.length]}">
    <span class="bh-spine"></span>
    <span class="bh-label">
      <b>Ausbildungsnachweis</b>
      <span class="bh-year">${h.jahr}. Ausbildungsjahr</span>
      <span class="bh-name">${escapeHtml(bhName())}</span>
    </span>
  </div>`;
}

function heftProgressHTML(h) {
  const g = heftProgress(h);
  const bar = (done, all) => `<span class="bh-bar"><i style="width:${all ? (100 * done) / all : 0}%"></i></span>`;
  return `<span class="bh-prog"><span>Wochen</span>${bar(g.weeksDone, g.weeks)}<span class="num">${g.weeksDone}/${g.weeks}</span></span>
    <span class="bh-prog"><span>Monate</span>${bar(g.monthsDone, g.months)}<span class="num">${g.monthsDone}/${g.months}</span></span>`;
}

function heftListHTML() {
  const list = hefteSorted();
  const add = `<button class="bh-add" data-bh="new">${ICON.plus}<span>Neues Berichtsheft</span></button>`;
  if (!list.length)
    return `<div class="empty">
      <div class="empty-icon">${svg('<path d="M5 3h11a3 3 0 0 1 3 3v15H8a3 3 0 0 1-3-3z"/><path d="M5 18a3 3 0 0 1 3-3h11M9 7h6"/>', 44)}</div>
      <p><b>Noch kein Berichtsheft</b></p>
    </div>${add}`;
  return `<div class="bh-rows">${list
    .map(
      (h) => `<button class="card bh-row" data-bh="open" data-id="${h.id}">${heftCoverHTML(h)}
      <span class="bh-info"><b>${h.jahr}. Ausbildungsjahr</b><span class="muted">${fmtYearSpan(h)}</span>${heftProgressHTML(h)}</span></button>`
    )
    .join('')}</div>${add}`;
}

/** Neues Heft: Ausbildungsjahr wählen (vorgeschlagen das Jahr von heute); ohne Ausbildungsbeginn erst die Angaben */
function newHeftMenu() {
  if (!bh.profile.beginn) {
    toast('Zuerst den Ausbildungsbeginn eintragen');
    location.hash = '#/heft-angaben';
    return;
  }
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
      ${stateHTML(pageState(w, weekFilled(w)))}
    </a>`;
  };
  const monthRow = (ym) => {
    const mo = h.months[ym];
    return `<a class="list-row bh-r bh-page" href="#/heft/${h.id}/monat/${ym}">
      <span class="list-kw bh-kw-month">Monat</span>
      <span class="list-main"><span class="list-title">Monatsbericht ${MONTHS[Number(ym.slice(5)) - 1]}</span></span>
      ${stateHTML(pageState(mo, monthFilled(mo)))}
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
      <a class="list-row bh-r" href="#/heft-angaben"><span class="list-main"><span class="list-title">Angaben</span><span class="list-sub">${
        bh.profile.name && bh.profile.beruf ? escapeHtml(bhName()) : 'Deckblatt und Vorblatt ausfüllen'
      }</span></span><span class="list-chevron">${ICON.chevronRight}</span></a>
      <button class="list-row bh-r" data-bh="pdf" data-kind="woche"><span class="list-main"><span class="list-title">Wochenheft</span><span class="list-sub">PDF mit allen Wochen</span></span><span class="bh-pdf-icon">${ICON.share}</span></button>
      <button class="list-row bh-r" data-bh="pdf" data-kind="monat"><span class="list-main"><span class="list-title">Monatsheft</span><span class="list-sub">PDF mit allen Monaten</span></span><span class="bh-pdf-icon">${ICON.share}</span></button>
    </div>
    ${keys
      .map((ym) => {
        const g = groups.get(ym);
        return `<h2 class="section-title month-head"><span>${monthName(ym)}</span></h2>
        <div class="card list">${g.month ? monthRow(ym) : ''}${g.weeks.slice().reverse().map(weekRow).join('')}</div>`;
      })
      .join('')}
    ${keys.length ? '' : `<p class="footnote center">Das Ausbildungsjahr beginnt am ${fmtShort(parseDate(h.start))}.</p>`}`;
}

function heftMoreMenu() {
  const h = currentHeft();
  const open = [
    ...heftWeeks(h).filter((k) => h.weeks[k]?.signed?.azubi && !h.weeks[k].signed.ausbilder).map((k) => h.weeks[k]),
    ...heftMonths(h).filter((k) => h.months[k]?.signed?.azubi && !h.months[k].signed.ausbilder).map((k) => h.months[k]),
  ];
  actionSheet([
    ...(open.length
      ? [{ label: `Alle als Ausbilder abzeichnen (${open.length})`, run: () => withSignature('ausbilder', () => {
          open.forEach((e) => (e.signed.ausbilder = isoDate(new Date())));
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

const bhEditable = (e) => !isSigned(e);
/** Zeilen, die der Text eines Tages im Vordruck belegt (5 passen hinein) */
function dayLines(text) {
  if (!(text || '').trim()) return 0;
  const f = bhColumn(BH_FIELDS.woche, 76.2)[0];
  return wrapText(text.replace(/\n+$/, ''), f.r[2] - f.r[0] - 4, 8).length;
}
const overHTML = (n) => (n > 5 ? `Passt nicht ganz aufs Blatt (${n} von 5 Zeilen)` : '');

function renderBhWeek(h, mon) {
  const weeks = heftWeeks(h);
  const nr = weeks.indexOf(mon) + 1;
  if (!nr) return location.replace(`#/heft/${h.id}`);
  const w = h.weeks[mon] || emptyWeek();
  const [a, b] = weekSpan(h, mon, w);
  const locked = !bhEditable(w);
  const days = weekDays(h, mon);
  const hasSheet = days.some((i) => sheetDayFor(addDays(parseDate(mon), i)));
  const dayCard = (i) => {
    const d = w.days[i];
    const date = addDays(parseDate(mon), i);
    if (i === 5 && !(d.text || '').trim() && !bhSatOpen)
      return `<button class="card bh-day bh-sat" data-bh="sat"${locked ? ' disabled' : ''}>${ICON.plus} Samstag ${fmtDayMonth(date)}</button>`;
    return `<section class="card bh-day" data-i="${i}">
      <div class="bh-day-head"><b>${WEEKDAYS[i]}</b> <span class="muted">${fmtDayMonth(date)}</span>
        <label class="bh-hours"><input data-bh-hours="${i}" inputmode="decimal" placeholder="0,00" value="${escapeHtml(d.hours || '')}" enterkeyhint="done"${locked ? ' readonly' : ''}><span>Std.</span></label>
      </div>
      <textarea class="txt bh-text" data-bh-text="${i}" rows="2" placeholder="Ausgeführte Arbeiten, Unterricht usw."${locked ? ' readonly' : ''}>${escapeHtml(d.text || '')}</textarea>
      <p class="bh-over">${overHTML(dayLines(d.text))}</p>
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
    ${hasSheet && !locked ? `<button class="bh-add bh-import" data-bh="from-sheets">${ICON.doc}<span>Aus Stundenzettel übernehmen</span></button>` : ''}
    <div class="bh-days">${days.map(dayCard).join('')}</div>
    ${signCardHTML(w, b)}
    ${pdfThumbHTML('Bericht')}`;
  bhEntry = { kind: 'woche', h, key: mon };
  fitRowTexts();
  updatePdfThumb(true);
}
let bhSatOpen = false;
let bhEntry = null; // { kind, h, key } der geöffneten Seite

/** Eintrag der geöffneten Seite (legt ihn beim ersten Schreiben an) */
function bhCurrent(create = true) {
  const { kind, h, key } = bhEntry;
  const store = kind === 'woche' ? h.weeks : h.months;
  if (!store[key] && create) store[key] = kind === 'woche' ? emptyWeek() : emptyMonth();
  return store[key];
}

/** Text eines Stundenzettel-Tages fürs Berichtsheft: jede Arbeit eine Zeile; Tagesarten als Wort */
function sheetDayReport(d, date) {
  if (!d) return null;
  if (d.status && !canWork(d)) return { text: DAY_STATUS_SHORT[d.status], hours: '' };
  const parts = [];
  for (const r of d.rows) for (const p of String(r.work || '').split(',')) if (p.trim() && !parts.some((x) => sameKey(x) === sameKey(p))) parts.push(p.trim());
  const holiday = d.status === 'feiertag' ? holidayName(date) || 'Feiertag' : '';
  if (!parts.length) return holiday ? { text: holiday, hours: '' } : null;
  const net = workedNet(d);
  return { text: [holiday, ...parts].filter(Boolean).join('\n'), hours: net ? fmtHours(net) : '' };
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
      w.days[i] = { text: r.text, hours: r.hours };
      n++;
    }
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
  if (!heftMonths(h).includes(ym)) return location.replace(`#/heft/${h.id}`);
  const mo = h.months[ym] || emptyMonth();
  const [a, b] = monthSpan(h, ym);
  const locked = !bhEditable(mo);
  const part = ([key, title]) => {
    const p = mo[key] || {};
    const src = p.img && bhImages.get(p.img.id);
    return `<h2 class="section-title">${title}</h2>
    <section class="card bh-part" data-part="${key}">
      <textarea class="txt bh-text bh-long" data-bh-mtext="${key}" rows="4" placeholder="${key === 'taet' ? 'Was hast du im Betrieb gemacht?' : 'Was wurde in der Schule behandelt?'}"${locked ? ' readonly' : ''}>${escapeHtml(p.text || '')}</textarea>
      ${src ? `<div class="bh-photo"><img src="data:image/jpeg;base64,${src}" alt="">${locked ? '' : `<button class="bh-photo-del" data-bh="img-del" data-part="${key}" aria-label="Bild entfernen">${ICON.close}</button>`}</div>` : ''}
      ${!locked && !p.img ? `<label class="link-btn bh-photo-add">${ICON.plus} Bild<input type="file" accept="image/*" data-bh-img="${key}" hidden></label>` : ''}
      <p class="bh-over">${monthFitHTML(key, p)}</p>
    </section>`;
  };
  const anyWeeks = heftWeeks(h).some((k) => weekMonth(h, k) === ym && weekFilled(h.weeks[k]));
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <button class="nav-btn" data-bh="pdf-page" aria-label="PDF">${ICON.share}</button>
    </header>
    <h1 class="large-title">${monthName(ym)}</h1>
    <p class="bh-sub muted">Monatsbericht · ${fmtDayMonth(a)} – ${fmtShort(b)}</p>
    ${anyWeeks && !locked ? `<button class="bh-add bh-import" data-bh="from-weeks">${ICON.doc}<span>Aus den Wochen übernehmen</span></button>` : ''}
    ${BH_PARTS.map(part).join('')}
    ${signCardHTML(mo, b)}
    ${pdfThumbHTML('Bericht')}`;
  bhEntry = { kind: 'monat', h, key: ym };
  fitRowTexts();
  updatePdfThumb(true);
}

/** Stichpunkte der Wochen eines Monats als Anfang für den Monatsbericht (Berufsschul-Tage getrennt) */
function monthFromWeeks() {
  const { h, key } = bhEntry;
  const work = [];
  const school = [];
  for (const mon of heftWeeks(h).filter((k) => weekMonth(h, k) === key)) {
    for (const d of h.weeks[mon]?.days || []) {
      const lines = String(d?.text || '').split('\n').map((l) => l.replace(/^[•\-–]\s*/, '').trim()).filter(Boolean);
      const isSchool = /^berufsschule/i.test(lines[0] || '');
      for (const l of lines) {
        const t = l.replace(/^berufsschule:?\s*/i, '');
        const list = isSchool ? school : work;
        if (t && !/^(urlaub|krank|frei)$/i.test(t) && !list.some((x) => sameKey(x) === sameKey(t))) list.push(t);
      }
    }
  }
  const run = () => {
    const mo = bhCurrent();
    mo.taet = { ...mo.taet, text: work.map((t) => `• ${t}`).join('\n') };
    if (school.length) mo.schule = { ...mo.schule, text: school.map((t) => `• ${t}`).join('\n') };
    saveBh();
    renderBhMonth(h, key);
  };
  if (monthFilled(h.months[key])) confirmDialog('Text ersetzen?', 'Die Stichpunkte aus den Wochen überschreiben den Text hier.', 'Ersetzen', run);
  else run();
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
    .join('')}</div>
  ${isSigned(e) ? '<p class="footnote">Zum Ändern zuerst die Unterschriften entfernen.</p>' : ''}`;
}

/** Gespeicherte Unterschrift der Rolle benutzen; fehlt sie, erst unterschreiben lassen */
function withSignature(role, then) {
  if (bh.sigs[role]) return then();
  signaturePad((sig) => {
    bh.sigs[role] = sig;
    saveBh();
    then();
  }, BH_ROLES.find((r) => r[0] === role)[1]);
}

function signTap(role) {
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
          saveBh();
          rerender();
        },
      },
    ]);
    return;
  }
  if (!filled) return toast('Erst den Bericht schreiben');
  withSignature(role, () => {
    const cur = bhCurrent();
    cur.signed = { ...cur.signed, [role]: isoDate(new Date()) };
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
  const field = ([k, label, ac]) =>
    ac === 'date'
      ? `<label class="field"><span>${label}</span><input type="date" data-bh-p="${k}" value="${escapeHtml(p[k] || '')}"></label>`
      : `<label class="field"><span>${label}</span><input data-bh-p="${k}" value="${escapeHtml(p[k] || '')}" ${ac ? `autocomplete="${ac}"` : ''} enterkeyhint="done"></label>`;
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
      </button>`
    ).join('')}</div>
    </div>`;
}

function editSignature(role) {
  const label = BH_ROLES.find((r) => r[0] === role)[1];
  const draw = () =>
    signaturePad((sig) => {
      bh.sigs[role] = sig;
      saveBh();
      renderBhInfo();
    }, label);
  if (!bh.sigs[role]) return draw();
  actionSheet([
    { label: 'Neu unterschreiben', run: draw },
    {
      label: 'Unterschrift löschen',
      destructive: true,
      run: () => {
        delete bh.sigs[role];
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
  const p = bh.profile;
  return { name: p.name, vorname: p.vorname, beruf: p.beruf, abteilung: p.abteilung, von: fmtShort(a), bis: fmtShort(b), jahr: String(h.jahr) };
}
const bhSigsFor = (e) =>
  BH_ROLES.map(([r]) => (e?.signed?.[r] ? { sig: bh.sigs[r], date: fmtShort(parseDate(e.signed[r])) } : null));
const bhProfileForPdf = () => ({ ...bh.profile, geboren: fmtLong(bh.profile.geboren), beginn: fmtLong(bh.profile.beginn), ende: fmtLong(bh.profile.ende) });

function addWeekPage(doc, h, mon) {
  const w = h.weeks[mon];
  const [a, b] = weekSpan(h, mon, w);
  const days = weekDays(h, mon);
  return bhWeekPage(doc, {
    nr: String(heftWeeks(h).indexOf(mon) + 1),
    head: bhHeadFor(h, a, b),
    days: [0, 1, 2, 3, 4, 5].map((i) => (days.includes(i) && w ? { text: w.days[i]?.text || '', total: w.days[i]?.hours || '' } : null)),
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
  const what = page
    ? monthly
      ? `Monatsbericht ${monthName(page)}`
      : `Wochenbericht Nr. ${heftWeeks(h).indexOf(page) + 1}`
    : `Berichtsheft ${h.jahr}. Ausbildungsjahr – ${monthly ? 'Monate' : 'Wochen'}`;
  const blob = doc.output({ title: what, author: bhName() });
  return new File([blob], `${what}.pdf`, { type: 'application/pdf' });
}

/** PDF der geöffneten Wochen- oder Monatsseite (für die Vorschau) */
const bhPageFile = () => (bhEntry && findHeft(bhEntry.h.id) ? buildHeftPdf(bhEntry.h, bhEntry.kind, bhEntry.key) : null);

async function shareBhPdf(file) {
  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      if (e && e.name !== 'AbortError') downloadFile(file);
    }
  } else downloadFile(file);
}

function bhPdf(kind, page) {
  const h = currentHeft();
  let file;
  try {
    file = buildHeftPdf(h, kind, page);
  } catch (e) {
    toast('PDF konnte nicht erstellt werden');
    return;
  }
  shareBhPdf(file);
}

// ───────── Ereignisse ─────────

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
    case 'pdf':
      bhPdf(el.dataset.kind);
      break;
    case 'pdf-page':
      bhPdf(bhEntry.kind, bhEntry.key);
      break;
    case 'from-sheets':
      weekFromSheets();
      break;
    case 'from-weeks':
      monthFromWeeks();
      break;
    case 'sat':
      bhSatOpen = true;
      renderBhWeek(bhEntry.h, bhEntry.key);
      document.querySelector('[data-bh-text="5"]')?.focus();
      break;
    case 'sign':
      signTap(el.dataset.role);
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
        saveBh();
        renderBhMonth(bhEntry.h, bhEntry.key);
      }, true);
      break;
    }
  }
});

document.addEventListener('input', (e) => {
  const t = e.target;
  if (t.dataset.bhText != null) {
    const i = Number(t.dataset.bhText);
    bhCurrent().days[i].text = t.value;
    saveBh();
    t.closest('.bh-day').querySelector('.bh-over').textContent = overHTML(dayLines(t.value));
    updatePdfThumb();
  } else if (t.dataset.bhHours != null) {
    bhCurrent().days[Number(t.dataset.bhHours)].hours = t.value;
    saveBh();
    updatePdfThumb();
  } else if (t.dataset.bhMtext != null) {
    const mo = bhCurrent();
    const k = t.dataset.bhMtext;
    mo[k] = { ...mo[k], text: t.value };
    saveBh();
    t.closest('.bh-part').querySelector('.bh-over').textContent = monthFitHTML(k, mo[k]);
    updatePdfThumb();
  } else if (t.dataset.bhP != null) {
    bh.profile[t.dataset.bhP] = t.value.trim();
    if (t.dataset.bhP === 'beginn' || t.dataset.bhP === 'ende') bhRecalcYears();
    saveBh();
  }
});

document.addEventListener('change', async (e) => {
  const t = e.target;
  if (t.dataset.bhHours != null) {
    // Stunden einheitlich schreiben: „8“ → „8,00“
    const v = t.value.trim();
    if (v && Number.isFinite(parseFloat(v.replace(',', '.')))) {
      t.value = parseNum(v).toFixed(2).replace('.', ',');
      bhCurrent().days[Number(t.dataset.bhHours)].hours = t.value;
      saveBh();
    }
  } else if (t.dataset.bhImg != null && t.files?.[0]) {
    const k = t.dataset.bhImg;
    // Das Verkleinern dauert: das Bild gehört zur Seite, auf der es gewählt wurde, auch wenn man inzwischen weiter ist
    const { h, key } = bhEntry;
    try {
      const img = await bhImportImage(t.files[0]);
      const mo = h.months[key] || (h.months[key] = emptyMonth());
      mo[k] = { ...mo[k], img };
      saveBh();
      if (currentView === 'bhMonth' && bhEntry?.h === h && bhEntry.key === key) renderBhMonth(h, key);
    } catch (err) {
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
  for (const inc of data.hefte) {
    if (!inc?.id || !inc.start) continue;
    const cur = findHeft(inc.id) || bh.hefte.find((h) => h.jahr === inc.jahr);
    if (!cur) {
      bh.hefte.push({ ...inc, weeks: inc.weeks || {}, months: inc.months || {} });
      n++;
      continue;
    }
    for (const [k, w] of Object.entries(inc.weeks || {})) if (!weekFilled(cur.weeks[k]) && weekFilled(w)) (cur.weeks[k] = w), n++;
    for (const [k, m] of Object.entries(inc.months || {})) if (!monthFilled(cur.months[k]) && monthFilled(m)) (cur.months[k] = m), n++;
  }
  for (const [id, img] of Object.entries(data.images || {})) if (!bhImages.has(id) && typeof img === 'string') bhPutImage(id, img);
  saveBh();
  return n;
}
