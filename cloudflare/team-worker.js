// Std-Protokoll – Team-Speicher (Cloudflare Worker mit D1-Datenbank in der EU)
//
// Jedes iPhone legt hier die Stundenzettel des laufenden Monats ab (ein Eintrag je Gerät, wird bei jeder
// Änderung überschrieben). Wer den Team-Code kennt, kann alle Einträge lesen. Einträge aus älteren Monaten
// löscht der Worker bei jeder Anfrage; damit ist der Speicher nach einem Monatswechsel leer.
//
// Einrichtung im Cloudflare-Dashboard:
//   - D1-Datenbank (Jurisdiction „EU“) als Binding mit dem Namen DB
//   - Workers AI als Binding mit dem Namen AI (Rechtschreibung, gleiche Baustellen)
//   - Secret TEAM_CODE: der Team-Code, den die Kollegen eingeben
// Die Tabelle legt der Worker selbst an.
//
// Anfragen (Code im Header X-Team-Code):
//   GET    /ping   → { ok }   nur zum Messen der Antwortzeit
//   GET    /team   → { month, members: [{ member, name, updated, sheets }], posts: [{ id, member, name, text, created }], spellV }
//                    spellV: Stand von Anweisung und Wörterbuch (wie v bei /ai; ändert er sich, prüfen die iPhones neu)
//   PUT    /me     ← { member, token, name, month, sheets, version }   eigener Eintrag (version: App-Version für die Admin-Seite)
//   DELETE /me     ← { member, token }                         Team verlassen (eigene Nachrichten bleiben bis Monatsende)
//   POST   /post   ← { member, token, text }                   Nachricht an die Pinnwand (nur mit eigenem Eintrag)
//   DELETE /post   ← { member, token, id }                     eigene Nachricht löschen
//   POST   /ai     ← { member, token, task: 'spell', items }   → { v, out: [[Eintrag, Ergebnis, geprüft]] }
//                    Rechtschreibung je Eintrag (Arbeit, Baustelle): erst die KI, danach das Wörterbuch (Tabelle dict:
//                    richtige Schreibweisen; gleiche Buchstaben oder ein Tippfehler werden ersetzt). Antwortet die KI
//                    nicht (Kontingent, Fehler), gilt nur das Wörterbuch (geprüft = false). v ändert sich mit dem Wörterbuch
//                  ← { member, token, task: 'sites', names }   → { groups } welche Baustellen-Schreibweisen dieselbe meinen
//                  ← { member, token, task: 'tr', to, items }  → { out: [[Eintrag, Übersetzung oder null]] } Einträge
//                    russisch schreibender Kollegen ins Deutsche (fürs PDF) bzw. deutsche ins Russische (to: 'de' | 'ru')
//                    Workers AI (kostenloses Tageskontingent); Ergebnisse in ai_cache (60 Tage), höchstens AI_PER_DAY
//                    Anfragen je Person und Tag. Nur mit eigenem Eintrag im laufenden Monat
//   POST   /error  ← { member, token, name, version, ua, reports: [{ message, stack, view, count, first, last }] }
//                    Fehlerberichte der App; bleiben beim Monatswechsel erhalten (Tabelle errors), werden nach
//                    ERROR_DAYS Tagen gelöscht. Danach Mitteilung an die angemeldeten Admin-Geräte (Web Push),
//                    höchstens alle PUSH_GAP Minuten
// Nur mit Admin-Code (Header X-Admin-Code, Secret ADMIN_CODE; er gilt auch als Team-Code):
//   GET    /errors → { errors, storage, team, dict, usage }   die letzten Fehlerberichte, Speicherbelegung, Team diesen Monat,
//                                                              Wörterbuch, Tagesgrenzen von Cloudflare (siehe cfUsage)
//   PUT    /dict   ← { word }                                  richtige Schreibweise ins Wörterbuch
//   DELETE /dict   ← { word }                                  aus dem Wörterbuch löschen
//   PUT    /push   ← { endpoint, keys: { p256dh, auth } }      Gerät für Mitteilungen anmelden
//   DELETE /push   ← { endpoint }                              abmelden
// Tagesgrenzen: Secret CF_STATS_TOKEN (API-Token nur mit „Konto-Analysen: Lesen“) und Variable CF_ACCOUNT_ID
// Web Push: Secret VAPID_JWK (privater Schlüssel als JWK), öffentlicher Schlüssel steht in fehler-seite.js

