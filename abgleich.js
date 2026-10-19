// Std-Protokoll – Abgleich mehrerer Geräte (nur Konten mit Abgleich, Schalter auf der Server-Seite; Plan:
// Ideen/Plan-Abgleich-mehrere-Geraete.md). Zettel, Einstellungen, Reisekostenabrechnungen, Lohnabrechnungen,
// Arbeitsscheine und das Berichtsheft gehen je Datensatz verschlüsselt an den Team-Server
// (POST /sync, cloudflare/team-worker.js) und von dort auf die anderen Geräte desselben Kontos.
//
// Eigener Speicher je Gerät (nie abgeglichen, nicht in der Sicherung) stdprotokoll.sync.v1:
// { user, created, kinds, rev, kg, at, hold, recs, held, conflicts, devs, oldKeys, sent }
//   created: wann das Konto auf dem Server angelegt wurde (anders = gelöscht und gleichnamig neu angelegt: alles neu)
//   rev: bis hierher abgeholt; at: zuletzt erfolgreich abgeholt (Team-Upload nur mit frischem Stand)
//   recs: { 'k:id': { rev, h, a, b } } je Datensatz der Stand auf dem Server und der Fingerabdruck der Fassung, die dieses
//         Gerät zuletzt gesendet oder übernommen hat ('del' = gelöscht, '!' = auf jeden Fall senden). Lokal anders →
//         senden (base = rev), lokal fehlt → Löschmarke. So muss keiner der vielen save…-Aufrufe wissen, was er ändert.
//         a: Fingerabdruck derselben Fassung nach dem automatischen Nachtragen (Feiertage, fixWeekend) – das macht
//         jedes Gerät selbst, es zählt nicht als eigene Änderung (sonst Konflikt mit jeder echten Änderung anderswo)
//         b: Fingerabdruck des Inhalts ohne „zuletzt geändert“ und Ansicht (syncBareH) – ändert sich nur die Ansicht (Tage
//         der Abrechnung weitergeblättert, leere Zeilen im Wochenbericht weg), ist das keine eigene Änderung
//   held: eingehende Fassungen des Zettels, der gerade mit ungespeicherten Tagen im Editor offen ist (später anwenden)
//   wait: eingehende Berichte, deren Heft hier (noch) fehlt (kommt es, werden sie angewendet)
//   conflicts: [{ key, k, id, srv: { rev, del, v, dev, updated }, twin }] auf zwei Geräten geändert → Fenster;
//              twin: anderer Zettel derselben Woche (auf zwei Geräten neu angelegt)
//   hold: höchste App-Fassung, die schon gesendet hat; ist sie neuer als diese, sendet dieses Gerät nichts mehr
//   devs: Geräte-ID → Name (für das Fenster)
//   oldKeys: { kg: Schlüssel } frühere Schlüssel nach einem Passwortwechsel – damit verschlüsselt dieses Gerät die noch
//            alten Datensätze neu (syncRekey) und kann sie bis dahin lesen; weg, sobald der Server nichts Altes mehr hat
//   sent: { 'k:id': [Fingerabdruck, …] } die zuletzt gesendeten Fassungen ohne Antwort – ging die Antwort verloren,
//         erkennt das Abholen bzw. die Ablehnung beim erneuten Senden die eigene Fassung (sonst Konflikt-Fenster
//         „auf zwei Geräten geändert“ mit zweimal diesem Gerät)
// Passwort ändern (konto.js accountPassword): erst alles abgleichen, dann neues Passwort beim Server (kg + 1), dann neu
// verschlüsseln in Teilen. Andere Geräte bekommen „pwchanged“, melden sich neu an und behalten dabei den alten Schlüssel.
// Ungesendetes dort wird kein Konflikt, wenn die Server-Fassung inhaltlich die bekannte ist (syncIncoming).
// „Stand vom … wiederherstellen“ (syncRestorePick): der Server schreibt die damaligen Fassungen als neue (rev).
// Arten: sheet (Zettel), set (Einstellung), trip (Abrechnung, ohne leere), pay (Lohnabrechnung, id = Monat „2026-08“),
// report (Arbeitsschein, id = Schein-id), Berichtsheft: bh-profile (id „profile“: Angaben, gespeicherte Unterschriften,
// automatisch unterschreiben), bh-heft (Heft ohne Wochen/Monate), bh-week (id „Heft-id|Montag“, nur beschriebene),
// bh-month (id „Heft-id|JJJJ-MM“, nur beschriebene), bh-img (Bild-id, { d: JPEG Base64 }; unveränderlich, nur neu oder
// gelöscht). Wochen und Monate tragen ihre Unterschriften; ein Heft löschen = Löschmarken für alles darin.
// Zettel, Abrechnung, Lohn, Berichtsheft: Konflikt-Fenster. Einstellungen, Arbeitsscheine: die zuletzt gesendete gilt (ohne
// SYNC_SET_SKIP, die bleiben je Gerät). Arbeitsscheine holt jedes Gerät weiter selbst ab (Server/Google); ein auf einem
// anderen Gerät gelöschter Schein kommt dabei nicht wieder (von Hand gelöscht = Platzhalter mit gone, addReports).

