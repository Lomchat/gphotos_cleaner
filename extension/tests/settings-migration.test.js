/**
 * Carrying settings over from an earlier version.
 *
 * Not cosmetic: losing a deliberately set limit starts an hours-long run nobody
 * asked for, and carrying over a key whose meaning was inverted would process
 * exactly the opposite of the intended scope.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { migrateSettings } from '../src/ui/panel.js';

test('the two old limits become a single limit', () => {
  const out = migrateSettings({ scanMaxPerPass: 2000, analyzeMaxPerPass: 5000 });
  assert.equal(out.maxPerRun, 2000, 'the stricter one wins');
  assert.equal('scanMaxPerPass' in out, false);
  assert.equal('analyzeMaxPerPass' in out, false);
});

test('a single old limit is enough', () => {
  assert.equal(migrateSettings({ scanMaxPerPass: 750 }).maxPerRun, 750);
  assert.equal(migrateSettings({ analyzeMaxPerPass: 300 }).maxPerRun, 300);
});

test('"no limit" does not become a limit', () => {
  // 0 already meant "unlimited"; turning it into a limit of 0 would block
  // every run.
  const out = migrateSettings({ scanMaxPerPass: 0, analyzeMaxPerPass: 0 });
  assert.equal(out.maxPerRun, undefined);
});

test('an already-migrated limit is not overwritten', () => {
  const out = migrateSettings({ maxPerRun: 100, scanMaxPerPass: 9000 });
  assert.equal(out.maxPerRun, 100);
});

test('nonsense values are ignored', () => {
  for (const bad of [null, undefined, NaN, Infinity, -5, 'beaucoup']) {
    const out = migrateSettings({ scanMaxPerPass: bad, analyzeMaxPerPass: bad });
    assert.equal(out.maxPerRun, undefined, String(bad));
  }
});

test('the old time window is dropped, not reinterpreted', () => {
  // `scanSinceTs` meant "keep only recent". The current setting says the
  // opposite, so carrying it over would process exactly the photos we wanted
  // to protect.
  const out = migrateSettings({ scanSinceTs: Date.UTC(2024, 0, 1) });
  assert.equal('scanSinceTs' in out, false);
  assert.equal(out.scanOlderThanTs, undefined, 'no bound is inferred');
});

test('unrelated settings pass through untouched', () => {
  const input = { thumbSize: 224, dryRun: false, analyzeInflight: 5, resumeScan: false };
  assert.deepEqual(migrateSettings(input), input);
});

test('migration does not mutate the input object', () => {
  const input = { scanMaxPerPass: 1000 };
  migrateSettings(input);
  assert.deepEqual(input, { scanMaxPerPass: 1000 }, 'the stored record stays readable');
});

/* ------------------------------------------------- correcting a bad threshold */

/**
 * A default only reaches people who have never saved a setting.
 *
 * Everyone else keeps the old number for ever — which is exactly the case
 * where it does the most harm, because they are the people who have been using
 * the thing. An earlier build shipped a grouping threshold of 0.75; measured
 * afterwards on a real library it put 96% of every face into a single group,
 * so people could not be told apart at all. That is not a taste in how strict
 * grouping should be, it is an unusable value, and it has to be corrected for
 * the people already carrying it.
 */
test('a stored threshold above the measured floor is corrected', () => {
  const out = migrateSettings({ peopleEps: 0.75 });
  assert.ok(out.peopleEps <= 0.63, `left at ${out.peopleEps}`);
  assert.equal(out.epsRetunedFrom, 0.75, 'and what it was is remembered, to be shown');
});

test('a usable threshold is left exactly as it was', () => {
  const out = migrateSettings({ peopleEps: 0.5 });
  assert.equal(out.peopleEps, 0.5);
  assert.equal(out.epsRetunedFrom, undefined, 'nothing to explain');
});

test('the correction happens once, never again', () => {
  // Otherwise a deliberate choice made afterwards would be undone on every
  // reload, which is worse than the bug: a setting that will not stay put.
  const chosen = migrateSettings({ peopleEps: 0.7, epsRetunedFrom: 0.75 });
  assert.equal(chosen.peopleEps, 0.7, 'a later deliberate value is the users to keep');
});

test('a fresh install is not told about a correction that never happened', () => {
  assert.equal(migrateSettings({}).epsRetunedFrom, undefined);
});

test('the change is shown, with the way back', () => {
  // Moving somebody's slider in silence is how a tool stops being trusted,
  // even when the move is right.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const start = source.indexOf('  buildEpsControl() {');
  const body = source.slice(start, source.indexOf('  countsLabel()', start));
  assert.match(body, /epsRetunedFrom/);
  assert.match(body, /Put it back at/, 'and it can be put back');
  assert.match(body, /96% of every face/, 'with the measurement that justified it');
});
