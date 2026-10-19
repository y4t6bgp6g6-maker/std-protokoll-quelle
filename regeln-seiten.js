// Regel-Seiten (nur Admin, aus der Server-Seite): Zwischenseite #/regeln und je Bereich eine Seite
// (#/regeln/arbeitsarten, …/kunden, …/schreibweisen, …/ketten). Jede Änderung geht sofort an den Server (PUT /regeln,
// base = zuletzt bestätigte Fassung); alle im Team bekommen die neuen Regeln beim nächsten Laden des Teams
// (kunden.js: regelnPruefen). Ohne Server-Fassung gelten die Regeln aus regeln.js – die erste Änderung lädt sie hoch.

const RG_BEREICHE = [
  ['arbeitsarten', 'Arbeitsarten'],
  ['kunden', 'Kunden-Regeln'],
  ['schreibweisen', 'Schreibweisen'],
  ['ketten', 'Ketten'],
];
const RG_TEXT = {
  arbeitsarten:
    'Ordnet jede Zeile einer Arbeitsart zu. Die erste passende Regel gilt. Wirkt auf die Karten „Arbeitsarten“ und „Arbeitsarten pro Monat“ in der Übersicht – auf allen Geräten im Team.',
  kunden:
    'Gelten für einzelne Kunden vor allen anderen Regeln, z. B. Kunde + Wartung = Kundendienst. Eine Kette gilt mit allen Filialen. Wirkt auf die Arbeitsarten in der Übersicht – auf allen Geräten im Team.',
  schreibweisen:
    'Wann zwei Schreibweisen dasselbe meinen. Wirkt auf Kunden-Karte und -Seite, Ketten, Kunden-Regeln und Arbeitsarten – auf allen Geräten im Team.',
  ketten: 'Wann Kunden mit gleichem Namensanfang zu einer Kette mit Filialen werden. Wirkt auf die Karte und die Seite „Kunden“ – auf allen Geräten im Team.',
};
const RG_FARBE = { baustelle: 'var(--accent-fill)', kundendienst: 'var(--art-k)', werkstatt: 'var(--art-w)', sonstiges: 'var(--muted)' };

let rgOk = null; // zuletzt vom Server bestätigte Fassung { rev, zeit, regeln } (rev 0 = noch keine)
let rgBusy = false;
let rgNochmal = false;
const rgOffen = new Set(); // aufgeklappte Regeln (Arbeitsarten)
let rgTab = 'kunden'; // Schreibweisen: Kunden | Tätigkeiten
let rgProbe = { site: '', work: '' };
let rgNeuKunde = null; // Kunden-Seite → „Kunden-Regel anlegen …“

const rgClone = (x) => JSON.parse(JSON.stringify(x));
/** Gültige Regeln als bearbeitbare Kopie, fehlende Abschnitte aus regeln.js ergänzt */
function rgKopie() {
  const r = rgClone(regelnAktiv());
  for (const a of REGELN.arbeitsarten.abschnitte) if (!r.arbeitsarten.abschnitte.some((x) => x.id === a.id)) r.arbeitsarten.abschnitte.push(rgClone(a));
  return r;
}
const rgAb = (r, id) => r.arbeitsarten.abschnitte.find((a) => a.id === id);

/** Regeln ändern: fn bekommt eine Kopie; gilt sofort hier, dann an den Server */
function rgAendern(fn) {
  const r = rgKopie();
  fn(r);
  regelnServer = { rev: rgOk ? rgOk.rev : regelnServer?.rev || 0, zeit: Date.now(), regeln: r };
  regelnMerken();
  KD = null;
  rgZeichnen();
  rgSenden();
}
async function rgSenden() {
  if (rgBusy) return (rgNochmal = true);
  rgBusy = true;
  try {
    do {
      rgNochmal = false;
      const regeln = regelnServer.regeln;
      try {
        const d = await adminRequest('PUT', '/regeln', { base: rgOk ? rgOk.rev : regelnServer.rev, regeln });
        rgOk = { rev: d.rev, zeit: d.zeit, regeln: rgClone(regeln) };
        regelnServer = { ...regelnServer, rev: d.rev, zeit: d.zeit };
      } catch (e) {
        rgNochmal = false;
        if (e.status === 409 && e.data && e.data.regeln) {
          rgOk = { rev: e.data.rev, zeit: e.data.zeit, regeln: e.data.regeln };
          toast('Auf einem anderen Gerät geändert – neu geladen');
        } else toast(e.status ? 'Nicht gespeichert' : 'Keine Verbindung – nicht gespeichert');
        regelnServer = rgOk && rgOk.rev ? rgClone(rgOk) : null;
        KD = null;
        rgZeichnen();
      }
    } while (rgNochmal);
  } finally {
    rgBusy = false;
    regelnMerken();
    KD = null;
  }
}
/** Beim Öffnen: Fassung vom Server holen (die gemerkte kann älter sein) */
async function rgHolen() {
  try {
    const d = await adminRequest('GET', '/regeln');
    rgOk = d.rev ? { rev: d.rev, zeit: d.zeit, regeln: d.regeln } : { rev: 0 };
    if (!rgBusy) {
      regelnServer = d.rev ? rgClone(rgOk) : null;
      regelnMerken();
      KD = null;
      rgZeichnen();
    }
  } catch {}
}

