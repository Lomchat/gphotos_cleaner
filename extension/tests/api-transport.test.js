/**
 * The wire format of Google's `batchexecute` endpoint.
 *
 * Nothing about it is documented, so these tests are the specification: they
 * record the exact shape that works, taken from a client known to work against
 * the live service. A change here is either a deliberate port of a change on
 * Google's side, or a bug.
 *
 * The failure modes matter as much as the format. A response that is a login
 * page, a rate-limit, or a renamed field all arrive as "not the JSON I wanted",
 * and the extension's behaviour differs completely between them: sign in again,
 * back off, or stop and say the format changed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ApiError, buildQuery, buildBody, parseEnvelope, call
} from '../src/api/batchexecute.js';

const TOKENS = { at: 'AT-token', sid: 'SID', bl: 'boq_v1', path: '/' };

/** Run `fn` and hand back what it threw. `assert.throws` returns nothing. */
function thrown(fn) {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new assert.AssertionError({ message: 'expected a throw, got a value' });
}

/** A well-formed response carrying `payload` for `rpcid`. */
function envelope(rpcid, payload) {
  return ")]}'\n\n" + JSON.stringify([
    ['wrb.fr', rpcid, JSON.stringify(payload), null, null, null, 'generic'],
    ['di', 42],
    ['af.httprm', 42, '-123', 5]
  ]);
}

/* ------------------------------------------------------------------ query */

test('the query names the call, the session and the release', () => {
  const q = new URLSearchParams(buildQuery('lcxiM', TOKENS));
  assert.equal(q.get('rpcids'), 'lcxiM');
  assert.equal(q.get('f.sid'), 'SID');
  assert.equal(q.get('bl'), 'boq_v1');
  assert.equal(q.get('rt'), 'c', 'compact response, not a stream');
});

test('pageId is the constant "none", never the pagination cursor', () => {
  // The cursor travels in the body. Putting it here does nothing at all, and
  // would hide the fact that the real one was never sent.
  const q = new URLSearchParams(buildQuery('lcxiM', TOKENS));
  assert.equal(q.get('pageId'), 'none');
});

test('rapt is sent only when the session has one', () => {
  assert.equal(new URLSearchParams(buildQuery('lcxiM', TOKENS)).get('rapt'), null);
  const locked = { ...TOKENS, rapt: 'RAPT' };
  assert.equal(new URLSearchParams(buildQuery('lcxiM', locked)).get('rapt'), 'RAPT');
});

test('the source path follows the signed-in account', () => {
  const q = new URLSearchParams(buildQuery('lcxiM', { ...TOKENS, path: '/u/2/' }));
  assert.equal(q.get('source-path'), '/u/2/');
});

/* ------------------------------------------------------------------- body */

test('the body nests the arguments as a JSON string inside JSON', () => {
  const body = buildBody('lcxiM', [null, 123, 500], TOKENS);
  const params = new URLSearchParams(body);
  assert.equal(params.get('at'), 'AT-token');

  const envelopeArg = JSON.parse(params.get('f.req'));
  assert.deepEqual(envelopeArg, [[['lcxiM', '[null,123,500]', null, 'generic']]]);
});

test('the request token is url-encoded, not pasted in raw', () => {
  // Real `at` tokens contain "+", "/" and "=" — pasted in raw, "+" becomes a
  // space on arrival and every call comes back unauthorised.
  const body = buildBody('lcxiM', [], { ...TOKENS, at: 'a+b/c=d&e' });
  assert.equal(body.includes('a+b/c=d&e'), false, 'the raw token must not appear');
  assert.equal(new URLSearchParams(body).get('at'), 'a+b/c=d&e');
});

/* --------------------------------------------------------------- response */

test('the payload is read out of the wrb.fr frame', () => {
  const out = parseEnvelope(envelope('lcxiM', [[['key']], 'next', '1700000000000']), 'lcxiM');
  assert.deepEqual(out, [[['key']], 'next', '1700000000000']);
});

