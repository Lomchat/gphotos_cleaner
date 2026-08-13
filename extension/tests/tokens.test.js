/**
 * The session credentials, and the world boundary they cross.
 *
 * They live in `window.WIZ_global_data`, which a content script in an isolated
 * world cannot see at all — the object is simply not there. So a second script
 * runs in the page's own world and posts the values across. Two files, and the
 * key list is the one thing they both have to know, because a MAIN-world
 * content script cannot import.
 *
 * That duplication is the risk these tests exist for: a key renamed in one file
 * and not the other produces a request that Google answers with 400, and
 * nothing in the extension says why.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { readTokens, TOKEN_KEYS, REQUIRED, TOKENS_EVENT } from '../src/api/tokens.js';

const MAIN_WORLD = readFileSync(new URL('../src/page/main-world.js', import.meta.url), 'utf8');

const wiz = (over = {}) => ({
  SNlM0e: 'AT', FdrFJe: 'SID', cfb2h: 'BL', eptZe: '/u/1/', ...over
});

/* ------------------------------------------------------------------ reading */

test('a complete WIZ object yields everything the API needs', () => {
  const { tokens, ok, missing } = readTokens(wiz());
  assert.equal(ok, true);
  assert.deepEqual(missing, []);
  assert.equal(tokens.at, 'AT');
  assert.equal(tokens.sid, 'SID');
  assert.equal(tokens.bl, 'BL');
  assert.equal(tokens.path, '/u/1/');
});

test('what is missing is named, not merely counted', () => {
  // A silent failure here becomes a 400 on every call with no clue why.
  const { ok, missing } = readTokens({ SNlM0e: 'AT' });
  assert.equal(ok, false);
  assert.deepEqual(missing.sort(), ['bl', 'sid']);
});

test('the default account gets a usable path', () => {
  assert.equal(readTokens({ ...wiz(), eptZe: undefined }).tokens.path, '/');
  assert.equal(readTokens({ ...wiz(), eptZe: '/u/2' }).tokens.path, '/u/2/',
    'the path is a prefix, so it has to end in a slash');
});

test('the locked-folder token is carried when the page has one', () => {
  assert.equal(readTokens(wiz()).tokens.rapt, undefined);
  assert.equal(readTokens(wiz({ Dbw5Ud: 'RAPT' })).tokens.rapt, 'RAPT');
});

test('non-string values are ignored rather than sent as objects', () => {
  const { ok } = readTokens(wiz({ SNlM0e: { nested: true } }));
  assert.equal(ok, false, 'a token that is not a string is not a token');
});

test('nothing at all is handled without throwing', () => {
  for (const bad of [null, undefined, 'string', 42]) {
    const r = readTokens(bad);
    assert.equal(r.ok, false);
    assert.equal(r.tokens.path, '/');
  }
});

test('the three required tokens are exactly what a call cannot go without', () => {
  assert.deepEqual(REQUIRED, ['at', 'sid', 'bl']);
});

/* ----------------------------------------------------- the two key lists agree */

test('the MAIN-world script copies exactly the keys the mapping knows', () => {
  const m = /const KEYS = \[([^\]]*)\]/.exec(MAIN_WORLD);
  assert.ok(m, 'main-world.js must declare its key list as a plain array');
  const declared = m[1].match(/'([^']+)'/g).map((s) => s.slice(1, -1));
  assert.deepEqual(
    declared.sort(),
    Object.keys(TOKEN_KEYS).sort(),
    'the two lists have drifted: one side reads a key the other never sends'
  );
});

test('the MAIN-world script interprets nothing', () => {
  // It shares a global scope with Google's own application. Every line there is
  // a name that could collide, so it copies values and stops.
  assert.equal(/readTokens|import /.test(MAIN_WORLD), false,
    'no imports and no mapping: a MAIN-world content script cannot import anyway');
  assert.match(MAIN_WORLD, /window\.postMessage\(/);
});

test('the message name is shared, not spelled out twice', () => {
  assert.ok(MAIN_WORLD.includes(`'${TOKENS_EVENT}'`),
    'main-world.js must post under the name the listener expects');
});

test('the values are posted to our own origin, never to a wildcard', () => {
  // "*" would broadcast the session token to any frame listening.
  assert.match(MAIN_WORLD, /window\.postMessage\(\s*\{[^)]*\},\s*window\.location\.origin\s*\)/s);
  assert.equal(/postMessage\([^)]*,\s*['"]\*['"]\s*\)/.test(MAIN_WORLD), false);
});

test('the page is asked again if the values are not there yet', () => {
  // WIZ_global_data is inlined in the document, but the script may still run
  // first. Giving up once would cost the whole session.
  assert.match(MAIN_WORLD, /setInterval/);
  assert.match(MAIN_WORLD, /:request/, 'and the isolated side can ask for a fresh copy');
});
