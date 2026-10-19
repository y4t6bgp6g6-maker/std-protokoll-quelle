// Regeln der App – erzeugt vom Regel-Werkzeug aus „Regeln und Logiken/*.json“ (außerhalb des Repos).
// Nicht von Hand ändern.
const REGELN = {
 "arbeitsarten": {
  "id": "arbeitsarten",
  "titel": "Arbeitsarten und Kunden",
  "beschreibung": "Gilt für die Übersicht (Karten „Arbeitsarten“, „Arbeitsarten pro Monat“, „Kunden“ und die Seite „Kunden“). Alles läuft nur auf dem Gerät, ohne KI. Im Zettel wird nichts gespeichert.",
  "test": "arbeitsart",
  "abschnitte": [
   {
    "id": "arbeitsart",
    "typ": "regelliste",
    "titel": "Arbeitsart je Zeile",
    "text": "Jede Zeile im Zettel bekommt genau eine Art. Die Regeln werden von oben nach unten geprüft, die erste passende gilt. Groß/klein ist egal, ä = ae = a, ö = oe = o, ü = ue = u, ß = ss.",
    "ziele": {
     "baustelle": "Baustelle",
     "kundendienst": "Kundendienst",
     "werkstatt": "Werkstatt",
     "sonstiges": "Sonstiges"
    },
    "felder": {
     "baustelle": "Baustelle",
     "arbeit": "Arbeit"
    },
    "sonst": "sonstiges",
    "regeln": [
     {
      "titel": "Werkstatt",
      "ziel": "werkstatt",
      "feld": "baustelle",
      "wie": "anfang",
      "hinweis": "Egal, was gemacht wurde.",
      "woerter": [
       "Firma",
       "Halle",
       "Werkstatt",
       "Lager"
      ],
      "ausnahmen": []
     },
     {
      "titel": "Kundendienst (starke Wörter)",
      "ziel": "kundendienst",
      "feld": "arbeit",
      "wie": "teil",
      "hinweis": "",
      "woerter": [
       "Störung",
       "gestört",
       "Wartung",
       "gewartet",
       "repar",
       "Lecksuche",
       "überprüf",
       "kontroll",
       "getauscht",
       "gewechselt",
       "nachgefüllt",
       "undicht",
       "defekt",
       "Fehler",
       "gereinigt",
       "geholt",
       "geliefert",
       "gebracht",
       "wechseln",
       "tauschen"
      ],
      "ausnahmen": [
       "angebracht"
      ]
     },
     {
      "titel": "Baustelle",
      "ziel": "baustelle",
      "feld": "arbeit",
      "wie": "teil",
      "hinweis": "",
      "woerter": [
       "Montage",
       "montiert",
       "Inbetriebnahme",
       "in Betrieb genommen",
       "Aufbau",
       "aufgebaut",
       "verlegt",
       "eingebaut",
       "vorbereitet",
       "Leitung",
       "verkabelt",
       "Verkabelung",
       "verdrahtet",
       "Verdrahtung",
       "isoliert",
       "abgebaut",
       "gebaut",
       "Restarbeit",
       "aufgehang",
       "befestigt"
      ],
      "ausnahmen": []
     },
     {
      "titel": "Kundendienst (schwache Wörter)",
      "ziel": "kundendienst",
      "feld": "arbeit",
      "wie": "teil",
      "hinweis": "Zählen nur, wenn keine Regel darüber passt.",
      "woerter": [
       "abgesaugt",
       "aufgefüllt",
       "gemessen",
       "eingestellt",
       "erneuert"
      ],
      "ausnahmen": []
     }
    ]
   },
   {
    "id": "stunden",
    "typ": "text",
    "titel": "Stunden",
    "text": "- Die Pause des Tages wird **anteilig nach Dauer** auf die Zeilen des Tages verteilt.\n- Gezählt werden nur Tage bis heute, an denen gearbeitet werden kann (auch Arbeit am Feiertag)."
   },
   {
    "id": "kunden",
    "typ": "text",
    "titel": "Kunden",
    "text": "- **Kunde** = Feld „Baustelle“.\n- **Zählen nicht als Kunde:** Werkstatt-Zeilen und Zeilen ohne Baustelle.\n- **Gleicher Kunde trotz anderer Schreibweise:** dieselbe Regel wie auf der Team-Seite: gleiche Hausnummern, ein Tippfehler (ab 12 Buchstaben zwei), oder der eine Name steckt ganz im anderen. Anders als auf der Team-Seite zählt der Ort hinter dem Komma mit; zwei verschiedene Orte hinter dem Komma sind nie derselbe Kunde, es sei denn, der eine Ort steht auch im anderen Namen.\n- **Name des Kunden:** die Schreibweise mit den meisten Stunden.\n- **Einsatztage:** Tage mit mindestens einer Zeile bei diesem Kunden."
   },
   {
    "id": "ketten",
    "typ": "text",
    "titel": "Ketten (Kunde mit Filialen)",
    "text": "1. **Gleicher Anfang:** Mindestens zwei Kunden beginnen mit denselben ganzen Wörtern, der Rest ist verschieden („Muster-Pizza Nord“ und „Muster-Pizza Süd“ → Kette „Muster-Pizza“).\n2. **Kettenname:** so lang, wie er bei allen Filialen gleich ist („Pizza Muster Nord“ und „Pizza Muster Süd“ → „Pizza Muster“).\n3. **Artikel vorne** zählen nicht (Liste unten).\n4. **Dazu kommen:** ein Kunde, der genau so heißt wie eine gefundene Kette, auch mit Ort vorne („Musterstadt Muster-Pizza“).\n5. **Keine Kette** bilden die Wörter der Listen unten, Zahlen, Wörter unter 3 Buchstaben und Orte (alles, was irgendwo hinter einem Komma steht).\n6. **Von Hand** (Kunden-Seite lang drücken, Mac Rechtsklick) geht immer vor: „Zu Kette zusammenfassen …“, „Aus der Kette lösen“ (kommt nie wieder automatisch in eine Kette), „Kette auflösen“. Gespeichert als Einstellung `kunden`, wird abgeglichen."
   },
   {
    "id": "kettenwoerter",
    "typ": "wortliste",
    "titel": "Bilden keine Kette",
    "text": "Branche, Rechtsform, Füllwörter. Ganze Wörter.",
    "woerter": [
     "Bäckerei",
     "Hotel",
     "Restaurant",
     "Pizzeria",
     "Café",
     "Eiscafé",
     "Imbiss",
     "Supermarkt",
     "Markt",
     "Bistro",
     "Grill",
     "Döner",
     "Kita",
     "Kindergarten",
     "Schule",
     "Praxis",
     "Zahnarzt",
     "Altenheim",
     "Pflegeheim",
     "Baustelle",
     "Gaststätte",
     "Gasthaus",
     "Gasthof",
     "Kneipe",
     "Bar",
     "Metzgerei",
     "Fleischerei",
     "Kiosk",
     "Tankstelle",
     "Apotheke",
     "Getränke",
     "Eisdiele",
     "Hof",
     "Haus",
     "Familie",
     "Fam",
     "Herr",
     "Frau",
     "GmbH",
     "KG",
     "AG",
     "Co",
     "UG",
     "OHG",
     "eK",
     "und",
     "der",
     "die",
     "das",
     "zum",
     "zur",
     "am",
     "an",
     "im",
     "in",
     "bei",
     "von",
     "alte",
     "alter",
     "neue",
     "neuer"
    ]
   },
   {
    "id": "artikel",
    "typ": "wortliste",
    "titel": "Artikel vorne",
    "text": "Am Anfang eines Namens übersprungen („The Muster“ = „Muster“). Ganze Wörter.",
    "woerter": [
     "the",
     "der",
     "die",
     "das",
     "zum",
     "zur",
     "am",
     "im",
     "bei",
     "la",
     "le",
     "il",
     "el",
     "da"
    ]
   },
   {
    "id": "strassen",
    "typ": "wortliste",
    "titel": "Straßen",
    "text": "Wörter mit diesen Enden bilden keine Kette.",
    "woerter": [
     "str",
     "straße",
     "weg",
     "allee",
     "platz",
     "ring",
     "damm",
     "gasse",
     "chaussee"
    ]
   }
  ]
 }
};
