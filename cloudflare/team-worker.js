// Std-Protokoll – Team-Speicher (Cloudflare Worker mit D1-Datenbank in der EU)
//
// Jedes iPhone legt hier die Stundenzettel des laufenden Monats ab (ein Eintrag je Gerät, wird bei jeder
// Änderung überschrieben). Lesen nur mit Team-Code und Konto. Einträge aus älteren Monaten (außer dem Vormonat)
// löscht der Worker bei jeder Anfrage.
//
// Einrichtung im Cloudflare-Dashboard:
//   - D1-Datenbank (Jurisdiction „EU“) als Binding mit dem Namen DB
//   - Workers AI als Binding mit dem Namen AI (Rechtschreibung, gleiche Baustellen)
//   - Durable Object als Binding mit dem Namen ARENA, Klasse Arena (SQLite-Klasse, im kostenlosen Tarif)
//   - Secret TEAM_CODE: der Team-Code, den die Kollegen eingeben (bis er auf der Server-Seite geändert wird, siehe PUT /code)
// Die Tabelle legt der Worker selbst an.
//
// Anfragen (Code im Header X-Team-Code):
//   GET    /ping   → { ok }   nur zum Messen der Antwortzeit
//   GET    /team   Header X-User, X-Auth (Konto, sonst 403 'konto') → { month, members: [{ member, name, updated, sheets }], prev: { month, members }, posts: [{ id, member, name, text, created }], spellV }
//                    prev: Zettel des Vormonats (Tabelle history); posts: die letzten POSTS_KEEP Nachrichten (nicht mehr monatlich gelöscht)
//                    spellV: Stand von Anweisung und Wörterbuch (wie v bei /ai; ändert er sich, prüfen die iPhones neu)
//   PUT    /me     ← { member, token, name, month, sheets, version, prev: { month, sheets } }   eigener Eintrag (version: App-Version für die Admin-Seite)
//                    nur, wenn ein Konto den Eintrag kennt (sonst 403 'konto')
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
//   POST   /arena  Header X-User, X-Auth ← { name }            → { ticket } Eintrittskarte für die Arena (2 min)
//   GET    /arena/ws?t=<ticket>  WebSocket zur Arena (Durable Object ARENA, Klasse Arena; Nachrichten siehe dort)
// Konten (Benutzername + Passwort, für das Team Pflicht) und verschlüsselte Sicherungen. Das iPhone leitet aus dem
// Passwort zwei Schlüssel ab: auth (hier nur als SHA-256 gespeichert) und den Sicherungs-Schlüssel (verlässt das iPhone
// nie). Sicherungen kommen also schon verschlüsselt an; der Server kann sie nicht lesen.
//   POST   /account ← { action: 'join', user, auth, mode: 'create' | 'login', member, token, name }
//                    → { member, backups }  Konto anlegen bzw. prüfen und mit dem Team-Eintrag verbinden. Hat das Konto
//                    schon einen Eintrag, gilt dessen Kennung (neues Token); ein mitgeschickter anderer Eintrag
//                    mit passendem Token wird gelöscht (keine Doppelten nach Neuinstallation)
//                  ← { action: 'list', user, auth }                      → { backups: [{ at, size }] } neueste zuerst
//                  ← { action: 'get', user, auth, at }                   → { data }
//                  ← { action: 'password', user, auth, newAuth }         → neues Passwort; alte Sicherungen werden gelöscht
//                  ← { action: 'delete', user, auth }                    Konto und Sicherungen löschen
//   PUT    /backup  Header X-User, X-Auth; Inhalt = verschlüsselte Sicherung (Text)  → { at }
//                    Behalten: die drei neuesten und je Tag (deutsche Zeit) die letzte der vergangenen BACKUP_DAYS Tage
// Arbeitsscheine aus einer Arbeitsschein-App (ohne Team-Code, Header X-Report-Key = Secret REPORT_KEY, jede Herkunft):
//   POST   /reports ← Schein (Format „arbeitsschein/1“, siehe checkReport) → { ok, empfaenger, offen }
//                    Empfänger: Verfasser und alle Mitarbeiter, zugeordnet über den echten Namen (voller Name aus den
//                    Einstellungen des Kontos, Schreibweise großzügig, siehe nameKey) oder eine Zuordnung des Admins;
//                    ein mitgeschickter Benutzername geht vor. Nicht eindeutige Namen warten in report_open, bis der
//                    Admin sie auf der Server-Seite zuordnet. Gleiche id ersetzt; wer nicht mehr draufsteht, verliert ihn
//   DELETE /reports ← { id }                                   Schein zurückziehen
//   Abholen mit Konto: POST /account { action: 'reports', since, fullname } → { reports: [{ id, data, changed, deleted }], names }
//   Tabellen reports (je Empfänger eine Zeile), report_open (wartende Namen), report_alias (Zuordnungen); 60 Tage
// Nur mit Admin-Code (Header X-Admin-Code, Secret ADMIN_CODE; er gilt auch als Team-Code):
//   GET    /errors → { errors, storage, team, dict, accounts, code, usage } die letzten Fehlerberichte, Speicherbelegung, Team diesen Monat,
//                                                              Wörterbuch, Tagesgrenzen von Cloudflare (siehe cfUsage)
//   PUT    /dict   ← { word }                                  richtige Schreibweise ins Wörterbuch
//   DELETE /dict   ← { word }                                  aus dem Wörterbuch löschen
//   DELETE /account ← { user }                                 Konto samt Sicherungen löschen (z. B. Passwort vergessen)
//   PUT    /alias  ← { key, user }                             wartenden Namen einem Konto zuordnen (wird gemerkt, Scheine zugestellt)
//   DELETE /alias  ← { key }                                   wartenden Namen verwerfen (z. B. Aushilfe ohne Konto)
//   PUT    /code   ← { code }                                  neuer Team-Code (gilt sofort; alle müssen ihn neu eingeben) → { code }
//   DELETE /member ← { member }                                Person aus dem Team entfernen (z. B. doppelt nach Neuinstallation;
//                                                              benutzt sie die App noch, erscheint sie beim nächsten Upload wieder)
//   PUT    /push   ← { endpoint, keys: { p256dh, auth } }      Gerät für Mitteilungen anmelden
//   DELETE /push   ← { endpoint }                              abmelden
// Tagesgrenzen: Secret CF_STATS_TOKEN (API-Token nur mit „Konto-Analysen: Lesen“) und Variable CF_ACCOUNT_ID
// Web Push: Secret VAPID_JWK (privater Schlüssel als JWK), öffentlicher Schlüssel steht in fehler-seite.js

const ORIGINS = ['https://y4t6bgp6g6-maker.github.io'];
const MAX_BODY = 1_000_000;
const MAX_TEXT = 500;
const MAX_POSTS = 300; // je Person und Monat
const POSTS_KEEP = 300; // Teammeeting: so viele Nachrichten bleiben; jede neue verdrängt dann die älteste
const MAX_ERRORS = 30; // Fehlerberichte je Gerät und Tag
const ERROR_DAYS = 180;
const PUSH_GAP = 10;
const VAPID_SUB = 'https://y4t6bgp6g6-maker.github.io/std-protokoll/';
const STORAGE_LIMIT = 500 * 1024 * 1024; // D1 im kostenlosen Tarif: 500 MB je Datenbank
const BACKUP_MAX = 20_000_000; // Zeichen je Sicherung (mit Bildern aus dem Berichtsheft)
const BACKUP_PART = 900_000; // D1: höchstens 2 MB je Zeile, also in Teilen speichern
const BACKUP_DAYS = 7;
const AUTH_FAILS = 5; // falsche Passwörter, danach AUTH_WAIT Minuten Pause
const AUTH_WAIT = 10;
const REPORT_MAX = 200_000; // Zeichen je Arbeitsschein
const REPORT_DAYS = 60;
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