const SYNC_KEY = 'stdprotokoll.sync.v1';
/** App-Fassung (gleiche Zahl wie CACHE in sw.js): ein Gerät mit älterer sendet nicht mehr, sobald eine neuere gesendet hat */
const SYNC_F = 137;
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
  syncSt.oldKeys ||= {};
  syncSt.sent ||= {};
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

/** app.js ist ganz geladen (syncStart) – vorher gibt es cryptStore noch nicht (Zugriff wirft, z. B. savePayslips beim Laden) */
let syncStarted = false;
/** Abgleich aktiv: im Team, Konto bestätigt und mit Abgleich, Schlüssel da */
const syncOn = () => !!(syncStarted && team && account && account.ok && account.sync && !account.pwchanged && cryptStore);

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
/** Zum Vergleich des Inhalts: ohne „zuletzt geändert“, eingelesen um, angezeigte Tage der Abrechnung, leere Zeilen im
 *  Wochenbericht (fallen beim Anzeigen weg) */
const syncBareH = (k, v) =>
  v == null
    ? 'del'
    : k === 'bh-week'
    ? syncH({ ...v, updatedAt: 0, days: Array.isArray(v.days) ? v.days.map((d) => (d && Array.isArray(d.lines) ? { ...d, lines: d.lines.filter((l) => String(l?.t || '').trim() || String(l?.h || '').trim()) } : d)) : v.days })
    : k === 'sheet' || k === 'bh-month' || k === 'bh-profile'
    ? syncH({ ...v, updatedAt: 0 })
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
/** Arten, bei denen syncBareH mehr weglässt als syncHk */
const SYNC_BARE = new Set(['sheet', 'trip', 'pay', 'bh-week', 'bh-month', 'bh-profile']);
/** Merken, welche Fassung der Server hat */
const syncRec = (k, v, rev, h = syncHk(k, v)) => {
  const e = { rev, h };
  const a = syncAutoH(k, v);
  if (a) e.a = a;
  if (v != null && SYNC_BARE.has(k)) e.b = syncBareH(k, v);
  return e;
};
/** Hier seit dem Abgleich nichts geändert (höchstens Feiertage nachgetragen bzw. die Ansicht) */
const syncSame = (e, k, local, hl = syncHk(k, local)) => e.h === hl || e.a === hl || (!!e.b && local != null && e.b === syncBareH(k, local));
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
  // mit von Hand gelöschten (gone) – die gehen als Datensatz an die anderen Geräte, damit deren Abholen sie nicht zurückbringt
  for (const r of reportStore.items) m.set(syncKeyOf('report', r.id), { k: 'report', id: r.id, v: r });
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
  if (k === 'report') return reportStore.items.find((r) => r.id === id) || null;
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

/** Was zu senden ist: [{ key, k, id, base, del, v, h }] – ohne Datensätze mit offenem Konflikt */
function syncChanges(local = syncLocal()) {
  const st = syncState();
  // offener Konflikt, zurückgehaltene Fassung (Editor): erst nach der Wahl bzw. dem Speichern
  // bzw. eingehender Bericht, dessen Heft hier fehlt: erst, wenn das Heft wieder da ist oder der Bericht gelöscht
  const blocked = new Set([
    ...st.conflicts.flatMap((c) => [c.key, ...(c.twin ? [syncKeyOf('sheet', c.twin)] : [])]),
    ...st.held.map((x) => syncKeyOf(x.k, x.id)),
    ...st.wait.map((x) => syncKeyOf(x.k, x.id)),
  ]);
  const out = [];
  for (const [key, r] of local) {
    if (blocked.has(key)) continue;
    const h = syncHk(r.k, r.v);
    const e = st.recs[key];
    // Einstellung noch nie abgeglichen und nur die Vorgabe: nicht senden (ein frisch angemeldetes Gerät überschriebe
    // sonst die Werte des bisherigen, 18.10.) – so heißt eine Vorgabe auf dem Server immer „bewusst eingestellt“
    if (!e && r.k === 'set' && syncSetDefault(r.id, r.v.v)) continue;
    if (e && e.h === h) continue;
    // nur die Ansicht anders (Abrechnung weitergeblättert …): nicht senden
    if (e && e.b && syncBareH(r.k, r.v) === e.b) continue;
    out.push({ key, k: r.k, id: r.id, base: e ? e.rev : 0, v: r.v, h });
  }
  let used = null;
  for (const [key, e] of Object.entries(st.recs)) {
    const { k, id } = syncSplit(key);
    if (local.has(key) || e.h === 'del' || blocked.has(key) || !SYNC_KINDS_HERE.includes(k)) continue;
    // Bilder noch nicht aus IndexedDB geladen, IndexedDB geht nicht oder ein Bericht zeigt noch darauf: fehlen nur
    // scheinbar (z. B. Speichern in IndexedDB gescheitert) – gelöscht wird ein Bild nur mit seinem Verweis
    if (k === 'bh-img' && (!bhImagesLoaded || bhImagesBroken || (used ||= syncImgUsed()).has(id))) continue;
    out.push({ key, k, id, base: e.rev, del: true, h: 'del' });
  }
  return out;
}

// ───────── Verschlüsseln (Schlüssel des Kontos, wie die Sicherung) ─────────

