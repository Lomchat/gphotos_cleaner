/**
 * Talking to the extension from a content script that may have been orphaned.
 *
 * Reloading or updating an extension does not reload the pages it is already
 * running on. The old content script keeps executing — its timers fire, its
 * listeners run, the panel is still on screen — but its `chrome.*` bridge is
 * dead. Every call across it throws "Extension context invalidated".
 *
 * That throw is *synchronous*. `chrome.storage.local.set(...).catch(...)` does
 * not help: the exception happens before the promise exists, so the `.catch`
 * is never reached and it surfaces as an uncaught error in Google's own
 * console, while the panel goes on looking perfectly healthy and quietly saving
 * nothing.
 *
 * So every call goes through here, and the answer to a dead bridge is one
 * thing: tell the user to reload the page. Nothing else can fix it — not a
 * retry, not a fallback. The page must be reloaded to get a live content
 * script, and only the user should decide when.
 */

/** Raised when the bridge is gone. Carries no advice but the one that works. */
export class ContextLostError extends Error {
  constructor() {
    super('The extension was reloaded or updated. Reload this page to reconnect.');
    this.name = 'ContextLostError';
    this.contextLost = true;
  }
}

/**
 * Is the bridge still there?
 *
 * `chrome.runtime.id` is the cheapest live check: it is present on a valid
 * context and gone on an orphaned one. Reading it is itself wrapped, because on
 * some invalidation paths even the property access throws.
 */
export function extensionAlive() {
  try {
    return !!(globalThis.chrome && chrome.runtime && chrome.runtime.id);
  } catch {
    return false;
  }
}

/** Does this error mean the bridge died, rather than the call failing? */
export function isContextLost(err) {
  if (err?.contextLost) return true;
  const message = String(err?.message || err || '');
  return /Extension context invalidated|context invalidated|receiving end does not exist/i.test(message);
}

/**
 * Run something that touches `chrome.*`, converting a dead bridge into a
 * rejection rather than a synchronous throw. Everything else passes through
 * unchanged: a real storage failure is not a reload.
 */
async function guarded(fn) {
  if (!extensionAlive()) throw new ContextLostError();
  try {
    return await fn();
  } catch (err) {
    if (isContextLost(err)) throw new ContextLostError();
    throw err;
  }
}

export function storageGet(keys) {
  return guarded(() => chrome.storage.local.get(keys));
}

export function storageSet(values) {
  return guarded(() => chrome.storage.local.set(values));
}

export function storageRemove(keys) {
  return guarded(() => chrome.storage.local.remove(keys));
}

export function sendMessage(message) {
  return guarded(() => chrome.runtime.sendMessage(message));
}
