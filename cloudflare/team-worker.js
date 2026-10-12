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
//   PUT    /me     ← { member, token, name, month, sheets }   eigener Eintrag
//   DELETE /me     ← { member, token }                         Team verlassen (eigene Nachrichten bleiben bis Monatsende)
//   POST   /post   ← { member, token, text }                   Nachricht an die Pinnwand (nur mit eigenem Eintrag)
//   DELETE /post   ← { member, token, id }                     eigene Nachricht löschen

const ORIGINS = ['https://y4t6bgp6g6-maker.github.io'];
const MAX_BODY = 1_000_000;
const MAX_TEXT = 500;
const MAX_POSTS = 300; // je Person und Monat

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
        'Access-Control-Allow-Headers': 'Content-Type, X-Team-Code',
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

export default {
  async fetch(req, env) {
    const h = cors(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: h });

    if (!sameCode(req.headers.get('X-Team-Code'), env.TEAM_CODE)) {
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
        await db
          .prepare(
            'INSERT INTO members (member, token, name, month, data, updated) VALUES (?, ?, ?, ?, ?, ?) ' +
              'ON CONFLICT(member) DO UPDATE SET name = excluded.name, month = excluded.month, data = excluded.data, updated = excluded.updated'
          )
          .bind(body.member, token, name, month, JSON.stringify(body.sheets), Date.now())
          .run();
        return json({ ok: true }, 200, h);
      }
    } catch (e) {
      return json({ error: 'body' }, 400, h);
    }
    return json({ error: 'not found' }, 404, h);
  },
};
