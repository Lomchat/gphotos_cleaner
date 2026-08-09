/**
 * Backend client.
 *
 * The backend is optional, which means every one of these paths is a path the
 * user will actually hit: server not started, wrong token, stopped halfway
 * through a run. Each one has to end in a readable message rather than a
 * half-updated catalogue.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  analyse, checkHealth, known, listGroups, renameGroup, groupPhotos,
  clearBackend, group, invertGroups, groupLabel, normaliseUrl,
  BackendError, DEFAULT_BACKEND
} from '../src/common/backend.js';

const CFG = { url: 'http://127.0.0.1:8765', token: 'tok' };

/** Minimal fetch double: a route table plus a log of what was sent. */
function fakeFetch(routes) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const path = url.replace(CFG.url, '');
    calls.push({ path, method: init.method || 'GET', headers: init.headers, body: init.body ? JSON.parse(init.body) : null, signal: init.signal });
    const handler = routes[path] ?? routes[`${init.method || 'GET'} ${path}`];
    if (!handler) throw new Error(`unexpected request ${path}`);
    const result = typeof handler === 'function' ? await handler(calls.at(-1)) : handler;
    if (result instanceof Error) throw result;
    return {
      ok: result.status === undefined || result.status < 400,
      status: result.status ?? 200,
      json: async () => result.body
    };
  };
  return calls;
}

test.afterEach(() => { delete globalThis.fetch; });

/* ------------------------------------------------------------------ url */

test('a trailing slash never produces a double slash', () => {
  assert.equal(normaliseUrl('http://127.0.0.1:8765/'), 'http://127.0.0.1:8765');
  assert.equal(normaliseUrl('http://127.0.0.1:8765///'), 'http://127.0.0.1:8765');
});

test('surrounding whitespace is forgiven', () => {
  assert.equal(normaliseUrl('  http://x  '), 'http://x');
});

test('the backend is off by default', () => {
  assert.equal(DEFAULT_BACKEND.enabled, false);
});

test('an empty URL fails before any request', async () => {
  fakeFetch({});
  await assert.rejects(() => listGroups({ url: '', token: '' }), /no backend URL/);
});

/* --------------------------------------------------------------- health */

test('a reachable backend with a good token reports authOk', async () => {
  fakeFetch({
    '/health': { body: { status: 'ok', authRequired: true, stats: { photos: 3 } } },
    '/known': { body: { known: [] } }
  });
  const health = await checkHealth(CFG);
  assert.equal(health.authOk, true);
  assert.equal(health.stats.photos, 3);
});

test('a wrong token is reported as running-but-unauthorised, not as down', async () => {
  fakeFetch({
    '/health': { body: { status: 'ok', authRequired: true } },
    '/known': { status: 401, body: { detail: 'bad token' } }
  });
  const health = await checkHealth(CFG);
  assert.equal(health.status, 'ok');
  assert.equal(health.authOk, false);
});

test('a backend that needs no token is not probed for one', async () => {
  const calls = fakeFetch({ '/health': { body: { status: 'ok', authRequired: false } } });
  const health = await checkHealth(CFG);
  assert.equal(health.authOk, true);
  assert.equal(calls.filter((c) => c.path === '/known').length, 0);
});

test('an unreachable backend raises a network error, not a crash', async () => {
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  await assert.rejects(() => checkHealth(CFG), (err) => {
    assert.ok(err instanceof BackendError);
    assert.equal(err.kind, 'network');
    return true;
  });
});

test('the token travels in a header, never in the URL', async () => {
  const calls = fakeFetch({ '/health': { body: { status: 'ok', authRequired: false } } });
  await checkHealth(CFG);
  assert.equal(calls[0].headers['X-Cleaner-Token'], 'tok');
  assert.equal(calls[0].path.includes('tok'), false);
});

test('no token header is sent when none is configured', async () => {
  const calls = fakeFetch({ '/health': { body: { status: 'ok', authRequired: false } } });
  await checkHealth({ url: CFG.url, token: '' });
  assert.equal('X-Cleaner-Token' in calls[0].headers, false);
});

/* ---------------------------------------------------------------- known */

test('known() returns a set of ids', async () => {
  fakeFetch({ '/known': { body: { known: ['a', 'b'] } } });
  const found = await known(CFG, ['a', 'b', 'c']);
  assert.deepEqual([...found].sort(), ['a', 'b']);
});

test('known() splits large id lists into several requests', async () => {
  const calls = fakeFetch({ '/known': (call) => ({ body: { known: call.body.photoIds.slice(0, 1) } }) });
  const ids = Array.from({ length: 1200 }, (_, i) => `p${i}`);
  await known(CFG, ids);
  assert.equal(calls.length, 3);
  assert.ok(calls.every((c) => c.body.photoIds.length <= 500));
});

test('known() makes no request for an empty list', async () => {
  const calls = fakeFetch({});
  assert.equal((await known(CFG, [])).size, 0);
  assert.equal(calls.length, 0);
});

/* -------------------------------------------------------------- analyse */