/** Vormonat zu „2026-10“ → „2026-09“ */
function prevMonthOf(month) {
  const [y, m] = month.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}
const HISTORY_TABLE = 'CREATE TABLE IF NOT EXISTS history (member TEXT NOT NULL, month TEXT NOT NULL, name TEXT, data TEXT NOT NULL, updated INTEGER NOT NULL, PRIMARY KEY (member, month))';
/** Zettel des Vormonats speichern (nur, wenn neuer als der gespeicherte Stand) */
const HISTORY_SET = 'ON CONFLICT(member, month) DO UPDATE SET name = excluded.name, data = excluded.data, updated = excluded.updated WHERE excluded.updated > history.updated';

/** Laufender Monat in deutscher Zeit, z. B. „2026-10“ */
function currentMonth() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}

/** Team-Code: auf der Server-Seite änderbar (Tabelle config), sonst das Secret TEAM_CODE.
 *  Kurz zwischengespeichert, damit nicht jede Anfrage die Datenbank fragt (andere Instanzen nehmen den alten Code
 *  danach noch bis zu TEAM_CODE_CACHE ms an) */
const TEAM_CODE_CACHE = 30000;
let teamCodeCache = null;
async function currentTeamCode(env) {
  if (teamCodeCache && Date.now() - teamCodeCache.at < TEAM_CODE_CACHE) return teamCodeCache.code;
  let code = env.TEAM_CODE;
  try {
    const row = await env.DB.prepare("SELECT value FROM config WHERE key = 'team_code'").first();
    if (row && row.value) code = row.value;
  } catch (e) {
    // Tabelle gibt es erst nach der ersten Änderung; jeder andere Fehler darf nicht zum alten Code zurückfallen
    if (!/no such table/i.test(String(e && e.message))) throw e;
  }
  teamCodeCache = { code, at: Date.now() };
  return code;
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
        'Access-Control-Allow-Headers': 'Content-Type, X-Team-Code, X-Admin-Code, X-User, X-Auth',
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

// ───────── Konten und Sicherungen ─────────

const ACCOUNT_TABLES = [
  'CREATE TABLE IF NOT EXISTS accounts (user TEXT PRIMARY KEY, auth TEXT NOT NULL, member TEXT, name TEXT, created INTEGER NOT NULL, fails INTEGER NOT NULL DEFAULT 0, failed INTEGER)',
  'CREATE TABLE IF NOT EXISTS backups (user TEXT NOT NULL, at INTEGER NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL, size INTEGER NOT NULL, data TEXT NOT NULL, PRIMARY KEY (user, at, part))',
];
/** Benutzername: 3–32 Buchstaben, Ziffern, Punkt, Strich, Unterstrich; Groß/klein egal */
const userKey = (s) => {
  const u = String(s ?? '').trim().toLowerCase();
  return /^[\p{L}\p{N}._-]{3,32}$/u.test(u) ? u : '';
};
/** Benutzername aus dem Header X-User (kodiert, Header erlauben keine kyrillischen Buchstaben) */
const headerUser = (req) => {
  const v = req.headers.get('X-User') || '';
  try {
    return userKey(decodeURIComponent(v));
  } catch {
    return userKey(v);
  }
};
const validAuth = (s) => typeof s === 'string' && /^[A-Za-z0-9+/=]{40,64}$/.test(s);

/** Konto mit Passwort-Prüfwert prüfen; nach AUTH_FAILS Fehlversuchen AUTH_WAIT Minuten gesperrt.
 *  Ergebnis: Zeile des Kontos oder { error, status } */
async function checkAccount(db, user, auth) {
  if (!user || !validAuth(auth)) return { error: 'id', status: 400 };
  const row = await db.prepare('SELECT * FROM accounts WHERE user = ?').bind(user).first();
  if (!row) return { error: 'unknown', status: 404 };
  if (row.fails >= AUTH_FAILS && Date.now() - (row.failed || 0) < AUTH_WAIT * 60000) return { error: 'wait', status: 429 };
  if (!sameCode(await sha256(auth), row.auth)) {
    await db.prepare('UPDATE accounts SET fails = CASE WHEN ? - COALESCE(failed, 0) > ? THEN 1 ELSE fails + 1 END, failed = ? WHERE user = ?')
      .bind(Date.now(), AUTH_WAIT * 60000, Date.now(), user).run();
    await new Promise((r) => setTimeout(r, 400));
    return { error: 'auth', status: 403 };
  }
  if (row.fails) await db.prepare('UPDATE accounts SET fails = 0 WHERE user = ?').bind(user).run();
  return row;
}

/** Sicherungen eines Kontos: [{ at, size }], neueste zuerst */
const backupList = async (db, user) =>
  (await db.prepare('SELECT at, size FROM backups WHERE user = ? AND part = 0 ORDER BY at DESC').bind(user).all()).results;

/** Tag in deutscher Zeit („2026-10-15“) */
const berlinDay = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date(t));

/** Behalten: die drei neuesten (ein versehentlich gesicherter leerer Stand verdrängt den guten nicht gleich) und je Tag
 *  die letzte der vergangenen BACKUP_DAYS Tage; der Rest wird gelöscht */
async function pruneBackups(db, user) {
  const list = await backupList(db, user);
  const days = new Set();
  const drop = [];
  list.forEach((b, i) => {
    const day = berlinDay(b.at);
    if (i < 3 || (!days.has(day) && Date.now() - b.at < BACKUP_DAYS * 86400e3)) days.add(day);
    else drop.push(b.at);
  });
  if (drop.length) await db.batch(drop.map((at) => db.prepare('DELETE FROM backups WHERE user = ? AND at = ?').bind(user, at)));
}

