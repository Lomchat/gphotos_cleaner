/**
 * Service worker. Its only real job: guarantee the offscreen document exists,
 * and relay analysis batches from the content script.
 */

const OFFSCREEN_URL = 'src/offscreen/offscreen.html';
let creating = null;

async function hasOffscreen() {
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    return contexts.length > 0;
  } catch {
    // Fallback for Chrome versions without getContexts.
    return typeof chrome.offscreen?.hasDocument === 'function'
      ? chrome.offscreen.hasDocument()
      : false;
  }
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creating) {
    await creating;
    return;
  }
  creating = chrome.offscreen
    .createDocument({
      url: OFFSCREEN_URL,
      reasons: ['BLOBS'],
      justification:
        'Decode and analyse library thumbnails locally, off the page thread.'
    })
    .catch((err) => {
      // Possible race: another call may have created the document meanwhile.
      if (!String(err).includes('Only a single offscreen')) throw err;
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;

  if (msg.type === 'ANALYZE_BATCH') {
    (async () => {
      try {
        await ensureOffscreen();
        const res = await chrome.runtime.sendMessage({
          target: 'offscreen',
          type: 'ANALYZE_BATCH',
          items: msg.items
        });
        sendResponse(res || { ok: false, error: 'No reply from the analysis engine' });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // The people pass shares the offscreen document with the main analysis, so
  // it goes through the same relay. Listed by name rather than forwarded
  // wholesale: a content script must not be able to reach arbitrary handlers.
  if (msg.type === 'PEOPLE_STATUS' || msg.type === 'PEOPLE_DOWNLOAD' ||
      msg.type === 'PEOPLE_FORGET' || msg.type === 'PEOPLE_BATCH') {
    (async () => {
      try {
        await ensureOffscreen();
        const res = await chrome.runtime.sendMessage({
          target: 'offscreen', type: msg.type, items: msg.items
        });
        sendResponse(res || { ok: false, error: 'No reply from the analysis engine' });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  // Download progress travels the other way, offscreen -> panel. Relayed to
  // every Google Photos tab, since the offscreen document cannot address them.
  if (msg.type === 'PEOPLE_PROGRESS') {
    chrome.tabs.query({ url: 'https://photos.google.com/*' }).then((tabs) => {
      for (const tab of tabs) chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
    }).catch(() => {});
    return false;
  }

  if (msg.type === 'ENGINE_STATUS') {
    (async () => {
      try {
        await ensureOffscreen();
        const res = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'PING' });
        sendResponse(res || { ok: false });
      } catch (err) {
        sendResponse({ ok: false, error: String(err?.message || err) });
      }
    })();
    return true;
  }

  return false;
});

// Toolbar click: open Google Photos, or reveal the existing tab.
chrome.action.onClicked.addListener(async (tab) => {
  if (tab?.url?.startsWith('https://photos.google.com/')) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'TOGGLE_PANEL' });
      return;
    } catch {
      // Content script not injected yet — typically a tab opened before the
      // extension was installed. A reload injects it.
      await chrome.tabs.reload(tab.id);
      return;
    }
  }

  try {
    const [existing] = await chrome.tabs.query({ url: 'https://photos.google.com/*' });
    if (existing) {
      await chrome.tabs.update(existing.id, { active: true });
      await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
  } catch {
    // Filtering by URL needs host permissions; if denied, just open a new tab.
  }
  await chrome.tabs.create({ url: 'https://photos.google.com/' });
});
