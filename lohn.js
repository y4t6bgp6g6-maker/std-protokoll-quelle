// Netto-Schätzung für einen Monat: Lohnsteuer nach dem Einkommensteuertarif 2024, 2025 bzw. 2026
// (Programmablaufplan, vereinfacht) und Sozialabgaben Arbeitnehmeranteil. Ergebnis ist eine Schätzung, keine
// Lohnabrechnung. Geprüft an echten Abrechnungen 2025 und 2026 (Lohnsteuer und Sozialabgaben auf den Cent) und an
// den Prüffällen des BMF.

const LOHN_2024 = {
  bbgKv: 5175,
  bbgRv: 7550, // West
  mindestVsp: true, // Mindestvorsorgepauschale (bis 2025)
  kv: 7.3,
  kvVsp: 7.0,
  rv: 9.3,
  av: 1.3,
  pv: 1.7,
  pvKinderlos: 0.6,
  pvAbschlag: 0.25,
  bavSteuerfrei: 604,
  bavSvFrei: 302,
  werbungskosten: 1230,
  sonderausgaben: 36,
  entlastung: 4260,
  kfb: 9312, // Kinderfreibetrag + Freibetrag für Betreuung je Zähler 1,0 (nur für Soli und Kirchensteuer)
  soliFreigrenze: 18130,
  kirche: 9,
  w1: 13279,
  w2: 33380,
  w3: 222260,
  tarif: [11604, 17005, 66760, 277825, 922.98, 1025.38, 181.19, 10602.13, 18936.88],
};
// Grundfreibetrag 2024 rückwirkend erhöht: im Dezember 2024 rechnete die Lohnabrechnung das ganze Jahr mit dem
// neuen Tarif nach (PAP Dezember 2024, „MLST1224“)
const LOHN_2024_NEU = {
  ...LOHN_2024,
  w1: 13432,
  kfb: 9540,
  tarif: [11784, 17005, 66760, 277825, 954.8, 991.21, 181.19, 10636.31, 18971.06],
};

const LOHN_2025 = {
  bbgKv: 5512.5,
  bbgRv: 8050,
  mindestVsp: true,
  kv: 7.3,
  kvVsp: 7.0,
  rv: 9.3,
  av: 1.3,
  pv: 1.8,
  pvKinderlos: 0.6,
  pvAbschlag: 0.25,
  bavSteuerfrei: 644,
  bavSvFrei: 322,
  werbungskosten: 1230,
  sonderausgaben: 36,
  entlastung: 4260,
  kfb: 9600,
  soliFreigrenze: 19950,
  kirche: 9,
  w1: 13785,
  w2: 34240,
  w3: 222260,
  // Grundtarif: Grenzen und Formeln (§ 32a EStG)
  tarif: [12096, 17443, 68480, 277825, 932.3, 1015.13, 176.64, 10911.92, 19246.67],
};

const LOHN_2026 = {
  bbgKv: 5812.5, // Beitragsbemessungsgrenze Kranken-/Pflegeversicherung je Monat
  bbgRv: 8450, // Renten-/Arbeitslosenversicherung je Monat
  kv: 7.3, // allgemeiner Beitragssatz, Arbeitnehmeranteil (%)
  kvVsp: 7.0, // ermäßigter Satz für die Vorsorgepauschale (%)
  rv: 9.3,
  av: 1.3,
  pv: 1.8,
  pvKinderlos: 0.6, // Zuschlag für Kinderlose ab 23
  pvAbschlag: 0.25, // je Kind ab dem 2. (bis zum 5.), Kinder unter 25
  bavSteuerfrei: 676, // 8 % der BBG RV je Monat (Entgeltumwandlung steuerfrei)
  bavSvFrei: 338, // 4 % der BBG RV je Monat (sozialversicherungsfrei)
  werbungskosten: 1230,
  sonderausgaben: 36,
  entlastung: 4260, // Steuerklasse II (weitere Kinder nur als Freibetrag auf Antrag – nicht im Lohnsteuerabzug)
  kfb: 9756,
  soliFreigrenze: 20350,
  kirche: 9, // Niedersachsen (%)
  // Steuerklasse V/VI
  w1: 14071,
  w2: 34939,
  w3: 222260,
  tarif: [12348, 17799, 69878, 277825, 914.51, 1034.87, 173.1, 11135.63, 19470.38],
};

