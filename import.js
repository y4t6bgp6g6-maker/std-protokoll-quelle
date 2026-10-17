'use strict';
// Stundenzettel aus Numbers-Dateien (.numbers) und aus PDFs einlesen – ohne externe Bibliothek.
// Ergebnis ist immer dasselbe Zwischenformat (siehe parsedToSheets):
//   { name, from: Date, to: Date, days: [{ day: 0–6, rows: [{ start, end, site, work }], pause, status }] }

// ───────────────────────── Hilfen ─────────────────────────

const latin1 = (bytes) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
};
const utf8 = new TextDecoder('utf-8');

async function inflate(bytes, format) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream(format));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const WEEKDAY_KEYS = ['montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag'];
/** „Dienstag “, „Di“, „DIENSTAG“ → 1; sonst -1 */
function weekdayIndex(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return -1;
  const i = WEEKDAY_KEYS.findIndex((k) => t === k || t.startsWith(k));
  if (i >= 0) return i;
  return ['mo', 'di', 'mi', 'do', 'fr', 'sa', 'so'].indexOf(t.replace(/\.$/, ''));
}

/** Wochentag am Anfang entfernen: „Donnerstag frei“ → „frei“ */
const stripWeekday = (text) => String(text || '').trim().replace(/^[a-zäöü]+\.?/i, (w) => (weekdayIndex(w) >= 0 ? '' : w)).trim();

/** „08:00“, „8.30“, „8:30 Uhr“ → Minuten */
function parseClock(text) {
  const m = String(text || '').match(/(\d{1,2})[:.](\d{2})/);
  if (!m) return null;
  const v = Number(m[1]) * 60 + Number(m[2]);
  return v >= 0 && v <= 1440 ? v : null;
}

/** Pause als Text: „0h 30m“, „1ч 0мин“, „0:30“, „30 min“, „0,5“ → Minuten */
function parseDuration(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  const h = t.match(/(\d+(?:[.,]\d+)?)\s*(h|std|ч|stunde)/);
  const m = t.match(/(\d+)\s*(m|min|мин)/);
  if (h || m) return Math.round((h ? parseFloat(h[1].replace(',', '.')) * 60 : 0) + (m ? Number(m[1]) : 0));
  const c = t.match(/^(\d{1,2}):(\d{2})$/);
  if (c) return Number(c[1]) * 60 + Number(c[2]);
  const n = parseFloat(t.replace(',', '.'));
  if (!Number.isNaN(n)) return n <= 12 ? Math.round(n * 60) : Math.round(n); // Stunden, große Zahlen als Minuten
  return null;
}

/** „15.12.2025“, „01.09.26“, „1.9.26“ → Date */
function parseDateText(text) {
  const m = String(text || '').match(/(\d{1,2})\.(\d{1,2})\.(\d{4}|\d{2})/);
  if (!m) return null;
  const y = m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  return new Date(y, Number(m[2]) - 1, Number(m[1]));
}

// Wörter für Urlaub, Krankheit, Feiertag und freie Tage (nur diese Formen, „Krankenhaus“ oder „Freiburg“ zählen nicht)
const STATUS_WORDS = [
  ['urlaub', /^(urlaub|urlaubstag|urlaubstage|resturlaub|jahresurlaub)$/],
  ['krank', /^(krank|krankheit|krankheitstag|krankgeschrieben|krankmeldung|krankgemeldet|krankenschein|au)$/],
  ['feiertag', /^(feiertag|feiertage)$/],
  ['frei', /^(frei|freier|überstundenfrei|gleitzeit|zeitausgleich)$/],
];
const statusOfWord = (w) => (STATUS_WORDS.find(([, re]) => re.test(w)) || [])[0] || null;
const words = (text) => String(text || '').toLowerCase().split(/[^a-zäöüß]+/).filter(Boolean);

/** Tagesart, wenn das Wort irgendwo im Text steht (z. B. „heute krank“) */
function statusFromText(text) {
  for (const w of words(text)) {
    if (w === 'au') continue; // „AU“ nur als ganzer Eintrag, siehe statusOnlyText
    const st = statusOfWord(w);
    if (st) return st;
  }
  return null;
}

/** Tagesart, wenn der Text nur daraus besteht (z. B. „Urlaub“, „Gesetzlicher Feiertag“, „Freier Tag“) */
function statusOnlyText(text) {
  const ws = words(text).filter((w) => !['gesetzlicher', 'tag', 'ganzer', 'halber', 'bezahlter', 'unbezahlter'].includes(w));
  return ws.length === 1 ? statusOfWord(ws[0]) : null;
}

/** Am Ende eines Tages: „Urlaub“, „Krank“ usw. in irgendeiner Spalte → Tagesart.
 *  Ohne Uhrzeiten reicht das Wort irgendwo; mit Uhrzeiten (eingetragen, damit die Stunden zählen)
 *  muss eine Zelle nur aus dem Wort bestehen, damit „Kollege krank, Vertretung“ ein Arbeitstag bleibt. */
function finishDay(day) {
  const texts = day.texts || [];
  delete day.texts;
  if (day.status) return;
  const hasTimes = day.rows.some((r) => r.start != null || r.end != null);
  for (const t of texts) {
    const status = hasTimes ? statusOnlyText(t) : statusOnlyText(t) || statusFromText(t);
    if (status) {
      day.status = status;
      // Feiertag mit Uhrzeiten (z. B. Notdienst): die Arbeitszeilen bleiben erhalten
      day.rows = status === 'feiertag' && hasTimes ? day.rows.filter((r) => r.start != null || r.end != null) : [];
      return;
    }
  }
}