test('the frame is chosen by call id, not by position', () => {
  // Google interleaves frames of its own. Taking the first one would hand back
  // somebody else's answer, parsed as ours.
  const text = ")]}'\n\n" + JSON.stringify([
    ['wrb.fr', 'other', JSON.stringify(['not ours'])],
    ['wrb.fr', 'lcxiM', JSON.stringify(['ours'])]
  ]);
  assert.deepEqual(parseEnvelope(text, 'lcxiM'), ['ours']);
});

test('an empty page is a null payload, not a failure', () => {
  const text = ")]}'\n\n" + JSON.stringify([['wrb.fr', 'lcxiM', null]]);
  assert.equal(parseEnvelope(text, 'lcxiM'), null);
});

test('a login page is reported as an authorisation problem', () => {
  // Signed out, Google answers with HTML. Reported as "shape" it would read as
  // "the format changed", and the user would never think to sign in.
  const err = thrown(() => parseEnvelope('<!DOCTYPE html><html>…', 'lcxiM'));
  assert.ok(err instanceof ApiError);
  assert.equal(err.kind, 'auth');
});

test('a response with no frame at all is a shape problem', () => {
  const err = thrown(() => parseEnvelope(")]}'\n\n[[\"di\",4]]", 'lcxiM'));
  assert.ok(err instanceof ApiError);
  assert.equal(err.kind, 'shape');
});

test('an empty body is not silently treated as an empty page', () => {
  const err = thrown(() => parseEnvelope('', 'lcxiM'));
  assert.ok(err instanceof ApiError);
  assert.equal(err.kind, 'shape');
});

test('a frame whose payload is not JSON is reported, not swallowed', () => {
  const text = ")]}'\n\n" + JSON.stringify([['wrb.fr', 'lcxiM', 'not json at all']]);
  assert.throws(() => parseEnvelope(text, 'lcxiM'), ApiError);
});

/* ------------------------------------------------------------------- call */

test('a call posts a form body to the account path, with credentials', async () => {
  let seen = null;
  await call('lcxiM', [1], { ...TOKENS, path: '/u/1/' }, {
    fetchImpl: async (url, init) => {
      seen = { url, init };
      return { ok: true, status: 200, text: async () => envelope('lcxiM', []) };
    }
  });

  assert.match(seen.url, /^https:\/\/photos\.google\.com\/u\/1\/data\/batchexecute\?/);
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.credentials, 'include', 'the session cookie is the whole point');
  assert.match(seen.init.headers['content-type'], /application\/x-www-form-urlencoded/);
});

test('missing credentials fail before any request is made', async () => {
  let called = false;
  const err = await call('lcxiM', [], { at: 'x' }, {
    fetchImpl: async () => { called = true; }
  }).catch((e) => e);
  assert.ok(err instanceof ApiError);
  assert.equal(err.kind, 'auth');
  assert.equal(called, false, 'no point asking Google without a session');
});

test('401 and 403 are authorisation, other statuses are not', async () => {
  const status = async (code) => call('lcxiM', [], TOKENS, {
    fetchImpl: async () => ({ ok: false, status: code, text: async () => '' })
  }).catch((e) => e);

  assert.equal((await status(401)).kind, 'auth');
  assert.equal((await status(403)).kind, 'auth');
  assert.equal((await status(429)).kind, 'http');
  assert.equal((await status(500)).kind, 'http');
  assert.equal((await status(429)).status, 429, 'the code survives, so backoff can use it');
});

test('a network failure is distinguishable from a bad answer', async () => {
  const err = await call('lcxiM', [], TOKENS, {
    fetchImpl: async () => { throw new Error('offline'); }
  }).catch((e) => e);
  assert.equal(err.kind, 'network');
  assert.match(err.message, /offline/, 'the underlying cause survives');
});

test('an aborted call says so rather than blaming the network', async () => {
  const controller = new AbortController();
  controller.abort();
  const err = await call('lcxiM', [], TOKENS, {
    signal: controller.signal,
    fetchImpl: async () => { throw new Error('aborted'); }
  }).catch((e) => e);
  assert.match(err.message, /cancelled/);
});
