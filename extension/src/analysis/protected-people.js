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
 * A protected person, built from a face or from a whole group.
 *
 * A group centroid is the better identity when there is one — it averages away
 * the lighting and the angle of any single shot — so callers are expected to
 * find the group first and fall back to the lone face only when there is none.
 * The distinction is recorded, because "protected from one photo" is a weaker
 * claim and the panel should be able to say so.
 */
export function makeProtected({ centroid, name = null, from = 'face', photoId = null, now = 0 }) {
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
    addedAt: now
  };
}

/** A short label, named or not. */
export function protectedLabel(person, index = 0) {
  return person?.name || `Protected ${index + 1}`;
}
