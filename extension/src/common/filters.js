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
  from: null,
  to: null,
  personIds: [],        // groups selected in the People tab
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
  dateRange: (it, f) =>
    (f.from == null || (it.ts != null && it.ts >= f.from)) &&
    (f.to == null || (it.ts != null && it.ts <= f.to)),

  // People criteria need the optional backend. `it.people` is an array only
  // once the backend has looked at that photo; undefined means "not analysed",
  // which is emphatically not the same as "nobody in it". Treating the two
  // alike would offer up every photo the backend has not reached yet under a
  // filter the user reads as "definitely without them".
  withPerson: (it, f) =>
    Array.isArray(it.people) && f.personIds.length > 0 &&
    it.people.some((g) => f.personIds.includes(g)),
  withoutPerson: (it, f) =>
    Array.isArray(it.people) && f.personIds.length > 0 &&
    !it.people.some((g) => f.personIds.includes(g))
};

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
export function applyFilters(items, filters, precomputedDuplicates) {
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
  if (!activeCount) return { items: [], groups, keepers, activeCount };

  const out = [];
  for (const it of items) {
    const r = evaluate(it, filters, dupSelectable);
    const hit = filters.mode === 'all' ? r.all : r.matched.length > 0;
    if (hit) out.push({ ...it, matched: r.matched });
  }
  // Most suspicious first: the more criteria an item trips, the likelier it is
  // genuinely worth removing.
  out.sort((a, b) => b.matched.length - a.matched.length || (b.ts ?? 0) - (a.ts ?? 0));
  return { items: out, groups, keepers, activeCount };
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
  const traits = {
    noFace: 0, hasFace: 0, screenshot: 0, document: 0, blurry: 0, dark: 0, bright: 0
  };

  for (const it of items) {
    if (it.isVideo) {
      videos++;
      videoSeconds += it.duration || 0;
    }
    if (it.analyzed) analyzed++;
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
  dateRange: 'Date range',
  withPerson: 'With selected people',
  withoutPerson: 'Without selected people'
};
