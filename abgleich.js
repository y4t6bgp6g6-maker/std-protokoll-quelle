// Std-Protokoll – Abgleich mehrerer Geräte (nur Konten mit Abgleich, Schalter auf der Server-Seite; Plan:
// Ideen/Plan-Abgleich-mehrere-Geraete.md). Zettel, Einstellungen, Reisekostenabrechnungen, Lohnabrechnungen,
// Arbeitsscheine und das Berichtsheft gehen je Datensatz verschlüsselt an den Team-Server
// (POST /sync, cloudflare/team-worker.js) und von dort auf die anderen Geräte desselben Kontos.
//
// Eigener Speicher je Gerät (nie abgeglichen, nicht in der Sicherung) stdprotokoll.sync.v1:
// { user, kinds, rev, kg, at, hold, recs, held, conflicts, devs }
//   rev: bis hierher abgeholt; at: zuletzt erfolgreich abgeholt (Team-Upload nur mit frischem Stand)
//   recs: { 'k:id': { rev, h, a } } je Datensatz der Stand auf dem Server und der Fingerabdruck der Fassung, die dieses
//         Gerät zuletzt gesendet oder übernommen hat ('del' = gelöscht, '!' = auf jeden Fall senden). Lokal anders →
//         senden (base = rev), lokal fehlt → Löschmarke. So muss keiner der vielen save…-Aufrufe wissen, was er ändert.
//         a: Fingerabdruck derselben Fassung nach dem automatischen Nachtragen (Feiertage, fixWeekend) – das macht
//         jedes Gerät selbst, es zählt nicht als eigene Änderung (sonst Konflikt mit jeder echten Änderung anderswo)
//   held: eingehende Fassungen des Zettels, der gerade mit ungespeicherten Tagen im Editor offen ist (später anwenden)
//   wait: eingehende Berichte, deren Heft hier (noch) fehlt (kommt es, werden sie angewendet)
//   conflicts: [{ key, k, id, srv: { rev, del, v, dev, updated }, twin }] auf zwei Geräten geändert → Fenster;
//              twin: anderer Zettel derselben Woche (auf zwei Geräten neu angelegt)
//   hold: höchste App-Fassung, die schon gesendet hat; ist sie neuer als diese, sendet dieses Gerät nichts mehr
//   devs: Geräte-ID → Name (für das Fenster)
// Arten: sheet (Zettel), set (Einstellung), trip (Abrechnung, ohne leere), pay (Lohnabrechnung, id = Monat „2026-08“),
// report (Arbeitsschein, id = Schein-id), Berichtsheft: bh-profile (id „profile“: Angaben, gespeicherte Unterschriften,
// automatisch unterschreiben), bh-heft (Heft ohne Wochen/Monate), bh-week (id „Heft-id|Montag“, nur beschriebene),
// bh-month (id „Heft-id|JJJJ-MM“, nur beschriebene), bh-img (Bild-id, { d: JPEG Base64 }; unveränderlich, nur neu oder
// gelöscht). Wochen und Monate tragen ihre Unterschriften; ein Heft löschen = Löschmarken für alles darin.
// Zettel, Abrechnung, Lohn, Berichtsheft: Konflikt-Fenster. Einstellungen, Arbeitsscheine: die zuletzt gesendete gilt (ohne
// SYNC_SET_SKIP, die bleiben je Gerät). Arbeitsscheine holt jedes Gerät weiter selbst ab (Server/Google); ein auf einem
// anderen Gerät gelöschter Schein kommt dabei nicht wieder (syncGone in addReports).

const SYNC_KEY = 'stdprotokoll.sync.v1';
/** App-Fassung (gleiche Zahl wie CACHE in sw.js): ein Gerät mit älterer sendet nicht mehr, sobald eine neuere gesendet hat */
const SYNC_F = 122;
/** Arten, die diese Fassung abgleicht (kommen neue dazu, holt das Gerät einmal alles neu ab) */
const SYNC_KINDS_HERE = ['sheet', 'set', 'trip', 'pay', 'report', 'bh-profile', 'bh-heft', 'bh-img', 'bh-week', 'bh-month'];
/** Einstellungen je Gerät bzw. fest vorgegeben */
const SYNC_SET_SKIP = new Set(['theme', 'listMode', 'ovCards', 'encryptBackup', 'target', 'hoursPerDay', 'minuteStep', 'state']);
const SYNC_PUSH_N = 40; // Worker: höchstens 40 Datensätze je Senden
const SYNC_PUSH_BYTES = 800_000; // Worker: Anfrage höchstens 1 MB
const SYNC_ONE_MAX = 950_000; // größere Datensätze passen nicht in eine Anfrage: übergehen statt alles aufzuhalten
const SYNC_KEEPALIVE = 50_000; // keepalive erlaubt 64 KB für alle offenen Anfragen zusammen (fehlerbericht.js braucht auch)
const SYNC_FRESH = 5 * 60e3; // so lange gilt der abgeholte Stand als aktuell (Team-Upload)
const SYNC_TICK = 45e3;

let syncSt = null;
function syncState() {
  const user = account ? account.user : '';
  if (!syncSt)
    try {
      syncSt = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
    } catch {}
  if (!syncSt || syncSt.user !== user) syncSt = { user, rev: 0, kg: 0, at: 0, hold: 0, recs: {}, held: [], conflicts: [], devs: {} };
  syncSt.wait ||= [];
  // neue Arten in dieser Fassung: einmal alles abholen (Fingerabdrücke verhindern doppelte Arbeit)
  if (String(syncSt.kinds) !== String(SYNC_KINDS_HERE)) {
    syncSt.kinds = SYNC_KINDS_HERE;
    syncSt.rev = 0;
    syncSt.at = 0;
  }
  return syncSt;
}
const syncSave = () => {
  try {
    localStorage.setItem(SYNC_KEY, JSON.stringify(syncSt));
  } catch {}
};

/** Abgleich aktiv: im Team, Konto bestätigt und mit Abgleich, Schlüssel da */
const syncOn = () => !!(team && account && account.ok && account.sync && !account.pwchanged && cryptStore && typeof settings !== 'undefined');

// ───────── Datensätze und Fingerabdrücke ─────────

/** JSON mit sortierten Schlüsseln: gleicher Inhalt = gleicher Text, egal in welcher Reihenfolge Felder entstanden */
const syncCanon = (v) =>
  JSON.stringify(v, (k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map((n) => [n, x[n]])) : x));
