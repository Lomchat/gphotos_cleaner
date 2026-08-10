/**
 * UltraFace output decoding.
 *
 * These are the parts a model cannot check for us: a wrong class index reports
 * background confidence as face confidence, a broken NMS returns the same face
 * a dozen times, and forgotten letterbox padding shifts every box on any photo
 * that is not 4:3. All three are silent.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  iou, nonMaxSuppression, decodeDetections, summarise, toInputTensor, unpadBoxes
} from '../src/analysis/face-postprocess.js';

/* ------------------------------------------------------------------- IoU */

test('IoU is 1 for identical boxes and 0 for disjoint ones', () => {
  const a = [0.1, 0.1, 0.5, 0.5];
  assert.equal(iou(a, a), 1);
  assert.equal(iou(a, [0.6, 0.6, 0.9, 0.9]), 0);
});

test('IoU of a half-overlap is one third', () => {
  // Two unit squares sharing half their area: intersection 0.5, union 1.5.
  const r = iou([0, 0, 1, 1], [0.5, 0, 1.5, 1]);
  assert.ok(Math.abs(r - 1 / 3) < 1e-9, `got ${r}`);
});

test('touching edges do not count as overlap', () => {
  assert.equal(iou([0, 0, 1, 1], [1, 0, 2, 1]), 0);
});

/* ------------------------------------------------------------------- NMS */

test('NMS keeps the best of a cluster and drops the rest', () => {
  const kept = nonMaxSuppression([
    { box: [0.1, 0.1, 0.4, 0.4], score: 0.7 },
    { box: [0.11, 0.11, 0.41, 0.41], score: 0.9 },
    { box: [0.12, 0.12, 0.42, 0.42], score: 0.6 }
  ]);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].score, 0.9, 'the highest score survives');
});

test('NMS keeps genuinely separate faces', () => {
  const kept = nonMaxSuppression([
    { box: [0.05, 0.1, 0.25, 0.4], score: 0.9 },
    { box: [0.6, 0.1, 0.8, 0.4], score: 0.85 },
    { box: [0.35, 0.5, 0.55, 0.8], score: 0.8 }
  ]);
  assert.equal(kept.length, 3, 'three people in frame must stay three');
});

test('NMS honours its cap', () => {
  const many = Array.from({ length: 200 }, (_, i) => ({
    box: [i * 0.004, 0, i * 0.004 + 0.002, 0.01],
    score: 0.5
  }));
  assert.equal(nonMaxSuppression(many, 0.35, 10).length, 10);
});

test('NMS does not mutate its input', () => {
  const input = [
    { box: [0, 0, 1, 1], score: 0.3 },
    { box: [0, 0, 1, 1], score: 0.9 }
  ];
  const snapshot = JSON.stringify(input);
  nonMaxSuppression(input);
  assert.equal(JSON.stringify(input), snapshot);
});

/* -------------------------------------------------------------- decoding */

/** Build a raw model output with one face at a known position. */
function rawOutput(entries, n = 8) {
  const scores = new Float32Array(n * 2);
  const boxes = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) scores[i * 2] = 0.99; // background
  for (const [i, score, box] of entries) {
    scores[i * 2] = 1 - score;
    scores[i * 2 + 1] = score;
    boxes.set(box, i * 4);
  }
  return { scores, boxes };
}

test('reads the face class, not the background class', () => {
  // Index 0 is background. Reading it instead would report every anchor as a
  // near-certain face.
  const { scores, boxes } = rawOutput([[3, 0.95, [0.2, 0.2, 0.5, 0.6]]]);
  const faces = decodeDetections(scores, boxes);
  assert.equal(faces.length, 1);
  assert.ok(Math.abs(faces[0].score - 0.95) < 1e-6);
});

test('applies the score threshold', () => {
  const { scores, boxes } = rawOutput([
    [1, 0.95, [0.1, 0.1, 0.3, 0.4]],
    [2, 0.40, [0.5, 0.1, 0.7, 0.4]]
  ]);
  assert.equal(decodeDetections(scores, boxes, { scoreThreshold: 0.6 }).length, 1);
  assert.equal(decodeDetections(scores, boxes, { scoreThreshold: 0.3 }).length, 2);
});