const items = Array.from({ length: 250 }, (_, i) => ({ photoId: `p${i}`, url: `https://x/${i}` }));
const okBatch = (call) => ({
  body: {
    analysed: call.body.items.map((i) => ({ photoId: i.photoId })),
    failed: [], skipped: [], elapsedMs: 1
  }
});

test('items are sent in batches', async () => {
  const calls = fakeFetch({ '/analyse': okBatch });
  const totals = await analyse(CFG, items, { batchSize: 100 });
  assert.equal(calls.length, 3);
  assert.equal(totals.analysed, 250);
});

test('only the id and the URL leave the browser', async () => {
  const calls = fakeFetch({ '/analyse': okBatch });
  await analyse(CFG, [{ photoId: 'p1', url: 'https://x/1', features: { secret: 1 }, ts: 5 }]);
  assert.deepEqual(calls[0].body.items, [{ photoId: 'p1', url: 'https://x/1' }]);
});

test('progress is reported after every batch', async () => {
  fakeFetch({ '/analyse': okBatch });
  const seen = [];
  await analyse(CFG, items, { batchSize: 100, onBatch: (b) => seen.push(b.done) });
  assert.deepEqual(seen, [100, 200, 250]);
});

test('one failing batch does not throw away the others', async () => {
  let n = 0;
  fakeFetch({ '/analyse': (call) => (++n === 2 ? new TypeError('boom') : okBatch(call)) });
  const totals = await analyse(CFG, items, { batchSize: 100 });
  assert.equal(totals.analysed, 150);
  assert.equal(totals.errors.length, 1);
});

test('a bad token stops the run instead of repeating 3 times', async () => {
  const calls = fakeFetch({ '/analyse': { status: 401, body: { detail: 'bad token' } } });
  const totals = await analyse(CFG, items, { batchSize: 100 });
  assert.equal(calls.length, 1);
  assert.equal(totals.errors.length, 1);
});

test('a missing model stops the run too', async () => {
  const calls = fakeFetch({ '/analyse': { status: 503, body: { detail: 'model missing' } } });
  await analyse(CFG, items, { batchSize: 100 });
  assert.equal(calls.length, 1);
});

test('an abort signal stops between batches', async () => {
  const controller = new AbortController();
  let n = 0;
  const calls = fakeFetch({ '/analyse': (call) => { if (++n === 2) controller.abort(); return okBatch(call); } });
  await analyse(CFG, items, { batchSize: 100, signal: controller.signal });
  assert.equal(calls.length, 2);
});

test('failures and skips are tallied separately', async () => {
  fakeFetch({ '/analyse': { body: { analysed: [{ photoId: 'a' }], failed: [{ photoId: 'b' }], skipped: ['c', 'd'] } } });
  const totals = await analyse(CFG, [{ photoId: 'a', url: 'u' }]);
  assert.deepEqual(
    { a: totals.analysed, f: totals.failed, s: totals.skipped },
    { a: 1, f: 1, s: 2 }
  );
});

test('an empty item list makes no request', async () => {
  const calls = fakeFetch({});
  const totals = await analyse(CFG, []);
  assert.equal(calls.length, 0);
  assert.equal(totals.batches, 0);
});

/* --------------------------------------------------------------- groups */

test('grouping asks for the incremental mode by default', async () => {
  const calls = fakeFetch({ '/group': { body: { mode: 'incremental', groups: [] } } });
  await group(CFG);
  assert.equal(calls[0].body.incremental, true);
});

test('a rebuild asks for the full mode', async () => {
  const calls = fakeFetch({ '/group': { body: { mode: 'full', groups: [] } } });
  await group(CFG, { incremental: false });
  assert.equal(calls[0].body.incremental, false);
});

test('renaming sends the name and the group id', async () => {
  const calls = fakeFetch({ '/groups/2/name': { body: { groupId: 2, name: 'Mum' } } });
  await renameGroup(CFG, 2, 'Mum');
  assert.equal(calls[0].path, '/groups/2/name');
  assert.equal(calls[0].body.name, 'Mum');
});

test('clearing a name sends null rather than an empty string', async () => {
  const calls = fakeFetch({ '/groups/2/name': { body: {} } });
  await renameGroup(CFG, 2, null);
  assert.equal(calls[0].body.name, null);
});

test('group photos come back as a plain list', async () => {
  fakeFetch({ '/groups/1/photos': { body: { groupId: 1, photoIds: ['a', 'b'] } } });
  assert.deepEqual(await groupPhotos(CFG, 1), ['a', 'b']);
});

test('clearing backend data uses DELETE', async () => {
  const calls = fakeFetch({ 'DELETE /data': { body: { status: 'cleared' } } });
  await clearBackend(CFG);
  assert.equal(calls[0].method, 'DELETE');
});

/* ------------------------------------------------------------- inverting */