/** 64-Bit-Fingerabdruck (zwei verschiedene 32-Bit-Verfahren + Länge) */
function syncHash(s) {
  let a = 5381;
  let b = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = ((a << 5) + a + c) | 0;
    b = Math.imul(b ^ c, 0x01000193);
  }
  return `${(a >>> 0).toString(36)}.${(b >>> 0).toString(36)}.${s.length.toString(36)}`;
}
const syncH = (v) => (v == null ? 'del' : syncHash(syncCanon(v)));
/** Fingerabdruck je Art: Bilder ändern sich nie (neue ID je Bild) – ihr Inhalt muss nicht jedes Mal durchgerechnet werden */
const syncHk = (k, v) => (k === 'bh-img' ? (v == null ? 'del' : 'img') : syncH(v));
/** Zum Vergleich des Inhalts: ohne „zuletzt geändert“, eingelesen um, angezeigte Tage der Abrechnung */
const syncBareH = (k, v) =>
  v == null
    ? 'del'
    : k === 'sheet' || k === 'bh-week' || k === 'bh-month' || k === 'bh-profile'
    ? syncHk(k, { ...v, updatedAt: 0 })
    : k === 'trip'
    ? syncH({ ...v, updatedAt: 0, from: 0, to: 0 })
    : k === 'pay'
    ? syncH({ ...v, importedAt: 0, updatedAt: 0 })
    : syncHk(k, v);
/** Fingerabdruck nach dem automatischen Nachtragen beim Start (nur Zettel) */
function syncAutoH(k, v) {
  if (k !== 'sheet' || v == null) return undefined;
  const c = structuredClone(v);
  return fixWeekend(c) ? syncH(c) : undefined;
}
/** Merken, welche Fassung der Server hat */
const syncRec = (k, v, rev, h = syncHk(k, v)) => {
  const a = syncAutoH(k, v);
  return a ? { rev, h, a } : { rev, h };
};
const syncKeyOf = (k, id) => `${k}:${id}`;
const syncSplit = (key) => {
  const i = key.indexOf(':');
  return { k: key.slice(0, i), id: key.slice(i + 1) };
};

/** Alle Datensätze dieses Geräts: Map 'k:id' → { k, id, v } (Zettel im gespeicherten Stand) */
function syncLocal() {
  const m = new Map();
  for (const s of savedSheets()) m.set(syncKeyOf('sheet', s.id), { k: 'sheet', id: s.id, v: s });
  for (const [n, v] of Object.entries(settings)) if (!SYNC_SET_SKIP.has(n) && v !== undefined) m.set(syncKeyOf('set', n), { k: 'set', id: n, v: { v } });
  // leere Abrechnung (noch kein Tag): entsteht beim Öffnen und verschwindet beim Verlassen wieder
  for (const t of trips) if (t.dates.length) m.set(syncKeyOf('trip', t.id), { k: 'trip', id: t.id, v: t });
  for (const [n, p] of Object.entries(payslips)) if (p) m.set(syncKeyOf('pay', n), { k: 'pay', id: n, v: p });
  for (const r of reports()) m.set(syncKeyOf('report', r.id), { k: 'report', id: r.id, v: r });
  // Berichtsheft: Heft vor seinen Berichten, Bilder vor den Monaten (so kommt auf dem anderen Gerät alles in der Reihenfolge an)
  const add = (k, id, v) => v && m.set(syncKeyOf(k, id), { k, id, v });
  add('bh-profile', 'profile', syncBhProfile());
  for (const h of bh.hefte) add('bh-heft', h.id, syncBhHeft(h));
  if (bhImagesLoaded) for (const [id, d] of bhImages) add('bh-img', id, { d });
  for (const h of bh.hefte) {
    for (const [mon, w] of Object.entries(h.weeks || {})) if (weekFilled(w)) add('bh-week', `${h.id}|${mon}`, w);
    for (const [ym, mo] of Object.entries(h.months || {})) if (monthFilled(mo)) add('bh-month', `${h.id}|${ym}`, mo);
  }
  return m;
}
/** Angaben, gespeicherte Unterschriften und „Automatisch unterschreiben“ als ein Datensatz (null = noch nichts da) */
function syncBhProfile() {
  if (!Object.keys(bh.profile).length && !Object.keys(bh.sigs).length && !bh.autoSign) return null;
  return { profile: bh.profile, sigs: bh.sigs, autoSign: !!bh.autoSign, updatedAt: bh.profileAt };
}
/** Heft ohne seine Wochen und Monate (die sind eigene Datensätze) */
function syncBhHeft(h) {
  const { weeks, months, ...rest } = h;
  return rest;
}
/** „Heft-id|Montag“ → { h, key } */
function syncBhPage(id) {
  const i = id.lastIndexOf('|');
  return { hid: id.slice(0, i), key: id.slice(i + 1), h: findHeft(id.slice(0, i)) };
}
/** Ein Datensatz dieses Geräts (null = gibt es nicht) */
function syncLocalOne(k, id) {
  if (k === 'sheet') return savedSheet(findSheet(id)) || null;
  if (k === 'set') return !SYNC_SET_SKIP.has(id) && settings[id] !== undefined ? { v: settings[id] } : null;
  if (k === 'trip') return trips.find((t) => t.id === id && t.dates.length) || null;
  if (k === 'pay') return payslips[id] || null;
  if (k === 'report') return reports().find((r) => r.id === id) || null;
  if (k === 'bh-profile') return syncBhProfile();
  if (k === 'bh-heft') return findHeft(id) ? syncBhHeft(findHeft(id)) : null;
  if (k === 'bh-img') return bhImages.has(id) ? { d: bhImages.get(id) } : null;
  if (k === 'bh-week' || k === 'bh-month') {
    const { h, key } = syncBhPage(id);
    const x = h && (k === 'bh-week' ? h.weeks : h.months)[key];
    return x && (k === 'bh-week' ? weekFilled(x) : monthFilled(x)) ? x : null;
  }
  return null;
}
/** Auf einem anderen Gerät gelöscht (Arbeitsschein beim Abholen nicht wieder aufnehmen) */
const syncGone = (k, id) => {
  if (!(account && account.sync)) return false;
  const e = syncState().recs[syncKeyOf(k, id)];
  return !!e && e.h === 'del';
};

/** Was zu senden ist: [{ key, k, id, base, del, v, h }] – ohne Datensätze mit offenem Konflikt */
function syncChanges(local = syncLocal()) {
  const st = syncState();
  // offener Konflikt, zurückgehaltene Fassung (Editor): erst nach der Wahl bzw. dem Speichern
  const blocked = new Set([...st.conflicts.flatMap((c) => [c.key, ...(c.twin ? [syncKeyOf('sheet', c.twin)] : [])]), ...st.held.map((x) => syncKeyOf(x.k, x.id))]);
  const out = [];
  for (const [key, r] of local) {
    if (blocked.has(key)) continue;
    const h = syncHk(r.k, r.v);
    const e = st.recs[key];
    if (!e || e.h !== h) out.push({ key, k: r.k, id: r.id, base: e ? e.rev : 0, v: r.v, h });
  }
  for (const [key, e] of Object.entries(st.recs)) {
    const { k, id } = syncSplit(key);
    if (local.has(key) || e.h === 'del' || blocked.has(key) || !SYNC_KINDS_HERE.includes(k)) continue;
    // Bilder noch nicht aus IndexedDB geladen bzw. IndexedDB geht nicht: fehlen nur scheinbar
    if (k === 'bh-img' && (!bhImagesLoaded || bhImagesBroken)) continue;
    out.push({ key, k, id, base: e.rev, del: true, h: 'del' });
  }
  return out;
}

