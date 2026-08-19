/**
 * Sorting logic: filters, near-duplicate grouping, statistics.
 * Pure functions — testable and independent of the DOM.
 */

import { hexToPair, hammingPair } from '../analysis/features.js';
import { dayKey, monthKey, yearKey } from './dates.js';

export const DEFAULT_FILTERS = {
  enabled: {
    noFace: false,
    hasFace: false,
    screenshot: false,
    document: false,
    blurry: false,
    dark: false,
    bright: false,
    duplicates: false,
    longVideo: false,
    largeFile: false,
    dateRange: false,
    withPerson: false,
    withoutPerson: false
  },
  noFaceMax: 0.35,      // presence score at or below this…
  noFaceMaxSkin: 0.05,  // …AND skin area at or below this ⇒ "no people"
  hasFaceMin: 0.55,
  screenshotMin: 0.55,
  documentMin: 0.55,
  blurMin: 0.6,
  darkMin: 0.6,
  brightMin: 0.6,
  dupDistance: 8,       // max Hamming distance between fingerprints
  dupWindow: 80,        // temporal neighbourhood scanned
  dupKeep: 'sharpest',  // 'sharpest' | 'first' | 'last' | 'none'
  longVideoSec: 120,
  largeFileMb: 20,      // known only for items listed through the API
  from: null,
  to: null,
  personIds: [],        // groups selected in the People tab
  sort: 'suspicion',    // see SORTS
  mode: 'any'           // 'any' = union of criteria, 'all' = intersection
};

/* ----------------------------------------------------------- duplicates */

/**
 * Group near-duplicates.
 *
 * Comparing every pair would be O(n²). Bursts and copies are almost always
 * adjacent in time, so we sort by date and only compare within a sliding
 * window, bringing the cost down to O(n·k).
 *
 * @returns {Map<string, string[]>} group id → member ids
 */
export function clusterDuplicates(items, { distance = 8, window = 80 } = {}) {
  const usable = items
    .filter((it) => it.features?.dhash)
    .map((it) => ({
      id: it.id,
      ts: it.ts ?? 0,
      pair: hexToPair(it.features.dhash),
      apair: hexToPair(it.features.ahash),
      sharp: it.features.lapVar ?? 0
    }))
    .filter((it) => it.pair);

  usable.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

  const parent = new Map(usable.map((it) => [it.id, it.id]));
  const find = (x) => {
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) {
      const nxt = parent.get(x);
      parent.set(x, r);
      x = nxt;
    }
    return r;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (let i = 0; i < usable.length; i++) {
    for (let j = i + 1; j < Math.min(usable.length, i + 1 + window); j++) {
      if (hammingPair(usable[i].pair, usable[j].pair) > distance) continue;
      // Confirm with a second fingerprint: dHash alone conflates flat scenes
      // (skies, walls) that have nothing in common.
      if (hammingPair(usable[i].apair, usable[j].apair) > distance + 6) continue;
      union(usable[i].id, usable[j].id);
    }
  }

  const groups = new Map();
  for (const it of usable) {
    const root = find(it.id);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(it.id);
  }
  for (const [k, v] of groups) if (v.length < 2) groups.delete(k);
  return groups;
}

/**
 * Pick the copy to keep in each duplicate group.
 * @returns {Set<string>} ids that must NOT be offered for deletion
 */
export function pickKeepers(groups, byId, strategy = 'sharpest') {
  const keep = new Set();
  if (strategy === 'none') return keep;

  // Best copy = sharpest; ties broken by resolution.
  const score = (r) => {
    const f = r.features || {};
    return (f.lapVar || 0) + (f.natW || 0) * (f.natH || 0) * 1e-5;
  };

  for (const members of groups.values()) {
    const rows = members.map((id) => byId.get(id)).filter(Boolean);
    if (!rows.length) continue;
    let best = rows[0];
    for (const r of rows) {
      if (strategy === 'first') {
        if ((r.ts ?? Infinity) < (best.ts ?? Infinity)) best = r;
      } else if (strategy === 'last') {
        if ((r.ts ?? -Infinity) > (best.ts ?? -Infinity)) best = r;
      } else if (score(r) > score(best)) {
        best = r;
      }
    }
    keep.add(best.id);
  }
  return keep;
}