// ───────── Einstieg auf der Server-Seite und Routen ─────────

function regelnEintragHTML() {
  return `<button class="card fb-row fb-code" data-rg-open><span>Regeln</span><span class="fb-ping">${RG_BEREICHE.length} Bereiche${ICON.chevronRight}</span></button>`;
}

function regelnRoute(hash) {
  const m = hash.match(/^#\/regeln(?:\/([a-z]+))?$/);
  if (!m) return false;
  if (!admin || !team) {
    location.replace('#/team');
    return true;
  }
  if (m[1] && !RG_BEREICHE.some(([k]) => k === m[1])) {
    location.replace('#/regeln');
    return true;
  }
  currentView = m[1] ? 'regelnBereich' : 'regeln';
  rgZeichnen();
  rgHolen();
  if (m[1] === 'kunden' && rgNeuKunde != null) {
    const k = rgNeuKunde;
    rgNeuKunde = null;
    setTimeout(() => rgKundenFenster(-1, k), 300);
  }
  return true;
}
const rgBereich = () => (location.hash.match(/^#\/regeln\/([a-z]+)$/) || [])[1] || null;

function rgZeichnen() {
  if (currentView !== 'regeln' && currentView !== 'regelnBereich') return;
  const y = window.scrollY;
  const b = rgBereich();
  const nav = `<header class="nav"><button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button><span class="nav-title"></span><span class="nav-btn"></span></header>`;
  if (!b) app.innerHTML = nav + rgUebersichtHTML();
  else {
    const titel = RG_BEREICHE.find(([k]) => k === b)[1];
    const body = { arbeitsarten: rgArbeitsartenHTML, kunden: rgKundenHTML, schreibweisen: rgSchreibHTML, ketten: rgKettenHTML }[b]();
    app.innerHTML = `${nav}<h1 class="large-title">${titel}</h1><p class="rg-intro">${RG_TEXT[b]}</p>${body}`;
  }
  window.scrollTo(0, y);
}

function rgUebersichtHTML() {
  const r = rgKopie();
  const n = {
    arbeitsarten: plural(rgAb(r, 'arbeitsart').regeln.length, 'Regel', 'Regeln'),
    kunden: plural(rgAb(r, 'kundenregeln').regeln.length, 'Regel', 'Regeln'),
    schreibweisen: plural(['kunden', 'taetigkeiten'].reduce((t, k) => t + (rgAb(r, 'schreibweisen')[k].gruppen || []).length, 0), 'Gruppe', 'Gruppen'),
    ketten: '3 Listen',
  };
  const stand = regelnServer && regelnServer.rev ? `Fassung ${regelnServer.rev} vom ${rgZeit(regelnServer.zeit)}` : 'Noch die Regeln der App – die erste Änderung lädt sie auf den Server.';
  return `<h1 class="large-title">Regeln</h1>
    <p class="rg-intro">Nach diesen Regeln erkennt die App Arbeitsarten und Kunden. Sie gelten auf allen Geräten im Team.</p>
    <div class="card rg-list">${RG_BEREICHE.map(([k, t]) => `<a class="rg-row" href="#/regeln/${k}"><span>${t}</span><span class="rg-val">${n[k]}</span>${ICON.chevronRight}</a>`).join('')}</div>
    <div class="card rg-list"><button class="rg-row" data-rg="alt"><span>Frühere Fassungen</span>${ICON.chevronRight}</button></div>
    <p class="footnote">${stand}</p>`;
}
const rgZeit = (t) => {
  const d = new Date(t);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}., ${pad(d.getHours())}:${pad(d.getMinutes())} Uhr`;
};

// ───────── Bausteine ─────────

const rgCap = (w, data, cls = '') => `<button class="rv-cap ${cls}" ${data} translate="no">${escapeHtml(w)}</button>`;
const rgPlus = (data) => `<button class="rv-cap add" ${data} aria-label="Hinzufügen">+</button>`;

/** Eingabefenster: Titel, Wert, fertig(text); liste = Vorschläge (datalist) */
function rgEingabe(titel, wert, fertig, { platzhalter = '', liste = null, ok = 'Übernehmen' } = {}) {
  const id = `rg-dl-${Date.now()}`;
  const modal = openModal(
    `<div class="alert-body"><b>${titel}</b>
      <input class="pw-input" data-rg-in value="${escapeHtml(wert || '')}" placeholder="${escapeHtml(platzhalter)}" maxlength="200" autocomplete="off" enterkeyhint="done" translate="no"${liste ? ` list="${id}"` : ''}>
      ${liste ? `<datalist id="${id}">${liste.map((x) => `<option value="${escapeHtml(x)}"></option>`).join('')}</datalist>` : ''}
    </div>
    <div class="alert-buttons"><button data-c="no">Abbrechen</button><button data-c="yes" class="strong">${ok}</button></div>`,
    'alert'
  );
  const input = modal.querySelector('[data-rg-in]');
  const go = () => {
    const v = input.value.trim();
    closeModal();
    if (v) fertig(v);
  };
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (b) b.dataset.c === 'no' ? closeModal() : go();
  });
  input.addEventListener('keydown', (e) => e.key === 'Enter' && (e.preventDefault(), go()));
  setTimeout(() => (input.focus(), input.select()), 50);
}
/** „a, b, c“ → Wörter ohne Doppelte (auch gegen vorhandene) */
const rgWoerter = (text, vorhanden = []) => {
  const have = new Set(vorhanden.map((w) => w.toLowerCase()));
  return text
    .split(',')
    .map((w) => w.trim())
    .filter((w) => w && !have.has(w.toLowerCase()) && (have.add(w.toLowerCase()), true));
};

// ───────── Arbeitsarten (Entwurf B: aufklappbare Liste) ─────────

function rgArbeitsartenHTML() {
  const ab = rgAb(rgKopie(), 'arbeitsart');
  const how = (r) => `${ab.felder[r.feld] || r.feld} ${r.wie === 'anfang' ? 'beginnt mit' : 'enthält'} · ${plural(r.woerter.length, 'Wort', 'Wörter')}`;
  return `<div class="card rg-probe">
      <div class="rg-probe-in"><input data-rg-p="site" value="${escapeHtml(rgProbe.site)}" placeholder="Baustelle" autocomplete="off" translate="no"><input data-rg-p="work" value="${escapeHtml(rgProbe.work)}" placeholder="Arbeit" autocomplete="off" translate="no"></div>
      <div class="rg-probe-out" id="rg-probe-out">${rgProbeHTML()}</div>
    </div>
    <div class="card rg-list">${ab.regeln
      .map((r, i) => {
        const open = rgOffen.has(i);
        return `<div class="rg-rule" style="--c:${RG_FARBE[r.ziel]}">
          <button class="rg-rrow" data-rg-tog="${i}"><i></i><span><b>${i + 1}. ${escapeHtml(r.titel)}</b><span class="rg-sub">${how(r)}</span></span><span class="rv-to">${escapeHtml(ab.ziele[r.ziel])}</span>${open ? ICON.chevronDown : ICON.chevronRight}</button>
          ${
            open
              ? `<div class="rg-open">
                  <div class="rv-caps">${r.woerter.map((w, wi) => rgCap(w, `data-rg-w="${i}:${wi}"`)).join('')}${rgPlus(`data-rg-wadd="${i}"`)}</div>
                  <div class="rg-sub rg-aus">Zählt nicht als Treffer</div>
                  <div class="rv-caps">${(r.ausnahmen || []).map((w, wi) => rgCap(w, `data-rg-x="${i}:${wi}"`, 'aus')).join('')}${rgPlus(`data-rg-xadd="${i}"`)}</div>
                  <button class="rg-edit" data-rg-edit="${i}">Regel bearbeiten …</button>
                </div>`
              : ''
          }
        </div>`;
      })
      .join('')}
      <div class="rg-rule rg-sonst" style="--c:var(--sep)"><div class="rg-rrow"><i></i><span class="rg-sub">Sonst</span><span class="rv-to" style="--c:var(--muted)">${escapeHtml(ab.ziele[ab.sonst])}</span><span></span></div></div>
      <button class="rg-add" data-rg="regel-neu">Regel hinzufügen</button>
    </div>`;
}
function rgProbeHTML() {
  if (!rgProbe.site.trim() && !rgProbe.work.trim()) return '<span class="rg-sub">Ausprobieren: Baustelle und Arbeit eintippen</span>';
  const res = arbeitsartGrund(rgProbe);
  const ab = rgAb(rgKopie(), 'arbeitsart');
  const kr = rgAb(rgKopie(), 'kundenregeln').regeln;
  const grund =
    res.kunde >= 0
      ? `Kunden-Regel „${escapeHtml(kr[res.kunde].kunde)}“${res.wort ? ` · ${escapeHtml(res.wort)}` : ''}`
      : res.regel >= 0
        ? `Regel ${res.regel + 1} „${escapeHtml(ab.regeln[res.regel].titel)}“ · ${escapeHtml(res.wort)}`
        : 'Keine Regel passt';
  return `<span class="rv-to" style="--c:${RG_FARBE[res.art]}">${escapeHtml(ab.ziele[res.art])}</span> <span class="rg-sub" translate="no">${grund}</span>`;
}

function rgRegelMenu(i) {
  const r = rgKopie();
  const ab = rgAb(r, 'arbeitsart');
  const g = ab.regeln[i];
  const set = (fn) => rgAendern((x) => fn(rgAb(x, 'arbeitsart').regeln, rgAb(x, 'arbeitsart')));
  actionSheet([
    { label: `Ergebnis: ${escapeHtml(ab.ziele[g.ziel])} …`, run: () => actionSheet(Object.entries(ab.ziele).filter(([k]) => k !== ab.sonst).map(([k, t]) => ({ label: escapeHtml(t), run: () => set((l) => (l[i].ziel = k)) }))) },
    { label: `Prüft: ${escapeHtml(ab.felder[g.feld])} ${g.wie === 'anfang' ? 'beginnt mit' : 'enthält'} …`, run: () => actionSheet([
      { label: 'Arbeit enthält', run: () => set((l) => Object.assign(l[i], { feld: 'arbeit', wie: 'teil' })) },
      { label: 'Baustelle enthält', run: () => set((l) => Object.assign(l[i], { feld: 'baustelle', wie: 'teil' })) },
      { label: 'Baustelle beginnt mit', run: () => set((l) => Object.assign(l[i], { feld: 'baustelle', wie: 'anfang' })) },
    ]) },
    { label: 'Umbenennen …', run: () => rgEingabe('Name der Regel', g.titel, (v) => set((l) => (l[i].titel = v))) },
    ...(i > 0 ? [{ label: 'Nach oben', run: () => (rgOffen.clear(), set((l) => l.splice(i - 1, 0, l.splice(i, 1)[0]))) }] : []),
    ...(i < ab.regeln.length - 1 ? [{ label: 'Nach unten', run: () => (rgOffen.clear(), set((l) => l.splice(i + 1, 0, l.splice(i, 1)[0]))) }] : []),
    { label: 'Regel löschen', destructive: true, run: () => confirmDialog('Regel löschen?', `„${escapeHtml(g.titel)}“ mit ${plural(g.woerter.length, 'Wort', 'Wörtern')}.`, 'Löschen', () => (rgOffen.clear(), set((l) => l.splice(i, 1))), true) },
  ]);
}
function rgWortMenu(i, wi, aus) {
  const ab = rgAb(rgKopie(), 'arbeitsart');
  const w = (aus ? ab.regeln[i].ausnahmen : ab.regeln[i].woerter)[wi];
  const set = (fn) => rgAendern((x) => fn(rgAb(x, 'arbeitsart').regeln));
  actionSheet([
    { label: `„${escapeHtml(w)}“ löschen`, destructive: true, run: () => set((l) => (aus ? l[i].ausnahmen : l[i].woerter).splice(wi, 1)) },
    ...(aus
      ? []
      : ab.regeln
          .map((r, j) => [r, j])
          .filter(([, j]) => j !== i)
          .map(([r, j]) => ({ label: `Nach ${j + 1}. ${escapeHtml(r.titel)}`, run: () => set((l) => (l[i].woerter.splice(wi, 1), l[j].woerter.push(w))) }))),
  ]);
}

// ───────── Kunden-Regeln (Entwurf A: Liste, Ergebnis rechts) ─────────

function rgKundenHTML() {
  const r = rgKopie();
  const ab = rgAb(r, 'arbeitsart');
  const kr = rgAb(r, 'kundenregeln').regeln;
  return `<div class="card rg-list">${kr
    .map((k, i) => `<button class="kr-row" data-rg-kr="${i}" style="--c:${RG_FARBE[k.ziel]}">
      <span><b translate="no">${escapeHtml(k.kunde)}</b>${k.filiale ? ` <span class="kr-fil" translate="no">${escapeHtml(k.filiale)}</span>` : rgKette(k.kunde) ? ' <span class="kr-fil">alle Filialen</span>' : ''}</span>
      <span class="rv-to">${escapeHtml(ab.ziele[k.ziel])}</span>${ICON.chevronRight}
      <span class="rv-caps">${k.woerter.length ? k.woerter.map((w) => `<span class="rv-cap" translate="no">${escapeHtml(w)}</span>`).join('') : '<span class="rg-sub">jede Arbeit</span>'}</span>
    </button>`)
    .join('')}
    <button class="rg-add" data-rg="kr-neu">Kunden-Regel hinzufügen</button></div>`;
}
/** Kunden aller Jahre (mit Ketten und Filialen) für die Auswahl */
const rgKundenListe = () => kundenFacts(null).kunden;
const rgKette = (name) => rgKundenListe().some((k) => k.chain && k.name === name);

/** Kunden-Regel bearbeiten (i = -1: neu, kunde = vorgewählter Kunde) */
function rgKundenFenster(i, kunde = '') {
  const r = rgKopie();
  const ab = rgAb(r, 'arbeitsart');
  const k = i >= 0 ? rgAb(r, 'kundenregeln').regeln[i] : { kunde, filiale: '', woerter: [], ziel: 'kundendienst' };
  const liste = rgKundenListe();
  const val = (name, fil = '') => escapeHtml(JSON.stringify([name, fil]));
  const opts = liste
    .map((c) =>
      c.chain
        ? `<optgroup label="${escapeHtml(c.name)}"><option value="${val(c.name)}">${escapeHtml(c.name)} – alle Filialen</option>${c.branches.map((b) => `<option value="${val(c.name, b.name)}">${escapeHtml(c.name)} ${escapeHtml(b.name)}</option>`).join('')}</optgroup>`
        : `<option value="${val(c.name)}">${escapeHtml(c.name)}</option>`
    )
    .join('');
  const cur = JSON.stringify([k.kunde, k.filiale || '']);
  const known = !k.kunde || liste.some((c) => c.name === k.kunde);
  const modal = openModal(
    `<div class="alert-body rg-kf"><b>Kunden-Regel</b>
      <label class="rg-kf-l">Kunde<select data-rg-kk translate="no"><option value="${val('')}">Kunde wählen …</option>${known ? '' : `<option value="${escapeHtml(cur)}">${escapeHtml(k.kunde)} ${escapeHtml(k.filiale || '')}</option>`}${opts}</select></label>
      <label class="rg-kf-l">Wörter in der Arbeit<input class="pw-input" data-rg-kw value="${escapeHtml(k.woerter.join(', '))}" placeholder="leer = jede Arbeit" autocomplete="off" translate="no"></label>
      <label class="rg-kf-l">Ergebnis<select data-rg-kz>${Object.entries(ab.ziele).filter(([z]) => z !== ab.sonst).map(([z, t]) => `<option value="${z}"${z === k.ziel ? ' selected' : ''}>${escapeHtml(t)}</option>`).join('')}</select></label>
    </div>
    <div class="alert-buttons">${i >= 0 ? '<button data-c="del" class="destructive">Löschen</button>' : '<button data-c="no">Abbrechen</button>'}<button data-c="yes" class="strong">Sichern</button></div>`,
    'alert'
  );
  const sel = modal.querySelector('[data-rg-kk]');
  sel.value = cur;
  if (sel.value !== cur) sel.selectedIndex = 0;
  modal.addEventListener('click', (e) => {
    const b = e.target.closest('[data-c]');
    if (!b) return;
    if (b.dataset.c === 'no') return closeModal();
    if (b.dataset.c === 'del') {
      closeModal();
      return rgAendern((x) => rgAb(x, 'kundenregeln').regeln.splice(i, 1));
    }
    const [name, fil] = JSON.parse(sel.value);
    if (!name) return toast('Erst einen Kunden wählen');
    const neu = { kunde: name, filiale: fil || '', woerter: rgWoerter(modal.querySelector('[data-rg-kw]').value), ziel: modal.querySelector('[data-rg-kz]').value };
    closeModal();
    rgAendern((x) => {
      const l = rgAb(x, 'kundenregeln').regeln;
      if (i >= 0) l[i] = neu;
      else l.push(neu);
    });
  });
}
/** Kunden-Seite (lang drücken, nur Admin): Kunden-Regel für diesen Kunden anlegen */
function rgKundenRegelFuer(name) {
  rgNeuKunde = name;
  location.hash = '#/regeln/kunden';
}

// ───────── Schreibweisen (Entwurf C: Umschalter, Allgemein, Gleiche Namen) ─────────

const RG_SW = {
  kunden: [
    ['gross', 'Groß-/Kleinschreibung egal', ''],
    ['akzente', 'Akzente und Umlaute egal', 'ä = a, ß = ss'],
    ['satz', 'Satzzeichen und Leerzeichen egal', '„Muster-Pizza“ = „Musterpizza“'],
    ['strasse', '„Straße“ = „Str.“', ''],
    ['hausnr', 'Hausnummern müssen gleich sein', '„Halle 3“ ≠ „Halle 4“'],
    ['ortHinten', 'Ort darf hinten fehlen', '„Muster“ = „Muster Nord“'],
    ['ortVorne', 'Ort darf vorne stehen', '„Musterstadt Muster“ = „Muster“'],
    ['komma', 'Komma', '„Muster, Nord“', [['leer', 'wie Leerzeichen'], ['ignorieren', 'Ort dahinter ignorieren']]],
    ['orteNie', 'Verschiedene Orte nie gleich', '„Muster, Nord“ ≠ „Muster, Süd“'],
    ['tipp', 'Tippfehler', '', [['aus', 'aus'], ['5', '1 ab 5 Buchstaben'], ['5/12', '1 ab 5, 2 ab 12 Buchstaben']]],
    ['artikel', 'Artikel vorne egal', '„The Muster“ = „Muster“'],
  ],
  taetigkeiten: [
    ['gross', 'Groß-/Kleinschreibung egal', ''],
    ['umlaute', 'Umlaute egal', 'ä = ae = a, ß = ss'],
    ['wortteil', 'Wortteil genügt', '„repar“ trifft „repariert“'],
    ['bindestrich', 'Bindestrich und Leerzeichen egal', '„Kühl-Zelle“ = „Kühlzelle“'],
    ['tipp', 'Tippfehler', '', [['aus', 'aus'], ['5', '1 ab 5 Buchstaben'], ['5/10', '1 ab 5, 2 ab 10 Buchstaben']]],
  ],
};
function rgSchreibHTML() {
  const sw = rgAb(rgKopie(), 'schreibweisen');
  const o = swOpt(sw, rgTab);
  const gruppen = sw[rgTab].gruppen || [];
  return `<div class="sw-seg">${[['kunden', 'Kunden'], ['taetigkeiten', 'Tätigkeiten']].map(([k, t]) => `<button class="${rgTab === k ? 'on' : ''}" data-rg-tab="${k}">${t}</button>`).join('')}</div>
    <h2 class="section-title">Allgemein</h2>
    <div class="card rg-list">${RG_SW[rgTab]
      .map(([key, t, sub, wahl]) =>
        wahl
          ? `<button class="sa-row" data-rg-wahl="${key}"><span>${t}${sub ? `<small>${sub}</small>` : ''}</span><span class="rg-val">${(wahl.find(([v]) => v === String(o[key])) || [, o[key]])[1]}</span>${ICON.chevronRight}</button>`
          : `<label class="sa-row"><span>${t}${sub ? `<small>${sub}</small>` : ''}</span><input type="checkbox" class="toggle" data-rg-sw="${key}" ${o[key] ? 'checked' : ''}></label>`
      )
      .join('')}</div>
    <h2 class="section-title">Gleiche Namen</h2>
    <div class="card rg-list">${gruppen
      .map((g, gi) => `<div class="sw-row"><button class="rg-gname" data-rg-g="${gi}" translate="no">${escapeHtml(g.name)}</button><div class="rv-caps">${(g.auch || []).map((a, ai) => rgCap(a, `data-rg-ga="${gi}:${ai}"`)).join('')}${rgPlus(`data-rg-gadd="${gi}"`)}</div></div>`)
      .join('')}
      <button class="rg-add" data-rg="g-neu">Gruppe hinzufügen</button></div>`;
}
const rgSw = (fn) => rgAendern((x) => fn(rgAb(x, 'schreibweisen')[rgTab]));
const rgNamenListe = () => (rgTab === 'kunden' ? rgKundenListe().map((k) => k.name) : null);

// ───────── Ketten (drei Wortlisten) ─────────

const RG_KETTEN = [
  ['kettenwoerter', 'Bilden keine Kette', 'Branche, Rechtsform, Füllwörter – ganze Wörter.'],
  ['artikel', 'Artikel vorne', 'Am Anfang eines Namens übersprungen.'],
  ['strassen', 'Straßen', 'Wörter mit diesen Enden bilden keine Kette.'],
];
function rgKettenHTML() {
  const r = rgKopie();
  return RG_KETTEN.map(
    ([id, t, sub]) => `<h2 class="section-title">${t}</h2><div class="card rg-wl"><p class="rg-sub">${sub}</p><div class="rv-caps">${rgAb(r, id)
      .woerter.map((w, wi) => rgCap(w, `data-rg-kw2="${id}:${wi}"`))
      .join('')}${rgPlus(`data-rg-kwadd="${id}"`)}</div></div>`
  ).join('');
}

// ───────── Bedienung ─────────

document.addEventListener('click', (e) => {
  if (e.target.closest?.('[data-rg-open]')) return (location.hash = '#/regeln');
  if (currentView !== 'regeln' && currentView !== 'regelnBereich') return;
  const el = e.target.closest('button, [data-rg-tog]');
  if (!el) return;
  const d = el.dataset;
  if (d.rg === 'alt') rgFruehere();
  else if (d.rgTog != null) {
    const i = Number(d.rgTog);
    if (rgOffen.has(i)) rgOffen.delete(i);
    else rgOffen.add(i);
    rgZeichnen();
  } else if (d.rgEdit != null) rgRegelMenu(Number(d.rgEdit));
  else if (d.rgW) rgWortMenu(...d.rgW.split(':').map(Number), false);
  else if (d.rgX) rgWortMenu(...d.rgX.split(':').map(Number), true);
  else if (d.rgWadd != null || d.rgXadd != null) {
    const i = Number(d.rgWadd ?? d.rgXadd);
    const aus = d.rgXadd != null;
    rgEingabe(aus ? 'Ausnahmen hinzufügen' : 'Wörter hinzufügen', '', (v) =>
      rgAendern((x) => {
        const g = rgAb(x, 'arbeitsart').regeln[i];
        const l = aus ? (g.ausnahmen ||= []) : g.woerter;
        l.push(...rgWoerter(v, l));
      }), { platzhalter: 'mehrere mit Komma' });
  } else if (d.rg === 'regel-neu')
    rgEingabe('Neue Regel', '', (v) =>
      rgAendern((x) => {
        const ab = rgAb(x, 'arbeitsart');
        ab.regeln.push({ titel: v, ziel: 'baustelle', feld: 'arbeit', wie: 'teil', hinweis: '', woerter: [], ausnahmen: [] });
        rgOffen.add(ab.regeln.length - 1);
      }), { platzhalter: 'Name' });
  else if (d.rgKr != null) rgKundenFenster(Number(d.rgKr));
  else if (d.rg === 'kr-neu') rgKundenFenster(-1);
  else if (d.rgTab) {
    rgTab = d.rgTab;
    rgZeichnen();
  } else if (d.rgWahl) {
    const [, t, , wahl] = RG_SW[rgTab].find(([k]) => k === d.rgWahl);
    const cur = swOpt(rgAb(rgKopie(), 'schreibweisen'), rgTab)[d.rgWahl];
    actionSheet(wahl.map(([v, l]) => ({ label: `${l}${String(cur) === v ? ` <span class="ovc-check">${ICON.check}</span>` : ''}`, run: () => rgSw((s) => ((s.allgemein ||= {})[d.rgWahl] = v)) })));
  } else if (d.rgG != null) {
    const gi = Number(d.rgG);
    const g = rgAb(rgKopie(), 'schreibweisen')[rgTab].gruppen[gi];
    actionSheet([
      { label: 'Umbenennen …', run: () => rgEingabe('Name', g.name, (v) => rgSw((s) => (s.gruppen[gi].name = v)), { liste: rgNamenListe() }) },
      { label: 'Gruppe löschen', destructive: true, run: () => rgSw((s) => s.gruppen.splice(gi, 1)) },
    ]);
  } else if (d.rgGa) {
    const [gi, ai] = d.rgGa.split(':').map(Number);
    const w = rgAb(rgKopie(), 'schreibweisen')[rgTab].gruppen[gi].auch[ai];
    actionSheet([{ label: `„${escapeHtml(w)}“ löschen`, destructive: true, run: () => rgSw((s) => s.gruppen[gi].auch.splice(ai, 1)) }]);
  } else if (d.rgGadd != null) {
    const gi = Number(d.rgGadd);
    rgEingabe('Andere Schreibweisen', '', (v) => rgSw((s) => (s.gruppen[gi].auch ||= []).push(...rgWoerter(v, [s.gruppen[gi].name, ...(s.gruppen[gi].auch || [])]))), {
      platzhalter: 'mehrere mit Komma',
      liste: rgNamenListe(),
    });
  } else if (d.rg === 'g-neu')
    rgEingabe(rgTab === 'kunden' ? 'Kunde' : 'Tätigkeit', '', (v) => rgSw((s) => (s.gruppen ||= []).push({ name: v, auch: [] })), { liste: rgNamenListe() });
  else if (d.rgKw2) {
    const [id, wi] = d.rgKw2.split(':');
    const w = rgAb(rgKopie(), id).woerter[Number(wi)];
    actionSheet([{ label: `„${escapeHtml(w)}“ löschen`, destructive: true, run: () => rgAendern((x) => rgAb(x, id).woerter.splice(Number(wi), 1)) }]);
  } else if (d.rgKwadd) {
    const id = d.rgKwadd;
    rgEingabe('Wörter hinzufügen', '', (v) => rgAendern((x) => rgAb(x, id).woerter.push(...rgWoerter(v, rgAb(x, id).woerter))), { platzhalter: 'mehrere mit Komma' });
  }
});
document.addEventListener('change', (e) => {
  const t = e.target.closest?.('[data-rg-sw]');
  if (!t || currentView !== 'regelnBereich') return;
  rgSw((s) => ((s.allgemein ||= {})[t.dataset.rgSw] = t.checked));
});
document.addEventListener('input', (e) => {
  const t = e.target.closest?.('[data-rg-p]');
  if (!t) return;
  rgProbe[t.dataset.rgP] = t.value;
  const out = document.getElementById('rg-probe-out');
  if (out) out.innerHTML = rgProbeHTML();
});

/** Frühere Fassungen (Server behält die letzten 20): wählen → zurückholen */
async function rgFruehere() {
  let alt;
  try {
    alt = (await adminRequest('GET', '/regeln-alt')).alt || [];
  } catch {
    return toast('Keine Verbindung');
  }
  if (!alt.length) return toast('Noch keine früheren Fassungen');
  actionSheet(
    alt.map((a) => ({
      label: `Fassung ${a.rev} · ${rgZeit(a.zeit)}`,
      run: () =>
        confirmDialog('Fassung zurückholen?', `Die Regeln von ${rgZeit(a.zeit)} gelten dann wieder für alle im Team.`, 'Zurückholen', () =>
          rgAendern((x) => (x.arbeitsarten = rgClone(a.regeln.arbeitsarten)))
        ),
    }))
  );
}