// ───────── Verschlüsseln (Schlüssel des Kontos, wie die Sicherung) ─────────

async function syncCryptKey() {
  if (syncCryptKey.raw !== cryptStore.key) {
    syncCryptKey.k = await crypto.subtle.importKey('raw', fromB64(cryptStore.key), 'AES-GCM', false, ['encrypt', 'decrypt']);
    syncCryptKey.raw = cryptStore.key;
  }
  return syncCryptKey.k;
}
/** Hülle {"kg":…,"iv":"…","d":"…"} – der Server nimmt nur genau diese Form an. Bilder: das JPEG selbst (nicht noch
 *  einmal Base64 im JSON – so bleibt die Hülle so groß wie das Bild und passt in eine Anfrage) */
async function syncSeal(v, kg, k) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = k === 'bh-img' ? fromB64(v.d) : new TextEncoder().encode(JSON.stringify(v));
  const d = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await syncCryptKey(), plain);
  const out = JSON.stringify({ kg, iv: toB64(iv), d: toB64(d) });
  // nie unverschlüsselt senden
  if (!/^\{"kg":\d+,"iv":"[A-Za-z0-9+/=]{16}","d":"[A-Za-z0-9+/=]+"\}$/.test(out)) throw new Error('plain');
  return out;
}
async function syncOpen(data, k) {
  const o = JSON.parse(data);
  const p = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(o.iv) }, await syncCryptKey(), fromB64(o.d));
  return k === 'bh-img' ? { d: toB64(p) } : JSON.parse(new TextDecoder().decode(p));
}

// ───────── Server ─────────

/** POST /sync: alles im Inhalt (keine eigenen Header → keine Vorab-Anfrage, keepalive geht) */
async function syncRequest(action, extra = {}) {
  const body = JSON.stringify({ code: team.code, user: account.user, auth: account.auth, token: team.token, device: deviceInfo().id, action, ...extra });
  const opts = { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, cache: 'no-store' };
  // keepalive: geht auch noch raus, wenn das iPhone gleich nach dem Speichern gesperrt wird
  const ka = body.length < SYNC_KEEPALIVE;
  let res;
  try {
    res = await fetch(TEAM_URL + '/sync', { ...opts, keepalive: ka });
  } catch (e) {
    // keepalive-Grenze voll (andere Anfragen): ohne noch einmal
    if (!ka) throw e;
    res = await fetch(TEAM_URL + '/sync', opts);
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    window.serverFehler?.('POST', `/sync ${action}`, res.status, data.error);
    teamAccessError(res.status, data.error);
    throw Object.assign(new Error(data.error || 'fehler'), { status: res.status, data });
  }
  return data;
}

let syncBusy = false;
let syncAgain = false;
/** Abgleichen: abholen (wenn es Neues gibt), dann Eigenes senden. pushFirst (nach dem Speichern): erst senden – das
 *  geht schneller raus; was andere inzwischen geschickt haben, kommt mit der Antwort bzw. danach */
async function syncRun(pushFirst = false) {
  if (!syncOn() || !navigator.onLine) return;
  if (syncBusy) {
    syncAgain = syncAgain === 'full' || !pushFirst ? 'full' : 'push';
    return;
  }
  syncBusy = true;
  const st = syncState();
  try {
    // Bilder des Berichtshefts erst aus IndexedDB laden (sonst sähe es aus, als wären sie gelöscht), zu große verkleinern
    // (ältere Bilder, aus einer Sicherung)
    await bhImagesReady;
    await bhShrinkImages();
    if (st.hold && st.hold <= SYNC_F) st.hold = 0;
    let head = null;
    if (!pushFirst || !st.at) {
      head = await syncRequest('head');
      syncMeta(head);
      // Server kennt weniger als dieses Gerät (Konto gelöscht und gleichnamig neu angelegt): alles neu abgleichen
      if (head.rev < st.rev) Object.assign(st, { rev: 0, at: 0, recs: {} });
      if (head.rev !== st.rev || !st.at) await syncPull();
      else st.at = Date.now();
    }
    syncRetryHeld();
    const top = await syncPush();
    // andere Geräte haben inzwischen gesendet
    if (top > st.rev) await syncPull();
    syncSave();
  } catch (e) {
    if (e.status === 401 && team) leaveTeamLocal('Team-Code ungültig');
    // Abgleich auf der Server-Seite ausgeschaltet
    else if (e.status === 403 && e.message === 'sync' && account) {
      account.sync = false;
      saveAccount();
    } else if (e.status === 409 && e.message === 'version') syncHold(e.data && e.data.f);
    else if (e.status === 409 && e.message === 'kg') syncMeta(e.data || {});
    else if (!e.status && e.message !== 'Failed to fetch' && e.name !== 'TypeError') window.fehlerMelden?.(e, 'abgleich');
  } finally {
    syncBusy = false;
    syncSave();
    if (syncAgain) {
      const full = syncAgain === 'full';
      syncAgain = false;
      setTimeout(() => syncRun(!full), 300);
    }
  }
  syncShowConflicts();
  // Team-Upload wartete auf den aktuellen Stand
  if (syncCurrent()) teamQueueUpload(500);
}
/** Zähler, Schlüssel-Generation und neueste App-Fassung des Kontos (aus head und pull) */
function syncMeta(o) {
  const st = syncState();
  if (o.kg) st.kg = o.kg;
  if (o.f > SYNC_F) syncHold(o.f);
}
/** Eine neuere App-Fassung hat gesendet: ab jetzt nur abholen, einmal Bescheid geben */
function syncHold(f) {
  const st = syncState();
  if (!(f > SYNC_F) || st.hold >= f) return;
  st.hold = f;
  syncSave();
  infoDialog('Bitte App neu öffnen', 'Auf einem anderen Gerät läuft schon eine neuere Fassung.');
}

async function syncPull() {
  const st = syncState();
  for (let n = 0; n < 100; n++) {
    const out = await syncRequest('pull', { since: st.rev });
    syncMeta(out);
    Object.assign((st.devs ||= {}), out.devices || {});
    await syncApply(out.records || []);
    st.rev = out.rev;
    syncSave();
    if (!out.more) break;
  }
  st.at = Date.now();
}

