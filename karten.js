// Übersicht: eine große Karte (immer mit Diagramm) und drei kleine Karten. Den Inhalt jeder Karte wählt man durch
// langes Drücken auf die Karte; die Anordnung bleibt fest. Auswahl in settings.ovCards, Urlaubsanspruch in
// settings.vacationDays. Wird vor app.js geladen und nutzt dessen Funktionen erst beim Zeichnen.

const OVC_DEFAULT = { big: 'urlaub', small: ['krank', 'ueber', 'schnitt'] };
const ovcChoice = () => ({ ...OVC_DEFAULT, ...settings.ovCards, small: [...(settings.ovCards?.small || OVC_DEFAULT.small)] });

/** Alles, was die Karten für ein Jahr brauchen – einmal pro Zeichnen berechnet */
function ovcFacts(year) {
  const today = startOfDay(new Date());
  const now = new Date();
  const f = {
    year,
    urlaub: 0,
    urlaubPlan: 0,
    krank: 0,
    krankDates: [],
    feiertag: 0,
    workDays: 0,
    workedNet: 0,
    sites: new Set(),
    m: [...Array(12)].map(() => ({ worked: 0, ot: 0, urlaub: 0, urlaubPlan: 0, krank: 0, net: null })),
  };
  for (const s of sheets) {
    s.days.forEach((d, i) => {
      if (!sheetIsActive(s, i)) return;
      const date = sheetDate(s, i);
      if (date.getFullYear() !== year) return;
      const mo = f.m[date.getMonth()];
      if (d.status === 'urlaub') {
        if (date > today) (f.urlaubPlan++, mo.urlaubPlan++);
        else (f.urlaub++, mo.urlaub++);
      } else if (d.status === 'krank') {
        f.krank++;
        mo.krank++;
        f.krankDates.push(date);
      } else if (d.status === 'feiertag' && i < 5 && date <= today) f.feiertag++; // wie Arbeitstage nur bis heute
      if (canWork(d)) for (const r of d.rows) if (r.site) f.sites.add(r.site.trim().toLowerCase());
      if (!d.status && date <= today && d.rows.some((r) => r.start != null && r.end != null)) {
        f.workDays++;
        f.workedNet += workedNet(d);
      }
    });
  }
  // Krankmeldungen: zusammenhängende Krankheitstage (Wochenenden und Feiertage dazwischen unterbrechen nicht)
  f.krankDates.sort((a, b) => a - b);
  f.krankSpells = f.krankDates.filter((d, k) => {
    if (!k) return true;
    for (let x = addDays(f.krankDates[k - 1], 1); x < d; x = addDays(x, 1)) if (x.getDay() % 6 && !holidayName(x)) return true;
    return false;
  }).length;
  const acc = overtimeAccounts();
  const worked = acc.worked.get(year) || new Map();
  const months = acc.ot.get(year) || new Map();
  const counted = countedOvertime(year, months);
  worked.forEach((v, k) => (f.m[k - 1].worked = v));
  counted.forEach((v, k) => Object.assign(f.m[k - 1], { ot: v, counted: true }));
  f.total = yearBalance(worked);
  f.ot = yearBalance(counted);
  // Netto nur für vollständige, abgeschlossene Monate (wie in der Jahresübersicht)
  const lastDone = year < now.getFullYear() ? 12 : year === now.getFullYear() ? now.getMonth() : 0;
  f.net = null;
  if (hasWage())
    for (let k = 1; k <= lastDone; k++) {
      if (!worked.has(k) || monthGaps(year, k).length) continue;
      const p = monthPay(year, k, months.get(k) || 0);
      if (!p) continue;
      f.m[k - 1].net = p.netto;
      f.net = (f.net || 0) + p.netto;
    }
  // Gesetzliche Feiertage Mo–Fr im ganzen Jahr
  f.holidays = 0;
  for (let x = new Date(year, 0, 1); x.getFullYear() === year; x = addDays(x, 1)) if (x.getDay() % 6 && holidayName(x)) f.holidays++;
  f.anspruch = Math.max(0, Math.round(parseNum(settings.vacationDays)));
  f.rest = f.anspruch - f.urlaub - f.urlaubPlan;
  return f;
}

