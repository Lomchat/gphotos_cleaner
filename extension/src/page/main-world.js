/**
 * Runs in the page's own JavaScript world, unlike every other file here.
 *
 * Its only job is to read `window.WIZ_global_data` — which an isolated content
 * script cannot see — and hand the raw values across the boundary. Nothing else
 * belongs in this file: code here shares a global scope with Google's own
 * application, so anything it defines is a name that could collide with theirs.
 *
 * It deliberately does no interpretation. The keys are copied verbatim and the
 * isolated side maps them, so the meaning of each one is written down in exactly
 * one place (`src/api/tokens.js`). The list below is the one thing duplicated,
 * because a MAIN-world content script cannot import; a test compares the two.
 *
 * The values travel by `postMessage` to our own origin, and the listener on the
 * other side checks the source before believing any of it.
 */

(() => {
  const EVENT = 'gpc:tokens';
  const KEYS = ['SNlM0e', 'FdrFJe', 'cfb2h', 'eptZe', 'oPEP7c', 'Dbw5Ud'];

  function collect() {
    const data = window.WIZ_global_data;
    if (!data) return null;
    const raw = {};
    for (const key of KEYS) {
      const value = data[key];
      if (typeof value === 'string' && value) raw[key] = value;
    }
    return raw;
  }

  function publish() {
    const raw = collect();
    if (!raw) return false;
    window.postMessage({ source: EVENT, raw }, window.location.origin);
    return true;
  }

  // The isolated side asks when it needs them, because it may load first and
  // because the token is refreshed on a long-lived tab.
  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    if (event.data?.source !== `${EVENT}:request`) return;
    publish();
  });

  // WIZ_global_data is inlined in the document, so it is usually there
  // already. If it is not, try a few times rather than fail the session.
  if (!publish()) {
    let tries = 0;
    const timer = setInterval(() => {
      if (publish() || ++tries > 40) clearInterval(timer);
    }, 250);
  }
})();
