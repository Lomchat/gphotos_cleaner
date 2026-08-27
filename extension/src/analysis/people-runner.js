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
import { grabFrames, dedupeFaces, BYTE_CAP, FRAME_COUNT } from './video-frames.js';

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

/** See `worker.js`: URLs from the API always need the session cookie. */
const needsCookie = new Set();

async function fetchBitmap(url) {
  let host;
  try { host = new URL(url).hostname; } catch { host = url; }

  let res;
  if (needsCookie.has(host)) {
    res = await fetch(url, { credentials: 'include', cache: 'force-cache' });
  } else {
    res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
    if (!res.ok) {
      needsCookie.add(host);
      res = await fetch(url, { credentials: 'include', cache: 'no-store' });
    }
  }
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
/**
 * Every usable face in one already-decoded picture.
 *
 * Split out of `analysePhoto` so a video can run it once per sampled frame.
 * Returns the faces and how many were too small to identify, rather than a
 * finished result, because a video has to pool several of these before it can
 * say anything.
 */
async function facesInBitmap(bitmap) {
  const { tensor, pad } = toInputTensor(imageDataOf(bitmap));
  const summary = await detectFaces(tensor, pad, DETECT_THRESHOLD);
  if (!summary) throw new Error('face detection unavailable');

  // `boxes`, not `faces`: the detector's reply carries a summary of the
  // strongest face alongside the full list, and reading the wrong key would
  // silently find nobody in a library full of people.
  const boxes = summary.boxes || [];
  let skipped = 0;
  const usable = [];
  for (const face of boxes) {
    if (faceWidthPx(face.box, bitmap.width) < MIN_FACE_PX) { skipped++; continue; }
    usable.push(face);
  }

  // Fanned out across the recognition pool rather than awaited one at a time.
  const vectors = await Promise.all(usable.map((f) => embed(facePatch(bitmap, f.box))));
  if (vectors.some((v) => !v)) throw new Error('recognition unavailable');

  return {
    skipped,
    faces: usable.map((face, i) => ({
      box: face.box,
      score: face.score,
      // Plain array, not the Float32Array: the reply travels over
      // chrome.runtime messaging, which serialises to JSON rather than
      // structure-cloning. A typed array arrives there as {"0": .., "1": ..},
      // with no length — and every distance computed from it comes out as 1.
      vector: Array.from(vectors[i])
    }))
  };
}

/**
 * Faces across several frames of a video, one per person.
 *
 * Falls back to the poster frame on any failure — a decode that does not work
 * leaves a video no worse off than before videos were read at all, which is
 * what makes sampling them safe to switch on.
 */
async function analyseVideo(item, options) {
  const base = (item.urlRaw || item.url || '').split('=')[0];
  const { frames, reason } = base
    ? await grabFrames(`${base}=m18`, {
        duration: item.duration || 0,
        byteCap: options?.byteCap ?? BYTE_CAP,
        count: options?.frameCount ?? FRAME_COUNT
      })
    : { frames: [], reason: 'no url' };

  if (!frames.length) return { frames: 0, fellBack: reason || 'no frame' };

  const found = [];
  let skipped = 0;
  try {
    for (const frame of frames) {
      const part = await facesInBitmap(frame);
      skipped += part.skipped;
      // The box is normalised, so it travels between frames of one video
      // unchanged — they are all the same size.
      for (const face of part.faces) found.push(face);
    }
  } finally {
    for (const frame of frames) frame.close?.();
  }

  return {
    frames: frames.length,
    skipped,
    // One per person. Five frames of one face are five embeddings of one
    // person: stored whole they would inflate that person's group fivefold,
    // skew the rarest-people order, and break the rule that two faces sharing
    // a photo id are two *different* people — which is what protection uses to
    // tell a clean group from a merged one.
    faces: dedupeFaces(found, options?.eps ?? 0.55)
  };
}

export async function analysePhoto(item, options = {}) {
  // A video is sampled across several instants when asked for; its poster
  // frame remains the fallback, and the only path when sampling is off.
  if (item.isVideo && options.sampleVideo) {
    try {
      const out = await analyseVideo(item, options);
      if (out.faces?.length || out.frames) {
        return {
          id: item.id, ok: true,
          faces: out.faces || [],
          skipped: out.skipped || 0,
          frames: out.frames
        };
      }
    } catch (err) {
      // Straight on to the poster frame below.
      void err;
    }
  }

  let bitmap;
  try {
    bitmap = await fetchBitmap(item.url);
  } catch (err) {
    return { id: item.id, ok: false, error: String(err?.message || err) };
  }

  try {
    const { faces, skipped } = await facesInBitmap(bitmap);

    return { id: item.id, ok: true, faces, skipped, width: bitmap.width, height: bitmap.height };
  } catch (err) {
    return { id: item.id, ok: false, error: String(err?.message || err) };
  } finally {
    bitmap.close?.();
  }
}