/** Spalte anhand der Überschrift erkennen */
function columnKind(text) {
  const t = String(text || '').trim().toLowerCase();
  if (!t) return null;
  if (t === 'tag' || t === 'datum') return 'day';
  if (t.includes('beginn') || t === 'von' || t === 'start') return 'start';
  if (t.includes('ende') || t === 'bis') return 'end';
  if (t.includes('pause')) return 'pause';
  if (t.includes('baustelle') || t === 'ort' || t.includes('einsatzort') || t.includes('kunde')) return 'site';
  if (t.includes('art der arbeit') || t === 'arbeit' || t.includes('tätigkeit')) return 'work';
  return null;
}

const STOP_WORDS = /stunden\s*gesamt|überstunden|summe|^stunden:$/i;

// ───────────────────────── ZIP ─────────────────────────

/** Einträge einer ZIP-Datei: Map Name → () => Promise<Uint8Array> */
function readZip(buf) {
  const bytes = new Uint8Array(buf);
  const view = new DataView(buf);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('Keine ZIP-Datei');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) break;
    const method = view.getUint16(p + 10, true);
    const size = view.getUint32(p + 20, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = utf8.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    entries.set(name, async () => {
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const data = bytes.subarray(start, start + size);
      if (method === 0) return data;
      if (method === 8) return inflate(data, 'deflate-raw');
      throw new Error('ZIP-Methode ' + method);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ───────────────────────── Numbers (IWA: Snappy + Protobuf) ─────────────────────────

function snappyDecompress(src) {
  let i = 0;
  let len = 0;
  let shift = 0;
  for (;;) {
    const b = src[i++];
    len |= (b & 0x7f) << shift;
    shift += 7;
    if (b < 0x80) break;
  }
  const out = new Uint8Array(len);
  let o = 0;
  while (i < src.length) {
    const tag = src[i++];
    const type = tag & 3;
    if (type === 0) {
      let n = tag >> 2;
      if (n >= 60) {
        const bytes = n - 59;
        n = 0;
        for (let k = 0; k < bytes; k++) n |= src[i + k] << (8 * k);
        i += bytes;
      }
      n += 1;
      out.set(src.subarray(i, i + n), o);
      i += n;
      o += n;
    } else {
      let n;
      let off;
      if (type === 1) {
        n = ((tag >> 2) & 7) + 4;
        off = ((tag >> 5) << 8) | src[i++];
      } else if (type === 2) {
        n = (tag >> 2) + 1;
        off = src[i] | (src[i + 1] << 8);
        i += 2;
      } else {
        n = (tag >> 2) + 1;
        off = (src[i] | (src[i + 1] << 8) | (src[i + 2] << 16) | (src[i + 3] << 24)) >>> 0;
        i += 4;
      }
      for (let k = 0; k < n; k++, o++) out[o] = out[o - off];
    }
  }
  return out;
}

/** IWA-Datei: Blöcke aus 1 Byte (0) + 3 Byte Länge + Snappy-Daten */
function iwaDecode(data) {
  const parts = [];
  let total = 0;
  let i = 0;
  while (i + 4 <= data.length) {
    const len = data[i + 1] | (data[i + 2] << 8) | (data[i + 3] << 16);
    const part = snappyDecompress(data.subarray(i + 4, i + 4 + len));
    parts.push(part);
    total += part.length;
    i += 4 + len;
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function readVarint(b, pos) {
  let n = 0;
  let mul = 1;
  for (;;) {
    const x = b[pos.i++];
    n += (x & 0x7f) * mul;
    mul *= 128;
    if (x < 0x80) return n;
  }
}

/** Protobuf-Nachricht → Map Feldnummer → Liste der Werte (Zahl oder Uint8Array) */
function pbParse(b) {
  const fields = new Map();
  const pos = { i: 0 };
  while (pos.i < b.length) {
    const key = readVarint(b, pos);
    const fn = Math.floor(key / 8);
    const wt = key & 7;
    let v;
    if (wt === 0) v = readVarint(b, pos);
    else if (wt === 1) {
      v = b.subarray(pos.i, pos.i + 8);
      pos.i += 8;
    } else if (wt === 2) {
      const len = readVarint(b, pos);
      v = b.subarray(pos.i, pos.i + len);
      pos.i += len;
    } else if (wt === 5) {
      v = b.subarray(pos.i, pos.i + 4);
      pos.i += 4;
    } else throw new Error('Protobuf-Typ ' + wt);
    if (!fields.has(fn)) fields.set(fn, []);
    fields.get(fn).push(v);
  }
  return fields;
}
const pbGet = (f, n) => (f.get(n) || [])[0];
const pbAll = (f, n) => f.get(n) || [];
const pbRef = (bytes) => pbGet(pbParse(bytes), 1);

/** Alle Objekte aller IWA-Dateien: Map ID → { type, data } */
async function numbersObjects(zip) {
  const objects = new Map();
  for (const [name, read] of zip) {
    if (!name.endsWith('.iwa')) continue;
    const data = iwaDecode(await read());
    const pos = { i: 0 };
    while (pos.i < data.length) {
      const len = readVarint(data, pos);
      const info = pbParse(data.subarray(pos.i, pos.i + len));
      pos.i += len;
      const id = pbGet(info, 1);
      for (const mi of pbAll(info, 2)) {
        const m = pbParse(mi);
        const size = pbGet(m, 3);
        objects.set(id, { type: pbGet(m, 1), data: data.subarray(pos.i, pos.i + size) });
        pos.i += size;
      }
    }
  }
  return objects;
}

/** Dezimalzahl im 128-Bit-Format von Numbers */
function decimal128(b) {
  const exp = (((b[15] & 0x7f) << 7) | (b[14] >> 1)) - 0x1820;
  let m = BigInt(b[14] & 1);
  for (let i = 13; i >= 0; i--) m = m * 256n + BigInt(b[i]);
  const v = Number(m) * Math.pow(10, exp);
  return b[15] & 0x80 ? -v : v;
}

function dataList(objects, id) {
  const out = new Map();
  const o = objects.get(id);
  if (!o) return out;
  for (const e of pbAll(pbParse(o.data), 3)) {
    const ef = pbParse(e);
    const s = pbGet(ef, 3);
    const r = pbGet(ef, 4);
    out.set(pbGet(ef, 1), s ? utf8.decode(s) : r ? { ref: pbRef(r) } : null);
  }
  return out;
}

/** Zelle: { text } für Text, { seconds } für Datum/Uhrzeit, { duration } in Sekunden, { number } */
function decodeCell(buf, strings, rich, objects) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const type = buf[1];
  const flags = dv.getUint32(8, true);
  let k = 12;
  const cell = { type };
  if (flags & 0x1) {
    cell.number = decimal128(buf.subarray(k, k + 16));
    k += 16;
  }
  if (flags & 0x2) {
    cell.double = dv.getFloat64(k, true);
    k += 8;
  }
  if (flags & 0x4) {
    cell.seconds = dv.getFloat64(k, true);
    k += 8;
  }
  if (flags & 0x8) {
    const s = strings.get(dv.getInt32(k, true));
    if (typeof s === 'string') cell.text = s;
    k += 4;
  }
  if (flags & 0x10) {
    const r = rich.get(dv.getInt32(k, true));
    const storage = r && r.ref != null ? objects.get(r.ref) : null;
    if (storage) cell.text = pbAll(pbParse(storage.data), 3).map((x) => utf8.decode(x)).join('');
    k += 4;
  }
  if (type === 7 && cell.double != null) cell.duration = cell.double;
  else if (cell.double != null && cell.number == null) cell.number = cell.double;
  return cell;
}

/** Alle Tabellen einer Numbers-Datei als Raster (Zeilen × Spalten, Zellen oder null) */
async function readNumbersTables(buf) {
  const zip = readZip(buf);
  if (![...zip.keys()].some((n) => n.endsWith('.iwa'))) throw new Error('Keine Numbers-Datei');
  const objects = await numbersObjects(zip);
  const tables = [];
  for (const [, o] of objects) {
    if (o.type !== 6001) continue; // TST.TableModelArchive
    const f = pbParse(o.data);
    const nrows = pbGet(f, 6);
    const ncols = pbGet(f, 7);
    const ds = pbParse(pbGet(f, 4));
    const strings = dataList(objects, pbRef(pbGet(ds, 4)));
    const rich = pbGet(ds, 17) ? dataList(objects, pbRef(pbGet(ds, 17))) : new Map();
    const grid = Array.from({ length: nrows }, () => Array(ncols).fill(null));
    const tiles = pbParse(pbGet(ds, 3));
    for (const t of pbAll(tiles, 1)) {
      const tf = pbParse(t);
      const tileRow = (pbGet(tf, 1) || 0) * 256;
      const tile = objects.get(pbRef(pbGet(tf, 2)));
      if (!tile) continue;
      for (const ri of pbAll(pbParse(tile.data), 5)) {
        const rf = pbParse(ri);
        const row = tileRow + pbGet(rf, 1);
        const buffer = pbGet(rf, 6) || pbGet(rf, 3);
        const offsets = pbGet(rf, 7) || pbGet(rf, 4);
        if (!buffer || !offsets || row >= nrows) continue;
        const wide = !!pbGet(rf, 8);
        const ov = new DataView(offsets.buffer, offsets.byteOffset, offsets.byteLength);
        for (let col = 0; col < Math.min(ncols, offsets.length / 2); col++) {
          let off = ov.getUint16(col * 2, true);
          if (off === 0xffff) continue;
          if (wide) off *= 4;
          const cell = decodeCell(buffer.subarray(off), strings, rich, objects);
          if (cell.type !== 0) grid[row][col] = cell;
        }
      }
    }
    tables.push({ name: utf8.decode(pbGet(f, 8) || new Uint8Array()), grid });
  }
  return tables;
}

const NUMBERS_EPOCH = Date.UTC(2001, 0, 1);
/** Datum einer Numbers-Zelle (Sekunden seit 2001, als „Uhrzeit ohne Zeitzone“) → lokales Datum */
const cellDate = (s) => {
  const d = new Date(NUMBERS_EPOCH + s * 1000);
  return new Date(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};
const cellText = (c) => (c && c.text != null ? c.text.trim() : '');
function cellClock(c) {
  if (!c) return null;
  if (c.seconds != null) return Math.round((((c.seconds % 86400) + 86400) % 86400) / 60);
  if (c.duration != null) return Math.round(c.duration / 60) % 1441;
  if (c.text) return parseClock(c.text);
  if (c.number != null && c.number < 1) return Math.round(c.number * 1440); // Bruchteil eines Tages
  return null;
}
function cellPause(c) {
  if (!c) return null;
  if (c.duration != null) return Math.round(c.duration / 60);
  if (c.text) return parseDuration(c.text);
  if (c.number != null) return c.number <= 12 ? Math.round(c.number * 60) : Math.round(c.number);
  return null;
}
function cellDateValue(c) {
  if (!c) return null;
  if (c.seconds != null) return cellDate(c.seconds);
  return parseDateText(c.text);
}

/** Raster einer Numbers-Tabelle → Zwischenformat */
function gridToParsed(grid) {
  const result = { name: '', from: null, to: null, days: [] };
  const nextValue = (r, c) => {
    for (let k = c + 1; k < grid[r].length; k++) if (grid[r][k]) return grid[r][k];
    return null;
  };
  // Kopf: Name, Woche von, Bis
  let header = -1;
  let cols = null;
  for (let r = 0; r < grid.length && header < 0; r++) {
    grid[r].forEach((c, ci) => {
      const t = cellText(c).toLowerCase();
      if (/^name:?$/.test(t)) result.name = cellText(nextValue(r, ci)).replace(/\s+/g, ' ');
      else if (/^woche\s*von:?$/.test(t) || /^von:?$/.test(t)) result.from = cellDateValue(nextValue(r, ci)) || result.from;
      else if (/^bis:?$/.test(t)) result.to = cellDateValue(nextValue(r, ci)) || result.to;
    });
    const kinds = grid[r].map((c) => columnKind(cellText(c)));
    if (kinds.includes('day') && kinds.includes('start')) {
      header = r;
      cols = {};
      kinds.forEach((k, ci) => {
        if (k && cols[k] == null) cols[k] = ci;
      });
    }
  }
  if (header < 0) throw new Error('Keine Tabelle mit „Tag“ und „Arbeitsbeginn“ gefunden');

  let current = null;
  for (let r = header + 1; r < grid.length; r++) {
    const row = grid[r];
    if (row.some((c) => STOP_WORDS.test(cellText(c)))) break;
    const day = cols.day != null ? weekdayIndex(cellText(row[cols.day])) : -1;
    if (day >= 0) {
      if (current) finishDay(current);
      current = { day, rows: [], pause: null, status: null, texts: [] };
      result.days.push(current);
    }
    if (!current) continue;
    // Alle Texte der Zeile (jede Spalte, in der Spalte „Tag“ ohne den Wochentag) für Urlaub/Krank/Frei/Feiertag
    row.forEach((c, ci) => {
      const t = ci === cols.day ? stripWeekday(cellText(c)) : cellText(c);
      if (t) current.texts.push(t);
    });
    const get = (k) => (cols[k] != null ? row[cols[k]] : null);
    const pause = cellPause(get('pause'));
    if (pause != null && current.pause == null) current.pause = pause;
    const entry = { start: cellClock(get('start')), end: cellClock(get('end')), site: cellText(get('site')), work: cellText(get('work')) };
    addEntry(current, entry);
  }
  if (current) finishDay(current);
  return result;
}

/** Zeile zum Tag hinzufügen; „Frei“, „Urlaub“ usw. ohne Uhrzeiten werden zur Tagesart */
function addEntry(day, e) {
  if (e.start == null && e.end == null && !e.site && !e.work) return;
  day.rows.push(e);
}

// ───────────────────────── PDF ─────────────────────────

/** Alle Objekte „n 0 obj … endobj“ einer PDF-Datei (als Latin-1-Text) */
function pdfObjects(text) {
  const objects = new Map();
  const re = /(\d+)\s+0\s+obj\b/g;
  let m;
  while ((m = re.exec(text))) {
    const start = m.index + m[0].length;
    const end = text.indexOf('endobj', start);
    if (end < 0) break;
    objects.set(Number(m[1]), text.slice(start, end));
    re.lastIndex = end;
  }
  return objects;
}

async function pdfStream(objText, bytesOf, objects) {
  const s = objText.indexOf('stream');
  if (s < 0) return '';
  let p = s + 6;
  if (objText[p] === '\r') p++;
  if (objText[p] === '\n') p++;
  const dict = objText.slice(0, s);
  // Länge laut /Length (direkt oder als Verweis), sonst bis „endstream“ ohne Zeilenumbruch davor
  let len = null;
  const lm = dict.match(/\/Length\s+(\d+)(\s+0\s+R)?/);
  if (lm) len = lm[2] ? Number(String((objects && objects.get(Number(lm[1]))) || '').trim()) || null : Number(lm[1]);
  let raw;
  if (len != null) raw = bytesOf(objText.slice(p, p + len));
  else raw = bytesOf(objText.slice(p, objText.lastIndexOf('endstream')).replace(/\r?\n$/, ''));
  if (/\/FlateDecode/.test(dict)) return latin1(await inflate(raw, 'deflate'));
  return latin1(raw);
}

// MacRoman 0x80–0xFF
const MAC_ROMAN =
  'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
const WIN_ANSI_HIGH = { 0x80: '€', 0x82: '‚', 0x84: '„', 0x85: '…', 0x91: '‘', 0x92: '’', 0x93: '“', 0x94: '”', 0x96: '–', 0x97: '—' };

function parseToUnicode(cmap) {
  const map = new Map();
  const hex = (h) => parseInt(h, 16);
  const uni = (h) => String.fromCodePoint(...h.match(/.{4}/g).map(hex));
  for (const block of cmap.match(/beginbfchar([\s\S]*?)endbfchar/g) || []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) map.set(hex(m[1]), uni(m[2]));
  }
  for (const block of cmap.match(/beginbfrange([\s\S]*?)endbfrange/g) || []) {
    for (const m of block.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      const base = hex(m[3]);
      for (let c = hex(m[1]), k = 0; c <= hex(m[2]); c++, k++) map.set(c, String.fromCodePoint(base + k));
    }
  }
  return map;
}

const resolve = (objects, v) => {
  const m = String(v || '').match(/^\s*(\d+)\s+0\s+R/);
  return m ? objects.get(Number(m[1])) || '' : v;
};

async function pdfFont(objects, fontObj, bytesOf) {
  const font = { widths: [], first: 0, map: null, decode: null };
  const enc = fontObj.match(/\/Encoding\s*\/(\w+)/);
  font.decode = enc && enc[1] === 'WinAnsiEncoding'
    ? (c) => (c >= 0x80 ? WIN_ANSI_HIGH[c] || String.fromCharCode(c) : String.fromCharCode(c))
    : (c) => (c >= 0x80 ? MAC_ROMAN[c - 0x80] : String.fromCharCode(c));
  const diffs = fontObj.match(/\/Differences\s*\[([^\]]*)\]/);
  if (diffs) {
    const names = { quoteright: '’', quoteleft: '‘', quotesingle: "'", endash: '–', emdash: '—', adieresis: 'ä', odieresis: 'ö', udieresis: 'ü', Adieresis: 'Ä', Odieresis: 'Ö', Udieresis: 'Ü', germandbls: 'ß', space: ' ' };
    const extra = new Map();
    let code = 0;
    for (const tok of diffs[1].match(/\d+|\/[^\s/\]]+/g) || []) {
      if (/^\d+$/.test(tok)) code = Number(tok);
      else extra.set(code++, names[tok.slice(1)] || null);
    }
    const base = font.decode;
    font.decode = (c) => extra.get(c) || base(c);
  }
  const tu = fontObj.match(/\/ToUnicode\s+(\d+)\s+0\s+R/);
  if (tu) font.map = parseToUnicode(await pdfStream(objects.get(Number(tu[1])) || '', bytesOf, objects));
  const fc = fontObj.match(/\/FirstChar\s+(\d+)/);
  font.first = fc ? Number(fc[1]) : 0;
  let w = fontObj.match(/\/Widths\s*(\[[^\]]*\]|\d+\s+0\s+R)/);
  if (w) {
    const arr = w[1].startsWith('[') ? w[1] : resolve(objects, w[1]);
    font.widths = (String(arr).match(/-?\d+(\.\d+)?/g) || []).map(Number);
  }
  return font;
}

/** Zeichenketten aus einem PDF-Inhalt: ( … ) mit Escapes oder < … > in Hex */
function pdfStringBytes(tok) {
  if (tok[0] === '<') {
    const h = tok.slice(1, -1).replace(/\s/g, '');
    const out = [];
    for (let i = 0; i < h.length; i += 2) out.push(parseInt(h.substr(i, 2).padEnd(2, '0'), 16));
    return out;
  }
  const out = [];
  const s = tok.slice(1, -1);
  for (let i = 0; i < s.length; i++) {
    let c = s[i];
    if (c !== '\\') {
      out.push(c.charCodeAt(0));
      continue;
    }
    c = s[++i];
    const esc = { n: 10, r: 13, t: 9, b: 8, f: 12 };
    if (c in esc) out.push(esc[c]);
    else if (/[0-7]/.test(c)) {
      let o = c;
      while (o.length < 3 && /[0-7]/.test(s[i + 1])) o += s[++i];
      out.push(parseInt(o, 8));
    } else if (c === '\r' || c === '\n') {
      if (c === '\r' && s[i + 1] === '\n') i++;
    } else out.push(c.charCodeAt(0));
  }
  return out;
}

function tokenize(content) {
  const tokens = [];
  const re = /\((?:\\.|[^\\)])*\)|<<|>>|<[0-9a-fA-F\s]*>|\[|\]|\/[^\s/\[\]()<>{}%]+|[^\s/\[\]()<>{}%]+|%[^\n]*/gs;
  // Klammern dürfen verschachtelt sein: einfache Variante reicht für Numbers/Quartz
  let m;
  while ((m = re.exec(content))) if (m[0][0] !== '%') tokens.push(m[0]);
  return tokens;
}

