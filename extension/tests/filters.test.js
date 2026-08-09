import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_FILTERS, clusterDuplicates, pickKeepers, evaluate,
  applyFilters, computeStats, countPerCriterion, CRITERION_TESTS
} from '../src/common/filters.js';

/** Build a catalogue item with sane defaults. */
function item(id, overrides = {}) {
  const { features = {}, ...rest } = overrides;
  return {
    id,
    ts: new Date(2023, 0, 1).getTime(),
    isVideo: 0,
    duration: null,
    analyzed: 1,
    features: {
      dhash: '0000000000000000',
      ahash: '0000000000000000',
      faceScore: 0,
      screenshotScore: 0,
      documentScore: 0,
      blurScore: 0,
      darkScore: 0,
      brightScore: 0,
      lapVar: 100,
      natW: 1000,
      natH: 1000,
      ...features
    },
    ...rest
  };
}

function filters(overrides = {}) {
  return {
    ...structuredClone(DEFAULT_FILTERS),
    ...overrides,
    enabled: { ...DEFAULT_FILTERS.enabled, ...(overrides.enabled || {}) }
  };
}

/* ------------------------------------------------------------- duplicates */

test('groups identical fingerprints', () => {
  const items = [
    item('a', { features: { dhash: 'ffffffffffffffff', ahash: 'ffffffffffffffff' } }),
    item('b', { features: { dhash: 'ffffffffffffffff', ahash: 'ffffffffffffffff' } }),
    item('c', { features: { dhash: '0000000000000000', ahash: '0000000000000000' } })
  ];
  const groups = clusterDuplicates(items, { distance: 8, window: 80 });
  assert.equal(groups.size, 1, 'a single duplicate group');
  const members = [...groups.values()][0].sort();
  assert.deepEqual(members, ['a', 'b']);
});

test('does not pair fingerprints that are too far apart', () => {
  const items = [
    item('a', { features: { dhash: 'ffffffffffffffff', ahash: 'ffffffffffffffff' } }),
    item('b', { features: { dhash: '0000000000000000', ahash: '0000000000000000' } })
  ];
  assert.equal(clusterDuplicates(items, { distance: 8, window: 80 }).size, 0);
});

test('requires confirmation from the second fingerprint', () => {
  // Identical dHash but distant aHash: the resemblance is an artefact,
  // typically two flat surfaces at different brightnesses.
  const items = [
    item('a', { features: { dhash: '0000000000000000', ahash: '0000000000000000' } }),
    item('b', { features: { dhash: '0000000000000000', ahash: 'ffffffffffffffff' } })
  ];
  assert.equal(clusterDuplicates(items, { distance: 8, window: 80 }).size, 0);
});

test('the time window bounds the comparisons', () => {
  const same = { dhash: 'ffffffffffffffff', ahash: 'ffffffffffffffff' };
  const items = [];
  for (let i = 0; i < 30; i++) {
    // Identical items, separated in time.
    items.push(item(`x${i}`, { ts: new Date(2023, 0, 1 + i).getTime(), features: { ...same } }));
  }
  const wide = clusterDuplicates(items, { distance: 8, window: 80 });
  assert.equal([...wide.values()][0].length, 30, 'wide window links everything');

  const narrow = clusterDuplicates(items, { distance: 8, window: 1 });
  // With a window of 1 each item only sees its immediate neighbour, so
  // union-find still links them in a chain.
  assert.equal([...narrow.values()][0].length, 30);
});

test('transitivity links a gradual burst', () => {
  // a~b and b~c, but a and c are far apart: they must still land in the same
  // group, like successive frames of a burst.
  const items = [
    item('a', { ts: 1, features: { dhash: '0000000000000000', ahash: '0000000000000000' } }),
    item('b', { ts: 2, features: { dhash: '000000000000003f', ahash: '000000000000003f' } }),
    item('c', { ts: 3, features: { dhash: '0000000000000fff', ahash: '0000000000000fff' } })
  ];
  const groups = clusterDuplicates(items, { distance: 8, window: 80 });
  assert.equal(groups.size, 1);
  assert.equal([...groups.values()][0].length, 3);
});

test('ignores items with no fingerprint', () => {
  const items = [item('a', { features: { dhash: null } }), item('b'), item('c')];
  const groups = clusterDuplicates(items, { distance: 8, window: 80 });
  const all = [...groups.values()].flat();
  assert.ok(!all.includes('a'));
});