/** Schlüssel des Kontos (bzw. ein früherer aus oldKeys) als CryptoKey */
async function syncCryptKey(raw = cryptStore.key) {
  const m = (syncCryptKey.m ||= new Map());
  if (!m.has(raw)) m.set(raw, await crypto.subtle.importKey('raw', fromB64(raw), 'AES-GCM', false, ['encrypt', 'decrypt']));
  return m.get(raw);
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
async function syncOpen(data, k, raw) {
  const o = JSON.parse(data);
  const p = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(o.iv) }, await syncCryptKey(raw), fromB64(o.d));
  return k === 'bh-img' ? { d: toB64(p) } : JSON.parse(new TextDecoder().decode(p));
}

// ───────── Server ─────────

/** Keine Verbindung (bzw. inzwischen abgemeldet): kein Fehlerbericht – alles andere im Abgleich ist ein Programmfehler */
const syncNetError = (e) => Object.assign(e instanceof Error ? e : new Error(String(e)), { net: true });
/** POST /sync: alles im Inhalt (keine eigenen Header → keine Vorab-Anfrage, keepalive geht) */
async function syncRequest(action, extra = {}) {
  if (!team || !account) throw syncNetError(new Error('offline'));
  const auth = account.auth;
  const body = JSON.stringify({ code: team.code, user: account.user, auth, token: team.token, device: deviceInfo().id, action, ...extra });
  const opts = { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, cache: 'no-store' };
  // keepalive: geht auch noch raus, wenn das iPhone gleich nach dem Speichern gesperrt wird
  const ka = body.length < SYNC_KEEPALIVE;
  let res;
  try {
    res = await fetch(TEAM_URL + '/sync', { ...opts, keepalive: ka });
  } catch (e) {
    // keepalive-Grenze voll (andere Anfragen): ohne noch einmal
    if (!ka) throw syncNetError(e);
    try {
      res = await fetch(TEAM_URL + '/sync', opts);
    } catch (e2) {
      throw syncNetError(e2);
    }
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    window.serverFehler?.('POST', `/sync ${action}`, res.status, data.error);
    teamAccessError(res.status, data.error, auth);
    throw Object.assign(new Error(data.error || 'fehler'), { status: res.status, data });
  }
  return data;
}

let syncBusy = false;
let syncAgain = false;
/** Angehalten, solange das Passwort geändert bzw. ein Stand wiederhergestellt wird */
let syncPaused = false;
/** Abgelehnt mit einer Fassung, deren Schlüssel dieses Gerät nicht kennt (Passwortwechsel, noch nicht neu verschlüsselt):
 *  in diesem Durchgang nicht erneut senden */
const syncKgWait = new Set();
/** Anzeige beim Neu-Verschlüsseln (nur auf dem Gerät, das das Passwort ändert): Funktion(Anteil 0–1) oder null */
let syncRekeyProgress = null;
/** Warten, bis kein Abgleich mehr läuft */
async function syncIdle() {
  for (let n = 0; (syncBusy || syncAgain) && n < 600; n++) await new Promise((r) => setTimeout(r, 100));
}
/** Abgleichen: abholen (wenn es Neues gibt), dann Eigenes senden. pushFirst (nach dem Speichern): erst senden – das
 *  geht schneller raus; was andere inzwischen geschickt haben, kommt mit der Antwort bzw. danach */
async function syncRun(pushFirst = false) {
  if (!syncOn() || !navigator.onLine || syncPaused) return;
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
    syncKgWait.clear();
    let head = null;
    if (!pushFirst || !st.at) {
      head = await syncRequest('head');
      syncMeta(head);
      // mit dem bisherigen Passwort angenommen: ein abgebrochener Passwortwechsel kam nicht beim Server an
      if (account.pwNext && !syncPaused) {
        delete account.pwNext;
        saveAccount();
      }
      // nichts mehr neu zu verschlüsseln: frühere Schlüssel vergessen
      if (!head.rekey && Object.keys(st.oldKeys).length) st.oldKeys = {};
      // Konto gelöscht und gleichnamig neu angelegt (bzw. Server kennt weniger als dieses Gerät): alles neu abgleichen
      if ((head.created && st.created && head.created !== st.created) || head.rev < st.rev)
        Object.assign(st, { rev: 0, at: 0, recs: {}, conflicts: [], held: [], wait: [], sent: {} });
      if (head.created) st.created = head.created;
      if (head.rev !== st.rev || !st.at) await syncPull();
      else st.at = Date.now();
    }
    syncRetryHeld();
    let top = await syncPush();
    if (head && head.rekey) top = Math.max(top, await syncRekey(syncRekeyProgress));
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
    else if (!e.status && !e.net) window.fehlerMelden?.(e, 'abgleich');
  } finally {
    syncBusy = false;
    syncUnsentMemo = null;
    syncSave();
    if (syncAgain) {
      const full = syncAgain === 'full';
      syncAgain = false;
      setTimeout(() => syncRun(!full), 300);
    }
  }
  syncShowConflicts();
  // Konto-Seite offen: „Abgeglichen: …“
  const el = document.getElementById('account-status');
  if (el && account) el.textContent = accountStatusText();
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

