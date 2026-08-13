/**
 * The paging loop, end to end without a browser.
 *
 * Every mistake this loop can make is silent. A run that stops one page early
 * reports success. A run that ignores the date window lists the wrong half of
 * the library and reports success. A run that spends its limit on items it
 * already had reports success, having done nothing. The counters in the panel
 * would agree with all three.
 *
 * So the loop is driven here against a scripted API and a fake store, and what
 * is checked is not "did it finish" but *which items ended up in the catalogue
 * and what the cursor says next time*.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { ApiScanner } from '../src/content/api-scanner.js';

const TOKENS = { at: 'AT', sid: 'SID', bl: 'BL', path: '/' };
const DAY = 86400000;
const T0 = 1700000000000;

/** A raw item as the API sends it, `n` days before T0. */
function raw(id, daysAgo = 0, over = {}) {
  return [
    id,
    [`https://lh3.googleusercontent.com/${id}`, 100, 100],
    over.ts === undefined ? T0 - daysAgo * DAY : over.ts,
    `dedup-${id}`,
    0, T0, null, [[1]], null, null, null, null, null, false,
    over.options || {}
  ];
}

/**
 * An API that answers `pages` in order, and records what it was asked.
 * Metadata requests are answered with a size, so the size pass has something.
 */
function fakeApi(pages) {
  const asked = [];
  const fetchImpl = async (url, init) => {
    const params = new URLSearchParams(init.body);
    const [rpcid, argsJson] = JSON.parse(params.get('f.req'))[0][0];
    const args = JSON.parse(argsJson);

    let payload;
    if (rpcid === 'lcxiM') {
      asked.push({ pageId: args[0], before: args[1], size: args[2] });
      payload = pages.length ? pages.shift() : [[], null, null];
    } else {
      // Metadata: one row per key, each a megabyte.
      const keys = args[0][0][0].map(([k]) => k);
      payload = [[null, keys.map((k) => [k, [null, null, null, `${k}.jpg`,
        null, null, T0, null, null, 1048576, [1, 1048576, 2]]])]];
    }
    return {
      ok: true, status: 200,
      text: async () => ")]}'\n\n" + JSON.stringify([['wrb.fr', rpcid, JSON.stringify(payload)]])
    };
  };
  return { asked, fetchImpl };
}

/** A store that behaves like the real one for the handful of calls used. */
function fakeStore(existing = []) {
  const rows = new Map(existing.map((id) => [id, { id }]));
  let meta = null;
  return {
    rows,
    get meta() { return meta; },
    deps: {
      getAllIds: async () => [...rows.keys()],
      upsertItems: async (batch) => {
        for (const r of batch) rows.set(r.id, { ...(rows.get(r.id) || {}), ...r });
      },
      getMeta: async () => meta,
      setMeta: async (_key, value) => { meta = value; },
      getTokens: async () => TOKENS,
      refreshTokens: async () => TOKENS
    }
  };
}

function scanner(store, api, opts = {}) {
  return new ApiScanner({
    tokens: TOKENS,
    deps: store.deps,
    fetchImpl: api.fetchImpl,
    withSizes: false,
    ...opts
  });
}

/* ---------------------------------------------------------------- paging */

test('a library shorter than one page is listed and finished', async () => {
  const store = fakeStore();
  const api = fakeApi([[[raw('a'), raw('b', 1)], null, String(T0 - DAY)]]);
  const r = await scanner(store, api).run();

  assert.equal(r.discovered, 2);
  assert.equal(r.reachedEnd, true);
  assert.deepEqual([...store.rows.keys()], ['a', 'b']);
});

test('the cursor from one page is what asks for the next', async () => {
  const store = fakeStore();
  const api = fakeApi([
    [[raw('a')], 'PAGE2', String(T0)],
    [[raw('b', 1)], 'PAGE3', String(T0 - DAY)],
    [[raw('c', 2)], null, String(T0 - 2 * DAY)]
  ]);
  const r = await scanner(store, api).run();

  assert.equal(r.discovered, 3);
  assert.deepEqual(api.asked.map((a) => a.pageId), [null, 'PAGE2', 'PAGE3']);
  assert.equal(api.asked[1].before, null,
    'once paging by cursor the date is dropped: the cursor carries the position');
});