/* ----------------------------------------------------------------- lenses */

/**
 * Restrict the pool to photos or to videos.
 *
 * Deliberately not a criterion. Criteria are combined — in the default "any"
 * mode they union — so a "videos" checkbox ticked beside "blurry" would give
 * *videos or blurry photos*, which is the opposite of what "only videos"
 * says. A lens narrows what every criterion then sees, so "only" means only.
 *
 * It also keeps the invariant the whole panel rests on: the number beside a
 * criterion equals what ticking it selects. Both read the pool this returns.
 */
export const MEDIA_LENSES = ['all', 'photo', 'video'];

export function applyLens(items, lens) {
  if (lens === 'video') return items.filter((it) => it.isVideo);
  if (lens === 'photo') return items.filter((it) => !it.isVideo);
  return items;
}

/** How many photos and videos a catalogue holds, for the lens buttons. */
export function countMedia(items) {
  let videos = 0;
  for (const it of items) if (it.isVideo) videos++;
  return { all: items.length, video: videos, photo: items.length - videos };
}

/* --------------------------------------------------------------- filters */

/**
 * Face-detection methods whose verdict is taken at face value. Anything else —
 * the skin-tone heuristic, an unknown name, an entry written by an older
 * version — keeps the extra skin-area guard.
 */
export const TRUSTED_FACE_METHODS = new Set(['ultraface', 'FaceDetector']);

/**
 * The single definition of what each criterion means.
 *
 * Filtering, the badge counts and the statistics all read this table. Without
 * it they drift apart, and a user sees "320" next to a filter that returns 280
 * — exactly when trust matters most.
 *
 * On videos: their thumbnail is one arbitrary frame, which may be blurry, dark
 * or empty while the video is not. Visual-quality criteria therefore never
 * apply to them. "Screenshot" is the exception — screen recordings are a real
 * category to clean up, and one frame is enough to spot them.
 */
export const CRITERION_TESTS = {
  noFace: (it, f) => {
    const ft = it.features;
    if (!ft || it.isVideo) return false;
    if (ft.faceScore > f.noFaceMax) return false;
    // The skin-area guard exists only to compensate for the heuristic, which
    // collapses on profiles and partly hidden faces while skin area stays high.
    // A trained detector needs no such crutch, and applying it there would
    // wrongly protect every photo full of skin-coloured scenery.
    //
    // Trusted methods are named explicitly rather than the heuristic excluded:
    // an entry from an older version, or a method name we do not recognise,
    // must fall on the cautious side. Guessing the other way would offer photos
    // that the catalogue previously protected.
    if (TRUSTED_FACE_METHODS.has(ft.faceMethod)) return true;
    return (ft.skinFrac ?? 0) <= f.noFaceMaxSkin;
  },
  hasFace: (it, f) => !!it.features && it.features.faceScore >= f.hasFaceMin,
  screenshot: (it, f) => !!it.features && it.features.screenshotScore >= f.screenshotMin,
  document: (it, f) => !!it.features && it.features.documentScore >= f.documentMin,
  blurry: (it, f) => !!it.features && !it.isVideo && it.features.blurScore >= f.blurMin,
  dark: (it, f) => !!it.features && !it.isVideo && it.features.darkScore >= f.darkMin,
  bright: (it, f) => !!it.features && !it.isVideo && it.features.brightScore >= f.brightMin,
  duplicates: (it, f, dup) => dup.has(it.id),
  longVideo: (it, f) => !!it.isVideo && (it.duration ?? 0) >= f.longVideoSec,

  // Size comes from the API's metadata pass. An item with no figure never
  // matches: "unknown size" must not be presented as "small enough to ignore"
  // — nor, worse, swept up by a filter the user reads as "the big ones".
  largeFile: (it, f) => itemBytes(it) >= f.largeFileMb * 1024 * 1024,

  dateRange: (it, f) =>
    (f.from == null || (it.ts != null && it.ts >= f.from)) &&
    (f.to == null || (it.ts != null && it.ts <= f.to)),

  // People criteria need the People pass. `it.people` is an array only once
  // that pass has read the photo; undefined means "not analysed", which is
  // emphatically not the same as "nobody in it". Treating the two alike would
  // offer up every photo the pass has not reached yet under a filter the user
  // reads as "definitely without them".
  withPerson: (it, f) =>
    Array.isArray(it.people) && f.personIds.length > 0 &&
    it.people.some((g) => f.personIds.includes(g)),
  withoutPerson: (it, f) =>
    Array.isArray(it.people) && f.personIds.length > 0 &&
    !it.people.some((g) => f.personIds.includes(g))
};

