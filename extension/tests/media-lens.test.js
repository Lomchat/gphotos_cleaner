/**
 * Showing only photos, or only videos.
 *
 * The interesting decision is that this is *not* a criterion. Criteria are
 * combined, and in the default "any" mode they union — so a "videos" checkbox
 * ticked beside "blurry" would give *videos or blurry photos*, which is the
 * opposite of what "only videos" says. Every criterion in the list behaves
 * that way, correctly; this one is a different kind of thing.
 *
 * A lens narrows the pool that the criteria and their counters both read, so
 * "only" means only, and the panel's central invariant — the number beside a
 * criterion equals what ticking it selects — holds without anyone maintaining
 * it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MEDIA_LENSES, applyLens, countMedia,
  DEFAULT_FILTERS, applyFilters, countPerCriterion
} from '../src/common/filters.js';
import { Panel } from '../src/ui/panel.js';

const SOURCE = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');

const photo = (id, over = {}) => ({ id, ts: 1000, isVideo: 0, ...over });
const video = (id, over = {}) => ({ id, ts: 1000, isVideo: 1, duration: 30, ...over });

const mixed = [photo('p1'), video('v1'), photo('p2'), video('v2'), photo('p3')];

/* ------------------------------------------------------------- the lens */

test('the video lens keeps only videos', () => {
  assert.deepEqual(applyLens(mixed, 'video').map((i) => i.id), ['v1', 'v2']);
});

test('the photo lens keeps only photos', () => {
  assert.deepEqual(applyLens(mixed, 'photo').map((i) => i.id), ['p1', 'p2', 'p3']);
});

test('the default lens keeps everything', () => {
  assert.equal(applyLens(mixed, 'all').length, mixed.length);
  assert.equal(applyLens(mixed, undefined).length, mixed.length,
    'and an unknown lens shows everything rather than nothing');
});

test('the lens does not disturb the list it was given', () => {
  // Every other pure function here is non-destructive; one that quietly was
  // not would corrupt the catalogue the panel holds.
  const before = JSON.stringify(mixed);
  applyLens(mixed, 'video');
  assert.equal(JSON.stringify(mixed), before);
});

test('the flag is read the way the catalogue writes it', () => {
  // `toRow` stores 0/1, not booleans, and a strict `=== true` would show an
  // empty grid on a library full of videos.
  assert.equal(applyLens([{ id: 'a', isVideo: 1 }], 'video').length, 1);
  assert.equal(applyLens([{ id: 'a', isVideo: 0 }], 'photo').length, 1);
  assert.equal(applyLens([{ id: 'a' }], 'photo').length, 1, 'missing means photo');
});

test('the counts match what each lens would show', () => {
  // They are on the buttons, so a wrong one is an outright lie about what
  // pressing it does.
  const counts = countMedia(mixed);
  assert.equal(counts.all, applyLens(mixed, 'all').length);
  assert.equal(counts.photo, applyLens(mixed, 'photo').length);
  assert.equal(counts.video, applyLens(mixed, 'video').length);
});

test('an empty catalogue counts zero of everything', () => {
  assert.deepEqual(countMedia([]), { all: 0, video: 0, photo: 0 });
});

/* ------------------------------------------- why it is not a criterion */

test('a lens restricts where a criterion would have unioned', () => {
  // The whole reason for the design. Ticking "blurry" with the video lens on
  // must give blurry videos — not "videos, plus every blurry photo".
  const items = [
    video('v-blurry', { features: { blurScore: 0.9 } }),
    video('v-sharp', { features: { blurScore: 0.1 } }),
    photo('p-blurry', { features: { blurScore: 0.9 } })
  ];
  const filters = {
    ...structuredClone(DEFAULT_FILTERS),
    enabled: { ...DEFAULT_FILTERS.enabled, blurry: true }
  };

  // Blur is a visual-quality criterion, so it never applies to videos — which
  // is why the lens leaves nothing here, and that is the correct answer.
  const throughLens = applyFilters(applyLens(items, 'video'), filters).items;
  assert.deepEqual(throughLens.map((i) => i.id), []);

  // Without the lens the same criteria reach a photo. That difference is the
  // point: the lens decides what is looked at, the criterion what is chosen.
  const unlensed = applyFilters(items, filters).items;
  assert.deepEqual(unlensed.map((i) => i.id), ['p-blurry']);
});

test('the counters see the same pool the filter does', () => {
  // The invariant the panel rests on. Counting the catalogue while filtering
  // a lensed pool would put a number beside a checkbox that ticking it cannot
  // produce.
  const items = [
    video('v1', { isVideo: 1, duration: 300 }),
    video('v2', { isVideo: 1, duration: 300 }),
    photo('p1')
  ];
  const filters = {
    ...structuredClone(DEFAULT_FILTERS),
    enabled: { ...DEFAULT_FILTERS.enabled, longVideo: true }
  };
  const pool = applyLens(items, 'video');
  assert.equal(countPerCriterion(pool, filters).longVideo, applyFilters(pool, filters).items.length);
});

/* ------------------------------------------------------------- the panel */

test('the lens narrows the same pool decisions do', () => {
  const start = SOURCE.indexOf('  recompute() {');
  const body = SOURCE.slice(start, SOURCE.indexOf('  renderAll() {', start));
  assert.match(body, /const pool = applyLens\(guarded, this\.state\.settings\.mediaLens\)/,
    'the lens is the last narrowing, after decisions and protected people');
  assert.match(body, /countPerCriterion\(pool,/);
  assert.match(body, /applyFilters\(pool,/);
});

test('the duplicate grouping is recomputed when the lens moves', () => {
  // Its cache key decides that. Without the lens in it, switching to videos
  // would leave clusters built from photos that are no longer shown.
  const start = SOURCE.indexOf('  duplicateSelection() {');
  const body = SOURCE.slice(start, start + 900);
  assert.match(body, /mediaLens/);
});

test('it starts showing everything', () => {
  // A tool that opens already hiding half the library, with the reason three
  // scrolls up the column, is one people conclude has lost their photos.
  assert.match(SOURCE, /mediaLens: 'all'/);
});

test('the choice is offered before the criteria it governs', () => {
  const start = SOURCE.indexOf("const side = el('aside', { class: 'side' },");
  const block = SOURCE.slice(start, start + 400);
  assert.ok(block.indexOf('buildMediaLens()') < block.indexOf("'Combine'"),
    'it decides what everything below it is looking at');
});

test('each lens says how many it would show', () => {
  const start = SOURCE.indexOf('  buildMediaLens() {');
  const body = SOURCE.slice(start, SOURCE.indexOf('  resetButton(', start));
  assert.match(body, /countMedia\(/);
  assert.match(body, /nf\(counts\[lens\]\)/);
  assert.match(body, /for \(const lens of MEDIA_LENSES\)/,
    'every lens is offered, from the one list that defines them');
});

test('the counts exclude what decisions have already hidden', () => {
  // Otherwise "Videos 223" beside a grid holding forty is a number nobody can
  // account for.
  const start = SOURCE.indexOf('  buildMediaLens() {');
  const body = SOURCE.slice(start, SOURCE.indexOf('  resetButton(', start));
  assert.match(body, /hideKept \? this\.state\.items\.filter\(\(it\) => !it\.kept\)/);
});

test('the method the buttons call exists', () => {
  assert.equal(typeof Panel.prototype.buildMediaLens, 'function');
});

test('the lens list is the one source of what is offered', () => {
  assert.deepEqual(MEDIA_LENSES, ['all', 'photo', 'video']);
});