const mul = (a, b) => [
  a[0] * b[0] + a[1] * b[2],
  a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2],
  a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4],
  a[4] * b[1] + a[5] * b[3] + b[5],
];

/** Texte der ersten Seite mit Position (von oben links) und Breite */
async function readPdfItems(buf) {
  const bytes = new Uint8Array(buf);
  const text = latin1(bytes);
  if (!text.startsWith('%PDF')) throw new Error('Keine PDF-Datei');
  const bytesOf = (s) => {
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
    return out;
  };
  const objects = pdfObjects(text);
  const pageEntry = [...objects.values()].find((o) => /\/Type\s*\/Page\b/.test(o));
  if (!pageEntry) throw new Error('Keine Seite gefunden');
  const box = (pageEntry.match(/\/MediaBox\s*\[([^\]]*)\]/) || [, '0 0 595 842'])[1].trim().split(/\s+/).map(Number);
  const pageH = box[3];
  let res = (pageEntry.match(/\/Resources\s*(\d+\s+0\s+R|<<[\s\S]*?>>\s*>>)/) || [])[1] || '';
  res = resolve(objects, res);
  const fontDict = (String(res).match(/\/Font\s*(<<[^>]*>>|\d+\s+0\s+R)/) || [])[1] || '';
  const fonts = new Map();
  for (const m of String(resolve(objects, fontDict)).matchAll(/\/([^\s/]+)\s+(\d+)\s+0\s+R/g)) {
    fonts.set(m[1], await pdfFont(objects, objects.get(Number(m[2])) || '', bytesOf));
  }
  const contentRefs = (pageEntry.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/) || [])[1] || '';
  let content = '';
  for (const m of contentRefs.matchAll(/(\d+)\s+0\s+R/g)) content += (await pdfStream(objects.get(Number(m[1])) || '', bytesOf, objects)) + '\n';

  const items = [];
  let ctm = [1, 0, 0, 1, 0, 0];
  const stack = [];
  let tm = [1, 0, 0, 1, 0, 0];
  let tlm = [1, 0, 0, 1, 0, 0];
  let font = null;
  let size = 1;
  let leading = 0;
  let charSpace = 0;
  let wordSpace = 0;
  let hScale = 1;
  const operands = [];
  const show = (codes) => {
    if (!font) return;
    let str = '';
    let width = 0;
    for (const c of codes) {
      str += (font.map && font.map.get(c)) || font.decode(c) || '';
      const w = font.widths[c - font.first] || 0;
      width += ((w / 1000) * size + charSpace + (c === 32 ? wordSpace : 0)) * hScale;
    }
    const m = mul(tm, ctm);
    const scale = Math.hypot(m[0], m[1]);
    items.push({ text: str, x: m[4], y: pageH - m[5], size: size * Math.hypot(m[2], m[3]), w: width * scale });
    tm = mul([1, 0, 0, 1, width, 0], tm);
  };
  for (const tok of tokenize(content)) {
    if (tok[0] === '(' || tok[0] === '<' || tok[0] === '/' || tok === '[' || tok === ']' || /^-?[\d.]+$/.test(tok)) {
      operands.push(tok);
      continue;
    }
    const num = (i) => Number(operands[operands.length - i]);
    switch (tok) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() || [1, 0, 0, 1, 0, 0];
        break;
      case 'cm':
        ctm = mul([num(6), num(5), num(4), num(3), num(2), num(1)], ctm);
        break;
      case 'BT':
        tm = [1, 0, 0, 1, 0, 0];
        tlm = tm;
        break;
      case 'Tf':
        font = fonts.get(String(operands[operands.length - 2]).slice(1)) || null;
        size = num(1);
        break;
      case 'Tm':
        tm = [num(6), num(5), num(4), num(3), num(2), num(1)];
        tlm = tm;
        break;
      case 'Td':
        tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm);
        tm = tlm;
        break;
      case 'TD':
        leading = -num(1);
        tlm = mul([1, 0, 0, 1, num(2), num(1)], tlm);
        tm = tlm;
        break;
      case 'T*':
        tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        break;
      case 'TL':
        leading = num(1);
        break;
      case 'Tc':
        charSpace = num(1);
        break;
      case 'Tw':
        wordSpace = num(1);
        break;
      case 'Tz':
        hScale = num(1) / 100;
        break;
      case 'Tj':
        show(pdfStringBytes(operands[operands.length - 1]));
        break;
      case "'":
        tlm = mul([1, 0, 0, 1, 0, -leading], tlm);
        tm = tlm;
        show(pdfStringBytes(operands[operands.length - 1]));
        break;
      case 'TJ': {
        const start = operands.lastIndexOf('[');
        for (const op of operands.slice(start + 1)) {
          if (op === ']') break;
          if (op[0] === '(' || op[0] === '<') show(pdfStringBytes(op));
          else tm = mul([1, 0, 0, 1, (-Number(op) / 1000) * size * hScale, 0], tm);
        }
        break;
      }
    }
    operands.length = 0;
  }
  // Nebeneinander liegende Textstücke einer Zeile zusammenfügen (Lücke = Leerzeichen)
  items.sort((a, b) => a.y - b.y || a.x - b.x);
  const merged = [];
  for (const it of items) {
    if (!it.text.trim() && !it.text) continue;
    const last = merged[merged.length - 1];
    if (last && Math.abs(last.y - it.y) < 1 && it.x - (last.x + last.w) < it.size * 0.6 && it.x >= last.x + last.w - it.size) {
      const gap = it.x - (last.x + last.w);
      last.text += (gap > it.size * 0.15 && !last.text.endsWith(' ') && !it.text.startsWith(' ') ? ' ' : '') + it.text;
      last.w = it.x + it.w - last.x;
    } else merged.push({ ...it });
  }
  // Ligaturen wie „ﬂ“ und „ﬀ“ in normale Buchstaben zerlegen
  return merged.filter((it) => it.text.trim()).map((it) => ({ ...it, text: it.text.replace(/[\uFB00-\uFB06]/g, (c) => c.normalize('NFKC')).trim() }));
}

