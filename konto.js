// Std-Protokoll – Konto: Benutzername + Passwort. Für das Team Pflicht, sonst freiwillig.
// Mit Konto sind alle Sicherungen verschlüsselt (Datei, Team-Server). Aus dem Passwort entstehen auf dem
// iPhone zwei Schlüssel: auth (der Server speichert davon nur einen Prüfwert) und der Sicherungs-Schlüssel (bleibt auf
// dem iPhone, liegt wie bisher in stdprotokoll.crypt.v1). Beide hängen nur von Benutzername und Passwort ab – nach einem
// Datenverlust reicht erneutes Anmelden, um die Sicherungen vom Team-Server wieder zu öffnen.
//
// Eigener Speicher (nicht in der Sicherung): { user, auth, mode, ok, restore, at, hash, error, sync, pwchanged, pwNext, left }
// mode: 'create' (neues Konto) | 'login' (bestehendes); ok: vom Server bestätigt; restore: 'ask' = Sicherung auf dem
// Server, Frage nach dem Einlesen noch offen (bis dahin wird nichts hochgeladen, sonst überschriebe ein leerer Stand sie);
// sync: Abgleich mehrerer Geräte für dieses Konto eingeschaltet (Schalter auf der Server-Seite); pwchanged: Passwort auf
// einem anderen Gerät geändert – Team-Upload und Sicherung warten, bis hier neu angemeldet ist; pwNext: { auth, key, salt }
// neues Passwort, das gerade beim Server geändert wird (Abgleich) – kam die Antwort nicht an und meldet der Server danach
// „pwchanged“, gilt es (accountPwAdopt), statt neu anmelden zu müssen; left: { code, token } Team mit Abgleich verlassen –
// damit fragt das Gerät beim Start, ob es inzwischen abgemeldet ist (accountLeftCheck)

const ACCOUNT_KEY = 'stdprotokoll.account.v1';
/** Sicherung auf dem Team-Server: nach Änderungen höchstens einmal je Stunde */
const ACCOUNT_BACKUP_GAP = 3600e3;
/** Mindestlänge für neue Passwörter (neues Konto, Passwort ändern) */
const PW_MIN = 8;

let account = null;
try {
  account = JSON.parse(localStorage.getItem(ACCOUNT_KEY) || 'null');
} catch {}
const saveAccount = () => {
  try {
    if (account) localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    else localStorage.removeItem(ACCOUNT_KEY);
  } catch {}
};
const accountOk = () => !!(account && account.ok);
/** Mit Abgleich kommt alles vom Server (keine Frage, der Team-Upload wartet nicht darauf) */
const accountRestorePending = () => !!(account && account.restore === 'ask' && !account.sync);
/** Benutzername wie auf dem Server: 3–32 Buchstaben, Ziffern, Punkt, Strich, Unterstrich; klein */
const accountUser = (s) => {
  const u = String(s ?? '').trim().toLowerCase();
  return /^[\p{L}\p{N}._-]{3,32}$/u.test(u) ? u : '';
};

/** Schlüssel aus Benutzername und Passwort: { auth (Base64), key (AES-GCM), salt } */
async function accountDerive(user, pw) {
  const te = new TextEncoder();
  const hash = async (s) => new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(s))).slice(0, 16);
  const salt = await hash(`std-protokoll-enc:${user}`);
  const key = await passwordKey(pw, salt);
  const base = await crypto.subtle.importKey('raw', te.encode(pw), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt: await hash(`std-protokoll-auth:${user}`), iterations: PBKDF2_ITER, hash: 'SHA-256' }, base, 256);
  return { auth: toB64(bits), key, salt };
}

// token: Konten mit Abgleich brauchen zusätzlich das Token eines ihrer Geräte (beim Beitreten das neue, siehe accountJoin)
const accountRequest = (action, extra = {}, code) =>
  teamRequest('POST', '/account', { action, user: account.user, auth: account.auth, token: team ? team.token : undefined, ...extra }, code);
/** Abgleich (nur Konten mit Schalter): Geräte-Liste, umbenennen, abmelden */
const accountSyncRequest = (action, extra = {}) =>
  teamRequest('POST', '/sync', { action, user: account.user, auth: account.auth, token: team.token, device: deviceInfo().id, ...extra });

// ───────── Geräte (Konto mit Abgleich: bis zu 3 je Konto) ─────────
// Eigener Speicher je Gerät (nie abgeglichen, nicht in der Sicherung): { id }. Die ID bleibt beim Verlassen des Teams und
// bei ungültigem Team-Code erhalten – sonst belegte jedes erneute Beitreten einen neuen Platz

const DEVICE_KEY = 'stdprotokoll.device.v1';
const WIPED_KEY = 'stdprotokoll.wiped.v1';
/** Vorgabe für den Gerätenamen (iPadOS meldet sich als Mac, hat aber Touch) */
function deviceKind() {
  const ua = navigator.userAgent;
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad';
  if (/iPhone|iPod/.test(ua)) return 'iPhone';
  if (/Android/.test(ua)) return 'Handy';
  return /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'PC' : 'Gerät';
}
function deviceInfo() {
  let d = null;
  try {
    d = JSON.parse(localStorage.getItem(DEVICE_KEY) || 'null');
  } catch {}
  if (!d || typeof d.id !== 'string' || !/^[A-Za-z0-9-]{8,128}$/.test(d.id)) {
    d = { id: uid() };
    try {
      localStorage.setItem(DEVICE_KEY, JSON.stringify(d));
    } catch {}
  }
  return d;
}

