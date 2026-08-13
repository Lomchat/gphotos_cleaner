/**
 * Sorting and filtering by what a photo actually costs.
 *
 * This is the criterion the extension could never offer before: the grid does
 * not carry file sizes, so until the API listing there was nothing to filter
 * on. Duration stood in for it on videos, badly.
 *
 * The rule that matters is what happens to an item with no figure. Google's
 * metadata pass may not have covered it, or may have been switched off — and
 * "unknown" must never be presented as "small", because a filter someone reads
 * as "the big ones" would then be answering a different question.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FILTERS, CRITERION_TESTS, CRITERION_LABELS, SORTS,
  applyFilters, countPerCriterion, computeStats, sortItems, itemBytes
} from '../src/common/filters.js';
import { CRITERIA } from '../src/ui/panel.js';

const MB = 1024 * 1024;
const item = (id, over = {}) => ({ id, ts: 1000, isVideo: 0, ...over });

const filters = (over = {}) => ({
  ...structuredClone(DEFAULT_FILTERS),
  ...over,
  enabled: { ...DEFAULT_FILTERS.enabled, ...(over.enabled || {}) }
});

/* ------------------------------------------------------------- which bytes */

test('the quota cost is what counts, not the file on disk', () => {
  // A storage-saver copy weighs more as a file than it costs in quota, and
  // quota is what the user is trying to free.
  assert.equal(itemBytes({ sizeBytes: 8 * MB, spaceTaken: 2 * MB }), 2 * MB);
  assert.equal(itemBytes({ sizeBytes: 8 * MB }), 8 * MB, 'the file size stands in when there is no quota figure');
  assert.equal(itemBytes({}), 0, 'unknown is zero, and zero is never "large"');
});

/* --------------------------------------------------------------- the filter */

test('a photo over the threshold matches, one under it does not', () => {
  const f = filters({ largeFileMb: 20 });
  assert.equal(CRITERION_TESTS.largeFile(item('a', { sizeBytes: 40 * MB }), f), true);
  assert.equal(CRITERION_TESTS.largeFile(item('b', { sizeBytes: 4 * MB }), f), false);
});

test('the threshold is inclusive at its own value', () => {
  const f = filters({ largeFileMb: 20 });
  assert.equal(CRITERION_TESTS.largeFile(item('a', { sizeBytes: 20 * MB }), f), true);
});

test('an unmeasured photo never matches "large files"', () => {
  const f = filters({ largeFileMb: 1 });
  assert.equal(CRITERION_TESTS.largeFile(item('a'), f), false);
  assert.equal(CRITERION_TESTS.largeFile(item('b', { sizeBytes: null }), f), false);
});

test('videos are judged by size like anything else', () => {
  // Duration used to stand in for size because size was unavailable. Now that
  // it is, a long low-bitrate clip is no longer mistaken for a heavy one.
  const f = filters({ largeFileMb: 50 });
  assert.equal(CRITERION_TESTS.largeFile(item('v', { isVideo: 1, duration: 3600, sizeBytes: 5 * MB }), f), false);
  assert.equal(CRITERION_TESTS.largeFile(item('w', { isVideo: 1, duration: 12, sizeBytes: 900 * MB }), f), true);
});

test('the badge count equals what the filter returns', () => {
  const items = [
    item('a', { sizeBytes: 100 * MB }),
    item('b', { spaceTaken: 30 * MB, sizeBytes: 90 * MB }),
    item('c', { sizeBytes: 1 * MB }),
    item('d')
  ];
  const f = filters({ enabled: { largeFile: true }, largeFileMb: 20 });
  assert.equal(applyFilters(items, f).items.length, countPerCriterion(items, f).largeFile);
  assert.equal(applyFilters(items, f).items.length, 2);
});

test('raising the threshold can only shrink the selection', () => {
  const items = Array.from({ length: 20 }, (_, i) => item(`i${i}`, { sizeBytes: i * MB }));
  const lenient = applyFilters(items, filters({ enabled: { largeFile: true }, largeFileMb: 5 })).items;
  const strict = applyFilters(items, filters({ enabled: { largeFile: true }, largeFileMb: 15 })).items;
  const ids = new Set(lenient.map((i) => i.id));
  assert.ok(strict.length <= lenient.length);
  for (const it of strict) assert.ok(ids.has(it.id));
});

/* ---------------------------------------------------------------- the order */

test('the biggest files come first', () => {
  const items = [
    item('small', { sizeBytes: 1 * MB }),
    item('huge', { sizeBytes: 900 * MB }),
    item('medium', { sizeBytes: 40 * MB })
  ];
  assert.deepEqual(sortItems(items, 'biggest').map((i) => i.id), ['huge', 'medium', 'small']);
});

test('unmeasured photos sink, whichever way the order runs', () => {
  // The invariant every order here keeps: an item nothing is known about must
  // never be presented at the top, where someone skims and ticks.
  const items = [item('unknown'), item('known', { sizeBytes: 3 * MB })];
  assert.equal(sortItems(items, 'biggest').at(-1).id, 'unknown');
});

test('the size order declares that it needs the size pass', () => {
  // Without the flag the panel would offer an order over a library where every
  // key is null — a button that does nothing and explains nothing.
  assert.equal(SORTS.biggest.needsSizes, true);
});

/* ----------------------------------------------------------------- the rest */

test('storage totals count only what was measured, and say how much', () => {
  const s = computeStats([
    item('a', { sizeBytes: 10 * MB }),
    item('b', { spaceTaken: 5 * MB, sizeBytes: 20 * MB }),
    item('c')
  ]);
  assert.equal(s.bytes, 15 * MB);
  assert.equal(s.sized, 2, 'so a partial total can be reported as partial');
  assert.equal(s.total, 3);
});

test('the criterion is wired into the interface like every other', () => {
  const crit = CRITERIA.find((c) => c.key === 'largeFile');
  assert.ok(crit, 'the criterion must be reachable from the panel');
  assert.ok(CRITERION_LABELS.largeFile);
  assert.equal(DEFAULT_FILTERS.enabled.largeFile, false, 'off by default, like the rest');
  assert.equal(crit.controls[0].prop, 'largeFileMb');
});