/* ----------------------------------------------------------------- keepers */

test('pickKeepers keeps the sharpest by default', () => {
  const items = [
    item('flou', { features: { lapVar: 10 } }),
    item('net', { features: { lapVar: 900 } })
  ];
  const byId = new Map(items.map((i) => [i.id, i]));
  const groups = new Map([['g', ['flou', 'net']]]);
  assert.deepEqual([...pickKeepers(groups, byId, 'sharpest')], ['net']);
});

test('pickKeepers honours the chronological strategies', () => {
  const items = [
    item('vieux', { ts: 1000 }),
    item('recent', { ts: 9000 })
  ];
  const byId = new Map(items.map((i) => [i.id, i]));
  const groups = new Map([['g', ['vieux', 'recent']]]);
  assert.deepEqual([...pickKeepers(groups, byId, 'first')], ['vieux']);
  assert.deepEqual([...pickKeepers(groups, byId, 'last')], ['recent']);
  assert.equal(pickKeepers(groups, byId, 'none').size, 0);
});

/* ---------------------------------------------------------------- filters */

test('evaluate only activates ticked criteria', () => {
  const it = item('a', { features: { blurScore: 0.9, darkScore: 0.9 } });
  const r = evaluate(it, filters({ enabled: { blurry: true } }), new Set());
  assert.deepEqual(r.active, ['blurry']);
  assert.deepEqual(r.matched, ['blurry']);
});

test('"all criteria" mode requires the intersection', () => {
  const f = filters({ enabled: { blurry: true, dark: true }, mode: 'all' });
  const blurOnly = item('a', { features: { blurScore: 0.9, darkScore: 0.1 } });
  const both = item('b', { features: { blurScore: 0.9, darkScore: 0.9 } });
  assert.equal(evaluate(blurOnly, f, new Set()).all, false);
  assert.equal(evaluate(both, f, new Set()).all, true);
});

test('blur and darkness do not apply to videos', () => {
  // A video thumbnail does not represent its content: judging it blurry would
  // lead to deleting perfectly sharp videos.
  const video = item('v', { isVideo: 1, features: { blurScore: 1, faceScore: 0 } });
  const f = filters({ enabled: { blurry: true, noFace: true } });
  const r = evaluate(video, f, new Set());
  assert.deepEqual(r.matched, [], 'neither blur nor "no people" may touch a video');
});

test('applyFilters returns nothing when no criterion is active', () => {
  const r = applyFilters([item('a'), item('b')], filters());
  assert.equal(r.items.length, 0);
  assert.equal(r.activeCount, 0);
});

test('applyFilters ranks the most suspicious items first', () => {
  const items = [
    item('one', { features: { blurScore: 0.9 } }),
    item('three', { features: { blurScore: 0.9, darkScore: 0.9, screenshotScore: 0.9 } }),
    item('two', { features: { blurScore: 0.9, darkScore: 0.9 } })
  ];
  const f = filters({ enabled: { blurry: true, dark: true, screenshot: true }, mode: 'any' });
  const r = applyFilters(items, f);
  assert.deepEqual(r.items.map((i) => i.id), ['three', 'two', 'one']);
  assert.deepEqual(r.items[0].matched.sort(), ['blurry', 'dark', 'screenshot']);
});

test('the duplicates filter spares the kept copy', () => {
  const dup = { dhash: 'ffffffffffffffff', ahash: 'ffffffffffffffff' };
  const items = [
    item('sharp', { ts: 1, features: { ...dup, lapVar: 900 } }),
    item('blur1', { ts: 2, features: { ...dup, lapVar: 10 } }),
    item('blur2', { ts: 3, features: { ...dup, lapVar: 20 } })
  ];
  const r = applyFilters(items, filters({ enabled: { duplicates: true }, dupKeep: 'sharpest' }));
  const ids = r.items.map((i) => i.id).sort();
  assert.deepEqual(ids, ['blur1', 'blur2']);
  assert.ok(r.keepers.has('sharp'), 'the sharpest is protected');
});

test('the date filter bounds on both sides', () => {
  const items = [
    item('before', { ts: new Date(2020, 0, 1).getTime() }),
    item('inside', { ts: new Date(2022, 5, 1).getTime() }),
    item('after', { ts: new Date(2024, 0, 1).getTime() }),
    item('nodate', { ts: null })
  ];
  const r = applyFilters(items, filters({
    enabled: { dateRange: true },
    from: new Date(2021, 0, 1).getTime(),
    to: new Date(2023, 0, 1).getTime()
  }));
  assert.deepEqual(r.items.map((i) => i.id), ['inside']);
});

