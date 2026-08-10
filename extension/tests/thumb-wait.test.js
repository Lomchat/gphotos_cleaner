/**
 * Waiting for images before harvesting.
 *
 * Tiles render before their images. Harvest in between and the item is recorded
 * with no thumbnail, which can never be analysed — and repairing one means
 * walking the whole grid again. On a real run this went wrong at scale: 1,836
 * of 2,000 items harvested with no image.
 *
 * The cause was the early exit meant for the tail — the last image or two that
 * never come. It fired after three quiet polls, roughly a third of a second,
 * which is shorter than Google takes to deliver the *first* image deep in a
 * large library. So it triggered before anything had arrived, and the five
 * second budget was never spent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { Scanner } from '../src/content/scanner.js';

/**
 * Drive waitForThumbs against a scripted coverage sequence.
 * @param {number[]} ratios one reading per poll
 */
async function run(ratios, options = {}) {
  const seen = [];
  let i = 0;
  const coverage = () => {
    const ratio = ratios[Math.min(i++, ratios.length - 1)];
    seen.push(ratio);
    return { total: 100, ready: Math.round(ratio * 100), ratio };
  };
  const s = new Scanner({ thumbPollMs: 1, thumbStallMs: 12, coverage, ...options });
  const started = Date.now();
  await s.waitForThumbs();
  return { polls: seen.length, lastRatio: seen.at(-1), elapsed: Date.now() - started, stats: s.stats };
}

test('it stops as soon as the target is reached', async () => {
  const r = await run([0.2, 0.6, 0.95]);
  assert.equal(r.polls, 3);
});

test('an empty grid is not waited for', async () => {
  const started = Date.now();
  const s = new Scanner({
    thumbPollMs: 1, thumbWaitMaxMs: 4000,
    coverage: () => ({ total: 0, ready: 0, ratio: 1 })
  });
  await s.waitForThumbs();
  assert.ok(Date.now() - started < 200, 'nothing rendered means nothing to wait for');
});

// These assert on elapsed time, not on a poll count: under load a Node timer
// set to 1 ms can take fifteen, and counting polls would make the test flaky
// while measuring nothing anyone cares about. The property is "it spends its
// budget rather than bailing out early".
const BUDGET = 120;
const SPENT_MOST_OF_IT = BUDGET * 0.7;

test('it keeps waiting while nothing has arrived yet', async () => {
  // The regression. A grid stuck at zero means the page has not started, which
  // is the opposite of "no more are coming" — so this must not give up early.
  const r = await run(new Array(500).fill(0), { thumbWaitMaxMs: BUDGET });
  assert.ok(r.elapsed >= SPENT_MOST_OF_IT,
    `gave up after ${r.elapsed}ms of a ${BUDGET}ms budget with nothing loaded`);
});

test('it keeps waiting when only a few images are in', async () => {
  const r = await run(new Array(500).fill(0.2), { thumbWaitMaxMs: BUDGET });
  assert.ok(r.elapsed >= SPENT_MOST_OF_IT,
    `gave up after ${r.elapsed}ms of a ${BUDGET}ms budget at 20% coverage`);
});

test('it gives up on the tail once most images are in', async () => {
  // The case the early exit is actually for: 80% arrived, the rest never will.
  const r = await run(new Array(2000).fill(0.8), { thumbStallMs: 30, thumbWaitMaxMs: 4000 });
  assert.ok(r.elapsed < 1500, `waited ${r.elapsed}ms for a tail that was not coming`);
});

test('quiet time is measured in milliseconds, not in polls', async () => {
  // Counting polls made the behaviour depend on the polling rate: a faster poll
  // meant a shorter wait, which is backwards.
  // The property is that the wall-clock wait is the same either way. Poll counts
  // are not asserted: under load they depend on how the machine feels, and the
  // first draft of this test was flaky for exactly that reason.
  const STALL = 300;
  const eager = await run(new Array(5000).fill(0.8), { thumbPollMs: 1, thumbStallMs: STALL, thumbWaitMaxMs: 4000 });
  const lazy = await run(new Array(5000).fill(0.8), { thumbPollMs: 40, thumbStallMs: STALL, thumbWaitMaxMs: 4000 });
  for (const [name, r] of [['1ms polling', eager], ['40ms polling', lazy]]) {
    assert.ok(r.elapsed >= STALL * 0.7 && r.elapsed < STALL * 3,
      `${name} waited ${r.elapsed}ms, expected about ${STALL}ms`);
  }
});

test('the overall budget is still honoured', async () => {
  const r = await run(new Array(5000).fill(0.1), { thumbPollMs: 1, thumbWaitMaxMs: 80 });
  assert.ok(r.elapsed < 600, `the budget must bound the wait, took ${r.elapsed}ms`);
});

test('progress resets the quiet timer', async () => {
  // Images trickling in one at a time is still progress, and must not be cut
  // short by the stall rule.
  // The quiet window has to be comfortably longer than a poll here: a Node
  // timer set to 1 ms routinely takes ten, which would look like a stall.
  const trickle = [0.6, 0.6, 0.62, 0.62, 0.64, 0.64, 0.66, 0.95];
  const r = await run(trickle, { thumbStallMs: 400, thumbPollMs: 1, thumbWaitMaxMs: 4000 });
  assert.equal(r.lastRatio, 0.95, 'it should have stayed until the target');
});

test('the time spent is reported', async () => {
  const r = await run([0.2, 0.95]);
  assert.ok(r.stats.thumbWaitMs >= 0);
  assert.equal(r.stats.thumbRatio, 0.95);
});