/**
 * What an item actually costs, in bytes.
 *
 * `spaceTaken` is what it uses against the storage quota and `size` is the file
 * on disk; they differ for anything Google re-encoded in storage-saver mode.
 * The quota figure comes first because freeing quota is the point of the
 * exercise. Zero means unknown, and unknown is never treated as large.
 */
export function itemBytes(item) {
  return item.spaceTaken || item.sizeBytes || 0;
}

export const CRITERION_KEYS = Object.keys(CRITERION_TESTS);

const NO_DUPES = new Set();

/**
 * Evaluate the active criteria for one item.
 * @returns {{matched:string[], active:string[], all:boolean}}
 */
export function evaluate(item, filters, dupSelectable = NO_DUPES) {
  const matched = [];
  const active = [];
  for (const key of CRITERION_KEYS) {
    if (!filters.enabled[key]) continue;
    active.push(key);
    if (CRITERION_TESTS[key](item, filters, dupSelectable)) matched.push(key);
  }
  return { matched, active, all: active.length > 0 && matched.length === active.length };
}

/**
 * Count how many items each criterion would catch on its own.
 * Feeds the badge next to every checkbox.
 */
export function countPerCriterion(items, filters, dupSelectable = NO_DUPES) {
  const counts = Object.fromEntries(CRITERION_KEYS.map((k) => [k, 0]));
  for (const item of items) {
    for (const key of CRITERION_KEYS) {
      if (CRITERION_TESTS[key](item, filters, dupSelectable)) counts[key]++;
    }
  }
  return counts;
}

/**
 * Apply the whole filter set.
 *
 * @param {{selectable:Set, groups:Map, keepers:Set}} [precomputedDuplicates]
 *        already-computed grouping, to avoid redoing expensive work.
 */
export function applyFilters(items, filters, precomputedDuplicates, context) {
  let { groups, keepers, selectable: dupSelectable } = precomputedDuplicates || {};

  if (!precomputedDuplicates) {
    groups = new Map();
    keepers = new Set();
    dupSelectable = new Set();
    if (filters.enabled.duplicates) {
      const byId = new Map(items.map((it) => [it.id, it]));
      groups = clusterDuplicates(items, {
        distance: filters.dupDistance,
        window: filters.dupWindow
      });
      keepers = pickKeepers(groups, byId, filters.dupKeep);
      for (const members of groups.values()) {
        for (const id of members) if (!keepers.has(id)) dupSelectable.add(id);
      }
    }
  }

  const activeCount = Object.values(filters.enabled).filter(Boolean).length;

  // No criterion ticked: show the whole library rather than an empty page.
  // `browsing` travels with the result because it changes what a selection
  // means. With criteria on, everything shown was chosen by a rule and can be
  // ticked wholesale; here nothing has been judged, so the caller must not tick
  // anything on the user's behalf.
  if (!activeCount) {
    const all = items.map((it) => ({ ...it, matched: [] }));
    sortItems(all, filters.sort, context);
    return { items: all, groups, keepers, activeCount, browsing: true };
  }

  const out = [];
  for (const it of items) {
    const r = evaluate(it, filters, dupSelectable);
    const hit = filters.mode === 'all' ? r.all : r.matched.length > 0;
    if (hit) out.push({ ...it, matched: r.matched });
  }
  sortItems(out, filters.sort, context);
  return { items: out, groups, keepers, activeCount, browsing: false };
}

/* ------------------------------------------------------------------ order */

/**
 * How confident we are that a photo has nobody in it, 0 = certainly someone.
 *
 * Videos and unanalysed items have no answer. They are given `null` and pushed
 * to the end rather than treated as empty: sorting "surest that nobody is in
 * it" must not put an unknown at the top, right where a user skims and ticks.
 */
