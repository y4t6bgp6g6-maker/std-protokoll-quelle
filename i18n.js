'use strict';
// Sprache der Oberfläche (Einstellung „Sprache“: de = Deutsch, ru = Русский).
// Der Code schreibt alle Texte deutsch; bei ru übersetzt diese Datei, was auf dem Bildschirm erscheint (Textknoten und
// die Attribute placeholder, aria-label, title, alt) – jedes Mal, wenn die Seite neu gezeichnet wird. PDFs entstehen nicht
// aus der Seite und bleiben deshalb immer deutsch. Wörterbuch und Muster: i18n-ru.js.
// Einträge (Tätigkeiten, Nachrichten) übersetzt die KI über den Team-Server (team.js, aiTranslate).
// Wird als erstes Skript geladen; liest die Einstellung selbst, bevor app.js sie lädt.

const LANG = (() => {
  try {
    return JSON.parse(localStorage.getItem('stdprotokoll.settings.v1') || '{}').lang === 'ru' ? 'ru' : 'de';
  } catch (e) {
    return 'de';
  }
})();
document.documentElement.lang = LANG;

/** Russische Mehrzahl: 1 день, 2 дня, 5 дней (one, few, many) */
function ruPlural(n, one, few, many) {
  const a = Math.abs(Math.trunc(Number(String(n).replace(',', '.'))));
  if (/[,.]\d{1,2}$/.test(String(n))) return few; // Dezimalzahl: „2,5 часа“ (nicht „1.000“ mit Tausenderpunkt)
  const d = a % 10;
  const h = a % 100;
  if (d === 1 && h !== 11) return one;
  if (d >= 2 && d <= 4 && (h < 12 || h > 14)) return few;
  return many;
}

const I18N = {
  exact: new Map(), // ganzer Text → Übersetzung
  patterns: [], // [RegExp (ganzer Text), Ersatz (Text mit $1 … oder Funktion)]
  parts: [], // Bruchstücke, die auch mitten im Text ersetzt werden: [RegExp, Ersatz]
  rparts: [], // Muster mitten im Text: [RegExp mit g, Ersatz]
};

/** Wörterbuch einer Sprache eintragen (aus i18n-ru.js) */
function i18nAdd({ exact = {}, patterns = [], parts = {}, rparts = [] }) {
  for (const [k, v] of Object.entries(exact)) I18N.exact.set(k, v);
  I18N.patterns.push(...patterns);
  // Muster mitten im Text (z. B. „8,50 h“), nach den Bruchstücken
  I18N.rparts.push(...rparts);
  // längere Bruchstücke zuerst, nur an Wortgrenzen
  const keys = Object.keys(parts).sort((a, b) => b.length - a.length);
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  for (const k of keys) I18N.parts.push([new RegExp(`(?<![\\p{L}\\p{N}])${esc(k)}(?![\\p{L}])`, 'gu'), parts[k]]);
}

/** Text übersetzen (Leerraum am Rand bleibt); unbekanntes bleibt deutsch */
function tr(text) {
  if (LANG === 'de' || !text) return text;
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/);
  const core = m[2];
  if (!core || !/[A-Za-zÄÖÜäöüß]/.test(core)) return text;
  let out = I18N.exact.get(core);
  if (out == null)
    for (const [re, rep] of I18N.patterns) {
      if (!re.test(core)) continue;
      // ein Muster, das nichts ändert (z. B. „X: Y“ mit unbekanntem X), überlässt den Text den nächsten
      const r = core.replace(re, rep);
      if (r !== core) {
        out = r;
        break;
      }
    }
  if (out == null) {
    out = core;
    for (const [re, rep] of I18N.parts) {
      re.lastIndex = 0;
      if (re.test(out)) out = out.replace(re, rep);
    }
  }
  for (const [re, rep] of I18N.rparts) out = out.replace(re, rep);
  return m[1] + out + m[3];
}

const I18N_ATTRS = ['placeholder', 'aria-label', 'title', 'alt'];
/** Nur ein geändertes Attribut übersetzen (nicht den ganzen Teilbaum) */
function i18nAttr(el, a) {
  if (!el || el.nodeType !== 1 || i18nSkipAttrs(el)) return;
  const v = el.getAttribute(a);
  if (!v) return;
  const t = tr(v);
  if (t !== v) el.setAttribute(a, t);
}
/** Nicht übersetzen: Inhalt von Eingaben und alles mit translate="no" (z. B. Einträge, Namen); Platzhalter von Eingaben schon */
const i18nSkip = (el) => !el || el.closest('textarea, script, style, [translate="no"], [contenteditable]');
const i18nSkipAttrs = (el) => !el || el.closest('[translate="no"]');

function i18nNode(node) {
  if (node.nodeType === 3) {
    if (i18nSkip(node.parentElement)) return;
    const v = node.nodeValue;
    const t = tr(v);
    if (t !== v) node.nodeValue = t;
    return;
  }
  if (node.nodeType !== 1 || i18nSkipAttrs(node)) return;
  for (const a of I18N_ATTRS) {
    const v = node.getAttribute(a);
    if (v) {
      const t = tr(v);
      if (t !== v) node.setAttribute(a, t);
    }
  }
  // Knöpfe als input (z. B. type="button") zeigen ihren value
  if (node.tagName === 'INPUT' && (node.type === 'button' || node.type === 'submit') && node.value) node.value = tr(node.value);
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === 3) {
      if (i18nSkip(n.parentElement)) continue;
      const v = n.nodeValue;
      const t = tr(v);
      if (t !== v) n.nodeValue = t;
    } else if (!i18nSkipAttrs(n)) {
      for (const a of I18N_ATTRS) {
        const v = n.getAttribute(a);
        if (v) {
          const t = tr(v);
          if (t !== v) n.setAttribute(a, t);
        }
      }
    }
  }
}

if (LANG !== 'de') {
  const observer = new MutationObserver((list) => {
    for (const m of list) {
      if (m.type === 'characterData') i18nNode(m.target);
      else if (m.type === 'attributes') i18nAttr(m.target, m.attributeName);
      else m.addedNodes.forEach(i18nNode);
    }
  });
  const start = () => {
    i18nNode(document.body);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: I18N_ATTRS });
  };
  if (document.body) start();
  else document.addEventListener('DOMContentLoaded', start);
}

/** Kyrillisch im Text? (Einträge russisch schreibender Kollegen) */
const hasCyrillic = (s) => /\p{Script=Cyrillic}/u.test(String(s || ''));