/** Auf einem anderen Gerät abgemeldet (Server antwortet „removed“, nur dann): alle Daten der App auf diesem Gerät löschen
 *  und neu starten. Auch die Geräte-ID – mit ihr nähme der Server dieses Gerät 90 Tage lang nicht wieder an */
async function deviceWipe() {
  if (deviceWipe.done) return;
  deviceWipe.done = true;
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('stdprotokoll.')) localStorage.removeItem(k);
    localStorage.setItem(WIPED_KEY, '1');
  } catch {}
  // ab jetzt nichts mehr speichern (offene Zeitgeber, Editor): sonst stünden Daten nach dem Neustart wieder da
  Storage.prototype.setItem = () => {};
  try {
    const db = await bhDb();
    await new Promise((resolve) => {
      const tx = db.transaction('img', 'readwrite');
      tx.objectStore('img').clear();
      tx.oncomplete = tx.onerror = tx.onabort = resolve;
    });
  } catch {}
  history.replaceState(null, '', location.pathname);
  location.reload();
}
/** Nach dem Neustart einmal sagen, warum alles leer ist */
function deviceWipedNotice() {
  try {
    if (!localStorage.getItem(WIPED_KEY)) return;
    localStorage.removeItem(WIPED_KEY);
  } catch {
    return;
  }
  infoDialog('Gerät abgemeldet', 'Die Daten auf diesem Gerät wurden gelöscht.');
}

/** Geräte des Kontos (null = nicht geladen bzw. ohne Abgleich): [{ device, name, created, seen, me }] */
let accountDevs = null;
let accountSyncAt = 0;
/** Abgleich an? Welche Geräte? Beim Start, beim Zurückkehren und auf der Konto-Seite (page). Dabei kommen auch „abgemeldet“,
 *  „Team verlassen“ und „Passwort geändert“ an (teamRequest), ohne dass etwas hochgeladen werden muss.
 *  Mit Abgleich fragt syncRun (head) das ohnehin – die Geräteliste braucht nur die Konto-Seite. Ohne Abgleich (fast alle
 *  Kollegen, Antwort 403) beim Start und danach höchstens alle 30 min */
async function accountSyncCheck(page = false) {
  if (!team || !accountOk() || !navigator.onLine || accountSyncCheck.busy) return;
  if (!page && account.sync && !account.pwchanged && cryptStore) return;
  if (Date.now() - accountSyncAt < (page ? 10e3 : 30 * 60e3)) return;
  accountSyncCheck.busy = true;
  accountSyncAt = Date.now();
  const sync = account.sync;
  const before = JSON.stringify(accountDevs);
  try {
    accountDevs = (await accountSyncRequest('devices')).devices || [];
    account.sync = true;
    // beim Einschalten trägt der Server das bisherige Gerät nur als „Gerät“ ein
    const me = accountDevs.find((d) => d.me);
    if (me && me.name === 'Gerät' && deviceKind() !== 'Gerät') accountDevs = (await accountSyncRequest('device-name', { device: me.device, name: deviceKind() })).devices || accountDevs;
  } catch (e) {
    // Abgleich aus (Schalter auf der Server-Seite)
    if (account && e.status === 403 && e.message === 'sync') {
      account.sync = false;
      accountDevs = null;
    }
  } finally {
    accountSyncCheck.busy = false;
  }
  if (!account) return;
  // nur „zuletzt gesehen“ anders: neu zeichnen genügt
  if (account.sync !== sync) {
    saveAccount();
    syncSoon(0);
  }
  if (account.sync !== sync || JSON.stringify(accountDevs) !== before) accountRerender();
}

/** Team mit Abgleich verlassen (hier oder auf einem anderen Gerät): seitdem fragt das Gerät nichts mehr – beim Start
 *  einmal nachsehen, ob es inzwischen abgemeldet wurde (dann Daten löschen) */
async function accountLeftCheck() {
  const l = account && account.ok && !team && account.left;
  if (!l || !TEAM_URL || !navigator.onLine) return;
  let res;
  let data = {};
  try {
    const body = JSON.stringify({ code: l.code, user: account.user, auth: account.auth, token: l.token, device: deviceInfo().id, action: 'head' });
    res = await fetch(TEAM_URL + '/sync', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body, cache: 'no-store' });
    data = await res.json().catch(() => ({}));
  } catch {
    return;
  }
  if (res.status === 403 && data.error === 'removed') return deviceWipe();
  // weiter „verlassen“: beim nächsten Start wieder; alles andere (Team-Code oder Passwort geändert, Abgleich aus, Gerät
  // nach 90 Tagen vergessen): nicht mehr fragen
  if ((res.status === 403 && data.error === 'left') || res.status === 429 || res.status >= 500) return;
  delete account.left;
  saveAccount();
}

