// Std-Protokoll – Ansicht auf dem iPad und dem Mac (Stile: ipad.css). Auf dem iPhone tut diese Datei nichts.
// Mac: immer wie das iPad quer (Seitenleiste, auch bei schmalem Fenster), dazu Maus und Tastatur (unten).
// Quer (breit genug): Seitenleiste links mit den Bereichen und der Zettel-Liste statt der Leiste unten, Plus oben rechts;
// „Zettel“ öffnet gleich den neuesten Zettel (die Liste steht ja links).
// Hoch: Leiste oben in der Mitte, Plus oben rechts; im Zettel blendet der Knopf oben links die Zettel-Liste ein.
// Im Zettel stehen die Tage nebeneinander, wenn zwei Spalten Platz haben. Schmales Fenster (Split View): wie auf dem iPhone.

const IPAD_MIN_W = 700;
const ipadMac = () => deviceKind() === 'Mac';
const ipadOn = () => ipadMac() || (deviceKind() === 'iPad' && innerWidth >= IPAD_MIN_W);
const ipadQuer = () => ipadOn() && (ipadMac() || (innerWidth > innerHeight && innerWidth >= 1000));
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
  root.classList.toggle('mac', on && ipadMac());
  if (!on) {
    root.classList.remove('ipad-side-open');
    delete root.dataset.view;
    return;
  }
  root.dataset.view = currentView;
  // zwei Spalten im Zettel, wenn je Tag mindestens so viel Platz bleibt wie auf einem großen iPhone (drei am Mac abgelehnt)
  const room = innerWidth - (quer ? ipadSide.offsetWidth : 0) - 40;
  root.classList.toggle('ipad-cols', room >= 760);
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
/** Hoch: Zurück im Zettel wird zum Knopf für die Zettel-Liste; Mac: Spaltenköpfe der Tabelle */
function ipadEditorNav() {
  const days = currentView === 'editor' && document.documentElement.classList.contains('mac') && document.getElementById('days');
  if (days && !days.querySelector('.mac-th'))
    days.insertAdjacentHTML(
      'afterbegin',
      '<div class="mac-th" aria-hidden="true"><span>Tag</span><div><span>Beginn</span><span></span><span>Ende</span><span></span><span>Baustelle</span><span>Art der Arbeit</span><span>Std.</span></div><span>Gesamt</span></div>'
    );
  const b = app.querySelector('.nav > .nav-btn.back');
  if (!b || currentView !== 'editor' || !document.documentElement.classList.contains('ipad-hoch')) return;
  if (b.dataset.act === 'ipad-list') return;
  b.dataset.act = 'ipad-list';
  b.setAttribute('aria-label', 'Zettel');
  b.innerHTML = IPAD_SIDE_ICON;
}
/** Zettel-Liste (hoch) ein-/ausblenden – mit Bewegung nur dabei, nicht beim Drehen */
function ipadSideOpen(on) {
  const root = document.documentElement;
  if (root.classList.contains('ipad-side-open') === on) return;
  root.classList.add('ipad-side-anim');
  root.classList.toggle('ipad-side-open', on);
  clearTimeout(ipadSideOpen.t);
  ipadSideOpen.t = setTimeout(() => root.classList.remove('ipad-side-anim'), 350);
}
const ipadClose = () => ipadSideOpen(false);

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
new MutationObserver(() => ipadEditorNav()).observe(app, { childList: true });

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
    ipadSideOpen(true);
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

// ───────── Mac: Rechtsklick und Tastatur ─────────
const ipadIsMac = () => document.documentElement.classList.contains('mac');
// Rechtsklick wie langes Drücken bzw. Wischen (nur, was man auch sieht: Kartenauswahl, Löschen in Listen, Personen auf
// der Server-Seite); in Eingabefeldern bleibt das normale Menü
document.addEventListener('contextmenu', (e) => {
  if (!ipadIsMac() || e.target.closest('input, textarea, [contenteditable="true"]') || layer.classList.contains('open')) return;
  const card = e.target.closest('[data-ovc]');
  const person = e.target.closest('[data-fb-hold]');
  const del = e.target.closest('.swipe')?.querySelector('.swipe-del');
  if (card) ovcPick(card.dataset.ovc);
  else if (person) adminPersonMenu(person);
  else if (del) del.click();
  else return;
  e.preventDefault();
});
// ⌘N neuer Zettel, Esc schließt ein Fenster (wie Tippen daneben), Enter bestätigt (nie beim Löschen)
document.addEventListener('keydown', (e) => {
  if (!ipadIsMac() || e.isComposing) return;
  const open = layer.classList.contains('open');
  if (e.key === 'n' && e.metaKey && !e.shiftKey && !e.altKey) {
    e.preventDefault();
    if (!open) document.getElementById('ipad-plus').click();
  } else if (e.key === 'Escape' && open) {
    e.preventDefault();
    layer.querySelector('.backdrop')?.click();
  } else if (e.key === 'Enter' && open && !e.target.closest?.('textarea')) {
    const ok = layer.querySelector('.alert-buttons button.strong:not(.destructive)');
    if (ok && !e.target.closest?.('input')) {
      e.preventDefault();
      ok.click();
    }
  }
});

