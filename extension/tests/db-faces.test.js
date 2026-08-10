/**
 * Face rows: how they are keyed, and how a photo's rows are replaced.
 *
 * The replacement used to walk a cursor inside the same transaction as the
 * inserts. A cursor queues its deletes from its own callbacks, which run after
 * the inserts are already queued, so it walked over the rows just written and
 * deleted them too. Re-saving a photo wiped its faces instead of replacing
 * them — silently, and the grouping that followed then found nothing at all.
 *
 * The fix is a key-range delete: one request, ordered before the inserts, that
 * cannot see them. These tests pin the reasoning that makes the range correct.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { faceKeyBounds, faceRowId } from '../src/content/db.js';

const between = (key, [low, high]) => key >= low && key <= high;

test('a row id joins the photo and the index', () => {
  assert.equal(faceRowId('AF1Qip', 0), 'AF1Qip#0');
  assert.equal(faceRowId('AF1Qip', 12), 'AF1Qip#12');
});

test('the range covers every row of its photo', () => {
  const bounds = faceKeyBounds('AF1Qip');
  for (const i of [0, 1, 9, 10, 63]) {
    assert.ok(between(faceRowId('AF1Qip', i), bounds), `face ${i} escaped the range`);
  }
});

test('the range stops short of a photo whose id merely starts the same', () => {
  // The case a naive prefix match gets wrong: deleting p0 must not touch
  // p0extra, whose rows sit next to it in key order.
  const bounds = faceKeyBounds('p0');
  assert.equal(between(faceRowId('p0extra', 0), bounds), false);
  assert.equal(between(faceRowId('p0', 0), bounds), true);
});

test('the range excludes an unrelated photo entirely', () => {
  const bounds = faceKeyBounds('AAA');
  assert.equal(between(faceRowId('BBB', 0), bounds), false);
});

test('the upper bound sits above every character a photo id uses', () => {
  // Google ids are base64url. If any of those sorted above the bound, that
  // photo's later faces would survive a replacement and become ghosts.
  const bounds = faceKeyBounds('id');
  for (const ch of 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_') {
    assert.ok(between(`id#${ch}`, bounds), `${ch} escaped the range`);
  }
});

test('replacing rows is not done by walking a cursor', () => {
  // The exact mistake this file exists to prevent.
  const source = readFileSync(new URL('../src/content/db.js', import.meta.url), 'utf8');
  const start = source.indexOf('export async function saveFaces');
  const body = source.slice(start, source.indexOf('\n}', start));
  assert.equal(/openCursor|openKeyCursor/.test(body), false,
    'a cursor here deletes the rows just inserted; use a key-range delete');
  assert.match(body, /IDBKeyRange\.bound/);
});
