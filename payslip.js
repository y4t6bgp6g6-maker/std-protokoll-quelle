// Lohnabrechnung einlesen: Foto → Texterkennung (Tesseract.js, läuft auf dem iPhone; Programm und Sprachdaten
// werden beim ersten Mal aus dem Netz geladen) → Werte aus dem Text (DATEV-Abrechnung „Brutto/Netto-Bezüge“).
// Das Foto selbst wird nicht gespeichert, nur die erkannten Zahlen.

const TESSERACT_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
const PAYSLIP_MONTHS = ['januar', 'februar', 'märz', 'april', 'mai', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'];
/** Abgekürzte Monatsnamen („für Jan 2025 (1. NB)“) – nur mit Jahreszahl dahinter */
const PAYSLIP_MONTHS_SHORT = { jan: 1, feb: 2, mär: 3, mar: 3, mrz: 3, apr: 4, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, okt: 10, nov: 11, dez: 12 };

let tesseractLoad = null;
function loadTesseract() {
  if (window.Tesseract) return Promise.resolve();
  tesseractLoad ||= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = TESSERACT_URL;
    s.onload = resolve;
    s.onerror = () => {
      tesseractLoad = null;
      reject(new Error('Texterkennung konnte nicht geladen werden (Internet?)'));
    };
    document.head.append(s);
  });
  return tesseractLoad;
}

/**
 * Foto für die Texterkennung aufbereiten. Drei Durchgänge; jeder macht seine Lesefehler an anderen Stellen, zusammen
 * bestätigen sie die Zahlen gegenseitig:
 * 1: ganze Seite, lange Seite 3400 px, Graustufen und örtliche Schwelle (jeder Bildpunkt wird mit der Helligkeit seiner
 *    Umgebung verglichen – gleicht Schatten, Knicke und ungleiches Licht aus)
 * 2: ganze Seite, 2400 px, nur Graustufen und etwas Kontrast
 * 3: nur das rechte gute Drittel (Spalte „Betrag“: Lohnarten, Gesamt-Brutto, Abzüge, Netto, Auszahlung) in hoher
 *    Auflösung mit örtlicher Schwelle – dort stehen die Summen
 * An 23 echten Abrechnungen getestet, dazu jede zweimal künstlich verschlechtert (schief, unscharf, Schatten, klein).
 */