/** Datensätze, die nicht in eine Anfrage passen (bis zum nächsten Start nicht erneut versuchen) */
const syncTooBig = new Set();
/** Eigenes senden, in Teilen. Ergebnis: Zähler des Servers nach dem letzten Senden (0 = nichts gesendet) */
async function syncPush() {
  const st = syncState();
  if (st.hold > SYNC_F) return 0;
  let top = 0;
  for (let round = 0; round < 30; round++) {
    const list = syncChanges().filter((c) => !syncTooBig.has(c.key));
    if (!list.length) break;
    const batch = [];
    let size = 0;
    for (const c of list) {
      if (syncTooBig.has(c.key)) continue;
      const data = c.del ? '' : await syncSeal(c.v, st.kg, c.k);
      if (data.length > SYNC_ONE_MAX) {
        syncTooBig.add(c.key);
        window.fehlerMelden?.(new Error(`zu groß: ${c.k} ${data.length}`), 'abgleich');
        continue;
      }
      if (batch.length && (batch.length >= SYNC_PUSH_N || size + data.length > SYNC_PUSH_BYTES)) break;
      batch.push({ ...c, data });
      size += data.length + 200;
    }
    if (!batch.length) break;
    const out = await syncRequest('push', { f: SYNC_F, kg: st.kg, records: batch.map((c) => ({ k: c.k, id: c.id, base: c.base, del: !!c.del, data: c.data })) });
    const accepted = out.accepted || [];
    for (const a of accepted) {
      const c = batch.find((x) => x.k === a.k && x.id === a.id);
      if (c) st.recs[c.key] = syncRec(c.k, c.v, a.rev, c.h);
    }
    // niemand sonst hat dazwischen gesendet: die eigenen Fassungen nicht noch einmal abholen
    if (out.rev - accepted.length === st.rev) st.rev = out.rev;
    top = Math.max(top, out.rev);
    const rejected = out.rejected || [];
    for (const r of rejected) {
      // auf dem Server gibt es den Datensatz gar nicht (mehr): neu anlegen bzw. vergessen
      if (!r.rev) {
        const key = syncKeyOf(r.k, r.id);
        const c = batch.find((x) => x.key === key);
        if (c && c.del) delete st.recs[key];
        else if (c) st.recs[key] = { rev: 0, h: '!' };
      }
    }
    // abgelehnt: ein anderes Gerät war schneller – dessen Fassung wie beim Abholen behandeln (gleich, gewinnt, Konflikt)
    await syncApply(rejected.filter((r) => r.rev));
    syncSave();
  }
  return top;
}

// ───────── Eingehendes ─────────

/** Fassungen vom Server übernehmen (Abholen oder abgelehnt beim Senden) */
async function syncApply(records) {
  const st = syncState();
  const ch = { sheets: false, editor: false, settings: [] };
  for (const r of records) {
    if (!SYNC_KINDS_HERE.includes(r.k)) continue;
    // mit älterem Passwort verschlüsselt (wird gerade neu verschlüsselt, E6): später
    if (!r.del && r.kg !== st.kg) continue;
    let v = null;
    if (!r.del)
      try {
        v = await syncOpen(r.data, r.k);
      } catch (e) {
        window.fehlerMelden?.(e, 'abgleich');
        continue;
      }
    if (v && !syncValid(r.k, r.id, v)) continue;
    syncIncoming({ k: r.k, id: r.id, rev: r.rev, del: !!r.del, v, dev: r.dev, updated: r.updated }, ch);
  }
  syncAfter(ch);
}

/** Eingehende Fassung passt zur Art (sonst übergehen) */
function syncValid(k, id, v) {
  if (k === 'sheet') return v.id === id && !!v.weekStart && Array.isArray(v.days) && v.days.length === 7;
  if (k === 'trip') return v.id === id && Array.isArray(v.dates) && !!v.over && typeof v.over === 'object';
  if (k === 'pay') return v.year > 2000 && v.month >= 1 && v.month <= 12 && payKey(v.year, v.month) === id && !!v.hours;
  if (k === 'report') return v.id === id && !!v.date;
  if (k === 'bh-profile') return !!v.profile && typeof v.profile === 'object' && !!v.sigs && typeof v.sigs === 'object';
  if (k === 'bh-heft') return v.id === id && v.jahr > 0 && !!v.start && !!v.end;
  if (k === 'bh-img') return typeof v.d === 'string' && v.d.length > 100;
  if (k === 'bh-week') return /\|\d{4}-\d\d-\d\d$/.test(id) && Array.isArray(v.days);
  if (k === 'bh-month') return /\|\d{4}-\d\d$/.test(id) && typeof v === 'object';
  return true;
}

/** Ein eingehender Datensatz: gleich → nur merken; hier unverändert → übernehmen; hier auch geändert → Einstellung:
 *  die eigene gewinnt (wird erneut gesendet), Zettel: Konflikt-Fenster */
function syncIncoming(srv, ch) {
  const st = syncState();
  const key = syncKeyOf(srv.k, srv.id);
  const e = st.recs[key];
  if (e && e.rev >= srv.rev) return;
  const local = syncLocalOne(srv.k, srv.id);
  const hl = syncHk(srv.k, local);
  const hs = syncHk(srv.k, srv.v);
  const drop = () => {
    st.conflicts = st.conflicts.filter((c) => c.key !== key);
    st.held = st.held.filter((x) => syncKeyOf(x.k, x.id) !== key);
    st.wait = st.wait.filter((x) => syncKeyOf(x.k, x.id) !== key);
  };
  if (hl === hs) {
    st.recs[key] = syncRec(srv.k, srv.v, srv.rev, hs);
    return drop();
  }
  // Bericht eines Hefts, das hier (noch) fehlt: warten, bis das Heft kommt
  if ((srv.k === 'bh-week' || srv.k === 'bh-month') && !srv.del && !syncBhPage(srv.id).h) {
    drop();
    st.wait.push(srv);
    return;
  }
  // Zettel mit ungespeicherten Tagen im Editor: nicht anfassen, später erneut (beim Speichern lehnt der Server ab → Fenster)
  if (srv.k === 'sheet' && editorSaved && editorSaved.id === srv.id && editorPending()) {
    st.held = st.held.filter((x) => x.id !== srv.id || x.k !== srv.k).concat([srv]);
    return;
  }
  drop();
  const unchanged = e ? e.h === hl || e.a === hl : local == null;
  // Heft auf einem anderen Gerät gelöscht, hier aber ein Bericht darin geändert: fragen statt still alles zu löschen
  if (srv.k === 'bh-heft' && srv.del && unchanged && syncBhDirty(srv.id).length) {
    st.conflicts.push({ key, k: srv.k, id: srv.id, srv });
    return;
  }
  // nur „zuletzt geändert“ anders (z. B. gleich eingelesen): die Fassung des Servers übernehmen
  if (unchanged || syncBareH(srv.k, local) === syncBareH(srv.k, srv.v)) {
    // neuer Zettel einer Woche, für die es hier schon einen (anderen) gibt: beide auf zwei Geräten angelegt
    const twin = srv.k === 'sheet' && !srv.del && !local && sheets.find((s) => s.id !== srv.id && weekKey(s) === weekKey(srv.v));
    if (twin && !syncSameSheet(savedSheet(twin), srv.v)) {
      st.conflicts.push({ key, k: srv.k, id: srv.id, srv, twin: twin.id });
      return;
    }
    if (twin) syncDropTwin(twin.id, srv.id, ch);
    syncPut(srv, ch);
    st.recs[key] = syncRec(srv.k, srv.v, srv.rev, hs);
    return;
  }
  if (srv.k === 'set' || srv.k === 'report') {
    // schon einmal abgeglichen und hier geändert: die eigene gewinnt (auf die Fassung des Servers senden);
    // zum ersten Mal (neues Gerät): die des Servers – außer der Server hat nur die Vorgabe und hier ist etwas
    // eingestellt (ein frisch angemeldetes Gerät war schneller als das bisherige, 18.10.: Name und Lohn wären weg)
    if (e) st.recs[key] = { rev: srv.rev, h: e.h };
    else if (srv.k === 'set' && syncSetDefault(srv.id, srv.v && srv.v.v) && !syncSetDefault(srv.id, local && local.v)) st.recs[key] = { rev: srv.rev, h: '!' };
    else {
      syncPut(srv, ch);
      st.recs[key] = syncRec(srv.k, srv.v, srv.rev, hs);
    }
    return;
  }
  st.conflicts.push({ key, k: srv.k, id: srv.id, srv });
}

