/**
 * The orders offered above the preview.
 *
 * An order is a claim about confidence: "surest that nobody is in it, first"
 * tells the user the top of the grid is safe to skim and tick. Anything the
 * order cannot actually judge — a video, an unanalysed photo, one the People
 * pass never read — must therefore sink, never float. Getting that backwards
 * puts unknowns exactly where someone stops reading.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SORTS, SORT_KEYS, DEFAULT_SORT, sortItems, groupSizeMap,
  peopleLikelihood, peopleAttachment, DEFAULT_FILTERS
} from '../src/common/filters.js';

function item(id, overrides = {}) {
  const { features, ...rest } = overrides;
  return {
    id,
    ts: 1000,
    isVideo: 0,
    matched: [],
    features: features === null ? null : { faceScore: 0.5, blurScore: 0, darkScore: 0, ...features },
    ...rest
  };
}

const order = (items, key, ctx) => sortItems(items.slice(), key, ctx).map((i) => i.id);

/* -------------------------------------------------------------- registry */

test('the default order is one that exists', () => {
  assert.ok(SORTS[DEFAULT_SORT]);
  assert.equal(DEFAULT_FILTERS.sort, DEFAULT_SORT);
});

test('every order is labelled and explained', () => {
  for (const key of SORT_KEYS) {
    assert.ok(SORTS[key].label?.length > 2, `${key} has no label`);
    assert.ok(SORTS[key].hint?.length > 15, `${key} has no explanation`);
    assert.equal(typeof SORTS[key].key, 'function');
    assert.ok([1, -1].includes(SORTS[key].dir), `${key} has no direction`);
  }
});

test('labels are distinct', () => {
  const labels = SORT_KEYS.map((k) => SORTS[k].label);
  assert.equal(new Set(labels).size, labels.length);
});

test('an unknown order falls back to the default rather than throwing', () => {
  const items = [item('a', { matched: ['x'] }), item('b')];
  assert.deepEqual(order(items, 'nonsense'), order(items, DEFAULT_SORT));
});

/* ------------------------------------------------------------- suspicion */

test('the most-tripped photo comes first', () => {
  assert.deepEqual(order([
    item('one', { matched: ['a'] }),
    item('three', { matched: ['a', 'b', 'c'] }),
    item('two', { matched: ['a', 'b'] })
  ], 'suspicion'), ['three', 'two', 'one']);
});

/* -------------------------------------------------------------- noPeople */

test('the surest empty photo comes first', () => {
  assert.deepEqual(order([
    item('crowd', { features: { faceScore: 0.98 } }),
    item('empty', { features: { faceScore: 0.01 } }),
    item('maybe', { features: { faceScore: 0.5 } })
  ], 'noPeople'), ['empty', 'maybe', 'crowd']);
});

test('a video never floats to the top of "surely nobody"', () => {
  // Its thumbnail is one arbitrary frame, so the score means nothing — and the
  // top of this order is exactly where someone skims and ticks.
  const out = order([
    item('video', { isVideo: 1, features: { faceScore: 0 } }),
    item('empty', { features: { faceScore: 0.02 } })
  ], 'noPeople');
  assert.equal(out[0], 'empty');
  assert.equal(out.at(-1), 'video');
});

test('an unanalysed photo sinks rather than claiming to be empty', () => {
  const out = order([
    item('unknown', { features: null }),
    item('empty', { features: { faceScore: 0.02 } })
  ], 'noPeople');
  assert.deepEqual(out, ['empty', 'unknown']);
});

test('peopleLikelihood refuses to answer for videos and unanalysed items', () => {
  assert.equal(peopleLikelihood(item('v', { isVideo: 1 })), null);
  assert.equal(peopleLikelihood(item('u', { features: null })), null);
  assert.equal(peopleLikelihood(item('p', { features: { faceScore: 0.7 } })), 0.7);
});

/* ------------------------------------------------------------ rarePeople */

const GROUPS = [{ id: 0, size: 500 }, { id: 1, size: 12 }, { id: 2, size: 2 }];
const ctx = { groupSizes: groupSizeMap(GROUPS) };

test('a photo of someone who barely appears ranks above a photo of a regular', () => {
  assert.deepEqual(order([
    item('partner', { people: [0] }),
    item('stranger', { people: [2] }),
    item('friend', { people: [1] })
  ], 'rarePeople', ctx), ['stranger', 'friend', 'partner']);
});