const LOHN_JAHRE = { 2024: LOHN_2024, 2025: LOHN_2025, 2026: LOHN_2026 };
/** Kennt die App den Steuertarif dieses Jahres? */
const lohnJahrBekannt = (year) => !!LOHN_JAHRE[year];
/** Werte des Jahres (vor 2024 wie 2024, nach 2026 wie 2026; ohne Jahr 2026) */
const lohnJahr = (year) => LOHN_JAHRE[year] || (year && year < 2024 ? LOHN_2024 : LOHN_2026);

/** Einkommensteuer nach Grundtarif (ganze Euro) */
function tarifJahr(zve, c = LOHN_2026) {
  const [g0, g1, g2, g3, a, b, d, e, f] = c.tarif;
  const x = Math.floor(zve);
  if (x <= g0) return 0;
  if (x <= g1) {
    const y = (x - g0) / 10000;
    return Math.floor((a * y + 1400) * y);
  }
  if (x <= g2) {
    const z = (x - g1) / 10000;
    return Math.floor((d * z + 2397) * z + b);
  }
  if (x <= g3) return Math.floor(0.42 * x - e);
  return Math.floor(0.45 * x - f);
}

/** Steuerklasse V und VI: eigene Formel ohne Grundfreibetrag (PAP „MST5-6“) */
function tarif56(zzx, c = LOHN_2026) {
  const up = (zx) => {
    const diff = (tarifJahr(zx * 1.25, c) - tarifJahr(zx * 0.75, c)) * 2;
    return Math.max(diff, Math.floor(zx * 0.14));
  };
  if (zzx > c.w2) {
    let st = up(c.w2);
    st += zzx > c.w3 ? (c.w3 - c.w2) * 0.42 + (zzx - c.w3) * 0.45 : (zzx - c.w2) * 0.42;
    return Math.floor(st);
  }
  const vergl = up(zzx);
  if (zzx <= c.w1) return vergl;
  return Math.floor(Math.min(vergl, up(c.w1) + (zzx - c.w1) * 0.42));
}

/**
 * Netto für einen Monat.
 * brutto: steuer- und beitragspflichtiger Bruttolohn (Grundlohn, Überstunden, Zulagen)
 * opts: { klasse 1–6, kirche, kinder, zusatz (KV-Zusatzbeitrag %), bav (Entgeltumwandlung € je Monat), year, month,
 *         stFrei / svFrei: steuer- bzw. beitragsfreie Teile des Bruttos (z. B. Inflationsausgleichsprämie) }
 * Ergebnis: { brutto, lohnsteuer, soli, kirchensteuer, kv, rv, av, pv, bav, netto }
 */
