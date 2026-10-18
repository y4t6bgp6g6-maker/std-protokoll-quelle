// Std-Protokoll – Ansicht auf dem iPad (Stile: ipad.css). Auf dem iPhone und dem Mac tut diese Datei nichts.
// Quer (breit genug): Seitenleiste links mit den Bereichen und der Zettel-Liste statt der Leiste unten, Plus oben rechts;
// „Zettel“ öffnet gleich den neuesten Zettel (die Liste steht ja links).
// Hoch: Leiste oben in der Mitte, Plus oben rechts; im Zettel blendet der Knopf oben links die Zettel-Liste ein.
// Im Zettel stehen die Tage nebeneinander, wenn zwei Spalten Platz haben. Schmales Fenster (Split View): wie auf dem iPhone.

const IPAD_MIN_W = 700;
const ipadOn = () => deviceKind() === 'iPad' && innerWidth >= IPAD_MIN_W;
const ipadQuer = () => ipadOn() && innerWidth > innerHeight && innerWidth >= 1000;
const IPAD_SIDE_ICON = svg('<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M9 4v16"/>', 22);

document.body.insertAdjacentHTML(
  'beforeend',
  `<aside id="ipad-side">
    <div class="ipad-side-title">Std-Protokoll</div>
    <nav class="ipad-side-nav">${TABS.filter(Boolean)
      .map((t) => `<button class="ipad-side-row" data-ipad-tab="${t[0]}">${ICON[t[2]]}<span>${t[1]}</span></button>`)
      .join('')}</nav>
    <div class="ipad-side-sep"></div>
    <div class="ipad-side-list"></div>
  </aside>
  <div id="ipad-scrim"></div>
  <div id="ipad-top"><nav class="ipad-tabs">${TABS.filter(Boolean)
    .map((t) => `<button class="ipad-tab" data-ipad-tab="${t[0]}">${ICON[t[2]]}<span>${t[1]}</span></button>`)
    .join('')}</nav></div>
  <button id="ipad-plus" data-act="new" aria-label="Neuer Stundenzettel">${ICON.tabAdd}</button>`
);
const ipadSide = document.getElementById('ipad-side');
const ipadList = ipadSide.querySelector('.ipad-side-list');

/** Zettel-Liste (bzw. Hefte) wie auf der Seite „Zettel“, offener Zettel hervorgehoben */
function ipadListHTML() {
  return bhSwitchHTML() + (bhMode() === 'heft' ? heftListHTML() : listBodyHTML());
}
function ipadRenderList(show) {
  const html = show ? ipadListHTML() : '';
  if (ipadList.innerHTML !== html) ipadList.innerHTML = html;
  ipadList.querySelectorAll('.sel').forEach((x) => x.classList.remove('sel'));
  if (currentView === 'editor' && editorId) ipadList.querySelector(`a[href="#/zettel/${CSS.escape(editorId)}"]`)?.classList.add('sel');
}

/** Klassen am <html>, Hervorhebung, Liste – nach jedem Seitenwechsel und beim Drehen */
function ipadSync() {
  const root = document.documentElement;
  const on = ipadOn();
  const quer = on && ipadQuer();
  root.classList.toggle('ipad', on);
  root.classList.toggle('ipad-quer', quer);
  root.classList.toggle('ipad-hoch', on && !quer);
  if (!on) {
    root.classList.remove('ipad-side-open');
    delete root.dataset.view;
    return;
  }
  root.dataset.view = currentView;
  // zwei Spalten im Zettel, wenn je Tag mindestens so viel Platz bleibt wie auf einem großen iPhone
  root.classList.toggle('ipad-cols', innerWidth - (quer ? 320 : 0) - 40 >= 760);
  const tab = TABS.find((t) => t && t[3].includes(currentView));
  document.querySelectorAll('[data-ipad-tab]').forEach((b) => b.classList.toggle('on', !!tab && b.dataset.ipadTab === tab[0]));
  // quer: Liste links nur im Bereich „Zettel“ und nicht, wenn die Liste selbst die Seite ist
  ipadRenderList(quer ? !!tab && tab[0] === '#/' && currentView !== 'list' : true);
  // quer: „Zettel“ zeigt gleich den neuesten Zettel
  if (quer && currentView === 'list' && searchQuery == null && bhMode() === 'zettel') {
    const m = listBodyHTML().match(/href="(#\/zettel\/[^"]+)"/);
    if (m) location.replace(m[1]);
  }
  ipadEditorNav();
}
/** Hoch: Zurück im Zettel wird zum Knopf für die Zettel-Liste */
function ipadEditorNav() {
  const b = app.querySelector('.nav > .nav-btn.back');
  if (!b || currentView !== 'editor' || !document.documentElement.classList.contains('ipad-hoch')) return;
  if (b.dataset.act === 'ipad-list') return;
  b.dataset.act = 'ipad-list';
  b.setAttribute('aria-label', 'Zettel');
  b.innerHTML = IPAD_SIDE_ICON;
}
const ipadClose = () => document.documentElement.classList.remove('ipad-side-open');

// nach jedem Seitenwechsel (route ruft updateTabbar am Ende)
const ipadUpdateTabbar = updateTabbar;
updateTabbar = function () {
  ipadUpdateTabbar();
  ipadClose();
  ipadSync();
};
// Zettel gespeichert (Stunden in der Liste), gelöscht: Liste links neu
const ipadSaveSheets = saveSheets;
saveSheets = function (changed) {
  ipadSaveSheets(changed);
  clearTimeout(ipadSync.t);
  if (ipadOn()) ipadSync.t = setTimeout(ipadSync, 300);
};
// Liste neu zeichnen (nach dem Löschen per Wischen, Wechsel Stundenzettel/Berichtsheft) – quer steht sie links, solange
// rechts etwas anderes offen ist
const ipadRenderListPage = renderList;
renderList = function () {
  if (ipadQuer() && currentView !== 'list') {
    if (currentView === 'editor' && !findSheet(editorId)) location.replace('#/');
    else ipadSync();
    return;
  }
  ipadRenderListPage();
};
new MutationObserver(ipadEditorNav).observe(app, { childList: true });

document.addEventListener('click', (e) => {
  const t = e.target.closest('[data-ipad-tab]');
  if (t) {
    haptic();
    ipadClose();
    if ((location.hash || '#/') === t.dataset.ipadTab) window.scrollTo({ top: 0, behavior: 'smooth' });
    else location.replace(t.dataset.ipadTab);
    return;
  }
  if (e.target.closest('[data-act="ipad-list"]')) {
    haptic();
    ipadSync();
    document.documentElement.classList.add('ipad-side-open');
    return;
  }
  if (e.target.id === 'ipad-scrim') ipadClose();
});
let ipadW = innerWidth;
let ipadH = innerHeight;
window.addEventListener('resize', () => {
  // Tastatur ändert nur die Höhe: nicht umbauen
  if (innerWidth === ipadW && Math.abs(innerHeight - ipadH) < 200) return;
  ipadW = innerWidth;
  ipadH = innerHeight;
  ipadSync();
});
ipadSync();