// Uhrzeit tippen statt wählen (Mac, Knopf hat den Fokus): „7“, „730“, „0730“, „7:30“ – Enter/Tab übernimmt (auf das
// 30-Minuten-Raster gerundet), Esc verwirft. Ohne Ziffern öffnet Enter wie bisher die Auswahl
let macTime = null; // { btn, buf, orig }
function macTimeParse(buf) {
  const p = buf.split(/[:.,]/);
  let h;
  let m = 0;
  if (p.length > 1) (h = +p[0]), (m = p[1].length === 1 ? +p[1] * 10 : +p[1]);
  else if (buf.length <= 2) h = +buf;
  else if (buf.length === 3) (h = +buf[0]), (m = +buf.slice(1));
  else (h = +buf.slice(0, 2)), (m = +buf.slice(2, 4));
  if (!(h >= 0 && h <= 24 && m >= 0 && m < 60)) return null;
  const step = settings.minuteStep;
  // wie das Rad: nächstliegender Schritt, bei Gleichstand der frühere
  return (Math.ceil((h * 60 + m) / step - 0.5) * step) % 1440;
}
function macTimeCommit(back) {
  const { btn, buf } = macTime;
  macTime = null;
  const v = macTimeParse(buf);
  const { s, dayIndex, day, rowIndex, row } = rowContext(btn);
  const which = btn.dataset.which;
  if (v != null) {
    row[which] = v;
    // wie die Auswahl: Ende wird Beginn der nächsten Zeile
    if (which === 'end') {
      const next = day.rows[rowIndex + 1];
      if (next && next.start == null) next.start = v;
    }
    saveSheets(s);
  }
  refreshDay(dayIndex);
  const r = document.querySelector(`#days .row[data-row="${CSS.escape(row.id)}"]`);
  const to = !r ? null : back ? (which === 'end' ? r.querySelector('.time[data-which="start"]') : null) : which === 'start' ? r.querySelector('.time[data-which="end"]') : r.querySelector('[data-f="site"]');
  (to || r?.querySelector(`.time[data-which="${which}"]`))?.focus();
}
document.addEventListener(
  'keydown',
  (e) => {
    if (!ipadIsMac() || currentView !== 'editor' || layer.classList.contains('open') || e.metaKey || e.ctrlKey) return;
    const btn = e.target.closest?.('#days .time');
    if (btn) {
      const mine = macTime && macTime.btn === btn;
      if (/^[0-9:.,]$/.test(e.key)) {
        if (!mine) macTime = { btn, buf: '', orig: btn.textContent };
        if (macTime.buf.length < 5) macTime.buf += e.key;
      } else if (e.key === 'Backspace' && mine) macTime.buf = macTime.buf.slice(0, -1);
      else if ((e.key === 'Enter' || e.key === 'Tab') && mine && macTime.buf) return e.preventDefault(), macTimeCommit(e.shiftKey);
      else if (e.key === 'Escape' && mine) {
        e.preventDefault();
        return macTimeCancel();
      } else return;
      e.preventDefault();
      btn.classList.add('typing');
      btn.textContent = macTime.buf || '–';
      return;
    }
    // Enter in „Art der Arbeit“: weiter zur nächsten Zeile des Tages, in der letzten eine neue anlegen
    const work = e.target.closest?.('#days textarea[data-f="work"]');
    if (work && e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      const rowEl = work.closest('.row');
      let next = rowEl.nextElementSibling;
      while (next && !next.classList.contains('row')) next = next.nextElementSibling;
      if (next) return next.querySelector('.time[data-which="start"]').focus();
      const i = rowEl.closest('.day').dataset.day;
      work.blur();
      rowEl.closest('.day').querySelector('[data-act="addrow"]').click();
      setTimeout(() => [...document.querySelectorAll(`#days .day[data-day="${i}"] .row`)].pop()?.querySelector('.time[data-which="start"]').focus(), 50);
    }
  },
  true
);
/** Halb getippte Uhrzeit verwerfen (Esc, Fokus woanders): Knopf zeigt wieder den gespeicherten Wert */
function macTimeCancel() {
  if (!macTime) return;
  macTime.btn.textContent = macTime.orig;
  macTime.btn.classList.remove('typing');
  macTime = null;
}
document.addEventListener('focusout', (e) => macTime && e.target === macTime.btn && macTimeCancel());

