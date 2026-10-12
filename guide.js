// Std-Protokoll – Anleitung: Arbeitsscheine automatisch abholen und Sicherung in Google Drive
// Seite #/anleitung (Einstellungen → Arbeitsscheine → Anleitung). Enthält das Google-Skript zum Kopieren;
// der Schlüssel wird hier erzeugt (oder aus der vorhandenen Abholadresse übernommen) und steht nie im Repo.

/** Google-Skript; __KEY__ wird beim Kopieren durch den Schlüssel ersetzt */
const GUIDE_SCRIPT = "// Std-Protokoll – Arbeitsscheine abholen und Sicherungen in Google Drive ablegen\n// Läuft im eigenen Google-Konto. Gibt die .odt-Anhänge neuer Mails an die App weiter (doGet)\n// und speichert die Sicherungen der App im Drive-Ordner „Std-Protokoll-Sicherungen“ (doPost, die letzten 30 bleiben).\n// Der Schlüssel schützt die Adresse – nicht weitergeben.\n\nconst KEY = '__KEY__';\n\nfunction doGet(e) {\n  if (!e || e.parameter.key !== KEY) return json({ error: 'key' });\n  const since = Number(e.parameter.since) || 0;\n  // Gmail sucht sekundengenau ab „after:“; ohne Stand die letzten 120 Tage\n  const query = 'has:attachment filename:odt ' + (since ? 'after:' + Math.floor(since / 1000 - 3600) : 'newer_than:120d');\n  const files = [];\n  for (const thread of GmailApp.search(query, 0, 200)) {\n    for (const msg of thread.getMessages()) {\n      const time = msg.getDate().getTime();\n      if (time <= since) continue;\n      for (const att of msg.getAttachments()) {\n        if (!/\\.odt$/i.test(att.getName())) continue;\n        try {\n          const parts = Utilities.unzip(att.copyBlob().setContentType('application/zip'));\n          const text = (name) => {\n            const f = parts.find((p) => p.getName() === name);\n            return f ? f.getDataAsString('UTF-8') : '';\n          };\n          files.push({ id: msg.getId() + '/' + att.getName(), name: att.getName(), time: time, meta: text('meta.xml'), content: text('content.xml') });\n        } catch (err) {\n          // beschädigter Anhang – übergehen\n        }\n      }\n    }\n  }\n  files.sort((a, b) => a.time - b.time);\n  return json({ files: files });\n}\n\nconst BACKUP_FOLDER = 'Std-Protokoll-Sicherungen';\nconst BACKUP_KEEP = 30;\n\nfunction doPost(e) {\n  if (!e || e.parameter.key !== KEY) return json({ error: 'key' });\n  let body;\n  try {\n    body = JSON.parse(e.postData.contents);\n  } catch (err) {\n    return json({ error: 'Daten unlesbar' });\n  }\n  if (body.action !== 'backup' || !body.data) return json({ error: 'unbekannte Anfrage' });\n  const folders = DriveApp.getFoldersByName(BACKUP_FOLDER);\n  const folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(BACKUP_FOLDER);\n  const name = String(body.name || 'Std-Protokoll-Sicherung.json').replace(/[\\\\/]/g, '-');\n  // Gleicher Tag: alte Datei ersetzen, damit pro Tag nur eine Sicherung liegt\n  const same = folder.getFilesByName(name);\n  while (same.hasNext()) same.next().setTrashed(true);\n  folder.createFile(name, body.data, 'application/json');\n  // Nur die neuesten BACKUP_KEEP behalten (ältere landen im Papierkorb von Drive)\n  const all = [];\n  const it = folder.getFiles();\n  while (it.hasNext()) all.push(it.next());\n  all.sort((x, y) => y.getDateCreated() - x.getDateCreated());\n  all.slice(BACKUP_KEEP).forEach((f) => f.setTrashed(true));\n  return json({ ok: true, name: name, count: Math.min(all.length, BACKUP_KEEP) });\n}\n\nfunction json(o) {\n  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);\n}\n";

const GUIDE_KEY = 'stdprotokoll.guide-key';

