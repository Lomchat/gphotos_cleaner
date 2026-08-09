/**
 * Human presence detection.
 *
 * The two errors do not cost the same. Wrongly seeing someone merely protects a
 * photo. Missing a person puts their photo on a list headed for the bin. These
 * tests therefore demand high **recall** — each case below is a family of
 * photos the older, precision-tuned version classed as "no people".
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { skinFaceHeuristic } from '../src/analysis/features.js';
import { portraitImage, makeImage, flatImage, rng } from './helpers.js';

/** Default threshold of the "no people" criterion in the UI. */
const NO_PEOPLE_THRESHOLD = 0.35;

const detects = (img) => skinFaceHeuristic(img).faceScore > NO_PEOPLE_THRESHOLD;

/* ------------------------------------------------------ people to detect */

test('classic portrait on a contrasting background', () => {
  const r = skinFaceHeuristic(portraitImage());
  assert.ok(r.faceScore > 0.5, `score ${r.faceScore}`);
  assert.ok(r.faceBox, 'a region must be located');
});

test('dark skin', () => {
  // The old RGB rule required r > 90 and a marked red/green gap, which
  // mechanically rejected dark skin.
  for (const skin of [[110, 74, 56], [78, 52, 40], [140, 95, 70]]) {
    assert.ok(detects(portraitImage({ skin, bg: [30, 70, 55] })), `skin ${skin}`);
  }
});

test('very light skin', () => {
  assert.ok(detects(portraitImage({ skin: [246, 214, 192], bg: [35, 60, 90] })));
});

test('colour casts: tungsten indoors, blue shade, fluorescent', () => {
  // Without grey-world balancing, skin tone leaves every fixed range.
  const casts = [
    [1.25, 1.0, 0.72],  // tungsten
    [0.82, 0.94, 1.28], // blue shade
    [0.95, 1.15, 0.9]   // greenish fluorescent
  ];
  for (const cast of casts) {
    assert.ok(detects(portraitImage({ cast, bg: [60, 60, 60] })), `cast ${cast}`);
  }
});

test('small face, as in a group photo', () => {
  // A face at 6% of the side covers under 1% of the frame, below the old area
  // floor, so it was systematically ignored.
  for (const faceR of [0.06, 0.08, 0.11]) {
    const r = skinFaceHeuristic(portraitImage({ faceR, bg: [45, 85, 60] }));
    assert.ok(r.faceScore > NO_PEOPLE_THRESHOLD, `radius ${faceR}, score ${r.faceScore}`);
  }
});

test('several people in frame', () => {
  const size = 160;
  const base = portraitImage({ size, faceR: 0.09, center: [0.25, 0.4], bg: [45, 85, 60] });
  const other = portraitImage({ size, faceR: 0.09, center: [0.72, 0.45], bg: [45, 85, 60] });
  // Overlay the two portraits: wherever the second has skin, write it.
  const fused = makeImage(size, size, (x, y) => {
    const i = (y * size + x) * 4;
    const isBg = other.data[i] === 45 && other.data[i + 1] === 85;
    const src = isBg ? base : other;
    return [src.data[i], src.data[i + 1], src.data[i + 2]];
  });
  assert.ok(detects(fused));
});

test('face merged with neck and shoulders', () => {
  // The skin component is no longer an isolated oval, which the old aspect and
  // fill filter rejected.
  const r = skinFaceHeuristic(portraitImage({ neck: true, bg: [35, 75, 55] }));
  assert.ok(r.faceScore > NO_PEOPLE_THRESHOLD, `score ${r.faceScore}`);
});

test('off-centre face near the edge', () => {
  for (const center of [[0.15, 0.3], [0.85, 0.7], [0.5, 0.16]]) {
    assert.ok(detects(portraitImage({ center, faceR: 0.13, bg: [40, 80, 60] })), `centre ${center}`);
  }
});

test('close-up filling almost the whole frame', () => {
  const r = skinFaceHeuristic(portraitImage({ faceR: 0.34, bg: [30, 60, 45] }));
  assert.ok(r.faceScore > NO_PEOPLE_THRESHOLD, `score ${r.faceScore}`);
});