/** Berichte des Hefts, die hier geändert und noch nicht gesendet sind: Titel wie im Konflikt-Fenster */
function syncBhDirty(hid) {
  const st = syncState();
  const h = findHeft(hid);
  if (!h) return [];
  const out = [];
  for (const [k, store, filled] of [['bh-week', h.weeks, weekFilled], ['bh-month', h.months, monthFilled]])
    for (const [key, x] of Object.entries(store || {})) {
      const id = `${hid}|${key}`;
      if (filled(x) && st.recs[syncKeyOf(k, id)]?.h !== syncH(x)) out.push(syncTitle(k, x, id));
    }
  return out;
}

/** Einstellung hat den Wert der Vorgabe (bzw. ist leer, wenn es keine Vorgabe gibt) */
const syncSetDefault = (id, v) => (id in DEFAULT_SETTINGS ? syncCanon(v) === syncCanon(DEFAULT_SETTINGS[id]) : v == null || v === '' || v === false);

/** Gleicher Inhalt zweier Zettel derselben Woche (Tage, Name, gesendet) */
const syncSameSheet = (a, b) => !sheetDiff(a, b).length && !!a.sentAt === !!b.sentAt && (a.name || '') === (b.name || '');

/** Eingehende Fassung hier eintragen */
function syncPut(srv, ch) {
  if (srv.k === 'sheet') {
    const i = sheets.findIndex((s) => s.id === srv.id);
    // Feiertage usw. gleich nachtragen wie beim Start (zählt nicht als eigene Änderung, siehe syncAutoH)
    const v = srv.del ? null : structuredClone(srv.v);
    if (v) fixWeekend(v);
    if (!v) {
      if (i >= 0) sheets.splice(i, 1);
    } else if (i >= 0) sheets[i] = v;
    else sheets.push(v);
    ch.sheets = true;
    if (editorSaved && editorSaved.id === srv.id) ch.editor = true;
  } else if (srv.k === 'set') {
    if (srv.del) delete settings[srv.id];
    else settings[srv.id] = srv.v.v;
    ch.settings.push(srv.id);
  } else if (srv.k === 'trip') {
    const t = trips.find((x) => x.id === srv.id);
    if (srv.del) trips = trips.filter((x) => x !== t);
    // dasselbe Objekt behalten: offene Fenster der Abrechnung (Uhrzeit, Unterschrift) schreiben sonst ins Leere
    else if (t) {
      for (const n of Object.keys(t)) delete t[n];
      Object.assign(t, structuredClone(srv.v));
    } else trips.push(structuredClone(srv.v));
    ch.trips = true;
  } else if (srv.k === 'pay') {
    if (srv.del) delete payslips[srv.id];
    else payslips[srv.id] = structuredClone(srv.v);
    ch.pays = true;
  } else if (srv.k === 'report') {
    reportStore.items = reportStore.items.filter((r) => r.id !== srv.id);
    if (!srv.del) reportStore.items.push(structuredClone(srv.v));
    ch.reports = true;
  } else if (srv.k.startsWith('bh-')) syncPutBh(srv, ch);
}
/** Berichtsheft: Heft-Objekte bleiben dieselben (die geöffnete Seite hält eins in bhEntry) */
function syncPutBh(srv, ch) {
  const v = srv.del ? null : structuredClone(srv.v);
  ch.bh = true;
  if (srv.k === 'bh-profile') {
    bh.profile = v ? v.profile : {};
    bh.sigs = v ? v.sigs : {};
    bh.autoSign = v ? v.autoSign : false;
    bh.profileAt = v ? v.updatedAt : undefined;
  } else if (srv.k === 'bh-heft') {
    const h = findHeft(srv.id);
    if (!v) bh.hefte = bh.hefte.filter((x) => x !== h);
    else if (h) {
      for (const n of Object.keys(h)) if (n !== 'weeks' && n !== 'months') delete h[n];
      Object.assign(h, v);
    } else bh.hefte.push({ ...v, weeks: {}, months: {} });
  } else if (srv.k === 'bh-img') {
    if (v) bhPutImage(srv.id, v.d);
    else bhDeleteImage(srv.id);
  } else {
    const { h, key } = syncBhPage(srv.id);
    if (!h) return;
    const store = srv.k === 'bh-week' ? h.weeks : h.months;
    const before = srv.k === 'bh-month' ? syncBhImgIds(store[key]) : [];
    if (!v) delete store[key];
    else store[key] = srv.k === 'bh-week' ? normWeek(v) : v;
    // Bild, das nach der neuen Fassung nirgends mehr steht (z. B. im Konflikt-Fenster die andere Fassung gewählt)
    const used = new Set(bh.hefte.flatMap((x) => Object.values(x.months || {}).flatMap(syncBhImgIds)));
    for (const id of before) if (!used.has(id)) bhDeleteImage(id);
  }
}
const syncBhImgIds = (mo) => (mo ? ['taet', 'schule'].map((k) => mo[k] && mo[k].img && mo[k].img.id).filter(Boolean) : []);
/** Zettel twin weicht dem gleichen Zettel keep (andere ID): Abrechnungen hängen danach an keep */
function syncDropTwin(twin, keep, ch) {
  sheets = sheets.filter((s) => s.id !== twin);
  let moved = false;
  for (const t of trips)
    if (t.sheetId === twin) {
      t.sheetId = keep;
      moved = true;
    }
  if (moved) saveTrips();
  ch.sheets = true;
  if (editorSaved && editorSaved.id === twin) ch.editor = true;
}

/** Nach dem Übernehmen: speichern (ohne erneut zu senden – die Fingerabdrücke stimmen schon) und neu zeichnen */
function syncAfter(ch) {
  if (ch.trips) saveTrips();
  if (ch.pays) savePayslips();
  if (ch.reports) saveReports();
  if (ch.bh) saveBh();
  if (!ch.sheets && !ch.settings.length && !ch.trips && !ch.pays && !ch.reports && !ch.bh) return;
  if (ch.settings.length) {
    settings.hiddenSuggestions = { site: [], work: [], ...settings.hiddenSuggestions };
    saveSettings();
    if (ch.settings.includes('warnSigns')) applyWarnSigns();
  }
  if (ch.sheets) saveSheets();
  if (ch.editor) {
    const s = editorSaved && findSheet(editorSaved.id);
    if (s) editorSaved = editorSnapshot(s);
  }
  if (ch.sheets || ch.settings.includes('hiddenSuggestions')) refreshSuggestions();
  syncRerender();
}