/** Beim Anmelden schon alle Plätze belegt: eins abmelden (Passwort ist geprüft). Ergebnis: true = abgemeldet */
function accountFreeDevice(devices, code) {
  return new Promise((resolve) => {
    const modal = openModal(
      `<div class="alert-body"><b>Schon ${devices.length} Geräte</b><div class="alert-msg">Eins abmelden – es löscht dann seine Daten.</div></div>
      <div class="alert-buttons stacked acc-pick">${devices
        .map((d) => `<button data-dev="${escapeHtml(d.device)}"><span translate="no">${escapeHtml(d.name || 'Gerät')}</span> · seit ${fmtDayMonth(new Date(d.created))}</button>`)
        .join('')}<button data-dev="">Abbrechen</button></div>`,
      'alert',
      false
    );
    modal.addEventListener('click', (e) => {
      const b = e.target.closest('[data-dev]');
      if (!b) return;
      closeModal();
      const d = devices.find((x) => x.device === b.dataset.dev);
      if (!d) return resolve(false);
      setTimeout(
        () =>
          confirmDialog(
            `„${escapeHtml(d.name || 'Gerät')}“ abmelden?`,
            'Es löscht seine Daten, sobald es online ist.',
            'Abmelden',
            async () => {
              try {
                await accountRequest('device-remove', { device: d.device }, code);
                resolve(true);
              } catch (err) {
                toast(accountError(err));
                resolve(false);
              }
            },
            true,
            'Abbrechen',
            () => resolve(false)
          ),
        280
      );
    });
  });
}

function accountDevicesHTML() {
  return `<h2 class="section-title">Geräte</h2>
    <div class="card form">${accountDevs
      .map(
        (d) => `<button class="field acc-dev" data-acc="device" data-dev="${escapeHtml(d.device)}"><span translate="no">${escapeHtml(d.name || 'Gerät')}</span><span class="muted">${
          d.me ? 'Dieses Gerät' : d.seen ? accountWhen(d.seen) : ''
        }</span></button>`
      )
      .join('')}</div>`;
}

function accountDeviceMenu(id) {
  const d = (accountDevs || []).find((x) => x.device === id);
  if (!d) return;
  actionSheet([
    { label: 'Umbenennen', run: () => accountDeviceRename(d) },
    // das eigene nicht: es löschte sofort alle Daten hier
    ...(d.me ? [] : [{ label: 'Abmelden', destructive: true, run: () => accountDeviceRemove(d) }]),
  ]);
}

function accountDeviceRename(d) {
  const modal = openModal(
    `<div class="alert-body"><b>Gerätename</b>
      <input class="pw-input" data-dev-name maxlength="40" autocomplete="off" enterkeyhint="done">
    </div>
    <div class="alert-buttons"><button data-c="no">Abbrechen</button><button data-c="yes" class="strong">OK</button></div>`,
    'alert'
  );
  const input = modal.querySelector('[data-dev-name]');
  input.value = d.name || '';
  const send = async () => {
    const name = input.value.replace(/\s+/g, ' ').trim();
    if (!name) return;
    closeModal();
    if (name === d.name) return;
    try {
      accountDevs = (await accountSyncRequest('device-name', { device: d.device, name })).devices || accountDevs;
    } catch (e) {
      return toast(accountError(e));
    }
    // Namen fürs Konflikt-Fenster (sonst bis zum nächsten Abholen der alte)
    const st = syncState();
    if (st.devs) st.devs[d.device] = name;
    syncSave();
    accountRerender();
  };
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    if (b.dataset.c === 'no') closeModal();
    else send();
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && send());
  setTimeout(() => input.focus(), 50);
}

function accountDeviceRemove(d) {
  confirmDialog(`„${escapeHtml(d.name || 'Gerät')}“ abmelden?`, 'Es löscht seine Daten, sobald es online ist.', 'Abmelden', async () => {
    try {
      accountDevs = (await accountSyncRequest('device-remove', { device: d.device })).devices || accountDevs;
    } catch (e) {
      return toast(accountError(e));
    }
    accountRerender();
  }, true);
}

/** Passwort auf einem anderen Gerät geändert: Lesen, Team-Upload und Sicherung warten, bis hier neu angemeldet ist
 *  (zählt beim Server nicht als Fehlversuch) */
function accountPwChanged() {
  // eigener Passwortwechsel, dessen Antwort nicht ankam (bzw. noch läuft): er hat geklappt
  if (account.pwNext) return accountPwAdopt();
  account.ok = false;
  account.pwchanged = true;
  account.error = accountError({ message: 'pwchanged' });
  saveAccount();
  accountRerender();
  // einmal Bescheid geben (danach steht es auf der Konto-Seite)
  confirmDialog('Passwort geändert', 'Auf einem anderen Gerät. Bitte neu anmelden.', 'Anmelden', accountRelogin, false, 'Später');
}

/** Neues Passwort übernehmen (der Server hat es): Prüfwert und Schlüssel ersetzen; die alte Sicherung ist weg */
function accountPwAdopt() {
  const n = account.pwNext;
  if (!n) return;
  delete account.pwNext;
  Object.assign(account, { auth: n.auth, at: 0, hash: '' });
  saveAccount();
  storeCryptKey({ salt: n.salt, key: n.key });
}

/** Mit dem neuen Passwort wieder anmelden (Konto bleibt, nur das Passwort wird neu eingegeben) */
async function accountRelogin() {
  const pw = await askPassword('Neu anmelden', `<span translate="no">${escapeHtml(account.user)}</span>`);
  if (pw != null) accountSetup(account.user, pw, 'login');
}

/** Fehlermeldung des Servers als kurzer Text */
const accountError = (e) =>
  ({
    401: 'Falscher Team-Code',
    unknown: 'Benutzername unbekannt',
    auth: 'Passwort falsch',
    taken: 'Benutzername schon vergeben',
    wait: 'Zu viele Versuche – in 10 Minuten wieder',
    size: 'Sicherung zu groß',
    token: 'Team-Eintrag gehört zu einem anderen Konto – dort anmelden',
    devices: 'Schon 3 Geräte angemeldet',
    pwchanged: 'Passwort geändert – neu anmelden',
    device: 'Gerät unbekannt – neu beitreten',
  })[e && (e.status === 401 ? 401 : e.message)] || (e && e.status ? 'Fehler auf dem Server' : 'Keine Verbindung');

