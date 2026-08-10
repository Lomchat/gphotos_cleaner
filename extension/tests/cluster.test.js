/**
 * Grouping faces into people.
 *
 * The dangerous failure here is silent: two people fused into one group looks
 * identical to a working feature until someone opens it, and by then the group
 * has been used to pick photos for deletion. Every test below that starts
 * "never" is guarding that case.
 *
 * The implementation trades DBSCAN for an online assignment plus a merge pass,
 * for reasons of scale. These tests hold it to DBSCAN's *answers*, including
 * the property DBSCAN gets for free and this one has to earn: independence
 * from the order faces arrive in.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  clusterFaces, assignToGroups, carryNames, groupLabel, peopleByPhoto,
  normalise, distance, DEFAULT_EPS
} from '../src/analysis/cluster.js';

/* ------------------------------------------------------------- fixtures */

/** Deterministic PRNG: a flaky clustering test is worse than none. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function gaussian(next) {
  const u = Math.max(next(), 1e-9);
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * next());
}

/** Tight blobs around random directions: one blob per person. */
function people(counts, { dim = 64, jitter = 0.05, seed = 1 } = {}) {
  const next = rng(seed);
  const faces = [];
  let n = 0;
  counts.forEach((count, person) => {
    const centre = new Float32Array(dim);
    for (let i = 0; i < dim; i++) centre[i] = gaussian(next);
    const unit = normalise(centre);
    for (let k = 0; k < count; k++) {
      const v = new Float32Array(dim);
      for (let i = 0; i < dim; i++) v[i] = unit[i] + gaussian(next) * jitter;
      faces.push({ id: `f${n}`, photoId: `p${n}`, person, vector: normalise(v) });
      n++;
    }
  });
  return faces;
}

/** Which person each group actually contains, by ground truth. */
function identities(groups, faces) {
  const byId = new Map(faces.map((f) => [f.id, f.person]));
  return groups.map((g) => new Set(g.members.map((m) => byId.get(m))));
}

function shuffle(items, seed) {
  const next = rng(seed);
  const out = items.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/* ------------------------------------------------------------- primitives */

test('normalising makes a vector unit length', () => {
  const out = normalise(Float32Array.from([3, 4]));
  assert.ok(Math.abs(Math.hypot(out[0], out[1]) - 1) < 1e-6);
});

test('scaling a vector does not change its direction', () => {
  const a = normalise(Float32Array.from([1, 2, 3]));
  const b = normalise(Float32Array.from([17, 34, 51]));
  assert.ok(distance(a, b) < 1e-6);
});

test('a zero vector does not produce NaN', () => {
  const out = normalise(new Float32Array(4));
  assert.ok(out.every((v) => Number.isFinite(v)));
});

test('identical directions are zero apart', () => {
  const a = normalise(Float32Array.from([1, 1, 0]));
  assert.ok(distance(a, a) < 1e-6);
});

test('opposite directions are two apart', () => {
  const a = normalise(Float32Array.from([1, 0]));
  const b = normalise(Float32Array.from([-1, 0]));
  assert.ok(Math.abs(distance(a, b) - 2) < 1e-6);
});

test('orthogonal directions are one apart', () => {
  const a = normalise(Float32Array.from([1, 0]));
  const b = normalise(Float32Array.from([0, 1]));
  assert.ok(Math.abs(distance(a, b) - 1) < 1e-6);
});

/* -------------------------------------------------------------- grouping */

test('one group per person', () => {
  const faces = people([6, 5, 4]);
  const { groups } = clusterFaces(faces);
  assert.equal(groups.length, 3);
});

test('never puts two people in one group', () => {
  const faces = people([6, 5, 4]);
  const { groups } = clusterFaces(faces);
  for (const set of identities(groups, faces)) {
    assert.equal(set.size, 1, 'a group mixed two identities');
  }
});

test('never splits one person across two groups', () => {
  const faces = people([8]);
  const { groups } = clusterFaces(faces);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].size, 8);
});