/** Offene Seite neu zeichnen – nicht mitten im Tippen und nicht unter einem Fenster (dann etwas später) */
function syncRerender() {
  clearTimeout(syncRerender.t);
  const busy = layer.classList.contains('open') || (document.activeElement && document.activeElement.matches('input, textarea, [contenteditable="true"]'));
  if (busy) {
    syncRerender.t = setTimeout(syncRerender, 1500);
    return;
  }
  if (currentView === 'editor') {
    // Zettel auf einem anderen Gerät gelöscht
    if (!currentSheet()) return goBack();
    return refreshAll();
  }
  // Abrechnung auf einem anderen Gerät gelöscht
  if (currentView === 'trip' && !currentTrip()) return goBack();
  importRerender();
}

/** Zurückgehaltene Fassungen (Editor hatte ungespeicherte Tage) erneut prüfen */
function syncRetryHeld() {
  const st = syncState();
  // Berichte, deren Heft inzwischen da ist
  const ready = st.wait.filter((x) => syncBhPage(x.id).h);
  if (!st.held.length && !ready.length) return;
  const held = [...st.held, ...ready];
  st.held = [];
  st.wait = st.wait.filter((x) => !ready.includes(x));
  const ch = { sheets: false, editor: false, settings: [] };
  for (const srv of held) syncIncoming(srv, ch);
  syncAfter(ch);
}

// ───────── Konflikte ─────────

/** Name eines Geräts für das Fenster */
const syncDevName = (dev) => (syncState().devs || {})[dev] || 'Anderes Gerät';
/** „13.–17.10.“ bzw. „29.09.–03.10.“ */
const syncRange = (a, b) => (+a === +b ? fmtDayMonth(a) : `${a.getMonth() === b.getMonth() ? `${pad(a.getDate())}.` : fmtDayMonth(a)}–${fmtDayMonth(b)}`);
/** Titel im Fenster: „Zettel 13.–17.10.“, „Abrechnung 13.–15.10.“, „Lohn August 2026“, „Wochenbericht 13.–17.10.“ */
function syncTitle(k, x, id) {
  if (k === 'bh-week') {
    const mon = parseDate(syncBhPage(id).key);
    return `Wochenbericht ${syncRange(mon, addDays(mon, 4))}`;
  }
  if (k === 'bh-month') return `Monatsbericht ${monthName(syncBhPage(id).key)}`;
  if (k === 'bh-heft') return `Berichtsheft ${x.jahr}. Ausbildungsjahr`;
  if (k === 'bh-profile') return 'Angaben im Berichtsheft';
  if (k === 'trip') {
    const d = [...x.dates].sort();
    return `Abrechnung ${syncRange(parseDate(d[0]), parseDate(d.at(-1)))}`;
  }
  if (k === 'pay') return `Lohn ${MONTHS[x.month - 1]} ${x.year}`;
  return `Zettel ${syncRange(sheetFirstDate(x), sheetLastDate(x))}`;
}
/** Summe oben in der Karte: Stunden, Verpflegung, Auszahlung */
function syncTotal(k, x) {
  if (k === 'trip') return fmtEuro(tripTotal(tripRows(x)));
  if (k === 'pay') return x.auszahlung == null ? '' : fmtMoney(x.auszahlung, true);
  if (k === 'bh-week') return fmtH(x.days.reduce((n, d) => n + Math.round(parseNum((d.type ? bhTypeHours(d.type) : d.hours) || '0') * 60), 0));
  if (k.startsWith('bh-')) return '';
  return fmtH(sheetTotal(x));
}
/** Eigener Name im Fenster („iPhone“) */
const syncMyName = () => ((accountDevs || []).find((d) => d.me) || {}).name || (syncState().devs || {})[deviceInfo().id] || deviceKind();

/** Unterschiede zweier Fassungen eines Zettels: [{ label, mine, theirs }] – Tage, dazu Woche, Name, gesendet */
function syncSheetDiff(mine, theirs) {
  const out = [];
  const range = (s) => `${fmtShort(sheetFirstDate(s))} – ${fmtShort(sheetLastDate(s))}`;
  // andere Woche: Tage nur mit Wochentag (das Datum ist ja verschieden)
  const moved = weekKey(mine) !== weekKey(theirs);
  if (moved) out.push({ label: 'Woche', mine: range(mine), theirs: range(theirs) });
  out.push(...sheetDiff(mine, theirs).map((d) => ({ ...d, label: moved ? WEEKDAYS_SHORT[d.i] : `${WEEKDAYS_SHORT[d.i]} ${fmtDayMonth(sheetDate(mine, d.i))}` })));
  if ((mine.name || '') !== (theirs.name || '')) out.push({ label: 'Name', mine: mine.name || '–', theirs: theirs.name || '–' });
  if (!!mine.sentAt !== !!theirs.sentAt) out.push({ label: 'Status', mine: mine.sentAt ? 'gesendet' : 'offen', theirs: theirs.sentAt ? 'gesendet' : 'offen' });
  return out;
}

