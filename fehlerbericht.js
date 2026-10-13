// Std-Protokoll – Fehlerberichte: unerwartete Fehler still auf den Team-Server laden (nur wer im Team ist).
// Wird als erstes Skript geladen und kommt ohne die anderen Dateien aus, damit auch Fehler beim Start ankommen.
// Im Bericht steht nur Technisches (Meldung, Codestelle, Version, Seite, Gerät), keine Zettel-Inhalte.
// Ohne Internet bleiben die Berichte liegen und gehen beim nächsten Mal hoch. Der Nutzer merkt davon nichts.
//
// Eigener Speicher: { queue: [{ sig, message, stack, view, count, first, last }], sent: { sig: 'YYYY-MM-DD' } }

(() => {
  const URL_ = 'https://std-protokoll-team.std-protokoll.workers.dev/error';
  const KEY = 'stdprotokoll.fehler.v1';
  const TEAM = 'stdprotokoll.team.v1';
  const MAX_QUEUE = 20;

  const load = () => {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || 'null');
      return s && Array.isArray(s.queue) ? { queue: s.queue, sent: s.sent || {} } : { queue: [], sent: {} };
    } catch {
      return { queue: [], sent: {} };
    }
  };
  const save = (s) => {
    try {
      localStorage.setItem(KEY, JSON.stringify(s));
    } catch {}
  };
  const team = () => {
    try {
      return JSON.parse(localStorage.getItem(TEAM) || 'null');
    } catch {
      return null;
    }
  };
  /** Vorname wie im Team (erstes Wort des Namens) */
  const firstName = () => {
    try {
      return String(JSON.parse(localStorage.getItem('stdprotokoll.settings.v1') || '{}').name || '').trim().split(/\s+/)[0].slice(0, 40);
    } catch {
      return '';
    }
  };
  const today = () => new Date().toISOString().slice(0, 10);

  /** Pfade kürzen: nur Dateiname und Zeile, nicht die ganze Adresse */
  const short = (s) => String(s || '').replace(/https?:\/\/[^\s)]*\/([^/\s)?]+)(\?[^\s):]*)?/g, '$1');

  function record(message, stack, file) {
    try {
      if (!team()) return;
      message = short(message).slice(0, 300);
      stack = short(stack).slice(0, 2000);
      // Fehler fremder Skripte (z. B. Erweiterungen) ohne Angaben bringen nichts
      if (!stack && (!message || message === 'Script error.')) return;
      if (file && !String(file).startsWith(location.origin)) return;
      const view = location.hash.replace(/^#\/team\/[^/]+/, '#/team/…').slice(0, 60) || '#/';
      const sig = `${message}|${stack.split('\n')[0] || ''}`;
      const s = load();
      const now = Date.now();
      const old = s.queue.find((e) => e.sig === sig);
      if (old) {
        old.count++;
        old.last = now;
      } else if (s.sent[sig] === today()) {
        return; // heute schon gemeldet
      } else {
        s.queue.push({ sig, message, stack, view, count: 1, first: now, last: now });
        s.queue = s.queue.slice(-MAX_QUEUE);
      }
      save(s);
      later(5000);
    } catch {}
  }

  /** App-Version aus dem Offline-Cache („std-protokoll-v25“); höchste Nummer, falls gerade zwei da sind */
  async function version() {
    try {
      const keys = (await caches.keys()).filter((k) => /^std-protokoll-v\d+$/.test(k));
      return keys.sort((a, b) => Number(b.split('-v')[1]) - Number(a.split('-v')[1]))[0] || '';
    } catch {
      return '';
    }
  }

  let busy = false;
  async function upload() {
    if (busy || !navigator.onLine) return;
    const t = team();
    let s = load();
    if (!t || !t.code || !s.queue.length) return;
    busy = true;
    try {
      const reports = s.queue.slice();
      const res = await fetch(URL_, {
        method: 'POST',
        headers: { 'X-Team-Code': t.code, 'Content-Type': 'application/json' },
        body: JSON.stringify({ member: t.member, token: t.token, name: firstName(), version: await version(), ua: navigator.userAgent.slice(0, 200), reports }),
        cache: 'no-store',
        keepalive: true,
      });
      // Angenommen oder endgültig abgelehnt (falscher Code, zu viele): aus der Warteschlange nehmen
      if (res.ok || (res.status >= 400 && res.status < 500)) {
        s = load();
        // Was während des Hochladens dazukam, bleibt für das nächste Mal
        const done = new Map(reports.map((r) => [r.sig, r.count]));
        s.queue = s.queue.filter((e) => (e.count -= done.get(e.sig) || 0) > 0);
        const d = today();
        for (const r of reports) s.sent[r.sig] = d;
        for (const k of Object.keys(s.sent)) if (s.sent[k] !== d) delete s.sent[k];
        save(s);
      }
    } catch {
    } finally {
      busy = false;
    }
  }

  let timer = 0;
  function later(ms) {
    clearTimeout(timer);
    timer = setTimeout(upload, ms);
  }

  window.addEventListener('error', (e) => record(e.message, e.error && e.error.stack, e.filename));
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    record(r && r.message ? `Promise: ${r.message}` : `Promise: ${String(r)}`, r && r.stack, '');
  });
  window.addEventListener('online', () => later(3000));
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && later(3000));
  later(4000);
})();
