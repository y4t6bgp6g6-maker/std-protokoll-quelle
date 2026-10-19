// Arbeitsarten und Kunden (Übersicht): Jede Zeile bekommt nach festen Regeln (regeln.js) eine Arbeitsart (Baustelle, Kundendienst,
// Werkstatt, Sonstiges); Kunde = Feld „Baustelle“ (ohne Werkstatt), gleiche Baustelle trotz anderer Schreibweise wie
// auf der Team-Seite (teamSameSite), Ketten aus gleichem Wortanfang („Muster-Pizza Nord“ / „Muster-Pizza Süd“) oder
// von Hand (settings.kunden = { merge: { Kunde: Kette }, split: [Kunde] }, Hand geht vor Regel). Alles wird nur
// berechnet, nichts im Zettel gespeichert; ohne Netz und ohne KI. Wird vor app.js geladen.

const ARTEN = [
  ['baustelle', 'Baustelle'],
  ['kundendienst', 'Kundendienst'],
  ['werkstatt', 'Werkstatt'],
  ['sonstiges', 'Sonstiges'],
];
/** Klein, ohne Akzente/Umlaute, ß = ss */
const kdNorm = (s) => String(s ?? '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/** Für die Regeln auch „ae/oe/ue“ wie ä/ö/ü: „Störung“ = „Stoerung“ = „Storung“ */
const kdArtNorm = (s) => kdNorm(String(s ?? '').toLowerCase().replace(/([aou])e/g, '$1'));
// Regeln: vom Server (der Admin ändert sie in der App, alle im Team bekommen sie; gemerkt unter REGELN_KEY) oder –
// bis dahin und ohne Team – regeln.js (REGELN, erzeugt vom Regel-Werkzeug am Mac aus „Regeln und Logiken/*.json“).
// Abschnitte, die die Server-Fassung nicht kennt, kommen aus regeln.js.
const REGELN_KEY = 'stdprotokoll.regeln.v1';
let regelnServer = null; // { rev, zeit, regeln }
try {
  regelnServer = JSON.parse(localStorage.getItem(REGELN_KEY) || 'null');
} catch {}
const regelnAktiv = () => (regelnServer?.regeln?.arbeitsarten?.abschnitte ? regelnServer.regeln : REGELN);
const kdRegelIn = (regeln, id) =>
  regeln.arbeitsarten.abschnitte.find((a) => a.id === id) || REGELN.arbeitsarten.abschnitte.find((a) => a.id === id);
const kdRegel = (id) => kdRegelIn(regelnAktiv(), id);
const kdEscRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Allgemeine Schreibweisen-Regeln (Seite „Schreibweisen“); Vorgabe = Verhalten bis v139
const SW_KUNDEN = { gross: true, akzente: true, satz: true, strasse: true, hausnr: true, ortHinten: true, ortVorne: true, komma: 'leer', orteNie: true, tipp: '5/12', artikel: true };
const SW_TAET = { gross: true, umlaute: true, wortteil: true, bindestrich: false, tipp: 'aus' };
const swOpt = (sw, teil) => ({ ...(teil === 'kunden' ? SW_KUNDEN : SW_TAET), ...(sw?.[teil]?.allgemein || {}) });
/** Erlaubte Tippfehler für ein Wort der Länge n: „aus“, „5“ (1 ab 5 Buchstaben), „5/12“ (dazu 2 ab 12) */
const swTipp = (tipp, n) => {
  const [a, b] = String(tipp).split('/').map(Number);
  return b && n >= b ? 2 : a && n >= a ? 1 : 0;
};

/** Gleiche Namen (Seite „Schreibweisen“): kdKey jeder Schreibweise → erster Name der Gruppe */
function swGruppen(sw, teil) {
  const m = new Map();
  for (const g of sw?.[teil]?.gruppen || []) for (const n of [g.name, ...(g.auch || [])]) if (kdKey(n)) m.set(kdKey(n), g.name);
  return m;
}

/** Baustelle zerlegt für den Vergleich (wie teamSiteParts auf der Team-Seite, aber nach den Schreibweisen-Regeln o) */
function kdSiteParts(name, o) {
  let s = String(name);
  if (o.gross) s = s.toLowerCase();
  if (o.akzente) s = s.replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '');
  s = s.replace(/['’`´]/g, '');
  if (o.strasse) s = s.replace(/stra(ss|ß)e/gi, 'str');
  const core = o.komma === 'ignorieren' ? s.split(',')[0] : s.replace(/,/g, ' ');
  const nums = o.hausnr ? (core.match(TEAM_SITE_ID) || []).map((x) => x.replace(/\s/g, '')).join(' ') : '';
  const rest = core.replace(TEAM_SITE_ID, ' ');
  const ws = rest.match(/\p{L}+/gu) || [];
  let letters;
  const ends = [];
  if (o.satz) {
    letters = ws.join('');
    let n = 0;
    for (const w of ws) ends.push((n += w.length));
  } else {
    letters = rest.trim().replace(/\s+/g, ' ');
    for (const m of letters.matchAll(/\p{L}+/gu)) ends.push(m.index + m[0].length);
  }
  return { letters, ends, words: [...new Set(ws.filter((w) => w.length >= 2))], nums };
}
/** Gleiche Baustelle? (wie teamSameSite, nach den Schreibweisen-Regeln o) */
function kdSameSite(a, b, o) {
  if (a.nums && b.nums && a.nums !== b.nums) return false;
  if (!a.letters || !b.letters) return a.letters === b.letters && a.nums === b.nums;
  if (a.letters === b.letters) return true;
  const [x, y] = a.letters.length <= b.letters.length ? [a, b] : [b, a];
  const n = x.letters.length;
  if (o.ortHinten && n >= 4 && y.letters.startsWith(x.letters) && y.ends.includes(n)) return true;
  if (editDistance(x.letters, y.letters) <= swTipp(o.tipp, n)) return true;
  if (!o.ortVorne) return false;
  const [few, many] = a.words.length <= b.words.length ? [a.words, b.words] : [b.words, a.words];
  const sameWord = (p, q) => p === q || (swTipp(o.tipp, Math.min(p.length, q.length)) >= 1 && editDistance(p, q) <= 1);
  return few.join('').length >= 4 && few.every((w) => many.some((v) => sameWord(w, v)));
}

/** Baustelle einer Zeile gehört zum Kunden einer Kunden-Regel ({ kunde, filiale })? Gleiche Namen zuerst, dann
 *  gleiche Baustelle oder der Kunde (bzw. „Kunde Filiale“) als ganze Wörter am Anfang – so gilt eine Kette für alle
 *  Filialen –, mit „Ort darf vorne stehen“ auch am Ende */
function kdKundeMatch(sw) {
  const o = swOpt(sw, 'kunden');
  const gruppe = swGruppen(sw, 'kunden');
  const parts = new Map();
  const partsOf = (n) => parts.get(n) || (parts.set(n, kdSiteParts(n, o)), parts.get(n));
  const cache = new Map();
  return (site, k) => {
    const key = `${site}\u0000${k.kunde}\u0000${k.filiale || ''}`;
    if (cache.has(key)) return cache.get(key);
    const s = gruppe.get(kdKey(site)) || site;
    const target = k.filiale ? `${k.kunde} ${k.filiale}` : k.kunde;
    const sw2 = kdKey(s).split(' ');
    const tw = kdKey(target).split(' ');
    const starts = tw.every((w, i) => sw2[i] === w);
    const ends = o.ortVorne && sw2.length > tw.length && tw.every((w, i) => sw2[sw2.length - tw.length + i] === w);
    const v = !!kdKey(target) && (starts || ends || (gruppe.get(kdKey(target)) || target) === s || kdSameSite(partsOf(s), partsOf(target), o));
    cache.set(key, v);
    return v;
  };
}

/**
 * Regelliste → Funktion Zeile → { art, regel (Nummer ab 0, -1 = keine), kunde (Nummer der Kunden-Regel), wort }.
 * Erst die Kunden-Regeln kr, dann die Regeln von oben nach unten; die erste passende gilt. Wörter als Wortteil
 * („teil“) oder am Anfang des Feldes („anfang“); Ausnahmen werden vor dem Vergleich aus dem Text genommen
 * („angebracht“ zählt nicht als „gebracht“); Tätigkeiten nach den Schreibweisen-Regeln sw (Gleiche Namen werden
 * vorher auf den ersten Namen der Gruppe gebracht). Auch für das Regel-Werkzeug (nur def).
 */
function artMatcher(def, sw = null, kr = null) {
  const o = swOpt(sw, 'taetigkeiten');
  const base = (s) => {
    let t = String(s ?? '');
    if (o.gross) t = t.toLowerCase();
    if (o.umlaute) t = t.replace(/([aouAOU])e/g, '$1').replace(/ß/g, 'ss').normalize('NFD').replace(/[̀-ͯ]/g, '');
    return t;
  };
  const fin = (t) => (o.bindestrich ? t.replace(/[-‐–\s]+/g, '') : t);
  const norm = (s) => fin(base(s)).trim();
  const alias = [];
  for (const g of sw?.taetigkeiten?.gruppen || [])
    for (const a of g.auch || []) {
      const x = base(a).trim();
      if (x) alias.push([new RegExp(`(^|[^\\p{L}\\p{N}])${kdEscRe(x)}(?=$|[^\\p{L}\\p{N}])`, 'gu'), `$1${base(g.name).trim()}`]);
    }
  const work = (s) => {
    let t = base(s);
    for (const [re, m] of alias) t = t.replace(re, m);
    return fin(t);
  };
  const hit = (t, w) => {
    if (o.wortteil ? t.includes(w) : new RegExp(`(^|[^\\p{L}\\p{N}])${kdEscRe(w)}(?=$|[^\\p{L}\\p{N}])`, 'u').test(t)) return true;
    const k = swTipp(o.tipp, w.length);
    if (!k || /[^\p{L}]/u.test(w)) return false;
    // Tippfehler je Wort des Textes (mit „Wortteil genügt“ dessen Anfang in Länge des Regelworts)
    for (const tok of t.split(/[^\p{L}]+/u)) {
      if (!tok || tok[0] !== w[0]) continue;
      const cands = o.wortteil ? [tok.slice(0, w.length), tok.slice(0, w.length + 1), tok.slice(0, w.length - 1)] : [tok];
      if (cands.some((c) => c && editDistance(c, w) <= k)) return true;
    }
    return false;
  };
  const rules = def.regeln.map((g) => ({ ...g, w: g.woerter.map(norm).filter(Boolean), x: (g.ausnahmen || []).map(norm).filter(Boolean) }));
  // Regeln für eine einzelne Filiale vor denen für den ganzen Kunden (sonst kämen sie nie zum Zug); i = Nummer in kr
  const krs = (kr || [])
    .map((k, i) => ({ ...k, i, w: (k.woerter || []).map(norm).filter(Boolean) }))
    .filter((k) => k.kunde)
    .sort((a, b) => !!b.filiale - !!a.filiale);
  const kmatch = krs.length ? kdKundeMatch(sw) : null;
  return (r) => {
    if (kmatch && r.site)
      for (let i = 0; i < krs.length; i++) {
        const k = krs[i];
        if (!kmatch(r.site, k)) continue;
        if (!k.w.length) return { art: k.ziel, regel: -1, kunde: k.i, wort: '' };
        const t = work(r.work);
        const wort = k.w.find((w) => hit(t, w));
        if (wort) return { art: k.ziel, regel: -1, kunde: k.i, wort };
      }
    for (let i = 0; i < rules.length; i++) {
      const g = rules[i];
      let t = g.feld === 'baustelle' ? norm(r.site) : work(r.work);
      for (const x of g.x) t = t.split(x).join(' ');
      const wort = g.wie === 'anfang' ? g.w.find((w) => t.replace(/^[^\p{L}\p{N}]+/u, '').startsWith(w)) : g.w.find((w) => hit(t, w));
      if (wort) return { art: g.ziel, regel: i, kunde: -1, wort };
    }
    return { art: def.sonst, regel: -1, kunde: -1, wort: '' };
  };
}

/** Ganze Stunden mit Tausenderpunkt: „357 h“ */
const kdHours = (min) => `${Math.round(min / 60).toLocaleString('de-DE')} h`;
/** Schlüssel eines Namens (für settings.kunden): Wörter klein, ohne Satzzeichen */
const kdKey = (s) => kdNorm(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Aus den gültigen Regeln gebaut (neu bei neuen Regeln vom Server: kdRegelnNeu) */
function kdKompilieren(regeln = regelnAktiv()) {
  const ab = (id) => kdRegelIn(regeln, id);
  const sw = ab('schreibweisen');
  const set = (id) => new Set(ab(id).woerter.map((w) => kdNorm(w).replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean));
  return {
    art: artMatcher(ab('arbeitsart'), sw, ab('kundenregeln')?.regeln),
    sw,
    swK: swOpt(sw, 'kunden'),
    gruppen: swGruppen(sw, 'kunden'),
    generic: set('kettenwoerter'),
    streetEnds: [...set('strassen')],
    article: set('artikel'),
  };
}
let KD = null;
const kd = () => (KD ||= kdKompilieren());
/** Neue Regeln (vom Server): neu bauen, Übersicht bzw. Kunden-Seite neu zeichnen */
function kdRegelnNeu() {
  KD = null;
  if (currentView === 'stats') ovcRefresh(null, false);
  else if (currentView === 'kunden') renderKunden();
}
const arbeitsartGrund = (r) => kd().art(r);
/** Arbeitsart einer Zeile */
const arbeitsart = (r) => kd().art(r).art;

const kdStreet = (w) => kd().streetEnds.some((e) => w.endsWith(e));
/** Kette aus diesen Wörtern möglich: mindestens ein Wort ab 3 Buchstaben, das keine Branche/Straße ist */
const kdChainKeyOk = (words) => words.some((w) => w.length >= 3 && !kd().generic.has(w) && !kdStreet(w) && !/\d/.test(w));
/** Wörter eines Namens: Original und verglichen (ohne Satzzeichen); Komma trennt wie ein Leerzeichen */
function kdWords(name) {
  const orig = String(name).split(/[\s,]+/).filter(Boolean);
  const pairs = orig.map((o) => [o, kdNorm(o).replace(/[^\p{L}\p{N}]/gu, '')]).filter((p) => p[1]);
  // Artikel vorne zählen nicht („The Muster“ = „Muster, Musterstadt“)
  if (kd().swK.artikel) while (pairs.length > 1 && kd().article.has(pairs[0][1])) pairs.shift();
  return { orig: pairs.map((p) => p[0]), norm: pairs.map((p) => p[1]) };
}

/** Regeln vom Server holen, wenn sich ihre Fassung geändert hat (rev aus GET /team) */
async function regelnPruefen(rev) {
  if (rev === (regelnServer ? regelnServer.rev : 0) || regelnPruefen.busy) return;
  if (!rev) {
    regelnServer = null;
    regelnMerken();
    return kdRegelnNeu();
  }
  regelnPruefen.busy = true;
  try {
    const d = await teamRequest('GET', '/regeln');
    if (d && d.rev && d.regeln) {
      regelnServer = { rev: d.rev, zeit: d.zeit, regeln: d.regeln };
      regelnMerken();
      kdRegelnNeu();
    }
  } catch {}
  regelnPruefen.busy = false;
}
function regelnMerken() {
  try {
    if (regelnServer) localStorage.setItem(REGELN_KEY, JSON.stringify(regelnServer));
    else localStorage.removeItem(REGELN_KEY);
  } catch {}
}

/** Kunden-Einstellung (nie undefined zurück, aber erst beim Ändern gespeichert) */
const kdSettings = () => ({ merge: { ...(settings.kunden?.merge || {}) }, split: [...(settings.kunden?.split || [])] });

/**
 * Alles für Karten und Seite eines Jahres: Minuten je Arbeitsart (gesamt und je Monat) und die Kunden. Gezählt werden
 * Tage bis heute, an denen gearbeitet werden kann (auch Arbeit am Feiertag); die Pause des Tages wird nach Dauer auf
 * seine Zeilen verteilt, damit alles zusammen die Netto-Stunden ergibt.
 */
function kundenFacts(year) {
  const today = startOfDay(new Date());
  const arten = { baustelle: 0, kundendienst: 0, werkstatt: 0, sonstiges: 0 };
  const artenM = [...Array(12)].map(() => ({ baustelle: 0, kundendienst: 0, werkstatt: 0, sonstiges: 0 }));
  const spell = new Map(); // Schreibweise → { min, days: Set }
  for (const s of sheets) {
    s.days.forEach((d, i) => {
      if (!sheetIsActive(s, i) || !canWork(d)) return;
      const date = sheetDate(s, i);
      if ((year != null && date.getFullYear() !== year) || date > today) return;
      const gross = dayWorked(d);
      if (!gross) return;
      const f = workedNet(d) / gross;
      const iso = isoDate(date);
      for (const r of d.rows) {
        const min = (rowMinutes(r) || 0) * f;
        if (!min) continue;
        const art = arbeitsart(r);
        arten[art] += min;
        artenM[date.getMonth()][art] += min;
        const site = String(r.site || '').trim();
        if (art === 'werkstatt' || !site) continue;
        const e = spell.get(site) || { min: 0, days: new Set() };
        e.min += min;
        e.days.add(iso);
        spell.set(site, e);
      }
    });
  }
  return { year, arten, artenM, kunden: kdGroup(spell) };
}

/** Schreibweisen → Kunden (gleiche Baustelle wie auf der Team-Seite) → Ketten (Hand, dann Regel) */
function kdGroup(spell) {
  // 1. gleiche Baustelle: zusammen nur, wenn jede Schreibweise der einen Gruppe zu jeder der anderen passt
  const names = [...spell.keys()].sort((a, b) => spell.get(b).min - spell.get(a).min);
  // nach den Schreibweisen-Regeln; Vorgabe: anders als auf der Team-Seite zählt der Ort nach dem Komma mit
  // („Muster-Pizza, Nord“ ≠ „Muster-Pizza, Süd“) und zwei verschiedene Orte hinter dem Komma sind nie dieselbe
  // Baustelle (auch nicht als Tippfehler)
  const o = kd().swK;
  const parts = names.map((n) => kdSiteParts(n, o));
  // (es sei denn, der eine Ort steht auch im anderen Namen: „Muster, Nord Mitte“ = „Muster Nord, Mitte“)
  const place = names.map((n) => (o.orteNie && o.komma !== 'ignorieren' && n.includes(',') ? kdKey(n.slice(n.lastIndexOf(',') + 1)) : null));
  const full = names.map((n) => ` ${kdKey(n)} `);
  const placeFits = (x, y) => !place[x] || !place[y] || full[y].includes(` ${place[x]} `) || full[x].includes(` ${place[y]} `);
  const same = (x, y) => placeFits(x, y) && kdSameSite(parts[x], parts[y], o);
  // Gleiche Namen (von Hand) gehören von Anfang an zusammen
  const groups = names.map((_, i) => [i]);
  const of = names.map((_, i) => i);
  const manual = names.map((n) => kd().gruppen.get(kdKey(n)) || null);
  const firstOf = new Map();
  names.forEach((n, i) => {
    if (!manual[i]) return;
    if (!firstOf.has(manual[i])) return firstOf.set(manual[i], i);
    const b = firstOf.get(manual[i]);
    of[i] = b;
    groups[b].push(i);
    groups[i] = [];
  });
  for (let i = 0; i < names.length; i++)
    for (let j = 0; j < i; j++) {
      const a = of[i], b = of[j];
      if (a === b || !groups[a].every((x) => groups[b].every((y) => same(x, y)))) continue;
      for (const x of groups[a]) of[x] = b;
      groups[b].push(...groups[a]);
      groups[a] = [];
    }
  // Name des Kunden = Schreibweise mit den meisten Stunden (names ist danach sortiert)
  const kunden = groups
    .filter((g) => g.length)
    .map((g) => {
      const days = new Set();
      let min = 0;
      for (const x of g) {
        min += spell.get(names[x]).min;
        spell.get(names[x]).days.forEach((d) => days.add(d));
      }
      return { name: manual[g.find((x) => manual[x]) ?? -1] || names[g[0]], keys: g.map((x) => kdKey(names[x])), min, days };
    });

  // 2. Ketten
  const set = kdSettings();
  const split = new Set(set.split);
  const mergeOf = (k) => k.keys.map((x) => set.merge[x]).find(Boolean);
  const chains = new Map(); // Schlüssel → { name, hand, members: [{ k, label }] }
  const join = (key, name, k, label, hand = false) => {
    const c = chains.get(key) || { name, hand, members: [] };
    c.hand ||= hand;
    c.members.push({ k, label });
    chains.set(key, c);
  };
  const free = [];
  const single = []; // ohne Kette
  for (const k of kunden) {
    const m = mergeOf(k);
    if (m) join(kdKey(m), m, k, k.name, true);
    else if (k.keys.some((x) => split.has(x))) single.push(k);
    else free.push(k);
  }
  // gleicher Anfang (ganze Wörter) bei mindestens zwei Kunden, Rest verschieden; die kürzeste passende Kette gilt
  const words = new Map(free.map((k) => [k, kdWords(k.name)]));
  const count = new Map();
  for (const k of free) {
    const w = words.get(k).norm;
    for (let n = 1; n <= w.length; n++) {
      const key = w.slice(0, n).join(' ');
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  // Orte bilden keine Kette: was irgendwo hinter einem Komma steht („Kunde, Ort“)
  const places = new Set(names.filter((n) => n.includes(',')).map((n) => kdWords(n.slice(n.lastIndexOf(',') + 1)).norm.join(' ')));
  const keyOk = (w) => count.get(w.join(' ')) >= 2 && !places.has(w.join(' ')) && kdChainKeyOk(w);
  // je Kunde die kürzeste passende Kette; danach so lang wie bei allen ihren Kunden gleich („Muster Pizza Nord“ und
  // „Muster Pizza Süd“ → „Muster Pizza“), solange jeder einen Rest behält
  const rest = [];
  const found = new Map(); // kürzester Schlüssel → Kunden
  for (const k of free) {
    const w = words.get(k);
    let n = 1;
    while (n < w.norm.length && !keyOk(w.norm.slice(0, n))) n++;
    if (n < w.norm.length) found.set(w.norm.slice(0, n).join(' '), [...(found.get(w.norm.slice(0, n).join(' ')) || []), k]);
    else rest.push(k);
  }
  for (const [key, ks] of found) {
    let n = key.split(' ').length;
    const ws = ks.map((k) => words.get(k));
    while (ws.every((w) => w.norm.length > n + 1 && w.norm[n] === ws[0].norm[n])) n++;
    for (const k of ks) {
      const w = words.get(k);
      join(w.norm.slice(0, n).join(' '), ws[0].orig.slice(0, n).join(' '), k, w.orig.slice(n).join(' '));
    }
  }
  // Name = eine schon gefundene Kette, auch mit Ort vorne („Musterstadt Muster-Pizza“)
  for (const k of rest) {
    const w = words.get(k);
    let hit = null;
    for (let n = 0; n < w.norm.length && !hit; n++) {
      const key = w.norm.slice(n).join(' ');
      if (chains.has(key)) hit = [key, n ? w.orig.slice(0, n).join(' ') : k.name];
    }
    if (hit) join(hit[0], chains.get(hit[0]).name, k, hit[1]);
    else single.push(k);
  }

  const list = single.map((k) => ({ name: k.name, key: k.keys[0], min: k.min, days: k.days.size }));
  for (const [key, c] of chains) {
    const days = new Set();
    c.members.forEach((m) => m.k.days.forEach((d) => days.add(d)));
    list.push({
      name: c.name,
      key,
      chain: true,
      hand: c.hand,
      min: c.members.reduce((t, m) => t + m.k.min, 0),
      days: days.size,
      branches: c.members
        .map((m) => ({ name: m.label || m.k.name, full: m.k.name, key: m.k.keys[0], hand: !!mergeOf(m.k), min: m.k.min, days: m.k.days.size }))
        .sort((a, b) => b.min - a.min),
    });
  }
  return list.sort((a, b) => b.min - a.min || a.name.localeCompare(b.name, 'de'));
}

// ───────── Karten der Übersicht ─────────

const ART_CLS = { baustelle: 'art-b', kundendienst: 'art-k', werkstatt: 'art-w', sonstiges: 'art-s' };

/** Ring: Stunden je Arbeitsart im Jahr */
function kdArtenRingHTML(f) {
  const parts = ARTEN.map(([k, t]) => ({ v: f.kd.arten[k], cls: ART_CLS[k], t }));
  const sum = parts.reduce((a, p) => a + p.v, 0);
  return `<div class="ovc-vac">
    ${ovcDonut(parts, Math.round(sum / 60).toLocaleString('de-DE'), 'Stunden')}
    <div class="ovc-vac-r">
      <div class="ovc-title">Arbeitsarten</div>
      <div class="ovc-lines">${parts.map((p) => `<div><i class="ovc-dot ${p.cls}"></i>${p.t}<b class="ovc-count">${kdHours(p.v)}</b></div>`).join('')}</div>
    </div>
  </div>`;
}

/** Säulen je Monat, gestapelt nach Arbeitsart */
function kdArtenBarsHTML(f) {
  const last = ovcLastMonth(f.year);
  return `<div class="ovc-head"><span class="ovc-title">Arbeitsarten</span></div>
    ${ovcBars(
      f.kd.artenM.map((m, k) => {
        if (k >= last) return null;
        // unten Baustelle, darüber die anderen (die Säule baut sich von unten auf)
        const segs = [...ARTEN].reverse().map(([a]) => ({ v: m[a], cls: ART_CLS[a] }));
        return { v: segs.reduce((t, x) => t + x.v, 0), segs };
      }),
      (v) => fmtNum(Math.round(v / 60))
    )}
    ${legend(ARTEN.map(([k, t]) => [ART_CLS[k], t]))}`;
}

/** Zeile eines Kunden: Name, klein Filialen und Tage, rechts Stunden, darunter ein Balken (im Verhältnis zum größten) */
function kdRowHTML(k, max, open = null) {
  const pct = max ? Math.max(1.5, (k.min / max) * 100) : 0;
  return `<div class="kd-top">
      ${open != null ? `<span class="kd-arrow${open ? ' open' : ''}">${ICON.chevronDown}</span>` : ''}
      <span class="kd-name" translate="no">${escapeHtml(k.name)}</span>
      ${k.chain ? `<span class="kd-fil">${plural(k.branches.length, 'Filiale', 'Filialen')}</span>` : ''}
      <span class="kd-days">${plural(k.days, 'Tag', 'Tage')}</span>
      <b class="kd-h">${kdHours(k.min)}</b>
    </div>
    <div class="kd-bar"><i style="width:${pct}%"></i></div>`;
}

/** Große Karte „Kunden“: die fünf größten, antippen → Seite mit allen */
function kdKundenCardHTML(f) {
  const list = f.kd.kunden;
  const max = list[0]?.min || 0;
  return `<div class="kd-card" data-kunden-open>
    <div class="ovc-head"><span class="ovc-title">Kunden</span><b class="ovc-count">${list.length}</b></div>
    ${list.length ? list.slice(0, 5).map((k) => `<div class="kd-row">${kdRowHTML(k, max)}</div>`).join('') : '<div class="kd-none">Noch keine Kunden</div>'}
    ${list.length > 5 ? `<div class="kd-more">+ ${list.length - 5} weitere</div>` : ''}
  </div>`;
}

document.addEventListener('click', (e) => {
  if (e.target.closest?.('[data-kunden-open]') && !layer.classList.contains('open')) location.hash = '#/kunden';
});

// ───────── Seite „Kunden“ ─────────

const kdOpen = new Set(); // aufgeklappte Ketten (Schlüssel), solange die App offen ist

function kundenRoute(hash) {
  if (hash !== '#/kunden') return false;
  currentView = 'kunden';
  renderKunden();
  return true;
}

function renderKunden() {
  const year = statsYear ?? new Date().getFullYear();
  const list = kundenFacts(year).kunden;
  renderKunden.list = list;
  const max = list[0]?.min || 0;
  const total = list.reduce((t, k) => t + k.min, 0);
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title">Kunden</h1>
    <p class="ps-sub">${year} · ${plural(list.length, 'Kunde', 'Kunden')} · ${kdHours(total)}</p>
    ${
      list.length
        ? `<div class="card kd-list">${list
            .map((k) => {
              const open = kdOpen.has(k.key);
              return `<div class="kd-row kd-item" data-kd-hold="${escapeHtml(k.key)}"${k.chain ? ` data-kd-chain="${escapeHtml(k.key)}"` : ''}>
                ${kdRowHTML(k, max, k.chain ? open : null)}
                ${
                  k.chain && open
                    ? `<div class="kd-branches">${k.branches
                        .map(
                          (b) => `<div class="kd-branch" data-kd-hold="${escapeHtml(b.key)}" data-kd-of="${escapeHtml(k.key)}">
                            <span class="kd-name" translate="no">${escapeHtml(b.name)}</span>
                            <span class="kd-days">${plural(b.days, 'Tag', 'Tage')}</span>
                            <b class="kd-h">${kdHours(b.min)}</b>
                          </div>`
                        )
                        .join('')}</div>`
                    : ''
                }
              </div>`;
            })
            .join('')}</div>`
        : '<div class="card kd-list"><div class="kd-none">Noch keine Kunden</div></div>'
    }`;
}

/** Kette auf- bzw. zuklappen */
document.addEventListener('click', (e) => {
  if (currentView !== 'kunden' || kdPressFired) return;
  const row = e.target.closest?.('[data-kd-chain]');
  if (!row || e.target.closest('.kd-branch')) return;
  const key = row.dataset.kdChain;
  if (kdOpen.has(key)) kdOpen.delete(key);
  else kdOpen.add(key);
  const y = window.scrollY;
  renderKunden();
  window.scrollTo(0, y);
  if (kdOpen.has(key)) expandIn(document.querySelector(`[data-kd-chain="${CSS.escape(key)}"] .kd-branches`));
});

function kdSave(set) {
  settings.kunden = set;
  saveSettings();
  const y = window.scrollY;
  renderKunden();
  window.scrollTo(0, y);
}

/** Menü zu einer Zeile (lang drücken, Mac: Rechtsklick) */
function kdMenu(el) {
  const list = renderKunden.list || [];
  const set = kdSettings();
  const key = el.dataset.kdHold;
  const of = el.dataset.kdOf;
  if (of) {
    // Filiale: aus der Kette lösen (von Hand zugeordnet → Zuordnung weg, sonst nie mehr automatisch in eine Kette)
    const chain = list.find((k) => k.key === of);
    const b = chain?.branches.find((x) => x.key === key);
    if (!b) return;
    actionSheet([
      {
        label: 'Aus der Kette lösen',
        run: () => {
          for (const [k, v] of Object.entries(set.merge)) if (kdKey(v) === of && kdKey(k) === key) delete set.merge[k];
          if (!set.split.includes(key)) set.split.push(key);
          kdSave(set);
        },
      },
    ]);
    return;
  }
  const k = list.find((x) => x.key === key);
  if (!k) return;
  if (k.chain) {
    actionSheet([
      {
        label: 'Kette auflösen',
        destructive: true,
        run: () => {
          for (const b of k.branches) {
            delete set.merge[b.key];
            if (!set.split.includes(b.key)) set.split.push(b.key);
          }
          for (const [x, v] of Object.entries(set.merge)) if (kdKey(v) === k.key) delete set.merge[x];
          kdOpen.delete(k.key);
          kdSave(set);
        },
      },
    ]);
    return;
  }
  // einzelner Kunde: zu einer Kette zusammenfassen (vorhandene oder neue)
  const into = (name) => {
    set.merge[k.key] = name;
    set.split = set.split.filter((x) => x !== k.key);
    kdOpen.add(kdKey(name));
    kdSave(set);
  };
  const chains = list.filter((x) => x.chain);
  actionSheet([
    {
      label: 'Zu Kette zusammenfassen …',
      run: () =>
        chains.length
          ? actionSheet([
              ...chains.map((c) => ({ label: `<span translate="no">${escapeHtml(c.name)}</span>`, run: () => into(c.name) })),
              { label: 'Neue Kette …', run: () => kdAskChain(k.name, into) },
            ])
          : kdAskChain(k.name, into),
    },
    // nur Admin: Kunden-Regel (Seite „Kunden-Regeln“, regeln-seiten.js)
    ...(admin && team ? [{ label: 'Kunden-Regel anlegen …', run: () => rgKundenRegelFuer(k.name) }] : []),
  ]);
}

function kdAskChain(name, done) {
  const modal = openModal(
    `<div class="alert-body"><b>Neue Kette</b>
      <input class="pw-input" data-kd-name value="${escapeHtml(kdWords(name).orig[0] || '')}" maxlength="60" autocomplete="off" enterkeyhint="done" translate="no">
    </div>
    <div class="alert-buttons"><button data-c="no">Abbrechen</button><button data-c="yes" class="strong">Zusammenfassen</button></div>`,
    'alert'
  );
  const input = modal.querySelector('[data-kd-name]');
  const ok = () => {
    const v = input.value.trim();
    if (!v) return;
    closeModal();
    done(v);
  };
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    if (b.dataset.c === 'no') closeModal();
    else ok();
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), ok()));
  setTimeout(() => (input.focus(), input.select()), 50);
}

// lang drücken → Menü; danach kein Auf-/Zuklappen
const KD_HOLD = 450;
let kdPress = null; // { el, x, y, timer }
let kdPressFired = false;
function kdPressEnd() {
  if (!kdPress) return;
  clearTimeout(kdPress.timer);
  kdPress.el.classList.remove('pressing');
  kdPress = null;
}
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest?.('.kd-branch[data-kd-hold], .kd-item[data-kd-hold]');
  if (!el || e.button > 0 || currentView !== 'kunden') return;
  kdPressEnd();
  kdPressFired = false;
  el.classList.add('pressing');
  kdPress = {
    el,
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(() => {
      kdPressEnd();
      kdPressFired = true;
      setTimeout(() => (kdPressFired = false), 600);
      haptic();
      kdMenu(el);
    }, KD_HOLD),
  };
});
document.addEventListener('pointermove', (e) => {
  if (kdPress && Math.hypot(e.clientX - kdPress.x, e.clientY - kdPress.y) > 10) kdPressEnd();
});
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, kdPressEnd));
window.addEventListener('scroll', kdPressEnd, { passive: true });
// Mac: Rechtsklick wie langes Drücken; sonst nur das Menü des Browsers unterdrücken
document.addEventListener('contextmenu', (e) => {
  const el = e.target.closest?.('.kd-branch[data-kd-hold], .kd-item[data-kd-hold]');
  if (!el || currentView !== 'kunden') return;
  e.preventDefault();
  if (document.documentElement.classList.contains('mac') && !layer.classList.contains('open')) kdMenu(el);
});
