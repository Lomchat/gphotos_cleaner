/**
 * The people pass: photo in, identity vectors out.
 *
 * Runs in the offscreen document, where the extension's own CSP applies and
 * `host_permissions` make thumbnail fetches CORS-free.
 *
 * This is a second pass over the library rather than part of the main analysis,
 * for one measured reason: identity needs pixels the 176px thumbnail does not
 * carry. The main pass is bound by transfer, so enlarging it would slow every
 * photo; here only photos already known to contain a face are re-fetched.
 */

import { toInputTensor } from './face-postprocess.js';
import { detect as detectFaces } from './face-pool.js';
import { embed } from './recognize-pool.js';
import { cropRect, toFaceTensor, faceWidthPx, FACE_SIZE } from './face-crop.js';

/**
 * Rendition asked of Google for this pass.
 *
 * Measured on a photo of seven strangers, closest different-person distance
 * against the 0.55 grouping threshold:
 *   176px (faces  9-13px)  0.584   +0.03 headroom
 *   320px (faces 17-22px)  0.593   +0.04
 *   512px (faces 28-35px)  0.627   +0.08
 * The gain flattens past 512, and the bytes do not.
 */
export const PEOPLE_RENDER_PX = 512;

/**
 * Faces narrower than this are recorded but never embedded.
 *
 * Below roughly 21 source pixels the headroom above the grouping threshold
 * collapses from ~0.08 to ~0.03 (measurement above). At that point a face
 * upscaled to 112px is mostly interpolation, and two strangers reduced to the
 * same blur sit close enough to merge. Refusing to guess is the safe answer:
 * a photo with only tiny faces is left with no identity rather than a wrong one.
 */
export const MIN_FACE_PX = 24;

const DETECT_THRESHOLD = 0.75;

async function fetchBitmap(url) {
  let res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok) res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  if (!res.ok) throw new Error(`thumbnail HTTP ${res.status}`);
  return createImageBitmap(await res.blob());
}

function imageDataOf(bitmap) {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  return ctx.getImageData(0, 0, bitmap.width, bitmap.height);
}

/**
 * Square 112x112 patch for one detection.
 *
 * The rectangle can hang off the edge of the photo — a face at the border is
 * ordinary. The visible part is placed at its true offset inside a black patch
 * rather than stretched to fill it, so the face keeps its proportions and its
 * position in the frame.
 */
function facePatch(bitmap, box) {
  const rect = cropRect(box, bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(FACE_SIZE, FACE_SIZE);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, FACE_SIZE, FACE_SIZE);
  if (rect.sw > 0 && rect.sh > 0) {
    ctx.drawImage(
      bitmap,
      rect.sx, rect.sy, rect.sw, rect.sh,
      rect.dx * rect.scale, rect.dy * rect.scale,
      rect.sw * rect.scale, rect.sh * rect.scale
    );
  }
  return toFaceTensor(ctx.getImageData(0, 0, FACE_SIZE, FACE_SIZE).data);
}

/**
 * Analyse one photo.
 *
 * @returns {{id, ok, faces?: Array<{box, score, vector}>, skipped?: number, error?}}
 */
export async function analysePhoto(item) {
  let bitmap;
  try {
    bitmap = await fetchBitmap(item.url);
  } catch (err) {
    return { id: item.id, ok: false, error: String(err?.message || err) };
  }

  try {
    const { tensor, pad } = toInputTensor(imageDataOf(bitmap));
    const summary = await detectFaces(tensor, pad, DETECT_THRESHOLD);
    if (!summary) return { id: item.id, ok: false, error: 'face detection unavailable' };

    // `boxes`, not `faces`: the detector's reply carries a summary of the
    // strongest face alongside the full list, and reading the wrong key would
    // silently find nobody in a library full of people.
    const boxes = summary.boxes || [];
    const faces = [];
    let skipped = 0;

    for (const face of boxes) {
      if (faceWidthPx(face.box, bitmap.width) < MIN_FACE_PX) { skipped++; continue; }
      const vector = await embed(facePatch(bitmap, face.box));
      if (!vector) return { id: item.id, ok: false, error: 'recognition unavailable' };
      // Plain array, not the Float32Array: the reply travels over
      // chrome.runtime messaging, which serialises to JSON rather than
      // structured-cloning. A typed array arrives there as {"0": .., "1": ..},
      // with no length — and every distance computed from it comes out as 1.
      faces.push({ box: face.box, score: face.score, vector: Array.from(vector) });
    }

    return { id: item.id, ok: true, faces, skipped, width: bitmap.width, height: bitmap.height };
  } catch (err) {
    return { id: item.id, ok: false, error: String(err?.message || err) };
  } finally {
    bitmap.close?.();
  }
}