test('the result does not depend on the order faces arrive in', () => {
  // The property DBSCAN gets for free and the merge pass has to earn.
  const faces = people([7, 6, 5], { seed: 4 });
  const reference = clusterFaces(faces).groups.map((g) => g.size).sort();
  for (const seed of [2, 3, 5, 8, 13]) {
    const sizes = clusterFaces(shuffle(faces, seed)).groups.map((g) => g.size).sort();
    assert.deepEqual(sizes, reference, `order ${seed} gave a different grouping`);
  }
});

test('every face of a person lands in the same group whatever the order', () => {
  const faces = people([9, 9], { seed: 6 });
  for (const seed of [1, 7, 11]) {
    const { groups } = clusterFaces(shuffle(faces, seed));
    for (const set of identities(groups, faces)) assert.equal(set.size, 1);
  }
});

test('a lone face is left ungrouped rather than forced into somebody', () => {
  const faces = people([5, 1], { seed: 3 });
  const { groups, ungrouped } = clusterFaces(faces);
  assert.equal(groups.length, 1);
  assert.equal(ungrouped.length, 1);
});

test('unbalanced groups both survive', () => {
  const faces = people([40, 2], { seed: 7 });
  const { groups } = clusterFaces(faces);
  assert.deepEqual(groups.map((g) => g.size).sort((a, b) => a - b), [2, 40]);
});

test('largest group comes first', () => {
  const faces = people([3, 9, 6]);
  const sizes = clusterFaces(faces).groups.map((g) => g.size);
  assert.deepEqual(sizes, [...sizes].sort((a, b) => b - a));
});

test('group ids are positional and contiguous', () => {
  const faces = people([4, 3, 2]);
  assert.deepEqual(clusterFaces(faces).groups.map((g) => g.id), [0, 1, 2]);
});

test('photo ids are deduplicated within a group', () => {
  const faces = people([4]);
  for (const f of faces) f.photoId = 'same-photo';
  assert.deepEqual(clusterFaces(faces).groups[0].photoIds, ['same-photo']);
});

test('an empty library produces no groups and does not throw', () => {
  assert.deepEqual(clusterFaces([]), { groups: [], ungrouped: [] });
});

test('a single face is ungrouped', () => {
  const faces = people([1]);
  const { groups, ungrouped } = clusterFaces(faces);
  assert.equal(groups.length, 0);
  assert.equal(ungrouped.length, 1);
});

test('a large eps is what merges people', () => {
  // Documents the failure the default guards against.
  const faces = people([5, 5]);
  assert.equal(clusterFaces(faces, { eps: 1.5 }).groups.length, 1);
});

test('spread is higher for a group that merged two people', () => {
  const faces = people([5, 5]);
  const tight = clusterFaces(faces).groups;
  const merged = clusterFaces(faces, { eps: 1.5 }).groups;
  assert.ok(merged[0].spread > Math.max(...tight.map((g) => g.spread)),
    'spread must expose a merge, it is the only warning the user gets');
});

test('centroids come back unit length', () => {
  for (const g of clusterFaces(people([5, 4])).groups) {
    let sum = 0;
    for (const v of g.centroid) sum += v * v;
    assert.ok(Math.abs(Math.sqrt(sum) - 1) < 1e-4);
  }
});

test('minSize is respected', () => {
  const faces = people([5, 3]);
  assert.equal(clusterFaces(faces, { minSize: 4 }).groups.length, 1);
});

/* ------------------------------------------------------------------ scale */

test('ten thousand faces group in reasonable time', () => {
  // The reason this module is not DBSCAN: the pairwise matrix for this input
  // would be 400 MB. If this ever regresses to O(n^2) the test will hang long
  // before anyone ships it.
  const counts = Array.from({ length: 120 }, (_, i) => 40 + (i % 60));
  const faces = people(counts, { dim: 128, seed: 21 });
  assert.ok(faces.length >= 8000, `only built ${faces.length} faces`);

  const started = Date.now();
  const { groups } = clusterFaces(faces);
  const elapsed = Date.now() - started;

  assert.equal(groups.length, 120);
  for (const set of identities(groups, faces)) assert.equal(set.size, 1);
  assert.ok(elapsed < 20000, `took ${elapsed}ms for ${faces.length} faces`);
});