/** Konto beim Team-Server anlegen bzw. prüfen und mit dem Team-Eintrag verbinden → { member, backups, sync }.
 *  Konto mit Abgleich: dieses Gerät wird eins seiner Geräte (Geräte-ID, Name); alle Plätze belegt → eins abmelden */
async function accountJoin(code, member, token) {
  let out;
  for (;;) {
    try {
      out = await accountRequest(
        'join',
        { mode: account.mode, member, token, name: teamFirstName(settings.name), fullname: settings.name.trim(), device: deviceInfo().id, deviceName: deviceKind() },
        code
      );
      break;
    } catch (e) {
      if (e.status !== 409 || e.message !== 'devices' || !(await accountFreeDevice((e.data && e.data.devices) || [], code))) throw e;
    }
  }
  account.ok = true;
  account.mode = 'login';
  account.error = '';
  account.sync = !!out.sync;
  delete account.pwchanged;
  delete account.left;
  accountDevs = null;
  accountSyncAt = 0;
  // Bestehendes Konto mit Sicherungen auf einem leeren iPhone: erst fragen, dann sichern.
  // Mit Abgleich nicht: das Gerät holt alles vom Server (abgleich.js)
  if (out.backups && out.backups.length && !account.at && !account.sync) account.restore = 'ask';
  if (account.sync) {
    account.restore = '';
    // erst abholen, dann senden (der gemerkte Stand kann von früher sein, z. B. Konto gelöscht und neu angelegt)
    syncState().at = 0;
    syncSave();
  }
  saveAccount();
  syncSoon(0);
  return out;
}

/** Schon im Team, Konto neu eingerichtet: verbinden (bisheriger Eintrag bleibt, bei bestehendem Konto gilt dessen).
 *  Hat der Server schon abgelehnt (Passwort falsch, Name vergeben …), nicht von selbst wiederholen – sonst sperrten
 *  die Fehlversuche das Konto auch für das richtige Passwort; neu anmelden auf der Konto-Seite */
async function accountLink() {
  if (!team || !account || account.ok || account.error || accountLink.busy) return;
  accountLink.busy = true;
  try {
    const out = await accountJoin(team.code, team.member, team.token);
    if (out.member !== team.member) {
      team.member = out.member;
      team.sent = '';
      saveTeam();
    }
    if (accountRestorePending()) accountOfferRestore(out.backups);
    else teamQueueUpload(0);
    // Lesen geht erst mit bestätigtem Konto
    teamLoad();
  } catch (e) {
    if (e.status === 401) leaveTeamLocal('Team-Code ungültig');
    else if (e.status) {
      // Name vergeben, Passwort falsch …: Konto bleibt unbestätigt, auf der Konto-Seite steht warum
      account.error = accountError(e);
      saveAccount();
    }
  } finally {
    accountLink.busy = false;
  }
  if (currentView === 'team') renderTeamBody();
  accountRerender();
}

/** Konto einrichten: neu anlegen oder anmelden. Im Team gleich beim Server, sonst beim Beitreten */
async function accountSetup(user, pw, mode, again) {
  user = accountUser(user);
  if (!user) return toast('Benutzername: mindestens 3 Zeichen, nur Buchstaben, Ziffern, . - _');
  // Neue Passwörter mindestens PW_MIN Zeichen (erschwert das Erraten); bestehende kürzere funktionieren beim Anmelden weiter
  if (pw.length < (mode === 'create' ? PW_MIN : 6)) return toast(`Passwort: mindestens ${mode === 'create' ? PW_MIN : 6} Zeichen`);
  // Ohne Team prüft kein Server das Passwort: zweimal eingeben, sonst verschlüsselte ein Tippfehler alle Sicherungen
  if ((mode === 'create' || !team) && again !== pw) return toast('Die beiden Passwörter sind verschieden.');
  toast('Wird eingerichtet …', 10000);
  const { auth, key, salt } = await accountDerive(user, pw);
  const prev = account;
  // Passwort auf einem anderen Gerät geändert: bisherigen Schlüssel behalten, bis alles neu verschlüsselt ist (abgleich.js).
  // Einen schon gemerkten nicht ersetzen – nach einem eigenen Wechsel (pwNext übernommen) ist cryptStore schon der neue
  if (prev && prev.user === user && prev.sync && cryptStore) {
    const st = syncState();
    if (st.kg && !st.oldKeys[st.kg]) st.oldKeys[st.kg] = cryptStore.key;
    syncSave();
  }
  account = { user, auth, mode, ok: false, restore: '', at: 0, hash: '', error: '' };
  if (team) {
    try {
      const out = await accountJoin(team.code, team.member, team.token);
      if (out.member !== team.member) {
        team.member = out.member;
        team.sent = '';
        saveTeam();
      }
    } catch (e) {
      account = prev;
      document.getElementById('toast').classList.remove('show');
      if (e.status === 401) leaveTeamLocal('Team-Code ungültig');
      else toast(accountError(e));
      return;
    }
  }
  saveAccount();
  // Ab jetzt verschlüsselt mit dem Schlüssel des Kontos (ersetzt den früheren Schalter „Sicherung verschlüsseln“)
  await rememberKey(key, salt);
  settings.encryptBackup = false;
  saveSettings();
  document.getElementById('toast').classList.remove('show');
  haptic();
  toast(mode === 'create' ? 'Konto erstellt' : 'Angemeldet');
  accountRerender();
  syncSoon(0);
  if (accountRestorePending()) accountOfferRestore();
  else if (team) {
    teamQueueUpload(0);
    accountBackup(true);
  }
}