const ORIGINS = ['https://y4t6bgp6g6-maker.github.io'];
const MAX_BODY = 1_000_000;
const MAX_TEXT = 500;
const MAX_POSTS = 300; // je Person und Monat
const MAX_ERRORS = 30; // Fehlerberichte je Gerät und Tag
const ERROR_DAYS = 180;
const PUSH_GAP = 10;
const VAPID_SUB = 'https://y4t6bgp6g6-maker.github.io/std-protokoll/';
const STORAGE_LIMIT = 500 * 1024 * 1024; // D1 im kostenlosen Tarif: 500 MB je Datenbank
const AI_MODEL = '@cf/google/gemma-4-26b-a4b-it';
const AI_PER_DAY = 300;
const AI_CACHE_DAYS = 60;
// Fassung der Anweisung: Teil des Speicher-Schlüssels, damit eine geänderte Anweisung alles neu prüft
const AI_SPELL_V = 4;
// Kostenloser Tarif je Tag (neu ab 0 Uhr UTC): Anfragen an Worker, gelesene/geschriebene Zeilen in D1, Neuronen der KI
const FREE_REQUESTS = 100000;
const FREE_ROWS_READ = 5000000;
const FREE_ROWS_WRITTEN = 100000;
const AI_FREE = 10000;
const AI_SPELL = "Du prüfst kurze Einträge aus einem deutschen Stundenzettel eines Handwerkers (Tätigkeiten oder Baustellen) auf Rechtschreibung. Korrigiere Rechtschreib- und Tippfehler sowie Groß-/Kleinschreibung, auch in Straßennamen (z. B. „Lindenwg“ → „Lindenweg“, „Hauptstrase“ → „Hauptstraße“). Formuliere nichts um, füge keine Wörter hinzu, lass Abkürzungen und Zahlen so. Namen bekannter Marken, Ketten und Unternehmen schreibst du genau in ihrer offiziellen Schreibweise – fehlende Apostrophe, Akzente und Großbuchstaben ergänzt du, auch wenn noch ein Ort oder anderes dabei steht (z. B. „loreal“ → „L'Oréal“, „starbucks Musterstadt“ → „Starbucks Musterstadt“, „ikea“ → „IKEA“). Namen von Personen, kleinen Firmen und Orten lässt du so, außer bei eindeutigem Tippfehler. Antworte nur mit JSON: {\"out\": [\"…\", …]} in derselben Reihenfolge und Anzahl wie die Eingabe.";
// Fassung der Übersetzungs-Anweisungen (Teil des Speicher-Schlüssels)
const AI_TR_V = 1;
const AI_TR_RULES =
  'Es sind kurze Einträge von Handwerkern (Tätigkeiten aus dem Stundenzettel, Berichte aus dem Ausbildungsnachweis, Nachrichten an Kollegen). Übersetze sinngemäß und knapp in der Fachsprache des Handwerks, nichts hinzufügen oder erklären. Zahlen, Maße und Uhrzeiten bleiben als Zahlen, alle Wörter werden übersetzt (auch „Uhr“, „Std.“). Namen von Personen, Firmen, Marken, Orten und Straßen werden nicht übersetzt';
const AI_TR = {
  de: `Du übersetzt ins Deutsche. ${AI_TR_RULES}; in kyrillischer Schrift geschriebene Namen schreibst du in lateinischer Schrift (z. B. „Иван“ → „Iwan“). Ist ein Eintrag schon deutsch, gib ihn unverändert zurück. Antworte nur mit JSON: {"out": ["…", …]} in derselben Reihenfolge und Anzahl wie die Eingabe.`,
  ru: `Du übersetzt ins Russische. ${AI_TR_RULES} und bleiben in ihrer Schreibweise. Ist ein Eintrag schon russisch, gib ihn unverändert zurück. Antworte nur mit JSON: {"out": ["…", …]} in derselben Reihenfolge und Anzahl wie die Eingabe.`,
};
const AI_SITES = 'Du bekommst nummerierte Baustellen-Bezeichnungen, die Handwerker einer Firma in ihre Stundenzettel geschrieben haben. Fasse die zusammen, die sicher dieselbe Baustelle meinen (andere Schreibweise, Tippfehler, Abkürzung, Ort oder Kunde zusätzlich genannt oder weggelassen, Straße abgekürzt). Verschiedene Hausnummern, verschiedene Straßen, verschiedene Gebäude oder Kunden am selben Ort sind verschiedene Baustellen. Im Zweifel getrennt lassen. Antworte nur mit JSON: {"groups": [[Nummer, Nummer, …], …]} – nur Gruppen mit mindestens zwei Nummern.';

/** Workers AI ohne „Nachdenken“ (schneller, weniger Verbrauch); Ergebnis: geparstes JSON aus der Antwort */
async function aiJson(env, system, user, maxTokens) {
  const r = await env.AI.run(AI_MODEL, {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: maxTokens,
    temperature: 0,
    chat_template_kwargs: { enable_thinking: false },
  });
  const text = String(r?.choices?.[0]?.message?.content ?? r?.response ?? '');
  const m = text.match(/\{[\s\S]*\}/);
  return JSON.parse(m ? m[0] : text);
}

