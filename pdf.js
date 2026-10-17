'use strict';
// Erzeugt Stundenzettel (A4 hoch) und Reisekostenabrechnung (A4 quer) als einseitige PDFs, ohne externe Bibliothek.
// Schrift: Helvetica (PDF-Standardschrift), Text in WinAnsi-Kodierung (Umlaute, ß, –).

const PDF_W = 595.28;
const PDF_H = 841.89;

const measureCtx = document.createElement('canvas').getContext('2d');
function measureText(text, size, bold) {
  measureCtx.font = `${bold ? 'bold ' : ''}${size}px Helvetica, Arial, sans-serif`;
  return measureCtx.measureText(text).width;
}

// Unicode-Zeichen im Bereich 0x80–0x9F von WinAnsi
const WIN_ANSI = {
  0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87,
  0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91,
  0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
};

/** Text so, wie er ins PDF kommt: zusammengesetzte Zeichen (é statt e + ´), jeder Leerraum als Leerzeichen,
 *  unsichtbare Formatzeichen (Null-Breite, weiches Trennzeichen) weg – sonst würden sie zu „?“ */
const pdfClean = (str) =>
  String(str ?? '')
    .normalize('NFC')
    .replace(/[\p{Cf}\u00ad]/gu, '')
    .replace(/\s/g, ' ');

function pdfString(str) {
  let out = '';
  for (const ch of pdfClean(str)) {
    let c = ch.codePointAt(0);
    if (c > 0xff || (c >= 0x80 && c < 0xa0)) c = WIN_ANSI[c] ?? 0x3f; // '?'
    if (c < 0x20) c = 0x20;
    const s = String.fromCharCode(c);
    out += s === '(' || s === ')' || s === '\\' ? '\\' + s : s;
  }
  return out;
}

/** Zeichen, die die PDF-Schrift nicht kennt und als „?“ druckt (z. B. kyrillische Buchstaben, č, ł) */
function pdfMissingChars(str) {
  const out = new Set();
  for (const ch of pdfClean(str)) {
    const c = ch.codePointAt(0);
    if ((c > 0xff || (c >= 0x80 && c < 0xa0)) && WIN_ANSI[c] == null) out.add(ch);
  }
  return [...out];
}

const num = (v) => (Math.round(v * 100) / 100).toString();
/** Text für Titel/Autor im Info-Wörterbuch: UTF-16 mit BOM (dort gilt nicht WinAnsi) */
const pdfInfoString = (str) =>
  '<FEFF' + [...pdfClean(str)].map((ch) => ch.charCodeAt(0).toString(16).padStart(4, '0') + (ch.length > 1 ? ch.charCodeAt(1).toString(16).padStart(4, '0') : '')).join('') + '>';

