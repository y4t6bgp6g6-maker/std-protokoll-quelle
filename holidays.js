'use strict';
// Gesetzliche Feiertage je Bundesland (ohne Feiertage, die nur in einzelnen Gemeinden gelten).

/** Ostersonntag (gregorianisch, Algorithmus nach Meeus/Jones/Butcher) */
function easterSunday(year) {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(year, month - 1, day);
}

const holidayCache = new Map();

/** Map 'YYYY-MM-DD' → Name des Feiertags für Jahr und Bundesland */
function holidaysFor(year, state) {
  const key = `${year}-${state}`;
  if (holidayCache.has(key)) return holidayCache.get(key);
  const easter = easterSunday(year);
  const fromEaster = (n) => addDays(easter, n);
  const fixed = (m, d) => new Date(year, m - 1, d);
  const inStates = (...codes) => codes.includes(state);
  // Buß- und Bettag: Mittwoch vor dem 23. November
  const nov23 = fixed(11, 23);
  const bussUndBettag = addDays(nov23, -(((nov23.getDay() - 3 + 7) % 7) || 7));

  const list = [
    [fixed(1, 1), 'Neujahr', true],
    [fixed(1, 6), 'Heilige Drei Könige', inStates('BW', 'BY', 'ST')],
    [fixed(3, 8), 'Internationaler Frauentag', inStates('BE', 'MV')],
    [fromEaster(-2), 'Karfreitag', true],
    [easter, 'Ostersonntag', inStates('BB')],
    [fromEaster(1), 'Ostermontag', true],
    [fixed(5, 1), 'Tag der Arbeit', true],
    [fromEaster(39), 'Christi Himmelfahrt', true],
    [fromEaster(49), 'Pfingstsonntag', inStates('BB')],
    [fromEaster(50), 'Pfingstmontag', true],
    [fromEaster(60), 'Fronleichnam', inStates('BW', 'BY', 'HE', 'NW', 'RP', 'SL')],
    [fixed(8, 15), 'Mariä Himmelfahrt', inStates('SL')],
    [fixed(9, 20), 'Weltkindertag', inStates('TH')],
    [fixed(10, 3), 'Tag der Deutschen Einheit', true],
    [fixed(10, 31), 'Reformationstag', inStates('BB', 'HB', 'HH', 'MV', 'NI', 'SN', 'ST', 'SH', 'TH')],
    [fixed(11, 1), 'Allerheiligen', inStates('BW', 'BY', 'NW', 'RP', 'SL')],
    [bussUndBettag, 'Buß- und Bettag', inStates('SN')],
    [fixed(12, 25), '1. Weihnachtstag', true],
    [fixed(12, 26), '2. Weihnachtstag', true],
  ];
  const map = new Map(list.filter(([, , active]) => active).map(([d, name]) => [isoDate(d), name]));
  holidayCache.set(key, map);
  return map;
}

/** Name des Feiertags an diesem Datum im eingestellten Bundesland, sonst null */
function holidayName(date) {
  return holidaysFor(date.getFullYear(), settings.state).get(isoDate(date)) || null;
}