/** Verbrauch heute laut Cloudflare (ganzes Konto, Tag in UTC): je [verbraucht, Grenze]; null ohne Token oder bei Fehler */
async function cfUsage(env) {
  if (!env.CF_STATS_TOKEN || !env.CF_ACCOUNT_ID) return null;
  const now = new Date();
  const day = now.toISOString().slice(0, 10);
  const query = `query ($a: string!, $d: Date!, $s: Time!, $e: Time!) { viewer { accounts(filter: { accountTag: $a }) {
    workersInvocationsAdaptive(limit: 100, filter: { date: $d }) { sum { requests } }
    d1AnalyticsAdaptiveGroups(limit: 100, filter: { date: $d }) { sum { rowsRead rowsWritten } }
    aiInferenceAdaptiveGroups(limit: 100, filter: { datetime_geq: $s, datetime_leq: $e }) { sum { totalNeurons } }
  } } }`;
  try {
    const res = await fetch('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_STATS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query, variables: { a: env.CF_ACCOUNT_ID, d: day, s: `${day}T00:00:00Z`, e: now.toISOString() } }),
    });
    const acc = (await res.json())?.data?.viewer?.accounts?.[0];
    if (!acc) return null;
    const sum = (rows, f) => (rows || []).reduce((n, r) => n + (Number(r?.sum?.[f]) || 0), 0);
    return {
      day,
      requests: [sum(acc.workersInvocationsAdaptive, 'requests'), FREE_REQUESTS],
      read: [sum(acc.d1AnalyticsAdaptiveGroups, 'rowsRead'), FREE_ROWS_READ],
      write: [sum(acc.d1AnalyticsAdaptiveGroups, 'rowsWritten'), FREE_ROWS_WRITTEN],
      ai: [sum(acc.aiInferenceAdaptiveGroups, 'totalNeurons'), AI_FREE],
    };
  } catch {
    return null;
  }
}

// ───────── Wörterbuch: richtige Schreibweisen (nach der KI) ─────────

/** Nur Buchstaben und Ziffern, klein, ohne Akzente: „L'Oréal“, „l oreal“ und „Loreal“ ergeben „loreal“ */
const dictKey = (s) =>
  String(s ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/[^\p{L}\p{N}]/gu, '');
async function loadDict(db) {
  await db.exec('CREATE TABLE IF NOT EXISTS dict (key TEXT PRIMARY KEY, word TEXT NOT NULL, created INTEGER NOT NULL)');
  return (await db.prepare('SELECT key, word FROM dict ORDER BY word COLLATE NOCASE').all()).results;
}
/** Stand der Wörterbuch-Regeln (nur die Antwort ändert sich, nicht das gemerkte KI-Ergebnis) */
const DICT_V = 3;
/** Stand von Anweisung und Wörterbuch: ändert er sich, verwerfen die iPhones ihre gemerkten Prüfungen */
const spellVersion = async (dict) => (await sha256(`${AI_SPELL_V}|${DICT_V}|${dict.map((d) => d.word).join('|')}`)).slice(0, 12);
function editDistance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const t = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = t;
    }
  }
  return row[b.length];
}
/** Eintrag mit einem Tippfehler (ab 12 Buchstaben zwei, unter 6 keiner); erster Buchstabe und Ziffern müssen
 *  gleich sein, und nur ein Eintrag darf passen */
function dictFuzzy(key, dict) {
  if (key.length < 6) return null;
  const digits = key.replace(/\D/g, '');
  const hits = dict.filter((d) => {
    const max = Math.min(key.length, d.key.length) >= 12 ? 2 : 1;
    return d.key.length >= 6 && d.key[0] === key[0] && d.key.replace(/\D/g, '') === digits &&
      Math.abs(d.key.length - key.length) <= max && editDistance(key, d.key) <= max;
  });
  return hits.length === 1 ? hits[0].word : null;
}
/** Wortfolgen, deren Buchstaben einem Eintrag gleichen, in dessen Schreibweise bringen (längste Folge zuerst);
 *  Satzzeichen davor und dahinter bleiben. Einzelne Tippfehler erkennt es selbst (Eigennamen kennt die KI oft nicht):
 *  erst nach allen genauen Treffern, und ein angehängtes kurzes Wort zählt nicht als Tippfehler („Musterhaus B“) */
