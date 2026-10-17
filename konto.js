// Std-Protokoll – Konto: Benutzername + Passwort. Für das Team Pflicht, sonst freiwillig.
// Mit Konto sind alle Sicherungen verschlüsselt (Datei, Team-Server). Aus dem Passwort entstehen auf dem
// iPhone zwei Schlüssel: auth (der Server speichert davon nur einen Prüfwert) und der Sicherungs-Schlüssel (bleibt auf
// dem iPhone, liegt wie bisher in stdprotokoll.crypt.v1). Beide hängen nur von Benutzername und Passwort ab – nach einem
// Datenverlust reicht erneutes Anmelden, um die Sicherungen vom Team-Server wieder zu öffnen.
//
// Eigener Speicher (nicht in der Sicherung): { user, auth, mode, ok, restore, at, hash, error }
// mode: 'create' (neues Konto) | 'login' (bestehendes); ok: vom Server bestätigt; restore: 'ask' = Sicherung auf dem
// Server, Frage nach dem Einlesen noch offen (bis dahin wird nichts hochgeladen, sonst überschriebe ein leerer Stand sie)

const ACCOUNT_KEY = 'stdprotokoll.account.v1';
/** Sicherung auf dem Team-Server: nach Änderungen höchstens einmal je Stunde */
const ACCOUNT_BACKUP_GAP = 3600e3;

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
const accountRestorePending = () => !!(account && account.restore === 'ask');
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

const accountRequest = (action, extra = {}, code) => teamRequest('POST', '/account', { action, user: account.user, auth: account.auth, ...extra }, code);

/** Fehlermeldung des Servers als kurzer Text */
const accountError = (e) =>
  ({
    401: 'Falscher Team-Code',
    unknown: 'Benutzername unbekannt',
    auth: 'Passwort falsch',
    taken: 'Benutzername schon vergeben',
    wait: 'Zu viele Versuche – in 10 Minuten wieder',
    size: 'Sicherung zu groß',
  })[e && (e.status === 401 ? 401 : e.message)] || (e && e.status ? 'Fehler auf dem Server' : 'Keine Verbindung');

/** Konto beim Team-Server anlegen bzw. prüfen und mit dem Team-Eintrag verbinden → { member, backups } */
async function accountJoin(code, member, token) {
  const out = await accountRequest('join', { mode: account.mode, member, token, name: teamFirstName(settings.name), fullname: settings.name.trim() }, code);
  account.ok = true;
  account.mode = 'login';
  account.error = '';
  // Bestehendes Konto mit Sicherungen auf einem leeren iPhone: erst fragen, dann sichern
  if (out.backups && out.backups.length && !account.at) account.restore = 'ask';
  saveAccount();
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
  if (pw.length < 6) return toast('Passwort: mindestens 6 Zeichen');
  if (mode === 'create' && again !== pw) return toast('Die beiden Passwörter sind verschieden.');
  toast('Wird eingerichtet …', 10000);
  const { auth, key, salt } = await accountDerive(user, pw);
  const prev = account;
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
  if (accountRestorePending()) accountOfferRestore();
  else if (team) {
    teamQueueUpload(0);
    accountBackup(true);
  }
}

