/**
 * Zooming and panning inside the full-size view.
 *
 * Pure arithmetic, kept out of the panel because it is the part that is easy
 * to get subtly wrong and impossible to notice in a screenshot: a zoom that
 * drifts off-target still zooms, it just fights whoever is using it.
 *
 * The rule that makes a wheel zoom feel right is that **the point under the
 * cursor stays under the cursor**. Zooming about the centre instead means
 * every step pushes what you were looking at towards the edge, and you chase
 * it back with a drag — which is the difference between inspecting a face and
 * wrestling with a viewport.
 *
 * Coordinates here are offsets from the centre of the stage, in stage pixels,
 * because that is the origin CSS transforms use.
 */

export const MIN_SCALE = 1;

/**
 * Eight times is enough to see the grain on a 1600px rendition, which is the
 * point at which there is nothing further to learn — past that the browser is
 * only interpolating and the answer stops improving.
 */
export const MAX_SCALE = 8;

/** How fast the wheel zooms. Per pixel of scroll, so it is device-independent. */
export const WHEEL_RATE = 0.0022;

/**
 * A wheel event's travel in pixels.
 *
 * `deltaY` is not comparable between devices: a mouse wheel usually reports
 * lines, a trackpad reports pixels, and a page-mode device reports neither.
 * Without this a notched wheel would zoom a hundred times faster than a
 * trackpad, or not at all.
 */
export function wheelPixels({ deltaY = 0, deltaMode = 0 } = {}) {
  if (deltaMode === 1) return deltaY * 16;   // lines
  if (deltaMode === 2) return deltaY * 400;  // pages
  return deltaY;
}

export function clampScale(scale) {
  if (!Number.isFinite(scale)) return MIN_SCALE;
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

/** What one wheel gesture does to the scale. Up zooms in. */
export function scaleAfterWheel(scale, pixels) {
  // Exponential, so a step feels the same whether you are at 1x or at 6x —
  // a fixed increment would crawl at the bottom and leap at the top.
  return clampScale(scale * Math.exp(-pixels * WHEEL_RATE));
}

/**
 * Zoom about a point, keeping whatever is under it in place.
 *
 * @param {{scale:number, x:number, y:number}} view current transform
 * @param {number} nextScale where the scale is going
 * @param {number} px pointer offset from the stage centre
 * @param {number} py
 */
export function zoomAbout(view, nextScale, px, py) {
  const scale = view.scale || MIN_SCALE;
  const next = clampScale(nextScale);
  if (next === scale) return { ...view, scale: next };

  // A point sits on screen at `x + c * scale`, where `c` is its position in
  // the unscaled picture. Solving for the offset that leaves it there:
  const ratio = next / scale;
  return {
    scale: next,
    x: px - (px - view.x) * ratio,
    y: py - (py - view.y) * ratio
  };
}

/**
 * Keep the picture overlapping the stage.
 *
 * Without this a zoomed photo can be dragged out of sight entirely, leaving a
 * black rectangle and no way to tell what happened. At a scale that fits, the
 * allowed range is zero — so it snaps back to centred rather than sitting
 * slightly off, which is what makes returning to 1x feel like a reset.
 *
 * `mediaW`/`mediaH` are the laid-out size before any transform: CSS
 * `object-fit: contain` means that is rarely the same as the stage.
 */
export function clampPan(view, { mediaW = 0, mediaH = 0, stageW = 0, stageH = 0 } = {}) {
  const limit = (media, stage) => Math.max(0, (media * view.scale - stage) / 2);
  // Clamping a negative offset against a zero limit yields -0, which is
  // arithmetically fine and prints as `translate(-0.0px)`. Adding zero folds
  // it back to +0 — the one case where that is not a no-op.
  const hold = (value, max) => Math.min(max, Math.max(-max, value || 0)) + 0;
  return {
    scale: view.scale,
    x: hold(view.x, limit(mediaW, stageW)),
    y: hold(view.y, limit(mediaH, stageH))
  };
}

/** The untouched view: fitted and centred. */
export function resetView() {
  return { scale: MIN_SCALE, x: 0, y: 0 };
}

/** The CSS for a view. Translate before scale, so offsets stay in stage pixels. */
export function transformFor(view) {
  return `translate(${view.x.toFixed(1)}px, ${view.y.toFixed(1)}px) scale(${view.scale.toFixed(3)})`;
}
