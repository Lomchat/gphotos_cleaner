/**
 * Turning a detected box into the 112x112 patch the recognition model expects.
 *
 * Pure geometry and array maths, kept out of the worker so it can be tested
 * without a canvas or a model. Errors here are the quiet kind: a crop shifted
 * by a fraction still embeds, still clusters, and still produces a group — of
 * the wrong person.
 */

export const FACE_SIZE = 112;

/**
 * The recognition model wants some context around the face, not the features
 * alone. Measured against tighter and looser crops, 25% gave the widest gap
 * between same-person and different-person distances.
 */
export const CROP_MARGIN = 0.25;

/**
 * Square source rectangle for a normalised detection box.
 *
 * Square because the model's input is square: feeding it a stretched rectangle
 * distorts the face and the embedding drifts. The box is widened to `margin`,
 * then squared on its longer side.
 *
 * The rectangle may fall partly outside the image — a face at the very edge of
 * a photo is common. Callers get the raw rectangle plus the clamped part that
 * actually exists, so they can place the visible pixels correctly inside a
 * black patch instead of stretching them to fill it.
 */
export function cropRect(box, width, height, margin = CROP_MARGIN) {
  const x1 = box[0] * width;
  const y1 = box[1] * height;
  const x2 = box[2] * width;
  const y2 = box[3] * height;

  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const half = Math.max(x2 - x1, y2 - y1) * (1 + margin) / 2;

  const left = Math.round(cx - half);
  const top = Math.round(cy - half);
  const side = Math.max(1, Math.round(half * 2));

  const sx = Math.max(0, left);
  const sy = Math.max(0, top);
  const sw = Math.max(0, Math.min(left + side, width) - sx);
  const sh = Math.max(0, Math.min(top + side, height) - sy);

  return {
    left, top, side,
    // Source rectangle clipped to the image…
    sx, sy, sw, sh,
    // …and where it belongs within the square patch.
    dx: sx - left, dy: sy - top,
    // Scale from patch pixels to output pixels.
    scale: FACE_SIZE / side
  };
}

/**
 * RGBA pixels to the NCHW float tensor the model expects.
 *
 * Two things must match the training pre-processing exactly or the embedding is
 * meaningless while still looking like a plausible vector: the (x-127.5)/127.5
 * scaling, and planar channel order rather than interleaved.
 */
export function toFaceTensor(rgba, size = FACE_SIZE) {
  const pixels = size * size;
  const out = new Float32Array(3 * pixels);
  for (let i = 0; i < pixels; i++) {
    const p = i * 4;
    out[i] = (rgba[p] - 127.5) / 127.5;
    out[pixels + i] = (rgba[p + 1] - 127.5) / 127.5;
    out[2 * pixels + i] = (rgba[p + 2] - 127.5) / 127.5;
  }
  return out;
}

/**
 * How many source pixels the face occupies, before any upscaling.
 *
 * A box measuring a handful of pixels carries no identity: upscaled to 112 it
 * embeds to a generic blur, and generic blurs from different people sit close
 * together — which is how two strangers end up in one group. Callers use this
 * to drop faces too small to judge instead of guessing about them.
 */
export function faceWidthPx(box, width) {
  return (box[2] - box[0]) * width;
}

/**
 * Where to put a picture so one face fills a square frame.
 *
 * Returns percentages for an absolutely-positioned `<img>` inside a square
 * container. Percentages rather than pixels because the frame is sized by CSS
 * and this has no way to know how big it ended up.
 *
 * The subtlety that makes this worth its own function: boxes are normalised to
 * the photo, so a box that is square *in normalised space* is not square on
 * screen unless the photo is. `cropRect` above squares faces in pixel space,
 * for the same reason — the model wants an undistorted face — and a viewer
 * that squares them in normalised space instead shows a face stretched by the
 * photo's aspect ratio, framed slightly wrong, on every non-square photograph.
 * Which is nearly all of them.
 *
 * @param {number[]} box  [x1, y1, x2, y2], normalised
 * @param {number} aspect width / height of the photo
 * @param {number} margin extra room around the face, as a fraction
 */
export function faceCropStyle(box, aspect = 1, margin = CROP_MARGIN * 2.4) {
  const [x1, y1, x2, y2] = Array.isArray(box) && box.length === 4 ? box : [0, 0, 1, 1];
  const a = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;

  const w = Math.max(1e-4, x2 - x1);
  const h = Math.max(1e-4, y2 - y1);
  // Squared in pixels, then carried back into normalised space, where the two
  // axes have different scales.
  // Bounded once, then split — never once per axis, which would clamp the two
  // by different amounts and quietly reintroduce the stretching this function
  // exists to avoid.
  //
  // The ceiling keeps a huge box from asking for a picture smaller than its
  // frame. The floor matters more: a degenerate box — zero width, or two
  // identical corners — divides into a magnification of several hundred
  // thousand per cent, which paints nothing and spends a great deal of memory
  // doing it.
  const low = 0.02 * Math.max(1, a);
  const high = Math.max(low, 4 * Math.min(1, a));
  const sidePx = Math.min(high, Math.max(low, Math.max(w * a, h) * (1 + margin)));
  const sideX = sidePx / a;
  const sideY = sidePx;

  const cx = (x1 + x2) / 2;
  const cy = (y1 + y2) / 2;
  const zoomX = 1 / sideX;
  const zoomY = 1 / sideY;

  return {
    width: zoomX * 100,
    height: zoomY * 100,
    left: -(cx - sideX / 2) * zoomX * 100,
    top: -(cy - sideY / 2) * zoomY * 100
  };
}
