// Übersicht: eine große Karte (immer mit Diagramm) und drei kleine Karten. Den Inhalt jeder Karte wählt man durch
// langes Drücken auf die Karte; die Anordnung bleibt fest. Auswahl in settings.ovCards, Urlaubsanspruch in
// settings.vacationDays. Wird vor app.js geladen und nutzt dessen Funktionen erst beim Zeichnen.

const OVC_DEFAULT = { big: 'urlaub', small: ['krank', 'ueber', 'schnitt'] };
/** Gewählte Karten; nicht mehr vorhandene kleine Karten (Stunden, Arbeitstage … bis v114) → die erste freie Vorgabe */
const ovcChoice = () => {
  const c = { ...OVC_DEFAULT, ...settings.ovCards, small: [...(settings.ovCards?.small || OVC_DEFAULT.small)] };
  c.small.forEach((k, i) => {
    if (!OVC_SMALL[k]) c.small[i] = Object.keys(OVC_SMALL).find((x) => !c.small.includes(x)) || OVC_DEFAULT.small[i];
  });
  return c;
};

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
    m: [...Array(12)].map(() => ({ worked: 0, ot: 0, urlaub: 0, urlaubPlan: 0, krank: 0, net: null })),
  };
  for (const s of sheets) {
    s.days.forEach((d, i) => {
      if (!sheetIsActive(s, i)) return;
      const date = sheetDate(s, i);
      if (date.getFullYear() !== year) return;
      const mo = f.m[date.getMonth()];
      const kind = absenceKind(s, i);
      if (kind === 'urlaub') {
        if (date > today) (f.urlaubPlan++, mo.urlaubPlan++);
        else (f.urlaub++, mo.urlaub++);
      } else if (kind === 'krank') {
        // Krankheitstage erst an ihrem Tag
        if (date > today) return;
        f.krank++;
        mo.krank++;
        f.krankDates.push(date);
      } else if ((d.status === 'feiertag' || ((d.status === 'urlaub' || d.status === 'krank') && !kind)) && i < 5 && date <= today) {
        // wie Arbeitstage nur bis heute; Urlaub/Krank an einem Feiertag zählt als Feiertag (wie im Lohnvergleich)
        f.feiertag++;
      }
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
  worked.forEach((v, k) => (f.m[k - 1].worked = v));
  months.forEach((v, k) => (f.m[k - 1].ot = v));
  // Vollständig (done): abgeschlossener Monat mit Zetteln und ohne Werktag ohne Eintrag. Nur diese zählen in die
  // Durchschnitte; die übrigen (auch der laufende) haben graue Säulen
  const cur = year === now.getFullYear() ? now.getMonth() + 1 : 0;
  for (let k = 1; k <= ovcLastMonth(year); k++) {
    const m = f.m[k - 1];
    m.done = k !== cur && worked.has(k) && !monthGaps(year, k).length;
    m.gap = !m.done;
  }
  const done = f.m.filter((m) => m.done);
  const avg = (list) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : null);
  f.avgWorked = avg(done.map((m) => m.worked));
  f.avgOt = avg(done.map((m) => m.ot));
  f.avgAbsence = avg(done.map((m) => m.urlaub + m.krank));
  // Überstunden-Saldo wie die Summe der Monatsliste: vollständige Monate und der laufende
  f.ot = yearBalance(countedOvertime(year, months));
  // Netto nur für vollständige Monate (wie in der Jahresübersicht); der laufende Monat bekommt die Hochrechnung wie
  // die Seite des Monats (restliche Werktage mit Soll) – sie zählt in keine Rechnung
  if (hasWage()) {
    for (let k = 1; k <= 12; k++) {
      if (!f.m[k - 1].done) continue;
      const p = monthPay(year, k, months.get(k) || 0);
      if (p) f.m[k - 1].net = p.netto;
    }
    if (cur) {
      const { missing, planMinus } = monthHoursSplit(year, cur);
      const p = monthPay(year, cur, months.get(cur) || 0, missing.length * settings.hoursPerDay * 60 + planMinus);
      if (p) f.m[cur - 1].netProj = p.netto;
    }
  }
  f.avgNet = avg(f.m.filter((m) => m.net != null).map((m) => m.net));
  f.anspruch = Math.max(0, Math.round(parseNum(settings.vacationDays)));
  f.rest = f.anspruch - f.urlaub - f.urlaubPlan;
  f.kd = kundenFacts(year); // Arbeitsarten und Kunden (kunden.js)
  return f;
}

const plural = (n, one, many) => `${fmtNum(n)} ${n === 1 ? one : many}`;
/** Euro ohne Cent mit Tausenderpunkt */
const ovcEuro = (v) => `${Math.round(v).toLocaleString('de-DE')} €`;

/** Kleine Karten: Titel, Zahl (mit kleiner Einheit), Farbe der Zahl, Zeile darunter; menu: Name im Auswahlmenü.
 *  Durchschnitte je Monat nur aus vollständigen Monaten (ohne den laufenden) */
const OVC_SMALL = {
  krank: { label: 'Krankheitstage', get: (f) => ({ num: fmtNum(f.krank), cls: 'sick', sub: plural(f.krankSpells, 'Krankmeldung', 'Krankmeldungen') }) },
  ueber: { label: 'Überstunden', get: (f) => ({ num: fmtSigned(f.ot).replace(' h', ''), unit: 'h', cls: balanceClass(f.ot), sub: 'Saldo' }) },
  schnitt: {
    label: 'Ø pro Tag',
    menu: 'Ø pro Tag (h)',
    get: (f) => ({ num: fmtDec(f.workDays ? f.workedNet / f.workDays : 0), unit: 'h', sub: 'netto' }),
  },
  urlaub: {
    label: 'Urlaub',
    // wie die große Karte: überzogen = „… zu viel“
    get: (f) => ({ num: fmtNum(f.urlaub), cls: 'vac', sub: !f.anspruch ? 'Tage genommen' : f.rest < 0 ? `${fmtNum(-f.rest)} zu viel` : `${fmtNum(f.rest)} übrig` }),
  },
  avgStunden: {
    label: 'Ø Stunden',
    menu: 'Ø Stunden pro Monat',
    get: (f) => (f.avgWorked == null ? { num: '–', sub: 'pro Monat' } : { num: fmtDec(Math.round(f.avgWorked)), unit: 'h', sub: 'pro Monat' }),
  },
  avgUeber: {
    label: 'Ø Überstunden',
    menu: 'Ø Überstunden pro Monat',
    get: (f) =>
      f.avgOt == null
        ? { num: '–', sub: 'pro Monat' }
        : { num: fmtSigned(Math.round(f.avgOt)).replace(' h', ''), unit: 'h', cls: balanceClass(Math.round(f.avgOt)), sub: 'pro Monat' },
  },
  avgNetto: {
    label: 'Ø Netto',
    menu: 'Ø Netto pro Monat',
    wage: true,
    get: (f) => ({ num: f.avgNet == null ? '–' : ovcEuro(f.avgNet), sub: 'pro Monat' }),
  },
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
        return `<div class="ovc-col${c?.gap ? ' ovc-gap' : ''}" style="--i:${k}"><div class="ovc-plot">
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
function ovcAvgHead(title, avg, fmt, cls = () => '') {
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
      return `${ovcAvgHead('Überstunden', f.avgOt, (v) => fmtSigned(Math.round(v)), (v) => balanceClass(Math.round(v)))}
        ${ovcBars(
          f.m.map((m, k) => (k < last ? { v: m.ot, cls: m.ot < 0 ? 'minus' : 'plus', gap: m.gap } : null)),
          (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + hrsShort(Math.abs(v))
        )}`;
    },
  },
  stunden: {
    label: 'Stunden pro Monat',
    html: (f) => {
      const last = ovcLastMonth(f.year);
      return `${ovcAvgHead('Stunden', f.avgWorked, (v) => fmtH(Math.round(v)))}
        ${ovcBars(f.m.map((m, k) => (k < last ? { v: m.worked, cls: 'acc', gap: m.gap } : null)), (v) => fmtNum(Math.round(v / 60)))}`;
    },
  },
  abwesenheit: {
    label: 'Abwesenheit pro Monat',
    html: (f) => `${ovcAvgHead('Abwesenheit', f.avgAbsence, (v) => plural(Math.round(v * 10) / 10, 'Tag', 'Tage'))}
      ${ovcBars(
        f.m.map((m) => ({ v: m.urlaub + m.krank, plan: m.urlaubPlan, gap: m.gap, segs: [{ v: m.krank, cls: 'sick' }, { v: m.urlaub, cls: 'vac' }] })),
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
  arbeitsarten: { label: 'Arbeitsarten', html: kdArtenRingHTML },
  arbeitsartenMonat: { label: 'Arbeitsarten pro Monat', html: kdArtenBarsHTML },
  kunden: { label: 'Kunden', html: kdKundenCardHTML },
  netto: {
    label: 'Netto pro Monat',
    wage: true,
    // Laufender Monat: Hochrechnung grün schraffiert (wie auf der Seite des Monats), nicht im Durchschnitt
    html: (f) => `${ovcAvgHead('Netto', f.avgNet, ovcEuro)}
      ${ovcBars(
        f.m.map((m) => (m.net != null ? { v: m.net, cls: 'ok' } : m.netProj != null ? { v: m.netProj, cls: 'ok proj' } : null)),
        (v) => fmtNum(Math.round(v / 100) / 10).replace(/,0$/, '') + 'k'
      )}`,
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
    label: `${defs[k].menu || defs[k].label}${k === current ? ` <span class="ovc-check">${ICON.check}</span>` : ''}`,
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