/** PDF-Texte → Zwischenformat */
function pdfItemsToParsed(items) {
  const result = { name: '', from: null, to: null, days: [] };
  // Zeilen: Texte mit fast gleicher Grundlinie
  const lines = [];
  for (const it of [...items].sort((a, b) => a.y - b.y)) {
    const line = lines.find((l) => Math.abs(l.y - it.y) < 2.5);
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  lines.forEach((l) => l.items.sort((a, b) => a.x - b.x));

  // Kopf
  for (const l of lines) {
    l.items.forEach((it, i) => {
      const t = it.text.toLowerCase();
      const next = l.items[i + 1];
      if (/^name:?$/.test(t) && next) result.name = l.items.slice(i + 1).filter((x) => !/:$/.test(x.text)).map((x) => x.text).join(' ').trim();
      else if (/^woche\s*von:?$/.test(t) && next) result.from = parseDateText(next.text);
      else if (/^bis:?$/.test(t) && next) result.to = parseDateText(next.text);
    });
  }
  const isHeader = (l) => {
    const kinds = l.items.map((it) => columnKind(it.text));
    return kinds.includes('day') && kinds.includes('start');
  };
  // Überschrift über zwei Zeilen („Arbeits-“ / „beginn“, so im PDF der App): Teile untereinander zusammensetzen
  const joinHeader = (l, n) => ({
    y: n.y,
    items: l.items.map((it) => {
      const below = n.items.find((b) => Math.abs(b.x - it.x) < 4);
      if (!below) return it;
      return { ...it, text: it.text.endsWith('-') ? it.text.slice(0, -1) + below.text : `${it.text} ${below.text}` };
    }),
  });
  let headerLine = null;
  for (let i = 0; i < lines.length && !headerLine; i++) {
    const next = lines[i + 1];
    if (isHeader(lines[i])) headerLine = lines[i];
    else if (next && next.y - lines[i].y < 14 && isHeader(joinHeader(lines[i], next))) headerLine = joinHeader(lines[i], next);
  }
  if (!headerLine) throw new Error('Keine Tabelle mit „Tag“ und „Arbeitsbeginn“ gefunden');
  // Spalten beginnen dort, wo ihre Überschrift steht (alle Überschriften, auch unbekannte wie „Stunden“)
  const cols = headerLine.items.map((it) => ({ x: it.x, kind: columnKind(it.text) })).sort((a, b) => a.x - b.x);
  const kindAt = (x) => {
    let k = null;
    for (const c of cols) if (c.x <= x + 3) k = c.kind;
    return k;
  };
  const body = lines.filter((l) => l.y > headerLine.y + 2);
  const stop = body.findIndex((l) => l.items.some((it) => STOP_WORDS.test(it.text)));
  const rows = (stop >= 0 ? body.slice(0, stop) : body).map((l) => {
    const r = { y: l.y, size: Math.max(...l.items.map((it) => it.size)), all: l.items.map((it) => it.text) };
    for (const it of l.items) {
      const k = kindAt(it.x);
      if (k) r[k] = r[k] ? `${r[k]} ${it.text}` : it.text;
    }
    return r;
  });
  // Senkrecht mittig umbrochener Text (PDF der App): die erste Zeile steht knapp über der Zeile mit den Zeiten
  for (let i = rows.length - 2; i >= 0; i--) {
    const a = rows[i];
    const b = rows[i + 1];
    if (a.day || a.start || a.end || a.pause || !(a.site || a.work) || !(b.start || b.end) || b.y - a.y >= 6) continue;
    for (const k of ['site', 'work']) if (a[k]) b[k] = b[k] ? `${a[k]} ${b[k]}` : a[k];
    b.all = [...a.all, ...b.all];
    rows.splice(i, 1);
  }
  // Tage: Beschriftungen in der Spalte „Tag“; stehen sie mittig im Block, liegen die Grenzen dazwischen
  const labels = rows.filter((r) => r.day && weekdayIndex(r.day) >= 0).map((r) => ({ y: r.y, day: weekdayIndex(r.day) }));
  if (!labels.length) throw new Error('Keine Wochentage gefunden');
  const firstContent = rows.find((r) => r.start || r.end || r.site || r.work);
  const centered = firstContent && firstContent.y < labels[0].y - 3;
  const bounds = labels.map((l, i) => {
    const next = labels[i + 1];
    if (centered) {
      const prev = labels[i - 1];
      const half = next ? (next.y - l.y) / 2 : prev ? (l.y - prev.y) / 2 : Infinity;
      return { day: l.day, top: l.y - half, bottom: next ? (l.y + next.y) / 2 : l.y + half };
    }
    return { day: l.day, top: l.y - 3, bottom: next ? next.y - 3 : Infinity };
  });
  for (const b of bounds) {
    const day = { day: b.day, rows: [], pause: null, status: null, texts: [] };
    let last = null;
    for (const r of rows) {
      if (r.y < b.top || r.y >= b.bottom) continue;
      day.texts.push(...r.all.map(stripWeekday).filter(Boolean));
      if (r.pause && day.pause == null) day.pause = parseDuration(r.pause);
      const e = { start: parseClock(r.start), end: parseClock(r.end), site: r.site || '', work: r.work || '' };
      // Umbrochener Text (weitere Zeile derselben Zelle) gehört zur Zeile darüber; Abstand zur zuletzt
      // angehängten Textzeile, damit auch eine dritte Zeile dazukommt
      if (last && e.start == null && e.end == null && r.y - last.y < r.size * 1.6) {
        if (e.site) last.e.site = `${last.e.site} ${e.site}`.trim();
        if (e.work) last.e.work = `${last.e.work} ${e.work}`.trim();
        last.y = r.y;
        continue;
      }
      const before = day.rows.length;
      addEntry(day, e);
      if (day.rows.length > before) last = { y: r.y, e };
    }
    finishDay(day);
    result.days.push(day);
  }
  return result;
}

// ───────────────────────── Zwischenformat → Stundenzettel ─────────────────────────

/** Woche aus dem Dateinamen, falls im Zettel kein Datum steht: „Stundenzettel 05.01.26 - 11.01.26“ */
const dateFromFileName = (name) => parseDateText(name);

/** Wochenzettel beginnen montags. Ist „Woche von“ bei einer ganzen Woche (bis = von + 6 Tage) kein Montag, ist meist das
 *  Jahr („13.04.2025“ statt 2026) oder der Monat („05.01.24“ statt 05.02.24) vertippt: dann das Jahr aus dem Dateinamen,
 *  sonst unter Nachbarjahr und Nachbarmonat der Montag, der am wenigsten vom Zettel abweicht */
function fixWeekYear(parsed, fileName) {
  const from = parsed.from;
  if (!from || from.getDay() === 1 || !parsed.to || Math.round((parsed.to - from) / 864e5) !== 6) return from;
  const y = from.getFullYear();
  const m = from.getMonth();
  const day = from.getDate();
  const named = dateFromFileName(fileName);
  if (named) {
    const d = new Date(named.getFullYear(), m, day);
    if (d.getDay() === 1) return d;
  }
  const options = [
    new Date(y + 1, m, day),
    new Date(y - 1, m, day),
    new Date(y, m + 1, day),
    new Date(y, m - 1, day),
    new Date(new Date().getFullYear(), m, day),
  ].filter((d) => d.getDay() === 1 && d.getDate() === day);
  if (!options.length) return from;
  return options.sort((a, b) => Math.abs(a - from) - Math.abs(b - from))[0];
}

/**
 * Baut die Stundenzettel einer Woche; anchor = „Woche von“ (bestimmt die Woche). Geht die Woche über ein Monatsende,
 * entsteht wie in der App je Monat ein Zettel mit den Tagen dieses Monats – für jeden Monat mit Einträgen; steht
 * gar nichts im Zettel, ein leerer für den Monat von „Woche von“.
 */
function parsedToSheets(parsed, fileName, chosen) {
  const from = chosen || parsed.from;
  const anchor = from || dateFromFileName(fileName);
  if (!anchor) throw new Error('Kein Datum („Woche von“) gefunden');
  // Datum geändert (Vorschlag bestätigt): in der Rückmeldung nennen
  const yearFixed = from && from !== parsed.from ? fmtShort(parsed.from) : '';
  // Eigener Name aus den Einstellungen hat Vorrang (z. B. beim Einlesen des Zettels eines Kollegen)
  const s = newSheet(anchor, settings.name.trim() || parsed.name || '');
  s.importedName = parsed.name || '';
  const seen = new Set();
  const filled = new Set();
  for (const d of parsed.days) {
    if (seen.has(d.day)) continue; // doppelte Wochentage: nur der erste zählt
    seen.add(d.day);
    if (d.status || d.rows.length || d.pause) filled.add(d.day);
    const day = s.days[d.day];
    const rows = d.rows.map((r) => ({ id: uid(), start: r.start, end: r.end, site: r.site || '', work: r.work || '' }));
    if (d.status) {
      day.status = d.status;
      day.pause = null;
      // Feiertag mit Arbeit (Notdienst): Zeilen übernehmen
      if (d.status === 'feiertag' && rows.length) {
        day.rows = rows;
        day.pause = d.pause != null ? d.pause : null;
      }
      continue;
    }
    if (rows.length) {
      day.rows = rows;
      day.pause = d.pause != null ? d.pause : null;
    } else if (d.pause) {
      day.pause = d.pause;
    }
  }
  // Je Monat der Woche ein Zettel, der nur die Tage dieses Monats übernimmt
  const parts = [];
  for (let i = 0; i < 7; i++) {
    const part = newSheet(sheetDate(s, i), s.name);
    if (parts.some((x) => x.year === part.year && x.month === part.month)) continue;
    part.importedName = s.importedName;
    if (yearFixed) part.yearFixed = yearFixed;
    for (const k of sheetActiveDays(part)) part.days[k] = s.days[k];
    parts.push(part);
  }
  let result = parts.filter((x) => sheetActiveDays(x).some((k) => filled.has(k)));
  if (!result.length) result = parts.filter((x) => x.year === s.year && x.month === s.month);
  result.forEach((x) => {
    markHolidays(x);
    fixWeekend(x);
  });
  return result;
}

/** Eine Datei (ArrayBuffer) einlesen → Stundenzettel (bei Wochen über ein Monatsende einer je Monat).
 *  Ist „Woche von“ kein Montag, entscheidet askDate(stated, proposed) → gewähltes Datum oder null (nicht einlesen);
 *  ohne askDate gilt der Vorschlag */
async function importTimesheetFile(name, buf, askDate = null) {
  const lower = name.toLowerCase();
  const head = new Uint8Array(buf.slice(0, 4));
  const isPdf = lower.endsWith('.pdf') || (head[0] === 0x25 && head[1] === 0x50);
  const finish = async (parsed) => {
    const proposed = fixWeekYear(parsed, name);
    let chosen = proposed;
    if (askDate && parsed.from && proposed && proposed !== parsed.from) {
      chosen = await askDate(parsed.from, proposed);
      if (!chosen) throw new Error('skip');
    }
    return parsedToSheets(parsed, name, chosen);
  };
  if (isPdf) return finish(pdfItemsToParsed(await readPdfItems(buf)));
  // Numbers-Dateien sind ZIP-Archive (beginnen mit „PK“)
  if (!(head[0] === 0x50 && head[1] === 0x4b)) throw new Error('nur Numbers-, PDF- oder Sicherungsdateien');
  const tables = await readNumbersTables(buf);
  let lastError = null;
  for (const t of tables) {
    let parsed;
    try {
      parsed = gridToParsed(t.grid);
      parsedToSheets(parsed, name); // Probe: passt diese Tabelle?
    } catch (e) {
      lastError = e;
      continue;
    }
    return finish(parsed);
  }
  throw lastError || new Error('Keine Tabelle gefunden');
}
