/**
 * These tests lock the interface's most important invariant: the number shown
 * next to a checkbox must be exactly the number of items ticking it would
 * select. A gap here means a selection whose size is not the one announced.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FILTERS, CRITERION_KEYS, applyFilters, countPerCriterion,
  clusterDuplicates, pickKeepers, computeStats
} from '../src/common/filters.js';
import { rng } from './helpers.js';

/** Varied, reproducible synthetic catalogue. */
function catalogue(n = 400, seed = 42) {
  const r = rng(seed);
  const items = [];
  for (let i = 0; i < n; i++) {
    const isVideo = r() < 0.12 ? 1 : 0;
    const analyzed = r() < 0.9 ? 1 : 0;
    // Some fingerprints repeat, to produce real clusters.
    const bucket = Math.floor(r() * 40).toString(16).padStart(2, '0');
    items.push({
      id: `id${i}`,
      ts: r() < 0.05 ? null : new Date(2018 + Math.floor(r() * 6), Math.floor(r() * 12), 1 + Math.floor(r() * 28), Math.floor(r() * 24)).getTime(),
      isVideo,
      duration: isVideo ? Math.floor(r() * 600) : null,
      analyzed,
      features: analyzed
        ? {
            dhash: `00000000000000${bucket}`,
            ahash: `00000000000000${bucket}`,
            faceScore: r(),
            screenshotScore: r(),
            documentScore: r(),
            blurScore: r(),
            darkScore: r(),
            brightScore: r(),
            lapVar: r() * 800,
            natW: 1000,
            natH: 1000
          }
        : null
    });
  }
  return items;
}

function filters(overrides = {}) {
  return {
    ...structuredClone(DEFAULT_FILTERS),
    ...overrides,
    enabled: { ...DEFAULT_FILTERS.enabled, ...(overrides.enabled || {}) }
  };
}

function duplicateSelection(items, f) {
  if (!f.enabled.duplicates) return { selectable: new Set(), groups: new Map(), keepers: new Set() };
  const groups = clusterDuplicates(items, { distance: f.dupDistance, window: f.dupWindow });
  const byId = new Map(items.map((i) => [i.id, i]));
  const keepers = pickKeepers(groups, byId, f.dupKeep);
  const selectable = new Set();
  for (const members of groups.values()) {
    for (const id of members) if (!keepers.has(id)) selectable.add(id);
  }
  return { groups, keepers, selectable };
}

test('each criterion badge equals the matching filter result', () => {
  const items = catalogue();
  const base = filters({ enabled: { duplicates: true } });
  const dup = duplicateSelection(items, base);
  const counts = countPerCriterion(items, base, dup.selectable);

  for (const key of CRITERION_KEYS) {
    const solo = filters({ enabled: { [key]: true } });
    const soloDup = key === 'duplicates' ? dup : undefined;
    const r = applyFilters(items, solo, soloDup);
    assert.equal(
      r.items.length,
      counts[key],
      `criterion "${key}": filter returns ${r.items.length}, badge says ${counts[key]}`
    );
  }
});

test('"any" mode equals the union of criteria taken alone', () => {
  const items = catalogue();
  const keys = ['blurry', 'dark', 'screenshot'];
  const union = new Set();
  for (const key of keys) {
    for (const it of applyFilters(items, filters({ enabled: { [key]: true } })).items) {
      union.add(it.id);
    }
  }
  const combined = applyFilters(
    items,
    filters({ enabled: Object.fromEntries(keys.map((k) => [k, true])), mode: 'any' })
  );
  assert.equal(combined.items.length, union.size);
  assert.deepEqual(new Set(combined.items.map((i) => i.id)), union);
});

test('"all" mode equals the intersection and is contained in "any"', () => {
  const items = catalogue();
  const keys = ['blurry', 'dark'];
  const enabled = Object.fromEntries(keys.map((k) => [k, true]));
  const all = applyFilters(items, filters({ enabled, mode: 'all' }));
  const any = applyFilters(items, filters({ enabled, mode: 'any' }));

  const sets = keys.map((k) => new Set(applyFilters(items, filters({ enabled: { [k]: true } })).items.map((i) => i.id)));
  const intersection = [...sets[0]].filter((id) => sets[1].has(id));

  assert.equal(all.items.length, intersection.length);
  assert.ok(all.items.length <= any.items.length);
  const anyIds = new Set(any.items.map((i) => i.id));
  for (const it of all.items) assert.ok(anyIds.has(it.id));
});

test('a kept copy never appears in the duplicate selection', () => {
  const items = catalogue();
  const f = filters({ enabled: { duplicates: true } });
  const dup = duplicateSelection(items, f);
  const r = applyFilters(items, f, dup);
  for (const it of r.items) {
    assert.ok(!dup.keepers.has(it.id), `${it.id} is the kept copy and must not be offered`);
  }
  // Every cluster must keep exactly one copy.
  for (const members of dup.groups.values()) {
    const kept = members.filter((id) => dup.keepers.has(id));
    assert.equal(kept.length, 1, 'a cluster must keep one and only one copy');
  }
});

test('tightening a threshold cannot widen the selection', () => {
  const items = catalogue();
  const lenient = applyFilters(items, filters({ enabled: { blurry: true }, blurMin: 0.3 }));
  const strict = applyFilters(items, filters({ enabled: { blurry: true }, blurMin: 0.8 }));
  assert.ok(strict.items.length <= lenient.items.length);
  const lenientIds = new Set(lenient.items.map((i) => i.id));
  for (const it of strict.items) assert.ok(lenientIds.has(it.id), 'the strict selection is a subset of the lenient one');
});

test('widening duplicate tolerance cannot shrink the clusters', () => {
  const items = catalogue();
  const tight = clusterDuplicates(items, { distance: 2, window: 80 });
  const loose = clusterDuplicates(items, { distance: 12, window: 80 });
  const inTight = new Set([...tight.values()].flat());
  const inLoose = new Set([...loose.values()].flat());
  for (const id of inTight) assert.ok(inLoose.has(id), `${id} disappears as tolerance grows`);
});

test('statistics never count more than the catalogue holds', () => {
  const items = catalogue();
  const s = computeStats(items);
  assert.equal(s.total, items.length);
  const dated = s.byYear.reduce((n, [, v]) => n + v, 0);
  assert.equal(dated + s.noDate, items.length);
  assert.equal(s.byMonth.reduce((n, [, v]) => n + v, 0), dated);
  assert.equal(s.byDay.reduce((n, [, v]) => n + v, 0), dated);
  assert.equal(s.byHour.reduce((a, b) => a + b, 0), dated);
  assert.equal(s.byWeekday.reduce((a, b) => a + b, 0), dated);
  for (const [key, v] of Object.entries(s.traits)) {
    assert.ok(v <= items.length, `trait ${key} out of bounds`);
  }
});

test('the catalogue stays intact after filtering', () => {
  const items = catalogue(120);
  const snapshot = JSON.stringify(items);
  applyFilters(items, filters({ enabled: { blurry: true, duplicates: true, dark: true } }));
  countPerCriterion(items, filters({ enabled: { blurry: true } }));
  computeStats(items);
  assert.equal(JSON.stringify(items), snapshot, 'sorting functions must be pure');
});
