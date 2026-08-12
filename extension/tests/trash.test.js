/**
 * Deciding what a deletion will actually do.
 *
 * This is the one part of the extension that changes something at Google, so
 * the rules have to be boring and checkable. Two of them carry the weight:
 * nothing without a dedup key can be sent (the call would take nothing, or
 * something else), and the figure quoted in the confirmation has to be the
 * figure the deletion frees — an overstated one is how somebody agrees to more
 * than they meant.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { planTrash, formatBytes } from '../src/content/trash-client.js';
import { Panel } from '../src/ui/panel.js';

const item = (over = {}) => ({
  id: 'a', dedupKey: 'dedup-a', isOwned: 1, sizeBytes: 1024 * 1024, ...over
});

/* ------------------------------------------------------------------ planning */

test('an ordinary selection is entirely deletable', () => {
  const plan = planTrash([item({ id: 'a' }), item({ id: 'b', dedupKey: 'dedup-b' })]);
  assert.equal(plan.deletable.length, 2);
  assert.equal(plan.noKey.length, 0);
  assert.equal(plan.notOwned.length, 0);
});

test('an item with no dedup key is never sent', () => {
  // It came from the old grid listing, which never saw one. Sending the media
  // key instead would delete nothing — or something else.
  const plan = planTrash([item({ dedupKey: null }), item({ id: 'b', dedupKey: undefined })]);
  assert.equal(plan.deletable.length, 0);
  assert.equal(plan.noKey.length, 2);
});

test('somebody else\'s photo is left alone', () => {
  const plan = planTrash([item({ isOwned: 0 })]);
  assert.equal(plan.deletable.length, 0);
  assert.equal(plan.notOwned.length, 1);
});

test('ownership is only refused when it is actually known', () => {
  // An older catalogue has no ownership field at all. Reading "unknown" as
  // "not yours" would quietly refuse to delete a whole library.
  const plan = planTrash([{ id: 'a', dedupKey: 'd' }]);
  assert.equal(plan.deletable.length, 1);
});

test('the quota figure is preferred over the file size', () => {
  // A storage-saver copy costs less quota than the file weighs, and freeing
  // quota is the point of the exercise.
  const plan = planTrash([item({ sizeBytes: 8 * 1024 * 1024, spaceTaken: 2 * 1024 * 1024 })]);
  assert.equal(plan.bytes, 2 * 1024 * 1024);
});

test('the size quoted counts only the items it was measured on', () => {
  const plan = planTrash([item(), item({ id: 'b', dedupKey: 'd2', sizeBytes: null })]);
  assert.equal(plan.sizedCount, 1, 'so the confirmation can say "measured on 1 of 2"');
  assert.equal(plan.bytes, 1024 * 1024);
});

test('an unmeasured selection reports no storage rather than zero', () => {
  const plan = planTrash([item({ sizeBytes: null }), item({ id: 'b', dedupKey: 'd2', sizeBytes: null })]);
  assert.equal(plan.sizedCount, 0);
  assert.equal(plan.bytes, 0);
});

test('an empty selection plans nothing', () => {
  const plan = planTrash([]);
  assert.deepEqual(plan.deletable, []);
  assert.equal(plan.bytes, 0);
});

/* -------------------------------------------------------------------- bytes */

test('sizes are written the way people read them', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(5 * 1024 * 1024), '5.0 MB');
  assert.equal(formatBytes(3.25 * 1024 * 1024 * 1024), '3.3 GB');
});

test('a large round figure loses the pointless decimal', () => {
  assert.equal(formatBytes(700 * 1024 * 1024), '700 MB');
});

/* ------------------------------------------------- what the panel promises */

const SOURCE = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');

/** The body of one method, from its declaration to the start of the next. */
function methodBody(name) {
  const start = SOURCE.search(new RegExp(`\\n {2}(?:async )?${name}\\(`));
  assert.notEqual(start, -1, `${name} not found`);
  const rest = SOURCE.slice(start + 1);
  const end = rest.search(/\n {2}(?:\/\*\*|(?:async )?[a-zA-Z_$][\w$]*\()/);
  return end === -1 ? rest : rest.slice(0, end);
}

test('deleting always goes through a confirmation', () => {
  // The button must not be wired straight to the deletion. This is the only
  // action in the extension that changes anything at Google.
  const footer = methodBody('renderFooter');
  assert.match(footer, /confirmTrash\(\)/);
  assert.equal(/startTrash\(\)/.test(footer), false,
    'the footer button asks; only the confirmation acts');
});

test('the confirmation says the photos are recoverable, and for how long', () => {
  // That is what makes this acceptable to ship at all. Left unsaid, the user is
  // agreeing to what looks like a permanent deletion.
  const block = methodBody('buildTrashConfirm');
  assert.match(block, /60 days/);
  assert.match(block, /bin/i);
  assert.match(block, /restored|restore/i);
});

test('the confirmation states the count and what it will not touch', () => {
  const block = methodBody('buildTrashConfirm');
  assert.match(block, /plan\.deletable\.length/);
  assert.match(block, /left alone/, 'skipped items are declared, not silently dropped');
});

test('the confirmation never quotes a size it did not measure', () => {
  const block = methodBody('buildTrashConfirm');
  assert.match(block, /plan\.sizedCount/,
    'the storage figure must be gated on how many items it covers');
});

test('a changed selection cancels a pending confirmation', () => {
  // It quotes a count and a size taken from the selection as it was. Anything
  // that recomputes the selection makes it a promise about something else.
  assert.match(methodBody('recompute'), /this\.state\.confirmTrash = null/);
});

test('nothing in the extension deletes permanently', () => {
  const api = readFileSync(new URL('../src/api/photos-api.js', import.meta.url), 'utf8');
  // The permanent-delete rpc id is deliberately absent, as is restore: the bin
  // is Google's to manage.
  assert.equal(/deletePermanently|XwAOJf.*restore/i.test(api), false);
  assert.match(api, /moveToTrash: 'XwAOJf'/);
});

test('a photo is forgotten locally only after Google confirms taking it', () => {
  const source = readFileSync(new URL('../src/content/trash-client.js', import.meta.url), 'utf8');
  const run = source.slice(source.indexOf('async run('));
  const trashed = run.indexOf('moveToTrashAll');
  const deleted = run.indexOf('deleteItems');
  assert.ok(trashed !== -1 && deleted !== -1);
  assert.ok(trashed < deleted,
    'a row removed for an item still in the library would hide it from every later run');
  assert.match(run, /totals\.done/, 'and only for the batches that actually went through');
});

test('the deletion methods the panel wires up all exist', () => {
  for (const name of ['confirmTrash', 'cancelTrash', 'buildTrashConfirm', 'startTrash', 'trashSummary']) {
    assert.equal(typeof Panel.prototype[name], 'function', `${name} is missing`);
  }
});