test('the run stops at its limit, mid-page, without losing what it read', async () => {
  const store = fakeStore();
  const many = Array.from({ length: 10 }, (_, i) => raw(`i${i}`, i));
  const api = fakeApi([[many, 'PAGE2', String(T0)]]);
  const r = await scanner(store, api, { maxNewItems: 4 }).run();

  assert.equal(r.limitReached, true);
  assert.equal(r.discovered, 4);
  assert.equal(store.rows.size, 4, 'the partial page is stored, not discarded');
  assert.equal(api.asked.length, 1, 'and no further page is requested');
});

test('an aborted run keeps what it already listed', async () => {
  const store = fakeStore();
  const api = fakeApi([
    [[raw('a')], 'PAGE2', String(T0)],
    [[raw('b', 1)], 'PAGE3', String(T0 - DAY)]
  ]);
  const s = scanner(store, api);
  const done = s.run(() => s.abort());
  const r = await done;

  assert.equal(r.aborted, true);
  assert.equal(store.rows.size, 1);
});

/* --------------------------------------------------------- the date window */

test('the window is asked for, and enforced on what comes back', async () => {
  // Belt and braces on purpose: the whole scope of the run rests on that
  // parameter, and if Google ever ignores it the skip count says so rather
  // than the run silently listing recent photos.
  const store = fakeStore();
  const cutoff = T0 - 5 * DAY;
  const api = fakeApi([[[raw('recent', 1), raw('old', 10)], null, String(T0)]]);
  const r = await scanner(store, api, { olderThanTs: cutoff }).run();

  assert.equal(api.asked[0].before, cutoff, 'the date is a request parameter');
  assert.equal(r.skippedRecent, 1);
  assert.deepEqual([...store.rows.keys()], ['old']);
});

test('an item with no date at all is kept rather than dropped', async () => {
  // Better to offer something uncertain than to lose it silently.
  const store = fakeStore();
  const api = fakeApi([[[raw('undated', 0, { ts: null })], null, null]]);
  await scanner(store, api, { olderThanTs: T0 - DAY }).run();
  assert.ok(store.rows.has('undated'));
});

/* ------------------------------------------------------------ what is new */

test('items already in the catalogue do not count against the limit', async () => {
  // The failure this prevents: a resumed run spending its two thousand slots
  // re-listing what it already had, and reporting a full run.
  const store = fakeStore(['a', 'b', 'c']);
  const api = fakeApi([[[raw('a'), raw('b', 1), raw('c', 2), raw('d', 3)], null, String(T0)]]);
  const r = await scanner(store, api, { maxNewItems: 2 }).run();

  assert.equal(r.discovered, 1);
  assert.equal(r.alreadyKnown, 3);
  assert.equal(r.limitReached, false, 'one new item is not a full run');
});

test('an item with no thumbnail is counted and left out', async () => {
  // Should never happen through the API. Reported anyway, because a gap nobody
  // is told about is how the last one ran unnoticed for weeks.
  const store = fakeStore();
  const noThumb = raw('x');
  noThumb[1] = [null, null, null];
  const api = fakeApi([[[noThumb, raw('y', 1)], null, String(T0)]]);
  const r = await scanner(store, api).run();

  assert.equal(r.skippedNoThumb, 1);
  assert.deepEqual([...store.rows.keys()], ['y']);
});

/* ----------------------------------------------------------- the cursor */

test('a finished run records that the library is fully covered', async () => {
  const store = fakeStore();
  const api = fakeApi([[[raw('a')], null, String(T0)]]);
  await scanner(store, api).run();

  assert.equal(store.meta.reachedEnd, true);
  assert.equal(store.meta.lastTimestamp, null, 'no position to resume from');
  assert.equal(store.meta.pageId, null);
});