export function peopleLikelihood(item) {
  if (!item.features || item.isVideo) return null;
  return item.features.faceScore ?? null;
}

/**
 * How attached a photo is to people who matter, 0 = nobody recognised.
 *
 * The key is the *largest* group present, not the number of faces. Someone who
 * shows up five hundred times is the reason to keep a photo, and one such face
 * outweighs any number of strangers beside them. A face seen only once never
 * forms a group at all, so its photo scores 0 and rises — which is the point:
 * it is the likeliest thing in the library to be deletable.
 */
export function peopleAttachment(item, groupSizes) {
  if (!Array.isArray(item.people)) return null;
  let biggest = 0;
  for (const id of item.people) biggest = Math.max(biggest, groupSizes.get(id) ?? 0);
  return biggest;
}

/**
 * The orders offered above the preview.
 *
 * Each is a *reason to look*, not a filter: they reorder what the criteria
 * already selected. `key` returns null for items the order cannot judge, and
 * those always sink to the bottom whichever direction is chosen — an item we
 * know nothing about must never be presented as a confident answer.
 */
export const SORTS = {
  suspicion: {
    label: 'Most suspicious',
    hint: 'The more criteria a photo trips, the likelier it is worth removing.',
    key: (it) => it.matched?.length ?? 0,
    dir: -1
  },
  noPeople: {
    label: 'Surely nobody',
    hint: 'Photos where the detector is most confident there is no one, first.',
    key: peopleLikelihood,
    dir: 1
  },
  rarePeople: {
    label: 'Rarest people',
    hint: 'Photos of people who barely appear elsewhere first; your regulars sink to the bottom.',
    key: (it, ctx) => peopleAttachment(it, ctx.groupSizes),
    dir: 1,
    needsPeople: true
  },
  similar: {
    label: 'Lookalikes',
    hint: 'Bursts and near-identical copies, grouped together so a set of eleven is one decision.',
    // Ranked by how large the set is, so the biggest pile-ups come first. A
    // photo nothing resembles has no answer here and sinks, which is the same
    // rule every other order follows.
    key: (it, ctx) => ctx.similarSize?.get(it.id) ?? null,
    dir: -1,
    needsSimilar: true
  },
  biggest: {
    label: 'Biggest files',
    hint: 'What actually costs you storage, heaviest first.',
    key: (it) => itemBytes(it) || null,
    dir: -1,
    // Nothing has a size until the metadata pass has run, and an order over a
    // library where every key is null is just the tie-break wearing a label.
    needsSizes: true
  },
  blurry: {
    label: 'Blurriest',
    hint: 'Softest images first.',
    key: (it) => (it.isVideo ? null : it.features?.blurScore ?? null),
    dir: -1
  },
  dark: {
    label: 'Darkest',
    hint: 'Darkest images first.',
    key: (it) => (it.isVideo ? null : it.features?.darkScore ?? null),
    dir: -1
  },
  oldest: {
    label: 'Oldest',
    hint: 'By date taken, oldest first.',
    key: (it) => it.ts ?? null,
    dir: 1
  },
  newest: {
    label: 'Newest',
    hint: 'By date taken, newest first.',
    key: (it) => it.ts ?? null,
    dir: -1
  }
};

export const SORT_KEYS = Object.keys(SORTS);
export const DEFAULT_SORT = 'suspicion';

/**
 * Order a list in place.
 *
 * Ties fall back to the date, then the id, so the grid never reshuffles between
 * two renders of the same data — a moving grid under a cursor about to tick
 * something is its own kind of hazard.
 */
export function sortItems(items, sortKey, context = {}) {
  const sort = SORTS[sortKey] || SORTS[DEFAULT_SORT];
  const ctx = { groupSizes: new Map(), ...context };
  const keys = new Map(items.map((it) => [it.id, sort.key(it, ctx)]));

  items.sort((a, b) => {
    const ka = keys.get(a.id);
    const kb = keys.get(b.id);
    if (ka == null && kb == null) return tieBreak(a, b);
    if (ka == null) return 1;
    if (kb == null) return -1;
    if (ka !== kb) return (ka - kb) * sort.dir;
    return tieBreak(a, b);
  });
  return items;
}

