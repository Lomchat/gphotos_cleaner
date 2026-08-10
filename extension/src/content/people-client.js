/**
 * Driving the people pass from the panel.
 *
 * Mirrors `analyze-client.js`: batches, reports progress, survives failures.
 * The work itself happens in the offscreen document; this side only decides
 * what to send and what to keep.
 *
 * Messaging and persistence are injected rather than reached for, so the
 * batching rules can be tested without a browser — they are the part that has
 * to hold when a run of several minutes hits a bad response halfway through.
 */

import * as db from './db.js';
import { withThumbSize } from './dom-adapter.js';
import { clusterFaces, carryNames, peopleByPhoto, DEFAULT_EPS } from '../analysis/cluster.js';
import { PEOPLE_RENDER_PX } from '../analysis/people-runner.js';

const BATCH_SIZE = 12;

/**
 * Photos worth re-fetching at full rendition.
 *
 * Only those the local analysis already believes contain a face. Sending the
 * whole library would multiply the transfer by twenty-odd for nothing: a
 * landscape has no identity to find.
 */
export function candidates(items, { minFaceScore = 0.35 } = {}) {
  return items.filter((it) =>
    it.url &&
    !it.isVideo &&
    it.analyzed &&
    (it.features?.faceScore ?? 0) >= minFaceScore
  );
}

/** Those not yet looked at by the people pass. */
export function pending(items, options) {
  return candidates(items, options).filter((it) => !it.peopleScanned);
}

/**
 * Send photos through the offscreen pass in batches.
 *
 * A failing batch does not abort the rest: on a library of twenty thousand
 * photos one transient error would otherwise throw away everything measured so
 * far, and the pass is minutes long.
 */
export async function scanFaces(items, {
  onProgress, signal, send, save = db.saveFaces
} = {}) {
  const totals = { scanned: 0, faces: 0, failed: 0, tooSmall: 0, errors: [] };

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    if (signal?.aborted) break;
    const slice = items.slice(i, i + BATCH_SIZE);

    let reply;
    try {
      reply = await send({
        type: 'PEOPLE_BATCH',
        // Enlarged here, not in the catalogue: the stored URL stays the 176px
        // one the grid displays, and only this pass pays for more pixels.
        items: slice.map((it) => ({ id: it.id, url: withThumbSize(it.url, PEOPLE_RENDER_PX) }))
      });
    } catch (err) {
      totals.errors.push(String(err?.message || err));
      continue;
    }

    if (!reply?.ok) {
      totals.errors.push(reply?.error || 'no reply from the analysis engine');
      // A missing model or a blocked runtime will not fix itself next batch.
      break;
    }

    const good = reply.results.filter((r) => r.ok);
    const bad = reply.results.filter((r) => !r.ok);
    totals.scanned += good.length;
    totals.failed += bad.length;
    totals.faces += good.reduce((n, r) => n + r.faces.length, 0);
    totals.tooSmall += good.reduce((n, r) => n + (r.skipped || 0), 0);
    if (bad.length && totals.errors.length < 3) totals.errors.push(bad[0].error);

    await save(good, good.map((r) => r.id));
    onProgress?.({
      done: Math.min(i + BATCH_SIZE, items.length),
      total: items.length,
      faces: totals.faces
    });
  }

  return totals;
}

/**
 * Group every stored face and write the answer back onto the photos.
 *
 * Grouping runs over the whole library rather than the newly scanned part: a
 * person is defined by all their photos, and clustering only the newcomers
 * would invent a second group for someone already known.
 */
export async function regroup({ eps = DEFAULT_EPS, previous = [] } = {}) {
  const faces = await db.getAllFaces();
  if (!faces.length) return { groups: [], faces: 0 };

  const { groups } = clusterFaces(
    faces.map((f) => ({ id: f.id, photoId: f.photoId, vector: f.vector })),
    { eps }
  );
  carryNames(groups, previous);

  const byPhoto = peopleByPhoto(groups);
  const scanned = new Set(faces.map((f) => f.photoId));
  const assignments = new Map();
  // Photos scanned but in no group get an explicit empty list: that is what
  // makes "without this person" trustworthy rather than a guess.
  for (const photoId of scanned) assignments.set(photoId, byPhoto.get(photoId) || []);

  await db.savePeople(assignments);
  return { groups, faces: faces.length, assignments };
}

/** Strip the heavy centroid before handing groups to the panel's state. */
export function forDisplay(groups, items) {
  const byId = new Map(items.map((it) => [it.id, it]));
  return groups.map((g) => ({
    id: g.id,
    name: g.name || null,
    size: g.size,
    spread: g.spread,
    photoIds: g.photoIds,
    centroid: Array.from(g.centroid),
    cover: g.photoIds.filter((p) => byId.get(p)?.url).slice(0, 3)
  }));
}
