// Std-Protokoll – Team-Speicher (Cloudflare Worker mit D1-Datenbank in der EU)
//
// Jedes iPhone legt hier die Stundenzettel des laufenden Monats und des Vormonats ab (ein Eintrag je Konto, wird bei
// jeder Änderung überschrieben). Lesen nur mit Team-Code und Konto. Beim Monatswechsel wandert der Monat in history
// (Vormonat), Älteres löscht der Worker.
//
// Einrichtung im Cloudflare-Dashboard:
//   - D1-Datenbank (Jurisdiction „EU“) als Binding mit dem Namen DB
//   - Workers AI als Binding mit dem Namen AI (Rechtschreibung, gleiche Baustellen)
//   - Secret TEAM_CODE: der Team-Code, den die Kollegen eingeben (bis er auf der Server-Seite geändert wird, siehe PUT /code)
// Die Tabellen legt der Worker selbst an.
//
// Anfragen (Code im Header X-Team-Code):
//   GET    /ping   → { ok }   nur zum Messen der Antwortzeit
//   GET    /team   Header X-User, X-Auth (Konto, sonst 403 'konto') → { month, members: [{ member, name, updated, sheets }], prev: { month, members }, posts: [{ id, member, name, text, created }], spellV, trV }
//                    prev: Zettel des Vormonats (Tabelle history); posts: die letzten POSTS_KEEP Nachrichten (nicht mehr monatlich gelöscht)
//                    spellV: Stand von Anweisung und Wörterbuch (wie v bei /ai; ändert er sich, prüfen die iPhones neu)
//   PUT    /me     ← { member, token, name, month, sheets, version, prev: { month, sheets } }   eigener Eintrag (version: App-Version für die Admin-Seite)
//                    nur, wenn ein Konto den Eintrag kennt (sonst 403 'konto')
//   DELETE /me     ← { member, token }                         Team verlassen (Zettel beider Monate weg; Nachrichten bleiben, siehe POSTS_KEEP)
//   POST   /post   ← { member, token, text }                   Nachricht ins Teammeeting (nur mit eigenem Eintrag und Konto)
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
// Abgleich mehrerer Geräte (nur Konten mit Schalter accounts.sync; Plan: Ideen/Plan-Abgleich-mehrere-Geraete.md):
//   Bei diesen Konten brauchen alle Anfragen mit Passwort zusätzlich das Token eines Geräts des Kontos (Header X-Token
//   bzw. token im Inhalt), sonst 403 'device'; abgemeldete Geräte bekommen 'removed', nach „Team verlassen“ auf einem
//   Gerät alle anderen 'left'. join braucht device (Geräte-ID) und deviceName; mehr als SYNC_DEVICES → 409 'devices'.
//   Anfrage mit dem vorigen Passwort → 403 'pwchanged' (kein Fehlversuch). Passwort ändern geht auch mit Abgleich:
//   kg + 1, accounts.rekey = 1 (nur mit Abgleich), bis ein Gerät, das den alten Schlüssel kennt, alles neu verschlüsselt
//   hat (rekey). Abgleich einschalten löscht Datensätze mit älterem Schlüssel (Passwort geändert, während er aus war).
//   POST   /sync    ← { code, user, auth, token, device, action, … } (alles im Inhalt, Content-Type text/plain)
//                    head                      → { rev, kg, f, rekey, created }   rekey: nach einem Passwortwechsel liegen
//                                                noch Datensätze mit älterem Schlüssel da; created: Konto angelegt (anders
//                                                als gemerkt = gelöscht und gleichnamig neu angelegt)
//                    rekey { kgs }             → { records, left } Datensätze mit diesen älteren Schlüssel-Generationen
//                                                (Teile à SYNC_PUSH_MAX); das Gerät verschlüsselt sie neu und sendet sie
//                                                per push zurück; left = 0 → fertig (accounts.rekey = 0, kg_at = jetzt)
//                    pull { since }            → { records: [{ k, id, rev, updated, dev, del, f, kg, data }], devices, rev, more }
//                    push { f, kg, records: [{ k, id, base, del, data }] } → { accepted: [{ k, id, rev }], rejected: [Fassung des Servers], rev }
//                         angenommen nur, wenn auf dem Server noch die Fassung base liegt (0 = neu); data verschlüsselt
//                    devices / device-name { device, name } / device-remove { device } → { devices }
//                    restore-days              → { from, days: { 'JJJJ-MM-TT': Änderungen }, undo } Tage (deutsche Zeit),
//                                                deren Stand sich wiederherstellen lässt (ab from: 30 Tage, frühestens ab
//                                                dem ersten Hochladen bzw. dem letzten Passwortwechsel); undo: Zeitpunkt
//                                                der letzten Wiederherstellung (deren Stand davor ist auch wählbar)
//                    restore { at, first }     → { changed, more, rev } jeden Datensatz auf die Fassung zum Zeitpunkt at
//                                                (aus sync + sync_old) – als neue Fassung, damit alle Geräte sie abholen;
//                                                nur verschlüsselte Daten werden kopiert. Je Aufruf SYNC_PUSH_MAX, bis more
//                                                false ist; schon wiederhergestellte bleiben (gleiche Daten)
//   POST   /account ← { action: 'device-remove', user, auth, device }  Gerät abmelden ohne eigenes Token (beim Anmelden voll)
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
//   PUT    /sync-switch ← { user, on }                         Abgleich für ein Konto ein/aus
//   DELETE /member ← { member }                                Person aus dem Team entfernen (z. B. doppelt nach Neuinstallation;
//                                                              benutzt sie die App noch, erscheint sie beim nächsten Upload wieder)
//   PUT    /push   ← { endpoint, keys: { p256dh, auth } }      Gerät für Mitteilungen anmelden
//   DELETE /push   ← { endpoint }                              abmelden
// Tagesgrenzen: Secret CF_STATS_TOKEN (API-Token nur mit „Konto-Analysen: Lesen“) und Variable CF_ACCOUNT_ID
// Web Push: Secret VAPID_JWK (privater Schlüssel als JWK), öffentlicher Schlüssel steht in fehler-seite.js

const ORIGINS = ['https://y4t6bgp6g6-maker.github.io'];
const MAX_BODY = 1_000_000;
const MAX_TEXT = 500;
const MAX_POSTS = 100; // je Person und Tag (Bremse; POSTS_KEEP begrenzt die Gesamtzahl)
const CODE_FAILS = 20; // falsche Team-Codes je Adresse, danach AUTH_WAIT Minuten Pause
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
const AUTH_FAILS_ALL = 30; // falsche Passwörter je Konto von allen Geräten zusammen, danach ebenfalls AUTH_WAIT Minuten Pause
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
const AI_TR_V = 2; // v102: noch kyrillische Ergebnisse ins Deutsche nicht mehr gemerkt – alte Einträge verwerfen
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
const DICT_V = 4;
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
    // innen nur Buchstaben, Ziffern, Leerzeichen, Apostroph (alle Formen wie sameKey der App), Bindestrich und Punkt
    if (!core || /[^\p{L}\p{N}\s'’‘`´ʼ′.\-]/u.test(core)) return null;
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
const HISTORY_SET =
  'ON CONFLICT(member, month) DO UPDATE SET name = excluded.name, data = excluded.data, updated = excluded.updated ' +
  'WHERE excluded.updated > history.updated AND (excluded.data IS NOT history.data OR excluded.name IS NOT history.name)';
/** Monatswechsel schon erledigt (je Worker-Instanz und Monat) */
let rolledMonth = '';

/** Laufender Monat in deutscher Zeit, z. B. „2026-10“ */
function currentMonth() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
  return `${p.find((x) => x.type === 'year').value}-${p.find((x) => x.type === 'month').value}`;
}

// Regeln der App (Arbeitsarten, Kunden-Regeln, Schreibweisen, Ketten): der Admin ändert sie in der App, alle im Team
// bekommen sie. config 'regeln' = { rev, zeit, regeln }, 'regeln_alt' = die vorigen Fassungen (neueste zuerst)
const REGELN_MAX = 150_000; // Bytes je Fassung
const REGELN_KEEP = 20; // so viele frühere Fassungen bleiben (alle zusammen unter ~900 KB je Zeile)
async function regelnRead(db, key = 'regeln') {
  try {
    const row = await db.prepare('SELECT value FROM config WHERE key = ?').bind(key).first();
    return row ? JSON.parse(row.value) : null;
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return null;
    throw e;
  }
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
        'Access-Control-Allow-Headers': 'Content-Type, X-Team-Code, X-Admin-Code, X-User, X-Auth, X-Token',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : {};
}

const json = (data, status, headers) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers } });

const validId = (s) => typeof s === 'string' && /^[A-Za-z0-9-]{8,128}$/.test(s);
/** Zettel eines Monats im Team-Upload: höchstens 12 (Teilwochen), je 7 Tage, je Tag höchstens 30 Zeilen */
const TEAM_SHEETS_MAX = 200_000; // Zeichen je Monat und Person
const teamSheetsOk = (a) =>
  Array.isArray(a) &&
  a.length <= 12 &&
  a.every(
    (s) =>
      s && typeof s.weekStart === 'string' && Array.isArray(s.days) && s.days.length === 7 &&
      s.days.every((d) => d && typeof d === 'object' && (d.rows == null || (Array.isArray(d.rows) && d.rows.length <= 30)))
  );

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

/** Fehlversuche je Konto und Gerät (IP-Adresse): so kann niemand ein fremdes Konto durch falsche Passwörter sperren */
const AUTH_FAILS_TABLE = 'CREATE TABLE IF NOT EXISTS auth_fails (key TEXT PRIMARY KEY, fails INTEGER NOT NULL, failed INTEGER NOT NULL)';
const clientIp = (req) => req.headers.get('CF-Connecting-IP') || '';

/** Konto mit Passwort-Prüfwert prüfen. Gesperrt (AUTH_WAIT Minuten) wird nach AUTH_FAILS Fehlversuchen von derselben
 *  Adresse – nur für diese – und nach AUTH_FAILS_ALL von allen zusammen (Durchprobieren über viele Adressen).
 *  Ergebnis: Zeile des Kontos oder { error, status } */