/** Konto und Sicherungs-Schlüssel von diesem iPhone entfernen (Abmelden, Konto gelöscht) */
function accountForget() {
  account = null;
  accountDevs = null;
  saveAccount();
  cryptStore = null;
  try {
    localStorage.removeItem(CRYPT_KEY);
  } catch {}
  accountRerender();
}

function accountLogout() {
  confirmDialog('Abmelden?', 'Ohne Konto ist das Team gesperrt und Sicherungen sind nicht verschlüsselt.', 'Abmelden', () => {
    accountForget();
  }, true);
}

function accountDelete() {
  confirmDialog('Konto löschen?', 'Die Sicherungen auf dem Team-Server werden gelöscht.', 'Löschen', async () => {
    try {
      await accountRequest('delete', {}, team.code);
    } catch (e) {
      if (e.message !== 'unknown') return toast(accountError(e));
    }
    accountForget();
  }, true);
}

const ACCOUNT_PW_SYNC_MSG = 'Die anderen Geräte melden sich danach neu an.';
const ACCOUNT_PW_LEFT_MSG = 'Der Rest wird beim nächsten Abgleich neu verschlüsselt.';
/** Fortschritt beim Neu-Verschlüsseln */
const accountRekeyShow = (p) => toast(`Wird neu verschlüsselt … ${Math.round(p * 100)} %`, 30000);

/** Neues Passwort: alte Sicherungen auf dem Server werden gelöscht (sie ließen sich nicht mehr öffnen), gleich neu sichern.
 *  Mit Abgleich: vorher alles abgleichen, danach alle Datensätze neu verschlüsseln (abgleich.js syncRekey); die anderen
 *  Geräte melden sich neu an */
async function accountPassword() {
  // Eine laufende Sicherung mit dem alten Passwort würde abgelehnt und meldete das Konto ab
  if (accountBusy) return toast('Sicherung läuft gerade – gleich noch einmal versuchen');
  const old = await askPassword('Bisheriges Passwort', '');
  if (old == null) return;
  if ((await accountDerive(account.user, old)).auth !== account.auth) return toast('Passwort falsch');
  const pw = await askPassword('Neues Passwort', account.sync ? ACCOUNT_PW_SYNC_MSG : 'Ohne Passwort lässt sich keine Sicherung öffnen.', true);
  if (pw == null) return;
  const sync = account.sync;
  if (sync && !(await syncReady())) return;
  toast('Wird geändert …', 10000);
  const next = await accountDerive(account.user, pw);
  const salt = toB64(next.salt);
  const key = toB64(await crypto.subtle.exportKey('raw', next.key));
  if (sync) {
    // während des Wechsels nichts mit dem alten Passwort senden (der Server meldete sonst „pwchanged“)
    syncPaused = true;
    await syncIdle();
    const st = syncState();
    st.oldKeys[st.kg] = cryptStore.key;
    syncSave();
    account.pwNext = { auth: next.auth, key, salt };
    saveAccount();
  }
  let out;
  try {
    out = await accountRequest('password', { newAuth: next.auth }, team.code);
  } catch (e) {
    syncPaused = false;
    document.getElementById('toast').classList.remove('show');
    // abgelehnt: bleibt beim alten; keine Verbindung: ungewiss – die nächste Antwort des Servers entscheidet (pwNext)
    if (e.status && account.pwNext) {
      delete account.pwNext;
      saveAccount();
    }
    return toast(accountError(e));
  }
  account.pwNext = { auth: next.auth, key, salt };
  accountPwAdopt();
  let left = false;
  if (sync) {
    syncState().kg = out.kg;
    syncSave();
    syncPaused = false;
    // alles neu verschlüsseln (läuft im Abgleich; bricht es ab, geht es beim nächsten weiter)
    syncRekeyProgress = accountRekeyShow;
    accountRekeyShow(0);
    try {
      await syncRun();
      await syncIdle();
    } finally {
      syncRekeyProgress = null;
    }
    left = !!Object.keys(syncState().oldKeys).length;
  }
  // Der Server hat die alten Sicherungen gelöscht (mit dem neuen Passwort nicht zu öffnen): gleich die neue anlegen
  // (mit Abgleich gibt es keine)
  const saved = !left && (sync || (await accountBackup(true)));
  document.getElementById('toast').classList.remove('show');
  if (left) infoDialog('Passwort geändert', ACCOUNT_PW_LEFT_MSG);
  else if (saved) toast('Passwort geändert');
  else infoDialog('Passwort geändert', 'Die neue Sicherung hat nicht geklappt. Bitte gleich „Jetzt sichern“ tippen.');
  accountRerender();
}

// ───────── Sicherung auf dem Team-Server ─────────