/** Unterschiede zweier Fassungen einer Abrechnung: Tage, Ort/Datum (tripDiff), dazu Name, Unterschrift, gesendet */
function syncTripDiff(mine, theirs) {
  const out = tripDiff(mine, theirs);
  if ((mine.name || '') !== (theirs.name || '')) out.push({ label: 'Name', mine: mine.name || '–', theirs: theirs.name || '–' });
  if ((mine.signature || '') !== (theirs.signature || ''))
    out.push({ label: 'Unterschrift', mine: mine.signature ? 'vorhanden' : '–', theirs: theirs.signature ? (mine.signature ? 'andere' : 'vorhanden') : '–' });
  if (!!mine.sentAt !== !!theirs.sentAt) out.push({ label: 'Status', mine: mine.sentAt ? 'gesendet' : 'offen', theirs: theirs.sentAt ? 'gesendet' : 'offen' });
  return out;
}
/** Felder der Lohnabrechnung im Fenster (wie auf ihrer Seite; Funktion: HOUR_KINDS steht erst in app.js) */
const syncPayFields = () => [
  ['tarif', 'Steuertarif', 'y'],
  ['rate', 'Stundenlohn', '€'],
  ...HOUR_KINDS.map(([k, label]) => [`hours.${k}`, label, 'h']),
  ['zulage', 'Zulagen', '€'],
  ['brutto', 'Gesamt-Brutto', '€'],
  ['steuer', 'Steuern', '€'],
  ['sv', 'Sozialabgaben', '€'],
  ['netto', 'Netto-Verdienst', '€'],
  ['abschlag', 'Abschlag', '€'],
  ['bav', 'Betriebsrente', '€'],
  ['nettoSonst', 'Weitere Netto-Be-/Abzüge', '€'],
  ['auszahlung', 'Auszahlung', '€'],
  ['kvZusatz', 'Zusatzbeitrag', '%'],
  ['ytd', 'Gesamt-Brutto im Jahr', '€'],
];
/** Unterschiede zweier Fassungen einer Lohnabrechnung: je abweichendes Feld */
function syncPayDiff(mine, theirs) {
  const get = (p, path) => path.split('.').reduce((o, n) => (o == null ? o : o[n]), p);
  const fmt = (v, unit, p) =>
    unit === 'y' ? String(v || p.year) : v == null || v === '' ? '–' : unit === '€' ? fmtMoney(v, true) : unit === 'h' ? fmtH(v * 60) : `${fmtDec(v * 60)} %`;
  return syncPayFields().map(([path, label, unit]) => ({ label, mine: fmt(get(mine, path), unit, mine), theirs: fmt(get(theirs, path), unit, theirs) })).filter(
    (d) => d.mine !== d.theirs
  );
}
/** Unterschriften eines Berichts: „am 13.10.“ bzw. „–“ je Rolle */
function syncSignDiff(mine, theirs) {
  const when = (x, r) => (x.signed && x.signed[r] ? tr(`am ${fmtDayMonth(parseDate(x.signed[r]))}`) : '–');
  return BH_ROLES.map(([r, label]) => ({ label, mine: when(mine, r), theirs: when(theirs, r) }));
}
/** Text eines Tages im Wochenbericht: jede Zeile mit Einzelstunden untereinander, dann „= 8,00 Std.“; Tagesart als Wort */
function syncBhDayText(d) {
  if (!d) return '–';
  if (d.type) return tr(bhTypes()[d.type] || d.type);
  const lines = (d.lines || []).filter((l) => l.t.trim() || l.h.trim()).map((l) => (l.h.trim() ? `${l.t.trim()} (${l.h.trim()})` : l.t.trim()));
  // eigenes Wort für den Umbruch (wordDiffHTML trennt an Leerzeichen; die Karte bricht dort um)
  return [...lines, d.hours ? `= ${d.hours} Std.` : ''].filter(Boolean).join(' \n ') || '–';
}
/** Unterschiede zweier Wochenberichte: je abweichender Tag, dazu die Unterschriften */
function syncBhWeekDiff(mine, theirs, id) {
  const mon = parseDate(syncBhPage(id).key);
  const out = [];
  for (let i = 0; i < 6; i++) {
    const a = syncBhDayText(mine.days[i]);
    const b = syncBhDayText(theirs.days[i]);
    if (a !== b) out.push({ label: `${WEEKDAYS_SHORT[i]} ${fmtDayMonth(addDays(mon, i))}`, mine: a, theirs: b });
  }
  return [...out, ...syncSignDiff(mine, theirs).filter((d) => d.mine !== d.theirs)];
}
/** Unterschiede zweier Monatsberichte: Texte, Bilder, Unterschriften */
function syncBhMonthDiff(mine, theirs) {
  const out = [];
  for (const [k, label] of BH_PARTS) {
    const a = (mine[k] && mine[k].text) || '';
    const b = (theirs[k] && theirs[k].text) || '';
    const text = a.trim() !== b.trim();
    if (text) out.push({ label, mine: a.trim() || '–', theirs: b.trim() || '–' });
    const ia = mine[k] && mine[k].img;
    const ib = theirs[k] && theirs[k].img;
    // Bild als Vorschau (direkt unter seinem Text, sonst mit dem Teil im Namen)
    if ((ia && ia.id) !== (ib && ib.id)) out.push({ label: text ? 'Bild' : `Bild ${label}`, img: { mine: ia && ia.id, theirs: ib && ib.id } });
  }
  return [...out, ...syncSignDiff(mine, theirs).filter((d) => d.mine !== d.theirs)];
}
/** Unterschiede der Angaben: Felder, gespeicherte Unterschriften, automatisch unterschreiben */
function syncBhProfileDiff(mine, theirs) {
  const val = (x, k, ac) => (ac === 'date' ? fmtLong(x.profile[k]) : x.profile[k] || '') || '–';
  const out = BH_PROFILE_FIELDS.map(([k, label, ac]) => ({ label, mine: val(mine, k, ac), theirs: val(theirs, k, ac) }));
  for (const [r, label] of BH_ROLES) {
    const a = mine.sigs[r] ? JSON.stringify(mine.sigs[r]) : '';
    const b = theirs.sigs[r] ? JSON.stringify(theirs.sigs[r]) : '';
    if (a !== b) out.push({ label: `Unterschrift ${label}`, mine: a ? tr('vorhanden') : '–', theirs: b ? tr(a ? 'andere' : 'vorhanden') : '–' });
  }
  out.push({ label: 'Automatisch unterschreiben', mine: tr(mine.autoSign ? 'an' : 'aus'), theirs: tr(theirs.autoSign ? 'an' : 'aus') });
  return out.filter((d) => d.mine !== d.theirs);
}
/** Unterschiede zweier Fassungen eines Hefts (Zeitraum) */
const syncBhHeftDiff = (mine, theirs) =>
  [{ label: 'Zeitraum', mine: fmtYearSpan(mine), theirs: fmtYearSpan(theirs) }].filter((d) => d.mine !== d.theirs);
function syncDiff(k, mine, theirs, id) {
  if (k === 'trip') return syncTripDiff(mine, theirs);
  if (k === 'pay') return syncPayDiff(mine, theirs);
  if (k === 'bh-week') return syncBhWeekDiff(mine, theirs, id);
  if (k === 'bh-month') return syncBhMonthDiff(mine, theirs);
  if (k === 'bh-profile') return syncBhProfileDiff(mine, theirs);
  if (k === 'bh-heft') return syncBhHeftDiff(mine, theirs);
  return syncSheetDiff(mine, theirs);
}

/** Wartende Konflikte nacheinander zeigen – nicht unter einem anderen Fenster und nicht, solange der betroffene Zettel
 *  ungespeicherte Tage hat */
async function syncShowConflicts() {
  if (syncShowConflicts.busy || typeof layer === 'undefined') return;
  const st = syncState();
  const editing = editorSaved && editorPending() ? editorSaved.id : null;
  const list = st.conflicts.filter((c) => c.id !== editing && c.twin !== editing);
  if (!list.length || !syncOn()) return;
  // nicht unter einem Fenster und nicht mitten im Tippen (Berichtsheft speichert bei jedem Tastendruck)
  if (layer.classList.contains('open') || (document.activeElement && document.activeElement.matches('input, textarea'))) {
    clearTimeout(syncShowConflicts.t);
    syncShowConflicts.t = setTimeout(syncShowConflicts, 2000);
    return;
  }
  syncShowConflicts.busy = true;
  let all = '';
  try {
    for (const c of list) {
      if (!st.conflicts.includes(c)) continue;
      const mine = c.twin ? savedSheet(findSheet(c.twin)) || null : syncLocalOne(c.k, c.id);
      // inzwischen gleich (z. B. Heft gelöscht, Bericht darin auch gelöscht): ohne Fenster
      if (!c.twin && syncHk(c.k, mine) === syncHk(c.k, c.srv.del ? null : c.srv.v)) {
        syncResolve(c, 'theirs');
        continue;
      }
      let pick = all;
      if (!pick) {
        pick = await syncAskConflict(c, mine, list.length - list.indexOf(c));
        if (pick.endsWith('All')) all = pick = pick.slice(0, -3);
      }
      syncResolve(c, pick);
    }
  } finally {
    syncShowConflicts.busy = false;
  }
  syncSoon(0);
}

