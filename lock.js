// Std-Protokoll – Sperre mit Face ID (Passkey/WebAuthn)
// Die App zeigt beim Start und nach mehr als LOCK_AFTER im Hintergrund einen Sperrbildschirm; „Entsperren“ startet
// Face ID (oder den iPhone-Code). Es ist eine Sperre vor der App, keine Verschlüsselung. Einstellung und Passkey-ID
// liegen nur auf diesem iPhone (stdprotokoll.lock.v1), nicht in der Sicherung.

const LOCK_KEY = 'stdprotokoll.lock.v1';
const LOCK_AFTER = 5 * 60e3;
let lockStore = (() => {
  try {
    return JSON.parse(localStorage.getItem(LOCK_KEY) || 'null');
  } catch {
    return null;
  }
})(); // { id: Base64 der Passkey-ID }
let hiddenAt = 0;

const lockOn = () => !!(lockStore && lockStore.id);
// index.html verbirgt den Inhalt schon beim Laden, sobald es einen Eintrag gibt – ohne gültige Sperre wieder zeigen
if (!lockOn()) document.documentElement.classList.remove('locked');

const lockAvailable = () => !!(window.PublicKeyCredential && navigator.credentials);
function saveLock() {
  try {
    if (lockStore) localStorage.setItem(LOCK_KEY, JSON.stringify(lockStore));
    else localStorage.removeItem(LOCK_KEY);
  } catch {}
}
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s) => Uint8Array.from(atob(s), (ch) => ch.charCodeAt(0));

/** Nicht mehr benutzten Passkey aus den Passwörtern entfernen lassen (iOS 26; ältere Versionen ignorieren es still) */
function forgetLockKey(id) {
  if (!id || !window.PublicKeyCredential?.signalUnknownCredential) return;
  const credentialId = id.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); // Base64url
  PublicKeyCredential.signalUnknownCredential({ rpId: location.hostname, credentialId }).catch(() => {});
}

/** Neuen Passkey anlegen; Face ID bzw. iPhone-Code bestätigt dabei, dass du es bist */
async function createLockKey() {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Std-Protokoll', id: location.hostname },
      user: { id: rand(16), name: 'Std-Protokoll', displayName: 'Std-Protokoll' },
      challenge: rand(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
    },
  });
  const old = lockStore?.id;
  lockStore = { id: b64u(cred.rawId) };
  saveLock();
  forgetLockKey(old); // „Neu einrichten“ auf dem Sperrbildschirm ersetzt den alten
}

/** Face ID abfragen; true, wenn bestätigt. Eine noch offene Abfrage wird abgebrochen (sonst hängt ein neuer Tipp). */
let lockAbort = null;
async function verifyLock() {
  lockAbort?.abort();
  lockAbort = new AbortController();
  const res = await navigator.credentials.get({
    signal: lockAbort.signal,
    publicKey: {
      challenge: rand(32),
      allowCredentials: [{ type: 'public-key', id: unb64(lockStore.id) }],
      userVerification: 'required',
      timeout: 60000,
    },
  });
  return !!res;
}

function showLock() {
  if (!lockOn() || document.getElementById('lock')) return;
  document.documentElement.classList.add('locked');
  // Farbe hinter Uhrzeit/Akku (iOS blendet dort mit theme-color ein) passend zum dunkelblauen Sperrbildschirm
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#0b1d4a');
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="lock" role="dialog" aria-modal="true"><div class="lock-bg"></div>
      <img src="icons/icon-512.png?v=2" alt="" class="lock-icon">
      <b class="lock-title">Std-Protokoll ist gesperrt</b>
      <span class="lock-sub">Mit Face ID entsperren</span>
      <button class="lock-btn" data-lock="open"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9.5v1M15 9.5v1M12 9.5v3.5h-1M9.5 15.5c1.4 1.2 3.6 1.2 5 0"/></svg>Entsperren</button>
      <p class="lock-msg" id="lock-msg"></p>
      <button class="lock-renew" data-lock="renew" hidden>Sperre neu einrichten</button>
    </div>`
  );  // Face ID gleich anfragen: iOS zeigt dann „Passkey verwenden“ – ein Tipp genügt. Bricht man ab, bleibt „Entsperren“.
  setTimeout(() => verifyLock().then(hideLock, lockFailed), 300);
}
function lockFailed(err) {
  if (err && err.name === 'AbortError') return; // durch einen neuen Tipp ersetzt
  const msg = document.getElementById('lock-msg');
  if (msg) msg.textContent = 'Nicht entsperrt.';
  const renew = document.querySelector('[data-lock="renew"]');
  if (renew) renew.hidden = false;
}
function hideLock() {
  document.getElementById('lock')?.remove();
  document.documentElement.classList.remove('locked');
  if (typeof applyTheme === 'function') applyTheme();
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-lock]');
  if (!b) return;
  try {
    if (b.dataset.lock === 'renew') await createLockKey();
    else await verifyLock();
    hideLock();
  } catch (err) {
    // Abgebrochen oder Passkey gelöscht: noch einmal versuchen oder neu einrichten (fragt ebenfalls Face ID/Code)
    lockFailed(err);
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER) showLock();
});

/** Schalter in den Einstellungen */
async function toggleLock(input, rerender) {
  if (!input.checked) {
    forgetLockKey(lockStore?.id);
    lockStore = null;
    saveLock();
    rerender();
    return;
  }
  input.checked = false;
  try {
    await createLockKey();
    toast('Face ID eingerichtet');
  } catch {
    infoDialog('Face ID nicht eingerichtet', 'Bitte noch einmal versuchen.');
  }
  rerender();
}