let accountBusy = false;
/** Kurzer Fingerabdruck der Daten (ohne Zeitstempel der Sicherung), um unveränderte Stände nicht erneut zu senden */
function textHash(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + s.length.toString(36);
}
/** Ergebnis: true = hochgeladen */
async function accountBackup(force = false) {
  if (!team || !accountOk() || accountRestorePending() || accountBusy || !navigator.onLine) return false;
  if (!cryptStore) {
    // Schlüssel nicht gespeichert (Speicher voll beim Anmelden): ohne ihn keine Sicherung – sichtbar machen statt still
    if (!account.error) {
      account.error = 'Schlüssel fehlt – abmelden und neu anmelden';
      saveAccount();
    }
    return false;
  }
  // Abgleich: der Server hat alles je Datensatz und frühere Fassungen 30 Tage („Stand vom …“) – keine Sicherung mehr
  if (account.sync) return false;
  // erst die Zeit prüfen: die Sicherung zusammenzustellen kostet bei vielen Bildern spürbar
  if (!force && Date.now() - (account.at || 0) < ACCOUNT_BACKUP_GAP) return false;
  const plain = backupJson();
  const hash = textHash(plain.replace(/"exportedAt":"[^"]*",/, ''));
  if (!force && hash === account.hash) return false;
  let done = false;
  accountBusy = true;
  try {
    const data = await sealBackup(plain);
    // nie unverschlüsselt senden (der Server nimmt es auch nicht an)
    if (!data.startsWith('{"app":"std-protokoll","enc"')) throw new Error('plain');
    const sentAuth = account.auth;
    const res = await fetch(TEAM_URL + '/backup', {
      method: 'PUT',
      headers: { 'X-Team-Code': team.code, 'X-User': encodeURIComponent(account.user), 'X-Auth': account.auth, 'X-Token': team.token, 'Content-Type': 'text/plain;charset=utf-8' },
      body: data,
      cache: 'no-store',
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) window.serverFehler?.('PUT', '/backup', res.status, out.error);
    if (!res.ok) teamAccessError(res.status, out.error, sentAuth);
    if (!res.ok) throw Object.assign(new Error(out.error || 'fehler'), { status: res.status });
    if (account) Object.assign(account, { at: out.at || Date.now(), hash, error: '' });
    done = true;
  } catch (e) {
    if (!account) return false;
    account.error = accountError(e);
    // Passwort anderswo geändert oder Konto gelöscht: neu anmelden
    if (e.message === 'auth' || e.message === 'unknown') account.ok = false;
  } finally {
    accountBusy = false;
    saveAccount();
  }
  const el = document.getElementById('account-status');
  if (el) el.textContent = accountStatusText();
  return done;
}
setInterval(() => accountBackup(), 10 * 60e3);
document.addEventListener('visibilitychange', () => {
  accountBackup();
  if (document.visibilityState === 'visible') accountSyncCheck();
});

const accountStatusText = () => {
  if (!team) return 'Im Team wird automatisch auf dem Team-Server gesichert.';
  if (account.sync) {
    // Sicherung gibt es mit Abgleich nicht: sagen, ob noch etwas nur auf diesem Gerät liegt
    const st = syncState();
    const open = st.conflicts.length || st.held.length || st.hold > SYNC_F || (syncStarted && syncUnsent());
    const when = open ? 'Noch nicht alles gesendet' : st.at ? `Abgeglichen: ${accountWhen(st.at)}` : 'Noch nicht abgeglichen';
    return account.error && account.ok ? `${when} · ${account.error}` : when;
  }
  const at = account.at ? new Date(account.at) : null;
  const when = at ? `Auf dem Team-Server gesichert: ${sameDay(at, new Date()) ? 'heute' : fmtDayMonth(at)} ${fmtTime(at.getHours() * 60 + at.getMinutes())}` : 'Noch nicht auf dem Team-Server gesichert';
  // nicht angemeldet: der Grund steht schon unter „Status“
  return account.error && account.ok ? `${when} · ${account.error}` : when;
};

// ───────── Arbeitsscheine vom Team-Server ─────────
// Eine Arbeitsschein-App schickt Scheine (Format „arbeitsschein/1“) an den Worker; jeder Mitarbeiter auf dem Schein
// bekommt ihn. Hier: abholen (im Team mit Konto) und in die Form bringen, die auch die .odt-Scheine haben.

const hmMin = (s) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};
/** Schein vom Server → je Einsatz ein Eintrag wie aus der .odt (id wie dort: Nummer, bei mehreren Tagen Nummer#n) */
function serverReportItems(r, names) {
  const ra = r.rechnungsadresse || {};
  const pr = r.projekt || {};
  const blocks = (r.arbeiten || []).map((t) => String(t).trim()).filter(Boolean);
  const created = /^(\d{4})-(\d{2})-(\d{2})$/.exec(r.erstellt || '');
  const staffName = (m) => (m.name || '').trim() || names[accountUser(m.benutzer)] || m.benutzer || '';
  return r.einsaetze.map((e, i) => {
    const start = hmMin(e.beginn);
    const end = hmMin(e.ende);
    const pause = e.pause_min || 0;
    return {
      v: 2,
      id: r.einsaetze.length > 1 ? `${r.nummer}#${i + 1}` : r.nummer,
      no: r.nummer,
      src: r.id,
      created: created ? `${created[3]}.${created[2]}.${created[1]}` : '',
      billName: (ra.name || '').trim(),
      email: (pr.email || '').trim(),
      date: e.datum,
      customer: (pr.name || ra.name || '').trim(),
      street: (ra.strasse || '').trim(),
      zip: (ra.plz || '').trim(),
      city: (ra.ort || '').trim(),
      start,
      end,
      pause,
      travel: e.fahrzeit_min ?? null,
      km: e.km != null ? String(e.km).replace('.', ',') : '',
      worked: e.arbeitszeit_min ?? (start != null && end != null ? (end >= start ? end - start : end + 1440 - start) - pause : null),
      staff: (e.mitarbeiter || []).map(staffName).filter(Boolean),
      work: blocks.join(' ').replace(/\s+/g, ' '),
      workLines: blocks,
      flat: (r.pauschalen || []).map((p) => ({ name: (p.bezeichnung || '').trim(), qty: (p.anzahl || '').trim(), note: (p.bemerkung || '').trim() })),
      material: (r.material || []).map((m) => ({ name: (m.bezeichnung || '').trim(), qty: (m.anzahl || '').trim(), unit: (m.einheit || '').trim() })),
    };
  });
}

/** Neue, geänderte und zurückgezogene Scheine holen; Ergebnis: Zahl neuer Einträge */
async function accountFetchReports() {
  if (!team || !accountOk() || accountFetchReports.busy || !navigator.onLine) return 0;
  accountFetchReports.busy = true;
  let n = 0;
  try {
    // voller Name: daran erkennt der Server dich auf den Arbeitsscheinen
    const out = await accountRequest('reports', { since: reportStore.serverSince || 0, fullname: settings.name.trim() }, team.code);
    for (const row of out.reports || []) {
      // ersetzt: alle Einträge dieses Scheins (Zahl der Einsätze kann sich geändert haben)
      reportStore.items = reportStore.items.filter((x) => x.src !== row.id);
      if (!row.deleted) {
        try {
          n += addReports(serverReportItems(JSON.parse(row.data), out.names || {}), true);
        } catch {
          // unbekanntes Format – übergehen
        }
      }
      reportStore.serverSince = Math.max(reportStore.serverSince || 0, row.changed || 0);
    }
    saveReports();
  } catch {
    // beim nächsten Mal
  } finally {
    accountFetchReports.busy = false;
  }
  return n;
}

// ───────── Einlesen vom Team-Server ─────────

const accountWhen = (t) => {
  const d = new Date(t);
  return `${sameDay(d, new Date()) ? 'heute' : fmtDayMonth(d)}, ${fmtTime(d.getHours() * 60 + d.getMinutes())} Uhr`;
};

/** Frage „Sicherung einlesen?“ noch offen (App vorher geschlossen, keine Verbindung): beim Start erneut stellen –
 *  bis zur Antwort wird nichts hochgeladen */
function accountResumeRestore() {
  // mit Abgleich kommt alles vom Server
  if (account && account.sync && account.restore === 'ask') {
    account.restore = '';
    saveAccount();
  }
  if (team && accountOk() && accountRestorePending()) accountOfferRestore();
}

/** Größe einer Sicherung kurz: „0,4 MB“ (ein auffällig kleiner Stand ist meist leer) */
const accountSize = (b) => `${(b.size / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1, minimumFractionDigits: 1 })} MB`;

/** Nach dem Anmelden auf einem leeren iPhone: Sicherungen zur Auswahl (neueste zuerst). Nicht beantwortet (daneben
 *  getippt, App geschlossen) → beim nächsten Start wieder */
async function accountOfferRestore(backups) {
  if (!backups) {
    try {
      backups = (await accountRequest('list', {}, team.code)).backups || [];
    } catch {
      return; // keine Verbindung: beim nächsten Start (accountResumeRestore)
    }
  }
  if (!backups.length) {
    account.restore = '';
    saveAccount();
    return;
  }
  const modal = openModal(
    `<div class="alert-body"><b>Sicherung einlesen?</b></div>
    <div class="alert-buttons stacked acc-pick">${backups
      .map((b, i) => `<button data-at="${b.at}" class="${i ? '' : 'strong'}">${accountWhen(b.at)} · ${accountSize(b)}</button>`)
      .join('')}<button data-at="">Nicht einlesen</button></div>`,
    'alert'
  );
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-at]');
    if (!b) return;
    closeModal();
    if (b.dataset.at) return accountRestore(Number(b.dataset.at));
    account.restore = '';
    saveAccount();
    teamQueueUpload(0);
  });
}