async function accountRequest(db, body, h) {
  const user = userKey(body.user);
  if (body.action === 'join') {
    if (!user || !validAuth(body.auth) || !validId(body.member) || !validId(body.token)) return json({ error: 'id' }, 400, h);
    const name = String(body.name ?? '').slice(0, 80);
    const fullname = String(body.fullname ?? '').trim().slice(0, 80);
    await ensureFullname(db);
    const token = await sha256(body.token);
    // mitgeschickter Eintrag: gehört er wirklich diesem iPhone? (Token passt oder es gibt ihn diesen Monat nicht)
    const sent = await db.prepare('SELECT token FROM members WHERE member = ?').bind(body.member).first();
    const sentOwn = !sent || sent.token === token;
    const exists = await db.prepare('SELECT user FROM accounts WHERE user = ?').bind(user).first();
    if (!exists) {
      if (body.mode !== 'create') return json({ error: 'unknown' }, 404, h);
      if (!sentOwn) return json({ error: 'token' }, 403, h);
      // ein Team-Eintrag gehört nur zu einem Konto (z. B. abgemeldet und neues Konto auf demselben iPhone)
      await db.batch([
        db.prepare('UPDATE accounts SET member = NULL WHERE member = ?').bind(body.member),
        db.prepare('INSERT INTO accounts (user, auth, member, name, fullname, created) VALUES (?, ?, ?, ?, ?, ?)').bind(user, await sha256(body.auth), body.member, name, fullname || null, Date.now()),
      ]);
      return json({ member: body.member, backups: [] }, 200, h);
    }
    const row = await checkAccount(db, user, body.auth);
    // falsches Passwort beim Anlegen: der Name gehört jemand anderem
    if (row.error) return json({ error: row.error === 'auth' && body.mode === 'create' ? 'taken' : row.error }, row.status, h);
    const member = validId(row.member) ? row.member : body.member;
    const ops = [
      db.prepare('UPDATE accounts SET member = NULL WHERE member = ? AND user <> ?').bind(member, user),
      db.prepare('UPDATE accounts SET member = ?, name = COALESCE(NULLIF(?, \'\'), name), fullname = COALESCE(NULLIF(?, \'\'), fullname) WHERE user = ?').bind(member, name, fullname, user),
    ];
    // Eintrag des Kontos übernimmt das neue Token; ein anderer, frisch angelegter Eintrag dieses iPhones verschwindet
    ops.push(db.prepare('UPDATE members SET token = ? WHERE member = ?').bind(token, member));
    if (member !== body.member && sent && sentOwn) ops.push(db.prepare('DELETE FROM members WHERE member = ?').bind(body.member));
    await db.batch(ops);
    return json({ member, backups: await backupList(db, user) }, 200, h);
  }
  const row = await checkAccount(db, user, body.auth);
  if (row.error) return json({ error: row.error }, row.status, h);
  if (body.action === 'list') return json({ backups: await backupList(db, user) }, 200, h);
  if (body.action === 'reports') {
    await reportTables(db);
    await ensureFullname(db);
    const since = Number(body.since) || 0;
    // voller Name aus den Einstellungen (für die Zuordnung der Arbeitsscheine), nur wenn geändert
    const fullname = String(body.fullname ?? '').trim().slice(0, 80);
    if (fullname && fullname !== row.fullname) await db.prepare('UPDATE accounts SET fullname = ? WHERE user = ?').bind(fullname, user).run();
    const [rows, names] = await db.batch([
      db.prepare('SELECT id, data, changed, deleted FROM reports WHERE user = ? AND changed > ? ORDER BY changed LIMIT 200').bind(user, since),
      db.prepare('SELECT user, name FROM accounts'),
    ]);
    return json({ reports: rows.results, names: Object.fromEntries(names.results.map((x) => [x.user, x.name || ''])) }, 200, h);
  }
  if (body.action === 'get') {
    const parts = (await db.prepare('SELECT data FROM backups WHERE user = ? AND at = ? ORDER BY part').bind(user, Number(body.at) || 0).all()).results;
    if (!parts.length) return json({ error: 'missing' }, 404, h);
    return json({ data: parts.map((p) => p.data).join('') }, 200, h);
  }
  if (body.action === 'password') {
    if (!validAuth(body.newAuth)) return json({ error: 'id' }, 400, h);
    // alte Sicherungen sind mit dem alten Passwort verschlüsselt – mit dem neuen ließen sie sich nicht öffnen
    await db.batch([
      db.prepare('UPDATE accounts SET auth = ? WHERE user = ?').bind(await sha256(body.newAuth), user),
      db.prepare('DELETE FROM backups WHERE user = ?').bind(user),
    ]);
    return json({ ok: true }, 200, h);
  }
  if (body.action === 'delete') {
    await db.batch([db.prepare('DELETE FROM backups WHERE user = ?').bind(user), db.prepare('DELETE FROM accounts WHERE user = ?').bind(user)]);
    return json({ ok: true }, 200, h);
  }
  return json({ error: 'action' }, 400, h);
}

// ───────── Arbeitsscheine ─────────

const REPORT_TABLE = 'CREATE TABLE IF NOT EXISTS reports (id TEXT NOT NULL, user TEXT NOT NULL, data TEXT NOT NULL, changed INTEGER NOT NULL, deleted INTEGER, PRIMARY KEY (id, user))';
/** CORS für die Arbeitsschein-App: jede Herkunft (geschützt durch den Schlüssel) */
const REPORT_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Report-Key',
  'Access-Control-Max-Age': '86400',
};

/** Name zum Vergleichen: Groß/klein, Leerzeichen, Akzente, ä/ae, ß/ss und Reihenfolge („Muster, Max“) egal */
const nameKey = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .sort()
    .join(' ');

/** Schein prüfen; Ergebnis: Fehlertext (welches Feld) oder '' */
function checkReport(r) {
  const str = (v, max, opt) => (v == null || v === '' ? opt : typeof v === 'string' && v.length <= max);
  const arr = (v, max) => Array.isArray(v) && v.length <= max;
  const hm = (v) => typeof v === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(v);
  const min = (v) => v == null || (Number.isInteger(v) && v >= 0 && v <= 1440);
  const person = (m) => m && typeof m === 'object' && str(m.name, 80, false) && nameKey(m.name) && str(m.benutzer, 40, true);
  if (!r || typeof r !== 'object') return 'Inhalt';
  if (r.format !== 'arbeitsschein/1') return 'format';
  if (typeof r.id !== 'string' || !/^[A-Za-z0-9._:-]{1,100}$/.test(r.id)) return 'id';
  if (!str(r.nummer, 40, false)) return 'nummer';
  if (r.erstellt != null && !(typeof r.erstellt === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(r.erstellt))) return 'erstellt';
  if (!person(r.verfasser)) return 'verfasser';
  const ra = r.rechnungsadresse || {};
  for (const k of ['name', 'strasse', 'plz', 'ort']) if (!str(ra[k], 200, true)) return `rechnungsadresse.${k}`;
  const pr = r.projekt || {};
  for (const k of ['name', 'email']) if (!str(pr[k], 200, true)) return `projekt.${k}`;
  if (!(ra.name || pr.name)) return 'projekt.name';
  if (!arr(r.einsaetze, 62) || !r.einsaetze.length) return 'einsaetze';
  for (const [i, e] of r.einsaetze.entries()) {
    const at = `einsaetze[${i}]`;
    if (!e || typeof e.datum !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.datum)) return `${at}.datum`;
    if (!hm(e.beginn)) return `${at}.beginn`;
    if (!hm(e.ende)) return `${at}.ende`;
    for (const k of ['pause_min', 'fahrzeit_min', 'arbeitszeit_min']) if (!min(e[k])) return `${at}.${k}`;
    if (e.km != null && !(typeof e.km === 'number' && e.km >= 0 && e.km < 100000)) return `${at}.km`;
    if (!arr(e.mitarbeiter, 30)) return `${at}.mitarbeiter`;
    for (const [k, m] of e.mitarbeiter.entries()) if (!person(m)) return `${at}.mitarbeiter[${k}]`;
  }
  if (!arr(r.arbeiten, 50) || !r.arbeiten.every((t) => str(t, 4000, false))) return 'arbeiten';
  if (r.pauschalen != null && !(arr(r.pauschalen, 200) && r.pauschalen.every((p) => p && str(p.bezeichnung, 200, true) && str(p.anzahl, 40, true) && str(p.bemerkung, 400, true))))
    return 'pauschalen';
  if (r.material != null && !(arr(r.material, 200) && r.material.every((m) => m && str(m.bezeichnung, 200, false) && str(m.anzahl, 40, true) && str(m.einheit, 40, true))))
    return 'material';
  return '';
}