test('rejects inverted and degenerate boxes', () => {
  const { scores, boxes } = rawOutput([
    [0, 0.9, [0.5, 0.5, 0.2, 0.2]],       // inverted
    [1, 0.9, [0.3, 0.3, 0.3005, 0.9]],    // sliver
    [2, 0.9, [0.1, 0.1, 0.4, 0.5]]        // valid
  ]);
  const faces = decodeDetections(scores, boxes);
  assert.equal(faces.length, 1);
  assert.deepEqual(faces[0].box.map((v) => +v.toFixed(4)), [0.1, 0.1, 0.4, 0.5]);
});

test('clamps boxes that spill outside the frame', () => {
  const { scores, boxes } = rawOutput([[0, 0.9, [-0.2, -0.1, 1.3, 1.2]]]);
  const [f] = decodeDetections(scores, boxes);
  assert.deepEqual(f.box, [0, 0, 1, 1]);
});

test('an empty output yields no faces', () => {
  const { scores, boxes } = rawOutput([]);
  assert.deepEqual(decodeDetections(scores, boxes), []);
});

/* ------------------------------------------------------------- summarise */

test('summarise reports zero for no faces', () => {
  const s = summarise([]);
  assert.equal(s.faceScore, 0);
  assert.equal(s.faceCount, 0);
  assert.equal(s.faceBox, null);
});

test('summarise takes the best confidence and counts every face', () => {
  const s = summarise([
    { box: [0.1, 0.1, 0.3, 0.3], score: 0.7 },
    { box: [0.5, 0.5, 0.9, 0.9], score: 0.93 }
  ]);
  assert.equal(s.faceCount, 2);
  assert.ok(Math.abs(s.faceScore - 0.93) < 1e-9);
  // faceBox is x, y, width, height of the most confident face.
  assert.deepEqual(s.faceBox.map((v) => +v.toFixed(4)), [0.5, 0.5, 0.4, 0.4]);
  assert.ok(Math.abs(s.faceArea - (0.04 + 0.16)) < 1e-9);
});

test('summarise stays inside [0, 1]', () => {
  const s = summarise(Array.from({ length: 40 }, () => ({ box: [0, 0, 1, 1], score: 1 })));
  assert.ok(s.faceScore <= 1 && s.faceArea <= 1);
});

/* -------------------------------------------------------- letterboxing */

const solid = (w, h, rgb) => ({
  data: Uint8ClampedArray.from(
    Array.from({ length: w * h }, () => [rgb[0], rgb[1], rgb[2], 255]).flat()
  ),
  width: w,
  height: h
});

test('the input tensor has the exact shape the model expects', () => {
  const { tensor } = toInputTensor(solid(100, 100, [127, 127, 127]), 320, 240);
  assert.equal(tensor.length, 3 * 320 * 240);
});

test('normalisation maps mid-grey to zero and white to about one', () => {
  const { tensor, pad } = toInputTensor(solid(320, 240, [127, 127, 127]), 320, 240);
  assert.equal(pad.ox, 0);
  assert.equal(pad.oy, 0);
  assert.equal(tensor[0], 0, 'value 127 is the normalisation midpoint');

  const white = toInputTensor(solid(320, 240, [255, 255, 255]), 320, 240).tensor;
  assert.ok(Math.abs(white[0] - 1) < 0.01);
});

test('a square image is letterboxed, not stretched', () => {
  // 4:3 target, 1:1 source: width fills, height is padded top and bottom.
  const { pad } = toInputTensor(solid(200, 200, [10, 20, 30]), 320, 240);
  assert.equal(pad.dw, 240);
  assert.equal(pad.dh, 240);
  assert.equal(pad.oy, 0);
  assert.equal(pad.ox, 40);
});

