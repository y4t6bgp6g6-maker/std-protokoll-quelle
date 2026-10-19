// Arbeitsarten und Kunden (Übersicht): Jede Zeile bekommt nach festen Regeln (regeln.js) eine Arbeitsart (Baustelle, Kundendienst,
// Werkstatt, Sonstiges); Kunde = Feld „Baustelle“ (ohne Werkstatt), gleiche Baustelle trotz anderer Schreibweise wie
// auf der Team-Seite (teamSameSite), Ketten aus gleichem Wortanfang („Muster-Pizza Nord“ / „Muster-Pizza Süd“) oder
// von Hand (settings.kunden = { merge: { Kunde: Kette }, split: [Kunde] }, Hand geht vor Regel). Alles wird nur
// berechnet, nichts im Zettel gespeichert; ohne Netz und ohne KI. Wird vor app.js geladen.

const ARTEN = [
  ['baustelle', 'Baustelle'],
  ['kundendienst', 'Kundendienst'],
  ['werkstatt', 'Werkstatt'],
  ['sonstiges', 'Sonstiges'],
];
/** Klein, ohne Akzente/Umlaute, ß = ss */
const kdNorm = (s) => String(s ?? '').toLowerCase().replace(/ß/g, 'ss').normalize('NFD').replace(/[\u0300-\u036f]/g, '');
/** Für die Regeln auch „ae/oe/ue“ wie ä/ö/ü: „Störung“ = „Stoerung“ = „Storung“ */
const kdArtNorm = (s) => kdNorm(String(s ?? '').toLowerCase().replace(/([aou])e/g, '$1'));
// Die Regeln selbst stehen in regeln.js (REGELN.arbeitsarten), erzeugt vom Regel-Werkzeug aus
// „Regeln und Logiken/Arbeitsarten-und-Kunden.json“ außerhalb des Repos – dort ändern, nicht hier.
const kdRegel = (id) => REGELN.arbeitsarten.abschnitte.find((a) => a.id === id);

/**
 * Regelliste → Funktion Zeile → { art, regel (Nummer ab 0, -1 = keine), wort }. Regeln von oben nach unten, die
 * erste passende gilt. Wörter als Wortteil („teil“) oder am Anfang des Feldes („anfang“); Ausnahmen werden vor dem
 * Vergleich aus dem Text genommen („angebracht“ zählt nicht als „gebracht“). Auch für das Regel-Werkzeug.
 */
function artMatcher(def) {
  const rules = def.regeln.map((g) => ({
    ...g,
    w: g.woerter.map((x) => kdArtNorm(x).trim()).filter(Boolean),
    x: (g.ausnahmen || []).map((x) => kdArtNorm(x).trim()).filter(Boolean),
  }));
  return (r) => {
    for (let i = 0; i < rules.length; i++) {
      const g = rules[i];
      let t = kdArtNorm(g.feld === 'baustelle' ? r.site : r.work);
      for (const x of g.x) t = t.split(x).join(' ');
      const wort = g.wie === 'anfang' ? g.w.find((w) => t.replace(/^[^\p{L}\p{N}]+/u, '').startsWith(w)) : g.w.find((w) => t.includes(w));
      if (wort) return { art: g.ziel, regel: i, wort };
    }
    return { art: def.sonst, regel: -1, wort: '' };
  };
}
const arbeitsartGrund = artMatcher(kdRegel('arbeitsart'));
/** Arbeitsart einer Zeile */
const arbeitsart = (r) => arbeitsartGrund(r).art;

/** Ganze Stunden mit Tausenderpunkt: „357 h“ */
const kdHours = (min) => `${Math.round(min / 60).toLocaleString('de-DE')} h`;
/** Schlüssel eines Namens (für settings.kunden): Wörter klein, ohne Satzzeichen */
const kdKey = (s) => kdNorm(s).replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