/** Schlüssel: aus der eingetragenen Abholadresse, sonst einmal zufällig erzeugt und gemerkt */
function guideKey() {
  try {
    const k = new URL((settings.reportUrl || '').trim()).searchParams.get('key');
    if (k) return k;
  } catch {}
  let k = '';
  try {
    k = localStorage.getItem(GUIDE_KEY) || '';
  } catch {}
  if (!k) {
    const abc = 'abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    k = [...crypto.getRandomValues(new Uint8Array(24))].map((b) => abc[b % abc.length]).join('');
    try {
      localStorage.setItem(GUIDE_KEY, k);
    } catch {}
  }
  return k;
}

/** Knöpfe und Symbole der Google-Skript-Seite, nachgezeichnet */
const G_ICON = {
  plus: '<path d="M19 13h-6v6h-2v-6H5v-2h6V5h2v6h6z"/>',
  save: '<path d="M17 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V7l-4-4zm-5 16a3 3 0 1 1 0-6 3 3 0 0 1 0 6zm3-10H5V5h10v4z"/>',
  run: '<path d="M8 5v14l11-7z"/>',
  gear: '<path d="M19.4 13a7.5 7.5 0 0 0 0-2l2.1-1.6-2-3.5-2.5 1a7.4 7.4 0 0 0-1.7-1L15 3h-4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1-2 3.5L6.6 11a7.5 7.5 0 0 0 0 2l-2.1 1.6 2 3.5 2.5-1a7.4 7.4 0 0 0 1.7 1L11 21h4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1 2-3.5zM13 15.5a3.5 3.5 0 1 1 0-7 3.5 3.5 0 0 1 0 7z" transform="translate(-1 0)"/>',
  pencil: '<path d="M3 17.25V21h3.75L17.8 9.94l-3.75-3.75zM20.7 7.04a1 1 0 0 0 0-1.41l-2.33-2.34a1 1 0 0 0-1.42 0l-1.83 1.83 3.75 3.75z"/>',
  copy: '<path d="M16 1H4a2 2 0 0 0-2 2v14h2V3h12zm3 4H8a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2zm0 16H8V7h11z"/>',
  down: '<path d="M7 10l5 5 5-5z"/>',
};
const gIcon = (name) => `<svg viewBox="0 0 24 24" aria-hidden="true">${G_ICON[name]}</svg>`;
/** Knopf wie auf der Google-Seite: kind = '' (grau), 'blue' (gefüllt), 'icon' (nur Symbol) */
const gBtn = (label, icon, kind = '') => `<span class="g-btn ${kind}${icon === 'down' && label ? ' trail' : ''}">${icon ? gIcon(icon) : ''}${label ? `<span>${label}</span>` : ''}</span>`;