const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;
/** Euro ohne Cent mit Tausenderpunkt */
const ovcEuro = (v) => `${Math.round(v).toLocaleString('de-DE')} €`;

/** Kleine Karten: Titel, Zahl (mit kleiner Einheit), Farbe der Zahl, Zeile darunter */
const OVC_SMALL = {
  krank: { label: 'Krankheitstage', get: (f) => ({ num: fmtNum(f.krank), cls: 'sick', sub: plural(f.krankSpells, 'Krankmeldung', 'Krankmeldungen') }) },
  ueber: { label: 'Überstunden', get: (f) => ({ num: fmtSigned(f.ot).replace(' h', ''), unit: 'h', cls: balanceClass(f.ot), sub: 'Saldo' }) },
  schnitt: {
    label: 'Ø pro Tag',
    get: (f) => ({ num: fmtDec(f.workDays ? f.workedNet / f.workDays : 0), unit: 'h', sub: 'netto' }),
  },
  urlaub: {
    label: 'Urlaub',
    get: (f) => ({ num: fmtNum(f.urlaub), cls: 'vac', sub: f.anspruch ? `${fmtNum(Math.max(0, f.rest))} übrig` : 'Tage genommen' }),
  },
  stunden: { label: 'Stunden', get: (f) => ({ num: fmtDec(f.total), unit: 'h', sub: 'gesamt' }) },
  tage: { label: 'Arbeitstage', get: (f) => ({ num: fmtNum(f.workDays), sub: 'gearbeitet' }) },
  feiertage: { label: 'Feiertage', get: (f) => ({ num: fmtNum(f.holidays), cls: 'hol', sub: 'Mo–Fr' }) },
  netto: { label: 'Netto', wage: true, get: (f) => ({ num: f.net == null ? '–' : ovcEuro(f.net), sub: 'geschätzt' }) },
  baustellen: { label: 'Baustellen', get: (f) => ({ num: fmtNum(f.sites.size), sub: 'verschiedene' }) },
};

/** Anfangsbuchstabe des Monats in der angezeigten Sprache (die Übersetzung kennt einzelne Buchstaben nicht) */
const monthLetter = (k) => (typeof tr === 'function' ? tr(MONTHS[k]) : MONTHS[k]).charAt(0);

/** Ring aus Abschnitten [{ v, cls }]; Abschnitte zeichnen sich nacheinander im Uhrzeigersinn */
function ovcDonut(parts, center, label) {
  const sum = parts.reduce((a, p) => a + p.v, 0) || 1;
  let at = 0;
  const arcs = parts
    .filter((p) => p.v > 0)
    .map((p, k) => {
      const len = (p.v / sum) * 100;
      const el = `<circle class="ovc-arc ${p.cls}" cx="66" cy="66" r="52" pathLength="100"
        style="stroke-dasharray:${len} 100;stroke-dashoffset:${-at};--d:${k * 160}ms"></circle>`;
      at += len;
      return el;
    })
    .join('');
  return `<div class="ovc-donut">
    <svg viewBox="0 0 132 132"><circle class="ovc-track" cx="66" cy="66" r="52"></circle>${arcs}</svg>
    <div class="ovc-donut-c"><b class="ovc-count">${center}</b><span>${label}</span></div>
  </div>`;
}

/**
 * Säulen je Monat: cols = 12 × { v, cls, plan, segs } (null = noch nichts). Werte stehen über (bzw. bei negativen
 * Werten unter) der Säule; mit negativen Werten liegt die Nulllinie so, dass beide Richtungen Platz haben.
 */
