// Arena: Live-Kampf in 3D für das Team (Knopf auf der Team-Seite neben dem Teammeeting).
// Das Spiel selbst (arena/arena.js mit Three.js und Figur) lädt erst beim Öffnen.

let arenaStop = null;
let arenaEl = null;

/** Symbol für den Knopf (zwei gekreuzte Hämmer) */
const arenaIcon = () => svg('<path d="M4 20l8.5-8.5M20 20l-8.5-8.5"/><path d="M5.5 5.5l3-1.5 3 3-1.5 3zM18.5 5.5l-3-1.5-3 3 1.5 3z"/>', 22);

function arenaRoute(hash) {
  if (hash !== '#/arena') return false;
  // nur im Team mit Konto
  if (!team || !accountOk()) {
    location.replace('#/team');
    return true;
  }
  currentView = 'arena';
  app.innerHTML = '';
  arenaOpen();
  return true;
}

function arenaOpen() {
  if (arenaEl) return;
  arenaEl = document.createElement('div');
  arenaEl.className = 'arena';
  document.body.appendChild(arenaEl);
  document.body.classList.add('arena-on');
  const el = arenaEl;
  import('./arena/arena.js')
    .then((mod) =>
      mod.start(el, {
        ticket: async () => {
          const r = await teamRequest('POST', '/arena', { name: teamFirstName(settings.name) || account.user });
          return TEAM_URL.replace(/^http/, 'ws') + '/arena/ws?t=' + encodeURIComponent(r.ticket);
        },
        exit: () => history.back(),
        retry: () => {
          arenaClose();
          arenaOpen();
        },
      })
    )
    .then((stop) => {
      if (arenaEl === el) arenaStop = stop;
      else stop();
    })
    .catch((e) => {
      window.fehlerMelden?.(e, 'arena');
      // Modul selbst nicht geladen (offline): Meldung mit Schließen
      if (arenaEl === el && !el.querySelector('.ar-msg.on')) {
        el.innerHTML = '<div class="ar-msg on"><span>Laden fehlgeschlagen</span><button class="ar-retry">Schließen</button></div>';
        el.querySelector('.ar-retry').onclick = () => history.back();
      }
    });
}

function arenaClose() {
  if (!arenaEl) return;
  arenaStop?.();
  arenaStop = null;
  arenaEl.remove();
  arenaEl = null;
  document.body.classList.remove('arena-on');
}
