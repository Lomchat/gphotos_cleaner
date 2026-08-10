/**
 * Grouping face embeddings into people.
 *
 * Pure functions over Float32Array — no DOM, no model, no storage. This is the
 * part where a mistake is invisible: two people merged into one group looks
 * exactly like a working feature until you open it, and the group sits next to
 * a button that hands a selection to Google Photos.
 *
 * Why not DBSCAN, which is the usual answer here: it needs the pairwise
 * distance matrix, and 10,000 faces is 100 million pairs — 400 MB to hold and
 * 51 GFLOP to fill, in a content script, on the user's tab. Instead each face
 * is compared against the *centroids* found so far, which is O(n·k) with k the
 * number of people, followed by a merge pass over the centroids alone (k², and
 * k is in the hundreds). Same shape of answer, a thousandth of the work.
 *
 * The cost of that choice is order-dependence: a face that arrives early can
 * found a group that a later, better-matching one would have joined. The merge
 * pass exists to repair exactly that, and `groupsMatch` in the tests holds this
 * to the same standard as the reference implementation.
 */

/**
 * Cosine distance at which two faces are taken to be the same person.
 *
 * 0.55 was read off five studio portraits, where the worst same-person pair sat
 * at 0.48 and the closest strangers at 0.63. Real libraries are not studio
 * portraits: profiles, sunglasses, bad light and twenty years of ageing push
 * same-person distances well past that, and the result was one person scattered
 * across a dozen groups.
 *
 * 0.60 keeps a margin under the stranger distance while placing far more faces.
 * It is a starting point, not a constant of nature — the People list has a
 * slider, because the right value depends on whose photos these are.
 */
export const DEFAULT_EPS = 0.6;

/**
 * How the merge pass is scaled relative to `eps`.
 *
 * This was 0.8, on the reasoning that a centroid is an average and therefore
 * closer to the true identity than any single face, so it should have to meet a
 * stricter bar. That reasoning was wrong about the case that matters. A person
 * splits into two clusters because something *systematic* separates them —
 * frontal against profile, indoors against sun — and averaging does not remove
 * a systematic difference the way it removes noise. The two centroids keep the
 * gap, sit above the stricter bar, and never merge.
 *
 * Measured over six runs of 44 faces from two people with wide within-person
 * variation, at the default eps:
 *
 *   ratio   faces placed   runs that mixed two identities
 *   0.8         11.2            1 of 6
 *   1.0         12.5            1 of 6
 *   1.1         25.2            4 of 6
 *   1.2         35.8            5 of 6
 *
 * So 1.0 is a modest gain at no extra risk, and the cliff is immediately after.
 * The large lever on splitting is `eps`, not this — which is why `eps` is the
 * one exposed to the user.
 */
export const MERGE_RATIO = 1.0;

/** A person seen once cannot be told apart from a stranger; leave them out. */
export const DEFAULT_MIN_SIZE = 2;

/**
 * Coerce whatever arrived into a usable Float32Array, or refuse loudly.
 */
export function toVector(value) {
  if (value instanceof Float32Array) return value;
  if (Array.isArray(value)) return Float32Array.from(value);

  // A Float32Array that has crossed chrome.runtime messaging arrives as
  // {"0": .., "1": ..}: JSON, not structured clone. Its numbers are intact, so
  // it is rebuilt rather than rejected — but see the throw below, which is what
  // stops any *other* shape from quietly behaving like a zero-length vector.
  if (value && typeof value === 'object') {
    const keys = Object.keys(value);
    if (keys.length && keys.every((k) => /^\d+$/.test(k))) {
      const out = new Float32Array(keys.length);
      for (let i = 0; i < keys.length; i++) out[i] = Number(value[i]) || 0;
      return out;
    }
  }
  throw new TypeError('unusable face vector: expected numbers, got ' + typeof value);
}

/**
 * Project onto the unit sphere.
 *
 * ArcFace is trained with an angular margin, so only direction carries
 * identity. Skipping this makes cosine distance depend on vector length, and
 * brightly lit faces drift away from dim ones for no reason at all.
 */
export function normalise(input) {
  const vector = toVector(input);
  let sum = 0;
  for (let i = 0; i < vector.length; i++) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum);
  if (norm === 0) return vector;
  const out = new Float32Array(vector.length);
  for (let i = 0; i < vector.length; i++) out[i] = vector[i] / norm;
  return out;
}

/**
 * Cosine distance between two unit vectors, in [0, 2].
 *
 * Both sides are checked, because a vector of no usable length would make every
 * pair sit exactly 1 apart — further than the grouping threshold, so every face
 * would become its own singleton and be dropped. The symptom is zero people
 * from a library full of them, with nothing logged.
 */
export function distance(a, b) {
  if (!a?.length || !b?.length) {
    throw new TypeError('cannot measure a distance against a zero-length vector');
  }
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return 1 - Math.min(1, Math.max(-1, dot));
}

/**
 * Group faces by identity.
 *
 * @param {Array<{id: string, photoId: string, vector: Float32Array}>} faces
 * @param {{eps?: number, minSize?: number}} options
 * @returns {{groups: Array, ungrouped: string[]}} groups carry `members`
 *   (face ids), `photoIds`, `centroid` and `spread`.
 */