/* ------------------------------------------------------------ incremental */

test('a new face joins the person it belongs to', () => {
  const faces = people([5, 5], { seed: 9 });
  const { groups } = clusterFaces(faces);
  const newcomer = { id: 'new', photoId: 'pn', vector: faces[0].vector };
  const assigned = assignToGroups([newcomer], groups);
  const home = groups.find((g) => g.members.includes(faces[0].id));
  assert.equal(assigned.get('new'), home.id);
});

test('a stranger stays ungrouped rather than joining the nearest person', () => {
  const faces = people([5], { seed: 1 });
  const { groups } = clusterFaces(faces);
  const stranger = people([1], { seed: 99 })[0];
  assert.equal(assignToGroups([{ ...stranger, id: 'x' }], groups).has('x'), false);
});

test('with no groups yet nothing is assigned', () => {
  const faces = people([3]);
  assert.equal(assignToGroups(faces, []).size, 0);
});

/* ------------------------------------------------------------------ names */

test('a name follows its person across a rebuild', () => {
  const faces = people([6, 4], { seed: 12 });
  const first = clusterFaces(faces).groups;
  first[0].name = 'Grandma';

  const rebuilt = carryNames(clusterFaces(shuffle(faces, 5)).groups, first);
  const named = rebuilt.filter((g) => g.name === 'Grandma');
  assert.equal(named.length, 1);
  assert.equal(named[0].size, first[0].size);
});

test('a name is never copied onto a different person', () => {
  const faces = people([5], { seed: 2 });
  const others = people([5], { seed: 77 });
  const previous = clusterFaces(faces).groups;
  previous[0].name = 'Dad';

  const rebuilt = carryNames(clusterFaces(others).groups, previous);
  assert.equal(rebuilt.some((g) => g.name === 'Dad'), false);
});

test('one name cannot land on two groups', () => {
  const faces = people([6, 5], { seed: 15 });
  const previous = clusterFaces(faces).groups;
  previous[0].name = 'Sam';
  const rebuilt = carryNames(clusterFaces(faces).groups, previous);
  assert.equal(rebuilt.filter((g) => g.name === 'Sam').length, 1);
});

test('unnamed groups stay unnamed', () => {
  const faces = people([4, 4], { seed: 18 });
  const rebuilt = carryNames(clusterFaces(faces).groups, []);
  assert.ok(rebuilt.every((g) => !g.name));
});

test('a named group reads by its name, an unnamed one by a 1-based label', () => {
  // Ids start at 0; "Person 0" reads as a bug to anyone who sees it.
  assert.equal(groupLabel({ id: 0, name: 'Grandma' }), 'Grandma');
  assert.equal(groupLabel({ id: 0 }), 'Person 1');
  assert.equal(groupLabel({ id: 7 }), 'Person 8');
});

/* --------------------------------------------------------- photo mapping */

test('groups invert into people-per-photo', () => {
  const byPhoto = peopleByPhoto([
    { id: 0, photoIds: ['a', 'b'] },
    { id: 1, photoIds: ['b', 'c'] }
  ]);
  assert.deepEqual(byPhoto.get('a'), [0]);
  assert.deepEqual(byPhoto.get('b'), [0, 1]);
});

test('a photo in no group is absent from the map, not empty in it', () => {
  // The distinction is what stops "not analysed" reading as "nobody in it".
  assert.equal(peopleByPhoto([{ id: 0, photoIds: ['a'] }]).has('z'), false);
});

test('group ids per photo come back sorted', () => {
  const byPhoto = peopleByPhoto([
    { id: 5, photoIds: ['a'] }, { id: 1, photoIds: ['a'] }, { id: 3, photoIds: ['a'] }
  ]);
  assert.deepEqual(byPhoto.get('a'), [1, 3, 5]);
});

test('the default threshold is the one the model was measured against', () => {
  assert.equal(DEFAULT_EPS, 0.55);
});