function ovcBars(cols, fmt) {
  const up = Math.max(0, ...cols.map((c) => (c ? Math.max(0, c.v) + (c.plan || 0) : 0)));
  const dn = Math.max(0, ...cols.map((c) => (c ? Math.max(0, -c.v) : 0)));
  const span = up + dn || 1;
  const top = dn ? (up / span) * 100 : 100;
  // Höhe einer Säule in ihrem Bereich (über bzw. unter der Nulllinie) – ein Bereich ohne Werte bleibt leer
  const upH = (v) => (up ? (Math.abs(v) / up) * 100 : 0);
  const dnH = (v) => (dn ? (Math.abs(v) / dn) * 100 : 0);
  return `<div class="ovc-bars">
    ${cols
      .map((c, k) => {
        const v = c?.v || 0;
        const plan = c?.plan || 0;
        const val = v || plan ? `<span class="ovc-val">${fmt(v + plan)}</span>` : '';
        const segs = (c?.segs || [{ v, cls: c?.cls }]).filter((x) => x.v);
        const bars = (h) => segs.map((x) => `<i class="ovc-bar ${x.cls || ''}" style="height:${h(x.v)}%"></i>`).join('');
        return `<div class="ovc-col" style="--i:${k}"><div class="ovc-plot">
          <div class="ovc-up" style="height:${top}%">
            ${v >= 0 ? val : ''}${plan ? `<i class="ovc-bar plan" style="height:${upH(plan)}%"></i>` : ''}${v > 0 ? bars(upH) : ''}${!v && !plan ? '<i class="ovc-bar ovc-none"></i>' : ''}
          </div>
          ${dn ? `<div class="ovc-dn" style="height:${100 - top}%">${v < 0 ? bars(dnH) + val : ''}</div>` : ''}
          </div><span class="ovc-m" translate="no">${monthLetter(k)}</span>
        </div>`;
      })
      .join('')}
  </div>`;
}

const legend = (items) =>
  `<div class="ovc-legend">${items.map(([cls, t]) => `<span><i class="ovc-dot ${cls}"></i>${t}</span>`).join('')}</div>`;

/** Bis zu welchem Monat (0–12) Werte stehen können: im laufenden Jahr bis zum laufenden Monat */
const ovcLastMonth = (year) => {
  const now = new Date();
  return year < now.getFullYear() ? 12 : year > now.getFullYear() ? 0 : now.getMonth() + 1;
};
/** Kopf der Säulen-Karten: Titel links, rechts der Durchschnitt je Monat („Ø 166,10 h“; ohne Werte „–“) */
function ovcAvgHead(title, vals, fmt, cls = () => '') {
  const avg = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  return `<div class="ovc-head"><span class="ovc-title">${title}</span><b class="ovc-count ${avg == null ? '' : cls(avg)}"><span class="ovc-avg">Ø</span> ${avg == null ? '–' : fmt(avg)}</b></div>`;
}
const hrsShort = (min) => fmtNum(Math.round(min / 6) / 10);