/** Datensätze, die nicht in eine Anfrage passen bzw. die der Server nie annimmt (Kennung mit Steuerzeichen …): bis zum
 *  nächsten Start übergehen, statt alles andere aufzuhalten */
const syncSkip = new Set();
/** Kennung, die der Server annimmt (wie im Worker) */
const syncIdOk = (id) => typeof id === 'string' && /^[^\u0000-\u001f]{1,200}$/.test(id);
/** Einmal melden und ab jetzt übergehen */
function syncSkipKey(key, why) {
  if (syncSkip.has(key)) return;
  syncSkip.add(key);
  window.fehlerMelden?.(new Error(`${why}: ${syncSplit(key).k}`), 'abgleich');
}
/** Eigenes senden, in Teilen. Ergebnis: Zähler des Servers nach dem letzten Senden (0 = nichts gesendet) */
async function syncPush() {
  const st = syncState();
  if (st.hold > SYNC_F) return 0;
  let top = 0;
  // abgelehnt, ohne dass sich danach etwas geändert hat (Fassung des Servers nicht lesbar …): in diesem Lauf nicht noch einmal
  const stuck = new Set();
  // verschlüsselt, passte aber nicht mehr ins Paket: im nächsten Paket nicht noch einmal verschlüsseln
  const sealed = new Map();
  for (let round = 0; round < 30; round++) {
    const list = syncChanges().filter((c) => !syncSkip.has(c.key) && !syncKgWait.has(c.key) && !stuck.has(c.key));
    if (!list.length) break;
    const batch = [];
    let size = 0;
    for (const c of list) {
      if (!syncIdOk(c.id)) {
        syncSkipKey(c.key, 'Kennung');
        continue;
      }
      const pre = sealed.get(c.key);
      const data = c.del ? '' : pre && pre.h === c.h ? pre.data : await syncSeal(c.v, st.kg, c.k);
      if (data.length > SYNC_ONE_MAX) {
        syncSkipKey(c.key, `zu groß ${data.length}`);
        continue;
      }
      if (batch.length && (batch.length >= SYNC_PUSH_N || size + data.length > SYNC_PUSH_BYTES)) {
        sealed.set(c.key, { h: c.h, data });
        break;
      }
      batch.push({ ...c, data });
      size += data.length + 200;
    }
    if (!batch.length) break;
    for (const c of batch) st.sent[c.key] = [...(st.sent[c.key] || []).slice(-2), c.h];
    syncSave();
    let out;
    try {
      out = await syncRequest('push', { f: SYNC_F, kg: st.kg, records: batch.map((c) => ({ k: c.k, id: c.id, base: c.base, del: !!c.del, data: c.data })) });
    } catch (e) {
      // sent bleibt stehen: ein früherer Versuch ohne Antwort kann angenommen worden sein (aufgeräumt beim nächsten
      // Eingang bzw. Senden dieses Datensatzes)
      // ein Datensatz, den der Server nie annimmt: übergehen und den Rest erneut senden
      const bad = e.status === 400 && e.message === 'record' && e.data && batch.find((c) => c.k === e.data.k && c.id === e.data.id);
      if (!bad) throw e;
      syncSkipKey(bad.key, 'abgelehnt');
      continue;
    }
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
      // Fassung mit einem Schlüssel, den dieses Gerät nicht kennt: warten, bis sie neu verschlüsselt ist
      if (r.rev && !r.del && r.kg !== st.kg && !st.oldKeys[r.kg]) syncKgWait.add(syncKeyOf(r.k, r.id));
      // auf dem Server gibt es den Datensatz gar nicht (mehr): neu anlegen bzw. vergessen
      if (!r.rev) {
        const key = syncKeyOf(r.k, r.id);
        const c = batch.find((x) => x.key === key);
        if (c && c.del) delete st.recs[key];
        else if (c) st.recs[key] = { rev: 0, h: '!' };
      }
    }
    // abgelehnt: ein anderes Gerät war schneller – dessen Fassung wie beim Abholen behandeln (gleich, gewinnt, Konflikt;
    // ist es eine eigene frühere, deren Antwort verloren ging: sent)
    await syncApply(rejected.filter((r) => r.rev));
    for (const r of rejected) {
      const c = batch.find((x) => x.k === r.k && x.id === r.id);
      if (c && ((st.recs[c.key] && st.recs[c.key].rev) || 0) === c.base) stuck.add(c.key);
    }
    for (const c of batch) delete st.sent[c.key];
    syncSave();
  }
  return top;
}

/** Nach einem Passwortwechsel: Datensätze mit einem früheren Schlüssel neu verschlüsseln und zurücksenden, in Teilen.
 *  Bricht es ab (App zu, kein Netz), geht es beim nächsten Abgleich weiter – auch auf einem anderen Gerät, das den
 *  früheren Schlüssel noch kennt. onProgress(Anteil 0–1) für die Anzeige. Ergebnis: Zähler des Servers (0 = nichts) */
