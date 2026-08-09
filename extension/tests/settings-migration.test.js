/**
 * Carrying settings over from an earlier version.
 *
 * Not cosmetic: losing a deliberately set limit starts an hours-long run nobody
 * asked for, and carrying over a key whose meaning was inverted would process
 * exactly the opposite of the intended scope.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

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