/** Große Karten: Titel (im Auswahlmenü), Inhalt */
const OVC_BIG = {
  urlaub: {
    label: 'Urlaub',
    html: (f) => {
      const over = f.rest < 0;
      return `<div class="ovc-vac">
        ${ovcDonut(
          [
            { v: f.urlaub, cls: 'vac' },
            { v: f.urlaubPlan, cls: 'vac-plan' },
            { v: Math.max(0, f.rest), cls: 'rest' },
          ],
          f.anspruch ? fmtNum(Math.abs(f.rest)) : fmtNum(f.urlaub),
          f.anspruch ? (over ? 'Tage zu viel' : 'Tage übrig') : 'Tage genommen'
        )}
        <div class="ovc-vac-r">
          <div class="ovc-title">Urlaub</div>
          <div class="ovc-lines">
            <div><i class="ovc-dot vac"></i>Genommen<b class="ovc-count">${fmtNum(f.urlaub)}</b></div>
            <div><i class="ovc-dot vac-plan"></i>Geplant<b class="ovc-count">${fmtNum(f.urlaubPlan)}</b></div>
            ${f.anspruch ? `<div><i class="ovc-dot rest"></i>Übrig<b class="ovc-count">${fmtNum(Math.max(0, f.rest))}</b></div>` : ''}
          </div>
          <div class="ovc-foot">${f.anspruch ? `Anspruch ${f.anspruch} Tage` : 'Kein Anspruch eingetragen'}</div>
        </div>
      </div>`;
    },
  },
  ueber: {
    label: 'Überstunden pro Monat',
    html: (f) => {
      const last = ovcLastMonth(f.year);
      return `${ovcAvgHead('Überstunden', f.m.filter((m) => m.counted).map((m) => m.ot), (v) => fmtSigned(Math.round(v)), (v) => balanceClass(Math.round(v)))}
        ${ovcBars(
          f.m.map((m, k) => (k < last ? { v: m.ot, cls: m.ot < 0 ? 'minus' : 'plus' } : null)),
          (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + hrsShort(Math.abs(v))
        )}`;
    },
  },
  stunden: {
    label: 'Stunden pro Monat',
    html: (f) => {
      const last = ovcLastMonth(f.year);
      // Durchschnitt ohne den laufenden Monat (der ist erst teilweise gearbeitet)
      const done = f.year === new Date().getFullYear() ? last - 1 : last;
      return `${ovcAvgHead('Stunden', f.m.slice(0, done).filter((m) => m.worked > 0).map((m) => m.worked), (v) => fmtH(Math.round(v)))}
        ${ovcBars(f.m.map((m, k) => (k < last ? { v: m.worked, cls: 'acc' } : null)), (v) => fmtNum(Math.round(v / 60)))}`;
    },
  },
  abwesenheit: {
    label: 'Abwesenheit pro Monat',
    html: (f) => `${ovcAvgHead('Abwesenheit', f.m.slice(0, ovcLastMonth(f.year)).map((m) => m.urlaub + m.krank), (v) => plural(Math.round(v * 10) / 10, 'Tag', 'Tage'))}
      ${ovcBars(
        f.m.map((m) => ({ v: m.urlaub + m.krank, plan: m.urlaubPlan, segs: [{ v: m.krank, cls: 'sick' }, { v: m.urlaub, cls: 'vac' }] })),
        (v) => fmtNum(v)
      )}
      ${legend([['vac', 'Urlaub'], ['sick', 'Krank'], ['plan', 'Geplant']])}`,
  },
  tagesarten: {
    label: 'Tagesarten',
    html: (f) => {
      const parts = [
        { v: f.workDays, cls: 'acc', t: 'Arbeit' },
        { v: f.urlaub, cls: 'vac', t: 'Urlaub' },
        { v: f.krank, cls: 'sick', t: 'Krank' },
        { v: f.feiertag, cls: 'hol', t: 'Feiertag' },
      ];
      return `<div class="ovc-vac">
        ${ovcDonut(parts, fmtNum(parts.reduce((a, p) => a + p.v, 0)), 'Tage')}
        <div class="ovc-vac-r">
          <div class="ovc-title">Tagesarten</div>
          <div class="ovc-lines">${parts.map((p) => `<div><i class="ovc-dot ${p.cls}"></i>${p.t}<b class="ovc-count">${fmtNum(p.v)}</b></div>`).join('')}</div>
        </div>
      </div>`;
    },
  },
  netto: {
    label: 'Netto pro Monat',
    wage: true,
    html: (f) => `${ovcAvgHead('Netto', f.m.filter((m) => m.net != null).map((m) => m.net), ovcEuro)}
      ${ovcBars(f.m.map((m) => (m.net == null ? null : { v: m.net, cls: 'ok' })), (v) => fmtNum(Math.round(v / 100) / 10).replace(/,0$/, '') + 'k')}`,
  },
};

function ovcSmallHTML(key, f, slot) {
  const def = OVC_SMALL[key] || OVC_SMALL.krank;
  const v = def.get(f);
  return `<div class="ovc ovc-s" data-ovc="s${slot}" data-k="${key}">
    <span class="ovc-label">${def.label}</span>
    <b class="ovc-num ovc-count ${v.cls || ''}">${v.num}${v.unit ? `<small>${v.unit}</small>` : ''}</b>
    <span class="ovc-sub">${v.sub}</span>
  </div>`;
}

function ovcBigHTML(key, f) {
  const def = OVC_BIG[key] || OVC_BIG.urlaub;
  return `<div class="ovc ovc-big ovc-${key}" data-ovc="big" data-k="${key}">${def.html(f)}</div>`;
}