test('dark scene: underexposed person', () => {
  const r = skinFaceHeuristic(portraitImage({
    skin: [120, 92, 76], bg: [12, 16, 20], cast: [0.72, 0.72, 0.75]
  }));
  assert.ok(r.faceScore > NO_PEOPLE_THRESHOLD, `score ${r.faceScore}`);
});

/* ------------------------------------------------------- scenes with none */

test('vegetation landscape', () => {
  const r = rng(4);
  const img = makeImage(160, 160, () => [
    30 + r() * 40, 90 + r() * 70, 40 + r() * 40
  ]);
  assert.equal(detects(img), false, `score ${skinFaceHeuristic(img).faceScore}`);
});

test('sky and sea', () => {
  const img = makeImage(160, 160, (x, y) => (y < 80 ? [120, 165, 220] : [30, 70, 120]));
  assert.equal(detects(img), false);
});

test('flat surface or neutral texture', () => {
  assert.equal(detects(flatImage(160, 160, 128)), false, 'flat grey');
  assert.equal(detects(flatImage(160, 160, 20)), false, 'near black');
  assert.equal(detects(makeImage(160, 160, () => [240, 240, 245])), false, 'white');
});

test('UI screenshot', () => {
  const img = makeImage(160, 160, (x, y) => {
    if (y < 12) return [24, 24, 28];
    if (y < 40) return [66, 133, 244];
    return x % 20 < 10 ? [255, 255, 255] : [242, 242, 245];
  });
  assert.equal(detects(img), false);
});

test('photo with a cool cast', () => {
  const r = rng(9);
  const img = makeImage(160, 160, () => [40 + r() * 60, 70 + r() * 70, 110 + r() * 90]);
  assert.equal(detects(img), false, `score ${skinFaceHeuristic(img).faceScore}`);
});

test('a uniformly skin-coloured surface counts as a person', () => {
  // DELIBERATE false positive. Sand, light wood or a beige wall filling the
  // frame are, pixel for pixel, skin-coloured; telling them apart from a
  // close-up without a trained model is beyond a heuristic.
  //
  // The error points the right way: the photo is simply excluded from the "no
  // people" list, hence protected. The opposite error would put someone's photo
  // on a list headed for the bin.
  const r = rng(11);
  const sand = makeImage(160, 160, () => [200 + r() * 30, 170 + r() * 25, 130 + r() * 25]);
  assert.equal(detects(sand), true, 'must be protected rather than offered for deletion');
});

/* ---------------------------------------------------------- behaviour */

test('the score grows with skin area', () => {
  // The area signal must be monotonic: that is what rescues faces whose
  // geometry fails (profile, three-quarter, partly occluded).
  const scores = [0.08, 0.14, 0.22, 0.3].map(
    (faceR) => skinFaceHeuristic(portraitImage({ faceR, bg: [40, 80, 60] })).faceScore
  );
  for (let i = 1; i < scores.length; i++) {
    assert.ok(scores[i] >= scores[i - 1] - 0.05,
      `the score must not collapse as the face grows: ${scores}`);
  }
});

test('skinFrac is reported and consistent', () => {
  const empty = skinFaceHeuristic(makeImage(160, 160, () => [30, 90, 40]));
  const full = skinFaceHeuristic(portraitImage({ faceR: 0.3 }));
  assert.ok(empty.skinFrac < 0.02, `landscape: ${empty.skinFrac}`);
  assert.ok(full.skinFrac > empty.skinFrac, 'a portrait holds more skin than a landscape');
  for (const r of [empty, full]) {
    assert.ok(r.skinFrac >= 0 && r.skinFrac <= 1);
    assert.ok(r.faceScore >= 0 && r.faceScore <= 1);
  }
});

test('the bounding box stays inside the image', () => {
  const r = skinFaceHeuristic(portraitImage({ center: [0.9, 0.9], faceR: 0.15 }));
  if (r.faceBox) {
    const [x, y, w, h] = r.faceBox;
    assert.ok(x >= 0 && y >= 0 && x + w <= 1.001 && y + h <= 1.001, `box ${r.faceBox}`);
  }
});