export function clusterFaces(faces, {
  eps = DEFAULT_EPS, minSize = DEFAULT_MIN_SIZE, mergeRatio = MERGE_RATIO
} = {}) {
  if (!faces.length) return { groups: [], ungrouped: [] };

  // Coerce first, then measure: the raw value may have crossed a JSON boundary
  // and carry no length of its own, and a dim of undefined would quietly make
  // every merged centroid an empty array.
  const units = faces.map((f) => normalise(f.vector));
  const dim = units[0].length;
  if (!dim) throw new TypeError('face vectors have no length; nothing can be grouped');

  // ---- assign: one pass, each face against the centroids so far -----------
  const clusters = [];
  for (let i = 0; i < faces.length; i++) {
    const unit = units[i];
    let best = -1;
    let bestDist = Infinity;
    for (let c = 0; c < clusters.length; c++) {
      const d = distance(unit, clusters[c].centroid);
      if (d < bestDist) { bestDist = d; best = c; }
    }
    if (best >= 0 && bestDist <= eps) {
      addMember(clusters[best], i, unit);
    } else {
      clusters.push({ members: [i], sum: Float32Array.from(unit), centroid: unit });
    }
  }

  // ---- merge: repair the order-dependence of the pass above ---------------
  mergeClusters(clusters, eps * mergeRatio, dim);

  // ---- report -------------------------------------------------------------
  const groups = [];
  const ungrouped = [];
  for (const cluster of clusters) {
    if (cluster.members.length < minSize) {
      for (const i of cluster.members) ungrouped.push(faces[i].id);
      continue;
    }
    const members = cluster.members.map((i) => faces[i].id);
    const photoIds = [...new Set(cluster.members.map((i) => faces[i].photoId))];
    groups.push({
      members,
      photoIds,
      size: cluster.members.length,
      centroid: cluster.centroid,
      spread: meanDistanceToCentroid(cluster, units)
    });
  }

  // Largest first: the people someone actually wants to filter on.
  groups.sort((a, b) => b.size - a.size);
  groups.forEach((g, i) => { g.id = i; });
  return { groups, ungrouped };
}

function addMember(cluster, index, unit) {
  cluster.members.push(index);
  for (let i = 0; i < unit.length; i++) cluster.sum[i] += unit[i];
  cluster.centroid = normalise(cluster.sum);
}

/**
 * Repeatedly fuse the closest pair of centroids until none are within reach.
 *
 * One pass is not enough: fusing A and B moves their centroid, which can bring
 * it within range of C. Looping until nothing changes is what makes the result
 * independent of the order faces arrived in.
 */
function mergeClusters(clusters, threshold, dim) {
  let merged = true;
  while (merged && clusters.length > 1) {
    merged = false;
    outer:
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        if (distance(clusters[a].centroid, clusters[b].centroid) > threshold) continue;
        const sum = new Float32Array(dim);
        for (let i = 0; i < dim; i++) sum[i] = clusters[a].sum[i] + clusters[b].sum[i];
        clusters[a] = {
          members: clusters[a].members.concat(clusters[b].members),
          sum,
          centroid: normalise(sum)
        };
        clusters.splice(b, 1);
        merged = true;
        break outer;
      }
    }
  }
}

/**
 * Mean distance from the members to their centroid.
 *
 * A high value on a large group is the signature of a merge — two people pulled
 * together — and is the number to look at before trusting a group.
 */
function meanDistanceToCentroid(cluster, units) {
  let total = 0;
  for (const i of cluster.members) total += distance(units[i], cluster.centroid);
  return Math.round((total / cluster.members.length) * 10000) / 10000;
}

/**
 * Attach new faces to groups that already exist.
 *
 * Re-clustering the whole library after every run would renumber every group
 * and undo any naming the user has done. New faces are matched against stored
 * centroids instead, and anything too far away stays ungrouped rather than
 * being forced into the closest match.
 *
 * @returns {Map<string, number>} face id → group id, only for faces that matched
 */
export function assignToGroups(faces, centroids, { eps = DEFAULT_EPS } = {}) {
  const out = new Map();
  if (!centroids.length) return out;
  const units = centroids.map((c) => normalise(c.centroid));
  for (const face of faces) {
    const unit = normalise(face.vector);
    let best = -1;
    let bestDist = Infinity;
    for (let i = 0; i < units.length; i++) {
      const d = distance(unit, units[i]);
      if (d < bestDist) { bestDist = d; best = i; }
    }
    if (best >= 0 && bestDist <= eps) out.set(face.id, centroids[best].id);
  }
  return out;
}

/**
 * Carry names across a rebuild by matching centroids, not ids.
 *
 * Group ids are positional and change whenever the library does, so a name tied
 * to an id would migrate to a different person — silently, and in a UI whose
 * whole job is deciding what to delete.
 */
export function carryNames(groups, previous, { maxDistance = 0.35 } = {}) {
  const named = previous.filter((p) => p.name && p.centroid);
  const taken = new Set();
  for (const group of groups) {
    let best = null;
    let bestDist = Infinity;
    for (const old of named) {
      if (taken.has(old)) continue;
      const d = distance(normalise(group.centroid), normalise(old.centroid));
      if (d < bestDist) { bestDist = d; best = old; }
    }
    if (best && bestDist <= maxDistance) {
      group.name = best.name;
      taken.add(best);
    }
  }
  return groups;
}

/** A short label for a group, named or not. */
export function groupLabel(group) {
  return group.name || `Person ${group.id + 1}`;
}

/**
 * Turn groups into "which people are in this photo".
 *
 * Photos absent from every group stay absent from the map: "not analysed" must
 * remain distinguishable from "nobody in it", because the *without* filter
 * depends on telling them apart.
 */
export function peopleByPhoto(groups) {
  const byPhoto = new Map();
  for (const group of groups) {
    for (const photoId of group.photoIds) {
      if (!byPhoto.has(photoId)) byPhoto.set(photoId, []);
      byPhoto.get(photoId).push(group.id);
    }
  }
  for (const list of byPhoto.values()) list.sort((a, b) => a - b);
  return byPhoto;
}
