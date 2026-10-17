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
 * Foto für die Texterkennung aufbereiten. Durchgang 1: lange Seite 3400 px, Graustufen und örtliche Schwelle
 * (jeder Bildpunkt wird mit der Helligkeit seiner Umgebung verglichen – gleicht Schatten, Knicke und ungleiches Licht
 * aus). Durchgang 2: 2400 px, nur Graustufen und etwas Kontrast. An 17 echten Abrechnungen getestet: Durchgang 1 liest
 * alle richtig, beide zusammen ebenso; die Fehler der Durchgänge liegen an verschiedenen Stellen.
 */
async function payslipCanvas(file, pass = 1) {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const f = Math.min(1, (pass === 1 ? 3400 : 2400) / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * f);
  c.height = Math.round(bmp.height * f);
  const ctx = c.getContext('2d', { willReadFrequently: pass === 1 });
  ctx.filter = 'grayscale(1) contrast(1.15)';
  ctx.drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close && bmp.close();
  if (pass === 1) {
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
    const r = Math.round(Math.max(w, h) / 80);
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

/** Text einer Lohnabrechnung erkennen (Durchgang 1 oder 2, siehe payslipCanvas); onProgress(0…1) */
async function recognizePayslip(file, pass, onProgress = () => {}) {
  await loadTesseract();
  const canvas = await payslipCanvas(file, pass);
  const worker = await Tesseract.createWorker('deu', 1, {
    logger: (m) => m.status === 'recognizing text' && onProgress(m.progress),
  });
  try {
    // Seite als ein Textblock lesen: so bleiben die Zeilen der Lohnarten zusammen
    await worker.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
    const { data } = await worker.recognize(canvas);
    return data.text;
  } finally {
    worker.terminate();
  }
}

/** „1.234,50“ / „500 ,00“ → 1234.5 */
const payslipNum = (s) => parseFloat(String(s).replace(/\s+/g, '').replace(/\./g, '').replace(',', '.'));
const psR2 = (v) => Math.round(v * 100 + (v >= 0 ? 1e-6 : -1e-6)) / 100;
const psNear = (a, b, tol = 0.011) => a != null && b != null && Math.abs(a - b) < tol;
/** Euro-Beträge einer Zeile („2.345,60“, auch „500 ,00-“) */
function moneyIn(line) {
  return [...String(line || '').matchAll(/(\d{1,3}(?:\.\d{3})*\s?,\s?\d{2})(?!\d)/g)].map((m) => payslipNum(m[1]));
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
  const head = lines.slice(0, 10);
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
  for (const line of head) {
    const dm = line.match(/(?<!\d)([0-3]\d)\s?[.,]\s?([01]\d)\s?[.,]\s?(20\d\d)(?!\d)/);
    if (dm && Number(dm[2]) >= 1 && Number(dm[2]) <= 12) {
      const d = new Date(Number(dm[3]), Number(dm[2]) - 2, 1);
      byDate = { month: d.getMonth() + 1, year: d.getFullYear() };
      break;
    }
  }
  const now = new Date();
  const ok = (r) => r && r.year && r.year >= 2015 && r.year * 12 + r.month <= now.getFullYear() * 12 + now.getMonth() + 1;
  if (byName && byDate && byName.month === byDate.month) return { month: byName.month, year: ok(byName) ? byName.year : byDate.year };
  if (ok(byName)) return byName;
  if (byName && byDate) {
    const year = byName.month <= byDate.month ? byDate.year : byDate.year - 1;
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
  if (/b\s?av|betr\.?\s?av|altersv/.test(label)) return null;
  if (/[üu]bers?t|berstd/.test(label)) return 'ueber';
  if (/urlaub/.test(label)) return 'urlaub';
  // Entgeltfortzahlung = Lohnfortzahlung im Krankheitsfall
  if (/entgel|fortz|krank|efz/.test(label)) return 'krank';
  if (/feiert/.test(label)) return 'feiertag';
  if (/stundenl|zeitl|grundl/.test(label)) return 'arbeit';
  if (/zulage|pr[äa]mie|zuschlag|pauschale/.test(label)) return 'zulage';
  return code ? PS_CODES[code[1]] || null : null;
}

/**
 * Werte aus dem erkannten Text.
 * hours: Stunden je Art (arbeit, ueber, urlaub, feiertag, krank, sonst), pay: Beträge der Lohnarten,
 * rate: Stundenlohn, zulage: Zulagen ohne Stunden, brutto/steuer/sv/netto (Netto-Verdienst), abschlag (bereits
 * erhalten), bav (Betriebsrente, Netto-Abzug), nettoSonst (weitere Netto-Be-/Abzüge, z. B. Verrechnung einer
 * Nachberechnung: + Gutschrift, − Abzug), auszahlung, kvZusatz (Zusatzbeitrag der Krankenkasse, %).
 * fixed: Werte, die nicht direkt gelesen, sondern aus den übrigen berechnet wurden. Fehlendes bleibt null.
 *
 * Die Texterkennung verliest einzelne Zahlen (Stundenlohn „18,40“ als „18740“ oder „28:40“, fehlende Kommas usw.).
 * Die Abrechnung enthält aber viele Gegenproben, die hier genutzt werden:
 * - Stunden × Stundenlohn (× 1,25 bei Überstunden) = Betrag der Lohnart – der Stundenlohn ist der, mit dem die
 *   meisten Zeilen aufgehen; fehlt in einer Zeile Stunden oder Betrag, folgt es aus dem anderen
 * - Gesamt-Brutto = Summe der Lohnarten; Steuer- und SV-Brutto (fünfmal gedruckt) = Gesamt-Brutto − Entgeltumwandlung
 * - SV-Abzüge = KV + RV + AV + PV; Netto = Brutto − Steuern − SV; Auszahlung = Netto − Abschlag − Betriebsrente
 *   ± weitere Netto-Be-/Abzüge (die Differenz zur gelesenen Auszahlung zählt nur, wenn der Betrag im Text steht)
 * - Jede Zahl, die mehrfach im Text vorkommt, gilt als bestätigt.
 * opts: { rates: bekannte Stundenlöhne, bav, abschlag (Erwartung, falls unlesbar), calc(brutto) → { lohnsteuer, sv } }
 */
function parsePayslipText(text, opts = {}) {
  const lines = String(text).split('\n').map((l) => l.replace(/[|]/g, ' ').trim()).filter(Boolean);
  const digits = lines.map((l) => l.replace(/\D/g, ''));
  /** Wie oft der Betrag im Text steht (Ziffern ohne Punkt und Komma, mindestens vier Ziffern) */
  const seen = (v) => {
    if (v == null || !(v > 0)) return 0;
    const d = String(Math.round(v * 100));
    if (d.length < 4) return 0;
    return digits.reduce((n, l) => n + (l.split(d).length - 1), 0);
  };
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
    fixed: [],
  };
  const fixed = new Set();
  const when = payslipMonth(lines);
  if (when) Object.assign(r, when);

  // Lohnarten
  const items = [];
  let zulage = null;
  let zulageLine = false; // Zeile mit Zulage/Prämie vorhanden (auch wenn ihr Betrag unlesbar ist)
  let bavDeduct = null;
  for (const line of lines) {
    const code = line.match(/^\W{0,4}(?:\d\s)?(\d{3})\s/);
    if (code && code[1] === '914') bavDeduct = lastMoney(line);
    const kind = payslipLineKind(line);
    if (!kind) continue;
    if (kind === 'zulage') {
      zulageLine = true;
      if ((zulage == null || code) && !/\d,\d{2}\s?-\s*$/.test(line) && lastMoney(line) != null) zulage = lastMoney(line);
      continue;
    }
    // Zahlen hinter „Std“ (bzw. hinter der Bezeichnung): Menge, Faktor, Prozentsatz, Betrag
    const unit = line.match(/\bS[tli1]d\b\.?/);
    const after = unit ? line.slice(unit.index + unit[0].length) : line.replace(/^\W{0,4}(?:\d\s)?\d{3}\s/, '').replace(/^[^\d]*/, '');
    const money = moneyIn(after);
    const hoursTok = after.match(/^\s*(\d{1,3}\s?,\s?\d{2})(?!\d)/);
    const it = {
      kind,
      pct: kind === 'ueber' ? opts.otFactor || 1.25 : 1,
      hours: hoursTok ? payslipNum(hoursTok[1]) : null,
      amount: money.length > (hoursTok ? 1 : 0) ? money.at(-1) : null,
      raw: [...after.matchAll(/\d[\d.,:;']*\d/g)].map((m) => m[0]),
    };
    // Kopfzeilen oben („Zeitlohn Std.“, „Überstd.“, „Urlaub Std.“) haben keine Lohnart-Nummer und keine Menge davor
    it.quality = (code ? 2 : 0) + (it.hours != null ? 1 : 0) + (it.amount != null ? 1 : 0);
    if (it.quality >= 2) items.push(it);
  }
  // Je Art die am besten gelesene Zeile
  const lineItems = Object.values(
    items.reduce((m, it) => ((!m[it.kind] || it.quality > m[it.kind].quality) && (m[it.kind] = it), m), {})
  );
  // Stundenlohn: der Wert, mit dem die meisten Zeilen aufgehen
  const quarter = (h) => h > 0 && h < 400 && Math.abs(h * 4 - Math.round(h * 4)) < 0.02;
  const cand = new Set((opts.rates || []).filter((v) => v > 0));
  for (const it of lineItems) {
    if (it.hours && it.amount) cand.add(psR2(it.amount / (it.hours * it.pct)));
    for (const t of it.raw.slice(it.hours != null ? 1 : 0)) {
      const m = t.replace(/[:;']/g, ',').match(/^(\d{2})[,.](\d{2})$/);
      if (m) cand.add(Number(`${m[1]}.${m[2]}`));
    }
  }
  // Faktor-Spalte mit höchstens einer verlesenen Ziffer („18740“, „178,40“, „28:40“ für 18,40)
  const likeRate = (t, rate) => editDistance(t.replace(/\D/g, ''), String(Math.round(rate * 100))) <= 1;
  let best = null;
  for (const rate of cand) {
    if (!(rate >= 10 && rate <= 100)) continue;
    let score = 0;
    for (const it of lineItems) {
      if (it.hours && it.amount && psNear(psR2(it.hours * rate * it.pct), it.amount)) score += 3;
      else if (it.amount && quarter(it.amount / (rate * it.pct))) score += 1;
      if (it.raw.slice(it.hours != null ? 1 : 0).some((t) => likeRate(t, rate))) score += 1;
    }
    score += Math.min(2, seen(rate) / 2) + ((opts.rates || []).includes(rate) ? 0.5 : 0);
    if (!best || score > best.score) best = { rate, score };
  }
  if (best && best.score >= 1) r.rate = best.rate;
  const open = []; // Zeilen, deren Betrag sich nicht lesen ließ (folgt unten aus dem Gesamt-Brutto)
  for (const it of lineItems) {
    let { hours, amount } = it;
    if (r.rate) {
      const f = r.rate * it.pct;
      if (amount != null && amount < 100 && likeRate(String(amount.toFixed(2)), r.rate)) amount = null;
      if (hours && amount && psNear(psR2(hours * f), amount)) {
        /* passt */
      } else if (amount && quarter(amount / f)) hours = Math.round((amount / f) * 4) / 4;
      else if (hours && hours < 300) amount = psR2(hours * f);
      else {
        open.push(it);
        continue;
      }
    }
    if (hours == null && amount == null) continue;
    r.hours[it.kind] += hours || 0;
    r.pay[it.kind] = psR2(r.pay[it.kind] + (amount || 0));
  }

  // Entgeltumwandlung (Betriebsrente): 914 „Betr.AV.AN lfd.Geh.Ver 100,00-“ bzw. Netto-Abzug „betr. Altersvorsorge“
  const bavLine = moneyAfter(lines, /betr\.?\s?Alters|Altersvorsorge/i, 0);
  r.bav = bavLine || bavDeduct || (/Alters|Betr\.?\s?AV/i.test(text) ? opts.bav || 0 : 0);
  const abschlag = moneyAfter(lines, /bereits\s+erh/i, 0);
  r.abschlag = abschlag != null ? abschlag : /bereits|erhalten/i.test(text) ? opts.abschlag || 0 : 0;

  // Zulage: gelesen; fehlt sie, folgt sie unten aus dem Gesamt-Brutto
  let sumLines = psR2(Object.values(r.pay).reduce((a, b) => a + b, 0));
  // Gesamt-Brutto: Kandidaten aus der Summe, dem Etikett und den mehrfach gedruckten Steuer-/SV-Brutto-Werten
  const bruttoCand = new Map();
  const addB = (v, w) => v > 0 && bruttoCand.set(psR2(v), (bruttoCand.get(psR2(v)) || 0) + w);
  if (zulage != null) addB(sumLines + zulage, 2);
  addB(moneyAfter(lines, /G.{0,2}sam.{0,2}-?\s?Br/i), 1);
  const counts = new Map();
  for (const l of lines) for (const m of l.matchAll(/\d[\d.,]{4,9}\d/g)) {
    const d = m[0].replace(/\D/g, '');
    if (d.length >= 5 && d.length <= 7) counts.set(d, (counts.get(d) || 0) + 1);
  }
  for (const [d, n] of counts) if (n >= 3 && Number(d) / 100 > Math.max(500, sumLines * 0.5)) addB(Number(d) / 100 + r.bav, 1);
  let brutto = null;
  let bScore = 0;
  for (const [v, w] of bruttoCand) {
    let score = w + seen(v) + seen(psR2(v - r.bav));
    if (zulage == null && sumLines > 0 && v > sumLines && v - sumLines < 2000) score += 0.5;
    if (score > bScore) [brutto, bScore] = [v, score];
  }
  r.brutto = brutto;
  // Genau eine Lohnart unlesbar: ihr Betrag ist der Rest bis zum (bestätigten) Gesamt-Brutto. Ohne jede Zulagen-Zeile
  // gilt die Zulage als 0 – sonst würde der Rest still zur „Zulage“ statt zu den Stunden der unlesbaren Zeile
  const knownZulage = zulage ?? (zulageLine ? null : 0);
  if (brutto != null && open.length === 1 && knownZulage != null && r.rate && bScore >= 3) {
    const it = open[0];
    const amount = psR2(brutto - sumLines - knownZulage);
    const hours = amount / (r.rate * it.pct);
    if (amount > 0 && quarter(hours)) {
      zulage = knownZulage;
      r.hours[it.kind] += Math.round(hours * 4) / 4;
      r.pay[it.kind] = psR2(r.pay[it.kind] + amount);
      sumLines = psR2(sumLines + amount);
      fixed.add(`hours.${it.kind}`);
    }
  }
  if (brutto != null) {
    if (zulage == null && sumLines > 0) {
      zulage = psR2(brutto - sumLines);
      if (zulage > 0) fixed.add('zulage');
    }
    if (zulage != null && !psNear(sumLines + zulage, brutto)) {
      // Summe passt nicht: eine Lohnart fehlt oder ist falsch gelesen
      fixed.add('brutto');
    }
  }
  r.zulage = zulage || 0;

  // Steuern und Sozialabgaben: gelesene Werte, die mehrfach im Text stehen, sonst berechnet
  // SV-Zeile „L 3.000,00 … 258,00 279,00 39,00 Z 72,00 648,00“: vier Beiträge und die Summe
  const svRead = [moneyAfter(lines, /(?<!Steuer)(SV|5V|sv)\W{0,2}\S{0,4}ch?t?l\S*\s+Abz/)];
  const svBrutto = brutto != null ? psR2(brutto - r.bav) : null;
  const svD = svBrutto ? String(Math.round(svBrutto * 100)) : null;
  const svLine = svD && lines.find((l) => l.replace(/\D/g, '').split(svD).length > 3);
  if (svLine) {
    // Beiträge: Zahlen hinter den vier Brutto-Werten (ohne „Z“ für den Kinderlosen-Zuschlag)
    const rest = svLine.split(/\s+/).filter((t) => /\d/.test(t) && !t.replace(/\D/g, '').includes(svD)).map((t) => Number(t.replace(/\D/g, '')) / 100);
    if (rest.length === 4 || rest.length === 5) svRead.push(psR2(rest[0] + rest[1] + rest[2] + rest[3]));
    const z = rest.length ? psR2(((rest[0] / svBrutto) * 100 - 7.3) * 2) : 0;
    if (z > 0 && z < 5 && psNear(psR2((svBrutto * (7.3 + z / 2)) / 100), rest[0], 0.02)) r.kvZusatz = z;
  }
  // Mit dem Zusatzbeitrag aus der SV-Zeile rechnen (er ändert sich von Jahr zu Jahr)
  const calc = brutto != null && opts.calc ? opts.calc(brutto, r.kvZusatz) : null;
  // Steuern, Sozialabgaben und Netto gemeinsam wählen: Brutto − Steuern − SV = Netto muss aufgehen; jeder Wert zählt,
  // je öfter er im Text steht, unter seinem Etikett gelesen wurde oder zur Rechnung der App passt
  const stRead = [moneyAfter(lines, /Steuer\s?r.{0,2}ch?t/i), moneyAfter(lines, /Lohn.{0,2}teuer/i, 1)].filter((v) => v > 0);
  // Steuer-Zeile „L 3.000,00 300,00 … 300,00“: Zahlen hinter dem Steuer-Brutto
  const stLine = svD && lines.find((l) => l.replace(/\D/g, '').split(svD).length === 2 && !/Brutto/i.test(l));
  if (stLine) {
    const toks = stLine.split(/\s+/).filter((t) => /\d{3}/.test(t) && !t.replace(/\D/g, '').includes(svD));
    for (const t of toks) {
      const v = Number(t.replace(/\D/g, '')) / 100;
      if (seen(v) >= 2) stRead.push(v);
    }
  }
  const nettoRead = moneyAfter(lines, /N.tto-?\s?Verd/i);
  const auszRead = moneyAfter(lines, /Auszahlungs/i);
  const nettoFrom = [nettoRead, auszRead != null ? psR2(auszRead + r.abschlag + r.bav) : null].filter((v) => v > 0);
  if (brutto != null) {
    const stC = [...new Set([...stRead, calc && calc.lohnsteuer].filter((v) => v > 0 && v < brutto * 0.45))];
    const svC = new Set(svRead.filter((v) => v > 0));
    if (calc) svC.add(calc.sv);
    for (const st of stC) for (const n of nettoFrom) svC.add(psR2(brutto - st - n));
    // Die Rechnung der App trifft auf den Cent, wenn der Zusatzbeitrag aus der SV-Zeile bekannt ist; sonst nur ungefähr
    const w = r.kvZusatz != null ? 1.5 : 0.5;
    const sup = (v, read, computed) => seen(v) + (read.some((x) => psNear(x, v)) ? 1 : 0) + (psNear(computed, v) ? w : 0);
    let bestT = null;
    for (const st of stC)
      for (const sv of svC) {
        if (!(sv > brutto * 0.1 && sv < brutto * 0.3)) continue;
        const netto = psR2(brutto - st - sv);
        const score = sup(st, stRead, calc && calc.lohnsteuer) + sup(sv, svRead, calc && calc.sv) + sup(netto, nettoFrom, null) * 1.5;
        if (!bestT || score > bestT.score) bestT = { st, sv, netto, score };
      }
    if (bestT) {
      r.steuer = bestT.st;
      r.sv = bestT.sv;
      if (!(stRead.some((x) => psNear(x, bestT.st)) && seen(bestT.st) >= 2) && !psNear(calc && calc.lohnsteuer, bestT.st)) fixed.add('steuer');
      if (!(svRead.some((x) => psNear(x, bestT.sv)) && seen(bestT.sv) >= 1) && !psNear(calc && calc.sv, bestT.sv)) fixed.add('sv');
    }
  }

  // Netto und Auszahlung folgen aus den Summen; gelesene Werte bestätigen sie
  if (r.brutto != null && r.steuer != null && r.sv != null) {
    r.netto = psR2(r.brutto - r.steuer - r.sv);
    r.auszahlung = psR2(r.netto - r.abschlag - r.bav);
    // Weitere Netto-Be-/Abzüge (z. B. „aus NB 01/2025 10,33“): Unterschied zur gelesenen Auszahlung, wenn er im Text steht
    const extra = auszRead != null ? psR2(auszRead - r.auszahlung) : 0;
    if (Math.abs(extra) >= 0.01 && seen(Math.abs(extra))) {
      r.nettoSonst = extra;
      r.auszahlung = auszRead;
    }
    if (!psNear(nettoRead, r.netto) && !seen(r.netto)) fixed.add('netto');
    if (!psNear(auszRead, r.auszahlung) && !seen(r.auszahlung)) fixed.add('auszahlung');
  } else {
    r.netto = nettoRead ?? (auszRead != null ? psR2(auszRead + r.abschlag + r.bav) : null);
    r.auszahlung = auszRead ?? (r.netto != null ? psR2(r.netto - r.abschlag - r.bav) : null);
  }
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
/** Plausibilität: Lohnarten ergeben das Gesamt-Brutto, Netto − Abzüge ergibt die Auszahlung */
function payslipChecks(p) {
  const sumPay = Object.values(p.pay || {}).reduce((a, b) => a + b, 0) + (p.zulage || 0);
  const near = (a, b) => a != null && b != null && Math.abs(a - b) < 0.02;
  return {
    brutto: near(Math.round(sumPay * 100) / 100, p.brutto),
    netto: near(p.brutto - (p.steuer || 0) - (p.sv || 0), p.netto),
    auszahlung: near(p.netto - (p.abschlag || 0) - (p.bav || 0) + (p.nettoSonst || 0), p.auszahlung),
  };
}
