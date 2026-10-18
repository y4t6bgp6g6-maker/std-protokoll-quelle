// Std-Protokoll – Abgleich mehrerer Geräte (nur Konten mit Abgleich, Schalter auf der Server-Seite; Plan:
// Ideen/Plan-Abgleich-mehrere-Geraete.md). Zettel und Einstellungen gehen je Datensatz verschlüsselt an den Team-Server
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
//   conflicts: [{ key, k, id, srv: { rev, del, v, dev, updated }, twin }] auf zwei Geräten geändert → Fenster;
//              twin: anderer Zettel derselben Woche (auf zwei Geräten neu angelegt)
//   hold: höchste App-Fassung, die schon gesendet hat; ist sie neuer als diese, sendet dieses Gerät nichts mehr
//   devs: Geräte-ID → Name (für das Fenster)
// Zettel: Konflikt-Fenster. Einstellungen: die zuletzt gesendete gilt (ohne SYNC_SET_SKIP, die bleiben je Gerät).

const SYNC_KEY = 'stdprotokoll.sync.v1';
/** App-Fassung (gleiche Zahl wie CACHE in sw.js): ein Gerät mit älterer sendet nicht mehr, sobald eine neuere gesendet hat */
const SYNC_F = 119;
/** Arten, die diese Fassung abgleicht (kommen neue dazu, holt das Gerät einmal alles neu ab) */
const SYNC_KINDS_HERE = ['sheet', 'set'];
/** Einstellungen je Gerät bzw. fest vorgegeben */
const SYNC_SET_SKIP = new Set(['theme', 'listMode', 'ovCards', 'encryptBackup', 'target', 'hoursPerDay', 'minuteStep', 'state']);
const SYNC_PUSH_N = 40; // Worker: höchstens 40 Datensätze je Senden
const SYNC_PUSH_BYTES = 800_000; // Worker: Anfrage höchstens 1 MB
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
/** Zum Vergleich des Inhalts: ohne „zuletzt geändert“ */
const syncBareH = (k, v) => (v == null ? 'del' : k === 'sheet' ? syncH({ ...v, updatedAt: 0 }) : syncH(v));
/** Fingerabdruck nach dem automatischen Nachtragen beim Start (nur Zettel) */
function syncAutoH(k, v) {
  if (k !== 'sheet' || v == null) return undefined;
  const c = structuredClone(v);
  return fixWeekend(c) ? syncH(c) : undefined;
}
/** Merken, welche Fassung der Server hat */
const syncRec = (k, v, rev, h = syncH(v)) => {
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
  return m;
}
/** Ein Datensatz dieses Geräts (null = gibt es nicht) */
function syncLocalOne(k, id) {
  if (k === 'sheet') return savedSheet(findSheet(id)) || null;
  if (k === 'set') return !SYNC_SET_SKIP.has(id) && settings[id] !== undefined ? { v: settings[id] } : null;
  return null;
}