function applyDict(text, dict) {
  if (!dict.length || !text) return text;
  const map = new Map(dict.map((d) => [d.key, d.word]));
  // „star bucks“ hat mehr Wörter als „Starbucks“: bis zu zwei Wörter mehr als der längste Eintrag
  const maxWords = Math.max(...dict.map((d) => d.word.split(/\s+/).length)) + 2;
  const toks = text.split(' ');
  const out = [];
  /** Ersatz für die Folge aus n Wörtern ab i, oder null */
  const at = (i, n, fuzzy) => {
    const seg = toks.slice(i, i + n).join(' ');
    const pre = seg.match(/^[^\p{L}\p{N}]*/u)[0];
    const post = seg.slice(pre.length).match(/[^\p{L}\p{N}]*$/u)[0];
    const core = seg.slice(pre.length, seg.length - post.length);
    // innen nur Buchstaben, Ziffern, Leerzeichen, Apostroph, Bindestrich und Punkt (keine Kommas usw.)
    if (!core || /[^\p{L}\p{N}\s'’`´.\-]/u.test(core)) return null;
    const key = dictKey(core);
    if (!fuzzy) return map.has(key) ? pre + map.get(key) + post : null;
    if (n > 1 && dictKey(toks[i + n - 1]).length <= 2) return null;
    const word = dictFuzzy(key, dict);
    return word ? pre + word + post : null;
  };
  for (let i = 0; i < toks.length; ) {
    const most = Math.min(maxWords, toks.length - i);
    let hit = null;
    for (const fuzzy of [false, true]) {
      for (let n = most; n >= 1 && !hit; n--) {
        const word = at(i, n, fuzzy);
        if (word) hit = { word, n };
      }
      if (hit) break;
    }
    if (hit) {
      out.push(hit.word);
      i += hit.n;
    } else out.push(toks[i++]);
  }
  return out.join(' ');
}

/** Spalte version nachträglich anlegen (ältere Tabelle ohne sie); einmal je Worker-Instanz */
let versionColumn = false;
async function ensureVersionColumn(db) {
  if (versionColumn) return;
  try {
    await db.exec('ALTER TABLE members ADD COLUMN version TEXT');
  } catch {}
  versionColumn = true;
}

/** Laufender Monat in deutscher Zeit, z. B. „2026-10“ */
function currentMonth() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}

/** Vergleich ohne Zeitunterschied, damit sich der Code nicht Zeichen für Zeichen erraten lässt */
function sameCode(a, b) {
  const x = new TextEncoder().encode(String(a ?? '').trim().toLowerCase());
  const y = new TextEncoder().encode(String(b ?? '').trim().toLowerCase());
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0 && x.length > 0;
}

async function sha256(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function cors(req) {
  const origin = req.headers.get('Origin') || '';
  const ok = ORIGINS.includes(origin) || /^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(origin);
  return ok
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'GET, PUT, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Team-Code, X-Admin-Code',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : {};
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(s);

async function readBody(req) {
  const text = await req.text();
  if (text.length > MAX_BODY) throw new Error('zu groß');
  return JSON.parse(text);
}

// ───────── Web Push (RFC 8291 Verschlüsselung, RFC 8292 VAPID) ─────────

const enc = (s) => new TextEncoder().encode(s);
const b64u = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) out.set(p, (i += p.length) - p.length);
  return out;
}
async function hkdf(salt, ikm, info, len) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, len * 8));
}

/** Nachricht für ein Gerät verschlüsseln (aes128gcm, ein Datensatz) */
async function pushBody(sub, text) {
  const uaPublic = unb64u(sub.p256dh);
  const local = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', local.publicKey));
  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, local.privateKey, 256));
  const ikm = await hkdf(unb64u(sub.auth), secret, concat(enc('WebPush: info\0'), uaPublic, asPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await crypto.subtle.importKey('raw', await hkdf(salt, ikm, enc('Content-Encoding: aes128gcm\0'), 16), 'AES-GCM', false, ['encrypt']);
  const nonce = await hkdf(salt, ikm, enc('Content-Encoding: nonce\0'), 12);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, cek, concat(enc(text), new Uint8Array([2]))));
  const head = new Uint8Array(21);
  head.set(salt);
  new DataView(head.buffer).setUint32(16, 4096);
  head[20] = asPublic.length;
  return concat(head, asPublic, data);
}

/** Anmeldung beim Push-Dienst (Apple, Google …) per signiertem Token */
async function vapid(endpoint, env) {
  const jwk = JSON.parse(env.VAPID_JWK);
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64u(enc(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64u(enc(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: VAPID_SUB })));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, enc(`${head}.${claims}`));
  const pub = concat(new Uint8Array([4]), unb64u(jwk.x), unb64u(jwk.y));
  return `vapid t=${head}.${claims}.${b64u(sig)}, k=${b64u(pub)}`;
}