const REPORT_OPEN = 'CREATE TABLE IF NOT EXISTS report_open (id TEXT NOT NULL, key TEXT NOT NULL, name TEXT NOT NULL, data TEXT NOT NULL, changed INTEGER NOT NULL, PRIMARY KEY (id, key))';
const REPORT_ALIAS = 'CREATE TABLE IF NOT EXISTS report_alias (key TEXT PRIMARY KEY, user TEXT NOT NULL)';
const reportTables = (db) => db.batch([REPORT_TABLE, REPORT_OPEN, REPORT_ALIAS, ...ACCOUNT_TABLES].map((sql) => db.prepare(sql)));
/** Voller Name je Konto (aus den Einstellungen); Spalte bei älteren Datenbanken nachrüsten */
let fullnameColumn = false;
async function ensureFullname(db) {
  if (fullnameColumn) return;
  try {
    await db.exec('ALTER TABLE accounts ADD COLUMN fullname TEXT');
  } catch {}
  fullnameColumn = true;
}

/** Schein an ein Konto geben (ersetzt seine frühere Fassung) */
const deliver = (db, id, user, text, now) =>
  db
    .prepare('INSERT INTO reports (id, user, data, changed, deleted) VALUES (?, ?, ?, ?, NULL) ON CONFLICT(id, user) DO UPDATE SET data = excluded.data, changed = excluded.changed, deleted = NULL')
    .bind(id, user, text, now);

async function reportsRequest(db, req, env, h) {
  if (!env.REPORT_KEY || !sameCode(req.headers.get('X-Report-Key'), env.REPORT_KEY)) {
    await new Promise((r) => setTimeout(r, 400));
    return json({ error: 'key' }, 401, h);
  }
  const text = await req.text();
  if (text.length > REPORT_MAX) return json({ error: 'size' }, 413, h);
  let r;
  try {
    r = JSON.parse(text);
  } catch {
    return json({ error: 'json' }, 400, h);
  }
  await reportTables(db);
  await ensureFullname(db);
  const now = Date.now();
  if (req.method === 'DELETE') {
    if (typeof r?.id !== 'string' || !r.id) return json({ error: 'id' }, 400, h);
    await db.batch([
      db.prepare("UPDATE reports SET data = '', deleted = ?, changed = ? WHERE id = ?").bind(now, now, r.id),
      db.prepare('DELETE FROM report_open WHERE id = ?').bind(r.id),
    ]);
    return json({ ok: true }, 200, h);
  }
  const bad = checkReport(r);
  if (bad) return json({ error: bad }, 400, h);
  // Personen auf dem Schein → Konten: Benutzername, sonst Zuordnung des Admins, sonst genau ein Konto mit diesem Namen
  const [accRows, aliasRows] = await db.batch([db.prepare('SELECT user, name, fullname FROM accounts'), db.prepare('SELECT key, user FROM report_alias')]);
  const users = new Set(accRows.results.map((a) => a.user));
  const alias = new Map(aliasRows.results.map((a) => [a.key, a.user]));
  const byName = new Map();
  for (const a of accRows.results) {
    const k = nameKey(a.fullname);
    if (k) byName.set(k, byName.has(k) ? null : a.user); // null = mehrdeutig
  }
  const people = [r.verfasser, ...r.einsaetze.flatMap((e) => e.mitarbeiter)];
  const to = new Map(); // Konto → angezeigter Name
  const open = new Map(); // Namensschlüssel → Name
  for (const p of people) {
    const key = nameKey(p.name);
    const u = userKey(p.benutzer);
    const user = (u && users.has(u) && u) || (users.has(alias.get(key)) && alias.get(key)) || byName.get(key) || null;
    if (user) to.set(user, p.name.trim());
    else open.set(key, p.name.trim());
  }
  const ops = [...to.keys()].map((u) => deliver(db, r.id, u, text, now));
  // nicht mehr auf dem Schein: dort entfernen; wartende Namen neu
  const keep = [...to.keys()];
  ops.push(
    db
      .prepare(`UPDATE reports SET data = '', deleted = ?, changed = ? WHERE id = ? AND deleted IS NULL${keep.length ? ` AND user NOT IN (${keep.map(() => '?').join(',')})` : ''}`)
      .bind(now, now, r.id, ...keep)
  );
  ops.push(db.prepare('DELETE FROM report_open WHERE id = ?').bind(r.id));
  for (const [key, name] of open) ops.push(db.prepare('INSERT INTO report_open (id, key, name, data, changed) VALUES (?, ?, ?, ?, ?)').bind(r.id, key, name, text, now));
  ops.push(db.prepare('DELETE FROM reports WHERE changed < ?').bind(now - REPORT_DAYS * 86400e3));
  ops.push(db.prepare('DELETE FROM report_open WHERE changed < ?').bind(now - REPORT_DAYS * 86400e3));
  await db.batch(ops);
  return json({ ok: true, empfaenger: [...to.values()], offen: [...open.values()] }, 200, h);
}