function renderGuide() {
  const key = guideKey();
  const step = (n, body) => `<li class="guide-step"><span class="guide-n">${n}</span><div>${body}</div></li>`;
  app.innerHTML = `
    <header class="nav">
      <button class="nav-btn back" data-act="back" aria-label="Zurück">${ICON.back}</button>
      <span class="nav-title"></span>
      <span class="nav-btn"></span>
    </header>
    <h1 class="large-title">Anleitung</h1>
    <p class="guide-lead">Arbeitsscheine kommen von selbst in die App, und die App sichert sich täglich in dein Google Drive. Einmal einrichten, am besten am Computer.</p>
    <div class="card guide-tip"><b>App neu installiert?</b> Nicht neu einrichten – erst die neueste Sicherung aus Drive (Ordner „Std-Protokoll-Sicherungen“) unter Optionen → <b>Sicherung einlesen</b> (bei verschlüsselter Sicherung mit deinem Passwort). Dann läuft alles wieder.</div>

    <h2 class="section-title">1 · Google-Skript anlegen</h2>
    <ol class="card guide">
      ${step(1, `<b>script.google.com</b> öffnen und mit dem Google-Konto anmelden, in dem die Arbeitsscheine ankommen. Dann ${gBtn('Neues Projekt', 'plus')}`)}
      ${step(2, `Code kopieren, im Editor alles markieren und ersetzen:
        <button class="guide-copy" data-act="guide-copy-code">${gIcon('copy')} Code kopieren</button>
        <span class="guide-note">Der Code enthält deinen Schlüssel – nicht weitergeben.</span>`)}
      ${step(3, `Oben links auf „Unbenanntes Projekt“ tippen, <b>Std-Protokoll</b> nennen. Dann speichern ${gBtn('', 'save', 'icon')}`)}
      ${step(4, `Daneben <b>doGet</b> auswählen ${gBtn('doGet', 'down')} und ${gBtn('Ausführen', 'run')}<br>
        Google fragt nach Erlaubnis: <b>Berechtigungen prüfen</b> → dein Konto → <b>Erweitert</b> → <b>Std-Protokoll öffnen (unsicher)</b> → <b>Alle auswählen</b> → <b>Weiter</b>.
        <span class="guide-note">„Unsicher“ heißt nur: Google hat dein eigenes Skript nicht geprüft. Eine Fehlermeldung danach ist normal.</span>`)}
      ${step(5, `Oben rechts ${gBtn('Bereitstellen', 'down', 'blue')} → <b>Neue Bereitstellung</b> → Zahnrad ${gBtn('', 'gear', 'icon')} → <b>Web-App</b>`)}
      ${step(6, `Einstellen: <b>Ausführen als: Ich</b> · <b>Zugriff: Jeder</b>. Dann ${gBtn('Bereitstellen', '', 'blue')}`)}
      ${step(7, `Bei <b>Web-App-URL</b> auf ${gBtn('Kopieren', 'copy')} tippen.`)}
    </ol>

    <h2 class="section-title">2 · Adresse in die App</h2>
    <div class="card form">
      <label class="field guide-url"><input id="guide-url" placeholder="Web-App-URL einfügen" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" enterkeyhint="done"></label>
      <button class="list-btn" data-act="guide-apply">In dieser App übernehmen</button>
      <button class="list-btn" data-act="guide-copy-url">Fertige Abholadresse kopieren</button>
    </div>
    <p class="footnote">Am Computer: fertige Adresse kopieren und am iPhone unter Optionen → Abholadresse einfügen.</p>

    <h2 class="section-title">3 · Testen</h2>
    <div class="card list">
      <button class="list-btn" data-act="reports-fetch">Arbeitsscheine jetzt abholen</button>
      <button class="list-btn" data-act="backup-drive">Jetzt in Google Drive sichern</button>
    </div>
    <p class="footnote">In Drive erscheint der Ordner „Std-Protokoll-Sicherungen“.</p>

    <h2 class="section-title">4 · Arbeitsscheine schicken</h2>
    <ol class="card guide">
      ${step(1, `Beim Senden des Arbeitsberichts die Gmail-Adresse dieses Google-Kontos ins Feld <b>BCC</b> schreiben.`)}
      ${step(2, `Die App holt neue Scheine beim Öffnen und beim Öffnen eines Zettels.`)}
    </ol>

    <h2 class="section-title">Skript später ändern</h2>
    <ol class="card guide">
      ${step(1, `Neuen Code einfügen und speichern ${gBtn('', 'save', 'icon')}`)}
      ${step(2, `${gBtn('Bereitstellen', 'down', 'blue')} → <b>Bereitstellungen verwalten</b> → Stift ${gBtn('', 'pencil', 'icon')}`)}
      ${step(3, `Bei <b>Version</b>: <b>Neue Version</b> → ${gBtn('Bereitstellen', '', 'blue')}. Die Adresse bleibt gleich.`)}
    </ol>`;
}

/** Fertige Abholadresse aus der eingefügten Web-App-URL (ohne alte Zusätze) und dem Schlüssel */
function guideAddress() {
  const raw = (document.getElementById('guide-url')?.value || '').trim();
  const m = raw.match(/https:\/\/script\.google\.com\/[^\s?#]*\/exec/);
  if (!m) {
    infoDialog('Adresse fehlt', 'Bitte die Web-App-URL aus Schritt 7 einfügen. Sie endet auf „/exec“.');
    return null;
  }
  return `${m[0]}?key=${guideKey()}`;
}

function guideAction(act) {
  if (act === 'guide-copy-code') {
    navigator.clipboard.writeText(GUIDE_SCRIPT.replace('__KEY__', guideKey())).then(
      () => toast('Code kopiert'),
      () => infoDialog('Kopieren fehlgeschlagen', 'Bitte noch einmal tippen.')
    );
  } else if (act === 'guide-copy-url') {
    const a = guideAddress();
    if (a) navigator.clipboard.writeText(a).then(() => toast('Abholadresse kopiert'), () => {});
  } else if (act === 'guide-apply') {
    const a = guideAddress();
    if (!a) return;
    settings.reportUrl = a;
    saveSettings();
    toast('Abholadresse übernommen');
  }
}