/** Karten der Übersicht für ein Jahr */
function ovcCardsHTML(year) {
  const c = ovcChoice();
  const f = ovcFacts(year);
  return `<div class="ovc-wrap">
    ${ovcBigHTML(c.big, f)}
    <div class="ovc-row">${c.small.map((k, i) => ovcSmallHTML(k, f, i)).join('')}</div>
  </div>`;
}

/** Lange Zahlen in den kleinen Karten verkleinern, bis sie in die Karte passen */
function ovcFit(root) {
  root.querySelectorAll('.ovc-num').forEach((el) => {
    el.style.fontSize = '';
    for (let size = 26; size > 15 && el.scrollWidth > el.clientWidth; size--) el.style.fontSize = `${size}px`;
  });
}

// ───────── Animation: Zahlen zählen hoch (von 0 bzw. vom vorigen Wert) ─────────

// Vorzeichen (+, − oder -) direkt vor der Zahl gehört zum Wert, damit z. B. „+2,00“ → „−3,00“ über null zählt
const ovcNumRe = /^(\D*?)([+−-]?)(\d[\d.]*(?:,\d+)?)(.*)$/s;
const ovcParse = (t) => {
  const m = t.match(ovcNumRe);
  if (!m) return null;
  const n = parseFloat(m[3].replace(/\./g, '').replace(',', '.'));
  return { pre: m[1], signed: !!m[2], n: m[2] === '−' || m[2] === '-' ? -n : n, dec: (m[3].split(',')[1] || '').length, dots: m[3].includes('.'), post: m[4] };
};
/** Zahl-Element hochzählen lassen; `from` = voriger Text (sonst 0). Kleine Einheiten (<small>) bleiben stehen. */
function ovcCount(el, from, delay = 0) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const node = [...el.childNodes].find((n) => n.nodeType === 3 && /\d/.test(n.textContent));
  if (!node) return;
  const b = ovcParse(node.textContent);
  const a = from != null ? ovcParse(from) : null;
  if (!b) return;
  const start0 = a ? a.n : 0;
  if (start0 === b.n) return;
  const signed = b.signed || !!a?.signed;
  const end = node.textContent;
  const fmt = (v) => {
    const s = Math.abs(v).toFixed(b.dec);
    const [i, d] = s.split('.');
    const sign = !signed || !Number(s) ? (v < 0 && Number(s) ? '-' : '') : v > 0 ? '+' : '−';
    return b.pre + sign + (b.dots ? Number(i).toLocaleString('de-DE') : i) + (d ? `,${d}` : '') + b.post;
  };
  node.textContent = fmt(start0);
  const t0 = performance.now() + delay;
  const dur = 700;
  const step = (now) => {
    const u = Math.max(0, Math.min(1, (now - t0) / dur));
    // am Ende genau der ursprüngliche Text (Schreibweise der Null, Vorzeichen)
    node.textContent = u < 1 ? fmt(start0 + (b.n - start0) * (1 - Math.pow(1 - u, 3))) : end;
    if (u < 1 && node.isConnected) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** Texte der Zahlen je Karte merken (für das Zählen vom alten zum neuen Wert) */
function ovcSnapshot(root = document) {
  const m = new Map();
  root.querySelectorAll('[data-ovc]').forEach((card) => {
    const nums = [...card.querySelectorAll('.ovc-count')].map((e) => [...e.childNodes].find((n) => n.nodeType === 3)?.textContent ?? '');
    m.set(`${card.dataset.ovc}:${card.dataset.k}`, nums);
  });
  return m;
}
function ovcAnimate(cards, snap = null, delay = 0) {
  cards.forEach((card) => {
    const before = snap?.get(`${card.dataset.ovc}:${card.dataset.k}`);
    card.querySelectorAll('.ovc-count').forEach((el, i) => ovcCount(el, before ? before[i] ?? null : null, delay));
  });
}

// ───────── Inhalt wählen: lange auf eine Karte drücken ─────────

const OVC_HOLD = 450;
let ovcPress = null; // { card, x, y, timer }
let ovcSuppressClick = false;

function ovcPressEnd() {
  if (!ovcPress) return;
  clearTimeout(ovcPress.timer);
  ovcPress.card.classList.remove('pressing');
  ovcPress = null;
}
document.addEventListener('pointerdown', (e) => {
  const card = e.target.closest?.('[data-ovc]');
  if (!card || e.button > 0) return;
  ovcPressEnd();
  card.classList.add('pressing');
  ovcPress = { card, x: e.clientX, y: e.clientY, timer: setTimeout(() => {
    const c = card;
    ovcPressEnd();
    ovcSuppressClick = true;
    setTimeout(() => (ovcSuppressClick = false), 600);
    c.classList.add('picked');
    setTimeout(() => c.classList.remove('picked'), 300);
    ovcPick(c.dataset.ovc);
  }, OVC_HOLD) };
});
document.addEventListener('pointermove', (e) => {
  if (ovcPress && Math.hypot(e.clientX - ovcPress.x, e.clientY - ovcPress.y) > 10) ovcPressEnd();
});
['pointerup', 'pointercancel'].forEach((t) => document.addEventListener(t, ovcPressEnd));
window.addEventListener('scroll', ovcPressEnd, { passive: true });
document.addEventListener('click', (e) => {
  if (ovcSuppressClick && e.target.closest?.('[data-ovc]')) (e.preventDefault(), e.stopPropagation());
}, true);
document.addEventListener('contextmenu', (e) => {
  if (e.target.closest?.('[data-ovc]')) e.preventDefault();
});

/** Auswahlmenü für eine Karte („big“ oder „s0“–„s2“) */
function ovcPick(slot) {
  const c = ovcChoice();
  const big = slot === 'big';
  const defs = big ? OVC_BIG : OVC_SMALL;
  const current = big ? c.big : c.small[Number(slot.slice(1))];
  const keys = Object.keys(defs).filter((k) => !defs[k].wage || hasWage());
  const actions = keys.map((k) => ({
    label: `${defs[k].label}${k === current ? ` <span class="ovc-check">${ICON.check}</span>` : ''}`,
    run: () => ovcSet(slot, k),
  }));
  if (current === 'urlaub')
    actions.push({ label: `<span class="muted">Urlaubsanspruch: ${Math.round(parseNum(settings.vacationDays))} Tage …</span>`, run: ovcAskAnspruch });
  actionSheet(actions);
}

function ovcSet(slot, key) {
  const c = ovcChoice();
  if (slot === 'big') c.big = key;
  else c.small[Number(slot.slice(1))] = key;
  settings.ovCards = c;
  saveSettings();
  ovcRefresh(slot, true);
}

function ovcAskAnspruch() {
  const values = [...Array(41).keys()];
  wheelPicker('Urlaubsanspruch', [{ values, label: (v) => `${v} Tage` }], [Math.round(parseNum(settings.vacationDays))], ([v]) => {
    settings.vacationDays = v;
    saveSettings();
    ovcRefresh(null, false);
  });
}

/** Karten neu zeichnen; `slot` + `swap`: diese Karte wechselt sichtbar den Inhalt */
function ovcRefresh(slot, swap) {
  const wrap = document.querySelector('.ovc-wrap');
  if (!wrap) return;
  const snap = ovcSnapshot(wrap);
  const tmp = document.createElement('div');
  tmp.innerHTML = ovcCardsHTML(statsYear ?? new Date().getFullYear());
  const fresh = tmp.firstElementChild;
  // Nur geänderte Karten ersetzen, damit die anderen ruhig stehen bleiben
  fresh.querySelectorAll('[data-ovc]').forEach((card) => {
    const old = wrap.querySelector(`[data-ovc="${card.dataset.ovc}"]`);
    if (!old || old.outerHTML === card.outerHTML) return;
    const swapped = swap && card.dataset.ovc === slot;
    const key = `${card.dataset.ovc}:${card.dataset.k}`;
    if (swapped) card.classList.add('ovc-swap');
    old.replaceWith(card);
    ovcFit(card);
    ovcAnimate([card], swapped ? null : new Map([[key, snap.get(key)]]), 0);
  });
}