// Wörter, die allein keine Kette bilden (Branche, Rechtsform, Straße …), Artikel vorne – aus regeln.js
const kdWordSet = (id) => new Set(kdRegel(id).woerter.map((w) => kdNorm(w).replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean));
const KD_GENERIC = kdWordSet('kettenwoerter');
const KD_STREET_ENDS = [...kdWordSet('strassen')];
const kdStreet = (w) => KD_STREET_ENDS.some((e) => w.endsWith(e));
/** Kette aus diesen Wörtern möglich: mindestens ein Wort ab 3 Buchstaben, das keine Branche/Straße ist */
const kdChainKeyOk = (words) => words.some((w) => w.length >= 3 && !KD_GENERIC.has(w) && !kdStreet(w) && !/\d/.test(w));
/** Wörter eines Namens: Original und verglichen (ohne Satzzeichen); Komma trennt wie ein Leerzeichen */
const KD_ARTICLE = kdWordSet('artikel');
function kdWords(name) {
  const orig = String(name).split(/[\s,]+/).filter(Boolean);
  const pairs = orig.map((o) => [o, kdNorm(o).replace(/[^\p{L}\p{N}]/gu, '')]).filter((p) => p[1]);
  // Artikel vorne zählen nicht („The Muster“ = „Muster, Musterstadt“)
  while (pairs.length > 1 && KD_ARTICLE.has(pairs[0][1])) pairs.shift();
  return { orig: pairs.map((p) => p[0]), norm: pairs.map((p) => p[1]) };
}

/** Kunden-Einstellung (nie undefined zurück, aber erst beim Ändern gespeichert) */
const kdSettings = () => ({ merge: { ...(settings.kunden?.merge || {}) }, split: [...(settings.kunden?.split || [])] });

/**
 * Alles für Karten und Seite eines Jahres: Minuten je Arbeitsart (gesamt und je Monat) und die Kunden. Gezählt werden
 * Tage bis heute, an denen gearbeitet werden kann (auch Arbeit am Feiertag); die Pause des Tages wird nach Dauer auf
 * seine Zeilen verteilt, damit alles zusammen die Netto-Stunden ergibt.
 */
function kundenFacts(year) {
  const today = startOfDay(new Date());
  const arten = { baustelle: 0, kundendienst: 0, werkstatt: 0, sonstiges: 0 };
  const artenM = [...Array(12)].map(() => ({ baustelle: 0, kundendienst: 0, werkstatt: 0, sonstiges: 0 }));
  const spell = new Map(); // Schreibweise → { min, days: Set }
  for (const s of sheets) {
    s.days.forEach((d, i) => {
      if (!sheetIsActive(s, i) || !canWork(d)) return;
      const date = sheetDate(s, i);
      if (date.getFullYear() !== year || date > today) return;
      const gross = dayWorked(d);
      if (!gross) return;
      const f = workedNet(d) / gross;
      const iso = isoDate(date);
      for (const r of d.rows) {
        const min = (rowMinutes(r) || 0) * f;
        if (!min) continue;
        const art = arbeitsart(r);
        arten[art] += min;
        artenM[date.getMonth()][art] += min;
        const site = String(r.site || '').trim();
        if (art === 'werkstatt' || !site) continue;
        const e = spell.get(site) || { min: 0, days: new Set() };
        e.min += min;
        e.days.add(iso);
        spell.set(site, e);
      }
    });
  }
  return { year, arten, artenM, kunden: kdGroup(spell) };
}