/** Alle Admin-Geräte benachrichtigen; abgelaufene Anmeldungen löschen */
async function notifyAdmins(db, env, payload) {
  if (!env.VAPID_JWK) return;
  await db.exec('CREATE TABLE IF NOT EXISTS push (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL, sent INTEGER)');
  const { results } = await db.prepare('SELECT endpoint, p256dh, auth, sent FROM push').all();
  for (const sub of results) {
    if (sub.sent && Date.now() - sub.sent < PUSH_GAP * 60000) continue;
    try {
      const res = await fetch(sub.endpoint, {
        method: 'POST',
        headers: { Authorization: await vapid(sub.endpoint, env), TTL: '86400', Urgency: 'normal', 'Content-Encoding': 'aes128gcm', 'Content-Type': 'application/octet-stream' },
        body: await pushBody(sub, JSON.stringify(payload)),
      });
      if (res.status === 404 || res.status === 410) await db.prepare('DELETE FROM push WHERE endpoint = ?').bind(sub.endpoint).run();
      else if (res.ok) await db.prepare('UPDATE push SET sent = ? WHERE endpoint = ?').bind(Date.now(), sub.endpoint).run();
    } catch {}
  }
}

export default {
  async fetch(req, env, ctx) {
    const h = cors(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    // Der Admin-Code gilt auch als Team-Code (der Admin tritt mit ihm bei)
    const teamCode = req.headers.get('X-Team-Code');
    if (!sameCode(teamCode, env.TEAM_CODE) && !sameCode(teamCode, env.ADMIN_CODE)) {
      // kurze Pause erschwert das Durchprobieren von Codes
      await new Promise((r) => setTimeout(r, 400));
      return json({ error: 'code' }, 401, h);
    }

    const db = env.DB;
    const month = currentMonth();
    // in einem Rutsch (eine Verbindung zur Datenbank statt vier nacheinander)
    await db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS members (member TEXT PRIMARY KEY, token TEXT NOT NULL, name TEXT, month TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, name TEXT, month TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL)'),
      db.prepare('DELETE FROM members WHERE month <> ?').bind(month),
      db.prepare('DELETE FROM posts WHERE month <> ?').bind(month),
    ]);

    const path = new URL(req.url).pathname;
    try {
      // Antwortzeit für die Server-Seite: so viel Arbeit wie jede Team-Anfrage, ohne Inhalt
      if (path === '/ping' && req.method === 'GET') return json({ ok: true }, 200, h);
      if (path === '/team' && req.method === 'GET') {
        const { results } = await db.prepare('SELECT member, name, updated, data FROM members WHERE month = ? ORDER BY name').bind(month).all();
        const members = results.map((r) => ({ member: r.member, name: r.name, updated: r.updated, sheets: JSON.parse(r.data) }));
        const posts = (await db.prepare('SELECT id, member, name, text, created FROM posts WHERE month = ? ORDER BY created DESC LIMIT 200').bind(month).all()).results;
        return json({ month, members, posts, spellV: await spellVersion(await loadDict(db)) }, 200, h);
      }

      if (path === '/post' && (req.method === 'POST' || req.method === 'DELETE')) {
        const body = await readBody(req);
        if (!validId(body.member) || !validId(body.token)) return json({ error: 'id' }, 400, h);
        // Nur wer im laufenden Monat einen Eintrag hat (Token geprüft), darf schreiben
        const me = await db.prepare('SELECT token, name FROM members WHERE member = ?').bind(body.member).first();
        if (!me) return json({ error: 'join' }, 403, h);
        if (me.token !== (await sha256(body.token))) return json({ error: 'token' }, 403, h);

        if (req.method === 'DELETE') {
          await db.prepare('DELETE FROM posts WHERE id = ? AND member = ?').bind(Number(body.id) || 0, body.member).run();
          return json({ ok: true }, 200, h);
        }
        const text = String(body.text ?? '').trim().slice(0, MAX_TEXT);
        if (!text) return json({ error: 'text' }, 400, h);
        const { n } = await db.prepare('SELECT COUNT(*) AS n FROM posts WHERE member = ? AND month = ?').bind(body.member, month).first();
        if (n >= MAX_POSTS) return json({ error: 'limit' }, 429, h);
        await db.prepare('INSERT INTO posts (member, name, month, text, created) VALUES (?, ?, ?, ?, ?)').bind(body.member, me.name, month, text, Date.now()).run();
        return json({ ok: true }, 200, h);
      }

      if (path === '/ai' && req.method === 'POST') {
        const body = await readBody(req);
        if (!validId(body.member) || !validId(body.token)) return json({ error: 'id' }, 400, h);
        const me = await db.prepare('SELECT token FROM members WHERE member = ?').bind(body.member).first();
        if (!me) return json({ error: 'join' }, 403, h);
        if (me.token !== (await sha256(body.token))) return json({ error: 'token' }, 403, h);
        if (!env.AI) return json({ error: 'ai' }, 503, h);
        await db.exec('CREATE TABLE IF NOT EXISTS ai_cache (key TEXT PRIMARY KEY, result TEXT NOT NULL, created INTEGER NOT NULL)');
        await db.exec('CREATE TABLE IF NOT EXISTS ai_use (member TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL, PRIMARY KEY (member, day))');
        const day = new Date().toISOString().slice(0, 10);
        if (Math.random() < 0.05) {
          await db.prepare('DELETE FROM ai_cache WHERE created < ?').bind(Date.now() - AI_CACHE_DAYS * 86400000).run();
          await db.prepare('DELETE FROM ai_use WHERE day < ?').bind(day).run();
        }
        const used = await db.prepare('SELECT n FROM ai_use WHERE member = ? AND day = ?').bind(body.member, day).first();
        const count = async () =>
          db.prepare('INSERT INTO ai_use (member, day, n) VALUES (?, ?, 1) ON CONFLICT(member, day) DO UPDATE SET n = n + 1').bind(body.member, day).run();
        const str = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);

        if (body.task === 'spell') {
          // Jeder Eintrag einzeln im Speicher: was die KI schon einmal geprüft hat (auch bei Kollegen), kostet nichts mehr.
          // Gespeichert wird das Ergebnis der KI; das Wörterbuch kommt erst beim Antworten dazu (Änderungen gelten sofort)
          const items = [...new Set((Array.isArray(body.items) ? body.items : []).map(str).filter(Boolean))].slice(0, 20);
          const dict = await loadDict(db);
          const v = await spellVersion(dict);
          const keys = await Promise.all(items.map(async (t) => `spell${AI_SPELL_V}:${await sha256(t)}`));
          const ai = new Map();
          if (items.length) {
            const { results } = await db.prepare(`SELECT key, result FROM ai_cache WHERE key IN (${keys.map(() => '?').join(', ')})`).bind(...keys).all();
            const found = new Map(results.map((r) => [r.key, r.result]));
            items.forEach((t, i) => found.has(keys[i]) && ai.set(t, found.get(keys[i])));
          }
          const todo = items.filter((t) => !ai.has(t));
          if (todo.length && !(used && used.n >= AI_PER_DAY)) {
            // Antwortet die KI nicht (Kontingent aufgebraucht, Fehler), gilt nur das Wörterbuch
            try {
              await count();
              // je Eintrag reichlich Platz (ein Token je Zeichen und JSON drumherum); abgeschnitten wäre die Antwort unbrauchbar
              const res = await aiJson(env, AI_SPELL, JSON.stringify(todo), 40 + todo.reduce((n, t) => n + t.length + 16, 0));
              if (Array.isArray(res.out) && res.out.length === todo.length) {
                const now = Date.now();
                await db.batch(
                  todo.map((t, i) => {
                    const fixed = str(res.out[i]) || t;
                    ai.set(t, fixed);
                    return db.prepare('INSERT OR REPLACE INTO ai_cache (key, result, created) VALUES (?, ?, ?)').bind(keys[items.indexOf(t)], fixed, now);
                  })
                );
              }
            } catch {}
          }
          return json({ v, out: items.map((t) => [t, applyDict(ai.get(t) ?? t, dict), ai.has(t)]) }, 200, h);
        }

        if (body.task === 'tr') {
          // Wie spell: jeder Eintrag einzeln gemerkt (für alle im Team); ohne Antwort der KI null (die App zeigt dann das Original)
          const to = body.to === 'ru' ? 'ru' : 'de';
          const s1000 = (v) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, 1000);
          const items = [...new Set((Array.isArray(body.items) ? body.items : []).map(s1000).filter(Boolean))].slice(0, 20);
          const keys = await Promise.all(items.map(async (t) => `tr${AI_TR_V}:${to}:${await sha256(t)}`));
          const done = new Map();
          if (items.length) {
            const { results } = await db.prepare(`SELECT key, result FROM ai_cache WHERE key IN (${keys.map(() => '?').join(', ')})`).bind(...keys).all();
            const found = new Map(results.map((r) => [r.key, r.result]));
            items.forEach((t, i) => found.has(keys[i]) && done.set(t, found.get(keys[i])));
          }
          const todo = items.filter((t) => !done.has(t));
          if (todo.length && !(used && used.n >= AI_PER_DAY)) {
            try {
              await count();
              // Kyrillisch braucht mehr Tokens je Zeichen als Deutsch
              const res = await aiJson(env, AI_TR[to], JSON.stringify(todo), 60 + todo.reduce((n, t) => n + t.length * 2 + 20, 0));
              if (Array.isArray(res.out) && res.out.length === todo.length) {
                const now = Date.now();
                const rows = [];
                todo.forEach((t, i) => {
                  const x = s1000(res.out[i]);
                  if (!x) return;
                  done.set(t, x);
                  rows.push(db.prepare('INSERT OR REPLACE INTO ai_cache (key, result, created) VALUES (?, ?, ?)').bind(keys[items.indexOf(t)], x, now));
                });
                if (rows.length) await db.batch(rows);
              }
            } catch {}
          }
          return json({ out: items.map((t) => [t, done.get(t) ?? null]) }, 200, h);
        }

        if (body.task === 'sites') {
          const names = [...new Set((Array.isArray(body.names) ? body.names : []).map(str).filter(Boolean))].sort().slice(0, 200);
          if (names.length < 2) return json({ groups: [] }, 200, h);
          const key = `sites:${await sha256(names.join('\n'))}`;
          const row = await db.prepare('SELECT result FROM ai_cache WHERE key = ?').bind(key).first();
          if (row) return json({ groups: JSON.parse(row.result) }, 200, h);
          if (used && used.n >= AI_PER_DAY) return json({ error: 'limit' }, 429, h);
          await count();
          const res = await aiJson(env, AI_SITES, names.map((n, i) => `${i + 1}: ${n}`).join('\n'), 60 + names.length * 8);
          const groups = (Array.isArray(res.groups) ? res.groups : [])
            .map((g) => [...new Set((Array.isArray(g) ? g : []).map((i) => names[Number(i) - 1]).filter(Boolean))])
            .filter((g) => g.length >= 2);
          await db.prepare('INSERT OR REPLACE INTO ai_cache (key, result, created) VALUES (?, ?, ?)').bind(key, JSON.stringify(groups), Date.now()).run();
          return json({ groups }, 200, h);
        }
        return json({ error: 'task' }, 400, h);
      }

      if (path === '/error' && req.method === 'POST') {
        const body = await readBody(req);
        if (!validId(body.member) || !Array.isArray(body.reports)) return json({ error: 'id' }, 400, h);
        // Fehlerberichte nicht mit dem Monat löschen, sondern erst nach ERROR_DAYS Tagen
        await db.exec('CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, name TEXT, version TEXT, ua TEXT, view TEXT, message TEXT NOT NULL, stack TEXT, count INTEGER NOT NULL, first INTEGER, last INTEGER, created INTEGER NOT NULL)');
        await db.prepare('DELETE FROM errors WHERE created < ?').bind(Date.now() - ERROR_DAYS * 86400000).run();
        // Mit Eintrag im laufenden Monat muss das Token passen; ohne (z. B. gleich nach dem Monatswechsel) reicht der Code
        const me = await db.prepare('SELECT token, name FROM members WHERE member = ?').bind(body.member).first();
        if (me && me.token !== (await sha256(String(body.token ?? '')))) return json({ error: 'token' }, 403, h);
        const since = Date.now() - 86400000;
        const { n } = await db.prepare('SELECT COUNT(*) AS n FROM errors WHERE member = ? AND created > ?').bind(body.member, since).first();
        const reports = body.reports.slice(0, Math.max(0, MAX_ERRORS - n));
        if (!reports.length) return json({ error: 'limit' }, 429, h);
        const str = (v, k) => String(v ?? '').slice(0, k);
        const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
        const now = Date.now();
        await db.batch(
          reports.map((r) =>
            db
              .prepare('INSERT INTO errors (member, name, version, ua, view, message, stack, count, first, last, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
              .bind(body.member, me ? me.name : str(body.name, 40), str(body.version, 40), str(body.ua, 200), str(r && r.view, 60), str(r && r.message, 300) || '?', str(r && r.stack, 2000), Math.max(1, Math.min(1e6, num(r && r.count) || 1)), num(r && r.first), num(r && r.last), now)
          )
        );
        const who = (me ? me.name : str(body.name, 40)) || 'Jemand';
        ctx.waitUntil(notifyAdmins(db, env, { title: 'Fehlerbericht', body: `${who}: ${str(reports[0] && reports[0].message, 120)}${reports.length > 1 ? ` (+${reports.length - 1})` : ''}` }));
        return json({ ok: true }, 200, h);
      }

      if (path === '/errors' || path === '/push' || path === '/dict') {
        // Nur für den Admin: falscher Code wie beim Team-Code mit kurzer Pause
        if (!sameCode(req.headers.get('X-Admin-Code'), env.ADMIN_CODE)) {
          await new Promise((r) => setTimeout(r, 400));
          return json({ error: 'admin' }, 403, h);
        }
        if (path === '/errors' && req.method === 'GET') {
          // Zahlen von Cloudflare dauern am längsten: gleich anfragen, die Datenbank läuft währenddessen
          const usage = cfUsage(env);
          await ensureVersionColumn(db);
          // Speicher: Größe der ganzen Datenbank (meta.size_after) und Bytes je Inhalt; der Rest ist die Datenbank selbst
          const bytes = (cols) => cols.map((c) => `COALESCE(LENGTH(CAST(${c} AS BLOB)), 0)`).join(' + ');
          const [, , errors, size, people, posts, dict] = await db.batch([
            db.prepare('CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, name TEXT, version TEXT, ua TEXT, view TEXT, message TEXT NOT NULL, stack TEXT, count INTEGER NOT NULL, first INTEGER, last INTEGER, created INTEGER NOT NULL)'),
            db.prepare('CREATE TABLE IF NOT EXISTS dict (key TEXT PRIMARY KEY, word TEXT NOT NULL, created INTEGER NOT NULL)'),
            db.prepare('SELECT id, name, version, ua, view, message, stack, count, first, last, created FROM errors ORDER BY created DESC LIMIT 50'),
            db.prepare(
              `SELECT (SELECT COALESCE(SUM(${bytes(['member', 'token', 'name', 'month', 'data', 'version'])}), 0) FROM members) AS sheets, ` +
                `(SELECT COALESCE(SUM(${bytes(['member', 'name', 'month', 'text'])}), 0) FROM posts) AS posts, ` +
                `(SELECT COALESCE(SUM(${bytes(['member', 'name', 'version', 'ua', 'view', 'message', 'stack'])}), 0) FROM errors) AS errors`
            ),
            // Team diesen Monat: je Person App-Version, letzter Upload, Zahl der Zettel
            db.prepare('SELECT name, version, updated, json_array_length(data) AS sheets FROM members WHERE month = ? ORDER BY name').bind(month),
            db.prepare('SELECT COUNT(*) AS n FROM posts WHERE month = ?').bind(month),
            db.prepare('SELECT word FROM dict ORDER BY word COLLATE NOCASE'),
          ]);
          const s = size.results[0];
          const storage = { total: size.meta.size_after || 0, limit: STORAGE_LIMIT, sheets: s.sheets, posts: s.posts, errors: s.errors };
          const team = { month, people: people.results, posts: posts.results[0].n };
          return json({ errors: errors.results, storage, team, dict: dict.results.map((d) => d.word), usage: await usage }, 200, h);
        }
        if (path === '/dict' && (req.method === 'PUT' || req.method === 'DELETE')) {
          const body = await readBody(req);
          const word = String(body.word ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
          const key = dictKey(word);
          if (!key) return json({ error: 'word' }, 400, h);
          await loadDict(db);
          if (req.method === 'DELETE') await db.prepare('DELETE FROM dict WHERE key = ?').bind(key).run();
          else await db.prepare('INSERT OR REPLACE INTO dict (key, word, created) VALUES (?, ?, ?)').bind(key, word, Date.now()).run();
          return json({ dict: (await loadDict(db)).map((d) => d.word) }, 200, h);
        }
        if (path === '/push' && (req.method === 'PUT' || req.method === 'DELETE')) {
          const body = await readBody(req);
          const endpoint = String(body.endpoint ?? '');
          if (!/^https:\/\/[^\s]{10,1000}$/.test(endpoint)) return json({ error: 'endpoint' }, 400, h);
          await db.exec('CREATE TABLE IF NOT EXISTS push (endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL, sent INTEGER)');
          if (req.method === 'DELETE') {
            await db.prepare('DELETE FROM push WHERE endpoint = ?').bind(endpoint).run();
            return json({ ok: true }, 200, h);
          }
          const keys = body.keys || {};
          if (typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') return json({ error: 'keys' }, 400, h);
          await db
            .prepare('INSERT INTO push (endpoint, p256dh, auth, created) VALUES (?, ?, ?, ?) ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth')
            .bind(endpoint, keys.p256dh.slice(0, 200), keys.auth.slice(0, 100), Date.now())
            .run();
          return json({ ok: true }, 200, h);
        }
      }

      if (path === '/me' && (req.method === 'PUT' || req.method === 'DELETE')) {
        const body = await readBody(req);
        if (!validId(body.member) || !validId(body.token)) return json({ error: 'id' }, 400, h);
        const token = await sha256(body.token);
        const row = await db.prepare('SELECT token FROM members WHERE member = ?').bind(body.member).first();
        if (row && row.token !== token) return json({ error: 'token' }, 403, h);

        if (req.method === 'DELETE') {
          await db.prepare('DELETE FROM members WHERE member = ?').bind(body.member).run();
          return json({ ok: true }, 200, h);
        }
        // Zettel eines anderen Monats (Uhr des iPhones geht falsch, Monatswechsel) nicht speichern
        if (body.month !== month) return json({ error: 'month', month }, 409, h);
        if (!Array.isArray(body.sheets)) return json({ error: 'sheets' }, 400, h);
        const name = String(body.name ?? '').slice(0, 80);
        const version = String(body.version ?? '').slice(0, 40) || null;
        await ensureVersionColumn(db);
        await db
          .prepare(
            'INSERT INTO members (member, token, name, month, data, updated, version) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT(member) DO UPDATE SET name = excluded.name, month = excluded.month, data = excluded.data, updated = excluded.updated, version = excluded.version'
          )
          .bind(body.member, token, name, month, JSON.stringify(body.sheets), Date.now(), version)
          .run();
        return json({ ok: true }, 200, h);
      }
    } catch (e) {
      return json({ error: 'body' }, 400, h);
    }
    return json({ error: 'not found' }, 404, h);
  },
};
