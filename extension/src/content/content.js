/**
 * Content script bootstrap.
 *
 * MV3 does not accept `"type": "module"` for content scripts, so this stays a
 * classic script and dynamically imports the rest from a web-accessible
 * resource. The imported module runs in the content script's isolated world,
 * with `chrome.*` available.
 *
 * Two rules govern this file, because they decide whether the user sees
 * anything at all:
 *   1. the message listener is wired BEFORE loading, so clicking the toolbar
 *      icon always does something, even mid-initialisation;
 *   2. a load failure is shown in the page, never only in the console — a
 *      silent extension is indistinguishable from a missing one.
 */

(() => {
  if (window.__gpCleanerLoaded) return;
  window.__gpCleanerLoaded = true;

  let panel = null;
  let loadError = null;
  let toggleRequested = false;

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type !== 'TOGGLE_PANEL') return false;
    if (panel) {
      panel.toggle();
    } else if (loadError) {
      showLoadError(loadError);
    } else {
      // Still loading: remember the intent and open as soon as the panel is
      // ready.
      toggleRequested = true;
      showBootNotice();
    }
    sendResponse({ ok: true, ready: !!panel, error: loadError && String(loadError.message || loadError) });
    return false;
  });

  boot();

  async function boot() {
    try {
      const { Panel } = await import(chrome.runtime.getURL('src/ui/panel.js'));
      panel = new Panel();
      await panel.mount();
      window.__gpCleanerPanel = panel;
      removeNotice();
      if (toggleRequested) panel.toggle(true);
    } catch (err) {
      loadError = err;
      console.error('[Photo Cleaner] failed to load:', err);
      showLoadError(err);
    }
  }

  /* --------------------------------------------------------- fallbacks */

  /**
   * Minimal banner, independent of the panel: it has to work in precisely the
   * case where the panel failed to load.
   */
  function notice() {
    let host = document.getElementById('gp-cleaner-notice');
    if (host) return host.shadowRoot.querySelector('.box');

    host = document.createElement('div');
    host.id = 'gp-cleaner-notice';
    const root = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      .box {
        position: fixed; top: 72px; right: 16px; z-index: 2147483000;
        max-width: 340px; padding: 11px 14px;
        border-radius: 10px; border: 1px solid #34353c;
        background: #202126; color: #e8eaed;
        font: 400 12.5px/1.5 "Google Sans", Roboto, system-ui, sans-serif;
        box-shadow: 0 8px 28px rgba(0,0,0,.5);
      }
      .box.error { border-color: #f28b82; }
      .box b { display: block; margin-bottom: 3px; font-weight: 600; }
      .box code { font: 11px/1.4 ui-monospace, Menlo, monospace; word-break: break-all; opacity: .8; }
    `;
    const box = document.createElement('div');
    box.className = 'box';
    root.append(style, box);
    (document.body || document.documentElement).append(host);
    return box;
  }

  function showBootNotice() {
    const box = notice();
    box.className = 'box';
    box.textContent = 'Photo Cleaner: starting…';
  }

  function showLoadError(err) {
    const box = notice();
    box.className = 'box error';
    box.replaceChildren();
    const title = document.createElement('b');
    title.textContent = 'Photo Cleaner could not start';
    const detail = document.createElement('code');
    detail.textContent = String(err?.message || err);
    box.append(title, detail);
  }

  function removeNotice() {
    document.getElementById('gp-cleaner-notice')?.remove();
  }
})();
