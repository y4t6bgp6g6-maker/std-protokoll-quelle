// Std-Protokoll – Team-Speicher (Cloudflare Worker mit D1-Datenbank in der EU)
//
// Jedes iPhone legt hier die Stundenzettel des laufenden Monats ab (ein Eintrag je Gerät, wird bei jeder
// Änderung überschrieben). Wer den Team-Code kennt, kann alle Einträge lesen. Einträge aus älteren Monaten
// löscht der Worker bei jeder Anfrage; damit ist der Speicher nach einem Monatswechsel leer.
//
// Einrichtung im Cloudflare-Dashboard:
//   - D1-Datenbank (Jurisdiction „EU“) als Binding mit dem Namen DB
//   - Secret TEAM_CODE: der Team-Code, den die Kollegen eingeben
// Die Tabelle legt der Worker selbst an.
//
// Anfragen (Code im Header X-Team-Code):
//   GET    /team   → { month, members: [{ member, name, updated, sheets }], posts: [{ id, member, name, text, created }] }
//   PUT    /me     ← { member, token, name, month, sheets, version }   eigener Eintrag (version: App-Version für die Admin-Seite)
//   DELETE /me     ← { member, token }                         Team verlassen (eigene Nachrichten bleiben bis Monatsende)
//   POST   /post   ← { member, token, text }                   Nachricht an die Pinnwand (nur mit eigenem Eintrag)
//   DELETE /post   ← { member, token, id }                     eigene Nachricht löschen
//   POST   /error  ← { member, token, name, version, ua, reports: [{ message, stack, view, count, first, last }] }
//                    Fehlerberichte der App; bleiben beim Monatswechsel erhalten (Tabelle errors), werden nach
//                    ERROR_DAYS Tagen gelöscht. Danach Mitteilung an die angemeldeten Admin-Geräte (Web Push),
//                    höchstens alle PUSH_GAP Minuten
// Nur mit Admin-Code (Header X-Admin-Code, Secret ADMIN_CODE; er gilt auch als Team-Code):
//   GET    /errors → { errors, storage, team }                die letzten Fehlerberichte, Speicherbelegung, Team diesen Monat
//   PUT    /push   ← { endpoint, keys: { p256dh, auth } }      Gerät für Mitteilungen anmelden
//   DELETE /push   ← { endpoint }                              abmelden
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
    await db.exec('CREATE TABLE IF NOT EXISTS members (member TEXT PRIMARY KEY, token TEXT NOT NULL, name TEXT, month TEXT NOT NULL, data TEXT NOT NULL, updated INTEGER NOT NULL)');
    await db.exec('CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, name TEXT, month TEXT NOT NULL, text TEXT NOT NULL, created INTEGER NOT NULL)');
    await db.prepare('DELETE FROM members WHERE month <> ?').bind(month).run();
    await db.prepare('DELETE FROM posts WHERE month <> ?').bind(month).run();

    const path = new URL(req.url).pathname;
    try {
      if (path === '/team' && req.method === 'GET') {
        const { results } = await db.prepare('SELECT member, name, updated, data FROM members WHERE month = ? ORDER BY name').bind(month).all();
        const members = results.map((r) => ({ member: r.member, name: r.name, updated: r.updated, sheets: JSON.parse(r.data) }));
        const posts = (await db.prepare('SELECT id, member, name, text, created FROM posts WHERE month = ? ORDER BY created DESC LIMIT 200').bind(month).all()).results;
        return json({ month, members, posts }, 200, h);
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

      if (path === '/errors' || path === '/push') {
        // Nur für den Admin: falscher Code wie beim Team-Code mit kurzer Pause
        if (!sameCode(req.headers.get('X-Admin-Code'), env.ADMIN_CODE)) {
          await new Promise((r) => setTimeout(r, 400));
          return json({ error: 'admin' }, 403, h);
        }
        if (path === '/errors' && req.method === 'GET') {
          await db.exec('CREATE TABLE IF NOT EXISTS errors (id INTEGER PRIMARY KEY AUTOINCREMENT, member TEXT NOT NULL, name TEXT, version TEXT, ua TEXT, view TEXT, message TEXT NOT NULL, stack TEXT, count INTEGER NOT NULL, first INTEGER, last INTEGER, created INTEGER NOT NULL)');
          await ensureVersionColumn(db);
          const { results } = await db.prepare('SELECT id, name, version, ua, view, message, stack, count, first, last, created FROM errors ORDER BY created DESC LIMIT 50').all();
          // Speicher: Größe der ganzen Datenbank (meta.size_after) und Bytes je Inhalt; der Rest ist die Datenbank selbst
          const bytes = (cols) => cols.map((c) => `COALESCE(LENGTH(CAST(${c} AS BLOB)), 0)`).join(' + ');
          const size = await db
            .prepare(
              `SELECT (SELECT COALESCE(SUM(${bytes(['member', 'token', 'name', 'month', 'data', 'version'])}), 0) FROM members) AS sheets, ` +
                `(SELECT COALESCE(SUM(${bytes(['member', 'name', 'month', 'text'])}), 0) FROM posts) AS posts, ` +
                `(SELECT COALESCE(SUM(${bytes(['member', 'name', 'version', 'ua', 'view', 'message', 'stack'])}), 0) FROM errors) AS errors`
            )
            .all();
          const s = size.results[0];
          const storage = { total: size.meta.size_after || 0, limit: STORAGE_LIMIT, sheets: s.sheets, posts: s.posts, errors: s.errors };
          // Team diesen Monat: je Person App-Version, letzter Upload, Zahl der Zettel
          const people = (await db.prepare('SELECT name, version, updated, json_array_length(data) AS sheets FROM members WHERE month = ? ORDER BY name').bind(month).all()).results;
          const { n: postCount } = await db.prepare('SELECT COUNT(*) AS n FROM posts WHERE month = ?').bind(month).first();
          return json({ errors: results, storage, team: { month, people, posts: postCount } }, 200, h);
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