async function syncRekey(onProgress) {
  const st = syncState();
  const kgs = Object.keys(st.oldKeys).map(Number);
  // ging zuletzt gar nicht (Schlüssel passt nicht): nicht bei jedem Abgleich erneut
  if (!kgs.length || Date.now() - (st.rekeyFail || 0) < 3600e3) return 0;
  let top = 0;
  let total = 0;
  for (let n = 0; n < 500; n++) {
    const out = await syncRequest('rekey', { kgs });
    const list = out.records || [];
    total = Math.max(total, out.left || 0);
    if (onProgress && total) onProgress(1 - (out.left || 0) / total);
    if (!list.length) {
      st.oldKeys = {};
      break;
    }
    const batch = [];
    for (const r of list)
      try {
        const v = await syncOpen(r.data, r.k, st.oldKeys[r.kg]);
        batch.push({ r, data: await syncSeal(v, st.kg, r.k) });
      } catch (e) {
        window.fehlerMelden?.(e, 'abgleich');
      }
    if (!batch.length) {
      st.rekeyFail = Date.now();
      break;
    }
    const res = await syncRequest('push', { f: SYNC_F, kg: st.kg, records: batch.map(({ r, data }) => ({ k: r.k, id: r.id, base: r.rev, del: false, data })) });
    // Inhalt unverändert: kannte dieses Gerät genau die alte Fassung, ist die neue dieselbe (nicht noch einmal abholen)
    for (const a of res.accepted || []) {
      const x = batch.find((b) => b.r.k === a.k && b.r.id === a.id);
      const e = st.recs[syncKeyOf(a.k, a.id)];
      if (x && e && e.rev === x.r.rev) e.rev = a.rev;
    }
    // niemand sonst hat dazwischen gesendet: das Neu-Verschlüsselte nicht noch einmal abholen
    if (res.rev - (res.accepted || []).length === st.rev) st.rev = res.rev;
    top = Math.max(top, res.rev || 0);
    syncSave();
  }
  if (onProgress && total) onProgress(1);
  return top;
}

/** Stand der Datensätze auf dem Server zu einem früheren Zeitpunkt: Auswahl (je Tag mit Änderungen der Stand am Abend;
 *  „vor der Wiederherstellung“ kann der Server auch, ist aber nicht gewünscht), dann wiederherstellen. Vorher muss alles abgeglichen sein */
async function syncRestorePick() {
  if (!(await syncReady())) return;
  let out;
  try {
    out = await syncRequest('restore-days');
  } catch (e) {
    return toast(e.message === 'rekey' ? 'Wird noch neu verschlüsselt – später noch einmal' : accountError(e));
  }
  const today = isoDate(new Date());
  const days = Object.keys(out.days).sort();
  const after = (d) => days.filter((x) => x > d).reduce((n, x) => n + out.days[x], 0);
  // Stand am Ende des Tages – nur, wenn sich danach noch etwas geändert hat
  const list = days
    .filter((d) => d < today)
    .map((d) => ({ at: +addDays(parseDate(d), 1) - 1, label: fmtDayMonth(parseDate(d)), day: d, n: after(d) }))
    .filter((x) => x.n && x.at >= out.from)
    .reverse();
  if (!list.length) return toast('Noch kein früherer Stand');
  const pick = await syncRestoreAsk(list);
  if (pick) syncRestore(pick);
}

/** Auswahl des Stands, dann Rückfrage. Ergebnis: gewählter Eintrag oder null */
function syncRestoreAsk(list) {
  return new Promise((resolve) => {
    const modal = openModal(
      `<div class="alert-body"><b>Stand wiederherstellen</b></div>
      <div class="alert-buttons stacked acc-pick">${list
        .map((x, i) => `<button data-i="${i}">Stand vom ${WEEKDAYS_SHORT[(parseDate(x.day).getDay() + 6) % 7]} ${x.label}</button>`)
        .join('')}<button data-i="">Abbrechen</button></div>`,
      'alert'
    );
    modal.previousElementSibling.addEventListener('click', () => resolve(null));
    modal.addEventListener('click', (e) => {
      const b = e.target.closest('[data-i]');
      if (!b) return;
      closeModal();
      const x = list[b.dataset.i];
      if (!x) return resolve(null);
      setTimeout(
        () =>
          confirmDialog(
            `Stand vom ${WEEKDAYS_SHORT[(parseDate(x.day).getDay() + 6) % 7]} ${x.label} wiederherstellen?`,
            'Gilt auf allen Geräten.',
            'Wiederherstellen',
            () => resolve(x),
            true,
            'Abbrechen',
            () => resolve(null)
          ),
        280
      );
    });
  });
}

/** Erst abgleichen (sonst ginge Ungesendetes verloren bzw. würde Konflikt). Ergebnis: true = alles aktuell */
async function syncReady() {
  if (!navigator.onLine) return toast('Keine Verbindung'), false;
  toast('Wird abgeglichen …', 10000);
  await syncIdle();
  await syncRun();
  await syncIdle();
  document.getElementById('toast').classList.remove('show');
  if (syncCurrent()) return true;
  toast(syncState().conflicts.length ? 'Erst den Konflikt klären' : 'Abgleich hat nicht geklappt – später noch einmal');
  return false;
}

async function syncRestore(pick) {
  syncPaused = true;
  await syncIdle();
  toast('Wird wiederhergestellt …', 60000);
  let ok = false;
  try {
    for (let n = 0, first = true; n < 200; n++, first = false) if (!(await syncRequest('restore', { at: pick.at, first })).more) break;
    ok = true;
  } catch (e) {
    toast(accountError(e));
  } finally {
    syncPaused = false;
  }
  await syncRun();
  await syncIdle();
  if (ok) toast(`Stand vom ${pick.label} wiederhergestellt`);
}