async function checkAccount(db, user, auth, ip = '') {
  if (!user || !validAuth(auth)) return { error: 'id', status: 400 };
  const row = await db.prepare('SELECT * FROM accounts WHERE user = ?').bind(user).first();
  if (!row) return { error: 'unknown', status: 404 };
  const now = Date.now();
  const wait = AUTH_WAIT * 60000;
  const key = `${user}|${ip}`;
  let own = null;
  try {
    own = await db.prepare('SELECT fails, failed FROM auth_fails WHERE key = ?').bind(key).first();
  } catch (e) {
    if (!/no such table/i.test(String(e && e.message))) throw e;
  }
  if ((own && own.fails >= AUTH_FAILS && now - own.failed < wait) || (row.fails >= AUTH_FAILS_ALL && now - (row.failed || 0) < wait))
    return { error: 'wait', status: 429 };
  const authHash = await sha256(auth);
  if (!sameCode(authHash, row.auth)) {
    // vorheriges Passwort (auf einem anderen Gerät geändert): kein Fehlversuch – sonst sperrten die anderen Geräte
    // mit ihren regelmäßigen Anfragen das ganze Konto
    if (row.old_auth && sameCode(authHash, row.old_auth)) return { error: 'pwchanged', status: 403 };
    await db.batch([
      db.prepare(AUTH_FAILS_TABLE),
      db.prepare('INSERT INTO auth_fails (key, fails, failed) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET fails = CASE WHEN ? - failed > ? THEN 1 ELSE fails + 1 END, failed = ?')
        .bind(key, now, now, wait, now),
      db.prepare('UPDATE accounts SET fails = CASE WHEN ? - COALESCE(failed, 0) > ? THEN 1 ELSE fails + 1 END, failed = ? WHERE user = ?').bind(now, wait, now, user),
      db.prepare('DELETE FROM auth_fails WHERE failed < ?').bind(now - 86400e3),
    ]);
    await new Promise((r) => setTimeout(r, 400));
    return { error: 'auth', status: 403 };
  }
  if (own && own.fails) await db.prepare('DELETE FROM auth_fails WHERE key = ?').bind(key).run();
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

async function accountRequest(db, body, h, ip = '') {
  const user = userKey(body.user);
  if (body.action === 'join') {
    if (!user || !validAuth(body.auth) || !validId(body.member) || !validId(body.token)) return json({ error: 'id' }, 400, h);
    const name = String(body.name ?? '').slice(0, 80);
    const fullname = String(body.fullname ?? '').trim().slice(0, 80);
    await ensureFullname(db);
    const token = await sha256(body.token);
    // mitgeschickter Eintrag: gehört er wirklich diesem iPhone? (Token der Zeile in members bzw. beim Konto gemerkt;
    // sonst ließe sich ein Kollege aus dem Team drängen – auch zum Monatsanfang, wenn members leer ist)
    const sent = await db.prepare('SELECT token FROM members WHERE member = ?').bind(body.member).first();
    const sentOwn = !(await ownsMember(db, body.member, token));
    const exists = await db.prepare('SELECT user FROM accounts WHERE user = ?').bind(user).first();
    if (!exists) {
      if (body.mode !== 'create') return json({ error: 'unknown' }, 404, h);
      if (!sentOwn) return json({ error: 'token' }, 403, h);
      // ein Team-Eintrag gehört nur zu einem Konto (z. B. abgemeldet und neues Konto auf demselben iPhone)
      await db.batch([
        db.prepare('UPDATE accounts SET member = NULL, token = NULL WHERE member = ?').bind(body.member),
        db.prepare('INSERT INTO accounts (user, auth, member, name, fullname, created, token) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(user, await sha256(body.auth), body.member, name, fullname || null, Date.now(), token),
      ]);
      return json({ member: body.member, backups: [] }, 200, h);
    }
    const row = await checkAccount(db, user, body.auth, ip);
    // falsches Passwort beim Anlegen: der Name gehört jemand anderem
    if (row.error) return json({ error: row.error === 'auth' && body.mode === 'create' ? 'taken' : row.error }, row.status, h);
    // Konto ohne Eintrag: den mitgeschickten nur, wenn er diesem iPhone gehört (sonst gäbe es einen fremden her)
    if (!validId(row.member) && !sentOwn) return json({ error: 'token' }, 403, h);
    const member = validId(row.member) ? row.member : body.member;
    const now = Date.now();
    // Konto mit Abgleich: Gerät eintragen (gleiche Geräte-ID = derselbe Platz mit neuem Token), die anderen Geräte
    // bleiben angemeldet; höchstens SYNC_DEVICES
    if (row.sync) {
      if (!validId(body.device)) return json({ error: 'device' }, 403, h);
      const devs = (await db.prepare('SELECT device, token, name, created, state FROM devices WHERE user = ?').bind(user).all()).results;
      const mine = devs.find((d) => d.device === body.device) || devs.find((d) => d.token === token);
      if (mine && mine.state === 'removed') return json({ error: 'removed' }, 403, h);
      const others = devs.filter((d) => d !== mine && d.state !== 'removed');
      if (others.length >= SYNC_DEVICES)
        return json({ error: 'devices', devices: others.map(({ device, name, created }) => ({ device, name, created })) }, 409, h);
      const devName = String(body.deviceName ?? '').trim().slice(0, 40) || 'Gerät';
      const ops = [];
      // Platzhalter vom Einschalten (Geräte-ID noch unbekannt): durch die echte ersetzen
      if (mine && mine.device !== body.device) ops.push(db.prepare('DELETE FROM devices WHERE user = ? AND device = ?').bind(user, mine.device));
      ops.push(
        db
          .prepare(
            "INSERT INTO devices (user, device, token, name, created, seen, state, changed) VALUES (?, ?, ?, ?, ?, ?, 'active', ?) " +
              "ON CONFLICT(user, device) DO UPDATE SET token = excluded.token, seen = excluded.seen, state = 'active', changed = excluded.changed"
          )
          .bind(user, body.device, token, mine ? mine.name || devName : devName, mine ? mine.created : now, now, now),
        db.prepare('UPDATE accounts SET member = NULL, token = NULL WHERE member = ? AND user <> ?').bind(member, user),
        db.prepare('UPDATE accounts SET member = ?, token = ?, name = COALESCE(NULLIF(?, \'\'), name), fullname = COALESCE(NULLIF(?, \'\'), fullname) WHERE user = ?').bind(member, token, name, fullname, user)
      );
      if (member !== body.member && sent && sentOwn) ops.push(db.prepare('DELETE FROM members WHERE member = ?').bind(body.member));
      await db.batch(ops);
      return json({ member, backups: await backupList(db, user), sync: true }, 200, h);
    }
    const ops = [
      db.prepare('UPDATE accounts SET member = NULL, token = NULL WHERE member = ? AND user <> ?').bind(member, user),
      db.prepare('UPDATE accounts SET member = ?, token = ?, name = COALESCE(NULLIF(?, \'\'), name), fullname = COALESCE(NULLIF(?, \'\'), fullname) WHERE user = ?').bind(member, token, name, fullname, user),
    ];
    // Eintrag des Kontos übernimmt das neue Token; ein anderer, frisch angelegter Eintrag dieses iPhones verschwindet
    ops.push(db.prepare('UPDATE members SET token = ? WHERE member = ?').bind(token, member));
    if (member !== body.member && sent && sentOwn) ops.push(db.prepare('DELETE FROM members WHERE member = ?').bind(body.member));
    await db.batch(ops);
    return json({ member, backups: await backupList(db, user) }, 200, h);
  }
  await ensureSync(db);
  const row = await checkAccount(db, user, body.auth, ip);
  if (row.error) return json({ error: row.error }, row.status, h);
  // Schon SYNC_DEVICES Geräte beim Anmelden: eins abmelden (Passwort reicht, das neue Gerät hat noch kein Token)
  if (body.action === 'device-remove') {
    if (!row.sync || !validId(body.device)) return json({ error: 'device' }, 400, h);
    await deviceRemove(db, user, body.device);
    return json({ devices: await deviceList(db, user) }, 200, h);
  }
  const devErr = await deviceError(db, row, body.token);
  if (devErr) return json({ error: devErr }, 403, h);
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
    // Vornamen nur für die Benutzer, die auf diesen Scheinen stehen (nicht die Liste aller Konten herausgeben)
    const onReports = new Set();
    for (const r of rows.results) {
      try {
        for (const e of JSON.parse(r.data).einsaetze || []) for (const m of e.mitarbeiter || []) if (userKey(m.benutzer)) onReports.add(userKey(m.benutzer));
      } catch {}
    }
    return json({ reports: rows.results, names: Object.fromEntries(names.results.filter((x) => onReports.has(x.user)).map((x) => [x.user, x.name || ''])) }, 200, h);
  }
  if (body.action === 'get') {
    const parts = (await db.prepare('SELECT data FROM backups WHERE user = ? AND at = ? ORDER BY part').bind(user, Number(body.at) || 0).all()).results;
    if (!parts.length) return json({ error: 'missing' }, 404, h);
    return json({ data: parts.map((p) => p.data).join('') }, 200, h);
  }
  if (body.action === 'password') {
    if (!validAuth(body.newAuth)) return json({ error: 'id' }, 400, h);
    // alte Sicherungen sind mit dem alten Passwort verschlüsselt – mit dem neuen ließen sie sich nicht öffnen.
    // Der alte Prüfwert bleibt als old_auth: andere Geräte mit dem alten Passwort sind dann kein Fehlversuch.
    // Abgleich: die Datensätze tragen noch den alten Schlüssel (kg), rekey = 1 bis ein Gerät sie neu verschlüsselt hat
    // (ohne Abgleich nicht: dann hielte niemand den alten Schlüssel, und rekey bliebe für immer – „Stand vom …“ gesperrt)
    const [, , kg] = await db.batch([
      db.prepare('UPDATE accounts SET auth = ?, old_auth = auth, kg = kg + 1, rekey = sync WHERE user = ?').bind(await sha256(body.newAuth), user),
      db.prepare('DELETE FROM backups WHERE user = ?').bind(user),
      db.prepare('SELECT kg FROM accounts WHERE user = ?').bind(user),
    ]);
    return json({ ok: true, kg: kg.results[0].kg }, 200, h);
  }
  if (body.action === 'delete') {
    await db.batch(accountDeleteOps(db, user));
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
  // ohne Steuerzeichen (die Nummer wird Teil der Kennung im Abgleich; der Server nimmt solche Kennungen dort nicht an)
  if (!str(r.nummer, 40, false) || /[\u0000-\u001f]/.test(r.nummer)) return 'nummer';
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

/** Gerätenachweis des Team-Eintrags (SHA-256 des Tokens) auch beim Konto: members verliert ihn beim Monatswechsel */
let tokenColumn = false;
async function ensureTokenColumn(db) {
  if (tokenColumn) return;
  try {
    await db.exec('ALTER TABLE accounts ADD COLUMN token TEXT');
  } catch {}
  tokenColumn = true;
}
// ───────── Abgleich mehrerer Geräte (nur Konten mit Schalter accounts.sync, gesetzt auf der Server-Seite) ─────────
// Ein Konto mit Abgleich hat bis zu SYNC_DEVICES Geräte (Tabelle devices, je Gerät eigenes Token); jedes gilt als
// Besitzer des Team-Eintrags. Die Daten liegen je Datensatz verschlüsselt in sync (rev fortlaufend je Konto,
// accounts.sync_rev); jede überschriebene Fassung SYNC_OLD_DAYS Tage in sync_old.
const SYNC_DEVICES = 3;
const SYNC_KINDS = new Set(['sheet', 'trip', 'pay', 'report', 'set', 'bh-heft', 'bh-week', 'bh-month', 'bh-profile', 'bh-img']);
const SYNC_PUSH_MAX = 40; // Datensätze je Senden (je Datensatz drei Anweisungen in einem Rutsch)
const SYNC_DATA_MAX = 1_900_000; // Zeichen je Datensatz (D1: höchstens 2 MB je Zeile)
const SYNC_PULL_MAX = 3_000_000; // Zeichen je Abholen (der Rest kommt mit more)
const SYNC_OLD_DAYS = 30;
const SYNC_REKEY_MAX = 780_000; // Zeichen je Teil beim Neu-Verschlüsseln (muss wieder in ein Senden passen)
const SYNC_DEL_DAYS = 365; // Löschmarken: so lange erfährt auch ein lange nicht geöffnetes Gerät vom Löschen
const SYNC_REMOVED_DAYS = 90; // abgemeldete Geräte: so lange bekommen sie noch „removed“ (und löschen ihre Daten)
const DEVICES_TABLE =
  'CREATE TABLE IF NOT EXISTS devices (user TEXT NOT NULL, device TEXT NOT NULL, token TEXT NOT NULL, name TEXT, created INTEGER NOT NULL, seen INTEGER, state TEXT NOT NULL, changed INTEGER, PRIMARY KEY (user, device))';
const SYNC_TABLE =
  'CREATE TABLE IF NOT EXISTS sync (user TEXT NOT NULL, k TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, updated INTEGER NOT NULL, dev TEXT, del INTEGER NOT NULL DEFAULT 0, f INTEGER, kg INTEGER, data TEXT NOT NULL, PRIMARY KEY (user, k, id))';
const SYNC_OLD_TABLE =
  'CREATE TABLE IF NOT EXISTS sync_old (user TEXT NOT NULL, k TEXT NOT NULL, id TEXT NOT NULL, rev INTEGER NOT NULL, replaced INTEGER NOT NULL, dev TEXT, del INTEGER NOT NULL DEFAULT 0, f INTEGER, kg INTEGER, data TEXT NOT NULL, updated INTEGER)';
/** Spalten und Tabellen für den Abgleich nachrüsten; einmal je Worker-Instanz */
let syncSchema = false;
/** Stand der Tabellen für den Abgleich (hochzählen, wenn ensureSync etwas Neues anlegt): eine neue Instanz prüft ihn mit
 *  einer Abfrage statt mit zwölf (ensureSync läuft auf fast allen Wegen, auch für Kollegen ohne Abgleich) */
const SYNC_SCHEMA_V = '1';
async function ensureSync(db) {
  if (syncSchema) return;
  try {
    const row = await db.prepare("SELECT value FROM config WHERE key = 'sync_schema'").first();
    if (row && row.value === SYNC_SCHEMA_V) {
      syncSchema = tokenColumn = true;
      return;
    }
  } catch {}
  await db.batch(ACCOUNT_TABLES.map((sql) => db.prepare(sql)));
  await ensureTokenColumn(db);
  // sync: Schalter; sync_rev: letzter rev; kg: Schlüssel-Generation (+1 je Passwortwechsel); old_auth: Prüfwert des
  // vorigen Passworts (andere Geräte bekommen „pwchanged“ statt Fehlversuch); max_f: neueste App-Version, die gesendet hat;
  // rekey: nach Passwortwechsel noch nicht alles neu verschlüsselt; kg_at: seitdem fertig (früherer Stand nicht lesbar);
  // restored_at: letzte Wiederherstellung
  const cols = ['sync INTEGER NOT NULL DEFAULT 0', 'sync_rev INTEGER NOT NULL DEFAULT 0', 'kg INTEGER NOT NULL DEFAULT 1', 'old_auth TEXT', 'max_f INTEGER NOT NULL DEFAULT 0', 'rekey INTEGER NOT NULL DEFAULT 0', 'kg_at INTEGER', 'restored_at INTEGER'];
  for (const col of cols)
    try {
      await db.exec(`ALTER TABLE accounts ADD COLUMN ${col}`);
    } catch {}
  await db.batch([
    db.prepare(DEVICES_TABLE),
    db.prepare(SYNC_TABLE),
    db.prepare('CREATE INDEX IF NOT EXISTS sync_by_rev ON sync (user, rev)'),
    db.prepare(SYNC_OLD_TABLE),
    db.prepare('CREATE INDEX IF NOT EXISTS sync_old_by_key ON sync_old (user, k, id, replaced)'),
  ]);
  // sync_old: seit wann die Fassung galt (für „Stand vom …“; ältere Zeilen ohne)
  try {
    await db.exec('ALTER TABLE sync_old ADD COLUMN updated INTEGER');
  } catch {}
  await db.batch([
    db.prepare('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
    db.prepare("INSERT INTO config (key, value) VALUES ('sync_schema', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(SYNC_SCHEMA_V),
  ]);
  syncSchema = true;
}

/** Gehört der Team-Eintrag diesem Gerät (token = SHA-256)? Ergebnis: '' = ja, sonst der Grund ('token', bei Konten mit
 *  Abgleich auch 'left' = Team auf einem anderen Gerät verlassen, 'removed' = Gerät abgemeldet).
 *  Konto mit Abgleich: jedes aktive Gerät des Kontos. Sonst wie bisher: Token der Zeile in members, ohne Zeile das
 *  beim Konto gemerkte (Monatsanfang, nach dem Verlassen); ohne Konto oder ohne gemerktes Token (vor v102): frei */
async function ownsMember(db, member, token) {
  await ensureSync(db);
  const acc = await db.prepare('SELECT user, token, sync FROM accounts WHERE member = ?').bind(member).first();
  if (acc && acc.sync) {
    const d = await db.prepare('SELECT state FROM devices WHERE user = ? AND token = ?').bind(acc.user, token).first();
    return !d ? 'token' : d.state === 'active' ? '' : d.state;
  }
  const row = await db.prepare('SELECT token FROM members WHERE member = ?').bind(member).first();
  if (row) return row.token === token ? '' : 'token';
  return !acc || !acc.token || acc.token === token ? '' : 'token';
}

/** Konto mit Abgleich: Anfragen mit Passwort brauchen zusätzlich das Token eines Geräts des Kontos (ein abgemeldetes
 *  Gerät kommt sonst mit dem gespeicherten Passwort weiter an die Daten). Ergebnis: '' oder 'device' | 'removed' */
async function deviceError(db, row, raw) {
  if (!row.sync) return (await deviceRemoved(db, row.user, raw)) ? 'removed' : '';
  if (!validId(raw)) return 'device';
  const d = await db.prepare('SELECT state FROM devices WHERE user = ? AND token = ?').bind(row.user, await sha256(raw)).first();
  return !d ? 'device' : d.state === 'removed' ? 'removed' : '';
}

/** Abgemeldetes Gerät – auch nachdem der Abgleich ausgeschaltet wurde (es soll seine Daten trotzdem löschen) */
async function deviceRemoved(db, user, raw) {
  if (!validId(raw)) return false;
  try {
    return !!(await db.prepare("SELECT 1 AS x FROM devices WHERE user = ? AND token = ? AND state = 'removed'").bind(user, await sha256(raw)).first());
  } catch (e) {
    if (/no such table/i.test(String(e && e.message))) return false;
    throw e;
  }
}

/** Geräte eines Kontos für die App (ohne Tokens) */
const deviceList = async (db, user) =>
  (await db.prepare("SELECT device, name, created, seen, state FROM devices WHERE user = ? AND state <> 'removed' ORDER BY created").bind(user).all()).results;

/** Gerät abmelden: es bekommt ab jetzt „removed“ und löscht daraufhin seine Daten */
const deviceRemove = (db, user, device) =>
  db.prepare("UPDATE devices SET state = 'removed', changed = ? WHERE user = ? AND device = ?").bind(Date.now(), user, device).run();

/** Konto ganz löschen: Sicherungen, Abgleich, Geräte */
const accountDeleteOps = (db, user) =>
  ['backups', 'sync', 'sync_old', 'devices', 'accounts'].map((t) => db.prepare(`DELETE FROM ${t} WHERE user = ?`).bind(user));

/** Datensatz für die App */
const syncOut = (r) => ({ k: r.k, id: r.id, rev: r.rev, updated: r.updated, dev: r.dev, del: !!r.del, f: r.f, kg: r.kg, data: r.data });
/** Nur Verschlüsseltes annehmen (Hülle der App: {"kg":…,"iv":"…","d":"…"}) */
const sealedRe = /^\{"kg":\d{1,6},"iv":"[A-Za-z0-9+/=]{16}","d":"[A-Za-z0-9+/=]+"\}$/;
/** Anweisungen, die sich auf den Stand eines Datensatzes beziehen: gilt nur, solange er noch die Fassung base hat */
/** Fassung, die gleich überschrieben wird, aufheben (Werte: replaced, user, k, id, rev, kg) – nur mit dem aktuellen
 *  Schlüssel (mit einem früheren ließe sie sich nie wiederherstellen; beim Neu-Verschlüsseln wären das alle Datensätze) */
const SYNC_KEEP_OLD =
  'INSERT INTO sync_old (user, k, id, rev, replaced, dev, del, f, kg, data, updated) SELECT user, k, id, rev, ?, dev, del, f, kg, data, updated FROM sync WHERE user = ? AND k = ? AND id = ? AND rev = ? AND kg = ?';
const SYNC_BASE = 'COALESCE((SELECT rev FROM sync WHERE user = ? AND k = ? AND id = ?), 0) = ?';

/** POST /sync – Zugang über den Inhalt (Team-Code, Benutzer, auth, Token: keine eigenen Header, damit „keepalive“ ohne
 *  Vorab-Anfrage geht). Aktionen: head, pull, push, devices, device-name, device-remove */
async function syncRequest(db, b, h, ip) {
  await ensureSync(db);
  const user = userKey(b.user);
  const row = await checkAccount(db, user, b.auth, ip);
  if (row.error) return json({ error: row.error }, row.status, h);
  if (!row.sync) return json({ error: (await deviceRemoved(db, user, b.token)) ? 'removed' : 'sync' }, 403, h);
  if (!validId(b.token)) return json({ error: 'device' }, 403, h);
  const dev = await db.prepare('SELECT device, seen, state FROM devices WHERE user = ? AND token = ?').bind(user, await sha256(b.token)).first();
  if (!dev) return json({ error: 'device' }, 403, h);
  if (dev.state !== 'active') return json({ error: dev.state }, 403, h);
  const now = Date.now();
  // zuletzt gesehen (höchstens einmal je Minute schreiben); Platzhalter vom Einschalten bekommt die echte Geräte-ID
  let device = dev.device;
  if (validId(b.device) && b.device !== device && !(await db.prepare('SELECT 1 AS x FROM devices WHERE user = ? AND device = ?').bind(user, b.device).first())) {
    await db.prepare('UPDATE devices SET device = ?, seen = ? WHERE user = ? AND device = ?').bind(b.device, now, user, device).run();
    device = b.device;
  } else if (now - (dev.seen || 0) > 60000) await db.prepare('UPDATE devices SET seen = ? WHERE user = ? AND device = ?').bind(now, user, device).run();

  if (b.action === 'head') return json({ rev: row.sync_rev, kg: row.kg, f: row.max_f, rekey: !!row.rekey, created: row.created }, 200, h);

  if (b.action === 'pull') {
    const since = Math.max(0, Math.floor(Number(b.since) || 0));
    // erst nur die Größen: Bilder sind groß, also höchstens SYNC_PULL_MAX Zeichen auf einmal (mindestens ein Datensatz)
    const meta = (await db.prepare('SELECT rev, LENGTH(data) AS n FROM sync WHERE user = ? AND rev > ? ORDER BY rev LIMIT 500').bind(user, since).all()).results;
    let upto = since;
    let size = 0;
    let picked = 0;
    for (const m of meta) {
      if (picked && size + m.n > SYNC_PULL_MAX) break;
      size += m.n;
      upto = m.rev;
      picked++;
    }
    const more = picked < meta.length || meta.length === 500;
    const [recs, devs] = picked
      ? await db.batch([
          db.prepare('SELECT k, id, rev, updated, dev, del, f, kg, data FROM sync WHERE user = ? AND rev > ? AND rev <= ? ORDER BY rev').bind(user, since, upto),
          db.prepare('SELECT device, name FROM devices WHERE user = ?').bind(user),
        ])
      : [{ results: [] }, { results: [] }];
    return json(
      {
        records: recs.results.map(syncOut),
        devices: Object.fromEntries(devs.results.map((d) => [d.device, d.name || ''])),
        // fertig: Stand = Zähler des Kontos (Lücken durch überschriebene Fassungen gibt es immer)
        rev: more ? upto : Math.max(upto, row.sync_rev),
        more,
        kg: row.kg,
        f: row.max_f,
      },
      200,
      h
    );
  }

  if (b.action === 'push') {
    const recs = Array.isArray(b.records) ? b.records : [];
    if (!recs.length || recs.length > SYNC_PUSH_MAX) return json({ error: 'records' }, 400, h);
    const f = Math.floor(Number(b.f) || 0);
    if (f < 1) return json({ error: 'version' }, 400, h);
    // ein Gerät mit älterer App sendet nicht (es könnte Neues der neueren Fassung verlieren)
    if (f < row.max_f) return json({ error: 'version', f: row.max_f }, 409, h);
    if (Number(b.kg) !== row.kg) return json({ error: 'kg', kg: row.kg }, 409, h);
    const seen = new Set();
    for (const r of recs) {
      const key = `${r && r.k}\n${r && r.id}`;
      const ok =
        r && SYNC_KINDS.has(r.k) && typeof r.id === 'string' && /^[^\u0000-\u001f]{1,200}$/.test(r.id) && Number.isInteger(r.base) && r.base >= 0 &&
        (r.del ? r.data == null || r.data === '' : typeof r.data === 'string' && r.data.length <= SYNC_DATA_MAX && sealedRe.test(r.data)) && !seen.has(key);
      if (!ok) return json({ error: 'record', k: r && r.k, id: r && r.id }, 400, h);
      seen.add(key);
    }
    const ops = [];
    if (f > row.max_f) ops.push(db.prepare('UPDATE accounts SET max_f = ? WHERE user = ? AND max_f < ?').bind(f, user, f));
    // je Datensatz in einem Rutsch (D1: atomar): alte Fassung aufheben, Zähler +1, neue Fassung schreiben – alles nur,
    // wenn auf dem Server noch die Fassung base liegt (sonst hat ein anderes Gerät inzwischen geändert → Konflikt)
    const writes = [];
    for (const r of recs) {
      const cond = [user, r.k, r.id, r.base];
      if (r.base > 0)
        ops.push(
          db
            .prepare(SYNC_KEEP_OLD)
            .bind(now, user, r.k, r.id, r.base, row.kg)
        );
      ops.push(db.prepare(`UPDATE accounts SET sync_rev = sync_rev + 1 WHERE user = ? AND ${SYNC_BASE}`).bind(user, ...cond));
      writes.push(ops.length);
      ops.push(
        db
          .prepare(
            `INSERT INTO sync (user, k, id, rev, updated, dev, del, f, kg, data) SELECT user, ?, ?, sync_rev, ?, ?, ?, ?, ?, ? FROM accounts WHERE user = ? AND ${SYNC_BASE} ` +
              'ON CONFLICT(user, k, id) DO UPDATE SET rev = excluded.rev, updated = excluded.updated, dev = excluded.dev, del = excluded.del, f = excluded.f, kg = excluded.kg, data = excluded.data'
          )
          .bind(r.k, r.id, now, device, r.del ? 1 : 0, f, row.kg, r.del ? '' : r.data, user, ...cond)
      );
    }
    ops.push(db.prepare('SELECT sync_rev FROM accounts WHERE user = ?').bind(user));
    const res = await db.batch(ops);
    const head = res[res.length - 1].results[0].sync_rev;
    const done = recs.map((r, i) => (res[writes[i]].meta.changes || 0) > 0);
    // angenommene haben im Rutsch aufeinanderfolgende rev bekommen, der letzte = head
    let rev = head - done.filter(Boolean).length;
    const accepted = [];
    recs.forEach((r, i) => done[i] && accepted.push({ k: r.k, id: r.id, rev: ++rev }));
    // abgelehnte: die Fassung auf dem Server mitschicken (null = gibt es nicht mehr)
    const lost = recs.filter((r, i) => !done[i]);
    const rejected = [];
    if (lost.length) {
      const cur = await db.batch(lost.map((r) => db.prepare('SELECT k, id, rev, updated, dev, del, f, kg, data FROM sync WHERE user = ? AND k = ? AND id = ?').bind(user, r.k, r.id)));
      lost.forEach((r, i) => rejected.push(cur[i].results[0] ? syncOut(cur[i].results[0]) : { k: r.k, id: r.id, rev: 0, del: true, data: '' }));
    }
    // gelegentlich aufräumen
    if (Math.random() < 0.05)
      await db.batch([
        db.prepare('DELETE FROM sync_old WHERE replaced < ?').bind(now - SYNC_OLD_DAYS * 86400e3),
        db.prepare('DELETE FROM sync WHERE del = 1 AND updated < ?').bind(now - SYNC_DEL_DAYS * 86400e3),
        db.prepare("DELETE FROM devices WHERE state = 'removed' AND changed < ?").bind(now - SYNC_REMOVED_DAYS * 86400e3),
      ]);
    return json({ accepted, rejected, rev: head }, 200, h);
  }

  // Nach einem Passwortwechsel: Datensätze mit einem älteren Schlüssel, den dieses Gerät noch kennt (kgs) – es
  // verschlüsselt sie neu und sendet sie per push (base = rev) zurück. Nichts mehr übrig → rekey aus
  if (b.action === 'rekey') {
    const kgs = JSON.stringify((Array.isArray(b.kgs) ? b.kgs : []).map(Number).filter((n) => Number.isInteger(n) && n > 0 && n < row.kg).slice(0, 20));
    const meta = (await db.prepare('SELECT rev, LENGTH(data) AS n FROM sync WHERE user = ? AND del = 0 AND kg IN (SELECT value FROM json_each(?)) ORDER BY rev LIMIT ?').bind(user, kgs, SYNC_PUSH_MAX).all()).results;
    // höchstens so viel, wie wieder in ein Senden passt (mindestens einer)
    let upto = 0;
    let size = 0;
    for (const m of meta) {
      if (upto && size + m.n > SYNC_REKEY_MAX) break;
      size += m.n;
      upto = m.rev;
    }
    const recs = upto
      ? (await db.prepare('SELECT k, id, rev, updated, dev, del, f, kg, data FROM sync WHERE user = ? AND del = 0 AND kg IN (SELECT value FROM json_each(?)) AND rev <= ? ORDER BY rev').bind(user, kgs, upto).all()).results
      : [];
    const left = (await db.prepare('SELECT COUNT(*) AS n FROM sync WHERE user = ? AND del = 0 AND kg <> ?').bind(user, row.kg).first()).n;
    if (!left && row.rekey) await db.prepare('UPDATE accounts SET rekey = 0, kg_at = ? WHERE user = ? AND kg = ?').bind(now, user, row.kg).run();
    return json({ records: recs.map(syncOut), left }, 200, h);
  }

  if (b.action === 'restore-days' || b.action === 'restore') {
    // während des Neu-Verschlüsselns ließe sich ein Teil des Stands nicht lesen
    if (row.rekey) return json({ error: 'rekey' }, 409, h);
    // frühestens: vor 30 Tagen (so lange bleiben alte Fassungen), seit dem ersten Hochladen, seit dem letzten Passwortwechsel
    const first = await db
      .prepare('SELECT MIN(t) AS t FROM (SELECT MIN(updated) AS t FROM sync WHERE user = ? UNION ALL SELECT MIN(COALESCE(updated, replaced)) FROM sync_old WHERE user = ?)')
      .bind(user, user)
      .first();
    const from = Math.max(now - SYNC_OLD_DAYS * 86400e3 + 3600e3, row.kg_at || 0, (first && first.t) || now);
    if (b.action === 'restore-days') {
      const [a, o] = await db.batch([
        db.prepare('SELECT updated AS t FROM sync WHERE user = ? AND updated > ?').bind(user, from),
        db.prepare('SELECT updated AS t FROM sync_old WHERE user = ? AND updated > ?').bind(user, from),
      ]);
      const days = {};
      for (const r of [...a.results, ...o.results]) days[berlinDay(r.t)] = (days[berlinDay(r.t)] || 0) + 1;
      return json({ from, days, undo: row.restored_at && row.restored_at > from ? row.restored_at : null }, 200, h);
    }
    const at = Math.floor(Number(b.at) || 0);
    if (at < from || at > now) return json({ error: 'at' }, 400, h);
    // geändert seit at: welche Fassung galt damals? (die neueste, die vor at entstand; keine = gab es noch nicht)
    const [cur, old] = await db.batch([
      db.prepare('SELECT k, id, rev, updated, del, f, kg, LENGTH(data) AS n FROM sync WHERE user = ? AND updated > ?').bind(user, at),
      db.prepare('SELECT k, id, rev, updated, del, f, kg, LENGTH(data) AS n FROM sync_old WHERE user = ? AND replaced > ?').bind(user, at),
    ]);
    const byKey = new Map();
    for (const o of old.results) byKey.set(`${o.k}\n${o.id}`, [...(byKey.get(`${o.k}\n${o.id}`) || []), o]);
    let todo = [];
    const same = [];
    for (const c of cur.results) {
      const vers = byKey.get(`${c.k}\n${c.id}`) || [];
      // ältere Zeilen ohne updated: unbekannt, wann sie entstanden – nicht raten
      if (vers.some((v) => v.updated == null)) continue;
      const t = vers.filter((v) => v.updated <= at).sort((x, y) => y.rev - x.rev)[0] || { del: 1, kg: row.kg, f: c.f };
      if (t.del && c.del) continue;
      if (!t.del && t.kg !== row.kg) continue;
      // gleiche Länge: vielleicht schon wiederhergestellt (gleiche Daten; neu verschlüsselt wären sie verschieden)
      (!t.del && !c.del && t.n === c.n ? same : todo).push({ c, t });
    }
    if (same.length) {
      const eq = await db.batch(
        same.map(({ c, t }) =>
          db
            .prepare('SELECT (SELECT data FROM sync WHERE user = ? AND k = ? AND id = ?) = (SELECT data FROM sync_old WHERE user = ? AND k = ? AND id = ? AND rev = ? LIMIT 1) AS eq')
            .bind(user, c.k, c.id, user, c.k, c.id, t.rev)
        )
      );
      todo = todo.concat(same.filter((x, i) => !eq[i].results[0].eq));
    }
    const chunk = todo.slice(0, SYNC_PUSH_MAX);
    const ops = [];
    if (b.first && chunk.length) ops.push(db.prepare('UPDATE accounts SET restored_at = ? WHERE user = ?').bind(now, user));
    // wie push: alte Fassung aufheben, Zähler +1, Fassung von damals als neue – nur, wenn sich nichts dazwischen geändert hat
    for (const { c, t } of chunk) {
      const cond = [user, c.k, c.id, c.rev];
      ops.push(db.prepare(SYNC_KEEP_OLD).bind(now, ...cond, row.kg));
      ops.push(db.prepare(`UPDATE accounts SET sync_rev = sync_rev + 1 WHERE user = ? AND ${SYNC_BASE}`).bind(user, ...cond));
      ops.push(
        db
          .prepare(
            'UPDATE sync SET rev = (SELECT sync_rev FROM accounts WHERE user = ?), updated = ?, dev = ?, del = ?, f = ?, kg = ?, ' +
              `data = ${t.del ? "''" : '(SELECT data FROM sync_old WHERE user = ? AND k = ? AND id = ? AND rev = ? LIMIT 1)'} WHERE user = ? AND k = ? AND id = ? AND rev = ?`
          )
          .bind(user, now, device, t.del ? 1 : 0, t.f || c.f, t.kg || row.kg, ...(t.del ? [] : [user, c.k, c.id, t.rev]), ...cond)
      );
    }
    ops.push(db.prepare('SELECT sync_rev FROM accounts WHERE user = ?').bind(user));
    const res = await db.batch(ops);
    return json({ changed: chunk.length, more: todo.length > chunk.length, rev: res[res.length - 1].results[0].sync_rev }, 200, h);
  }

  if (b.action === 'devices') return json({ devices: (await deviceList(db, user)).map((d) => ({ ...d, me: d.device === device })) }, 200, h);
  if (b.action === 'device-name') {
    const name = String(b.name ?? '').trim().slice(0, 40);
    if (!validId(b.device) || !name) return json({ error: 'name' }, 400, h);
    await db.prepare('UPDATE devices SET name = ? WHERE user = ? AND device = ?').bind(name, user, b.device).run();
    return json({ devices: (await deviceList(db, user)).map((d) => ({ ...d, me: d.device === device })) }, 200, h);
  }
  if (b.action === 'device-remove') {
    if (!validId(b.device)) return json({ error: 'device' }, 400, h);
    await deviceRemove(db, user, b.device);
    return json({ devices: (await deviceList(db, user)).map((d) => ({ ...d, me: d.device === device })) }, 200, h);
  }
  return json({ error: 'action' }, 400, h);
}

/** Eigener Eintrag im laufenden Monat (Token passt) mit Konto: { token, name } oder { error: 'join' | 'token' | 'konto' | 'left' | 'removed' } */
async function teamMember(db, body) {
  const me = await db.prepare('SELECT token, name FROM members WHERE member = ?').bind(body.member).first();
  if (!me) return { error: 'join' };
  const own = await ownsMember(db, body.member, await sha256(body.token));
  if (own) return { error: own };
  // Konto auf der Server-Seite gelöscht: nicht mehr schreiben (Lesen geht ohne Konto ohnehin nicht)
  if (!(await db.prepare('SELECT user FROM accounts WHERE member = ?').bind(body.member).first())) return { error: 'konto' };
  return me;
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
  const row = await checkAccount(db, headerUser(req), req.headers.get('X-Auth'), clientIp(req));
  if (row.error) return json({ error: row.error }, row.status, h);
  const devErr = await deviceError(db, row, req.headers.get('X-Token'));
  if (devErr) return json({ error: devErr }, 403, h);
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

export default {
  async fetch(req, env, ctx) {
    const isReports = new URL(req.url).pathname === '/reports';
    const h = isReports ? REPORT_CORS : cors(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });
    // Arbeitsschein-App: eigener Schlüssel statt Team-Code
    if (isReports) {
      if (req.method !== 'POST' && req.method !== 'DELETE') return json({ error: 'method' }, 405, h);
      return reportsRequest(env.DB, req, env, h);
    }

    // Der Admin-Code gilt auch als Team-Code (der Admin tritt mit ihm bei). Nach CODE_FAILS falschen Codes von
    // derselben Adresse AUTH_WAIT Minuten Pause – auch für den richtigen (sonst ließe sich weiter durchprobieren)
    const db = env.DB;
    const path = new URL(req.url).pathname;
    // Abgleich: alles im Inhalt (siehe syncRequest)
    let syncBody = null;
    if (path === '/sync' && req.method === 'POST') {
      try {
        syncBody = await readBody(req);
      } catch {
        return json({ error: 'body' }, 400, h);
      }
      if (!syncBody || typeof syncBody !== 'object') return json({ error: 'body' }, 400, h);
    }
    const teamCode = syncBody ? String(syncBody.code ?? '') : req.headers.get('X-Team-Code');
    const codeKey = `code|${clientIp(req)}`;
    const now0 = Date.now();
    let codeFails = null;
    try {
      codeFails = await db.prepare('SELECT fails, failed FROM auth_fails WHERE key = ?').bind(codeKey).first();
    } catch (e) {
      if (!/no such table/i.test(String(e && e.message))) throw e;
    }
    if (codeFails && codeFails.fails >= CODE_FAILS && now0 - codeFails.failed < AUTH_WAIT * 60000) return json({ error: 'wait' }, 429, h);
    if (!sameCode(teamCode, env.ADMIN_CODE) && !sameCode(teamCode, await currentTeamCode(env))) {
      await db.batch([
        db.prepare(AUTH_FAILS_TABLE),
        db.prepare('INSERT INTO auth_fails (key, fails, failed) VALUES (?, 1, ?) ON CONFLICT(key) DO UPDATE SET fails = CASE WHEN ? - failed > ? THEN 1 ELSE fails + 1 END, failed = ?')
          .bind(codeKey, now0, now0, AUTH_WAIT * 60000, now0),
      ]);
      // kurze Pause erschwert das Durchprobieren von Codes
      await new Promise((r) => setTimeout(r, 400));
      return json({ error: 'code' }, 401, h);
    }
    if (codeFails) await db.prepare('DELETE FROM auth_fails WHERE key = ?').bind(codeKey).run();

    const month = currentMonth();
    const prevMonth = prevMonthOf(month);
    // Einmal je Worker-Instanz und Monat, in einem Rutsch: Tabellen anlegen; beim Monatswechsel wandern die Zettel in
    // history (Vormonat bleibt sichtbar), Älteres wird gelöscht; Nachrichten bleiben (begrenzt auf POSTS_KEEP)
    if (rolledMonth !== month) await db.batch([
      db.prepare('CREATE TABLE IF NOT EXISTS members (member TEXT PRIMARY KEY, token TEXT NOT NULL, name TEXT, month TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, name TEXT, month TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL)'),
      db.prepare(HISTORY_TABLE),
      db.prepare(`INSERT INTO history (member, month, name, data, updated) SELECT member, month, name, data, updated FROM members WHERE month = ? ${HISTORY_SET}`).bind(prevMonth),
      // nur Älteres löschen: eine Instanz, die kurz vor Mitternacht noch den alten Monat rechnet, löscht sonst den neuen Vormonat
      db.prepare('DELETE FROM members WHERE month < ?').bind(month),
      db.prepare('DELETE FROM history WHERE month < ?').bind(prevMonth),
    ]);
    rolledMonth = month;

    try {
      if (syncBody) return await syncRequest(db, syncBody, h, clientIp(req));
      // Antwortzeit für die Server-Seite: Team-Code und ein Weg zur Datenbank, ohne Inhalt
      if (path === '/ping' && req.method === 'GET') {
        await db.prepare('SELECT 1').first();
        return json({ ok: true }, 200, h);
      }

      if ((path === '/account' && req.method === 'POST') || (path === '/backup' && req.method === 'PUT')) {
        await db.batch(ACCOUNT_TABLES.map((sql) => db.prepare(sql)));
        return path === '/backup' ? await backupPut(db, req, h) : await accountRequest(db, await readBody(req), h, clientIp(req));
      }
      if (path === '/team' && req.method === 'GET') {
        // Lesen nur mit Konto (Team-Code allein reicht nicht); ohne Angaben 'konto', sonst wie beim Anmelden
        const acc = await checkAccount(db, headerUser(req), req.headers.get('X-Auth'), clientIp(req));
        if (acc.error === 'id') return json({ error: 'konto' }, 403, h);
        if (acc.error) return json({ error: acc.error }, acc.status, h);
        const devErr = await deviceError(db, acc, req.headers.get('X-Token'));
        if (devErr) return json({ error: devErr }, 403, h);
        const [cur, prev, posts] = await db.batch([
          db.prepare('SELECT member, name, updated, data FROM members WHERE month = ? ORDER BY name').bind(month),
          db.prepare('SELECT member, name, updated, data FROM history WHERE month = ? ORDER BY name').bind(prevMonth),
          db.prepare('SELECT id, member, name, text, created FROM posts ORDER BY created DESC LIMIT ?').bind(POSTS_KEEP),
        ]);
        const list = (rows) => rows.results.map((r) => ({ member: r.member, name: r.name, updated: r.updated, sheets: JSON.parse(r.data) }));
        const regeln = await regelnRead(db);
        return json({ month, members: list(cur), prev: { month: prevMonth, members: list(prev) }, posts: posts.results, spellV: await spellVersion(await loadDict(db)), trV: AI_TR_V, regelnRev: regeln ? regeln.rev : 0 }, 200, h);
      }
      // Regeln holen (wie /team nur mit Konto); die App fragt nur, wenn regelnRev sich geändert hat
      if (path === '/regeln' && req.method === 'GET') {
        const acc = await checkAccount(db, headerUser(req), req.headers.get('X-Auth'), clientIp(req));
        if (acc.error === 'id') return json({ error: 'konto' }, 403, h);
        if (acc.error) return json({ error: acc.error }, acc.status, h);
        const devErr = await deviceError(db, acc, req.headers.get('X-Token'));
        if (devErr) return json({ error: devErr }, 403, h);
        return json((await regelnRead(db)) || { rev: 0 }, 200, h);
      }

      if (path === '/post' && (req.method === 'POST' || req.method === 'DELETE')) {
        const body = await readBody(req);
        if (!validId(body.member) || !validId(body.token)) return json({ error: 'id' }, 400, h);
        // Nur wer im laufenden Monat einen Eintrag hat (Token geprüft) und ein Konto, darf schreiben
        const me = await teamMember(db, body);
        if (me.error) return json({ error: me.error }, 403, h);

        if (req.method === 'DELETE') {
          await db.prepare('DELETE FROM posts WHERE id = ? AND member = ?').bind(Number(body.id) || 0, body.member).run();
          return json({ ok: true }, 200, h);
        }
        const text = String(body.text ?? '').trim().slice(0, MAX_TEXT);
        if (!text) return json({ error: 'text' }, 400, h);
        const { n } = await db.prepare('SELECT COUNT(*) AS n FROM posts WHERE member = ? AND created > ?').bind(body.member, Date.now() - 86400000).first();
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
        const me = await teamMember(db, body);
        if (me.error) return json({ error: me.error }, 403, h);
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
                  // ins Deutsche: noch kyrillisch (z. B. Name nicht umgeschrieben) gilt nicht als Übersetzung
                  if (!x || (to === 'de' && /[\u0400-\u04FF]/.test(x))) return;
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
          let res;
          try {
            res = await aiJson(env, AI_SITES, names.map((n, i) => `${i + 1}: ${n}`).join('\n'), 60 + names.length * 8);
          } catch {
            // KI antwortet nicht (Kontingent, kaputtes JSON): kein Serverfehler, die App fragt beim nächsten Mal wieder
            return json({ error: 'ai' }, 429, h);
          }
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
        const own = me ? await ownsMember(db, body.member, await sha256(String(body.token ?? ''))) : '';
        if (own) return json({ error: own }, 403, h);
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

      if (path === '/errors' || path === '/push' || path === '/dict' || path === '/member' || path === '/account' || path === '/alias' || path === '/code' || path === '/sync-switch' || path === '/regeln' || path === '/regeln-alt') {
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
          await ensureSync(db);
          const [, , , , errors, size, people, posts, dict, accounts, open, devices] = await db.batch([
            ...ACCOUNT_TABLES.map((sql) => db.prepare(sql)),
            db.prepare('CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, name TEXT, version TEXT, ua TEXT, view TEXT, message TEXT NOT NULL, stack TEXT, count INTEGER NOT NULL, first INTEGER, last INTEGER, created INTEGER NOT NULL)'),
            db.prepare('CREATE TABLE IF NOT EXISTS dict (key TEXT PRIMARY KEY, word TEXT NOT NULL, created INTEGER NOT NULL)'),
            db.prepare('SELECT id, name, version, ua, view, message, stack, count, first, last, created FROM errors ORDER BY created DESC LIMIT 50'),
            db.prepare(
              `SELECT (SELECT COALESCE(SUM(${bytes(['member', 'token', 'name', 'month', 'data', 'version'])}), 0) FROM members) + ` +
                `(SELECT COALESCE(SUM(${bytes(['member', 'name', 'month', 'data'])}), 0) FROM history) AS sheets, ` +
                `(SELECT COALESCE(SUM(${bytes(['member', 'name', 'month', 'text'])}), 0) FROM posts) AS posts, ` +
                `(SELECT COALESCE(SUM(${bytes(['member', 'name', 'version', 'ua', 'view', 'message', 'stack'])}), 0) FROM errors) AS errors, ` +
                `(SELECT COALESCE(SUM(LENGTH(data)), 0) FROM backups) AS backups, ` +
                `(SELECT COALESCE(SUM(LENGTH(data)), 0) FROM sync) + (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM sync_old) AS sync`
            ),
            // Team diesen Monat: je Person App-Version, letzter Upload, Zahl der Zettel
            db.prepare('SELECT member, name, version, updated, json_array_length(data) AS sheets FROM members WHERE month = ? ORDER BY name').bind(month),
            db.prepare('SELECT COUNT(*) AS n FROM posts WHERE month = ?').bind(month),
            db.prepare('SELECT word FROM dict ORDER BY word COLLATE NOCASE'),
            // Konten: Name, letzte Sicherung, Größe aller Sicherungen
            db.prepare('SELECT a.user, a.member, a.name, a.fullname, a.sync, (SELECT MAX(at) FROM backups b WHERE b.user = a.user) AS last, (SELECT COALESCE(SUM(LENGTH(data)), 0) FROM backups b WHERE b.user = a.user) AS bytes FROM accounts a ORDER BY a.user'),
            // Arbeitsscheine: Namen, die noch keinem Konto zugeordnet sind (je Name, Zahl der Scheine)
            db.prepare('SELECT key, MAX(name) AS name, COUNT(*) AS n, MAX(changed) AS last FROM report_open GROUP BY key ORDER BY last DESC'),
            // Geräte der Konten mit Abgleich
            db.prepare("SELECT user, device, name, seen, state FROM devices WHERE state <> 'removed' ORDER BY created"),
          ]);
          const s = size.results[0];
          const storage = { total: size.meta.size_after || 0, limit: STORAGE_LIMIT, sheets: s.sheets, posts: s.posts, errors: s.errors, backups: s.backups, sync: s.sync };
          for (const a of accounts.results) a.devices = devices.results.filter((d) => d.user === a.user).map(({ device, name, seen, state }) => ({ device, name, seen, state }));
          const team = { month, people: people.results, posts: posts.results[0].n };
          return json({ errors: errors.results, storage, team, dict: dict.results.map((d) => d.word), accounts: accounts.results, open: open.results, code: await currentTeamCode(env), usage: await usage }, 200, h);
        }

        if (path === '/code' && req.method === 'PUT') {
          const body = await readBody(req);
          const code = String(body.code ?? '').trim();
          // nur Zeichen, die im Header X-Team-Code gehen (kyrillische ließen fetch in jeder App scheitern)
          if (!/^[A-Za-z0-9._-]{6,40}$/.test(code)) return json({ error: 'code' }, 400, h);
          // sonst wären alle Kollegen Admin
          if (sameCode(code, env.ADMIN_CODE)) return json({ error: 'admin' }, 400, h);
          await db.batch([
            db.prepare('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)'),
            db.prepare("INSERT INTO config (key, value) VALUES ('team_code', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").bind(code),
          ]);
          teamCodeCache = { code, at: Date.now() };
          return json({ code }, 200, h);
        }
        // Regeln speichern: base = bekannte rev (zwei Admin-Geräte gleichzeitig → abgelehnt mit der Server-Fassung)
        if (path === '/regeln' && req.method === 'PUT') {
          const body = await readBody(req);
          const regeln = body && body.regeln;
          if (!regeln || typeof regeln !== 'object' || Array.isArray(regeln)) return json({ error: 'regeln' }, 400, h);
          const text = JSON.stringify(regeln);
          if (text.length > REGELN_MAX) return json({ error: 'size' }, 413, h);
          await db.prepare('CREATE TABLE IF NOT EXISTS config (key TEXT PRIMARY KEY, value TEXT NOT NULL)').run();
          const cur = await regelnRead(db);
          const rev = cur ? cur.rev : 0;
          if (Number(body.base) !== rev) return json({ error: 'rev', ...(cur || { rev: 0 }) }, 409, h);
          const next = { rev: rev + 1, zeit: Date.now(), regeln };
          const alt = cur ? [cur, ...((await regelnRead(db, 'regeln_alt')) || [])] : (await regelnRead(db, 'regeln_alt')) || [];
          // so viele frühere Fassungen, wie zusammen in eine Zeile passen
          const keep = [];
          let bytes = 0;
          for (const a of alt.slice(0, REGELN_KEEP)) {
            bytes += JSON.stringify(a).length;
            if (bytes > 850_000) break;
            keep.push(a);
          }
          const put = "INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value";
          await db.batch([db.prepare(put).bind('regeln', JSON.stringify(next)), db.prepare(put).bind('regeln_alt', JSON.stringify(keep))]);
          return json({ rev: next.rev, zeit: next.zeit }, 200, h);
        }
        if (path === '/regeln-alt' && req.method === 'GET') return json({ alt: (await regelnRead(db, 'regeln_alt')) || [] }, 200, h);
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
          await ensureSync(db);
          await db.batch(accountDeleteOps(db, user));
          return json({ ok: true }, 200, h);
        }
        if (path === '/sync-switch' && req.method === 'PUT') {
          const body = await readBody(req);
          const user = userKey(body.user);
          await ensureSync(db);
          const acc = user && (await db.prepare('SELECT user, member, token, sync FROM accounts WHERE user = ?').bind(user).first());
          if (!acc) return json({ error: 'user' }, 400, h);
          const now = Date.now();
          if (body.on && !acc.sync) {
            // Das bisherige Gerät wird Gerät 1 (Geräte-ID noch unbekannt: Platzhalter, ersetzt beim ersten Abgleich).
            // Datensätze mit älterem Schlüssel (Passwort geändert, während der Abgleich aus war) kann kein Gerät mehr öffnen
            // oder neu verschlüsseln: weg damit, sonst hinge jedes Gerät daran (Senden immer abgelehnt)
            const ops = [
              db.prepare('UPDATE accounts SET sync = 1, rekey = 0 WHERE user = ?').bind(user),
              db.prepare('DELETE FROM sync WHERE user = ? AND kg < (SELECT kg FROM accounts WHERE user = ?)').bind(user, user),
              db.prepare('DELETE FROM sync_old WHERE user = ? AND kg < (SELECT kg FROM accounts WHERE user = ?)').bind(user, user),
            ];
            if (acc.token)
              ops.push(
                db
                  .prepare("INSERT OR IGNORE INTO devices (user, device, token, name, created, seen, state, changed) VALUES (?, ?, ?, 'Gerät', ?, ?, 'active', ?)")
                  .bind(user, `alt-${crypto.randomUUID()}`, acc.token, now, now, now)
              );
            await db.batch(ops);
          } else if (!body.on && acc.sync) {
            // Aus: nur das zuletzt gesehene Gerät bleibt Besitzer des Team-Eintrags; die anderen bekommen „token“ wie früher
            const last = await db.prepare("SELECT token FROM devices WHERE user = ? AND state = 'active' ORDER BY seen DESC LIMIT 1").bind(user).first();
            const ops = [db.prepare('UPDATE accounts SET sync = 0, token = COALESCE(?, token) WHERE user = ?').bind(last ? last.token : null, user)];
            if (last && acc.member) ops.push(db.prepare('UPDATE members SET token = ? WHERE member = ?').bind(last.token, acc.member));
            // abgemeldete bleiben (SYNC_REMOVED_DAYS): sie bekommen weiter „removed“ und löschen ihre Daten
            ops.push(db.prepare("DELETE FROM devices WHERE user = ? AND (state <> 'removed' OR changed < ?)").bind(user, now - SYNC_REMOVED_DAYS * 86400e3));
            await db.batch(ops);
          }
          return json({ ok: true, sync: !!body.on }, 200, h);
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
        // Eintrag dieses iPhones? Auch ohne Zeile in members (Monatsanfang, nach dem Verlassen) über das Konto geprüft
        const own = await ownsMember(db, body.member, token);
        if (own) return json({ error: own }, 403, h);
        // Zettel nur von Einträgen, die zu einem Konto gehören (seit dem Konto Pflicht; alte Apps mit gespeichertem
        // Team-Code legten sonst eigene Einträge ohne Konto an). Verlassen geht immer
        const acc = await db.prepare('SELECT user, token, sync FROM accounts WHERE member = ?').bind(body.member).first();
        if (req.method === 'PUT' && !acc) return json({ error: 'konto' }, 403, h);
        // Konto von vor v102: Gerätenachweis beim ersten passenden Upload merken
        if (acc && acc.token !== token) await db.prepare('UPDATE accounts SET token = ? WHERE member = ?').bind(token, body.member).run();

        if (req.method === 'DELETE') {
          // Verlassen: auch der Vormonat verschwindet für das Team. Mit Abgleich gilt es für alle Geräte des Kontos
          // (sonst legten die anderen den Eintrag gleich wieder an): sie bekommen ab jetzt „left“
          await db.batch([
            db.prepare('DELETE FROM members WHERE member = ?').bind(body.member),
            db.prepare('DELETE FROM history WHERE member = ?').bind(body.member),
            ...(acc && acc.sync ? [db.prepare("UPDATE devices SET state = 'left', changed = ? WHERE user = ? AND state = 'active'").bind(Date.now(), acc.user)] : []),
          ]);
          return json({ ok: true }, 200, h);
        }
        // Zettel eines anderen Monats (Uhr des iPhones geht falsch, Monatswechsel) nicht speichern
        if (body.month !== month) return json({ error: 'month', month }, 409, h);
        // Form und Menge begrenzen: jede App im Team speichert die Zettel aller Kollegen
        if (!teamSheetsOk(body.sheets)) return json({ error: 'sheets' }, 400, h);
        const data = JSON.stringify(body.sheets);
        if (data.length > TEAM_SHEETS_MAX) return json({ error: 'size' }, 413, h);
        const name = String(body.name ?? '').slice(0, 80);
        const version = String(body.version ?? '').slice(0, 40) || null;
        await ensureVersionColumn(db);
        await db
          .prepare(
            'INSERT INTO members (member, token, name, month, data, updated, version) VALUES (?, ?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT(member) DO UPDATE SET name = excluded.name, month = excluded.month, data = excluded.data, updated = excluded.updated, version = excluded.version'
          )
          .bind(body.member, token, name, month, data, Date.now(), version)
          .run();
        // nachträglich geänderte Zettel des Vormonats
        // (leerer Vormonat nur, wenn es dort schon etwas gab: sonst stünde jeder Neue mit leerer Karte im Vormonat)
        const prevOk = body.prev && body.prev.month === prevMonth && teamSheetsOk(body.prev.sheets) && JSON.stringify(body.prev.sheets).length <= TEAM_SHEETS_MAX;
        if (prevOk && (body.prev.sheets.length || (await db.prepare('SELECT 1 AS x FROM history WHERE member = ? AND month = ?').bind(body.member, prevMonth).first())))
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