test('an interrupted run records where to pick up, and under which window', async () => {
  const store = fakeStore();
  const api = fakeApi([[Array.from({ length: 5 }, (_, i) => raw(`i${i}`, i)), 'NEXT', String(T0)]]);
  await scanner(store, api, { maxNewItems: 3, olderThanTs: T0 - DAY }).run();

  assert.equal(store.meta.reachedEnd, false);
  assert.equal(store.meta.olderThanTs, T0 - DAY,
    'the cursor remembers the question it answers');
  assert.ok(store.meta.lastTimestamp, 'and where it got to');
});

test('a second run continues from the recorded date', async () => {
  const store = fakeStore();
  await scanner(store, fakeApi([[[raw('a'), raw('b', 1)], 'NEXT', String(T0)]]),
    { maxNewItems: 2 }).run();

  const api2 = fakeApi([[[raw('c', 2)], null, String(T0 - 2 * DAY)]]);
  await scanner(store, api2).run();

  assert.equal(api2.asked[0].before, T0 - DAY, 'the oldest item seen last time');
  assert.deepEqual([...store.rows.keys()], ['a', 'b', 'c']);
});

test('changing the window discards the position rather than misusing it', async () => {
  const store = fakeStore();
  await scanner(store, fakeApi([[[raw('a')], 'NEXT', String(T0)]]), { maxNewItems: 1 }).run();

  const api2 = fakeApi([[[raw('b', 30)], null, null]]);
  const r = await scanner(store, api2, { olderThanTs: T0 - 20 * DAY }).run();

  assert.equal(r.resumedFrom, 'window-changed');
  assert.equal(api2.asked[0].before, T0 - 20 * DAY);
});

test('topping up a finished library stops once the pages are all known', async () => {
  // New photos arrive at the head, so the top-up restarts there. Without a
  // stop it would walk the entire library again on every run.
  const store = fakeStore();
  await scanner(store, fakeApi([[[raw('a')], null, String(T0)]])).run();
  assert.equal(store.meta.reachedEnd, true);

  const known = [[[raw('a')], 'P', String(T0)]];
  for (let i = 0; i < 6; i++) known.push([[raw('a')], `P${i}`, String(T0)]);
  const api2 = fakeApi(known);
  const r = await scanner(store, api2, { knownPagesBeforeStop: 3 }).run();

  assert.equal(r.resumedFrom, 'completed');
  assert.ok(api2.asked.length <= 4, `stopped after ${api2.asked.length} pages`);
  assert.equal(store.meta.reachedEnd, true,
    'the library is still fully covered; the cursor must not park mid-way');
});

/* -------------------------------------------------------------- failures */

test('a rate-limited page is retried, then succeeds', async () => {
  const store = fakeStore();
  const good = fakeApi([[[raw('a')], null, String(T0)]]);
  let n = 0;
  const fetchImpl = async (url, init) => {
    if (++n === 1) return { ok: false, status: 429, text: async () => '' };
    return good.fetchImpl(url, init);
  };
  const r = await new ApiScanner({
    tokens: TOKENS, deps: store.deps, fetchImpl, withSizes: false, retryBaseMs: 1
  }).run();

  assert.equal(r.retries, 1);
  assert.equal(r.discovered, 1);
});

test('a rotated request token is refreshed once rather than failing the run', async () => {
  const store = fakeStore();
  let refreshed = 0;
  const good = fakeApi([[[raw('a')], null, String(T0)]]);
  let n = 0;
  const fetchImpl = async (url, init) => {
    if (++n === 1) return { ok: false, status: 401, text: async () => '' };
    return good.fetchImpl(url, init);
  };
  const r = await new ApiScanner({
    tokens: TOKENS,
    deps: { ...store.deps, refreshTokens: async () => { refreshed++; return TOKENS; } },
    fetchImpl, withSizes: false, retryBaseMs: 1
  }).run();

  assert.equal(refreshed, 1, 'asked the page for a fresh token instead of a reload');
  assert.equal(r.discovered, 1);
});