// ───────── Eingehendes ─────────

/** Fassungen vom Server übernehmen (Abholen oder abgelehnt beim Senden) */
async function syncApply(records) {
  const st = syncState();
  const ch = { sheets: false, editor: false, settings: [] };
  // auch wenn mittendrin etwas schiefgeht: Übernommenes speichern (die Fingerabdrücke in recs sind schon gemerkt)
  try {
    for (const r of records) {
      if (!SYNC_KINDS_HERE.includes(r.k)) continue;
      // schon bekannt (z. B. eigene neu verschlüsselte Fassung): nicht erst entschlüsseln
      const e = st.recs[syncKeyOf(r.k, r.id)];
      if (e && e.rev >= r.rev) continue;
      // mit älterem Passwort verschlüsselt (wird gerade neu verschlüsselt): mit dem früheren Schlüssel, sonst später
      const raw = r.kg === st.kg ? cryptStore && cryptStore.key : st.oldKeys[r.kg];
      if (!r.del && !raw) continue;
      let v = null;
      if (!r.del)
        try {
          v = await syncOpen(r.data, r.k, raw);
        } catch (e) {
          window.fehlerMelden?.(e, 'abgleich');
          continue;
        }
      if (v && !syncValid(r.k, r.id, v)) continue;
      syncIncoming({ k: r.k, id: r.id, rev: r.rev, del: !!r.del, v, dev: r.dev, updated: r.updated }, ch);
    }
  } finally {
    syncAfter(ch);
  }
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
  // eine Fassung, die dieses Gerät gesendet hat, ohne die Antwort zu bekommen?
  const mine = (st.sent[key] || []).includes(hs);
  delete st.sent[key];
  const drop = () => {
    st.conflicts = st.conflicts.filter((c) => c.key !== key);
    st.held = st.held.filter((x) => syncKeyOf(x.k, x.id) !== key);
    st.wait = st.wait.filter((x) => syncKeyOf(x.k, x.id) !== key);
  };
  if (hl === hs) {
    st.recs[key] = syncRec(srv.k, srv.v, srv.rev, hs);
    return drop();
  }
  // Bilder ändern sich nie (neue ID je Bild): nie ein Fenster. Gelöscht wird hier nur, was kein Monatsbericht hier noch
  // braucht (auch ein unveränderter: dessen neue Fassung kann im Wettlauf abgelehnt worden sein) – sonst bleibt es und geht
  // wieder hoch; wird der Bericht ersetzt, räumt syncPutBh es ab. Fehlt es hier (IndexedDB), kommt es so auch wieder
  if (srv.k === 'bh-img') {
    drop();
    if (srv.del && local && syncImgUsed().has(srv.id)) st.recs[key] = { rev: srv.rev, h: 'del' };
    else {
      syncPut(srv, ch);
      st.recs[key] = syncRec(srv.k, srv.v, srv.rev, hs);
    }
    return;
  }
  // inhaltlich die Fassung, auf der die eigene Änderung aufbaut (neu verschlüsselt nach einem Passwortwechsel, nur die
  // Ansicht anders): kein Konflikt, die eigene geht auf die neue Fassung
  if (e && syncSame(e, srv.k, srv.v, hs)) {
    st.recs[key] = { ...e, rev: srv.rev };
    return drop();
  }
  // die eigene, schon angenommene Fassung (Antwort aufs Senden ging verloren): kein Konflikt – Neueres von hier geht darauf
  if (mine) {
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
  const unchanged = e ? syncSame(e, srv.k, local, hl) : local == null;
  // Heft auf einem anderen Gerät gelöscht, hier aber ein Bericht darin geändert: fragen statt still alles zu löschen
  if (srv.k === 'bh-heft' && srv.del && unchanged && syncBhDirty(srv.id).length) {
    st.conflicts.push({ key, k: srv.k, id: srv.id, srv });
    return;
  }
  // nur „zuletzt geändert“ anders (z. B. gleich eingelesen): die Fassung des Servers übernehmen
  if (unchanged || syncBareH(srv.k, local) === syncBareH(srv.k, srv.v)) {
    // neuer Zettel einer Woche, für die es hier schon einen (anderen) gibt: beide auf zwei Geräten angelegt
    const twin = srv.k === 'sheet' && !srv.del && !local && sheets.find((s) => s.id !== srv.id && weekKey(s) === weekKey(srv.v));
    // der andere Zettel ist gerade mit ungespeicherten Tagen im Editor offen: nicht anfassen, nach dem Speichern erneut
    if (twin && editorSaved && editorSaved.id === twin.id && editorPending()) {
      st.held = st.held.filter((x) => x.id !== srv.id || x.k !== srv.k).concat([srv]);
      return;
    }
    if (twin && !syncSameSheet(savedSheet(twin), srv.v)) {
      st.conflicts.push({ key, k: srv.k, id: srv.id, srv, twin: twin.id });
      return;
    }
    if (twin) {
      // gleicher Inhalt: alle Geräte behalten denselben (kleinere ID) – auch wenn sie es gleichzeitig entscheiden
      // (sonst wirft jedes den eigenen weg und löscht danach den anderen); der andere verschwindet auf seinem Gerät
      if (twin.id < srv.id) {
        st.recs[key] = { rev: srv.rev, h: 'del' };
        return;
      }
      syncDropTwin(twin.id, srv.id, ch);
    }
    syncPut(srv, ch);
    st.recs[key] = syncRec(srv.k, srv.v, srv.rev, hs);
    return;
  }
  if (srv.k === 'set' || srv.k === 'report') {
    // schon einmal abgeglichen und hier geändert: die eigene gewinnt (auf die Fassung des Servers senden);
    // zum ersten Mal (neues Gerät): die des Servers – Vorgaben schickt ein Gerät nie ungefragt (syncChanges), eine
    // Vorgabe auf dem Server ist also bewusst eingestellt
    if (e) st.recs[key] = { rev: srv.rev, h: e.h };
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
      const e = st.recs[syncKeyOf(k, id)];
      if (filled(x) && !(e && syncSame(e, k, x))) out.push(syncTitle(k, x, id));
    }
  return out;
}

/** Einstellung hat den Wert der Vorgabe (bzw. ist leer, wenn es keine Vorgabe gibt – false zählt dann als bewusst
 *  eingestellt: „Aus“ bei Hinweisen, deren Vorgabe „an“ ist) */
const syncSetDefault = (id, v) => (id in DEFAULT_SETTINGS ? syncCanon(v) === syncCanon(DEFAULT_SETTINGS[id]) : v == null || v === '');

/** Bilder, auf die ein Monatsbericht hier zeigt, dazu die der Server-Fassungen offener Konflikte (Wahl „Übernehmen“).
 *  onlyOwn: nur Berichte mit eigener, noch nicht abgeglichener Änderung bzw. offenem Konflikt (die anderen ersetzt
 *  ohnehin bald die Fassung vom Server) */
function syncImgUsed(onlyOwn = false) {
  const st = syncState();
  const ids = new Set();
  for (const h of bh.hefte)
    for (const [ym, mo] of Object.entries(h.months || {})) {
      const key = syncKeyOf('bh-month', `${h.id}|${ym}`);
      const e = st.recs[key];
      if (onlyOwn && e && syncSame(e, 'bh-month', mo) && !st.conflicts.some((c) => c.key === key)) continue;
      for (const id of syncBhImgIds(mo)) ids.add(id);
    }
  for (const c of st.conflicts) if (c.k === 'bh-month' && c.srv.v) for (const id of syncBhImgIds(c.srv.v)) ids.add(id);
  return ids;
}

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
  // offener Zettel: erst den gespeicherten Stand umstellen, dann speichern (sonst schriebe savedSheets die alten Tage)
  if (ch.editor) {
    const s = editorSaved && findSheet(editorSaved.id);
    if (s) editorSaved = editorSnapshot(s);
  }
  if (ch.sheets) saveSheets();
  if (ch.sheets || ch.settings.includes('hiddenSuggestions')) refreshSuggestions();
  syncRerender();
}