async function accountRestore(at) {
  toast('Wird geladen …', 10000);
  let data;
  try {
    data = (await accountRequest('get', { at }, team.code)).data;
  } catch (e) {
    document.getElementById('toast').classList.remove('show');
    return toast(accountError(e));
  }
  const d = new Date(at);
  const file = new File([data], `Team-Server ${isoDate(d)} ${pad(d.getHours())}-${pad(d.getMinutes())}.json`, { type: 'application/json' });
  // Erst nach erfolgreichem Einlesen wieder hochladen – sonst landete ein leerer Stand als neueste Sicherung auf dem Server
  if (!(await importBackup({ files: [file], value: '' }))) return accountRerender();
  account.restore = '';
  saveAccount();
  teamQueueUpload(0);
  accountBackup(true);
  accountRerender();
}

/** Alle Sicherungen auf dem Server zur Auswahl (neueste und je Tag eine) */
async function accountPickRestore() {
  let backups;
  try {
    backups = (await accountRequest('list', {}, team.code)).backups || [];
  } catch (e) {
    return toast(accountError(e));
  }
  if (!backups.length) return toast('Noch keine Sicherung auf dem Team-Server');
  const modal = openModal(
    `<div class="alert-body"><b>Sicherung einlesen</b></div>
    <div class="alert-buttons stacked acc-pick">${backups
      .map((b) => `<button data-at="${b.at}">${accountWhen(b.at)} · ${accountSize(b)}</button>`)
      .join('')}<button data-at="">Abbrechen</button></div>`,
    'alert'
  );
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-at]');
    if (!b) return;
    closeModal();
    if (b.dataset.at) accountRestore(Number(b.dataset.at));
  });
}