test('a tall phone photo keeps its proportions', () => {
  const { pad } = toInputTensor(solid(1080, 1920, [10, 20, 30]), 320, 240);
  assert.ok(Math.abs(pad.dw / pad.dh - 1080 / 1920) < 0.02,
    `aspect ${pad.dw}x${pad.dh} drifted from 9:16`);
  assert.ok(pad.dw <= 320 && pad.dh <= 240);
});

test('channels are separated, not interleaved', () => {
  const plane = 320 * 240;
  const { tensor } = toInputTensor(solid(320, 240, [255, 127, 0]), 320, 240);
  assert.ok(Math.abs(tensor[0] - 1) < 0.01, 'red plane');
  assert.ok(Math.abs(tensor[plane]) < 0.01, 'green plane');
  assert.ok(Math.abs(tensor[2 * plane] + 127 / 128) < 0.01, 'blue plane');
});

/* ------------------------------------------------------------ unpadding */

test('unpadding is the identity when nothing was padded', () => {
  const pad = { ox: 0, oy: 0, dw: 320, dh: 240, netW: 320, netH: 240 };
  const [f] = unpadBoxes([{ box: [0.25, 0.5, 0.75, 0.9], score: 0.9 }], pad);
  assert.deepEqual(f.box.map((v) => +v.toFixed(6)), [0.25, 0.5, 0.75, 0.9]);
});

test('unpadding recovers the true position on a padded image', () => {
  // Square source in a 4:3 net: 40px of padding each side, 240px of content.
  const pad = { ox: 40, oy: 0, dw: 240, dh: 240, netW: 320, netH: 240 };
  // A box centred in model space must come back centred in image space.
  const [f] = unpadBoxes([{ box: [(40 + 60) / 320, 0.25, (40 + 180) / 320, 0.75] }], pad);
  assert.ok(Math.abs(f.box[0] - 0.25) < 1e-6, `x1 ${f.box[0]}`);
  assert.ok(Math.abs(f.box[2] - 0.75) < 1e-6, `x2 ${f.box[2]}`);
});

test('a box entirely inside the padding is discarded', () => {
  const pad = { ox: 40, oy: 0, dw: 240, dh: 240, netW: 320, netH: 240 };
  const out = unpadBoxes([{ box: [0, 0.2, 0.05, 0.6], score: 0.9 }], pad);
  assert.equal(out.length, 0, 'padding contains no image, so no face');
});

test('a full-frame detection round-trips through letterbox and back', () => {
  const img = solid(1080, 1920, [200, 150, 120]);
  const { pad } = toInputTensor(img, 320, 240);
  const full = {
    box: [pad.ox / pad.netW, pad.oy / pad.netH,
          (pad.ox + pad.dw) / pad.netW, (pad.oy + pad.dh) / pad.netH],
    score: 0.9
  };
  const [f] = unpadBoxes([full], pad);
  assert.ok(Math.abs(f.box[0]) < 1e-6 && Math.abs(f.box[1]) < 1e-6);
  assert.ok(Math.abs(f.box[2] - 1) < 1e-6 && Math.abs(f.box[3] - 1) < 1e-6);
});

/* --------------------------------------------------- the detector contract */

test('the summary and the box list answer different questions', () => {
  // The main analysis stores a summary; the People pass crops every box. They
  // travel together, and confusing them means finding nobody at all.
  const faces = [
    { box: [0.1, 0.1, 0.2, 0.2], score: 0.9 },
    { box: [0.6, 0.6, 0.8, 0.8], score: 0.99 }
  ];
  const summary = summarise(faces);
  assert.equal(summary.faceCount, 2);
  assert.equal(summary.faceScore, 0.99, 'the summary reports the strongest face');
  assert.equal(summary.faces, undefined,
    'summarise() has no "faces" key — reading one would always yield undefined');
});

test('an empty detection summarises without throwing', () => {
  const summary = summarise([]);
  assert.equal(summary.faceCount, 0);
  assert.equal(summary.faceBox, null);
});
