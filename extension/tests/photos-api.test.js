/**
 * The four calls this extension makes.
 *
 * What is pinned here is the *argument shape*: undocumented positional arrays
 * where a misplaced null does not fail, it just returns something else. The
 * trash call gets the most attention, because it is the only one that changes
 * anything — and because it takes dedup keys rather than media keys, which is
 * the kind of distinction that silently deletes nothing, or the wrong thing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  RPC, SOURCE, PAGE_SIZE, INFO_CHUNK, TRASH_CHUNK,
  listPage, batchInfo, batchInfoAll, moveToTrash, moveToTrashAll
} from '../src/api/photos-api.js';

const TOKENS = { at: 'AT', sid: 'SID', bl: 'BL', path: '/' };

/** Records every request, and answers each with `payloads.shift()`. */
function recorder(payloads) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const params = new URLSearchParams(init.body);
    const envelope = JSON.parse(params.get('f.req'));
    const [rpcid, argsJson] = envelope[0][0];
    calls.push({ url, rpcid, args: JSON.parse(argsJson) });
    const payload = payloads.length ? payloads.shift() : null;
    return {
      ok: true,
      status: 200,
      text: async () => ")]}'\n\n" + JSON.stringify([['wrb.fr', rpcid, JSON.stringify(payload)]])
    };
  };
  return { calls, fetchImpl };
}

const item = (key, ts) => [key, ['https://lh3.googleusercontent.com/' + key, 100, 100], ts, `dedup-${key}`, 0, ts, null, [[1]], null, null, null, null, null, false, {}];

/* ----------------------------------------------------------------- listing */

test('a first page asks for the top of the library', () => {
  const { calls, fetchImpl } = recorder([[[], null, null]]);
  return listPage(TOKENS, { fetchImpl }).then(() => {
    assert.equal(calls[0].rpcid, RPC.byTakenDate);
    assert.deepEqual(calls[0].args, [null, null, PAGE_SIZE, null, 1, SOURCE.library]);
  });
});

test('the cursor and the date go in the request, in that order', async () => {
  // [pageId, timestamp, pageSize, …]. Swapped, Google answers from the top
  // every time and the run loops over the same five hundred photos.
  const { calls, fetchImpl } = recorder([[[], null, null]]);
  await listPage(TOKENS, { pageId: 'CURSOR', beforeTimestamp: 1700000000000, fetchImpl });
  assert.equal(calls[0].args[0], 'CURSOR');
  assert.equal(calls[0].args[1], 1700000000000);
});

test('a page comes back parsed, with its cursor', async () => {
  const { fetchImpl } = recorder([[[item('a', 2), item('b', 1)], 'NEXT', '1']]);
  const page = await listPage(TOKENS, { fetchImpl });
  assert.deepEqual(page.items.map((i) => i.mediaKey), ['a', 'b']);
  assert.equal(page.nextPageId, 'NEXT');
});

test('a null payload is the end of the library, not a crash', async () => {
  const { fetchImpl } = recorder([null]);
  const page = await listPage(TOKENS, { fetchImpl });
  assert.deepEqual(page.items, []);
  assert.equal(page.nextPageId, null);
});

/* ---------------------------------------------------------------- metadata */

test('the metadata call wraps each key in its own array', async () => {
  const { calls, fetchImpl } = recorder([[[null, []]]]);
  await batchInfo(TOKENS, ['k1', 'k2'], { fetchImpl });
  const [[keys, mask]] = calls[0].args;
  assert.deepEqual(keys, [[['k1'], ['k2']]]);
  assert.equal(mask[0].length, 36, 'the field mask is 36 long');
  assert.deepEqual(mask[0][24], [], 'and asks for exactly two groups');
  assert.deepEqual(mask[0][35], []);
});

test('metadata is fetched in chunks, not one enormous request', async () => {
  const keys = Array.from({ length: INFO_CHUNK * 2 + 5 }, (_, i) => `k${i}`);
  const { calls, fetchImpl } = recorder([]);
  await batchInfoAll(TOKENS, keys, { fetchImpl });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].args[0][0][0].length, INFO_CHUNK);
  assert.equal(calls[2].args[0][0][0].length, 5);
});