/** Gerade ein Fenster offen oder mitten im Tippen (Berichtsheft speichert bei jedem Tastendruck): nicht neu zeichnen bzw. fragen */
const syncUiBusy = () => layer.classList.contains('open') || !!(document.activeElement && document.activeElement.matches('input, textarea, [contenteditable="true"]'));
/** Offene Seite neu zeichnen – nicht mitten im Tippen und nicht unter einem Fenster (dann etwas später) */
function syncRerender() {
  clearTimeout(syncRerender.t);
  if (syncUiBusy()) {
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
  try {
    for (const srv of held) syncIncoming(srv, ch);
  } finally {
    syncAfter(ch);
  }
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
  if (k !== 'sheet') return 'Eintrag';
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
  if (!!mine.sentAt !== !!theirs.sentAt) out.push({ label: 'Status', mine: tr(mine.sentAt ? 'gesendet' : 'offen'), theirs: tr(theirs.sentAt ? 'gesendet' : 'offen') });
  return out;
}

/** Unterschiede zweier Fassungen einer Abrechnung: Tage, Ort/Datum (tripDiff), dazu Name, Unterschrift, gesendet */
function syncTripDiff(mine, theirs) {
  const out = tripDiff(mine, theirs);
  if ((mine.name || '') !== (theirs.name || '')) out.push({ label: 'Name', mine: mine.name || '–', theirs: theirs.name || '–' });
  if ((mine.signature || '') !== (theirs.signature || ''))
    out.push({ label: 'Unterschrift', mine: mine.signature ? tr('vorhanden') : '–', theirs: theirs.signature ? tr(mine.signature ? 'andere' : 'vorhanden') : '–' });
  if (!!mine.sentAt !== !!theirs.sentAt) out.push({ label: 'Status', mine: tr(mine.sentAt ? 'gesendet' : 'offen'), theirs: tr(theirs.sentAt ? 'gesendet' : 'offen') });
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
    unit === 'y' ? String(v || p.year) : v == null || v === '' ? '–' : unit === '€' ? fmtMoney(v, true) : unit === 'h' ? tr(fmtH(v * 60)) : `${fmtDec(v * 60)} %`;
  const out = syncPayFields().map(([path, label, unit]) => ({ label, mine: fmt(get(mine, path), unit, mine), theirs: fmt(get(theirs, path), unit, theirs) })).filter(
    (d) => d.mine !== d.theirs
  );
  // anders in einem Feld, das die Liste nicht kennt (neues Feld, Lohnzeilen …): nicht „kein Unterschied“ zeigen
  if (!out.length && syncBareH('pay', mine) !== syncBareH('pay', theirs)) out.push({ label: 'Weitere Angaben', mine: tr('andere'), theirs: tr('andere') });
  return out;
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
  return [...lines, d.hours ? `= ${d.hours} ${tr('Std.')}` : ''].filter(Boolean).join(' \n ') || '–';
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
  out.push({ label: 'Automatisch unterschreiben', mine: syncOnOff(mine.autoSign), theirs: syncOnOff(theirs.autoSign) });
  return out.filter((d) => d.mine !== d.theirs);
}
/** „an“/„aus“ eines Schalters (übersetzt steht „aus“ schon für „aus Datei“) */
const syncOnOff = (on) => (on ? tr('an') : LANG === 'de' ? 'aus' : tr('Schalter aus'));
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
  if (syncUiBusy()) {
    clearTimeout(syncShowConflicts.t);
    syncShowConflicts.t = setTimeout(syncShowConflicts, 2000);
    return;
  }
  syncShowConflicts.busy = true;
  let all = '';
  try {
    for (const c of list) {
      if (!st.conflicts.includes(c)) continue;
      // Bild (gespeichert von einer älteren Fassung): folgt seinem Bericht, ohne Fenster
      if (c.k === 'bh-img') {
        syncResolve(c, syncImgUsed().has(c.id) ? 'mine' : 'theirs');
        continue;
      }
      // zweiter Zettel derselben Woche, der hier inzwischen gelöscht ist (auf dem anderen Gerät wurde dessen behalten): nichts zu wählen
      if (c.twin && !findSheet(c.twin)) {
        syncResolve(c, 'theirs');
        continue;
      }
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
        // während das Fenster offen war, kam eine neuere Fassung (der Konflikt ist ersetzt): die nächste Runde zeigt sie
        if (!st.conflicts.includes(c)) continue;
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
    // festhalten: andere Fenster (z. B. „Passwort geändert“) warten, Seitenwechsel schließen es nicht – sonst hinge die Wahl
    holdModal(true);
    scrollBar(modal);
    let done = false;
    modal.addEventListener('click', (e) => {
      const b = e.target.closest('[data-c]');
      if (!b || done) return;
      done = true;
      haptic();
      holdModal(false);
      closeModal();
      setTimeout(() => resolve(modal.querySelector('.cf-switch')?.checked ? `${b.dataset.c}All` : b.dataset.c), 280);
    });
  });
}

