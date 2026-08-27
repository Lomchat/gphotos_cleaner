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
  normalise, distance, toVector, DEFAULT_EPS, MERGE_RATIO
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

test('the default threshold stays inside the measured window', () => {
  // Read off labelled photographs: same person at worst 0.48, closest
  // strangers 0.63. Anything outside that either scatters one person across
  // many groups or starts merging two — and a merge is the failure that offers
  // up someone else's photos.
  assert.ok(DEFAULT_EPS > 0.48, 'below this one person splits apart');
  assert.ok(DEFAULT_EPS < 0.63, 'above this two people start merging');
});

test('the threshold is only a default, never baked into the algorithm', () => {
  // clusterFaces must keep answering for the threshold it is given, or the
  // slider would stop meaning anything.
  const faces = people([12, 12], { dim: 64, seed: 5 });
  const tight = clusterFaces(faces, { eps: 0.45 }).groups.length;
  const loose = clusterFaces(faces, { eps: 0.7 }).groups.length;
  assert.ok(tight >= loose, `tight ${tight} vs loose ${loose}`);
});

/**
 * People strung out along a walk, each one near the last.
 *
 * Random clusters in many dimensions sit almost equidistant, so they cannot
 * chain however loose the merge is — which is why a first attempt at this test
 * passed against the very defaults that had collapsed a real library. Faces
 * are not random: a library is full of near-misses, and transitive merging
 * walks along them.
 *
 * A straight line does not work either. Normalising `axis + along * step * p`
 * converges towards `along`, so the far end of the "line" is a single point
 * and the fixture measures nothing. A random walk on the sphere keeps
 * neighbours close and lets the ends genuinely separate.
 *
 * Honest about its reach: this fixture separates a merge bar of 1.2 from 0.8,
 * but not 1.0 from 0.8. The evidence for that narrower choice is the real
 * library measured in `cluster.js`, and no synthetic stand-in here reproduces
 * it. What this guards is the direction — loosening the bar chains people
 * together, and it fails when someone tries.
 */
function chainOfPeople(count, perPerson, options) {
  const { dim = 128, stride = 1.6, jitter = 0.04, seed = 3 } = options || {};
  const next = rng(seed);
  let current = normalise(Float32Array.from({ length: dim }, () => gaussian(next)));
  const centres = [current];
  for (let p = 1; p < count; p++) {
    const step = Float32Array.from({ length: dim }, () => gaussian(next));
    const moved = new Float32Array(dim);
    for (let i = 0; i < dim; i++) moved[i] = current[i] + step[i] * stride / Math.sqrt(dim);
    current = normalise(moved);
    centres.push(current);
  }

  const faces = [];
  let n = 0;
  centres.forEach((unit, person) => {
    for (let k = 0; k < perPerson; k++) {
      const v = new Float32Array(dim);
      for (let i = 0; i < dim; i++) v[i] = unit[i] + gaussian(next) * jitter;
      faces.push({ id: `c${n}`, photoId: `q${n}`, person, vector: normalise(v) });
      n++;
    }
  });
  return faces;
}

test('a chain of people does not collapse into one group', () => {
  // The failure that shipped. Merging is transitive: A joins B, then AB joins
  // C, and the chain forms wherever a library offers near-misses to walk
  // along. The guard this replaces used two people, which cannot chain, and so
  // it blessed defaults that put 96% of a real library in a single group.
  const faces = chainOfPeople(14, 10);
  const { groups } = clusterFaces(faces);
  const biggest = Math.max(0, ...groups.map((g) => g.size));
  assert.ok(biggest <= faces.length * 0.3,
    `one group holds ${Math.round(biggest / faces.length * 100)}% of every face`);
});

test('no group reaches from one end of the chain to the other', () => {
  // Whatever else merging does, the people furthest apart are not the same
  // person, and no amount of walking between them makes them so.
  const faces = chainOfPeople(14, 10);
  const byId = new Map(faces.map((f) => [f.id, f.person]));
  for (const g of clusterFaces(faces).groups) {
    const who = g.members.map((m) => byId.get(m));
    const span = Math.max(...who) - Math.min(...who);
    assert.ok(span <= 3, `a group reached across ${span} steps of the chain`);
  }
});

test('a group holds one identity, at the shipped defaults', () => {
  // The measurement that matters on a real library: how often two faces that
  // are known to be different people land together.
  const faces = people(Array.from({ length: 16 }, () => 12), { dim: 96, seed: 11 });
  for (const set of identities(clusterFaces(faces).groups, faces)) {
    assert.equal(set.size, 1, 'a group mixed two people at the defaults');
  }
});