test('a failed metadata chunk does not cost the others', async () => {
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 1) return { ok: false, status: 500, text: async () => '' };
    return {
      ok: true, status: 200,
      text: async () => ")]}'\n\n" + JSON.stringify([['wrb.fr', RPC.batchInfo,
        JSON.stringify([[null, [['k', [null, null, null, 'a.jpg', null, null, null, null, null, 7, [1, 7, 2]]]]]])]])
    };
  };
  const keys = Array.from({ length: INFO_CHUNK + 1 }, (_, i) => `k${i}`);
  const out = await batchInfoAll(TOKENS, keys, { fetchImpl });
  assert.equal(out.length, 1, 'the second chunk still arrived');
});

test('an expired session stops the metadata pass instead of hammering', async () => {
  const fetchImpl = async () => ({ ok: false, status: 403, text: async () => '' });
  await assert.rejects(() => batchInfoAll(TOKENS, ['a'], { fetchImpl }));
});

/* ------------------------------------------------------------------ trash */

test('the trash call sends dedup keys, in the documented positions', async () => {
  const { calls, fetchImpl } = recorder([[1]]);
  await moveToTrash(TOKENS, ['dedup-a', 'dedup-b'], { fetchImpl });
  assert.equal(calls[0].rpcid, RPC.moveToTrash);
  assert.deepEqual(calls[0].args, [null, 1, ['dedup-a', 'dedup-b'], 3]);
});

test('trashing nothing makes no request at all', async () => {
  const { calls, fetchImpl } = recorder([]);
  const out = await moveToTrash(TOKENS, [], { fetchImpl });
  assert.equal(calls.length, 0);
  assert.equal(out.requested, 0);
});

test('a large deletion is batched, and reports progress as it goes', async () => {
  const keys = Array.from({ length: TRASH_CHUNK * 2 + 3 }, (_, i) => `d${i}`);
  const { calls, fetchImpl } = recorder([]);
  const seen = [];
  const totals = await moveToTrashAll(TOKENS, keys, {
    fetchImpl,
    onProgress: (p) => seen.push(p.done)
  });
  assert.equal(calls.length, 3);
  assert.equal(totals.done, keys.length);
  assert.deepEqual(seen, [TRASH_CHUNK, TRASH_CHUNK * 2, keys.length]);
});

test('a refused batch is counted as failed, and the rest still go', async () => {
  // The alternative — abandoning everything on the first refusal — would leave
  // the user with no idea which half of their selection was taken.
  let n = 0;
  const fetchImpl = async () => {
    n++;
    if (n === 2) return { ok: false, status: 500, text: async () => '' };
    return {
      ok: true, status: 200,
      text: async () => ")]}'\n\n" + JSON.stringify([['wrb.fr', RPC.moveToTrash, JSON.stringify([1])]])
    };
  };
  const keys = Array.from({ length: TRASH_CHUNK * 3 }, (_, i) => `d${i}`);
  const totals = await moveToTrashAll(TOKENS, keys, { fetchImpl });
  assert.equal(totals.done, TRASH_CHUNK * 2);
  assert.equal(totals.failed, TRASH_CHUNK);
  assert.ok(totals.errors.length, 'and says why');
});

test('an expired session stops a deletion immediately', async () => {
  // Every following batch would fail the same way, and each one is a request
  // Google counts against a user who is about to have to sign in anyway.
  let n = 0;
  const fetchImpl = async () => { n++; return { ok: false, status: 401, text: async () => '' }; };
  const keys = Array.from({ length: TRASH_CHUNK * 4 }, (_, i) => `d${i}`);
  await moveToTrashAll(TOKENS, keys, { fetchImpl });
  assert.equal(n, 1, 'one attempt, then stop');
});

test('an aborted deletion stops between batches', async () => {
  const controller = new AbortController();
  let n = 0;
  const fetchImpl = async () => {
    n++;
    controller.abort();
    return {
      ok: true, status: 200,
      text: async () => ")]}'\n\n" + JSON.stringify([['wrb.fr', RPC.moveToTrash, JSON.stringify([1])]])
    };
  };
  const keys = Array.from({ length: TRASH_CHUNK * 3 }, (_, i) => `d${i}`);
  const totals = await moveToTrashAll(TOKENS, keys, { fetchImpl, signal: controller.signal });
  assert.equal(n, 1);
  assert.equal(totals.done, TRASH_CHUNK, 'what went through is still reported');
});
