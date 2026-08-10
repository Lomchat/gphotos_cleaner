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