// ───────── iPad: Woche links, gewählter Tag rechts ─────────
// Links die sieben Tage (Baustellen, Stunden, Warnzeichen, ungespeichert), quer genau bildschirmhoch; rechts groß die Karte
// des gewählten Tages (Baustelle, Arbeit, Pause, Tagesart, Speichern wie gewohnt). Mac: Tabelle statt dessen.
let wkDay = null; // gewählter Tag (0–6) des offenen Zettels
let wkSheet = null;
const wkOn = () => document.documentElement.classList.contains('ipad') && !document.documentElement.classList.contains('mac') && currentView === 'editor';

function wkHTML(s) {
  const rows = s.days
    .map((d, i) => {
      const off = !sheetIsActive(s, i);
      const date = sheetDate(s, i);
      const sites = [...new Set(d.rows.map((r) => (r.site || '').split(',')[0].trim()).filter(Boolean))];
      const what = d.status ? `${DAY_STATUS_SHORT[d.status] || ''}${d.status === 'feiertag' && holidayName(date) ? ` · ${holidayName(date)}` : ''}` : sites.join(' · ');
      const warn = !off && (statusWarning(s, i) || pauseMissing(d) || d.rows.some((r) => !rowIsEmpty(r) && (timeWarning(d, r) || fieldMissing(d, r, 'site') || fieldMissing(d, r, 'work'))));
      const total = off ? 0 : dayTotal(d, i);
      return `<button class="wk-day wd-${i} ${i === wkDay ? 'sel' : ''} ${off ? 'off' : ''} ${i > 4 ? 'we' : ''}" data-wk-day="${i}"${off ? ' disabled' : ''}>
        <span class="wk-name"><b>${WEEKDAYS[i]}</b> <span>${fmtDayMonth(date)}</span>${warn ? ' <i class="wk-warn">⚠️</i>' : ''}${editorDayDirty(s, i) ? ' <i class="wk-dirty" aria-label="nicht gespeichert"></i>' : ''}</span>
        <span class="wk-what" translate="no">${escapeHtml(off ? (i === 0 ? 'vorheriger Monat' : 'nächster Monat') : what || (i > 4 ? 'frei' : '–'))}</span>
        <span class="wk-h">${total ? fmtH(total) : '–'}</span>
      </button>`;
    })
    .join('');
  return `<div class="wk-list">${rows}<div class="wk-sum"><span>Woche</span><b>${fmtH(sheetTotal(s))}</b></div></div>`;
}
function wkRender() {
  const days = document.getElementById('days');
  let wk = document.getElementById('ipad-week');
  if (!wkOn() || !days) {
    wk?.remove();
    days?.removeAttribute('data-sel');
    return;
  }
  const s = currentSheet();
  if (!s) return;
  if (wkSheet !== s.id || wkDay == null || !sheetIsActive(s, wkDay)) {
    wkSheet = s.id;
    // heute; leeres Wochenende → Freitag (bzw. letzter Werktag des Zettels)
    let today = s.days.findIndex((_, i) => sameDay(sheetDate(s, i), new Date()));
    if (today >= 5 && dayCollapsed(s, today)) today = sheetActiveDays(s).filter((k) => k < 5).pop() ?? today;
    wkDay = today >= 0 && sheetIsActive(s, today) ? today : sheetActiveDays(s)[0] ?? 0;
  }
  if (!wk) {
    days.insertAdjacentHTML('beforebegin', '<aside id="ipad-week"></aside>');
    wk = document.getElementById('ipad-week');
  }
  const html = wkHTML(s);
  if (wk.innerHTML !== html) wk.innerHTML = html;
  days.dataset.sel = wkDay;
  // Felder des eben gezeigten Tages auf ihre Höhe bringen (versteckt gemessen wären sie 0 bzw. zu hoch)
  const key = `${s.id}|${wkDay}|${document.documentElement.className}|${innerWidth}`;
  if (key !== wkRender.key) (wkRender.key = key), requestAnimationFrame(fitRowTexts);
}
document.addEventListener('click', (e) => {
  const b = e.target.closest?.('[data-wk-day]');
  if (!b) return;
  haptic();
  wkDay = Number(b.dataset.wkDay);
  wkRender();
  window.scrollTo({ top: 0, behavior: 'smooth' });
});
// neu zeichnen: Seite gewechselt (ipadEditorNav), gespeichert/geändert (saveSheets → ipadSync), gedreht (ipadSync)
const wkNav = ipadEditorNav;
ipadEditorNav = function () {
  wkNav();
  wkRender();
};
// beim Start: ipadSync oben lief schon, bevor es die Woche gab
wkRender();