test('the long-video filter honours the duration threshold', () => {
  const items = [
    item('short', { isVideo: 1, duration: 20 }),
    item('long', { isVideo: 1, duration: 300 }),
    item('photo', { isVideo: 0, duration: null })
  ];
  const r = applyFilters(items, filters({ enabled: { longVideo: true }, longVideoSec: 120 }));
  assert.deepEqual(r.items.map((i) => i.id), ['long']);
});

test('an unanalysed item triggers no visual criterion', () => {
  const raw = { id: 'x', ts: Date.now(), isVideo: 0, analyzed: 0, features: null };
  const f = filters({ enabled: { blurry: true, noFace: true, screenshot: true } });
  assert.deepEqual(evaluate(raw, f, new Set()).matched, []);
});

/* ------------------------------------------------------------- statistics */

test('computeStats aggregates by year, month and day', () => {
  const items = [
    item('a', { ts: new Date(2022, 0, 5, 10).getTime() }),
    item('b', { ts: new Date(2022, 0, 5, 14).getTime() }),
    item('c', { ts: new Date(2023, 6, 9, 22).getTime() }),
    item('v', { ts: new Date(2023, 6, 9, 22).getTime(), isVideo: 1, duration: 90 })
  ];
  const s = computeStats(items);
  assert.equal(s.total, 4);
  assert.equal(s.videos, 1);
  assert.equal(s.videoSeconds, 90);
  assert.deepEqual(s.byYear, [['2022', 2], ['2023', 2]]);
  assert.deepEqual(s.byMonth, [['2022-01', 2], ['2023-07', 2]]);
  assert.equal(s.byDay.find(([k]) => k === '2022-01-05')[1], 2);
  assert.equal(s.byHour[10], 1);
  assert.equal(s.byHour[22], 2);
});

test('computeStats isolates undated items', () => {
  const s = computeStats([item('a', { ts: null }), item('b')]);
  assert.equal(s.noDate, 1);
  assert.equal(s.byYear.reduce((n, [, v]) => n + v, 0), 1, 'only the dated item is aggregated');
});

test('computeStats counts detected traits', () => {
  const s = computeStats([
    item('a', { features: { blurScore: 0.9 } }),
    item('b', { features: { screenshotScore: 0.8 } }),
    item('c', { features: { faceScore: 0.9 } })
  ]);
  assert.equal(s.traits.blurry, 1);
  assert.equal(s.traits.screenshot, 1);
  assert.equal(s.traits.hasFace, 1);
  assert.equal(s.traits.noFace, 2, 'a and b have no detected people');
});

/* ------------------------------------------------- detector vs heuristic */

test('the skin-area guard applies to the heuristic only', () => {
  // Large skin area, no detected face. Under the heuristic that means "cannot
  // tell, protect it"; under a trained detector it means "genuinely nobody" —
  // a beach or a wooden table, which the user is entitled to clean up.
  const base = { faceScore: 0.1, skinFrac: 0.4 };
  const f = filters({ enabled: { noFace: true } });

  const heuristic = item('h', { features: { ...base, faceMethod: 'heuristic' } });
  const model = item('m', { features: { ...base, faceMethod: 'ultraface' } });

  assert.equal(evaluate(heuristic, f, new Set()).matched.length, 0, 'heuristic stays cautious');
  assert.deepEqual(evaluate(model, f, new Set()).matched, ['noFace'], 'the model is trusted');
});

test('a detected face is never classed as "no people", whatever the skin area', () => {
  const f = filters({ enabled: { noFace: true } });
  for (const faceMethod of ['heuristic', 'ultraface', 'FaceDetector']) {
    const it = item('x', { features: { faceScore: 0.92, skinFrac: 0.01, faceMethod } });
    assert.deepEqual(evaluate(it, f, new Set()).matched, [], faceMethod);
  }
});

test('a missing faceMethod is treated as the heuristic', () => {
  // Entries analysed before the model existed carry no method. Trusting them
  // like a detector would suddenly offer photos the old catalogue protected.
  const it = item('old', { features: { faceScore: 0.1, skinFrac: 0.4 } });
  const f = filters({ enabled: { noFace: true } });
  assert.equal(evaluate(it, f, new Set()).matched.length, 0);
});

