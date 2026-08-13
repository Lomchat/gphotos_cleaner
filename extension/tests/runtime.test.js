/**
 * Surviving a reloaded extension.
 *
 * Reloading or updating an extension does not reload the pages it is already
 * running on. The old content script keeps going — panel on screen, buttons
 * responding — with a dead `chrome.*` bridge underneath. Observed exactly that
 * way: an uncaught "Extension context invalidated" from a `.catch()`-guarded
 * storage write, while the panel carried on looking healthy and saving nothing.
 *
 * The `.catch()` did not help because the throw is *synchronous*: it happens
 * before the promise exists. That is the case these tests exist for, and it is
 * the one that is easy to reintroduce, because the guarded and unguarded forms
 * look identical.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  ContextLostError, extensionAlive, isContextLost,
  storageGet, storageSet, storageRemove, sendMessage
} from '../src/content/runtime.js';
import { Panel } from '../src/ui/panel.js';

/** Install a fake `chrome`, run, restore. */
async function withChrome(fake, fn) {
  const had = 'chrome' in globalThis;
  const previous = globalThis.chrome;
  globalThis.chrome = fake;
  try {
    return await fn();
  } finally {
    if (had) globalThis.chrome = previous;
    else delete globalThis.chrome;
  }
}

const alive = (over = {}) => ({
  runtime: { id: 'abc', sendMessage: async () => ({ ok: true }), ...(over.runtime || {}) },
  storage: { local: { get: async () => ({}), set: async () => {}, remove: async () => {}, ...(over.storageLocal || {}) } }
});

/** What Chrome actually does to an orphaned content script. */
const orphaned = () => ({
  runtime: {
    id: undefined,
    sendMessage: () => { throw new Error('Extension context invalidated.'); }
  },
  storage: {
    local: {
      get: () => { throw new Error('Extension context invalidated.'); },
      set: () => { throw new Error('Extension context invalidated.'); },
      remove: () => { throw new Error('Extension context invalidated.'); }
    }
  }
});

/* ---------------------------------------------------------------- detection */

test('a live bridge is recognised', () => withChrome(alive(), () => {
  assert.equal(extensionAlive(), true);
}));

test('an orphaned bridge is recognised by its missing id', () => withChrome(orphaned(), () => {
  assert.equal(extensionAlive(), false);
}));

test('no chrome at all is not a crash', () => withChrome(undefined, () => {
  assert.equal(extensionAlive(), false);
}));

test("Chrome's own wording is recognised, whatever raised it", () => {
  assert.equal(isContextLost(new Error('Extension context invalidated.')), true);
  assert.equal(isContextLost(new Error('Could not establish connection. Receiving end does not exist.')), true);
  assert.equal(isContextLost(new ContextLostError()), true);
});

test('an ordinary failure is not mistaken for a reload', () => {
  // Telling someone to reload the page when their disk quota is full would
  // send them round a loop that never fixes anything.
  assert.equal(isContextLost(new Error('QuotaExceededError')), false);
  assert.equal(isContextLost(new Error('HTTP 500')), false);
  assert.equal(isContextLost(null), false);
});

/* ------------------------------------------------------------ the wrapping */

test('a synchronous throw becomes a rejection', async () => {
  // The whole point. `chrome.storage.local.set(...).catch(...)` never reaches
  // its catch, because the exception precedes the promise.
  await withChrome(orphaned(), async () => {
    await assert.rejects(() => storageSet({ a: 1 }), ContextLostError);
    await assert.rejects(() => storageGet(['a']), ContextLostError);
    await assert.rejects(() => storageRemove(['a']), ContextLostError);
    await assert.rejects(() => sendMessage({ type: 'X' }), ContextLostError);
  });
});

test('the failure carries the only instruction that works', async () => {
  await withChrome(orphaned(), async () => {
    const err = await storageSet({ a: 1 }).catch((e) => e);
    assert.match(err.message, /[Rr]eload this page/);
  });
});

test('an asynchronous invalidation is caught too', async () => {
  // Some paths reject rather than throw: the bridge dies between the call and
  // the reply.
  const late = alive({ storageLocal: { set: async () => { throw new Error('Extension context invalidated.'); } } });
  await withChrome(late, async () => {
    await assert.rejects(() => storageSet({ a: 1 }), ContextLostError);
  });
});

test('a real storage error passes through unchanged', async () => {
  const failing = alive({ storageLocal: { set: async () => { throw new Error('QUOTA_BYTES quota exceeded'); } } });
  await withChrome(failing, async () => {
    const err = await storageSet({ a: 1 }).catch((e) => e);
    assert.equal(err instanceof ContextLostError, false);
    assert.match(err.message, /QUOTA_BYTES/);
  });
});

test('a working bridge is not disturbed', async () => {
  await withChrome(alive({ storageLocal: { get: async () => ({ k: 1 }) } }), async () => {
    assert.deepEqual(await storageGet(['k']), { k: 1 });
    assert.deepEqual(await sendMessage({ type: 'PING' }), { ok: true });
  });
});

/* --------------------------------------------------------------- the panel */

test('the panel says so once, not once per write', () => {
  // Every slider calls persist(). Thirty banners and thirty renders for one
  // fact would be worse than the silence it replaces.
  let renders = 0;
  const fake = {
    state: { contextLost: false, busy: 'full' },
    setStatus() {},
    renderAll() { renders++; },
    noteContext: Panel.prototype.noteContext
  };
  const err = new ContextLostError();
  assert.equal(fake.noteContext(err), true);
  assert.equal(fake.noteContext(err), true);
  assert.equal(fake.noteContext(err), true);
  assert.equal(renders, 1);
  assert.equal(fake.state.contextLost, true);
});

test('a lost bridge ends whatever the panel thought it was doing', () => {
  // Otherwise the run stays "busy" forever: it cannot finish, and every button
  // stays disabled behind it.
  const fake = {
    state: { contextLost: false, busy: 'full' },
    setStatus() {}, renderAll() {},
    noteContext: Panel.prototype.noteContext
  };
  fake.noteContext(new ContextLostError());
  assert.equal(fake.state.busy, null);
});

test('an ordinary error leaves the panel alone', () => {
  const fake = {
    state: { contextLost: false, busy: 'full' },
    setStatus() {}, renderAll() {},
    noteContext: Panel.prototype.noteContext
  };
  assert.equal(fake.noteContext(new Error('HTTP 500')), false);
  assert.equal(fake.state.contextLost, false);
  assert.equal(fake.state.busy, 'full', 'a failed request is not a dead extension');
});

test('the panel reaches the extension only through the guard', () => {
  // A single unguarded `chrome.` call is enough to put an uncaught error back
  // in Google's console and leave the panel silently saving nothing.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const calls = [...source.matchAll(/^.*\bchrome\.(storage|runtime)\b.*$/gm)]
    .map((m) => m[0].trim())
    .filter((line) => !line.startsWith('*') && !line.startsWith('//'));
  assert.deepEqual(calls, [], `unguarded extension calls: ${calls.join(' | ')}`);
});

test('the banner offers the reload rather than performing it', () => {
  // A run may be half done or a selection half made. Throwing the page away
  // without asking would lose both.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const start = source.indexOf('buildContextBanner()');
  const block = source.slice(start, start + 900);
  assert.match(block, /location\.reload\(\)/);
  assert.match(block, /onclick/, 'behind a button, not on sight');
});

test('the run button is disabled once the bridge is gone', () => {
  // It would start, fail on its first batch, and report an error about the
  // analysis engine that says nothing about the real cause.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  assert.match(source, /disabled: this\.state\.contextLost \|\|/);
});