/** Wahl umsetzen. 'mine': die eigene Fassung wird auf die des Servers gesendet; 'theirs': die des Servers übernehmen.
 *  Bei zwei Zetteln derselben Woche verschwindet der andere (Löschmarke); der bleibende wird auf jeden Fall gesendet,
 *  damit zwei Geräte, die gleichzeitig verschieden wählen, nicht beide Zettel löschen */
function syncResolve(c, pick) {
  const st = syncState();
  const ch = { sheets: false, editor: false, settings: [] };
  st.conflicts = st.conflicts.filter((x) => x !== c);
  const hs = syncHk(c.k, c.srv.v);
  if (c.twin) {
    const tk = syncKeyOf('sheet', c.twin);
    if (pick === 'mine') {
      st.recs[c.key] = syncRec(c.k, c.srv.v, c.srv.rev, hs); // fehlt hier → Löschmarke
      st.recs[tk] = { rev: st.recs[tk] ? st.recs[tk].rev : 0, h: '!' };
    } else {
      syncDropTwin(c.twin, c.id, ch);
      syncPut(c.srv, ch);
      st.recs[c.key] = { rev: c.srv.rev, h: '!' };
    }
  } else if (pick === 'mine') st.recs[c.key] = { rev: c.srv.rev, h: '!' };
  else {
    syncPut(c.srv, ch);
    st.recs[c.key] = syncRec(c.k, c.srv.v, c.srv.rev, hs);
  }
  syncSave();
  syncAfter(ch);
}

/** Bilder eines Monatsberichts im Fenster: Vorschau bzw. „kein Bild“ (noch nicht abgeholt: „Bild“) */
function syncImgHTML(img) {
  const one = (id) => {
    if (!id) return `<mark>${tr('kein Bild')}</mark>`;
    const d = bhImages.get(id);
    return d ? `<img class="cf-img" src="data:image/jpeg;base64,${d}" alt="">` : `<mark>${tr('Bild')}</mark>`;
  };
  return { mine: one(img.mine), theirs: one(img.theirs) };
}

/** Konflikt-Fenster: beide Fassungen als Karten nebeneinander (Gerät, Uhrzeit, Stunden, abweichende Tage markiert),
 *  Karte antippen = diese gilt. Ergebnis: 'mine' | 'theirs' (mit „All“: für alle weiteren gleich).
 *  Schließt nicht beim Antippen daneben – bis zur Wahl bliebe der Zettel ungesendet */
function syncAskConflict(c, mine, remaining) {
  return new Promise((resolve) => {
    const theirs = c.srv.del ? null : c.srv.v;
    const known = c.srv.dev in (syncState().devs || {});
    const diffs = mine && theirs ? syncDiff(c.k, mine, theirs, c.id).map((d) => ({ ...d, w: d.img ? syncImgHTML(d.img) : wordDiffHTML(d.mine, d.theirs) })) : [];
    // Heft anderswo gelöscht: welche Berichte hier noch geändert sind
    const dirty = c.k === 'bh-heft' && mine && !theirs ? syncBhDirty(c.id) : [];
    const card = (side, x, name, ms, cls, own) => `
      <div class="cf-card" data-c="${side}" role="button">
        <div class="cf-card-head"><span class="cf-tag ${cls}"${own || known ? ' translate="no"' : ''}>${escapeHtml(name)}</span><b>${x ? syncTotal(c.k, x) : ''}</b></div>
        <div class="cf-card-when">${x ? '' : 'gelöscht '}${ms ? fmtStamp(ms) : ''}</div>
        ${diffs.map((d) => `<div class="cf-card-day"><b>${d.label}</b><span class="cf-txt" translate="no">${side === 'mine' ? d.w.mine : d.w.theirs}</span></div>`).join('')}
        ${side === 'mine' && dirty.length ? `<div class="cf-card-day"><b>Geändert</b>${dirty.map((t) => `<span class="cf-line">${t}</span>`).join('')}</div>` : ''}
        <span class="cf-card-go">${side === 'mine' ? (x ? 'Behalten' : 'Gelöscht lassen') : x ? 'Übernehmen' : 'Löschen'}</span>
      </div>`;
    const modal = openModal(
      `<div class="alert-body cf">
        <b>${syncTitle(c.k, mine || theirs, c.id)} auf zwei Geräten geändert</b>
        <div class="cf-scroll"><div class="alert-msg">
          <p class="cf-intro">Welche Fassung soll gelten?</p>
          <div class="cf-cards">${card('mine', mine, syncMyName(), mine && (mine.updatedAt || mine.importedAt), 'app', true)}${card('theirs', theirs, syncDevName(c.srv.dev), c.srv.updated, 'new', false)}</div>
        </div><div class="cf-bar"><i></i></div></div>
      </div>
      ${remaining > 1 ? `<label class="cf-all"><span>Für alle ${remaining} gleich entscheiden</span><input type="checkbox" class="cf-switch"></label>` : ''}`,
      'alert wide',
      false
    );
    scrollBar(modal);
    let done = false;
    modal.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b || done) return;
      done = true;
      haptic();
      closeModal();
      setTimeout(() => resolve(modal.querySelector('.cf-switch')?.checked ? `${b.dataset.c}All` : b.dataset.c), 280);
    });
  });
}

// ───────── Team und Anlässe ─────────

/** Darf dieses Gerät ins Team hochladen? Mit Abgleich nur mit frischem Stand, ohne offenen Konflikt und ohne
 *  Ungesendetes – sonst überschriebe ein Gerät mit altem Stand den Eintrag, den alle Geräte des Kontos teilen */
function syncCurrent() {
  if (!(account && account.sync)) return true;
  if (!syncOn()) return false;
  const st = syncState();
  return !st.conflicts.length && !st.held.length && Date.now() - st.at < SYNC_FRESH && !(st.hold > SYNC_F) && !syncChanges().some((c) => !syncTooBig.has(c.key));
}

/** Nach dem Speichern: gleich senden */
function syncSoon(delay = 300) {
  if (!syncOn()) return;
  clearTimeout(syncSoon.t);
  syncSoon.t = setTimeout(() => syncRun(true), delay);
}

/** Start (app.js ganz geladen), Zurückkehren, wieder online, alle 45 s solange sichtbar */
function syncStart() {
  syncRun();
  setInterval(() => document.visibilityState === 'visible' && syncRun(), SYNC_TICK);
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? syncRun() : syncSoon(0)));
  window.addEventListener('online', () => syncRun());
}