const PAYSLIP_PASSES = 3;
async function payslipCanvas(file, pass = 1) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const x0 = pass === 3 ? Math.round(bmp.width * 0.64) : 0;
  const sw = bmp.width - x0;
  const sh = bmp.height;
  const f = Math.min(1, (pass === 1 ? 3400 : pass === 2 ? 2400 : 3000) / Math.max(sw, sh));
  const c = document.createElement('canvas');
  c.width = Math.round(sw * f);
  c.height = Math.round(sh * f);
  const ctx = c.getContext('2d', { willReadFrequently: pass !== 2 });
  ctx.filter = 'grayscale(1) contrast(1.15)';
  ctx.drawImage(bmp, x0, 0, sw, sh, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  if (pass !== 2) {
    const { width: w, height: h } = c;
    const img = ctx.getImageData(0, 0, w, h);
    const d = img.data;
    // Summenbild: Mittelwert jeder Umgebung in konstanter Zeit
    const I = new Uint32Array((w + 1) * (h + 1));
    for (let y = 0; y < h; y++) {
      let row = 0;
      for (let x = 0; x < w; x++) {
        row += d[(y * w + x) * 4];
        I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row;
      }
    }
    const r = Math.round(Math.max(w, h) / (pass === 3 ? 40 : 80));
    for (let y = 0; y < h; y++) {
      const y0 = Math.max(0, y - r);
      const y1 = Math.min(h, y + r + 1);
      for (let x = 0; x < w; x++) {
        const x0 = Math.max(0, x - r);
        const x1 = Math.min(w, x + r + 1);
        const sum = I[y1 * (w + 1) + x1] - I[y0 * (w + 1) + x1] - I[y1 * (w + 1) + x0] + I[y0 * (w + 1) + x0];
        const i = (y * w + x) * 4;
        const v = d[i] * (x1 - x0) * (y1 - y0) < sum * 0.85 ? 0 : 255;
        d[i] = d[i + 1] = d[i + 2] = v;
      }
    }
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

/**
 * Texterkennung für eine Lohnabrechnung (ein Programm für alle Durchgänge).
 * read(file, pass, onProgress(0…1)) → Text; danach close().
 */
async function payslipReader() {
  await loadTesseract();
  let progress = () => {};
  const worker = await Tesseract.createWorker('deu', 1, {
    logger: (m) => m.status === 'recognizing text' && progress(m.progress),
  });
  // Seite als ein Textblock lesen: so bleiben die Zeilen der Lohnarten zusammen
  await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
  return {
    async read(file, pass, onProgress = () => {}) {
      progress = onProgress;
      const { data } = await worker.recognize(await payslipCanvas(file, pass));
      return data.text;
    },
    close: () => worker.terminate(),
  };
}

/** „1.234,50“ / „500 ,00“ → 1234.5 */
const payslipNum = (s) => parseFloat(String(s).replace(/\s+/g, '').replace(/\./g, '').replace(',', '.'));
const psR2 = (v) => Math.round(v * 100 + (v >= 0 ? 1e-6 : -1e-6)) / 100;
const psNear = (a, b, tol = 0.011) => a != null && b != null && Math.abs(a - b) < tol;
/** Euro-Beträge einer Zeile („2.345,60“, ohne Tausenderpunkt „2345,60“, auch „500 ,00-“); nie nur das Ende einer
 *  längeren Zahl („3,360,00“ ist kein Betrag 360,00) */
function moneyIn(line) {
  return moneyTokens(line).map((t) => t.v);
}
const lastMoney = (line) => moneyIn(line).at(-1) ?? null;
/** Betrag aus der Zeile mit dem Stichwort oder – steht die Zahl darunter – aus den folgenden Zeilen */
function moneyAfter(lines, re, ahead = 2) {
  const i = lines.findIndex((l) => re.test(l));
  if (i < 0) return null;
  for (let k = i; k <= Math.min(lines.length - 1, i + ahead); k++) {
    const v = lastMoney(k === i ? lines[k].slice(lines[k].search(re)) : lines[k]);
    if (v != null) return v;
  }
  return null;
}
// editDistance (Abstand zweier Wörter) steht in app.js

/**
 * Abrechnungsmonat. Die Texterkennung liest „für Mai 2025“ oft fehlerhaft („rur November 2025“, „Für Uli 2025“,
 * „Septenber“), daher: Monatsname mit kleinen Lesefehlern, dahinter das Jahr; zur Kontrolle das Druckdatum oben
 * rechts („02.03.2026“, gedruckt im Folgemonat). Nicht sicher erkannt → null (die App fragt dann nach).
 */
function payslipMonth(lines) {
  // Kopf (der Aufrufer gibt die obersten Zeilen jedes Durchgangs)
  const head = lines;
  const hits = [];
  head.forEach((line, li) => {
    const title = /Abrech|Bez[üu]ge|f[üu]r/i.test(line);
    for (const m of line.matchAll(/([A-Za-zÄäÖöÜü]{3,10})[\s_.,|]*((?:\d[\s_]?){4})?/g)) {
      const w = m[1].toLowerCase();
      const short = PAYSLIP_MONTHS_SHORT[w];
      if (short && m[2]) {
        const year = Number(m[2].replace(/\D/g, ''));
        hits.push({ month: short, year: year >= 2015 && year <= 2099 ? year : null, d: 0, title, li });
      }
      PAYSLIP_MONTHS.forEach((name, i) => {
        const max = name.length >= 6 ? 2 : name.length >= 4 ? 1 : 0;
        if (w.length < name.length - 1 || w.length > name.length + max) return;
        const d = editDistance(w, name);
        if (d > max) return;
        const year = m[2] ? Number(m[2].replace(/\D/g, '')) : null;
        // Kurze Monatsnamen (Mai, Juni, Juli) nur mit Jahreszahl dahinter – sonst zu viele Zufallstreffer
        if (!year && name.length < 5) return;
        hits.push({ month: i + 1, year: year >= 2015 && year <= 2099 ? year : null, d, title, li });
      });
    }
  });
  // Beste Fundstelle: mit Jahr, in der Titelzeile, wenigste Lesefehler, weiter oben
  hits.sort((x, y) => !!y.year - !!x.year || y.title - x.title || x.d - y.d || x.li - y.li);
  const byName = hits[0] ? { month: hits[0].month, year: hits[0].year } : null;
  let byDate = null;
  let print = null; // Druckdatum (Monat, Jahr)
  for (const line of head) {
    const dm = line.match(/(?<!\d)([0-3]\d)\s?[.,]\s?([01]\d)\s?[.,]\s?(20\d\d)(?!\d)/);
    if (dm && Number(dm[2]) >= 1 && Number(dm[2]) <= 12) {
      print = { m: Number(dm[2]), y: Number(dm[3]) };
      const d = new Date(print.y, print.m - 2, 1);
      byDate = { month: d.getMonth() + 1, year: d.getFullYear() };
      break;
    }
  }
  const now = new Date();
  const ym = (r) => r.year * 12 + r.month;
  // Abrechnungsmonat liegt nie nach dem Druck und höchstens gut ein Jahr davor (Nachberechnungen) – sonst ist das Jahr
  // verlesen
  const fits = (r) => !print || (ym(r) <= print.y * 12 + print.m && ym(r) >= print.y * 12 + print.m - 14);
  const ok = (r) => r && r.year && r.year >= 2015 && ym(r) <= now.getFullYear() * 12 + now.getMonth() + 1 && fits(r);
  if (byName && byDate && byName.month === byDate.month) return { month: byName.month, year: ok(byName) ? byName.year : byDate.year };
  if (ok(byName)) return byName;
  if (byName && print) {
    // Jahr unlesbar: das letzte, in dem der Monat beim Druck schon begonnen hatte (auch im selben Monat gedruckt)
    const year = byName.month <= print.m ? print.y : print.y - 1;
    if (ok({ month: byName.month, year })) return { month: byName.month, year };
  }
  if (!byName && ok(byDate)) return byDate;
  // Nur der Monat ist sicher: Jahr offen lassen (die App fragt nach)
  if (byName) return { month: byName.month, year: null };
  return null;
}

/** Lohnart einer Zeile: Schlüssel nach Nummer oder Bezeichnung (auch mit Lesefehlern) */
const PS_CODES = { 101: 'arbeit', 118: 'ueber', 140: 'urlaub', 145: 'krank', 146: 'feiertag', 204: 'zulage' };
function payslipLineKind(line) {
  const code = line.match(/^\W{0,4}(\d{3})\b/);
  const label = line.toLowerCase();
  if (/b\s?av|betr\.?\s?av|altersv|umwandl|solidar/.test(label)) return null;
  // Einmalzahlungen (Urlaubs-, Weihnachtsgeld, Zuschuss zum Krankengeld): Betrag ohne Stunden
  if (/urlaubsg|weihn|einmal|krankengeld|zuschuss/.test(label)) return 'zulage';
  if (/[üu]bers?t|berstd/.test(label)) return 'ueber';
  if (/urlaub/.test(label)) return 'urlaub';
  // Entgeltfortzahlung = Lohnfortzahlung im Krankheitsfall
  if (/entgel|fortz|krank|efz/.test(label)) return 'krank';
  if (/feiert/.test(label)) return 'feiertag';
  if (/stundenl|zeitl|grundl/.test(label)) return 'arbeit';
  if (/zulage|pr[äa]mie|zuschlag|pauschale/.test(label)) return 'zulage';
  return code ? PS_CODES[code[1]] || null : null;
}

/** Texte mehrerer Durchgänge werden mit einem Seitenvorschub getrennt aneinandergehängt */
const PS_SEP = '\n\f\n';
/** Lohnart-Nummer am Zeilenanfang („101 Stundenlohn“), auch hinter Störzeichen vom Rand des Fotos („Ir   101 …“) */
const PS_CODE = /^(?:[^\s\d]{1,4}\s+){0,2}\W{0,4}(?:\d\s)?(\d{3})\s+(?=[^\d\s])/;
/** Euro-Beträge mit Vorzeichen („100,00-“ ist ein Abzug) und Stelle in der Zeile */
function moneyTokens(line) {
  // auch mit Leerzeichen als Tausendertrennung („3 360,00“)
  return [...String(line || '').matchAll(/(?<![\d.,])((?:\d{1,3}(?:\.\d{3})+|\d{1,2} \d{3}(?=\s?,)|\d{1,6})\s?,\s?\d{2})(?!\d)(\s?-)?/g)].map((m) => ({
    v: payslipNum(m[1]),
    neg: !!m[2],
    i: m.index,
    end: m.index + m[0].length,
  }));
}
/** Spalten St / SV / GB einer Lohnart („L L J“, „FFN“, „LLJI“): L laufend, S sonstiger Bezug, F frei, P pauschal;
 *  GB J = Teil des Gesamt-Bruttos */
function psFlags(line) {
  const m = [...String(line).matchAll(/(?:^|\s)([LFSPMVE])\s?([LFSP])\s?([JN])(?=[\sIl|.,]|$)/g)].at(-1);
  return m ? { st: m[1], sv: m[2], gb: m[3] } : null;
}
/** Häufigster Wert einer Liste (bei Gleichstand der mit mehr Fundstellen im Text), sonst null */
function psMost(values, seen) {
  const n = new Map();
  for (const v of values) if (v != null && Number.isFinite(v)) n.set(psR2(v), (n.get(psR2(v)) || 0) + 1);
  let best = null;
  for (const [v, c] of n) if (!best || c > best.c || (c === best.c && seen(v) > seen(best.v))) best = { v, c };
  return best ? best.v : null;
}

/**
 * Werte aus dem erkannten Text (ein Durchgang oder mehrere, getrennt durch PS_SEP).
 * hours: Stunden je Art (arbeit, ueber, urlaub, feiertag, krank, sonst), pay: Beträge der Lohnarten,
 * rate: Stundenlohn, zulage: Bezüge ohne Stunden (Zulagen, Prämien, Einmalzahlungen), brutto/steuer/sv/netto
 * (Netto-Verdienst), abschlag (bereits erhalten oder ausbezahlt), bav (Betriebsrente, Netto-Abzug), nettoSonst
 * (weitere Netto-Be-/Abzüge: + Gutschrift, − Abzug), auszahlung, kvZusatz (Zusatzbeitrag der Krankenkasse, %).
 * Für die Prüfungen: otFactor, svParts (KV, RV, AV, PV), head (Stunden oben rechts: zeit, ueber, bez), ytd
 * (Gesamt-Brutto des Jahres), stFrei/svFrei (steuer- bzw. beitragsfreie Teile des Bruttos, z. B. Inflationsprämie).
 * fixed: Werte, die nicht direkt gelesen, sondern aus den übrigen berechnet wurden. Fehlendes bleibt null.
 *
 * Die Texterkennung verliest einzelne Zahlen (Stundenlohn „15,20“ als „15720“ oder „25:20“, fehlende Kommas usw.).
 * Die Abrechnung enthält aber viele Gegenproben, die hier genutzt werden:
 * - Stunden × Stundenlohn (× 1,25 bei Überstunden) = Betrag der Lohnart – der Stundenlohn ist der, mit dem die
 *   meisten Zeilen aufgehen; fehlt in einer Zeile Stunden oder Betrag, folgt es aus dem anderen
 * - Gesamt-Brutto = Summe der Lohnarten mit „J“ in der Spalte GB; Steuer- und SV-Brutto stehen fünfmal da
 * - Steuern = Summe der Spalte „Steuerrechtliche Abzüge“ (mit Nachberechnung „N … 12,34-“)
 * - SV-Abzüge = KV + RV + AV + PV; Netto = Brutto − Steuern − SV; Auszahlung = Netto ± alle Netto-Be-/Abzüge
 * - Jede Zahl, die mehrfach im Text vorkommt (auch in verschiedenen Durchgängen), gilt als bestätigt.
 * opts: { rates: bekannte Stundenlöhne, bav, abschlag (Erwartung, falls unlesbar), otFactor, calc(brutto) → { lohnsteuer, sv } }
 */
function parsePayslipText(text, opts = {}) {
  const passes = String(text)
    .split('\f')
    .map((t) => t.split('\n').map((l) => l.replace(/[|]/g, ' ').trim()).filter(Boolean))
    .filter((p) => p.length);
  const lines = passes.flat();
  const digits = lines.map((l) => l.replace(/\D/g, ''));
  /** Wie oft der Betrag im Text steht (Ziffern ohne Punkt und Komma, mindestens vier Ziffern) */
  const seen = (v) => {
    if (v == null || !(v > 0)) return 0;
    const d = String(Math.round(v * 100));
    if (d.length < 4) return 0;
    return digits.reduce((n, l) => n + (l.split(d).length - 1), 0);
  };
  /** Betrag hinter einem Stichwort, aus jedem Durchgang (gelesene Werte, ohne null) */
  const readAll = (re, ahead = 2) => passes.map((p) => moneyAfter(p, re, ahead)).filter((v) => v != null);
  const otF = opts.otFactor || 1.25;
  const r = {
    year: null,
    month: null,
    rate: null,
    hours: { arbeit: 0, ueber: 0, urlaub: 0, feiertag: 0, krank: 0, sonst: 0 },
    pay: { arbeit: 0, ueber: 0, urlaub: 0, feiertag: 0, krank: 0, sonst: 0 },
    zulage: 0,
    brutto: null,
    steuer: null,
    sv: null,
    netto: null,
    abschlag: 0,
    bav: 0,
    nettoSonst: 0,
    auszahlung: null,
    kvZusatz: null,
    otFactor: otF,
    lines: [],
    svParts: null,
    head: null,
    ytd: null,
    stFrei: 0,
    svFrei: 0,
    fixed: [],
  };
  const fixed = new Set();
  // Monat: aus dem Kopf jedes Durchgangs
  const when = payslipMonth(passes.flatMap((p) => p.slice(0, 14)));
  if (when) Object.assign(r, when);

  // Lohnarten: je Nummer (bzw. Art) alle Lesungen aus allen Durchgängen
  const groups = new Map();
  let bavDeduct = null;
  for (const line of lines) {
    const code = line.match(PS_CODE);
    const flags = psFlags(line);
    if (code && code[1] === '914') bavDeduct = lastMoney(line);
    let kind = payslipLineKind(line);
    // Unbekannte Lohnart mit Nummer, die zum Gesamt-Brutto gehört (z. B. VWL-Zuschuss, Sachbezug): Betrag ohne Stunden
    if (!kind && code && flags && flags.gb === 'J' && !/b\s?av|betr\.?\s?av|altersv|umwandl/i.test(line)) kind = 'zulage';
    if (!kind) continue;
    // Nicht Teil des Gesamt-Bruttos (GB „N“)
    if (flags && flags.gb === 'N') continue;
    const money = moneyTokens(line);
    // Bezeichnung (Buchstaben der ersten Wörter) zum Wiedererkennen in anderen Durchgängen
    const label = line.replace(PS_CODE, '').split(/\s{2,}|\d/)[0].toLowerCase().replace(/[^a-zäöüß]/g, '').slice(0, 14);
    if (kind === 'zulage') {
      // Ohne Nummer und ohne Spalte GB ist es keine Lohnart (Fußnoten „Beitragszuschlag …“, Solidaritätszuschlag)
      if (!code && !flags) continue;
      const last = money.at(-1);
      // Schlüssel mit Art: dieselbe Nummer kann in einem anderen Durchgang als andere Art gelesen sein
      const key = code ? `${code[1]}:${kind}` : `z:${label}`;
      if (!groups.has(key)) groups.set(key, { kind, label, readings: [], flags: null });
      const g = groups.get(key);
      g.flags ||= flags;
      // Betrag mit Minus hinten: Abzug, keine Zulage
      g.readings.push({ amount: last && !last.neg ? last.v : null });
      continue;
    }
    // Betrag mit Minus hinten ist ein Abzug (z. B. unbezahlter Urlaub): zieht Stunden und Betrag von der Arbeit ab
    const minus = money.length && money.at(-1).neg;
    // Zahlen hinter „Std“ (bzw. hinter der Bezeichnung): Menge, Faktor, Prozentsatz, Betrag
    const unit = line.match(/\bS[tli1]d\b\.?/);
    const after = unit ? line.slice(unit.index + unit[0].length) : line.replace(PS_CODE, '').replace(/^[^\d]*/, '');
    const m2 = moneyIn(after);
    const hoursTok = after.match(/^\s*(\d{1,3}\s?,\s?\d{2})(?!\d)/);
    // Prozentsatz der Überstunden („125,00“ bzw. „150,00“), sonst der eingestellte
    const pctTok = kind === 'ueber' ? after.match(/(?<![\d.,])(1[0-9]{2}|200)\s?,\s?00(?!\d)(?=.*\d\s?,\s?\d{2})/) : null;
    const it = {
      pct: kind === 'ueber' ? (pctTok ? Number(pctTok[1]) / 100 : otF) : 1,
      hours: hoursTok ? payslipNum(hoursTok[1]) : null,
      amount: m2.length > (hoursTok ? 1 : 0) ? m2.at(-1) : null,
      raw: [...after.matchAll(/\d[\d.,:;']*\d/g)].map((m) => m[0]),
    };
    // Kopfzeilen oben („Zeitlohn Std.“, „Überstd.“, „Urlaub Std.“) haben keine Lohnart-Nummer und keine Menge davor
    it.quality = (code ? 2 : 0) + (it.hours != null ? 1 : 0) + (it.amount != null ? 1 : 0);
    if (it.quality < 2) continue;
    if (minus) kind = 'abzug';
    const key = code ? `${code[1]}:${kind}` : `k:${kind}`;
    if (!groups.has(key)) groups.set(key, { kind, label, readings: [] });
    groups.get(key).readings.push(it);
  }
  // Dieselbe Lohnart aus verschiedenen Durchgängen mit verlesener Nummer (oder ohne): gleiche Art und ähnliche
  // Bezeichnung → zusammenlegen
  const keys = [...groups.keys()];
  for (let a = 0; a < keys.length; a++)
    for (let b = a + 1; b < keys.length; b++) {
      const ga = groups.get(keys[a]);
      const gb = groups.get(keys[b]);
      if (!ga || !gb || ga.kind !== gb.kind) continue;
      const near = !ga.label || !gb.label || editDistance(ga.label, gb.label) <= Math.max(2, Math.floor(Math.min(ga.label.length, gb.label.length) / 4));
      if (!near) continue;
      ga.readings.push(...gb.readings);
      ga.flags ||= gb.flags;
      groups.delete(keys[b]);
    }
  const hourGroups = [...groups.values()].filter((g) => g.kind !== 'zulage');
  // Stundenlohn: der Wert, mit dem die meisten Zeilen aufgehen
  const quarter = (h) => h > 0 && h < 400 && Math.abs(h * 4 - Math.round(h * 4)) < 0.02;
  const cand = new Set((opts.rates || []).filter((v) => v > 0));
  for (const g of hourGroups)
    for (const it of g.readings) {
      if (it.hours && it.amount) cand.add(psR2(it.amount / (it.hours * it.pct)));
      for (const t of it.raw.slice(it.hours != null ? 1 : 0)) {
        const m = t.replace(/[:;']/g, ',').match(/^(\d{2})[,.](\d{2})$/);
        if (m) cand.add(Number(`${m[1]}.${m[2]}`));
      }
    }
  // Faktor-Spalte mit höchstens einer verlesenen Ziffer („15720“, „157,20“, „25:20“ für 15,20)
  const likeRate = (t, rate) => editDistance(t.replace(/\D/g, ''), String(Math.round(rate * 100))) <= 1;
  let best = null;
  for (const rate of cand) {
    if (!(rate >= 5 && rate <= 100)) continue;
    let score = 0;
    for (const g of hourGroups) {
      // je Lohnart zählt ihre beste Lesung
      let s = 0;
      for (const it of g.readings) {
        let t = 0;
        if (it.hours && it.amount && psNear(psR2(it.hours * rate * it.pct), it.amount)) t += 3;
        else if (it.amount && quarter(it.amount / (rate * it.pct))) t += 1;
        if (it.raw.slice(it.hours != null ? 1 : 0).some((x) => likeRate(x, rate))) t += 1;
        s = Math.max(s, t);
      }
      score += s;
    }
    score += Math.min(2, seen(rate) / 2) + ((opts.rates || []).includes(rate) ? 0.5 : 0);
    if (!best || score > best.score) best = { rate, score };
  }
  if (best && best.score >= 1) r.rate = best.rate;
  const open = []; // Lohnarten, deren Betrag sich nicht lesen ließ (folgt unten aus dem Gesamt-Brutto)
  for (const g of hourGroups) {
    // Lesungen nach Güte; die erste, deren Stunden und Betrag zusammenpassen, gilt
    const rs = [...g.readings].sort((a, b) => b.quality - a.quality);
    let done = null;
    const pct = psMost(rs.map((it) => it.pct), () => 0);
    if (r.rate) {
      const f = r.rate * pct;
      const clean = (it) => (it.amount != null && it.amount < 100 && likeRate(String(it.amount.toFixed(2)), r.rate) ? { ...it, amount: null } : it);
      const list = rs.map(clean);
      done =
        list.find((it) => it.hours && it.amount && psNear(psR2(it.hours * f), it.amount)) ||
        (() => {
          // Betrag aus mehreren Lesungen, der eine glatte Stundenzahl ergibt; sonst Stunden × Stundenlohn
          const am = psMost(list.filter((it) => it.amount && quarter(it.amount / f)).map((it) => it.amount), seen);
          if (am != null) return { hours: Math.round((am / f) * 4) / 4, amount: am };
          const h = psMost(list.filter((it) => it.hours && it.hours < 300).map((it) => it.hours), () => 0);
          return h != null ? { hours: h, amount: psR2(h * f) } : null;
        })();
      if (!done) {
        open.push({ kind: g.kind, pct });
        continue;
      }
    } else done = rs[0];
    if (done.hours == null && done.amount == null) continue;
    const sign = g.kind === 'abzug' ? -1 : 1;
    const kind = g.kind === 'abzug' ? 'arbeit' : g.kind;
    r.lines.push({ kind, hours: sign * (done.hours || 0), f: pct, amount: sign * (done.amount || 0) });
    r.hours[kind] += sign * (done.hours || 0);
    r.pay[kind] = psR2(r.pay[kind] + sign * (done.amount || 0));
  }
  // Bezüge ohne Stunden: je Lohnart der häufigste gelesene Betrag; steuer-/beitragsfreie Teile merken
  let zulage = 0;
  let zulageOpen = false; // Zulagen-Zeile vorhanden, Betrag unlesbar
  for (const g of groups.values()) {
    if (g.kind !== 'zulage') continue;
    const v = psMost(g.readings.map((x) => x.amount), seen);
    if (v == null) {
      zulageOpen = true;
      continue;
    }
    zulage = psR2(zulage + v);
    if (g.flags && /[FP]/.test(g.flags.st)) r.stFrei = psR2(r.stFrei + v);
    if (g.flags && /[FP]/.test(g.flags.sv)) r.svFrei = psR2(r.svFrei + v);
  }
  const zulageKnown = [...groups.values()].some((g) => g.kind === 'zulage');

  // Netto-Be-/Abzüge („9001 bereits erhalten 500,00-“, „aus NB 03/2026 12,34“): je Durchgang der Teil der Zeile hinter
  // der Verdienstbescheinigung (die steht links daneben); je Durchgang Summen von Abschlag, Betriebsrente und Sonstigem
  const nettoPasses = passes
    .map((p) => {
      // Kopf „Netto-Bezüge/Netto-Abzüge“ (nicht der Titel „Brutto/Netto-Bezüge“)
      let start = p.findIndex((l) => /N\S{2,3}o.?Bez\S*\s?\/\s?N|N\S{2,3}o.?Abz/i.test(l));
      // Kopf unlesbar: ab der ersten Zeile mit Nr. 9xxx bzw. „bereits erhalten“
      if (start < 0) start = p.findIndex((l, k) => k > 10 && /(?:^|\s)9\d{3}\s+\S|bereits\s+erh/i.test(l)) - 1;
      if (start < 0) return null;
      const t = { abschlag: 0, bav: 0, sonst: 0, n: 0, items: 0 };
      for (let k = start + 1; k < Math.min(p.length, start + 14); k++) {
        const l = p[k];
        if (/Betrag\s+erh|Auszahlungs|SV.?AG|Gesamtkosten/i.test(l)) break;
        const tok = moneyTokens(l).at(-1);
        // Netto-Posten stehen am Zeilenende; folgt noch Text, ist es ein Wert der Verdienstbescheinigung links
        if (!tok || /[A-Za-zÄÖÜäöü]{2}/.test(l.slice(tok.end))) continue;
        // Bezeichnung: der Text vor dem Betrag, hinter der letzten Zahl der Verdienstbescheinigung (links daneben)
        // bzw. hinter der Nr. 9xxx; Datumsteile wie „01/2025“ gehören zur Bezeichnung
        const pre = l.slice(0, tok.i);
        let cut = 0;
        let nr = null;
        for (const m of pre.matchAll(/(?<![/\d.,])\d[\d.,']*(?![/\d])/g)) {
          if (/^9\d{3}$/.test(m[0])) nr = m[0];
          else if (m[0].replace(/\D/g, '').length >= 3) nr = null;
          else continue;
          cut = m.index + m[0].length;
        }
        const label = pre.slice(cut).trim().toLowerCase();
        // Bezeichnung auch mit Lesefehlern („Altersvorsrge“, „erhalfen“)
        const like = (...ws) => label.split(/[^a-zäöü]+/).some((x) => x.length >= 4 && ws.some((w) => editDistance(x, w) <= (w.length >= 7 ? 2 : 1) || (x.length >= 5 && w.endsWith(x))));
        if (!nr && (!/[a-zäöü]{2}/.test(label) || /^betrag$/.test(label))) continue;
        // Wert der Verdienstbescheinigung mit Komma gelesen („AV-Beitrag 123,45“, „Steuerfreie Bezüge 1.000,00“)
        if (!nr && like('beitrag', 'brutto', 'gesamt', 'steuer', 'lohnsteuer', 'kirchensteuer', 'bezüge', 'bezug', 'steuerfreie', 'auszahlung', 'pfändung', 'darlehen', 'solidaritätszuschlag')) continue;
        t.items++;
        if (nr === '9001' || /bereits|erhalt|ausbez|ausgez/.test(label) || like('bereits', 'erhalten', 'ausbezahlt')) t.abschlag = psR2(t.abschlag + tok.v);
        else if (nr === '9010' || /alter|vorsor|betr\.?\s?av/.test(label) || like('altersvorsorge', 'vorsorge') || (tok.neg && psNear(tok.v, bavDeduct)))
          t.bav = psR2(t.bav + tok.v);
        else {
          t.sonst = psR2(t.sonst + (tok.neg ? -tok.v : tok.v));
          t.n++;
        }
      }
      // Betriebsrente steht sicher in der Lohnart 914: was die Netto-Zeilen (verrutscht) anders zuordnen, ist Abschlag
      if (bavDeduct && t.bav && !psNear(t.bav, bavDeduct) && t.bav > bavDeduct) {
        t.abschlag = psR2(t.abschlag + t.bav - bavDeduct);
        t.bav = bavDeduct;
      }
      return t.items ? t : null;
    })
    .filter(Boolean);
  // Vorläufig: je Teil der häufigste Wert der Durchgänge
  const most = (k) => psMost(nettoPasses.map((t) => t[k]), (x) => seen(Math.abs(x)));
  let abschlag = nettoPasses.length ? most('abschlag') || null : null;
  // Sonstiges: bei Uneinigkeit der Durchgang mit den wenigsten Posten (Lesefehler erfinden eher Posten dazu)
  const fewest = nettoPasses.filter((t) => abschlag == null || psNear(t.abschlag, abschlag)).sort((x, y) => x.n - y.n)[0];
  let sonst = fewest ? fewest.sonst : 0;
  let sonstCount = fewest ? fewest.n : 0;
  // Entgeltumwandlung (Betriebsrente): 914 „Betr.AV.AN lfd.Geh.Ver 100,00-“ bzw. Netto-Abzug „betr. Altersvorsorge“
  const bavLine = nettoPasses.length ? most('bav') || null : null;
  r.bav = bavLine || moneyAfter(lines, /betr\.?\s?Alters|Altersvorsorge/i, 0) || bavDeduct || (/Alters|Betr\.?\s?AV/i.test(text) ? opts.bav || 0 : 0);
  if (abschlag == null) abschlag = moneyAfter(lines, /bereits\s+erh/i, 0);
  r.abschlag = abschlag != null ? abschlag : /bereits/i.test(text) ? opts.abschlag || 0 : 0;

  // Stunden oben rechts („Zeitlohn Std. | Überstd. | Bez. Std.“: 152,00 10,00 162,00) – zur Kontrolle; die Zahlen
  // stehen in der Zeile unter dem Kopf (oder in derselben)
  for (const p of passes) {
    const hk = p.slice(0, 16).findIndex((l) => /Bez(?![a-zäöü])/i.test(l) && /Zeit|lohn|bers/i.test(l));
    if (hk < 0 || r.head) continue;
    for (const l of p.slice(hk, hk + 3)) {
      if (r.head) break;
      const nums = [...l.matchAll(/(?<![\d.,])(\d{1,3})\s?[,.]?\s?(\d{2})(?![\d.,])/g)].map((m) => Number(m[1]) + Number(m[2]) / 100);
      for (let k = 0; k + 1 < nums.length && !r.head; k++) {
        const [a, b, c] = [nums[k], nums[k + 1], nums[k + 2]];
        if (c != null && a >= 20 && a <= 300 && b > 0 && b < 100 && psNear(a + b, c) && quarter(a) && quarter(b)) r.head = { zeit: a, ueber: b, bez: c };
        else if (k + 2 === nums.length && a >= 20 && b >= 40 && b <= 300 && b >= a && quarter(a) && quarter(b)) r.head = { zeit: a, ueber: null, bez: b };
      }
    }
  }

  // Gesamt-Brutto: Kandidaten aus der Summe, dem Etikett und den mehrfach gedruckten Steuer-/SV-Brutto-Werten
  let sumLines = psR2(Object.values(r.pay).reduce((a, b) => a + b, 0));
  const bruttoCand = new Map();
  const addB = (v, w) => v > 0 && bruttoCand.set(psR2(v), (bruttoCand.get(psR2(v)) || 0) + w);
  if (!zulageOpen && !open.length) addB(sumLines + zulage, 2);
  for (const v of readAll(/G.{0,2}sam.{0,2}-?\s?Br/i)) addB(v, 1);
  // Betrags-Spalte allein (Durchgang 3): „LLJ 2.345,60“ – alle Beträge mit J
  for (const p of passes) {
    const js = p.filter((l) => !PS_CODE.test(l) && psFlags(l)?.gb === 'J').map((l) => moneyTokens(l).at(-1)).filter((t) => t && !t.neg);
    if (js.length) addB(js.reduce((a, t) => a + t.v, 0), 1);
  }
  // SV-Zeile „L 3.000,00 3.000,00 3.000,00 3.000,00 258,00 279,00 39,00 Z 72,00 648,00“: ein Betrag viermal (auch mit
  // Störziffer davor oder dahinter: „23.00000“)
  const svLines = [];
  let svD = null;
  const svDs = new Map();
  for (const l of lines) {
    const toks = l.split(/\s+/).map((t) => t.replace(/\D/g, '')).filter((t) => t.length >= 5 && t.length <= 8);
    let rep = null;
    for (const t of toks) {
      if (t.length > 7) continue;
      const c = toks.filter((x) => x.includes(t)).length;
      if (c >= 3 && (!rep || c > rep.c)) rep = { t, c };
    }
    if (rep) {
      svLines.push({ l, d: rep.t });
      svDs.set(rep.t, (svDs.get(rep.t) || 0) + 1);
    }
  }
  if (svDs.size) svD = [...svDs].sort((a, b) => b[1] - a[1])[0][0];
  const svLine = svLines.find((x) => x.d === svD)?.l || null;
  const svBruttoRead = svD ? Number(svD) / 100 : null;
  if (svBruttoRead) addB(svBruttoRead + r.bav + r.svFrei, 1);
  const counts = new Map();
  for (const l of lines) for (const m of l.matchAll(/\d[\d.,]{4,9}\d/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 5 && d.length <= 7) counts.set(d, (counts.get(d) || 0) + 1);
  }
  for (const [d, n] of counts) if (n >= 3 && d !== svD && Number(d) / 100 > Math.max(500, sumLines * 0.5)) addB(Number(d) / 100 + r.bav, 1);
  let brutto = null;
  let bScore = 0;
  for (const [v, w] of bruttoCand) {
    let score = w + seen(v) + seen(psR2(v - r.bav - r.stFrei));
    if (zulageOpen && sumLines > 0 && v > sumLines && v - sumLines - zulage < 2000) score += 0.5;
    if (score > bScore) [brutto, bScore] = [v, score];
  }
  r.brutto = brutto;
  // Genau eine Lohnart unlesbar: ihr Betrag ist der Rest bis zum (bestätigten) Gesamt-Brutto
  if (brutto != null && open.length === 1 && !zulageOpen && r.rate && bScore >= 3) {
    const it = open[0];
    const amount = psR2(brutto - sumLines - zulage);
    const hours = amount / (r.rate * it.pct);
    if (amount > 0 && quarter(hours)) {
      r.hours[it.kind] += Math.round(hours * 4) / 4;
      r.pay[it.kind] = psR2(r.pay[it.kind] + amount);
      r.lines.push({ kind: it.kind, hours: Math.round(hours * 4) / 4, f: it.pct, amount });
      sumLines = psR2(sumLines + amount);
      open.length = 0;
      fixed.add(`hours.${it.kind}`);
    }
  }
  if (brutto != null) {
    const rest = psR2(brutto - sumLines - zulage);
    // Zulage unlesbar (oder ganz ohne Zeile, aber Rest): Rest bis zum Brutto. Lohnarten zusammen mehr als das Brutto:
    // eine Zeile ist falsch gelesen – keine negative „Zulage“ daraus machen
    if ((zulageOpen || (!zulageKnown && rest > 0)) && sumLines > 0 && rest >= 0 && !open.length) {
      zulage = psR2(zulage + rest);
      if (rest > 0) fixed.add('zulage');
    } else if (!psNear(sumLines + zulage, brutto)) fixed.add('brutto');
  }
  r.zulage = zulage;

  // Steuern und Sozialabgaben: gelesene Werte, die mehrfach im Text stehen, sonst berechnet
  const svRead = readAll(/(?<!Steuer)(SV|5V|sv)\W{0,2}\S{0,4}ch?t?l\S*\s+Abz/);
  const svBrutto = svBruttoRead || (brutto != null ? psR2(brutto - r.bav - r.svFrei) : null);
  // Beiträge: Zahlen hinter dem letzten der vier Brutto-Werte (ohne „Z“ für den Kinderlosen-Zuschlag), aus jedem
  // Durchgang (auch mit einer verlesenen Ziffer im Brutto-Wert)
  const partsCand = [];
  for (const { l, d } of svLines) {
    if (d !== svD && editDistance(d, svD) > 1) continue;
    const toks = l.split(/\s+/);
    let last = -1;
    toks.forEach((t, i) => {
      const x = t.replace(/\D/g, '');
      if (x.length >= 5 && (x.includes(d) || x.includes(svD))) last = i;
    });
    const rest = toks.slice(last + 1).filter((t) => /\d/.test(t)).map((t) => Number(t.replace(/\D/g, '')) / 100);
    if (rest.length < 4) continue;
    const parts = rest.slice(0, 4);
    const sum = psR2(parts.reduce((a, b) => a + b, 0));
    if (rest.length <= 5) svRead.push(sum);
    partsCand.push({ parts, sum, ok: rest.length >= 5 && psNear(rest[4], sum) });
    // Störzahl vor den Beiträgen: auch spätere Vierergruppen
    for (let k = 1; k + 4 <= rest.length; k++) {
      const p4 = rest.slice(k, k + 4);
      partsCand.push({ parts: p4, sum: psR2(p4.reduce((a, b) => a + b, 0)), ok: false, late: true });
    }
    const z = psR2(((rest[0] / svBrutto) * 100 - 7.3) * 2);
    if (r.kvZusatz == null && z > 0 && z < 5 && psNear(psR2((svBrutto * (7.3 + z / 2)) / 100), rest[0], 0.02)) r.kvZusatz = z;
  }
  // Mit dem Zusatzbeitrag aus der SV-Zeile rechnen (er ändert sich von Jahr zu Jahr)
  const calc = brutto != null && opts.calc ? opts.calc(brutto, r.kvZusatz, r) : null;
  // 0 ist ein gültiger Wert (kleiner Lohn, Azubi, Steuerklasse III)
  const stRead = [...readAll(/Steuer\s?r.{0,2}ch?t/i), ...readAll(/Lohn.{0,2}teuer/i, 1)].filter((v) => v >= 0);
  // Spalte „Steuerrechtliche Abzüge“: alle Zeilen zwischen den Köpfen des Steuer- und des SV-Teils, mit Vorzeichen
  // (Nachberechnung: „N … 12,34-“)
  for (const p of passes) {
    const a = p.findIndex((l) => /Steuer.?Brutt|Steuer\s?r.{0,2}ch?t/i.test(l));
    if (a < 0) continue;
    const b = p.findIndex((l, k) => k > a && /[KS]V.?Brutt|KV.?Beitr|SV.?r\S*ch?t/i.test(l));
    if (b < 0 || b - a > 7) continue;
    const vals = p.slice(a + 1, b).map((l) => moneyTokens(l).at(-1)).filter(Boolean);
    if (vals.length > 1) stRead.push(psR2(vals.reduce((s, t) => s + (t.neg ? -t.v : t.v), 0)));
  }
  // Steuer-Zeile „L 3.000,00 300,00 … 300,00“: Zahlen hinter dem Steuer-Brutto
  const stLine = svD && lines.find((l) => l.replace(/\D/g, '').split(svD).length === 2 && !/Brutto/i.test(l));
  if (stLine) {
    const toks = stLine.split(/\s+/).filter((t) => /\d{3}/.test(t) && !t.replace(/\D/g, '').includes(svD));
    for (const t of toks) {
      const v = Number(t.replace(/\D/g, '')) / 100;
      if (seen(v) >= 2) stRead.push(v);
    }
  }
  const nettoReads = readAll(/N.tto-?\s?Verd/i);
  const auszReads = readAll(/Auszahlungs/i);
  const nettoFrom = [...nettoReads, ...auszReads.map((v) => psR2(v + r.abschlag + r.bav - sonst))].filter((v) => v > 0);
  if (brutto != null) {
    const stC = [...new Set([...stRead, calc && calc.lohnsteuer].filter((v) => v != null && v >= 0 && v < brutto * 0.45))];
    const svC = new Set(svRead.filter((v) => v > 0));
    if (calc) svC.add(calc.sv);
    for (const st of stC) for (const n of nettoFrom) svC.add(psR2(brutto - st - n));
    // Die Rechnung der App trifft auf den Cent, wenn der Zusatzbeitrag aus der SV-Zeile bekannt ist; sonst nur ungefähr
    const w = r.kvZusatz != null ? 1.5 : 0.5;
    const sup = (v, read, computed) => Math.min(4, seen(v)) + (read.filter((x) => psNear(x, v)).length ? 1 + Math.min(2, read.filter((x) => psNear(x, v)).length - 1) * 0.5 : 0) + (psNear(computed, v) ? w : 0);
    let bestT = null;
    for (const st of stC)
      for (const sv of svC) {
        if (!(sv > brutto * 0.05 && sv < brutto * 0.3)) continue;
        const netto = psR2(brutto - st - sv);
        const score = sup(st, stRead, calc && calc.lohnsteuer) + sup(sv, svRead, calc && calc.sv) + sup(netto, nettoFrom, null) * 1.5;
        if (!bestT || score > bestT.score) bestT = { st, sv, netto, score };
      }
    if (bestT) {
      r.steuer = bestT.st;
      r.sv = bestT.sv;
      if (!stRead.some((x) => psNear(x, bestT.st)) && !psNear(calc && calc.lohnsteuer, bestT.st)) fixed.add('steuer');
      if (!svRead.some((x) => psNear(x, bestT.sv)) && !psNear(calc && calc.sv, bestT.sv)) fixed.add('sv');
    }
  }
  // Beiträge zur Prüfung: die, deren Summe die Sozialabgaben ergibt; sonst die am häufigsten gelesenen
  let pc = partsCand.find((c) => psNear(c.sum, r.sv));
  if (!pc && partsCand.length) {
    // je Beitrag der häufigste Wert der Durchgänge
    const early = partsCand.filter((c) => !c.late);
    const vote = [0, 1, 2, 3].map((i) => psMost(early.map((c) => c.parts[i]), () => 0));
    if (vote.every((v) => v != null)) pc = { parts: vote, sum: psR2(vote.reduce((a, b) => a + b, 0)) };
    // Passt auch das nicht, gilt nur eine in sich stimmige Zeile (Beiträge ergeben die gedruckte Summe) – sonst
    // waren die Beiträge nicht lesbar
    if (pc && !psNear(pc.sum, r.sv)) pc = partsCand.find((c) => c.ok) || null;
  }
  if (pc) r.svParts = pc.parts;

  // Netto und Auszahlung folgen aus den Summen; gelesene Werte bestätigen sie
  if (r.brutto != null && r.steuer != null && r.sv != null) {
    r.netto = psR2(r.brutto - r.steuer - r.sv);
    // Der Durchgang, dessen Netto-Be-/Abzüge genau zur gelesenen Auszahlung führen, gilt
    const fit = nettoPasses
      .map((t) => ({ t, a: psR2(r.netto - t.abschlag - (t.bav || r.bav) + t.sonst) }))
      .map((x) => ({ ...x, votes: auszReads.filter((v) => psNear(v, x.a)).length + (seen(x.a) ? 0.5 : 0) }))
      .filter((x) => x.votes >= 1 && (!x.t.bav || psNear(x.t.bav, r.bav)))
      .sort((x, y) => y.votes - x.votes)[0];
    if (fit) {
      r.abschlag = fit.t.abschlag;
      sonst = fit.t.sonst;
      sonstCount = fit.t.n;
    }
    r.nettoSonst = sonst;
    r.auszahlung = psR2(r.netto - r.abschlag - r.bav + sonst);
    // Gelesene Auszahlung weicht ab: fehlt ein Netto-Be-/Abzug, ist der Unterschied dieser – wenn die Auszahlung in
    // mehreren Durchgängen gleich gelesen wurde oder der Unterschied selbst im Text steht
    const ausz = psMost(auszReads, seen);
    if (ausz != null && !psNear(ausz, r.auszahlung)) {
      const extra = psR2(ausz - r.auszahlung);
      const sure = auszReads.filter((v) => psNear(v, ausz)).length >= 2 || seen(Math.abs(extra));
      if (sure && Math.abs(extra) < r.netto) {
        r.nettoSonst = psR2(sonst + extra);
        r.auszahlung = ausz;
        if ((!seen(Math.abs(extra)) || sonstCount) && !psNear(r.nettoSonst, 0)) fixed.add('nettoSonst');
      }
    }
    if (!nettoReads.some((v) => psNear(v, r.netto)) && !seen(r.netto)) fixed.add('netto');
    if (!auszReads.some((v) => psNear(v, r.auszahlung)) && !seen(r.auszahlung)) fixed.add('auszahlung');
  } else {
    r.netto = psMost(nettoReads, seen) ?? (auszReads.length ? psR2(auszReads[0] + r.abschlag + r.bav - sonst) : null);
    r.nettoSonst = sonst;
    r.auszahlung = psMost(auszReads, seen) ?? (r.netto != null ? psR2(r.netto - r.abschlag - r.bav + sonst) : null);
  }

  // Jahressumme (Verdienstbescheinigung, links unten): „Gesamt-Brutto 12.345,67 | SV-Brutto …“
  const ytds = [];
  for (const l of lines) {
    if (!/G.{0,2}sam.{0,2}-?\s?Br/i.test(l) || !/S\s?V.?Br|Sv-?B/i.test(l)) continue;
    const t = l.slice(l.search(/G.{0,2}sam/i)).match(/(?<![\d.,])(\d{1,3}(?:[.,]?\d{3})*)\s?[,.]?\s?(\d{2})(?![\d])/);
    if (t) ytds.push(Number(t[1].replace(/\D/g, '')) + Number(t[2]) / 100);
  }
  const ytd = psMost(ytds.filter((v) => brutto == null || v >= brutto - 0.01), seen);
  if (ytd != null) r.ytd = ytd;
  r.fixed = [...fixed];
  return r;
}

/**
 * Fehlende Summen aus den übrigen Werten ergänzen (nur leere Felder, gelesene Werte bleiben stehen).
 * Ergänzte Werte stehen in p.fixed (für den Hinweis in der App). Ändert p und gibt es zurück.
 */
function repairPayslip(p) {
  const fixed = new Set(p.fixed || []);
  const set = (key, v) => {
    if (p[key] != null || v == null || !Number.isFinite(v)) return;
    p[key] = psR2(v);
    fixed.add(key);
  };
  if (p.brutto != null && p.steuer != null && p.sv != null) set('netto', p.brutto - p.steuer - p.sv);
  if (p.auszahlung != null) set('netto', p.auszahlung + (p.abschlag || 0) + (p.bav || 0) - (p.nettoSonst || 0));
  if (p.brutto != null && p.netto != null) {
    if (p.steuer != null) set('sv', p.brutto - p.netto - p.steuer);
    if (p.sv != null) set('steuer', p.brutto - p.netto - p.sv);
  }
  if (p.netto != null) set('auszahlung', p.netto - (p.abschlag || 0) - (p.bav || 0) + (p.nettoSonst || 0));
  p.fixed = [...fixed];
  return p;
}
/** Namen der Werte für den Hinweis „Berechnet statt gelesen: …“ */
const PS_FIELD_NAMES = {
  'hours.arbeit': 'Arbeitsstunden',
  'hours.ueber': 'Überstunden',
  'hours.urlaub': 'Urlaub',
  'hours.krank': 'Krankheit',
  'hours.feiertag': 'Feiertage',
  zulage: 'Zulagen',
  brutto: 'Gesamt-Brutto',
  steuer: 'Steuern',
  sv: 'Sozialabgaben',
  netto: 'Netto-Verdienst',
  nettoSonst: 'Weitere Netto-Be-/Abzüge',
  auszahlung: 'Auszahlung',
};
/**
 * Prüfungen einer Abrechnung: [{ key, ok, text }]. Prüfungen, für die Angaben fehlen (ältere Abrechnungen, Zeile nicht
 * lesbar), entfallen. prev: Abrechnung des Vormonats (für die Jahressumme), sonst null.
 */
function payslipChecks(p, prev = null) {
  const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.015;
  const kinds = ['arbeit', 'ueber', 'urlaub', 'krank', 'feiertag'];
  const out = [];
  // ok: true/false, null = ohne Wertung (Angabe nicht lesbar)
  const add = (key, ok, text) => out.push({ key, ok: ok === null ? null : !!ok, text });
  // Stunden × Stundenlohn = Betrag je Lohnart
  // (je gelesener Zeile mit ihrem Prozentsatz; ältere Abrechnungen ohne Zeilen: je Art)
  const rows = p.lines?.length
    ? p.lines
    : kinds.filter((k) => (p.hours?.[k] || 0) > 0 || (p.pay?.[k] || 0) > 0).map((k) => ({ hours: p.hours[k] || 0, f: k === 'ueber' ? p.otFactor || 1.25 : 1, amount: p.pay[k] || 0 }));
  if (p.rate && rows.length) add('stunden', rows.every((x) => near(psR2(x.hours * p.rate * x.f), x.amount)), 'Stunden × Stundenlohn = Beträge');
  // Stunden oben rechts: Überstunden gleich, bezahlte Stunden = alle (bzw. ohne Überstunden, ältere Abrechnungen)
  if (p.head && p.hours) {
    const all = kinds.reduce((t, k) => t + (p.hours[k] || 0), 0);
    add('kopf', (p.head.ueber == null || near(p.head.ueber, p.hours.ueber || 0)) && (near(p.head.bez, all) || near(p.head.bez, all - (p.hours.ueber || 0))), 'Stunden wie oben rechts');
  } else if (p.lines) add('kopf', null, 'Stunden oben rechts nicht lesbar');
  const sumPay = Object.values(p.pay || {}).reduce((a, b) => a + b, 0) + (p.zulage || 0);
  add('brutto', near(psR2(sumPay), p.brutto), 'Lohnarten ergeben das Gesamt-Brutto');
  if (p.svParts) add('sv', near(psR2(p.svParts.reduce((a, b) => a + b, 0)), p.sv), 'KV + RV + AV + PV = Sozialabgaben');
  // Neu eingelesen (mit Zeilen), aber die Beiträge waren nicht lesbar: ohne Wertung anzeigen
  else if (p.lines) add('sv', null, 'KV + RV + AV + PV nicht lesbar');
  add('netto', p.brutto != null && near(psR2(p.brutto - (p.steuer || 0) - (p.sv || 0)), p.netto), 'Brutto − Steuern − Sozialabgaben = Netto');
  add('auszahlung', p.netto != null && near(psR2(p.netto - (p.abschlag || 0) - (p.bav || 0) + (p.nettoSonst || 0)), p.auszahlung), p.nettoSonst ? 'Netto ± Be-/Abzüge = Auszahlung' : 'Netto − Abzüge = Auszahlung');
  // Jahressumme (Verdienstbescheinigung): im Januar = Gesamt-Brutto, sonst Vormonat + Gesamt-Brutto
  if (p.ytd != null && p.brutto != null) {
    if (p.month === 1) add('jahr', near(p.ytd, p.brutto), 'Jahressumme = Gesamt-Brutto');
    else if (prev && prev.ytd != null) add('jahr', near(p.ytd, psR2(prev.ytd + p.brutto)), 'Jahressumme passt zum Vormonat');
  }
  // Monat unlesbar (nur beim Einlesen – danach wird er abgefragt)
  if (!p.month || !p.year) add('monat', false, 'Monat nicht lesbar – wird gleich abgefragt');
  const fixed = (p.fixed || []).filter((k) => PS_FIELD_NAMES[k]);
  add('gelesen', !fixed.length, fixed.length ? `Berechnet statt gelesen: ${fixed.map((k) => PS_FIELD_NAMES[k]).join(', ')}` : 'Alle Werte gelesen');
  return out;
}
/** Alle Prüfungen stimmen */
const payslipAllOk = (p, prev) => payslipChecks(p, prev).every((c) => c.ok !== false);
