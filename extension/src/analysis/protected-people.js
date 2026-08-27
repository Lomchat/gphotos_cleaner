/**
 * People whose photos must never be offered for deletion.
 *
 * "I know this face — nothing with them in it should ever be on the chopping
 * block." Everything here follows from one awkward fact: **group ids are
 * positional and rebuilt from scratch every time the faces are regrouped.**
 * Person 3 today is a different person tomorrow. So a protection stored by id
 * would, on the next run, silently protect somebody else and expose the person
 * it was meant to shield — the worst possible failure for this feature.
 *
 * A protection is therefore stored as a **vector**: the identity itself,
 * matched by distance the same way grouping matches anything else. Ids change;
 * a face does not. `carryNames` already carries names across rebuilds this way,
 * so the mechanism is not new — only the stakes are higher.
 *
 * Two more consequences worth stating:
 *
 * Faces are matched, **not groups**. A group needs two faces to exist, so a
 * protected person appearing exactly once in a photo would form no group and
 * that photo would slip through. Checking every stored face costs more and is
 * the only thing that is actually correct.
 *
 * And the threshold is the user's own grouping slider rather than a second
 * one. It answers the identical question — *is this the same person?* — and
 * two numbers that must agree but can be set apart is a bug waiting to be
 * filed.
 */

import { toVector, normalise, distance } from './cluster.js';

/**
 * The protected person a vector belongs to, or null.
 *
 * Returns the nearest match rather than the first: with several protected
 * people, the closest is the honest answer, and it is what a caller naming the
 * reason a photo is hidden should show.
 */
export function matchProtected(vector, list = [], eps = 0.75) {
  if (!list.length) return null;
  let face;
  try {
    face = normalise(toVector(vector));
  } catch {
    // A vector that did not survive storage is not an identity. Refusing to
    // guess is right: the alternative is protecting an arbitrary person.
    return null;
  }

  let best = null;
  let bestDist = Infinity;
  for (const person of list) {
    if (!person?.centroid) continue;
    let d;
    try {
      d = distance(face, normalise(toVector(person.centroid)));
    } catch {
      continue;
    }
    if (d < bestDist) {
      bestDist = d;
      best = person;
    }
  }
  return best && bestDist <= eps ? { person: best, distance: bestDist } : null;
}

/**
 * Which photos hold a protected face.
 *
 * @param {Array<{photoId:string, vector:*}>} faces every face in the catalogue
 * @returns {Map<string, string>} photo id → the id of the person protecting it
 */
export function protectedPhotos(faces = [], list = [], eps = 0.75) {
  const out = new Map();
  if (!list.length) return out;
  for (const face of faces) {
    if (!face?.photoId || out.has(face.photoId)) continue;
    const hit = matchProtected(face.vector, list, eps);
    if (hit) out.set(face.photoId, hit.person.id);
  }
  return out;
}

/**
 * Is this group about one person, as far as anything here can tell?
 *
 * Two faces from the *same photograph* are almost never the same person, so a
 * group holding more faces than photographs has merged at least two people.
 * That is not a heuristic about faces, it is a fact about photographs, and it
 * is the same signal the clustering thresholds were measured with.
 */
export function looksLikeOnePerson(group, eps = 0.55) {
  if (!group || !group.centroid) return false;
  const photos = group.photoIds?.length ?? 0;
  if (!photos || group.size > photos) return false;
  // A group can also be technically unmixed and still far too loose to stand
  // for anybody — its centroid then sits between several people rather than on
  // one. Half the threshold is the point past which that starts to show.
  return (group.spread ?? 0) <= eps * 0.5;
}

/**
 * Which vector should stand for the person being protected.
 *
 * A group centroid generalises better — it has averaged away the lighting and
 * the angle of any single shot — so it recognises the person in photographs
 * that look nothing like the one in hand. But it speaks for everybody in that
 * group, and a group that has merged two people would protect them both. On a
 * photo of four friends, protecting one was protecting all four.
 *
 * So a group is only borrowed when it looks like one person. Otherwise the
 * face itself is the identity: it generalises less and it is unambiguous,
 * which is the right way round for a decision that hides photographs.
 */
export function chooseIdentity(vector, groups = [], eps = 0.55) {
  let best = null;
  let bestDist = Infinity;
  let unit;
  try {
    unit = normalise(toVector(vector));
  } catch {
    return { centroid: vector, from: 'face', name: null };
  }

  for (const group of groups) {
    if (!looksLikeOnePerson(group, eps)) continue;
    let d;
    try {
      d = distance(unit, normalise(toVector(group.centroid)));
    } catch {
      continue;
    }
    if (d < bestDist) { bestDist = d; best = group; }
  }

  if (best && bestDist <= eps) {
    return { centroid: best.centroid, from: 'group', name: best.name || null };
  }
  return { centroid: vector, from: 'face', name: null };
}

/**
 * A protected person, built from a face or from a whole group.
 *
 * The box and the photo travel with it so the person can be shown as a face
 * rather than as a row of text — a list of protections nobody can recognise is
 * a list nobody can audit.
 */
export function makeProtected({
  centroid, name = null, from = 'face', photoId = null, box = null, now = 0
}) {
  return {
    // Random rather than positional, precisely because positional is what
    // makes group ids unusable here.
    id: `pp_${now.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    name: name || null,
    // A plain array: this is stored through `chrome.storage`, which serialises
    // to JSON, and a Float32Array arrives there as {"0": …} with no length.
    centroid: Array.from(toVector(centroid)),
    from,
    photoId,
    box: box ? Array.from(box) : null,
    addedAt: now
  };
}

/** A short label, named or not. */
export function protectedLabel(person, index = 0) {
  return person?.name || `Protected ${index + 1}`;
}