/** Schreibweisen → Kunden (gleiche Baustelle wie auf der Team-Seite) → Ketten (Hand, dann Regel) */
function kdGroup(spell) {
  // 1. gleiche Baustelle: zusammen nur, wenn jede Schreibweise der einen Gruppe zu jeder der anderen passt
  const names = [...spell.keys()].sort((a, b) => spell.get(b).min - spell.get(a).min);
  // anders als auf der Team-Seite zählt der Ort nach dem Komma mit („Muster-Pizza, Nord“ ≠ „Muster-Pizza, Süd“)
  // und zwei verschiedene Orte hinter dem Komma sind nie dieselbe Baustelle (auch nicht als Tippfehler)
  const parts = names.map((n) => teamSiteParts(n.replace(/,/g, ' ')));
  // (es sei denn, der eine Ort steht auch im anderen Namen: „Muster, Nord Mitte“ = „Muster Nord, Mitte“)
  const place = names.map((n) => (n.includes(',') ? kdKey(n.slice(n.lastIndexOf(',') + 1)) : null));
  const full = names.map((n) => ` ${kdKey(n)} `);
  const placeFits = (x, y) => !place[x] || !place[y] || full[y].includes(` ${place[x]} `) || full[x].includes(` ${place[y]} `);
  const same = (x, y) => placeFits(x, y) && teamSameSite(parts[x], parts[y]);
  const groups = names.map((_, i) => [i]);
  const of = names.map((_, i) => i);
  for (let i = 0; i < names.length; i++)
    for (let j = 0; j < i; j++) {
      const a = of[i], b = of[j];
      if (a === b || !groups[a].every((x) => groups[b].every((y) => same(x, y)))) continue;
      for (const x of groups[a]) of[x] = b;
      groups[b].push(...groups[a]);
      groups[a] = [];
    }
  // Name des Kunden = Schreibweise mit den meisten Stunden (names ist danach sortiert)
  const kunden = groups
    .filter((g) => g.length)
    .map((g) => {
      const days = new Set();
      let min = 0;
      for (const x of g) {
        min += spell.get(names[x]).min;
        spell.get(names[x]).days.forEach((d) => days.add(d));
      }
      return { name: names[g[0]], keys: g.map((x) => kdKey(names[x])), min, days };
    });

  // 2. Ketten
  const set = kdSettings();
  const split = new Set(set.split);
  const mergeOf = (k) => k.keys.map((x) => set.merge[x]).find(Boolean);
  const chains = new Map(); // Schlüssel → { name, hand, members: [{ k, label }] }
  const join = (key, name, k, label, hand = false) => {
    const c = chains.get(key) || { name, hand, members: [] };
    c.hand ||= hand;
    c.members.push({ k, label });
    chains.set(key, c);
  };
  const free = [];
  const single = []; // ohne Kette
  for (const k of kunden) {
    const m = mergeOf(k);
    if (m) join(kdKey(m), m, k, k.name, true);
    else if (k.keys.some((x) => split.has(x))) single.push(k);
    else free.push(k);
  }
  // gleicher Anfang (ganze Wörter) bei mindestens zwei Kunden, Rest verschieden; die kürzeste passende Kette gilt
  const words = new Map(free.map((k) => [k, kdWords(k.name)]));
  const count = new Map();
  for (const k of free) {
    const w = words.get(k).norm;
    for (let n = 1; n <= w.length; n++) {
      const key = w.slice(0, n).join(' ');
      count.set(key, (count.get(key) || 0) + 1);
    }
  }
  // Orte bilden keine Kette: was irgendwo hinter einem Komma steht („Kunde, Ort“)
  const places = new Set(names.filter((n) => n.includes(',')).map((n) => kdWords(n.slice(n.lastIndexOf(',') + 1)).norm.join(' ')));
  const keyOk = (w) => count.get(w.join(' ')) >= 2 && !places.has(w.join(' ')) && kdChainKeyOk(w);
  // je Kunde die kürzeste passende Kette; danach so lang wie bei allen ihren Kunden gleich („Muster Pizza Nord“ und
  // „Muster Pizza Süd“ → „Muster Pizza“), solange jeder einen Rest behält
  const rest = [];
  const found = new Map(); // kürzester Schlüssel → Kunden
  for (const k of free) {
    const w = words.get(k);
    let n = 1;
    while (n < w.norm.length && !keyOk(w.norm.slice(0, n))) n++;
    if (n < w.norm.length) found.set(w.norm.slice(0, n).join(' '), [...(found.get(w.norm.slice(0, n).join(' ')) || []), k]);
    else rest.push(k);
  }
  for (const [key, ks] of found) {
    let n = key.split(' ').length;
    const ws = ks.map((k) => words.get(k));
    while (ws.every((w) => w.norm.length > n + 1 && w.norm[n] === ws[0].norm[n])) n++;
    for (const k of ks) {
      const w = words.get(k);
      join(w.norm.slice(0, n).join(' '), ws[0].orig.slice(0, n).join(' '), k, w.orig.slice(n).join(' '));
    }
  }
  // Name = eine schon gefundene Kette, auch mit Ort vorne („Musterstadt Muster-Pizza“)
  for (const k of rest) {
    const w = words.get(k);
    let hit = null;
    for (let n = 0; n < w.norm.length && !hit; n++) {
      const key = w.norm.slice(n).join(' ');
      if (chains.has(key)) hit = [key, n ? w.orig.slice(0, n).join(' ') : k.name];
    }
    if (hit) join(hit[0], chains.get(hit[0]).name, k, hit[1]);
    else single.push(k);
  }

  const list = single.map((k) => ({ name: k.name, key: k.keys[0], min: k.min, days: k.days.size }));
  for (const [key, c] of chains) {
    const days = new Set();
    c.members.forEach((m) => m.k.days.forEach((d) => days.add(d)));
    list.push({
      name: c.name,
      key,
      chain: true,
      hand: c.hand,
      min: c.members.reduce((t, m) => t + m.k.min, 0),
      days: days.size,
      branches: c.members
        .map((m) => ({ name: m.label || m.k.name, full: m.k.name, key: m.k.keys[0], hand: !!mergeOf(m.k), min: m.k.min, days: m.k.days.size }))
        .sort((a, b) => b.min - a.min),
    });
  }
  return list.sort((a, b) => b.min - a.min || a.name.localeCompare(b.name, 'de'));
}