function tieBreak(a, b) {
  return (b.ts ?? 0) - (a.ts ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** Group id → number of faces in it, for the "rarest people" order. */
export function groupSizeMap(groups) {
  return new Map((groups || []).map((g) => [g.id, g.size]));
}

/**
 * Splitting the grid into blocks.
 *
 * Three orders answer a question about a *group* of photos rather than about
 * one: rarest people asks about a person, oldest and newest about a day,
 * lookalikes about a set of near-identical shots. A flat grid gives no way to
 * act on the answer — so those orders return blocks, each tickable whole.
 *
 * Every one produces the same shape, `{ key, title, note, items }`, so the
 * panel renders blocks without knowing which order it is showing.
 *
 * One rule holds across all three: **a photo appears in exactly one block**.
 * The grid addresses tiles by their index into one flat list rebuilt from these
 * blocks, so a duplicate would make two tiles claim the same photo — and a
 * "tick everything here" could then reach a photo the user is keeping.
 */

/**
 * One block per person, rarest first.
 *
 * A photo goes under the **rarest** person in it: one holding a stranger and
 * your sister belongs with the stranger, because your sister is the reason to
 * keep it. Photos with nobody recognised come last, in their own block — they
 * are not a person, and mixing them in would make "tick all" mean something
 * different at the bottom of the page than at the top.
 */
export function sectionsByPerson(items, groups = []) {
  const size = new Map(groups.map((g) => [g.id, g.size]));
  const named = new Map(groups.map((g) => [g.id, g.name || null]));

  const byPerson = new Map();
  const nobody = [];

  for (const item of items) {
    const ids = Array.isArray(item.people) ? item.people : [];
    let rarest = null;
    for (const id of ids) {
      if (!size.has(id)) continue;
      if (rarest === null || size.get(id) < size.get(rarest)) rarest = id;
    }
    if (rarest === null) {
      nobody.push(item);
      continue;
    }
    if (!byPerson.has(rarest)) byPerson.set(rarest, []);
    byPerson.get(rarest).push(item);
  }

  const sections = [...byPerson.entries()]
    .map(([id, list]) => ({
      key: `person:${id}`,
      // By how rare the person is, not by how many of their photos survived
      // the filters: someone with four faces in the library is the interesting
      // case even if only one of them is on screen.
      order: size.get(id) ?? 0,
      id,
      title: named.get(id) || `Person ${id + 1}`,
      note: `${size.get(id) ?? 0} face(s) in the library`,
      items: list
    }))
    .sort((a, b) => a.order - b.order || a.id - b.id);

  if (nobody.length) {
    sections.push({ key: 'person:none', id: null, title: 'Nobody recognised', note: '', items: nobody });
  }
  return sections;
}

/**
 * One block per day, in whatever order the list already has.
 *
 * Deliberately not sorted here: the caller has already ordered by oldest or
 * newest, and re-deciding would make the blocks disagree with the button the
 * user pressed. Consecutive runs are split, so a list that is not in date
 * order simply produces more blocks rather than a wrong answer.
 */
export function sectionsByDay(items) {
  const sections = [];
  let current = null;

  for (const item of items) {
    const key = item.ts == null ? 'day:none' : `day:${dayKey(item.ts)}`;
    if (!current || current.key !== key) {
      current = {
        key,
        title: item.ts == null ? 'No date' : dayKey(item.ts),
        ts: item.ts ?? null,
        note: '',
        items: []
      };
      sections.push(current);
    }
    current.items.push(item);
  }
  return sections;
}

/**
 * One block per set of lookalikes, the largest sets first.
 *
 * This is the duplicates grouping shown as itself rather than as a filter: a
 * burst of eleven near-identical shots is one decision, and seeing them side by
 * side is what makes it. Photos with no lookalike go last in a single block —
 * they are the answer "nothing resembles this", which is worth showing rather
 * than hiding.
 */
export function sectionsBySimilarity(items, groups) {
  const groupOf = new Map();
  for (const [root, members] of groups || []) {
    for (const id of members) groupOf.set(id, root);
  }

  const byGroup = new Map();
  const alone = [];
  for (const item of items) {
    const root = groupOf.get(item.id);
    if (root === undefined) {
      alone.push(item);
      continue;
    }
    if (!byGroup.has(root)) byGroup.set(root, []);
    byGroup.get(root).push(item);
  }

  const sections = [...byGroup.entries()]
    .map(([root, list]) => ({
      key: `similar:${root}`,
      root,
      title: `${list.length} lookalikes`,
      note: 'one decision, not several',
      items: list
    }))
    // Biggest sets first: eleven near-identical shots are worth more attention
    // than a pair, and they are also the easiest to act on.
    .sort((a, b) => b.items.length - a.items.length || (a.root < b.root ? -1 : 1));

  if (alone.length) {
    sections.push({
      key: 'similar:none',
      root: null,
      title: 'Nothing resembles these',
      note: '',
      items: alone
    });
  }
  return sections;
}

/**
 * The blocks for an order, or null when it does not have any.
 *
 * One place deciding, so the panel never has to know which orders section
 * themselves — and so adding an order cannot half-wire it.
 */
export function sectionsForSort(items, sortKey, { groups = [], duplicates = null } = {}) {
  if (sortKey === 'rarePeople') {
    return groups.length ? sectionsByPerson(items, groups) : null;
  }
  if (sortKey === 'oldest' || sortKey === 'newest') {
    return sectionsByDay(items);
  }
  if (sortKey === 'similar') {
    return sectionsBySimilarity(items, duplicates);
  }
  return null;
}

/* ------------------------------------------------------------ statistics */

/**
 * Descriptive statistics. Traits are counted at default thresholds, regardless
 * of the user's filter settings: this section describes the library, it does
 * not preview a selection.
 */
export function computeStats(items) {
  const byYear = new Map();
  const byMonth = new Map();
  const byDay = new Map();
  const byWeekday = new Array(7).fill(0);
  const byHour = new Array(24).fill(0);

  let videos = 0;
  let analyzed = 0;
  let noDate = 0;
  let videoSeconds = 0;
  let bytes = 0;
  let sized = 0;
  const traits = {
    noFace: 0, hasFace: 0, screenshot: 0, document: 0, blurry: 0, dark: 0, bright: 0
  };

  for (const it of items) {
    if (it.isVideo) {
      videos++;
      videoSeconds += it.duration || 0;
    }
    if (it.analyzed) analyzed++;
    const b = itemBytes(it);
    if (b) { bytes += b; sized++; }
    if (it.ts == null) {
      noDate++;
    } else {
      inc(byYear, yearKey(it.ts));
      inc(byMonth, monthKey(it.ts));
      inc(byDay, dayKey(it.ts));
      const d = new Date(it.ts);
      byWeekday[d.getDay()]++;
      byHour[d.getHours()]++;
    }
    if (!it.features) continue;
    for (const key of Object.keys(traits)) {
      if (CRITERION_TESTS[key](it, DEFAULT_FILTERS, NO_DUPES)) traits[key]++;
    }
  }

  return {
    total: items.length,
    analyzed,
    videos,
    videoSeconds,
    noDate,
    // Storage is only known for what the size pass has covered, so the count it
    // is based on travels with it — "1.2 GB" over a tenth of the library is a
    // different statement from "1.2 GB" over all of it.
    bytes,
    sized,
    traits,
    byYear: sortedEntries(byYear),
    byMonth: sortedEntries(byMonth),
    byDay: sortedEntries(byDay),
    byWeekday,
    byHour
  };
}

function inc(map, key) {
  map.set(key, (map.get(key) || 0) + 1);
}

function sortedEntries(map) {
  return Array.from(map.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1));
}

export const CRITERION_LABELS = {
  noFace: 'No people',
  hasFace: 'Has people',
  screenshot: 'Screenshot',
  document: 'Document',
  blurry: 'Blurry',
  dark: 'Dark',
  bright: 'Overexposed',
  duplicates: 'Duplicate',
  longVideo: 'Long video',
  largeFile: 'Large file',
  dateRange: 'Date range',
  withPerson: 'With selected people',
  withoutPerson: 'Without selected people'
};