/** Konto und Sicherungs-Schlüssel von diesem iPhone entfernen (Abmelden, Konto gelöscht) */
function accountForget() {
  account = null;
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

/** Neues Passwort: alte Sicherungen auf dem Server werden gelöscht (sie ließen sich nicht mehr öffnen), gleich neu sichern */
async function accountPassword() {
  const old = await askPassword('Bisheriges Passwort', '');
  if (old == null) return;
  if ((await accountDerive(account.user, old)).auth !== account.auth) return toast('Passwort falsch');
  const pw = await askPassword('Neues Passwort', 'Ohne Passwort lässt sich keine Sicherung öffnen.', true);
  if (pw == null) return;
  toast('Wird geändert …', 10000);
  const next = await accountDerive(account.user, pw);
  try {
    await accountRequest('password', { newAuth: next.auth }, team.code);
  } catch (e) {
    document.getElementById('toast').classList.remove('show');
    return toast(accountError(e));
  }
  account.auth = next.auth;
  account.at = 0;
  account.hash = '';
  saveAccount();
  await rememberKey(next.key, next.salt);
  document.getElementById('toast').classList.remove('show');
  toast('Passwort geändert');
  accountBackup(true);
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
  if (!team || !accountOk() || accountRestorePending() || accountBusy || !cryptStore || !navigator.onLine) return false;
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
    const res = await fetch(TEAM_URL + '/backup', {
      method: 'PUT',
      headers: { 'X-Team-Code': team.code, 'X-User': encodeURIComponent(account.user), 'X-Auth': account.auth, 'Content-Type': 'text/plain;charset=utf-8' },
      body: data,
      cache: 'no-store',
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok) window.serverFehler?.('PUT', '/backup', res.status, out.error);
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
document.addEventListener('visibilitychange', () => accountBackup());

const accountStatusText = () => {
  if (!team) return 'Im Team wird automatisch auf dem Team-Server gesichert.';
  const at = account.at ? new Date(account.at) : null;
  const when = at ? `Auf dem Team-Server gesichert: ${sameDay(at, new Date()) ? 'heute' : fmtDayMonth(at)} ${fmtTime(at.getHours() * 60 + at.getMinutes())}` : 'Noch nicht auf dem Team-Server gesichert';
  return account.error ? `${when} · ${account.error}` : when;
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
          n += addReports(serverReportItems(JSON.parse(row.data), out.names || {}));
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

/** Nach dem Anmelden auf einem leeren iPhone: neueste Sicherung anbieten */
async function accountOfferRestore(backups) {
  if (!backups) {
    try {
      backups = (await accountRequest('list', {}, team.code)).backups || [];
    } catch {
      return;
    }
  }
  if (!backups.length) {
    account.restore = '';
    saveAccount();
    return;
  }
  confirmDialog(
    'Sicherung einlesen?',
    `Stand: ${accountWhen(backups[0].at)}`,
    'Einlesen',
    () => accountRestore(backups[0].at),
    false,
    'Nicht einlesen',
    () => {
      account.restore = '';
      saveAccount();
      teamQueueUpload(0);
    }
  );
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
  account.restore = '';
  saveAccount();
  const d = new Date(at);
  const file = new File([data], `Team-Server ${isoDate(d)} ${pad(d.getHours())}-${pad(d.getMinutes())}.json`, { type: 'application/json' });
  await importBackup({ files: [file], value: '' });
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
    <div class="alert-buttons acc-pick">${backups
      .map((b) => `<button data-at="${b.at}">${accountWhen(b.at)} · ${(b.size / 1024 / 1024).toLocaleString('de-DE', { maximumFractionDigits: 1 })} MB</button>`)
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
        <label class="field"><span>Passwort</span><input name="pw" data-acc="pw" ${pwAttrs} enterkeyhint="${kontoCreate ? 'next' : 'go'}"></label>
        ${kontoCreate ? `<label class="field"><span>Wiederholen</span><input name="pw2" data-acc="pw2" ${pwAttrs} enterkeyhint="go"></label>` : ''}
      </div>
      <button type="submit" class="primary tm-join-btn acc-submit">${kontoCreate ? 'Konto erstellen' : 'Anmelden'}</button>
    </form>
    <div class="center acc-switch"><button class="link-btn" data-acc="switch">${kontoCreate ? 'Schon ein Konto? Anmelden' : 'Noch kein Konto? Konto erstellen'}</button></div>
    <p class="footnote center">Fürs Team nötig, Sicherungen werden damit verschlüsselt.</p>`;
  }
  const ok = accountOk();
  return `
    <div class="card form">
      <div class="field"><span>Benutzername</span><span class="muted" translate="no">${escapeHtml(account.user)}</span></div>
      <div class="field"><span>Status</span><span class="muted" ${ok ? '' : 'style="color: var(--warning)"'}>${ok ? 'Angemeldet' : account.error || 'Wird beim Beitreten ins Team geprüft'}</span></div>
    </div>
    ${
      team && ok
        ? `<div class="card list">
      <button class="list-btn" data-acc="restore">Sicherung vom Team-Server einlesen …</button>
      <button class="list-btn" data-acc="backup">Jetzt sichern</button>
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
    case 'restore':
      accountPickRestore();
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