// ───────── Karten der Übersicht ─────────

const ART_CLS = { baustelle: 'art-b', kundendienst: 'art-k', werkstatt: 'art-w', sonstiges: 'art-s' };

/** Ring: Stunden je Arbeitsart im Jahr */
function kdArtenRingHTML(f) {
  const parts = ARTEN.map(([k, t]) => ({ v: f.kd.arten[k], cls: ART_CLS[k], t }));
  const sum = parts.reduce((a, p) => a + p.v, 0);
  return `<div class="ovc-vac">
    ${ovcDonut(parts, Math.round(sum / 60).toLocaleString('de-DE'), 'Stunden')}
    <div class="ovc-vac-r">
      <div class="ovc-title">Arbeitsarten</div>
      <div class="ovc-lines">${parts.map((p) => `<div><i class="ovc-dot ${p.cls}"></i>${p.t}<b class="ovc-count">${kdHours(p.v)}</b></div>`).join('')}</div>
    </div>
  </div>`;
}

/** Säulen je Monat, gestapelt nach Arbeitsart */
function kdArtenBarsHTML(f) {
  const last = ovcLastMonth(f.year);
  return `<div class="ovc-head"><span class="ovc-title">Arbeitsarten</span></div>
    ${ovcBars(
      f.kd.artenM.map((m, k) => {
        if (k >= last) return null;
        // unten Baustelle, darüber die anderen (die Säule baut sich von unten auf)
        const segs = [...ARTEN].reverse().map(([a]) => ({ v: m[a], cls: ART_CLS[a] }));
        return { v: segs.reduce((t, x) => t + x.v, 0), segs };
      }),
      (v) => fmtNum(Math.round(v / 60))
    )}
    ${legend(ARTEN.map(([k, t]) => [ART_CLS[k], t]))}`;
}

/** Zeile eines Kunden: Name, klein Filialen und Tage, rechts Stunden, darunter ein Balken (im Verhältnis zum größten) */
function kdRowHTML(k, max, open = null) {
  const pct = max ? Math.max(1.5, (k.min / max) * 100) : 0;
  return `<div class="kd-top">
      ${open != null ? `<span class="kd-arrow${open ? ' open' : ''}">${ICON.chevronDown}</span>` : ''}
      <span class="kd-name" translate="no">${escapeHtml(k.name)}</span>
      ${k.chain ? `<span class="kd-fil">${plural(k.branches.length, 'Filiale', 'Filialen')}</span>` : ''}
      <span class="kd-days">${plural(k.days, 'Tag', 'Tage')}</span>
      <b class="kd-h">${kdHours(k.min)}</b>
    </div>
    <div class="kd-bar"><i style="width:${pct}%"></i></div>`;
}