// ───────── Einstellungen → Konto ─────────

/** Ohne Konto: Anmelden (Vorgabe) oder – über den Link darunter – neues Konto mit wiederholtem Passwort */
let kontoCreate = false;
function kontoPageHTML() {
  if (!account) {
    const pwAttrs = `type="password" placeholder="Passwort" autocomplete="${kontoCreate ? 'new-password' : 'current-password'}"`;
    return `
    <form data-acc-form>
      <div class="card form">
        <label class="field"><span>Benutzername</span><input name="user" data-acc="user" placeholder="z. B. max.muster" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false" enterkeyhint="next"></label>
        <label class="field"><span>Passwort</span><input name="pw" data-acc="pw" ${pwAttrs} enterkeyhint="${kontoCreate || !team ? 'next' : 'go'}"></label>
        ${kontoCreate || !team ? `<label class="field"><span>Wiederholen</span><input name="pw2" data-acc="pw2" ${pwAttrs} enterkeyhint="go"></label>` : ''}
      </div>
      <button type="submit" class="primary tm-join-btn acc-submit">${kontoCreate ? 'Konto erstellen' : 'Anmelden'}</button>
    </form>
    <div class="center acc-switch"><button class="link-btn" data-acc="switch">${kontoCreate ? 'Schon ein Konto? Anmelden' : 'Noch kein Konto? Konto erstellen'}</button></div>
    <p class="footnote center">Fürs Team nötig, Sicherungen werden damit verschlüsselt.</p>`;
  }
  const ok = accountOk();
  // Geräte-Liste (nur mit Abgleich) frisch holen
  if (team && ok) setTimeout(() => accountSyncCheck(true));
  return `
    <div class="card form">
      <div class="field"><span>Benutzername</span><span class="muted" translate="no">${escapeHtml(account.user)}</span></div>
      <div class="field"><span>Status</span><span class="muted" ${ok ? '' : 'style="color: var(--warning)"'}>${ok ? 'Angemeldet' : account.error || 'Wird beim Beitreten ins Team geprüft'}</span></div>
    </div>
    ${team && !ok && account.error ? '<div class="card list"><button class="list-btn" data-acc="relogin">Neu anmelden …</button></div>' : ''}
    ${team && ok && account.sync && accountDevs ? accountDevicesHTML() : ''}
    ${
      team && ok
        ? `<div class="card list">
      ${
        // Abgleich: keine Sicherungen mehr, frühere Stände über „Stand vom …“
        account.sync
          ? '<button class="list-btn" data-acc="state">Stand vom … wiederherstellen</button>'
          : `<button class="list-btn" data-acc="restore">Sicherung vom Team-Server einlesen …</button>
      <button class="list-btn" data-acc="backup">Jetzt sichern</button>`
      }
    </div>
    <p class="footnote" id="account-status">${accountStatusText()}</p>`
        : `<p class="footnote" id="account-status">${accountStatusText()}</p>`
    }
    <div class="card list">
      ${team && ok ? '<button class="list-btn" data-acc="password">Passwort ändern …</button>' : ''}
      <button class="list-btn destructive" data-acc="logout">Abmelden</button>
      ${team && ok ? '<button class="list-btn destructive" data-acc="delete">Konto löschen</button>' : ''}
    </div>`;
}

function accountRerender() {
  if (currentView !== 'settings' && currentView !== 'settingsSub') return;
  const y = window.scrollY;
  renderSettings();
  window.scrollTo(0, y);
}

document.addEventListener('click', (e) => {
  const el = e.target.closest('button[data-acc]');
  if (!el || layer.contains(el)) return;
  switch (el.dataset.acc) {
    case 'switch': {
      // Eingaben behalten, nur die Art wechseln
      const f = document.querySelector('[data-acc-form]');
      const user = f.querySelector('[data-acc="user"]').value;
      const pw = f.querySelector('[data-acc="pw"]').value;
      kontoCreate = !kontoCreate;
      accountRerender();
      document.querySelector('[data-acc="user"]').value = user;
      document.querySelector('[data-acc="pw"]').value = pw;
      break;
    }
    case 'logout':
      accountLogout();
      break;
    case 'delete':
      accountDelete();
      break;
    case 'password':
      accountPassword();
      break;
    case 'relogin':
      accountRelogin();
      break;
    case 'device':
      accountDeviceMenu(el.dataset.dev);
      break;
    case 'restore':
      accountPickRestore();
      break;
    case 'state':
      syncRestorePick();
      break;
    case 'backup':
      toast('Sichern …');
      accountBackup(true).then((ok) => toast(ok ? 'Gesichert' : (account && account.error) || 'Nicht gesichert'));
      break;
  }
});
// Knopf oder Return im letzten Feld (ein echtes Formular, damit das iPhone das Passwort speichern kann)
document.addEventListener('submit', (e) => {
  if (!e.target.matches('[data-acc-form]')) return;
  e.preventDefault();
  const f = e.target;
  const val = (k) => (f.querySelector(`[data-acc="${k}"]`) || {}).value || '';
  accountSetup(val('user'), val('pw'), kontoCreate ? 'create' : 'login', val('pw2'));
});