function nettoMonat(brutto, opts) {
  const c = lohnJahr(opts.year);
  const klasse = Number(opts.klasse) || 1;
  const kinder = Math.max(0, Math.floor(Number(opts.kinder) || 0));
  const zusatz = Number(opts.zusatz) || 0;
  const bav = Math.max(0, Number(opts.bav) || 0);
  const r2 = (v) => Math.round(v * 100) / 100;

  // Entgeltumwandlung (Betriebsrente) mindert das steuer- und beitragspflichtige Brutto bis zu den Grenzen
  // (steuer- bzw. beitragsfreie Bezüge zählen zum Brutto, aber nicht mit)
  const steuerBrutto = brutto - Math.min(bav, c.bavSteuerfrei) - Math.max(0, Number(opts.stFrei) || 0);
  const svBrutto = brutto - Math.min(bav, c.bavSvFrei) - Math.max(0, Number(opts.svFrei) || 0);

  // Sozialversicherung, Arbeitnehmeranteil
  const pvSatz = c.pv + (kinder === 0 ? c.pvKinderlos : -c.pvAbschlag * Math.max(0, Math.min(kinder, 5) - 1));
  const kvBasis = Math.min(svBrutto, c.bbgKv);
  const rvBasis = Math.min(svBrutto, c.bbgRv);
  const kv = r2((kvBasis * (c.kv + zusatz / 2)) / 100);
  const pv = r2((kvBasis * pvSatz) / 100);
  const rv = r2((rvBasis * c.rv) / 100);
  const av = r2((rvBasis * c.av) / 100);

  // Lohnsteuer über den Jahresbetrag
  const jahr = steuerBrutto * 12;
  const vspRv = (Math.min(jahr, c.bbgRv * 12) * c.rv) / 100;
  // Mindestvorsorgepauschale (bis 2025): 12 % des Lohns, höchstens 1.900 € (Steuerklasse III 3.000 €)
  const vspMin = !c.mindestVsp ? 0 : Math.min(Math.floor(jahr * 12) / 100, klasse === 3 ? 3000 : 1900);
  const vsp = Math.ceil(
    vspRv + Math.max(vspMin, (Math.min(jahr, c.bbgKv * 12) * (c.kvVsp + zusatz / 2 + pvSatz)) / 100)
  );
  let frei = vsp;
  if (klasse !== 6) frei += c.werbungskosten + c.sonderausgaben;
  if (klasse === 2) frei += c.entlastung;
  const zve = Math.max(0, Math.floor(jahr - frei));
  // Jahressteuer nach einem Tarif; Soli und Kirchensteuer nach der Steuer ohne Kinderfreibeträge (Bemessungsgrundlage,
  // § 51a EStG): Zähler 0,5 je Kind, in Klasse III 1,0 (Klasse IV: 1,0 mit halbem Betrag), Klasse V/VI keine
  const steuer = (t) => {
    const tax = (z) => (klasse === 3 ? 2 * tarifJahr(Math.floor(z / 2), t) : klasse === 5 || klasse === 6 ? tarif56(z, t) : tarifJahr(z, t));
    const kfb = klasse === 5 || klasse === 6 ? 0 : kinder * t.kfb * (klasse === 3 ? 1 : 0.5);
    const st = tax(zve);
    const bmg = kfb ? tax(Math.max(0, Math.floor(zve - kfb))) : st;
    const freigrenze = t.soliFreigrenze * (klasse === 3 ? 2 : 1);
    const soli = bmg > freigrenze ? Math.min(bmg * 0.055, (bmg - freigrenze) * 0.119) : 0;
    return { st, bmg, soli: Math.floor(soli * 100) / 100 };
  };
  let { st, bmg, soli: soliJahr } = steuer(c);
  if (opts.year === 2024 && opts.month === 12) {
    // Dezember 2024: Jahressteuer nach neuem Tarif, abzüglich der elf Monate, die nach altem Tarif zu viel gezahlt wurden
    const neu = steuer(LOHN_2024_NEU);
    const nach = (n, a) => Math.max(0, n - 11 * (a - n));
    st = nach(neu.st, st);
    bmg = nach(neu.bmg, bmg);
    soliJahr = nach(neu.soli, soliJahr);
  }
  const lohnsteuer = Math.floor((st / 12) * 100) / 100;
  const soli = Math.floor((soliJahr / 12) * 100) / 100;
  const kirchensteuer = opts.kirche ? Math.floor(((bmg * c.kirche) / 100 / 12) * 100) / 100 : 0;

  const netto = r2(brutto - lohnsteuer - soli - kirchensteuer - kv - rv - av - pv - bav);
  return { brutto: r2(brutto), lohnsteuer, soli, kirchensteuer, kv, rv, av, pv, bav, netto };
}