// ───────── Team und Anlässe ─────────

/** Darf dieses Gerät ins Team hochladen? Mit Abgleich nur mit frischem Stand, ohne offenen Konflikt und ohne
 *  Ungesendetes – sonst überschriebe ein Gerät mit altem Stand den Eintrag, den alle Geräte des Kontos teilen */
function syncCurrent() {
  // ohne bestätigtes Konto hat ein Gerät, das schon im Abgleich war, womöglich einen alten Stand (z. B. abgemeldet)
  if (!(account && account.sync)) return !(syncWasOn() && !accountOk());
  if (!syncOn()) return false;
  const st = syncState();
  return !st.conflicts.length && !st.held.length && Date.now() - st.at < SYNC_FRESH && !(st.hold > SYNC_F) && !syncUnsent();
}
/** Liegt noch Ungesendetes hier? Nach jedem Lauf fragen mehrere (Ende des Laufs, Team-Upload, Konto-Seite) – darum kurz
 *  gemerkt; jede Änderung (syncSoon) und jeder Lauf vergessen es */
let syncUnsentMemo = null;
function syncUnsent() {
  if (syncUnsentMemo && Date.now() - syncUnsentMemo.at < 2000) return syncUnsentMemo.v;
  const v = syncChanges().some((c) => !syncSkip.has(c.key));
  syncUnsentMemo = { at: Date.now(), v };
  return v;
}

/** Dieses Gerät hat schon einmal abgeglichen (gespeicherter Stand mit Konto und Zähler) */
function syncWasOn() {
  try {
    const s = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
    return !!(s && s.user && s.rev > 0);
  } catch {
    return false;
  }
}

/** Nach dem Speichern: gleich senden */
function syncSoon(delay = 300) {
  syncUnsentMemo = null;
  if (!syncOn()) return;
  clearTimeout(syncSoon.t);
  syncSoon.t = setTimeout(() => syncRun(true), delay);
}

/** Start (app.js ganz geladen), Zurückkehren, wieder online, alle 45 s solange sichtbar */
function syncStart() {
  syncStarted = true;
  syncRun();
  setInterval(() => document.visibilityState === 'visible' && syncRun(), SYNC_TICK);
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? syncRun() : syncSoon(0)));
  window.addEventListener('online', () => syncRun());
}
