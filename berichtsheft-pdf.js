'use strict';
// Berichtsheft-PDF: die leeren Seiten der HWK-Vordrucke (berichtsheft-vorlagen.js) unverändert als Hintergrund,
// darauf nur die Einträge an den Stellen der Formularfelder. Mehrseitig, mit Bildern (JPEG) und Unterschriften.

const bhB64 = (s) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

class BhPdf {
  constructor() {
    this.pages = []; // { tpl, ops: [], images: [{ name, obj }] }
    this.images = []; // { bytes, w, h }
  }
  page(tpl) {
    const p = { tpl, ops: [], imgs: [] };
    this.pages.push(p);
    this.cur = p;
    return this;
  }
  // Koordinaten wie im PDF (unten links), passend zu den Feld-Rechtecken der Vorlage
  text(str, x, y, size, bold = false) {
    this.cur.ops.push(`BT /${bold ? 'BH2' : 'BH1'} ${num(size)} Tf 0 g ${num(x)} ${num(y)} Td (${pdfString(str)}) Tj ET`);
  }
  /** Einzeiliger Eintrag in einem Feld wie im Formular (Schrift wird nur verkleinert, wenn der Text nicht passt) */
  field(f, str, opts = {}) {
    let t = String(str ?? '').trim();
    if (!t || !f) return;
    const [x1, y1, x2, y2] = f.r;
    const bold = opts.bold ?? f.bold;
    const center = opts.center ?? f.center;
    const w = x2 - x1 - 4;
    let s = opts.size ?? f.size;
    let tw = measureText(t, s, bold);
    if (tw > w) {
      s = Math.max(5, (s * w) / tw);
      tw = measureText(t, s, bold);
    }
    // passt auch klein nicht: kürzen statt über das Feld hinaus zu schreiben
    if (tw > w) {
      while (t.length > 1 && measureText(`${t}…`, s, bold) > w) t = t.slice(0, -1);
      t = `${t.trimEnd()}…`;
      tw = measureText(t, s, bold);
    }
    const x = center ? x1 + (x2 - x1 - tw) / 2 : x1 + 2;
    this.text(t, x, y1 + (y2 - y1 - s * 0.7) / 2, s, bold);
  }
  /** Mehrzeiliger Text oben links im Feld; wird verkleinert, bis er hineinpasst. Ergebnis: true = passt */
  block(f, str, size) {
    const t = String(str ?? '').replace(/\s+$/, '');
    if (!t || !f) return true;
    const [x1, y1, x2, y2] = f.r;
    const w = x2 - x1 - 8;
    let s = size;
    let lines = wrapText(t, w, s);
    while (lines.length * s * 1.17 > y2 - y1 - 6 && s > 6) {
      s -= 0.5;
      lines = wrapText(t, w, s);
    }
    lines.forEach((l, i) => l && this.text(l, x1 + 4, y2 - 3 - s * 0.95 - i * s * 1.17, s));
    return lines.length * s * 1.17 <= y2 - y1 - 6;
  }
  /** Bild (JPEG) eingepasst und mittig im Rechteck */
  image(jpeg, w, h, rect) {
    const [x1, y1, x2, y2] = rect;
    const k = Math.min((x2 - x1) / w, (y2 - y1) / h);
    const dw = w * k;
    const dh = h * k;
    const name = `BI${this.images.length}`;
    this.images.push({ bytes: jpeg, w, h });
    this.cur.imgs.push([name, this.images.length - 1]);
    this.cur.ops.push(`q ${num(dw)} 0 0 ${num(dh)} ${num(x1 + (x2 - x1 - dw) / 2)} ${num(y1 + (y2 - y1 - dh) / 2)} cm /${name} Do Q`);
  }
  /** Unterschrift (Striche 0…1) in ein Rechteck einpassen, unten links ausgerichtet */
  signature(sig, rect) {
    if (!sig?.strokes?.length) return;
    const [x1, y1, x2, y2] = rect;
    const ratio = sig.ratio || 0.35;
    const k = Math.min(x2 - x1, (y2 - y1) / ratio);
    const ops = sig.strokes
      .map((st) => {
        const pts = st.length < 2 ? [st[0], [st[0][0] + 0.003, st[0][1]]] : st;
        return pts.map(([x, y], i) => `${num(x1 + x * k)} ${num(y1 + (1 - y) * ratio * k)} ${i ? 'l' : 'm'}`).join(' ');
      })
      .join(' ');
    this.cur.ops.push(`q 0.1 0.1 0.35 RG 0.9 w 1 J 1 j ${ops} S Q`);
  }
  output(info) {
    const enc = (s) => {
      const b = new Uint8Array(s.length);
      for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 0xff;
      return b;
    };
    // Objektnummern: 1 Katalog, 2 Seitenbaum, 3/4 Schriften, 5 Info, danach Vorlagen, Bilder, Seiten
    const tplBase = 6;
    const tplCount = BH_TPL.objs.length;
    const imgBase = tplBase + tplCount;
    const pageBase = imgBase + this.images.length;
    const ref = (n) => `${n} 0 R`;
    const objs = [];
    objs[1] = enc(`<< /Type /Catalog /Pages 2 0 R >>`);
    const kids = this.pages.map((_, i) => ref(pageBase + i * 2)).join(' ');
    objs[2] = enc(`<< /Type /Pages /Kids [${kids}] /Count ${this.pages.length} >>`);
    objs[3] = enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
    objs[4] = enc('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
    objs[5] = enc(`<< /Title (${pdfString(info.title)}) /Author (${pdfString(info.author)}) /Producer (Std-Protokoll) >>`);
    const stream = (dict, bytes) => {
      const head = enc(`${dict.slice(0, -2)} /Length ${bytes.length} >>\nstream\n`);
      const tail = enc('\nendstream');
      const b = new Uint8Array(head.length + bytes.length + tail.length);
      b.set(head);
      b.set(bytes, head.length);
      b.set(tail, head.length + bytes.length);
      return b;
    };
    BH_TPL.objs.forEach((o, i) => {
      const d = o.d.replace(/@(\d+)@/g, (_, n) => ref(tplBase + Number(n)));
      objs[tplBase + i] = o.s ? stream(d, bhB64(o.s)) : enc(d);
    });
    this.images.forEach((im, i) => {
      objs[imgBase + i] = stream(
        `<< /Type /XObject /Subtype /Image /Width ${im.w} /Height ${im.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode >>`,
        im.bytes
      );
    });
    this.pages.forEach((p, i) => {
      const n = pageBase + i * 2;
      const xo = [`/Tpl ${ref(tplBase + BH_TPL.pages[p.tpl])}`, ...p.imgs.map(([name, k]) => `/${name} ${ref(imgBase + k)}`)].join(' ');
      objs[n] = enc(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.304 841.89] /Resources << /Font << /BH1 3 0 R /BH2 4 0 R >> /XObject << ${xo} >> >> /Contents ${ref(n + 1)} >>`
      );
      objs[n + 1] = stream('<< >>', enc(`q /Tpl Do Q\n${p.ops.join('\n')}`));
    });
    const parts = [enc('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n')];
    let pos = parts[0].length;
    const offsets = [];
    for (let i = 1; i < objs.length; i++) {
      offsets[i] = pos;
      const head = enc(`${i} 0 obj\n`);
      const tail = enc('\nendobj\n');
      parts.push(head, objs[i], tail);
      pos += head.length + objs[i].length + tail.length;
    }
    let xref = `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let i = 1; i < objs.length; i++) xref += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
    xref += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${pos}\n%%EOF\n`;
    parts.push(enc(xref));
    return new Blob(parts, { type: 'application/pdf' });
  }
}

/** Text auf Breite umbrechen (Absätze bleiben erhalten, leere Zeilen auch) */
function wrapText(text, width, size, bold = false) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const next = line + w;
      if (line.trim() && measureText(next.trimEnd(), size, bold) > width) {
        out.push(line.trimEnd());
        line = w.trimStart();
      } else line = next;
      // einzelnes überlanges Wort hart trennen
      while (measureText(line, size, bold) > width && line.length > 1) {
        let k = line.length - 1;
        while (k > 1 && measureText(line.slice(0, k), size, bold) > width) k--;
        out.push(line.slice(0, k));
        line = line.slice(k);
      }
    }
    out.push(line.trimEnd());
  }
  return out;
}

// ───────── Seiten des Berichtshefts ─────────

/** „Name, Vorname“ wie auf Deckblatt und Vorblatt */
const bhFullName = (p) => [p.name, p.vorname].filter(Boolean).join(', ');

const bhField = (list, name) => list.find((f) => f.n === name);
/** Felder einer Spalte (gleiches x) von oben nach unten */
const bhColumn = (list, x) => list.filter((f) => Math.abs(f.r[0] - x) < 1).sort((a, b) => b.r[1] - a.r[1]);
// Unterschriftsfelder unten: Auszubildender, Erziehungsberechtigter, Ausbilder (Spalten wie im Vordruck)
const BH_SIG_COLS = [[42, 196], [201, 369], [374, 553]];

function bhDeckblatt(doc, monthly, p) {
  const F = monthly ? BH_FIELDS.deckM : BH_FIELDS.deck;
  doc.page(monthly ? 'deckM' : 'deckW');
  doc.field(bhField(F, 'Textfeld 4'), bhFullName(p));
  doc.field(bhField(F, 'Textfeld 4_2'), p.beruf);
  doc.field(bhField(F, 'Textfeld 4_3'), p.betrieb);
}

function bhVorblatt(doc, monthly, p, heftNr) {
  const F = monthly ? BH_FIELDS.vorM : BH_FIELDS.vor;
  doc.page(monthly ? 'vorM' : 'vorW');
  const vals = {
    'Textfeld 4_4': bhFullName(p),
    'Textfeld 4_13': p.geboren,
    'Textfeld 4_5': p.wohnort,
    'Textfeld 4_6': p.strasse,
    'Textfeld 4_7': p.beruf,
    'Textfeld 4_8': p.fachrichtung,
    'Textfeld 4_9': p.betrieb,
    'Textfeld 4_12': p.beginn,
    'Textfeld 4_10': p.ende,
    'Textfeld 4_11': heftNr,
  };
  for (const [n, v] of Object.entries(vals)) doc.field(bhField(F, n), v);
  doc.page(monthly ? 'erlM' : 'erlW');
}

/** Kopf der Wochen- und Monatsseiten */
function bhHead(doc, F, h) {
  doc.field(bhField(F, 'Textfeld 6'), h.name);
  doc.field(bhField(F, 'Textfeld 6_2'), h.vorname);
  doc.field(bhField(F, 'Textfeld 6_3'), h.beruf);
  doc.field(bhField(F, 'Textfeld 6_4'), h.abteilung);
  doc.field(bhField(F, 'Textfeld 6_5'), h.von);
  doc.field(bhField(F, 'Textfeld 6_6'), h.bis);
  doc.field(bhField(F, 'Textfeld 6_7'), h.jahr);
}

/** Unterschriften und „Abgezeichnet am“ (sigs: [{ sig, date }] für Azubi, Erziehungsberechtigte, Ausbilder) */
function bhSigns(doc, dateFields, sigs, lineY) {
  const dates = [...dateFields].sort((a, b) => a.r[0] - b.r[0]);
  (sigs || []).forEach((s, i) => {
    if (!s) return;
    const [x1, x2] = BH_SIG_COLS[i];
    if (s.sig) doc.signature(s.sig, [x1 + 4, lineY - 2, x2 - 30, lineY + 27]);
    doc.field(dates[i], s.date);
  });
}

/** Wochenseite. w = { nr, head, days: [{ lines: [{ t, h }] (bis 5), total }] × 6 (Mo–Sa), sigs } */
function bhWeekPage(doc, w) {
  const F = BH_FIELDS.woche;
  doc.page('woche');
  doc.field(bhField(F, 'Textfeld 4_14'), w.nr);
  bhHead(doc, F, w.head);
  const lines = bhColumn(F, 76.2);
  const einzel = bhColumn(F, 490.2);
  const totals = F.filter((f) => f.r[0] > 520).sort((a, b) => b.r[1] - a.r[1]);
  const width = lines[0].r[2] - lines[0].r[0] - 4;
  w.days.forEach((d, i) => {
    if (!d) return;
    // Zu lange Zeilen laufen in die nächsten freien Zeilen weiter (Einzelstunden bleiben bei der ersten);
    // reicht der Platz dafür nicht, werden sie im Feld verkleinert bzw. gekürzt
    const rows = d.lines.flatMap((l) => wrapText(l.t, width, 8).map((t, n) => ({ t, h: n ? '' : l.h })));
    (rows.length <= 5 ? rows : d.lines.slice(0, 5)).forEach((l, k) => {
      doc.field(lines[i * 5 + k], l.t, { size: 8 });
      doc.field(einzel[i * 5 + k], l.h, { center: true });
    });
    doc.field(totals[i], d.total, { center: true });
  });
  bhSigns(doc, F.filter((f) => f.r[1] < 60), w.sigs, 57);
}

/** Monatsseite. m = { monat, head, taet: { text, img }, schule: { text, img }, sigs } — img = { jpeg, w, h } */
function bhMonthPage(doc, m) {
  const F = BH_FIELDS.monat;
  doc.page('monat');
  doc.field(bhField(F, 'Textfeld 4_14'), m.monat);
  bhHead(doc, F, m.head);
  for (const [key, name] of [['taet', 'Textfeld 1'], ['schule', 'Beschriftungsfeld 2']]) {
    const f = bhField(F, name);
    const part = m[key] || {};
    if (part.img) {
      const [x1, y1, x2, y2] = f.r;
      const textH = part.text ? Math.min((y2 - y1) * 0.4, wrapText(part.text, x2 - x1 - 8, 12).length * 14 + 8) : 0;
      if (part.text) doc.block({ r: [x1, y2 - textH, x2, y2] }, part.text, 12);
      doc.image(part.img.jpeg, part.img.w, part.img.h, [x1 + 4, y1 + 4, x2 - 4, y2 - textH - 4]);
    } else doc.block(f, part.text, 12);
  }
  bhSigns(doc, F.filter((f) => f.r[1] < 60), m.sigs, 70);
}