/** Verschlüsselte Sicherung speichern (Inhalt roh, nicht als JSON verpackt: spart Rechenzeit bei großen Dateien) */
async function backupPut(db, req, h) {
  const row = await checkAccount(db, headerUser(req), req.headers.get('X-Auth'));
  if (row.error) return json({ error: row.error }, row.status, h);
  const data = await req.text();
  if (data.length > BACKUP_MAX) return json({ error: 'size' }, 413, h);
  // nur Verschlüsseltes annehmen (Format von sealBackup in app.js)
  if (!/^\{"app":"std-protokoll","enc":"AES-256-GCM"/.test(data)) return json({ error: 'plain' }, 400, h);
  const at = Date.now();
  const parts = Math.ceil(data.length / BACKUP_PART);
  await db.batch(
    Array.from({ length: parts }, (_, i) =>
      db.prepare('INSERT INTO backups (user, at, part, parts, size, data) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(row.user, at, i, parts, data.length, data.slice(i * BACKUP_PART, (i + 1) * BACKUP_PART))
    )
  );
  await pruneBackups(db, row.user);
  return json({ at }, 200, h);
}

// ───────── Arena (Live-Kampf in 3D, alle gleichzeitig; Durable Object ARENA) ─────────
// Bewegung meldet jedes iPhone selbst (Kollegen untereinander, kein Schummelschutz nötig); Treffer, Leben, Block,
// Rolle und Punkte rechnet nur der Server. Eine Arena für alle (idFromName('team')), Stand im Speicher; nur die
// Bestenliste (K.o. und Niederlagen je Konto, alle Zeiten) liegt in D1 (Tabelle arena_scores).
// Nachrichten (JSON, t = Art). iPhone → Server: s (x, z, r Blickrichtung, m 0/1/2 Tempo, b Block), atk (k: jab | cross |
// heavy, r), roll, emo. Server → iPhone: hi (id, r Radius, hp, players, lb), join, left, w (Stand aller, 15/s), atk, roll,
// emo, hit (a, v, k, d Schaden, hp, b geblockt, px/pz Rückstoß), die (v, a, k, d), spawn, lb (Bestenliste), item (it: neuer
// Erste-Hilfe-Koffer), take (id, by, hp), voll, raus. hi enthält auch items. Ist nur eine Person da, kämpft ein Bot mit
// (bot: true in den Angaben, zählt nicht in der Bestenliste).

const ARENA_R = 13; // Radius der Arena in Metern
const ARENA_MAX = 12;
const ARENA_TICK = 66; // ms, also etwa 15 Mal je Sekunde
const ARENA_HP = 100;
const ARENA_RESPAWN = 3500;
const ARENA_IDLE = 90000; // ohne Lebenszeichen hinauswerfen
const ARENA_COLORS = 8;
// Angriffe: Zeit bis zum Treffer, Reichweite (m), Schaden, Winkel (cos zur Blickrichtung), Rückstoß, Pause danach
const ARENA_HITS = {
  jab: { delay: 250, range: 1.8, dmg: 8, cos: 0.45, push: 2, cd: 280 },
  cross: { delay: 300, range: 1.9, dmg: 12, cos: 0.45, push: 3.5, cd: 360 },
  heavy: { delay: 620, range: 2.5, dmg: 28, cos: 0.25, push: 7, cd: 1300 },
};
const ARENA_ROLL = 450; // ms unverwundbar
const ARENA_ROLL_CD = 900;
const ARENA_LB = 10; // Plätze in der Bestenliste
const ARENA_HEAL = 35; // Erste-Hilfe-Koffer
const ARENA_ITEMS = 2; // höchstens so viele liegen gleichzeitig
const ARENA_ITEM_GAP = 15000;
const ARENA_BOT_SPEED = 2.6; // m/s
const ARENA_BOT_DMG = 0.7; // der Bot schlägt etwas schwächer zu
// Deckung in der Arena [x, z, Radius] – gleich wie OBST in arena/arena.js
const ARENA_OBST = [[4.6, 4.6, 0.9], [-4.6, 4.6, 0.8], [-4.6, -4.6, 0.9], [4.6, -4.6, 0.8]];

const arenaKey = (env) => crypto.subtle.importKey('raw', enc('arena|' + env.ADMIN_CODE), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
/** Eintrittskarte für den WebSocket (Browser können dort keine Header setzen): Konto + Name, 2 min gültig */
async function arenaTicket(env, user, name) {
  const body = b64u(enc(JSON.stringify({ u: user, n: name, e: Date.now() + 120000 })));
  return body + '.' + b64u(await crypto.subtle.sign('HMAC', await arenaKey(env), enc(body)));
}
async function arenaCheck(env, t) {
  const [body, sig] = String(t || '').split('.');
  if (!body || !sig) return null;
  try {
    if (!(await crypto.subtle.verify('HMAC', await arenaKey(env), unb64u(sig), enc(body)))) return null;
    const d = JSON.parse(new TextDecoder().decode(unb64u(body)));
    return d.e > Date.now() ? d : null;
  } catch {
    return null;
  }
}

export class Arena {
  constructor(state, env) {
    this.env = env;
    this.lb = null; // Konto → { name, k, d } (aus D1)
    this.players = new Map(); // id → Spieler (auch der Bot, ohne ws)
    this.scores = new Map(); // Konto → { k, d } (bleibt bei neuer Verbindung)
    this.items = new Map(); // id → Erste-Hilfe-Koffer { id, x, z }
    this.nextItem = 0;
    this.next = 1;
    this.timer = null;
  }

  async fetch(req) {
    if (req.headers.get('Upgrade') !== 'websocket') return new Response('websocket', { status: 426 });
    await this.loadLb();
    const pair = new WebSocketPair();
    const [client, ws] = [pair[0], pair[1]];
    ws.accept();
    const user = req.headers.get('X-Arena-User') || '?';
    // dasselbe Konto ein zweites Mal (neu verbunden, zweites Gerät): die alte Verbindung gilt nicht mehr
    for (const p of [...this.players.values()]) if (p.user === user) this.drop(p, 'doppelt');
    if (this.humans().length >= ARENA_MAX) {
      ws.send(JSON.stringify({ t: 'voll' }));
      ws.close(1013, 'voll');
      return new Response(null, { status: 101, webSocket: client });
    }
    const p = this.add({ ws, user, name: (req.headers.get('X-Arena-Name') || user).slice(0, 24), seen: Date.now() });
    ws.addEventListener('message', (e) => this.onMsg(p, e.data));
    ws.addEventListener('close', () => this.drop(p));
    ws.addEventListener('error', () => this.drop(p));
    this.send(p, { t: 'hi', id: p.id, r: ARENA_R, hp: ARENA_HP, players: [...this.players.values()].map((q) => this.info(q)), lb: this.top(), items: [...this.items.values()] });
    this.all({ t: 'join', p: this.info(p) }, p);
    this.botCheck();
    if (!this.timer) this.timer = setInterval(() => this.tick(), ARENA_TICK);
    return new Response(null, { status: 101, webSocket: client });
  }

  /** Spieler anlegen (Farbe: möglichst die eigene aus dem Konto, sonst die nächste freie) */
  add(base) {
    const used = new Set([...this.players.values()].map((p) => p.color));
    let color = [...base.user].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) % ARENA_COLORS;
    for (let i = 0; i < ARENA_COLORS && used.has(color); i++) color = (color + 1) % ARENA_COLORS;
    const score = this.scores.get(base.user) || { k: 0, d: 0 };
    this.scores.set(base.user, score);
    const p = { id: this.next++, color, score, x: 0, z: 0, r: 0, m: 0, b: 0, hp: ARENA_HP, dead: 0, roll: 0, cd: 0, ...base };
    this.place(p);
    this.players.set(p.id, p);
    return p;
  }
  humans() {
    return [...this.players.values()].filter((p) => !p.bot);
  }

  // ───── Trainings-Bot: nur, solange genau eine Person da ist ─────
  botCheck() {
    const bot = [...this.players.values()].find((p) => p.bot);
    const n = this.humans().length;
    if (n === 1 && !bot) {
      const b = this.add({ bot: true, user: '~bot', name: 'Bot', next: 0, guard: 0 });
      this.all({ t: 'join', p: this.info(b) });
    } else if (n !== 1 && bot) this.drop(bot);
  }
  botStep(b, now, dt) {
    if (b.dead) return;
    const t = this.humans().find((q) => !q.dead);
    if (!t) {
      b.m = 0;
      return;
    }
    const dx = t.x - b.x, dz = t.z - b.z, dist = Math.hypot(dx, dz);
    b.r = Math.atan2(dx, dz);
    b.m = 0;
    b.b = now < b.guard ? 1 : 0;
    if (now < b.cd) return;
    if (dist > 1.5) {
      const sp = (dist > 5 ? ARENA_BOT_SPEED * 1.4 : ARENA_BOT_SPEED) * dt;
      b.x += (dx / dist) * sp;
      b.z += (dz / dist) * sp;
      b.m = dist > 5 ? 2 : 1;
      this.collide(b);
    } else if (now > b.next) {
      // mal blocken, mal schlagen, selten der Hammer
      const r = Math.random();
      if (r < 0.25) b.guard = now + 900;
      else this.attack(b, r > 0.85 ? 'heavy' : r > 0.55 ? 'cross' : 'jab', b.r, now);
      b.next = now + 700 + Math.random() * 900;
    }
  }
  /** nicht durch Deckung und Arenarand (für Bot und Koffer; die iPhones prüfen selbst) */
  collide(p) {
    for (const o of ARENA_OBST) {
      const dx = p.x - o[0], dz = p.z - o[1], d = Math.hypot(dx, dz), min = o[2] + 0.4;
      if (d < min && d > 0.001) {
        p.x = o[0] + (dx / d) * min;
        p.z = o[1] + (dz / d) * min;
      }
    }
    const len = Math.hypot(p.x, p.z);
    if (len > ARENA_R) {
      p.x *= ARENA_R / len;
      p.z *= ARENA_R / len;
    }
  }

  async loadLb() {
    if (this.lb) return;
    const db = this.env.DB;
    await db.prepare('CREATE TABLE IF NOT EXISTS arena_scores (user TEXT PRIMARY KEY, name TEXT, k INTEGER NOT NULL, d INTEGER NOT NULL, updated INTEGER NOT NULL)').run();
    const rows = (await db.prepare('SELECT user, name, k, d FROM arena_scores').all()).results;
    this.lb = new Map(rows.map((r) => [r.user, { name: r.name, k: r.k, d: r.d }]));
  }
  /** Bestenliste: meiste K.o., bei Gleichstand weniger Niederlagen */
  top() {
    return [...this.lb.values()].sort((a, b) => b.k - a.k || a.d - b.d).slice(0, ARENA_LB).map((e) => [e.name, e.k, e.d]);
  }
  /** K.o. dauerhaft zählen (Sieger +1 K.o., Verlierer +1 Niederlage) und allen die neue Liste schicken; der Bot zählt nicht */
  record(win, lose) {
    if (win.bot || lose.bot) return;
    const now = Date.now();
    const sql = 'INSERT INTO arena_scores (user, name, k, d, updated) VALUES (?, ?, ?, ?, ?) ' +
      'ON CONFLICT(user) DO UPDATE SET name = excluded.name, k = arena_scores.k + excluded.k, d = arena_scores.d + excluded.d, updated = excluded.updated';
    const db = this.env.DB;
    const ops = [];
    for (const [p, k, d] of [[win, 1, 0], [lose, 0, 1]]) {
      const e = this.lb.get(p.user) || { name: p.name, k: 0, d: 0 };
      e.name = p.name;
      e.k += k;
      e.d += d;
      this.lb.set(p.user, e);
      ops.push(db.prepare(sql).bind(p.user, p.name, k, d, now));
    }
    db.batch(ops).catch(() => {});
    this.all({ t: 'lb', lb: this.top() });
  }

  info(p) {
    return { id: p.id, name: p.name, color: p.color, x: p.x, z: p.z, r: p.r, hp: p.hp, k: p.score.k, d: p.score.d, dead: !!p.dead, bot: !!p.bot };
  }
  send(p, msg) {
    if (p.bot) return;
    try {
      p.ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
    } catch {
      this.drop(p);
    }
  }
  all(msg, except) {
    const s = JSON.stringify(msg);
    for (const p of [...this.players.values()]) if (p !== except) this.send(p, s);
  }
  drop(p, why) {
    if (!this.players.has(p.id)) return;
    this.players.delete(p.id);
    if (!p.bot)
      try {
        if (why) p.ws.send(JSON.stringify({ t: 'raus', why }));
        p.ws.close(1000, why || 'ende');
      } catch {}
    this.all({ t: 'left', id: p.id });
    if (!p.bot) this.botCheck();
    if (!this.humans().length) {
      for (const b of [...this.players.values()]) this.players.delete(b.id);
      this.items.clear();
      if (this.timer) clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Startplatz am Rand, möglichst weit weg von den anderen */
  place(p) {
    let best = null;
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      const c = { x: Math.sin(a) * ARENA_R * 0.72, z: Math.cos(a) * ARENA_R * 0.72, r: a + Math.PI };
      c.min = Math.min(99, ...[...this.players.values()].filter((q) => q !== p).map((q) => Math.hypot(q.x - c.x, q.z - c.z)));
      if (!best || c.min > best.min) best = c;
    }
    Object.assign(p, { x: best.x, z: best.z, r: best.r, hp: ARENA_HP, dead: 0, b: 0, m: 0 });
  }

  onMsg(p, raw) {
    if (!this.players.has(p.id) || typeof raw !== 'string' || raw.length > 300) return;
    let d;
    try {
      d = JSON.parse(raw);
    } catch {
      return;
    }
    const now = Date.now();
    p.seen = now;
    if (d.t === 's') {
      if (p.dead) return;
      const x = Number(d.x), z = Number(d.z);
      if (!Number.isFinite(x) || !Number.isFinite(z)) return;
      const len = Math.hypot(x, z), k = len > ARENA_R ? ARENA_R / len : 1;
      p.x = x * k;
      p.z = z * k;
      p.r = Number.isFinite(+d.r) ? +d.r : p.r;
      p.m = Math.max(0, Math.min(2, +d.m || 0));
      p.b = d.b ? 1 : 0;
      this.pickup(p);
    } else if (d.t === 'atk') {
      this.attack(p, d.k, +d.r, now);
    } else if (d.t === 'roll') {
      if (p.dead || now < p.cd) return;
      p.roll = now + ARENA_ROLL;
      p.cd = now + ARENA_ROLL_CD;
      this.all({ t: 'roll', id: p.id }, p);
    } else if (d.t === 'emo') {
      if (!p.dead) this.all({ t: 'emo', id: p.id }, p);
    }
  }

  attack(p, kind, r, now) {
    const hit = ARENA_HITS[kind];
    if (!hit || p.dead || now < p.cd || now < p.roll) return;
    p.cd = now + hit.cd;
    if (Number.isFinite(r)) p.r = r;
    this.all({ t: 'atk', id: p.id, k: kind }, p);
    setTimeout(() => this.resolve(p, kind, hit), hit.delay);
  }

  /** Erste-Hilfe-Koffer aufheben (nur mit weniger als vollem Leben) */
  pickup(p) {
    if (p.hp >= ARENA_HP) return;
    for (const it of this.items.values()) {
      if (Math.hypot(it.x - p.x, it.z - p.z) > 1) continue;
      this.items.delete(it.id);
      p.hp = Math.min(ARENA_HP, p.hp + ARENA_HEAL);
      this.nextItem = Math.max(this.nextItem, Date.now() + ARENA_ITEM_GAP);
      this.all({ t: 'take', id: it.id, by: p.id, hp: p.hp });
      return;
    }
  }

  /** Treffer prüfen, wenn der Schlag ankommt: alle in Reichweite vor dem Angreifer */
  resolve(p, kind, hit) {
    if (!this.players.has(p.id) || p.dead) return;
    const now = Date.now();
    const fx = Math.sin(p.r), fz = Math.cos(p.r);
    for (const q of [...this.players.values()]) {
      if (q === p || q.dead || now < q.roll) continue;
      const dx = q.x - p.x, dz = q.z - p.z, dist = Math.hypot(dx, dz);
      // etwas großzügiger als die Animation (Verzögerung im Netz)
      if (dist > hit.range + 0.35 || (dist > 0.6 && (dx * fx + dz * fz) / dist < hit.cos)) continue;
      // Block hilft nur, wenn man dem Angreifer zugewandt ist; der schwere Schlag bricht ihn
      const facing = dist < 0.01 || -(dx * Math.sin(q.r) + dz * Math.cos(q.r)) / dist > 0.2;
      const blocked = !!(q.b && facing);
      const dmg = Math.round(hit.dmg * (blocked ? (kind === 'heavy' ? 0.5 : 0.15) : 1) * (p.bot ? ARENA_BOT_DMG : 1));
      q.hp = Math.max(0, q.hp - dmg);
      const nx = dist > 0.01 ? dx / dist : fx, nz = dist > 0.01 ? dz / dist : fz;
      const push = hit.push * (blocked ? 0.4 : 1);
      if (q.bot) {
        q.x += nx * push * 0.25;
        q.z += nz * push * 0.25;
        this.collide(q);
        q.cd = Math.max(q.cd, now + 350); // kurz benommen
      }
      this.all({ t: 'hit', a: p.id, v: q.id, k: kind, d: dmg, hp: q.hp, b: blocked ? 1 : 0, px: +(nx * push).toFixed(2), pz: +(nz * push).toFixed(2) });
      if (!q.hp) {
        q.dead = now;
        q.b = 0;
        q.score.d++;
        p.score.k++;
        this.all({ t: 'die', v: q.id, a: p.id, k: p.score.k, d: q.score.d });
        this.record(p, q);
        setTimeout(() => {
          if (!this.players.has(q.id)) return;
          this.place(q);
          this.all({ t: 'spawn', id: q.id, x: q.x, z: q.z, r: q.r, hp: q.hp });
        }, ARENA_RESPAWN);
      }
    }
  }

  tick() {
    const now = Date.now();
    for (const p of [...this.players.values()]) if (!p.bot && now - p.seen > ARENA_IDLE) this.drop(p, 'weg');
    if (!this.players.size) return;
    for (const p of this.players.values()) if (p.bot) this.botStep(p, now, ARENA_TICK / 1000);
    // neuer Koffer an einer freien Stelle
    if (this.items.size < ARENA_ITEMS && now > this.nextItem) {
      const it = { id: this.next++, x: 0, z: 0 };
      for (let i = 0; i < 20; i++) {
        const a = Math.random() * Math.PI * 2, r = 2 + Math.random() * (ARENA_R - 4);
        it.x = +(Math.sin(a) * r).toFixed(2);
        it.z = +(Math.cos(a) * r).toFixed(2);
        if (ARENA_OBST.every((o) => Math.hypot(o[0] - it.x, o[1] - it.z) > o[2] + 1.2)) break;
      }
      this.items.set(it.id, it);
      this.nextItem = now + ARENA_ITEM_GAP;
      this.all({ t: 'item', it });
    }
    const r2 = (v) => Math.round(v * 100) / 100;
    this.all({ t: 'w', s: [...this.players.values()].map((p) => [p.id, r2(p.x), r2(p.z), r2(p.r), p.m, p.b, p.hp]) });
  }
}

export default {
  async fetch(req, env, ctx) {
    const isReports = new URL(req.url).pathname === '/reports';
    const h = isReports ? REPORT_CORS : cors(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    // Arena: WebSocket mit Eintrittskarte (POST /arena), ohne Team-Code und Datenbank
    if (new URL(req.url).pathname === '/arena/ws') {
      if (!cors(req)['Access-Control-Allow-Origin']) return new Response('origin', { status: 403 });
      const t = await arenaCheck(env, new URL(req.url).searchParams.get('t'));
      if (!t) return new Response('ticket', { status: 403 });
      const headers = new Headers(req.headers);
      headers.set('X-Arena-User', t.u);
      headers.set('X-Arena-Name', t.n);
      return env.ARENA.get(env.ARENA.idFromName('team')).fetch(new Request(req, { headers }));
    }
    // Arbeitsschein-App: eigener Schlüssel statt Team-Code
    if (isReports) {
      if (req.method !== 'POST' && req.method !== 'DELETE') return json({ error: 'method' }, 405, h);
      return reportsRequest(env.DB, req, env, h);
    }

    // Der Admin-Code gilt auch als Team-Code (der Admin tritt mit ihm bei)
    const teamCode = req.headers.get('X-Team-Code');
    if (!sameCode(teamCode, env.ADMIN_CODE) && !sameCode(teamCode, await currentTeamCode(env))) {
      // kurze Pause erschwert das Durchprobieren von Codes
      await new Promise((r) => setTimeout(r, 400));
      return json({ error: 'code' }, 401, h);
    }

    const db = env.DB;
    const month = currentMonth();
    const prevMonth = prevMonthOf(month);
    // in einem Rutsch (eine Verbindung zur Datenbank statt mehrerer nacheinander). Beim Monatswechsel wandern die
    // Zettel in history (Vormonat bleibt sichtbar), Älteres wird gelöscht; Nachrichten bleiben (begrenzt auf POSTS_KEEP)
    await db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS members (member TEXT PRIMARY KEY, token TEXT NOT NULL, name TEXT, month TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, name TEXT, month TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL)'),
      db.prepare(HISTORY_TABLE),
      db.prepare(`INSERT INTO history (member, month, name, data, updated) SELECT member, month, name, data, updated FROM members WHERE month = ? ${HISTORY_SET}`).bind(prevMonth),
      db.prepare('DELETE FROM members WHERE month <> ?').bind(month),
      db.prepare('DELETE FROM history WHERE month <> ?').bind(prevMonth),
    ]);

    const path = new URL(req.url).pathname;
    try {
      // Antwortzeit für die Server-Seite: so viel Arbeit wie jede Team-Anfrage, ohne Inhalt
      if (path === '/ping' && req.method === 'GET') return json({ ok: true }, 200, h);

      if ((path === '/account' && req.method === 'POST') || (path === '/backup' && req.method === 'PUT')) {
        await db.batch(ACCOUNT_TABLES.map((sql) => db.prepare(sql)));
        return path === '/backup' ? await backupPut(db, req, h) : await accountRequest(db, await readBody(req), h);
      }
      if (path === '/team' && req.method === 'GET') {
        // Lesen nur mit Konto (Team-Code allein reicht nicht); ohne Angaben 'konto', sonst wie beim Anmelden
        const acc = await checkAccount(db, headerUser(req), req.headers.get('X-Auth'));
        if (acc.error === 'id') return json({ error: 'konto' }, 403, h);
        if (acc.error) return json({ error: acc.error }, acc.status, h);
        const [cur, prev, posts] = await db.batch([
          db.prepare('SELECT member, name, updated, data FROM members WHERE month = ? ORDER BY name').bind(month),
          db.prepare('SELECT member, name, updated, data FROM history WHERE month = ? ORDER BY name').bind(prevMonth),
          db.prepare('SELECT id, member, name, text, created FROM posts ORDER BY created DESC LIMIT ?').bind(POSTS_KEEP),
        ]);
        const list = (rows) => rows.results.map((r) => ({ member: r.member, name: r.name, updated: r.updated, sheets: JSON.parse(r.data) }));
        return json({ month, members: list(cur), prev: { month: prevMonth, members: list(prev) }, posts: posts.results, spellV: await spellVersion(await loadDict(db)) }, 200, h);
      }

      if (path === '/arena' && req.method === 'POST') {
        const acc = await checkAccount(db, headerUser(req), req.headers.get('X-Auth'));
        if (acc.error === 'id') return json({ error: 'konto' }, 403, h);
        if (acc.error) return json({ error: acc.error }, acc.status, h);
        const body = await readBody(req);
        const name = String(body.name ?? '').trim().slice(0, 24) || acc.name || acc.user;
        return json({ ticket: await arenaTicket(env, acc.user, name) }, 200, h);
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
        await db.batch([
          db.prepare('INSERT INTO posts (member, name, month, text, created) VALUES (?, ?, ?, ?, ?)').bind(body.member, me.name, month, text, Date.now()),
          // höchstens POSTS_KEEP Nachrichten: die älteste fällt weg
          db.prepare('DELETE FROM posts WHERE id NOT IN (SELECT id FROM posts ORDER BY id DESC LIMIT ?)').bind(POSTS_KEEP),
        ]);
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

      if (path === '/errors' || path === '/push' || path === '/dict' || path === '/member' || path === '/account' || path === '/alias' || path === '/code') {
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
          await reportTables(db);
          await ensureFullname(db);
          const [, , , , errors, size, people, posts, dict, accounts, open] = await db.batch([
            ...ACCOUNT_TABLES.map((sql) => db.prepare(sql)),
            db.prepare('CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, name TEXT, version TEXT, ua TEXT, view TEXT, message TEXT NOT NULL, stack TEXT, count INTEGER NOT NULL, first INTEGER, last INTEGER, created INTEGER NOT NULL)'),
            db.prepare('CREATE TABLE IF NOT EXISTS dict (key TEXT PRIMARY KEY, word TEXT NOT NULL, created INTEGER NOT NULL)'),
            db.prepare('SELECT id, name, version, ua, view, message, stack, count, first, last, created FROM errors ORDER BY created DESC LIMIT 50'),
            db.prepare(
              `SELECT (SELECT COALESCE(SUM(${bytes(['member', 'token', 'name', 'month', 'data', 'version'])}), 0) FROM members) + ` +
                `(SELECT COALESCE(SUM(${bytes(['member', 'name', 'month', 'data'])}), 0) FROM history) AS sheets, ` +
                `(SELECT COALESCE(SUM(${bytes(['member', 'name', 'month', 'text'])}), 0) FROM posts) AS posts, ` +
                `(SELECT COALESCE(SUM(${bytes(['member', 'name', 'version', 'ua', 'view', 'message', 'stack'])}), 0) FROM errors) AS errors, ` +
                `(SELECT COALESCE(SUM(LENGTH(data)), 0) FROM backups) AS backups`
            ),
            // Team diesen Monat: je Person App-Version, letzter Upload, Zahl der Zettel
            db.prepare('SELECT member, name, version, updated, json_array_length(data) AS sheets FROM members WHERE month = ? ORDER BY name').bind(month),
            db.prepare('SELECT COUNT(*) AS n FROM posts WHERE month = ?').bind(month),
            db.prepare('SELECT word FROM dict ORDER BY word COLLATE NOCASE'),
            // Konten: Name, letzte Sicherung, Größe aller Sicherungen
            db.prepare('SELECT a.user, a.member, a.name, a.fullname, (SELECT MAX(at) FROM backups b WHERE b.user = a.user) AS last, (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM backups b WHERE b.user = a.user) AS bytes FROM accounts a ORDER BY a.user'),
            // Arbeitsscheine: Namen, die noch keinem Konto zugeordnet sind (je Name, Zahl der Scheine)
            db.prepare('SELECT key, MAX(name) AS name, COUNT(*) AS n, MAX(changed) AS last FROM report_open GROUP BY key ORDER BY last DESC'),
          ]);
          const s = size.results[0];
          const storage = { total: size.meta.size_after || 0, limit: STORAGE_LIMIT, sheets: s.sheets, posts: s.posts, errors: s.errors, backups: s.backups };
          const team = { month, people: people.results, posts: posts.results[0].n };
          return json({ errors: errors.results, storage, team, dict: dict.results.map((d) => d.word), accounts: accounts.results, open: open.results, code: await currentTeamCode(env), usage: await usage }, 200, h);
        }

        if (path === '/code' && req.method === 'PUT') {
          const body = await readBody(req);
          const code = String(body.code ?? '').trim();
          if (!/^[\p{L}\p{N}._-]{6,40}$/u.test(code)) return json({ error: 'code' }, 400, h);
          // sonst wären alle Kollegen Admin
          if (sameCode(code, env.ADMIN_CODE)) return json({ error: 'admin' }, 400, h);
          await db.batch([
            db.prepare('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
            db.prepare("INSERT INTO config (key, value) VALUES ('team_code', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(code),
          ]);
          teamCodeCache = { code, at: Date.now() };
          return json({ code }, 200, h);
        }
        if (path === '/alias' && (req.method === 'PUT' || req.method === 'DELETE')) {
          const body = await readBody(req);
          const key = String(body.key ?? '');
          if (!key) return json({ error: 'key' }, 400, h);
          await reportTables(db);
          if (req.method === 'DELETE') {
            await db.prepare('DELETE FROM report_open WHERE key = ?').bind(key).run();
            return json({ ok: true }, 200, h);
          }
          const user = userKey(body.user);
          if (!user || !(await db.prepare('SELECT user FROM accounts WHERE user = ?').bind(user).first())) return json({ error: 'user' }, 400, h);
          // Zuordnung merken und die wartenden Scheine zustellen
          const now = Date.now();
          const waiting = (await db.prepare('SELECT id, data FROM report_open WHERE key = ?').bind(key).all()).results;
          await db.batch([
            db.prepare('INSERT OR REPLACE INTO report_alias (key, user) VALUES (?, ?)').bind(key, user),
            ...waiting.map((w) => deliver(db, w.id, user, w.data, now)),
            db.prepare('DELETE FROM report_open WHERE key = ?').bind(key),
          ]);
          return json({ ok: true, delivered: waiting.length }, 200, h);
        }
        if (path === '/account' && req.method === 'DELETE') {
          const user = userKey((await readBody(req)).user);
          if (!user) return json({ error: 'id' }, 400, h);
          await db.batch([db.prepare('DELETE FROM backups WHERE user = ?').bind(user), db.prepare('DELETE FROM accounts WHERE user = ?').bind(user)]);
          return json({ ok: true }, 200, h);
        }
        if (path === '/member' && req.method === 'DELETE') {
          const body = await readBody(req);
          if (!validId(body.member)) return json({ error: 'id' }, 400, h);
          await db.batch([db.prepare('DELETE FROM members WHERE member = ?').bind(body.member), db.prepare('DELETE FROM history WHERE member = ?').bind(body.member)]);
          return json({ ok: true }, 200, h);
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
        // Zettel nur von Einträgen, die zu einem Konto gehören (seit dem Konto Pflicht; alte Apps mit gespeichertem
        // Team-Code legten sonst eigene Einträge ohne Konto an). Verlassen geht immer
        if (req.method === 'PUT' && !(await db.prepare('SELECT user FROM accounts WHERE member = ?').bind(body.member).first()))
          return json({ error: 'konto' }, 403, h);

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
        // nachträglich geänderte Zettel des Vormonats
        if (body.prev && body.prev.month === prevMonth && Array.isArray(body.prev.sheets))
          await db
            .prepare(`INSERT INTO history (member, month, name, data, updated) VALUES (?, ?, ?, ?, ?) ${HISTORY_SET}`)
            .bind(body.member, prevMonth, name, JSON.stringify(body.prev.sheets), Date.now())
            .run();
        return json({ ok: true }, 200, h);
      }
    } catch (e) {
      return json({ error: 'body' }, 400, h);
    }
    return json({ error: 'not found' }, 404, h);
  },
};