/** Was zu senden ist: [{ key, k, id, base, del, v, h }] – ohne Datensätze mit offenem Konflikt */
function syncChanges(local = syncLocal()) {
  const st = syncState();
  // offener Konflikt, zurückgehaltene Fassung (Editor): erst nach der Wahl bzw. dem Speichern
  const blocked = new Set([...st.conflicts.flatMap((c) => [c.key, ...(c.twin ? [syncKeyOf('sheet', c.twin)] : [])]), ...st.held.map((x) => syncKeyOf(x.k, x.id))]);
  const out = [];
  for (const [key, r] of local) {
    if (blocked.has(key)) continue;
    const h = syncH(r.v);
    const e = st.recs[key];
    if (!e || e.h !== h) out.push({ key, k: r.k, id: r.id, base: e ? e.rev : 0, v: r.v, h });
  }
  for (const [key, e] of Object.entries(st.recs)) {
    const { k, id } = syncSplit(key);
    if (local.has(key) || e.h === 'del' || blocked.has(key) || !SYNC_KINDS_HERE.includes(k)) continue;
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
/** Hülle {"kg":…,"iv":"…","d":"…"} – der Server nimmt nur genau diese Form an */
async function syncSeal(v, kg) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const d = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await syncCryptKey(), new TextEncoder().encode(JSON.stringify(v)));
  const out = JSON.stringify({ kg, iv: toB64(iv), d: toB64(d) });
  // nie unverschlüsselt senden
  if (!/^\{"kg":\d+,"iv":"[A-Za-z0-9+/=]{16}","d":"[A-Za-z0-9+/=]+"\}$/.test(out)) throw new Error('plain');
  return out;
}
async function syncOpen(data) {
  const o = JSON.parse(data);
  const p = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(o.iv) }, await syncCryptKey(), fromB64(o.d));
  return JSON.parse(new TextDecoder().decode(p));
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
    if (st.hold && st.hold <= SYNC_F) st.hold = 0;
    let head = null;
    if (!pushFirst || !st.at) {
      head = await syncRequest('head');
      syncMeta(head);
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

/** Eigenes senden, in Teilen. Ergebnis: Zähler des Servers nach dem letzten Senden (0 = nichts gesendet) */
async function syncPush() {
  const st = syncState();
  if (st.hold > SYNC_F) return 0;
  let top = 0;
  for (let round = 0; round < 30; round++) {
    const list = syncChanges();
    if (!list.length) break;
    const batch = [];
    let size = 0;
    for (const c of list) {
      const data = c.del ? '' : await syncSeal(c.v, st.kg);
      if (batch.length && (batch.length >= SYNC_PUSH_N || size + data.length > SYNC_PUSH_BYTES)) break;
      batch.push({ ...c, data });
      size += data.length + 200;
    }
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
        v = await syncOpen(r.data);
      } catch (e) {
        window.fehlerMelden?.(e, 'abgleich');
        continue;
      }
    if (r.k === 'sheet' && v && !(v.id === r.id && v.weekStart && Array.isArray(v.days) && v.days.length === 7)) continue;
    syncIncoming({ k: r.k, id: r.id, rev: r.rev, del: !!r.del, v, dev: r.dev, updated: r.updated }, ch);
  }
  syncAfter(ch);
}

/** Ein eingehender Datensatz: gleich → nur merken; hier unverändert → übernehmen; hier auch geändert → Einstellung:
 *  die eigene gewinnt (wird erneut gesendet), Zettel: Konflikt-Fenster */
function syncIncoming(srv, ch) {
  const st = syncState();
  const key = syncKeyOf(srv.k, srv.id);
  const e = st.recs[key];
  if (e && e.rev >= srv.rev) return;
  const local = syncLocalOne(srv.k, srv.id);
  const hl = syncH(local);
  const hs = syncH(srv.v);
  const drop = () => {
    st.conflicts = st.conflicts.filter((c) => c.key !== key);
    st.held = st.held.filter((x) => syncKeyOf(x.k, x.id) !== key);
  };
  if (hl === hs) {
    st.recs[key] = syncRec(srv.k, srv.v, srv.rev, hs);
    return drop();
  }
  // Zettel mit ungespeicherten Tagen im Editor: nicht anfassen, später erneut (beim Speichern lehnt der Server ab → Fenster)
  if (srv.k === 'sheet' && editorSaved && editorSaved.id === srv.id && editorPending()) {
    st.held = st.held.filter((x) => x.id !== srv.id || x.k !== srv.k).concat([srv]);
    return;
  }
  drop();
  const unchanged = e ? e.h === hl || e.a === hl : local == null;
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
  if (srv.k === 'set') {
    // schon einmal abgeglichen und hier geändert: die eigene gewinnt (auf die Fassung des Servers senden);
    // zum ersten Mal (neues Gerät): die des Servers
    if (e) st.recs[key] = { rev: srv.rev, h: e.h };
    else {
      syncPut(srv, ch);
      st.recs[key] = syncRec(srv.k, srv.v, srv.rev, hs);
    }
    return;
  }
  st.conflicts.push({ key, k: srv.k, id: srv.id, srv });
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
  }
}
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
  if (!ch.sheets && !ch.settings.length) return;
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
  importRerender();
}