/* --------------------------------------------------------------- people */

/**
 * The people criteria depend on the optional backend, so an item may have no
 * `people` field at all. "Not analysed" must never be read as "nobody in it":
 * the whole point of the "without" filter is that a user acts on it.
 */
function withPeople(id, people, extra = {}) {
  const it = item(id, extra);
  if (people !== undefined) it.people = people;
  return it;
}

function peopleFilters(enabled, personIds) {
  return {
    ...DEFAULT_FILTERS,
    enabled: { ...DEFAULT_FILTERS.enabled, ...enabled },
    personIds
  };
}

test('"with" matches a photo containing a selected person', () => {
  const f = peopleFilters({ withPerson: true }, [1]);
  assert.equal(CRITERION_TESTS.withPerson(withPeople('a', [1, 2]), f), true);
});

test('"with" ignores a photo containing only other people', () => {
  const f = peopleFilters({ withPerson: true }, [1]);
  assert.equal(CRITERION_TESTS.withPerson(withPeople('a', [2, 3]), f), false);
});

test('"with" matches on any one of several selected people', () => {
  const f = peopleFilters({ withPerson: true }, [1, 4]);
  assert.equal(CRITERION_TESTS.withPerson(withPeople('a', [4]), f), true);
});

test('"without" matches a photo of other people only', () => {
  const f = peopleFilters({ withoutPerson: true }, [1]);
  assert.equal(CRITERION_TESTS.withoutPerson(withPeople('a', [2]), f), true);
});

test('"without" matches a photo the backend found nobody in', () => {
  const f = peopleFilters({ withoutPerson: true }, [1]);
  assert.equal(CRITERION_TESTS.withoutPerson(withPeople('a', []), f), true);
});

test('"without" never matches a photo the backend has not seen', () => {
  // The dangerous case: an unanalysed photo offered up for deletion under a
  // filter the user reads as "definitely not them".
  const f = peopleFilters({ withoutPerson: true }, [1]);
  assert.equal(CRITERION_TESTS.withoutPerson(withPeople('a', undefined), f), false);
});

test('"with" never matches an unanalysed photo either', () => {
  const f = peopleFilters({ withPerson: true }, [1]);
  assert.equal(CRITERION_TESTS.withPerson(withPeople('a', undefined), f), false);
});

test('neither criterion matches while nobody is selected', () => {
  // Otherwise ticking "without" alone would offer the entire library.
  const f = peopleFilters({ withPerson: true, withoutPerson: true }, []);
  const item = withPeople('a', [1]);
  assert.equal(CRITERION_TESTS.withPerson(item, f), false);
  assert.equal(CRITERION_TESTS.withoutPerson(item, f), false);
});

test('the two people criteria are exclusive on an analysed photo', () => {
  const f = peopleFilters({}, [1]);
  for (const people of [[1], [2], []]) {
    const item = withPeople('a', people);
    assert.notEqual(
      CRITERION_TESTS.withPerson(item, f),
      CRITERION_TESTS.withoutPerson(item, f),
      `people=${JSON.stringify(people)} matched both or neither`
    );
  }
});

test('a corrupted people field is treated as unanalysed', () => {
  const f = peopleFilters({ withoutPerson: true }, [1]);
  for (const bad of [null, 'nobody', 3, {}]) {
    assert.equal(CRITERION_TESTS.withoutPerson(withPeople('a', bad), f), false);
  }
});

test('people criteria drive applyFilters like any other', () => {
  const f = peopleFilters({ withoutPerson: true }, [1]);
  const items = [
    withPeople('keep', [1]),
    withPeople('offer', [2]),
    withPeople('unknown', undefined)
  ];
  const out = applyFilters(items, f).items.map((i) => i.id);
  assert.deepEqual(out, ['offer']);
});

test('the people criteria are counted per criterion like the others', () => {
  const f = peopleFilters({ withPerson: true }, [1]);
  const counts = countPerCriterion(
    [withPeople('a', [1]), withPeople('b', [2]), withPeople('c', undefined)], f
  );
  assert.equal(counts.withPerson, 1);
});

test('personIds defaults to empty so the filters are inert out of the box', () => {
  assert.deepEqual(DEFAULT_FILTERS.personIds, []);
  assert.equal(DEFAULT_FILTERS.enabled.withPerson, false);
  assert.equal(DEFAULT_FILTERS.enabled.withoutPerson, false);
});