test('the merge pass is stricter than the assignment', () => {
  // This test used to assert the opposite, on the argument that a person
  // splits for systematic reasons which averaging cannot remove, so centroids
  // should meet the same bar. The argument is sound and the conclusion was
  // wrong: merging is transitive, so the same bar lets A reach C through B,
  // and on a real library that chained 96% of every face into one group.
  //
  // A centroid is an average, and averages sit closer together than the things
  // they average — so the bar between them has to be tighter to mean the same
  // thing.
  assert.ok(MERGE_RATIO < 1, 'the same bar chains separate people together');
  assert.ok(MERGE_RATIO >= 0.6, 'below this a person really is left split in half');
});

test('the default merge never places fewer faces than a stricter one', () => {
  // Measured across seeds the gain is modest — 11.2 faces placed at 0.8 against
  // 12.5 at 1.0 — so this asserts the direction, not a figure. The large lever
  // on splitting is eps, which is why eps is the one with a slider.
  for (const seed of [44, 7, 21, 3]) {
    const faces = people([24, 20], { jitter: 0.30, seed });
    const placed = (mergeRatio) =>
      clusterFaces(faces, { mergeRatio }).groups.reduce((n, g) => n + g.size, 0);
    assert.ok(placed(MERGE_RATIO) >= placed(0.8), `seed ${seed} placed fewer faces`);
  }
});

test('a much looser merge is what starts mixing identities', () => {
  // The cliff sits just past the default: 1 run in 6 mixed at 1.0, 4 in 6 at
  // 1.1. This documents why the constant is not simply raised further.
  const mixedAt = (mergeRatio) => {
    let mixed = 0;
    for (const seed of [44, 7, 21, 3, 58, 90]) {
      const faces = people([24, 20], { jitter: 0.30, seed });
      const byId = new Map(faces.map((f) => [f.id, f.person]));
      const { groups } = clusterFaces(faces, { mergeRatio });
      if (groups.some((g) => new Set(g.members.map((m) => byId.get(m))).size > 1)) mixed++;
    }
    return mixed;
  };
  assert.ok(mixedAt(1.3) > mixedAt(MERGE_RATIO), 'the cliff past the default must be real');
});

test('ordinary variation still groups cleanly at the default', () => {
  const faces = people([24, 20], { jitter: 0.08, seed: 44 });
  const byId = new Map(faces.map((f) => [f.id, f.person]));
  for (const g of clusterFaces(faces).groups) {
    assert.equal(new Set(g.members.map((m) => byId.get(m))).size, 1,
      'a group mixed two identities at the defaults');
  }
});

/* ------------------------------------------------ crossing a JSON boundary */

/**
 * Face vectors travel from the offscreen document to the panel over
 * chrome.runtime messaging, which serialises to JSON rather than
 * structure-cloning. A Float32Array arrives there as {"0": .., "1": ..} with no
 * length at all — every distance then computes as 1, further apart than the
 * grouping threshold, so every face becomes a singleton and is dropped. The
 * symptom is zero people from a library full of them, and nothing logged.
 */
const asJson = (v) => JSON.parse(JSON.stringify(v));

test('a vector that crossed JSON is rebuilt, not silently mangled', () => {
  const real = new Float32Array([0.6, 0.8, 0]);
  const rebuilt = toVector(asJson(real));
  assert.equal(rebuilt.length, 3);
  assert.ok(Math.abs(rebuilt[0] - 0.6) < 1e-6);
});

test('plain arrays and typed arrays are both accepted', () => {
  assert.equal(toVector([1, 2, 3]).length, 3);
  assert.equal(toVector(new Float32Array(4)).length, 4);
});

test('a vector that crossed JSON groups exactly like the original', () => {
  const faces = people([5, 5], { seed: 31 });
  const direct = clusterFaces(faces).groups.map((g) => g.size).sort();
  const viaMessage = clusterFaces(
    faces.map((f) => ({ ...f, vector: asJson(f.vector) }))
  ).groups.map((g) => g.size).sort();
  assert.deepEqual(viaMessage, direct);
});

test('identical faces are zero apart however they were serialised', () => {
  // The precise reading that made every face a stranger: distance(x, x) === 1.
  const v = toVector(asJson(new Float32Array([0.6, 0.8, 0])));
  assert.ok(distance(v, v) < 1e-6);
});

test('an unusable vector fails loudly instead of yielding no groups', () => {
  // Zero groups from thousands of faces is indistinguishable from a library
  // with nobody in it. It has to be an error, not a result.
  assert.throws(() => toVector('nonsense'), /unusable face vector/);
  assert.throws(() => toVector(null), /unusable face vector/);
  assert.throws(() => distance(new Float32Array(0), new Float32Array(0)), /zero-length/);
});

test('grouping refuses vectors with no length rather than returning nothing', () => {
  const faces = [{ id: 'a', photoId: 'p', vector: {} }];
  assert.throws(() => clusterFaces(faces), /unusable face vector|no length/);
});
