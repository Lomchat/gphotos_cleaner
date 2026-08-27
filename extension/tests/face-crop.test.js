/**
 * Turning a detected box into the patch the recognition model sees.
 *
 * Every failure here is silent. A crop shifted by a fraction, a stretched
 * aspect ratio, interleaved channels where planar was expected — all of them
 * still produce a 512-float vector that clusters into a plausible group. Of
 * the wrong person.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  cropRect, toFaceTensor, faceWidthPx, FACE_SIZE, CROP_MARGIN
} from '../src/analysis/face-crop.js';

/* ------------------------------------------------------------------ rect */

test('the crop is square whatever the box shape', () => {
  const tall = cropRect([0.4, 0.1, 0.5, 0.9], 1000, 1000, 0);
  const wide = cropRect([0.1, 0.4, 0.9, 0.5], 1000, 1000, 0);
  assert.equal(tall.side, 800);
  assert.equal(wide.side, 800);
});

test('the crop is centred on the box', () => {
  const rect = cropRect([0.4, 0.4, 0.6, 0.6], 1000, 1000, 0);
  assert.equal(rect.left + rect.side / 2, 500);
  assert.equal(rect.top + rect.side / 2, 500);
});

test('the margin widens the crop by the stated fraction', () => {
  const tight = cropRect([0.4, 0.4, 0.6, 0.6], 1000, 1000, 0);
  const loose = cropRect([0.4, 0.4, 0.6, 0.6], 1000, 1000, 0.25);
  assert.equal(loose.side, Math.round(tight.side * 1.25));
});

test('the default margin is the one the model was measured with', () => {
  assert.equal(CROP_MARGIN, 0.25);
});

test('the square is taken from the longer side, never by stretching', () => {
  // Stretching a rectangle to fill a square input distorts the face and the
  // embedding drifts with it.
  const rect = cropRect([0.45, 0.2, 0.55, 0.8], 1000, 1000, 0);
  assert.equal(rect.side, 600);
});

test('a face at the left edge keeps its proportions', () => {
  const rect = cropRect([0.0, 0.4, 0.1, 0.5], 1000, 1000, 0.25);
  assert.ok(rect.left < 0, 'the square should hang off the edge');
  assert.equal(rect.sx, 0, 'the readable part starts at the image edge');
  assert.ok(rect.dx > 0, 'and is placed at its true offset inside the patch');
});

test('a face at the bottom-right edge is clipped, not wrapped', () => {
  const rect = cropRect([0.92, 0.92, 1.0, 1.0], 1000, 1000, 0.25);
  assert.ok(rect.sx + rect.sw <= 1000);
  assert.ok(rect.sy + rect.sh <= 1000);
});

test('a box larger than the photo still yields a readable rectangle', () => {
  const rect = cropRect([0, 0, 1, 1], 400, 300, 0.25);
  assert.ok(rect.sw > 0 && rect.sh > 0);
  assert.ok(rect.sx >= 0 && rect.sy >= 0);
});

test('the scale maps the square onto the model input', () => {
  const rect = cropRect([0.4, 0.4, 0.6, 0.6], 1000, 1000, 0);
  assert.equal(Math.round(rect.side * rect.scale), FACE_SIZE);
});

test('a degenerate box does not produce a zero-sized crop', () => {
  const rect = cropRect([0.5, 0.5, 0.5, 0.5], 800, 600, 0.25);
  assert.ok(rect.side >= 1);
});

test('a non-square photo maps the box to real pixels on each axis', () => {
  const rect = cropRect([0.25, 0.25, 0.75, 0.75], 800, 400, 0);
  // 0.5 of 800 is wider than 0.5 of 400: the square follows the longer side.
  assert.equal(rect.side, 400);
});

/* ---------------------------------------------------------------- tensor */

function rgba(pixels, r, g, b) {
  const out = new Uint8ClampedArray(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = b; out[i * 4 + 3] = 255;
  }
  return out;
}

test('the tensor has one plane per colour channel', () => {
  const out = toFaceTensor(rgba(FACE_SIZE * FACE_SIZE, 0, 0, 0));
  assert.equal(out.length, 3 * FACE_SIZE * FACE_SIZE);
});

test('channels are planar, not interleaved', () => {
  // Interleaved input is the classic mistake: it runs, and returns noise.
  const size = 4;
  const out = toFaceTensor(rgba(size * size, 255, 0, 0), size);
  const plane = size * size;
  assert.ok(out[0] > 0.9, 'first plane should be the red channel');
  assert.ok(out[plane] < -0.9, 'second plane should be green');
  assert.ok(out[2 * plane] < -0.9, 'third plane should be blue');
});

test('white maps to +1 and black to -1', () => {
  const white = toFaceTensor(rgba(16, 255, 255, 255), 4);
  const black = toFaceTensor(rgba(16, 0, 0, 0), 4);
  assert.ok(Math.abs(white[0] - 1) < 0.01);
  assert.ok(Math.abs(black[0] + 1) < 0.01);
});

