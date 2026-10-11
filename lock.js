// Yetizettel – Sperre mit Face ID (Passkey/WebAuthn)
// Die App zeigt beim Start und nach mehr als LOCK_AFTER im Hintergrund einen Sperrbildschirm; „Entsperren“ startet
// Face ID (oder den iPhone-Code). Es ist eine Sperre vor der App, keine Verschlüsselung. Einstellung und Passkey-ID
// liegen nur auf diesem iPhone (yetizettel.lock.v1), nicht in der Sicherung.

const LOCK_KEY = 'yetizettel.lock.v1';
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

/** Neuen Passkey anlegen; Face ID bzw. iPhone-Code bestätigt dabei, dass du es bist */
async function createLockKey() {
  const cred = await navigator.credentials.create({
    publicKey: {
      rp: { name: 'Yetizettel', id: location.hostname },
      user: { id: rand(16), name: 'Yetizettel', displayName: 'Yetizettel' },
      challenge: rand(32),
      pubKeyCredParams: [
        { type: 'public-key', alg: -7 },
        { type: 'public-key', alg: -257 },
      ],
      authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'preferred' },
      timeout: 60000,
    },
  });
  lockStore = { id: b64u(cred.rawId) };
  saveLock();
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
  document.body.insertAdjacentHTML(
    'beforeend',
    `<div id="lock" role="dialog" aria-modal="true">
      <img src="icons/apple-touch-icon.png" alt="" class="lock-icon">
      <b>Yetizettel ist gesperrt</b>
      <button class="lock-btn" data-lock="open">Entsperren</button>
      <p class="lock-msg" id="lock-msg"></p>
      <button class="lock-renew" data-lock="renew" hidden>Sperre neu einrichten</button>
    </div>`
  );
}
function hideLock() {
  document.getElementById('lock')?.remove();
  document.documentElement.classList.remove('locked');
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-lock]');
  if (!b) return;
  const msg = document.getElementById('lock-msg');
  try {
    if (b.dataset.lock === 'renew') await createLockKey();
    else await verifyLock();
    hideLock();
  } catch (err) {
    if (err && err.name === 'AbortError') return; // durch einen neuen Tipp ersetzt
    // Abgebrochen oder Passkey gelöscht: noch einmal versuchen oder neu einrichten (fragt ebenfalls Face ID/Code)
    msg.textContent = 'Nicht entsperrt.';
    document.querySelector('[data-lock="renew"]').hidden = false;
  }
});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') hiddenAt = Date.now();
  else if (hiddenAt && Date.now() - hiddenAt > LOCK_AFTER) showLock();
});

/** Schalter in den Einstellungen */
async function toggleLock(input, rerender) {
  if (!input.checked) {
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