test('a face seen only once puts its photo at the very top', () => {
  // Seen once it never forms a group, so the photo carries an empty list — and
  // that is exactly the thing likeliest to be deletable.
  assert.deepEqual(order([
    item('regular', { people: [0] }),
    item('one-off', { people: [] })
  ], 'rarePeople', ctx), ['one-off', 'regular']);
});

test('one regular outweighs any number of strangers beside them', () => {
  // The key is the largest group present, not a count or a sum: a photo with
  // your partner in it is worth keeping however many strangers share the frame.
  assert.deepEqual(order([
    item('partner-plus-crowd', { people: [0, 2, 1] }),
    item('two-strangers', { people: [2] })
  ], 'rarePeople', ctx), ['two-strangers', 'partner-plus-crowd']);
});

test('a photo the People pass never read sinks instead of looking deletable', () => {
  const out = order([
    item('unread', {}),
    item('regular', { people: [0] })
  ], 'rarePeople', ctx);
  assert.deepEqual(out, ['regular', 'unread']);
});

test('a group id with no known size counts as nobody', () => {
  assert.equal(peopleAttachment(item('x', { people: [99] }), ctx.groupSizes), 0);
});

test('without any group data the order changes nothing it cannot judge', () => {
  const items = [item('a', { people: [0] }), item('b', { people: [1] })];
  assert.equal(order(items, 'rarePeople').length, 2);
});

/* ------------------------------------------------------- quality and date */

test('the blurriest comes first', () => {
  assert.deepEqual(order([
    item('sharp', { features: { blurScore: 0.1 } }),
    item('soft', { features: { blurScore: 0.9 } })
  ], 'blurry'), ['soft', 'sharp']);
});

test('the darkest comes first', () => {
  assert.deepEqual(order([
    item('bright', { features: { darkScore: 0.1 } }),
    item('night', { features: { darkScore: 0.8 } })
  ], 'dark'), ['night', 'bright']);
});

test('quality orders do not judge videos', () => {
  const out = order([
    item('video', { isVideo: 1, features: { blurScore: 1 } }),
    item('photo', { features: { blurScore: 0.5 } })
  ], 'blurry');
  assert.equal(out[0], 'photo');
});

test('oldest and newest are exact opposites', () => {
  const items = [item('a', { ts: 300 }), item('b', { ts: 100 }), item('c', { ts: 200 })];
  assert.deepEqual(order(items, 'oldest'), ['b', 'c', 'a']);
  assert.deepEqual(order(items, 'newest'), ['a', 'c', 'b']);
});

test('a photo with no date sinks in both directions', () => {
  const items = [item('dated', { ts: 100 }), item('undated', { ts: null })];
  assert.equal(order(items, 'oldest').at(-1), 'undated');
  assert.equal(order(items, 'newest').at(-1), 'undated');
});

/* ------------------------------------------------------------- stability */

test('the same input always produces the same order', () => {
  // A grid that reshuffles between renders, under a cursor about to tick
  // something, is its own hazard.
  const items = [item('a'), item('b'), item('c'), item('d')];
  const first = order(items, 'noPeople');
  for (let i = 0; i < 5; i++) assert.deepEqual(order(items.slice().reverse(), 'noPeople'), first);
});

test('ties are broken by date then id, never arbitrarily', () => {
  const items = [
    item('b', { ts: 100 }), item('a', { ts: 100 }), item('c', { ts: 200 })
  ];
  assert.deepEqual(order(items, 'suspicion'), ['c', 'a', 'b']);
});

test('sorting an empty list is not an error', () => {
  assert.deepEqual(sortItems([], 'noPeople'), []);
});

test('every order puts its unjudgeable items last', () => {
  // The invariant that makes an order safe to trust at a glance.
  for (const key of SORT_KEYS) {
    const items = [
      item('unknown', { features: null, ts: null, people: undefined }),
      item('known', { features: { faceScore: 0.3, blurScore: 0.3, darkScore: 0.3 }, ts: 500, people: [0], matched: ['x'] })
    ];
    const out = sortItems(items, key, ctx).map((i) => i.id);
    assert.equal(out.at(-1), 'unknown', `${key} floated an unjudgeable item`);
  }
});