/** Zurückgehaltene Fassungen (Editor hatte ungespeicherte Tage) erneut prüfen */
function syncRetryHeld() {
  const st = syncState();
  if (!st.held.length) return;
  const held = st.held;
  st.held = [];
  const ch = { sheets: false, editor: false, settings: [] };
  for (const srv of held) syncIncoming(srv, ch);
  syncAfter(ch);
}

// ───────── Konflikte ─────────

/** Name eines Geräts für das Fenster */
const syncDevName = (dev) => (syncState().devs || {})[dev] || 'Anderes Gerät';
/** „Zettel 13.–17.10.“ bzw. „Zettel 29.09.–03.10.“ */
function syncTitle(s) {
  const a = sheetFirstDate(s);
  const b = sheetLastDate(s);
  return `Zettel ${a.getMonth() === b.getMonth() ? `${pad(a.getDate())}.` : fmtDayMonth(a)}–${fmtDayMonth(b)}`;
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

/** Wartende Konflikte nacheinander zeigen – nicht unter einem anderen Fenster und nicht, solange der betroffene Zettel
 *  ungespeicherte Tage hat */
async function syncShowConflicts() {
  if (syncShowConflicts.busy || typeof layer === 'undefined') return;
  const st = syncState();
  const editing = editorSaved && editorPending() ? editorSaved.id : null;
  const list = st.conflicts.filter((c) => c.id !== editing && c.twin !== editing);
  if (!list.length || !syncOn()) return;
  if (layer.classList.contains('open')) {
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
  const hs = syncH(c.srv.v);
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

/** Konflikt-Fenster: beide Fassungen als Karten nebeneinander (Gerät, Uhrzeit, Stunden, abweichende Tage markiert),
 *  Karte antippen = diese gilt. Ergebnis: 'mine' | 'theirs' (mit „All“: für alle weiteren gleich).
 *  Schließt nicht beim Antippen daneben – bis zur Wahl bliebe der Zettel ungesendet */
function syncAskConflict(c, mine, remaining) {
  return new Promise((resolve) => {
    const theirs = c.srv.del ? null : c.srv.v;
    const known = c.srv.dev in (syncState().devs || {});
    const diffs = mine && theirs ? syncSheetDiff(mine, theirs).map((d) => ({ ...d, w: wordDiffHTML(d.mine, d.theirs) })) : [];
    const card = (side, x, name, ms, cls, own) => `
      <div class="cf-card" data-c="${side}" role="button">
        <div class="cf-card-head"><span class="cf-tag ${cls}"${own || known ? ' translate="no"' : ''}>${escapeHtml(name)}</span><b>${x ? fmtH(sheetTotal(x)) : ''}</b></div>
        <div class="cf-card-when">${x ? '' : 'gelöscht '}${ms ? fmtStamp(ms) : ''}</div>
        ${diffs.map((d) => `<div class="cf-card-day"><b>${d.label}</b><span class="cf-txt" translate="no">${side === 'mine' ? d.w.mine : d.w.theirs}</span></div>`).join('')}
        <span class="cf-card-go">${side === 'mine' ? (x ? 'Behalten' : 'Gelöscht lassen') : x ? 'Übernehmen' : 'Löschen'}</span>
      </div>`;
    const modal = openModal(
      `<div class="alert-body cf">
        <b>${syncTitle(mine || theirs)} auf zwei Geräten geändert</b>
        <div class="cf-scroll"><div class="alert-msg">
          <p class="cf-intro">Welche Fassung soll gelten?</p>
          <div class="cf-cards">${card('mine', mine, syncMyName(), mine && mine.updatedAt, 'app', true)}${card('theirs', theirs, syncDevName(c.srv.dev), c.srv.updated, 'new', false)}</div>
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
  return !st.conflicts.length && !st.held.length && Date.now() - st.at < SYNC_FRESH && !(st.hold > SYNC_F) && !syncChanges().length;
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