test('mid grey maps to roughly zero', () => {
  const grey = toFaceTensor(rgba(16, 128, 128, 128), 4);
  assert.ok(Math.abs(grey[0]) < 0.01);
});

test('the alpha channel is ignored', () => {
  const opaque = rgba(16, 200, 100, 50);
  const transparent = rgba(16, 200, 100, 50);
  for (let i = 3; i < transparent.length; i += 4) transparent[i] = 0;
  assert.deepEqual(toFaceTensor(opaque, 4), toFaceTensor(transparent, 4));
});

/* ------------------------------------------------------------- face size */

test('face width is measured in source pixels', () => {
  assert.equal(faceWidthPx([0.25, 0.1, 0.5, 0.4], 800), 200);
});

test('the same face is worth more pixels in a larger rendition', () => {
  // The whole reason the People pass re-fetches at a larger size.
  const box = [0.4, 0.4, 0.45, 0.5];
  assert.ok(faceWidthPx(box, 512) > faceWidthPx(box, 176));
});

/* ------------------------------------------------- framing a face on screen */

/**
 * A face shown in a round frame, cut from the photo it came from.
 *
 * The trap: boxes are normalised to the photo, so a box that is square in
 * normalised space is not square on screen unless the photo is. `cropRect`
 * above squares faces in pixel space for exactly that reason; a viewer that
 * squares them in normalised space shows every face on a non-square photograph
 * stretched, and framed slightly wrong. Which is nearly all of them.
 */
import { faceCropStyle } from '../src/analysis/face-crop.js';

test('the picture keeps the shape it had', () => {
  // The whole point. A 16:9 photo must still be displayed 16:9, or the face is
  // squeezed by the ratio between the axes.
  const wide = faceCropStyle([0.4, 0.4, 0.6, 0.6], 16 / 9);
  assert.ok(Math.abs(wide.width / wide.height - 16 / 9) < 1e-6,
    `displayed at ${(wide.width / wide.height).toFixed(3)}:1`);

  const tall = faceCropStyle([0.4, 0.4, 0.6, 0.6], 3 / 4);
  assert.ok(Math.abs(tall.width / tall.height - 3 / 4) < 1e-6);
});

test('a square photo is neither stretched nor squashed', () => {
  const s = faceCropStyle([0.3, 0.3, 0.5, 0.5], 1);
  assert.equal(s.width, s.height);
});

test('the face lands in the middle of the frame', () => {
  // The offsets are what actually frame it, and they are easy to get subtly
  // wrong: a crop shifted by a fraction still shows a face, just not the one
  // that was clicked.
  for (const aspect of [1, 16 / 9, 3 / 4]) {
    const box = [0.5, 0.2, 0.7, 0.4];
    const s = faceCropStyle(box, aspect);
    // Where the box's centre ends up, as a fraction of the frame.
    const cx = (s.left + ((box[0] + box[2]) / 2) * s.width) / 100;
    const cy = (s.top + ((box[1] + box[3]) / 2) * s.height) / 100;
    assert.ok(Math.abs(cx - 0.5) < 1e-6, `x at ${cx} for aspect ${aspect}`);
    assert.ok(Math.abs(cy - 0.5) < 1e-6, `y at ${cy} for aspect ${aspect}`);
  }
});

test('the frame holds more than the detector box', () => {
  // Cropped exactly to the rectangle, a face loses its hair and its chin — and
  // is harder to recognise, which matters when the click protects a person.
  const box = [0.4, 0.4, 0.6, 0.6];
  const s = faceCropStyle(box, 1);
  const boxOnScreen = (box[2] - box[0]) * s.width / 100;
  assert.ok(boxOnScreen < 0.85, `the box fills ${(boxOnScreen * 100).toFixed(0)}% of the frame`);
  assert.ok(boxOnScreen > 0.35, 'and is not lost in it either');
});

test('a missing box shows the photo rather than nothing', () => {
  // Protections made before boxes were stored still have to render.
  const s = faceCropStyle(null, 1);
  assert.ok(Number.isFinite(s.width) && Number.isFinite(s.left));
  assert.ok(s.width <= 400, 'and not magnified to a single pixel');
});

test('a nonsensical box cannot magnify the picture without bound', () => {
  // A zero-width box would divide by nothing and ask for an image millions of
  // percent wide.
  const s = faceCropStyle([0.5, 0.5, 0.5, 0.5], 1);
  assert.ok(Number.isFinite(s.width) && s.width <= 40000, `width ${s.width}%`);
});

test('the shape survives the bounds, not only the ordinary case', () => {
  // Clamping each axis on its own would clamp them by different amounts and
  // quietly reintroduce exactly the stretching this is here to prevent.
  for (const aspect of [16 / 9, 3 / 4, 2.4]) {
    for (const box of [[0.5, 0.5, 0.5, 0.5], [0, 0, 1, 1], [0.1, 0.1, 0.99, 0.99]]) {
      const s = faceCropStyle(box, aspect);
      assert.ok(Math.abs(s.width / s.height - aspect) < 1e-6,
        `aspect ${aspect}, box ${box.join(',')} displayed at ${(s.width / s.height).toFixed(3)}`);
    }
  }
});