test('a changed response format stops immediately instead of retrying', async () => {
  // Retrying a malformed response four times only delays telling the user that
  // Google changed something.
  const store = fakeStore();
  let n = 0;
  const fetchImpl = async () => {
    n++;
    return { ok: true, status: 200, text: async () => 'nothing like an envelope' };
  };
  const r = await new ApiScanner({
    tokens: TOKENS, deps: store.deps, fetchImpl, withSizes: false, retryBaseMs: 1
  }).run();

  assert.equal(n, 1);
  assert.ok(r.error, 'and the run reports why it stopped');
});

test('a failed listing still saves what it managed to read', async () => {
  const store = fakeStore();
  const good = fakeApi([[[raw('a')], 'NEXT', String(T0)]]);
  let n = 0;
  const fetchImpl = async (url, init) => {
    n++;
    if (n === 1) return good.fetchImpl(url, init);
    return { ok: true, status: 200, text: async () => 'broken' };
  };
  const r = await new ApiScanner({
    tokens: TOKENS, deps: store.deps, fetchImpl, withSizes: false, retryBaseMs: 1
  }).run();

  assert.equal(store.rows.size, 1);
  assert.ok(r.error);
  assert.equal(store.meta.reachedEnd, false, 'so the next run picks up rather than restarting');
});

/* ------------------------------------------------------------- the sizes */

test('the size pass fills in names and bytes for what was just listed', async () => {
  const store = fakeStore();
  const api = fakeApi([[[raw('a'), raw('b', 1)], null, String(T0)]]);
  const r = await scanner(store, api, { withSizes: true }).run();

  assert.equal(r.sized, 2);
  assert.equal(r.bytes, 2 * 1048576);
  assert.equal(store.rows.get('a').sizeBytes, 1048576);
  assert.equal(store.rows.get('a').fileName, 'a.jpg');
  assert.equal(store.rows.get('a').label, 'a.jpg', 'the file name is what the grid shows');
});

test('the size pass never overwrites the listing it enriches', async () => {
  const store = fakeStore();
  const api = fakeApi([[[raw('a')], null, String(T0)]]);
  await scanner(store, api, { withSizes: true }).run();

  const row = store.rows.get('a');
  assert.equal(row.url, 'https://lh3.googleusercontent.com/a=w176-h176');
  assert.equal(row.ts, T0);
  assert.equal(row.dedupKey, 'dedup-a', 'without this the item cannot be deleted');
});

test('sizes failing does not cost the listing', async () => {
  const store = fakeStore();
  const good = fakeApi([[[raw('a')], null, String(T0)]]);
  const fetchImpl = async (url, init) => {
    const [rpcid] = JSON.parse(new URLSearchParams(init.body).get('f.req'))[0][0];
    if (rpcid !== 'lcxiM') return { ok: false, status: 500, text: async () => '' };
    return good.fetchImpl(url, init);
  };
  const r = await new ApiScanner({
    tokens: TOKENS, deps: store.deps, fetchImpl, withSizes: true, retryBaseMs: 1
  }).run();

  assert.equal(r.discovered, 1);
  assert.equal(r.sized, 0);
  assert.equal(store.rows.get('a').sizeBytes, null);
});

test('a run that cannot start can be started again', async () => {
  // The guard against two concurrent listings must not latch when the first
  // one never got going: no session on a page still loading is ordinary, and
  // every later run would refuse with "already running".
  const store = fakeStore();
  const failing = { ...store.deps, getTokens: async () => { throw new Error('no session yet'); } };
  const s = new ApiScanner({ deps: failing, fetchImpl: async () => {}, withSizes: false });
  await assert.rejects(() => s.run(), /no session yet/);
  await assert.rejects(() => s.run(), /no session yet/, 'and not "already running"');
});