test('group membership is inverted into photo -> groups', () => {
  const byPhoto = invertGroups([
    { id: 0, photoIds: ['a', 'b'] },
    { id: 1, photoIds: ['b', 'c'] }
  ]);
  assert.deepEqual(byPhoto.get('a'), [0]);
  assert.deepEqual(byPhoto.get('b'), [0, 1]);
  assert.deepEqual(byPhoto.get('c'), [1]);
});

test('a photo in no group is absent, not empty', () => {
  // The distinction is what keeps "not analysed" from reading as "nobody".
  const byPhoto = invertGroups([{ id: 0, photoIds: ['a'] }]);
  assert.equal(byPhoto.has('z'), false);
});

test('group ids per photo come back sorted', () => {
  const byPhoto = invertGroups([
    { id: 5, photoIds: ['a'] }, { id: 1, photoIds: ['a'] }, { id: 3, photoIds: ['a'] }
  ]);
  assert.deepEqual(byPhoto.get('a'), [1, 3, 5]);
});

test('inverting nothing yields nothing', () => {
  assert.equal(invertGroups([]).size, 0);
});

/* --------------------------------------------------------------- labels */

test('a named group keeps its name', () => {
  assert.equal(groupLabel({ id: 0, name: 'Grandma' }), 'Grandma');
});

test('an unnamed group gets a 1-based label', () => {
  // Group ids start at 0; "Person 0" would read as a bug to anyone.
  assert.equal(groupLabel({ id: 0, name: null }), 'Person 1');
  assert.equal(groupLabel({ id: 7 }), 'Person 8');
});

/* --------------------------------------------------------------- errors */

test('an HTTP error carries the detail the backend sent', async () => {
  fakeFetch({ '/groups': { status: 500, body: { detail: 'database is locked' } } });
  await assert.rejects(() => listGroups(CFG), /database is locked/);
});

test('a non-JSON error body still produces a usable message', async () => {
  globalThis.fetch = async () => ({
    ok: false, status: 502,
    json: async () => { throw new SyntaxError('not json'); }
  });
  await assert.rejects(() => listGroups(CFG), /HTTP 502/);
});

test('every request carries an abort signal so a hung backend cannot leak it', async () => {
  const calls = fakeFetch({ '/health': { body: { status: 'ok', authRequired: false } } });
  await checkHealth(CFG);
  assert.ok(calls[0].signal, 'no AbortSignal was attached');
});

/* ------------------------------------------------------- pixel fallback */

/**
 * The backend fetches thumbnails itself, without the browser's session. When
 * Google refuses that, the extension resends the bytes instead. Getting this
 * wrong is invisible: it looks like "the backend just doesn't find faces".
 */
test('photos the backend could not fetch are resent as bytes', async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    const first = bodies.length === 1;
    return {
      ok: true, status: 200,
      json: async () => first
        ? { analysed: [{ photoId: 'a' }], failed: [{ photoId: 'b', error: 'host not allowed' }], skipped: [] }
        : { analysed: [{ photoId: 'b' }], failed: [], skipped: [] }
    };
  };
  const totals = await analyse(CFG, [
    { photoId: 'a', url: 'https://x/a' }, { photoId: 'b', url: 'https://x/b' }
  ], { fetchData: async () => 'data:image/jpeg;base64,AAAA' });

  assert.equal(totals.analysed, 2);
  assert.equal(totals.failed, 0);
  assert.equal(totals.retried, 1);
  assert.deepEqual(bodies[1].items, [{ photoId: 'b', data: 'data:image/jpeg;base64,AAAA' }]);
});

test('the retry forces re-analysis so the failure record is replaced', async () => {
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    bodies.push(JSON.parse(init.body));
    return {
      ok: true, status: 200,
      json: async () => bodies.length === 1
        ? { analysed: [], failed: [{ photoId: 'b' }], skipped: [] }
        : { analysed: [{ photoId: 'b' }], failed: [], skipped: [] }
    };
  };
  await analyse(CFG, [{ photoId: 'b', url: 'https://x/b' }], { fetchData: async () => 'data:x' });
  assert.equal(bodies[1].force, true);
});

test('no retry happens when nothing failed', async () => {
  const calls = fakeFetch({ '/analyse': okBatch });
  await analyse(CFG, [{ photoId: 'a', url: 'u' }], { fetchData: async () => 'data:x' });
  assert.equal(calls.length, 1);
});

test('a photo that cannot be read in the page either is left failed', async () => {
  fakeFetch({
    '/analyse': { body: { analysed: [], failed: [{ photoId: 'b' }], skipped: [] } }
  });
  const totals = await analyse(CFG, [{ photoId: 'b', url: 'https://x/b' }], {
    fetchData: async () => { throw new Error('blocked'); }
  });
  assert.equal(totals.failed, 1);
  assert.equal(totals.retried, 0);
});

test('without a fetchData callback the old behaviour is unchanged', async () => {
  const calls = fakeFetch({
    '/analyse': { body: { analysed: [], failed: [{ photoId: 'b' }], skipped: [] } }
  });
  const totals = await analyse(CFG, [{ photoId: 'b', url: 'u' }]);
  assert.equal(calls.length, 1);
  assert.equal(totals.failed, 1);
});