class PdfDoc {
  constructor(w = PDF_W, h = PDF_H) {
    this.w = w;
    this.h = h;
    this.ops = [];
  }
  // Koordinaten von oben links (wie am Bildschirm); PDF rechnet von unten links.
  fill(x, y, w, h, gray) {
    this.ops.push(`${num(gray)} g ${num(x)} ${num(this.h - y - h)} ${num(w)} ${num(h)} re f`);
  }
  line(x1, y1, x2, y2, width, gray) {
    this.ops.push(`${num(gray)} G ${num(width)} w ${num(x1)} ${num(this.h - y1)} m ${num(x2)} ${num(this.h - y2)} l S`);
  }
  // Linienzug mit runden Enden (z. B. Unterschrift)
  path(points, width, gray = 0) {
    if (points.length < 2) points = [points[0], [points[0][0] + 0.3, points[0][1]]];
    const segs = points.map(([x, y], i) => `${num(x)} ${num(this.h - y)} ${i ? 'l' : 'm'}`).join(' ');
    this.ops.push(`${num(gray)} G ${num(width)} w 1 J 1 j ${segs} S`);
  }
  text(str, x, baseline, size, bold, gray = 0) {
    this.ops.push(`BT /${bold ? 'F2' : 'F1'} ${num(size)} Tf ${num(gray)} g ${num(x)} ${num(this.h - baseline)} Td (${pdfString(str)}) Tj ET`);
  }
  // Einzeiliger Text in einer Box: wird bei Bedarf verkleinert und notfalls gekürzt.
  textBox(str, x, y, w, h, size, bold, align = 'left', gray = 0) {
    let t = pdfClean(str).trim();
    if (!t) return;
    let s = size;
    let tw = measureText(t, s, bold);
    if (tw > w) {
      s = Math.max(5, (s * w) / tw);
      tw = measureText(t, s, bold);
      // genau auf die Breite verkleinert, misst der Text durch Rundung teils minimal mehr – das passt noch
      while (tw > w + 0.05 && t.length > 1) {
        t = t.slice(0, -2).trimEnd() + '…';
        tw = measureText(t, s, bold);
      }
    }
    const tx = align === 'right' ? x + w - tw : align === 'center' ? x + (w - tw) / 2 : x;
    this.text(t, tx, y + h / 2 + s * 0.35, s, bold, gray);
  }
  // Großer, fetter, zentrierter Text; mehrere Wörter werden bei Bedarf auf eigene Zeilen verteilt.
  labelBox(str, x, y, w, h, size) {
    const oneLine = measureText(str, size, true) <= w;
    const lines = oneLine ? [str] : str.split(/\s+/);
    let s = size;
    while (s > 6 && (lines.some((l) => measureText(l, s, true) > w) || lines.length * s * 1.2 > h)) s -= 0.5;
    const lineH = s * 1.2;
    const top = y + (h - lines.length * lineH) / 2;
    lines.forEach((l, i) => this.textBox(l, x, top + i * lineH, w, lineH, s, true, 'center'));
  }
  output(info) {
    const content = this.ops.join('\n');
    const objects = [
      '<< /Type /Catalog /Pages 2 0 R >>',
      '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.w)} ${num(this.h)}] /Resources << /Font << /F1 4 0 R /F2 5 0 R >> >> /Contents 6 0 R >>`,
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
      '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>',
      `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
      `<< /Title ${pdfInfoString(info.title)} /Author ${pdfInfoString(info.author)} /Producer (Std-Protokoll) >>`,
    ];
    let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
    const offsets = [];
    objects.forEach((o, i) => {
      offsets.push(out.length);
      out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    out += offsets.map((o) => String(o).padStart(10, '0') + ' 00000 n \n').join('');
    out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 7 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 0xff;
    return new Blob([bytes], { type: 'application/pdf' });
  }
}

/**
 * @param sheet Stundenzettel
 * @param overtimeTarget Soll-Stunden des Zettels (sheetTarget: anteilig bei Teilwochen)
 */
function buildTimesheetPdf(sheet, overtimeTarget) {
  const doc = new PdfDoc();
  const left = 36;
  const right = PDF_W - 36;
  const width = right - left;
  const fractions = [0.105, 0.09, 0.09, 0.075, 0.07, 0.19, 0.275, 0.105];
  const xs = [left];
  fractions.forEach((f) => xs.push(xs[xs.length - 1] + f * width));
  xs[xs.length - 1] = right;

  const BLACK = 0;
  const GREY_TEXT = 0.55;

  // Kopf
  doc.textBox('Stundenzettel', left, 38, width, 22, 16, true, 'center');
  const valueX = left + 95;
  doc.textBox('Name:', left, 70, 90, 14, 10, true);
  doc.textBox(sheet.name, valueX, 70, right - valueX, 14, 10, true);
  doc.textBox('Woche von:', left, 92, 90, 14, 10, true);
  doc.textBox(fmtShort(sheetFirstDate(sheet)), valueX, 92, 80, 14, 10, true);
  doc.textBox('Bis:', valueX + 95, 92, 30, 14, 10, true);
  doc.textBox(fmtShort(sheetLastDate(sheet)), valueX + 130, 92, 80, 14, 10, true);

  // Größen so wählen, dass die Tabelle die Seite füllt
  const tableTop = 118;
  const headerH = 26;
  const footerH = 78;
  const bottom = PDF_H - 36 - footerH;
  // Wie ein Tag im PDF erscheint – an einer Stelle für Zeilenzahl, Höhen und Zeichnen:
  // Sa/So steht ein Feiertag nicht im PDF (der Tag wie ein normaler Arbeitstag), außer von Hand gesetzt
  const pdfStatus = (d, i) => (sheetIsActive(sheet, i) && (i < 5 || d.manual) ? d.status : null);
  const pdfHolidayWork = (d, i) => !!pdfStatus(d, i) && holidayWork(d);
  // Mo–Fr mindestens 5 Zeilen, Sa/So mindestens 1; Krankheit/Urlaub usw. nur die Mindestzeilen;
  // Feiertag mit Arbeit (Notdienst): eine Zeile „Feiertag“, darunter die Arbeitszeilen
  const rowsOnPdf = (d, i) =>
    !sheetIsActive(sheet, i)
      ? pdfMinRows(i)
      : pdfHolidayWork(d, i)
        ? Math.max(d.rows.length + 1, pdfMinRows(i))
        : pdfStatus(d, i)
          ? pdfMinRows(i)
          : Math.max(d.rows.length, pdfMinRows(i));
  const rowCount = sheet.days.reduce((n, d, i) => n + rowsOnPdf(d, i), 0);
  const avail = bottom - tableTop - headerH;
  const siteW = xs[6] - xs[5] - 6;
  const workW = xs[7] - xs[6] - 6;

  // Baustelle / Art der Arbeit: überall dieselbe Schriftgröße. Braucht ein Eintrag mehr als eine normale Zeile,
  // wird seine Zeile höher (höchstens drei Textzeilen, sonst eine Stufe kleiner) und die übrigen werden niedriger.
  // Reicht der Platz so nicht (viele lange Einträge), wird alles zusammen kleiner, bis die Woche auf die Seite passt.
  const layout = (base) => {
    const fs = Math.max(4, Math.min(9.5, base * 0.48));
    const TEXT = Math.min(fs, (base - 3) / 2.3);
    const SMALL = TEXT * 0.85;
    const fitText = (text, w) => {
      const t = String(text ?? '').trim();
      if (!t) return { size: TEXT, lines: [] };
      for (const size of [TEXT, SMALL]) {
        const lines = wrapLines(t, w, size);
        if (lines.length <= 3) return { size, lines };
      }
      let size = SMALL;
      let lines = wrapLines(t, w, size);
      while (size > 3 && lines.length > 3) lines = wrapLines(t, w, (size -= 0.25));
      return { size, lines: lines.slice(0, 3) };
    };
    const texts = new Map(); // Zeile → { site, work }
    for (const d of sheet.days) for (const r of d.rows) texts.set(r, { site: fitText(r.site, siteW), work: fitText(r.work, workW) });
    const textH = (r) => {
      const { site, work } = texts.get(r);
      return Math.max(site.lines.length * site.size, work.lines.length * work.size) * 1.12 + 4;
    };
    // Höhe je Zeile des Tages bei Zeilenhöhe rowH (Arbeitszeilen am Feiertag beginnen eine Zeile tiefer)
    const heightsOf = (day, i, rowH) => {
      const hs = Array(rowsOnPdf(day, i)).fill(rowH);
      if (!sheetIsActive(sheet, i) || (pdfStatus(day, i) && !pdfHolidayWork(day, i))) return hs;
      const off = pdfHolidayWork(day, i) ? 1 : 0;
      day.rows.forEach((r, k) => (hs[k + off] = Math.max(rowH, textH(r))));
      return hs;
    };
    const used = (rowH) => sheet.days.reduce((t, d, i) => t + heightsOf(d, i, rowH).reduce((a, b) => a + b, 0), 0);
    // Größte Zeilenhöhe (höchstens base), bei der alles passt – used() wächst mit rowH
    let lo = 0;
    let hi = base;
    if (used(hi) > avail) for (let k = 0; k < 30; k++) used((lo + hi) / 2) <= avail ? (lo = (lo + hi) / 2) : (hi = (lo + hi) / 2);
    else lo = hi;
    // Eine Zeile braucht Platz für Tag/Uhrzeit (fs) – sonst ist der Maßstab zu groß
    return { fs, texts, rowH: lo, heightsOf: (day, i) => heightsOf(day, i, lo), ok: lo >= fs * 1.2 + 1 };
  };
  // Größter Maßstab, bei dem eine normale Zeile noch Platz für Tag und Uhrzeit hat
  const full = Math.min(28, avail / Math.max(rowCount, 1));
  let L = layout(full);
  if (!L.ok) {
    let lo = 4;
    let hi = full;
    let best = layout(lo);
    for (let k = 0; k < 14; k++) {
      const mid = (lo + hi) / 2;
      const m = layout(mid);
      if (m.ok) (best = m), (lo = mid);
      else hi = mid;
    }
    L = best;
  }
  const { fs, texts, rowH, heightsOf } = L;

  // Tabellenkopf
  doc.fill(left, tableTop, width, headerH, 0.75);
  const headers = ['Tag', 'Arbeits-\nbeginn', 'Arbeits-\nende', 'Stunden', 'Pause', 'Baustelle', 'Art der Arbeit', 'Stunden\nGesamt'];
  headers.forEach((h, i) => {
    const lines = h.split('\n');
    lines.forEach((l, li) => {
      doc.textBox(l, xs[i] + 3, tableTop + 3 + li * 10, xs[i + 1] - xs[i] - 6, 10, 8.5, true);
    });
  });

  // Tage
  const textCols = [
    { c: 1, align: 'right' },
    { c: 2, align: 'right' },
    { c: 3, align: 'right' },
    { c: 5, align: 'left' },
    { c: 6, align: 'left' },
  ];
  /** Vorbereiteter Text (fitText) senkrecht mittig in der Zelle */
  const drawText = ({ size, lines }, x, y, w, h) => {
    const lineH = size * 1.12;
    const top = y + Math.max(1, (h - lines.length * lineH) / 2);
    lines.forEach((l, i) => doc.textBox(l, x, top + i * lineH, w, lineH, size, false, 'left'));
  };
  let y = tableTop + headerH;
  const dayTops = [];
  sheet.days.forEach((day, i) => {
    const hs = heightsOf(day, i);
    const tops = hs.map((_, k) => y + hs.slice(0, k).reduce((a, b) => a + b, 0));
    const h = hs.reduce((a, b) => a + b, 0);
    const active = sheetIsActive(sheet, i);
    const status = pdfStatus(day, i);
    const hw = pdfHolidayWork(day, i);
    dayTops.push(y);

    doc.fill(xs[0], y, xs[1] - xs[0], h, 0.87);
    if (!active) doc.fill(xs[1], y, right - xs[1], h, 0.93);

    for (let r = 1; r < hs.length; r++) {
      for (const { c } of textCols) {
        if (status && !hw && c === 5) continue; // Spalte „Baustelle“ bleibt für den Text frei
        doc.line(xs[c], tops[r], xs[c + 1], tops[r], 0.4, 0.78);
      }
    }

    doc.textBox(WEEKDAYS[i], xs[0] + 3, y, xs[1] - xs[0] - 6, rowH, fs, true, 'left', active ? BLACK : GREY_TEXT);

    if (status && !hw) {
      doc.labelBox(DAY_STATUS_SHORT[status], xs[5] + 4, y, xs[6] - xs[5] - 8, h, Math.min(14, Math.max(fs + 3, h * 0.3)));
      doc.textBox(fmtHours(dayTotal(day, i)), xs[7] + 3, y, xs[8] - xs[7] - 6, rowH, fs, false, 'right');
    } else if (active) {
      if (hw) {
        doc.textBox(fmtHours(dayCredit(day, i)), xs[3] + 3, y, xs[4] - xs[3] - 6, rowH, fs, false, 'right');
        doc.textBox(DAY_STATUS_SHORT[status], xs[5] + 3, y, xs[6] - xs[5] - 6, rowH, fs, true);
      }
      day.rows.forEach((row, r) => {
        const k = hw ? r + 1 : r;
        const ry = tops[k];
        const cell = (c, text, align) => doc.textBox(text, xs[c] + 3, ry, xs[c + 1] - xs[c] - 6, rowH, fs, false, align);
        if (row.start != null) cell(1, fmtTime(row.start), 'right');
        if (row.end != null) cell(2, fmtTime(row.end), 'right');
        const m = rowMinutes(row);
        if (m != null) cell(3, fmtHours(m), 'right');
        drawText(texts.get(row).site, xs[5] + 3, ry, siteW, hs[k]);
        drawText(texts.get(row).work, xs[6] + 3, ry, workW, hs[k]);
      });
      const first = (c, text) => doc.textBox(text, xs[c] + 3, y, xs[c + 1] - xs[c] - 6, rowH, fs, false, 'right');
      if (day.pause != null && (day.pause > 0 || dayHasTimes(day))) {
        // Pause gehört zur Arbeit: am Feiertag in die erste Arbeitszeile
        doc.textBox(fmtHours(day.pause), xs[4] + 3, hw ? tops[1] : y, xs[5] - xs[4] - 6, rowH, fs, false, 'right');
      }
      first(7, fmtHours(dayTotal(day, i)));
    }
    y += h;
  });
  const tableBottom = y;

  // Linien
  doc.line(left, tableTop, right, tableTop, 0.8, BLACK);
  doc.line(left, tableTop + headerH, right, tableTop + headerH, 0.8, BLACK);
  dayTops.slice(1).forEach((t) => doc.line(left, t, right, t, 0.8, BLACK));
  doc.line(left, tableBottom, right, tableBottom, 0.8, BLACK);
  xs.forEach((x) => doc.line(x, tableTop, x, tableBottom, 0.6, BLACK));

  // Summen: Stunden (ohne Überstunden), Überstunden; darunter abgesetzt „Stunden Gesamt“ mit Strich und grau hinterlegt
  const total = sheetTotal(sheet);
  const sumRow = (label, value, y, bold) => {
    doc.textBox(label, xs[5], y, xs[7] - xs[5] - 6, 14, 10, bold, 'right');
    doc.textBox(value, xs[7] + 3, y, xs[8] - xs[7] - 6, 14, 10, bold, 'right');
  };
  let fy = tableBottom + 8;
  const over = sheetOvertime(sheet, overtimeTarget);
  sumRow('Stunden:', fmtHours(total - over), fy, false);
  fy += 16;
  sumRow('Überstunden:', fmtHours(over), fy, false);
  fy += 21;
  doc.fill(xs[6] + 20, fy - 2, right - xs[6] - 20, 18, 0.87);
  doc.line(xs[6] + 20, fy - 2, right, fy - 2, 0.8, BLACK);
  fy += 0.5;
  sumRow('Stunden Gesamt:', fmtHours(total), fy, true);

  return doc.output({ title: sheetTitle(sheet), author: sheet.name });
}

/** Text in Zeilen umbrechen, die in die Breite passen; Zeilenumbrüche im Text bleiben erhalten.
 *  Ein Wort, das allein nicht passt, wird nach „-“, „/“, „,“ oder „.“ getrennt, sonst mitten im Wort */
function wrapLines(text, w, size) {
  const fits = (t) => measureText(t, size, false) <= w;
  /** Zu langes Wort in Stücke, die einzeln passen */
  const pieces = (word) => {
    const out = [];
    let cur = '';
    for (const part of word.match(/[^-/,.]*[-/,.]|[^-/,.]+/g)) {
      if (fits(cur + part)) cur += part;
      else {
        if (cur) out.push(cur);
        cur = '';
        for (const ch of part) {
          if (cur && !fits(cur + ch)) {
            out.push(cur);
            cur = '';
          }
          cur += ch;
        }
      }
    }
    if (cur) out.push(cur);
    return out;
  };
  const lines = [];
  for (const para of String(text ?? '').split('\n')) {
    const words = para.trim().split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (fits(next)) line = next;
      else if (fits(word)) {
        if (line) lines.push(line);
        line = word;
      } else {
        // Anfang des langen Wortes noch in die angefangene Zeile, falls Platz
        const ps = pieces(word);
        if (line && fits(`${line} ${ps[0]}`)) line = `${line} ${ps.shift()}`;
        if (line) lines.push(line);
        line = ps.pop() || '';
        lines.push(...ps);
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

/**
 * Reisekostenabrechnung nach dem Formular des Arbeitgebers (A4 quer).
 * @param t { name, from, to, rows: [{ date, start, end, minutes, places, works, meal }], total, place, signDate, signature, title }
 */
function buildTravelPdf(t) {
  const W = 841.89;
  const H = 595.28;
  const doc = new PdfDoc(W, H);
  const L = 30;
  const R = W - 30;
  const width = R - L;
  const money = (v) => v.toFixed(2).replace('.', ',');
  const clock = (m) => (m === 1440 ? '24:00' : fmtTime(m));
  const hours = (m) => String(Math.round((m / 60) * 100) / 100).replace('.', ',');

  // Kopf: Felder mit Linie zum Ausfüllen
  const lineField = (label, x, y, w, labelW, value) => {
    doc.textBox(label, x, y, labelW, 14, 8, false);
    doc.line(x + labelW, y + 14, x + w, y + 14, 0.5, 0);
    if (value) doc.textBox(value, x + labelW + 4, y - 1, w - labelW - 8, 14, 10.5, false);
  };
  doc.textBox('Reisekostenabrechnung', L, 22, 300, 28, 21, true);
  lineField('Nr.', L + 312, 32, 100, 16);
  lineField('vom', L + 428, 32, 120, 22, t.from);
  lineField('bis', L + 562, 32, 110, 16, t.to);
  lineField('Kostenstelle', L + 688, 32, width - 688, 48);
  lineField('Name', L, 60, 330, 30, t.name);
  lineField('Bank', L + 346, 60, 230, 24);
  lineField('BIC', L + 592, 60, width - 592, 20);
  lineField('Anschrift', L, 82, 330, 40);
  lineField('IBAN', L + 346, 82, width - 346, 24);

  // Spalten wie im Formular
  const parts = [70, 90, 505, 45, 130, 140, 140, 140, 65, 150, 160];
  const xs = [L];
  parts.forEach((p) => xs.push(xs.at(-1) + (p / 1635) * width));
  xs[xs.length - 1] = R;
  const colW = (c) => xs[c + 1] - xs[c];
  const headers = [
    'Datum',
    'Reise-\nBeginn/\nEnde\nUhr',
    'Reiseanlass und Reiseweg\n(besuchte Orte angeben,\nOrt der Übernachtung unterstreichen)',
    'Std.',
    'Verpflegung',
    'Übernachtung\n(ohne\nFrühstück)',
    'Fahrtkosten',
    'Neben-\nkosten',
    'Beleg-\nNr.',
    'Summe',
    'Vorsteuer',
  ];

  const tableTop = 108;
  const headerH = 40;
  const sumRowH = 15;
  const bottomRowH = 22;
  const blockTop = H - 26 - 3 * bottomRowH;
  const sumTop = blockTop - 4 * sumRowH - 6;
  const bodyTop = tableTop + headerH;

  // Wie im Formular: doppelt hohe Zeilen; nur „Beginn/Ende“ und „Reiseanlass“ sind in zwei halbe Zeilen geteilt.
  // Ein Tag belegt genau eine Doppelzeile: oben die Reiseorte, unten die Tätigkeiten, je Kasten bis zu zwei Zeilen.
  // Braucht ein Kasten zwei Zeilen, gilt die kleinere Schrift für die ganze Abrechnung. Nichts läuft in den nächsten
  // Tag weiter (die App begrenzt die Textlänge); nur zu lange übernommene Texte werden in ihrem Kasten verkleinert.
  // Darunter eine ungeteilte Schlusszeile.
  const textW = colW(2) - 8;
  const pairCount = Math.max(7, t.rows.length) + 1;
  const rowH = (sumTop - bodyTop) / (pairCount * 2);
  const pairH = 2 * rowH;
  const bodyBottom = bodyTop + pairCount * pairH;
  const boxTexts = t.rows.flatMap((r) => [r.places || '', r.works || ''].map((x) => x.trim()));
  let fs = Math.min(9, rowH / 1.25);
  if (boxTexts.some((x) => wrapLines(x, textW, fs).length > 1)) fs = Math.min(fs, rowH / 2.3);

  headers.forEach((h, c) => {
    const lines = h.split('\n');
    const lh = 8.2;
    const top = tableTop + (headerH - lines.length * lh) / 2;
    lines.forEach((l, i) => doc.textBox(l, xs[c] + 2, top + i * lh, colW(c) - 4, lh, 7, false, 'center'));
  });

  // Einträge
  const cell = (c, y, h, text, align = 'right') => {
    const padX = c === 3 ? 1.5 : 4; // schmale Spalte „Std.“
    doc.textBox(text, xs[c] + padX, y, colW(c) - 2 * padX, h, fs, false, align);
  };
  /** Ein Kasten „Reiseanlass“: bis zu zwei Zeilen, senkrecht mittig */
  const textBoxCell = (text, y) => {
    if (!text) return;
    let size = fs;
    let lines = wrapLines(text, textW, size);
    while (lines.length > 2 && size > 4) lines = wrapLines(text, textW, (size -= 0.25));
    lines = lines.slice(0, 2);
    const lh = size * 1.15;
    lines.forEach((l, i) =>
      doc.textBox(l, xs[2] + 4, y + (rowH - lines.length * lh) / 2 + i * lh, textW, lh, size, false, 'left')
    );
  };
  t.rows.forEach((r, k) => {
    const y = bodyTop + k * pairH;
    cell(0, y, pairH, fmtDayMonth(r.date), 'center');
    if (r.start != null) cell(1, y, rowH, clock(r.start), 'center');
    if (r.end != null) cell(1, y + rowH, rowH, clock(r.end), 'center');
    textBoxCell((r.places || '').trim(), y);
    textBoxCell((r.works || '').trim(), y + rowH);
    if (r.minutes != null) cell(3, y, pairH, hours(r.minutes), 'center');
    if (r.meal) {
      cell(4, y, pairH, money(r.meal));
      cell(9, y, pairH, money(r.meal));
    }
  });

  // Tabellenlinien
  doc.line(L, tableTop, R, tableTop, 0.9, 0);
  doc.line(L, bodyTop, R, bodyTop, 0.9, 0);
  for (let i = 0; i < pairCount; i++) {
    const y = bodyTop + i * pairH;
    if (i > 0) doc.line(L, y, R, y, 0.5, 0.35);
    if (i < pairCount - 1) doc.line(xs[1], y + rowH, xs[3], y + rowH, 0.35, 0.55);
  }
  doc.line(L, bodyBottom, R, bodyBottom, 1.6, 0);
  xs.forEach((x, c) => doc.line(x, tableTop, x, bodyBottom, c === 9 || c === 10 ? 1.2 : 0.6, 0));

  // Summenzeilen unter der Tabelle
  const sums = [
    ['Summe ', 'ohne', ' Vorsteuerabzug', true],
    ['Summe ', 'mit', ' Vorsteuerabzug', false],
    ['Summe ', 'ohne', ' Vorsteuerabzug (Übertrag Fahrtkosten Rückseite)', true],
    ['Summe ', 'mit', ' Vorsteuerabzug (Übertrag Fahrtkosten Rückseite)', false],
  ];
  sums.forEach(([a, b, c, noTax], i) => {
    const y = sumTop + 6 + i * sumRowH;
    const label = a + b + c;
    const lw = measureText(label, 8, false);
    const lx = xs[3] - 8 - lw;
    doc.text(label, lx, y + sumRowH / 2 + 2.8, 8);
    // „ohne“ / „mit“ unterstrichen wie im Formular
    const ux = lx + measureText(a, 8, false);
    doc.line(ux, y + sumRowH / 2 + 4, ux + measureText(b, 8, false), y + sumRowH / 2 + 4, 0.4, 0);
    doc.textBox('+', xs[8] + 4, y, colW(8) - 8, sumRowH, 8, false, 'right');
    if (noTax) doc.textBox('—', xs[10] + 4, y, colW(10) - 8, sumRowH, 8, false, 'center');
    const from = i < 2 ? 3 : 9;
    doc.line(xs[from], y + sumRowH, R, y + sumRowH, 0.5, 0);
  });
  for (let c = 3; c <= 11; c++) {
    if (c > 3 && c < 9) doc.line(xs[c], sumTop + 6, xs[c], sumTop + 6 + 2 * sumRowH, 0.5, 0);
    else if (c >= 9) doc.line(xs[c], sumTop + 6, xs[c], blockTop, c === 9 || c === 10 ? 1.2 : 0.6, 0);
  }
  doc.line(xs[3], sumTop + 6, xs[3], sumTop + 6 + 2 * sumRowH, 0.5, 0);

  // Unterer Block: Prüfvermerke, Ort/Datum, Unterschrift und Gesamtsumme
  const leftEnd = xs[7];
  const yA = blockTop;
  const yB = yA + bottomRowH;
  const yC = yB + bottomRowH;
  const yEnd = yC + bottomRowH;
  doc.line(L, yA, R, yA, 0.9, 0);
  [yB, yC].forEach((y) => doc.line(L, y, R, y, 0.5, 0));
  doc.line(L, yEnd, R, yEnd, 0.9, 0);
  doc.line(L, yA, L, yEnd, 0.6, 0);
  doc.line(leftEnd, yA, leftEnd, yEnd, 0.6, 0);
  const small = (text, x, y, w) => text.split('\n').forEach((l, i, all) =>
    doc.textBox(l, x, y + (bottomRowH - all.length * 8.5) / 2 + i * 8.5, w, 8.5, 7.5, false));

  // Zeile A: geprüft | Zahlungsanweisung | gebucht
  const aw = leftEnd - L;
  const a1 = L + aw * 0.38;
  const a2 = L + aw * 0.69;
  doc.line(a1, yA, a1, yB, 0.5, 0);
  doc.line(a2, yA, a2, yB, 0.5, 0);
  small('geprüft', L + 4, yA, 60);
  small('Zahlungs-\nanweisung', a1 + 4, yA, 60);
  small('gebucht', a2 + 4, yA, 60);

  // Zeile B: Ort, Datum | Abrechnung erstellt/Betrag erhalten
  const bSplit = xs[4];
  doc.line(bSplit, yB, bSplit, yEnd, 0.5, 0);
  small('Ort, Datum', L + 4, yB, 50);
  const placeDate = [t.place, t.signDate].filter(Boolean).join(', ');
  doc.textBox(placeDate, L + 58, yB, bSplit - L - 62, bottomRowH, 10.5, false);
  small('Abrechnung erstellt/\nBetrag erhalten', bSplit + 4, yB, leftEnd - bSplit - 8);

  // Zeile C: Unterschrift (aus den Einstellungen, sonst leer)
  small('Unterschrift', L + 4, yC, 50);
  if (t.signature && t.signature.strokes && t.signature.strokes.length) {
    const boxX = L + 58;
    const boxW = Math.min(bSplit - boxX - 8, 221);
    const boxH = (bottomRowH + 10) * 1.3;
    const ratio = t.signature.ratio || 0.35;
    const scale = Math.min(boxW, boxH / ratio);
    // Die Linie im Unterschriftenfeld liegt bei 76 % der Höhe (.sig-line in styles.css) und kommt knapp über die Unterkante der Zeile
    const top = yEnd - 2 - 0.76 * ratio * scale;
    for (const stroke of t.signature.strokes) {
      doc.path(stroke.map(([x, y]) => [boxX + x * scale, top + y * ratio * scale]), 1.1, 0.1);
    }
  }

  // Rechte Seite: Gesamtsumme, Vorschuss, Aus-/Rückzahlung
  [
    ['Gesamtsumme', '=', yA, money(t.total)],
    ['Vorschuss', '–', yB, ''],
    ['Aus-/\nRückzahlung', '=', yC, ''],
  ].forEach(([label, sign, y, value]) => {
    small(label, xs[7] + 4, y, xs[8] - xs[7] - 8);
    doc.textBox(sign, xs[8] + 4, y, colW(8) - 8, bottomRowH, 9, false, 'right');
    if (value) doc.textBox(value, xs[9] + 4, y, colW(9) - 8, bottomRowH, 10, true, 'right');
  });
  doc.line(xs[8], yA, xs[8], yEnd, 0.5, 0);

  return doc.output({ title: t.title, author: t.name });
}