/** Große Karte „Kunden“: die fünf größten, antippen → Seite mit allen */
function kdKundenCardHTML(f) {
  const list = f.kd.kunden;
  const max = list[0]?.min || 0;
  return `<div class="kd-card" data-kunden-open>
    <div class="ovc-head"><span class="ovc-title">Kunden</span><b class="ovc-count">${list.length}</b></div>
    ${list.length ? list.slice(0, 5).map((k) => `<div class="kd-row">${kdRowHTML(k, max)}</div>`).join('') : '<div class="kd-none">Noch keine Kunden</div>'}
    ${list.length > 5 ? `<div class="kd-more">+ ${list.length - 5} weitere</div>` : ''}
  </div>`;
}

document.addEventListener('click', (e) => {
  if (e.target.closest?.('[data-kunden-open]') && !layer.classList.contains('open')) location.hash = '#/kunden';
});

// ───────── Seite „Kunden“ ─────────

const kdOpen = new Set(); // aufgeklappte Ketten (Schlüssel), solange die App offen ist

function kundenRoute(hash) {
  if (hash !== '#/kunden') return false;
  currentView = 'kunden';
  renderKunden();
  return true;
}

function renderKunden() {
  const year = statsYear ?? new Date().getFullYear();
  const list = kundenFacts(year).kunden;
  renderKunden.list = list;
  const max = list[0]?.min || 0;
  const total = list.reduce((t, k) => t + k.min, 0);
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title">Kunden</h1>
    <p class="ps-sub">${year} · ${plural(list.length, 'Kunde', 'Kunden')} · ${kdHours(total)}</p>
    ${
      list.length
        ? `<div class="card kd-list">${list
            .map((k) => {
              const open = kdOpen.has(k.key);
              return `<div class="kd-row kd-item" data-kd-hold="${escapeHtml(k.key)}"${k.chain ? ` data-kd-chain="${escapeHtml(k.key)}"` : ''}>
                ${kdRowHTML(k, max, k.chain ? open : null)}
                ${
                  k.chain && open
                    ? `<div class="kd-branches">${k.branches
                        .map(
                          (b) => `<div class="kd-branch" data-kd-hold="${escapeHtml(b.key)}" data-kd-of="${escapeHtml(k.key)}">
                            <span class="kd-name" translate="no">${escapeHtml(b.name)}</span>
                            <span class="kd-days">${plural(b.days, 'Tag', 'Tage')}</span>
                            <b class="kd-h">${kdHours(b.min)}</b>
                          </div>`
                        )
                        .join('')}</div>`
                    : ''
                }
              </div>`;
            })
            .join('')}</div>`
        : '<div class="card kd-list"><div class="kd-none">Noch keine Kunden</div></div>'
    }`;
}

/** Kette auf- bzw. zuklappen */
document.addEventListener('click', (e) => {
  if (currentView !== 'kunden' || kdPressFired) return;
  const row = e.target.closest?.('[data-kd-chain]');
  if (!row || e.target.closest('.kd-branch')) return;
  const key = row.dataset.kdChain;
  if (kdOpen.has(key)) kdOpen.delete(key);
  else kdOpen.add(key);
  const y = window.scrollY;
  renderKunden();
  window.scrollTo(0, y);
  if (kdOpen.has(key)) expandIn(document.querySelector(`[data-kd-chain="${CSS.escape(key)}"] .kd-branches`));
});

function kdSave(set) {
  settings.kunden = set;
  saveSettings();
  const y = window.scrollY;
  renderKunden();
  window.scrollTo(0, y);
}

/** Menü zu einer Zeile (lang drücken, Mac: Rechtsklick) */
function kdMenu(el) {
  const list = renderKunden.list || [];
  const set = kdSettings();
  const key = el.dataset.kdHold;
  const of = el.dataset.kdOf;
  if (of) {
    // Filiale: aus der Kette lösen (von Hand zugeordnet → Zuordnung weg, sonst nie mehr automatisch in eine Kette)
    const chain = list.find((k) => k.key === of);
    const b = chain?.branches.find((x) => x.key === key);
    if (!b) return;
    actionSheet([
      {
        label: 'Aus der Kette lösen',
        run: () => {
          for (const [k, v] of Object.entries(set.merge)) if (kdKey(v) === of && kdKey(k) === key) delete set.merge[k];
          if (!set.split.includes(key)) set.split.push(key);
          kdSave(set);
        },
      },
    ]);
    return;
  }
  const k = list.find((x) => x.key === key);
  if (!k) return;
  if (k.chain) {
    actionSheet([
      {
        label: 'Kette auflösen',
        destructive: true,
        run: () => {
          for (const b of k.branches) {
            delete set.merge[b.key];
            if (!set.split.includes(b.key)) set.split.push(b.key);
          }
          for (const [x, v] of Object.entries(set.merge)) if (kdKey(v) === k.key) delete set.merge[x];
          kdOpen.delete(k.key);
          kdSave(set);
        },
      },
    ]);
    return;
  }
  // einzelner Kunde: zu einer Kette zusammenfassen (vorhandene oder neue)
  const into = (name) => {
    set.merge[k.key] = name;
    set.split = set.split.filter((x) => x !== k.key);
    kdOpen.add(kdKey(name));
    kdSave(set);
  };
  const chains = list.filter((x) => x.chain);
  actionSheet([
    {
      label: 'Zu Kette zusammenfassen …',
      run: () =>
        chains.length
          ? actionSheet([
              ...chains.map((c) => ({ label: `<span translate="no">${escapeHtml(c.name)}</span>`, run: () => into(c.name) })),
              { label: 'Neue Kette …', run: () => kdAskChain(k.name, into) },
            ])
          : kdAskChain(k.name, into),
    },
  ]);
}

function kdAskChain(name, done) {
  const modal = openModal(
    `<div class="alert-body"><b>Neue Kette</b>
      <input class="pw-input" data-kd-name value="${escapeHtml(kdWords(name).orig[0] || '')}" maxlength="60" autocomplete="off" enterkeyhint="done" translate="no">
    </div>
    <div class="alert-buttons"><button data-c="no">Abbrechen</button><button data-c="yes" class="strong">Zusammenfassen</button></div>`,
    'alert'
  );
  const input = modal.querySelector('[data-kd-name]');
  const ok = () => {
    const v = input.value.trim();
    if (!v) return;
    closeModal();
    done(v);
  };
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    if (b.dataset.c === 'no') closeModal();
    else ok();
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), ok()));
  setTimeout(() => (input.focus(), input.select()), 50);
}

// lang drücken → Menü; danach kein Auf-/Zuklappen
const KD_HOLD = 450;
let kdPress = null; // { el, x, y, timer }
let kdPressFired = false;
function kdPressEnd() {
  if (!kdPress) return;
  clearTimeout(kdPress.timer);
  kdPress.el.classList.remove('pressing');
  kdPress = null;
}
document.addEventListener('pointerdown', (e) => {
  const el = e.target.closest?.('.kd-branch[data-kd-hold], .kd-item[data-kd-hold]');
  if (!el || e.button > 0 || currentView !== 'kunden') return;
  kdPressEnd();
  kdPressFired = false;
  el.classList.add('pressing');
  kdPress = {
    el,
    x: e.clientX,
    y: e.clientY,
    timer: setTimeout(() => {
      kdPressEnd();
      kdPressFired = true;
      setTimeout(() => (kdPressFired = false), 600);
      haptic();
      kdMenu(el);
    }, KD_HOLD),
  };
});
document.addEventListener('pointermove', (e) => {
  if (kdPress && Math.hypot(e.clientX - kdPress.x, e.clientY - kdPress.y) > 10) kdPressEnd();
});
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, kdPressEnd));
window.addEventListener('scroll', kdPressEnd, { passive: true });
// Mac: Rechtsklick wie langes Drücken; sonst nur das Menü des Browsers unterdrücken
document.addEventListener('contextmenu', (e) => {
  const el = e.target.closest?.('.kd-branch[data-kd-hold], .kd-item[data-kd-hold]');
  if (!el || currentView !== 'kunden') return;
  e.preventDefault();
  if (document.documentElement.classList.contains('mac') && !layer.classList.contains('open')) kdMenu(el);
});
