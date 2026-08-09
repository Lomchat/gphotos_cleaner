import test from 'node:test';
import assert from 'node:assert/strict';

import {
  toGray, resizeGray, laplacianVariance, localSharpnessP95, luminanceStats,
  bimodality, dHash, aHash, hexToPair, hammingPair, colorStats, flatBlockRatio,
  axialEdgeRatio, textLineScore, bandUniformity, screenAspectScore, skinFaceHeuristic
} from '../src/analysis/features.js';

import {
  makeImage, noiseImage, smoothImage, uiImage, documentImage,
  photoImage, flatImage, blur, resizeImage
} from './helpers.js';

test('toGray applies Rec.709 luminance', () => {
  const g = toGray(makeImage(2, 1, () => [255, 255, 255]));
  assert.equal(g[0], 255);
  const black = toGray(makeImage(2, 1, () => [0, 0, 0]));
  assert.equal(black[0], 0);
  // Green weighs more than red, which weighs more than blue.
  const green = toGray(makeImage(1, 1, () => [0, 255, 0]))[0];
  const red = toGray(makeImage(1, 1, () => [255, 0, 0]))[0];
  const blue = toGray(makeImage(1, 1, () => [0, 0, 255]))[0];
  assert.ok(green > red && red > blue, `${green} > ${red} > ${blue}`);
});

test('resizeGray averages blocks correctly', () => {
  // 4x4 checkerboard reduces to one pixel at the exact mean.
  const img = makeImage(4, 4, (x, y) => {
    const v = (x + y) % 2 === 0 ? 0 : 200;
    return [v, v, v];
  });
  const out = resizeGray(toGray(img), 4, 4, 1, 1);
  assert.ok(Math.abs(out[0] - 100) < 2, `got mean ${out[0]}`);
});

test('Laplacian variance separates sharp from blurred', () => {
  const sharp = laplacianVariance(toGray(noiseImage(64, 64)), 64, 64);
  const soft = laplacianVariance(toGray(smoothImage(64, 64)), 64, 64);
  assert.ok(sharp > 1000, `sharp image: ${sharp}`);
  assert.ok(soft < 5, `smooth image: ${soft}`);
  assert.ok(sharp > soft * 100);
});

test('blurring an image collapses the sharpness measure', () => {
  const src = photoImage(64, 64);
  const before = laplacianVariance(toGray(src), 64, 64);
  const after = laplacianVariance(toGray(blur(src, 3)), 64, 64);
  assert.ok(after < before / 4, `before ${before}, after ${after}`);
});

test('localSharpnessP95 spares an image sharp only in places', () => {
  // Left half sharp, right half smooth: the global measure collapses while
  // the local one must stay high. This is the bokeh portrait case.
  const w = 96, h = 96;
  const noise = noiseImage(w, h);
  const mixed = makeImage(w, h, (x, y) => {
    if (x < w / 2) {
      const i = (y * w + x) * 4;
      return [noise.data[i], noise.data[i + 1], noise.data[i + 2]];
    }
    return [128, 128, 128];
  });
  const gray = toGray(mixed);
  const global = laplacianVariance(gray, w, h);
  const local = localSharpnessP95(gray, w, h, 24);
  assert.ok(local > global, `local ${local} should exceed global ${global}`);
});

test('luminanceStats describes a dark image correctly', () => {
  const s = luminanceStats(toGray(flatImage(32, 32, 10)));
  assert.ok(Math.abs(s.mean - 10) < 1);
  assert.equal(s.darkFrac, 1);
  assert.equal(s.brightFrac, 0);
  assert.equal(s.p50, 10);
});

test('luminanceStats describes a bright image correctly', () => {
  const s = luminanceStats(toGray(flatImage(32, 32, 250)));
  assert.equal(s.brightFrac, 1);
  assert.equal(s.darkFrac, 0);
});

test('bimodality separates a document from a continuous scene', () => {
  const twoTone = makeImage(64, 64, (x) => (x < 32 ? [0, 0, 0] : [255, 255, 255]));
  const gradient = makeImage(64, 64, (x) => {
    const v = Math.round((x / 63) * 255);
    return [v, v, v];
  });
  const g1 = toGray(twoTone);
  const g2 = toGray(gradient);
  const b1 = bimodality(luminanceStats(g1).hist, g1.length);
  const b2 = bimodality(luminanceStats(g2).hist, g2.length);
  assert.ok(b1 > 0.9, `bimodal: ${b1}`);
  assert.ok(b2 < b1 / 2, `continuous: ${b2}`);
});

test('dHash is stable and discriminating', () => {
  const a = photoImage(64, 64, 3);
  const b = photoImage(64, 64, 3);
  const c = noiseImage(64, 64, 11);
  const ha = dHash(toGray(a), 64, 64);
  const hb = dHash(toGray(b), 64, 64);
  const hc = dHash(toGray(c), 64, 64);
  assert.equal(ha.length, 16);
  assert.equal(ha, hb, 'same image, same fingerprint');
  assert.equal(hammingPair(hexToPair(ha), hexToPair(hb)), 0);
  assert.ok(hammingPair(hexToPair(ha), hexToPair(hc)) > 12, 'different images, distant fingerprints');
});

test('dHash survives a slight alteration', () => {
  const src = photoImage(80, 80, 5);
  const tweaked = blur(src, 1); // light recompression or resize
  const d = hammingPair(hexToPair(dHash(toGray(src), 80, 80)), hexToPair(dHash(toGray(tweaked), 80, 80)));
  assert.ok(d <= 12, `distance ${d} too large for a near variant`);
});

test('fingerprints stay comparable across source resolutions', () => {
  // Justifies downloading smaller thumbnails: if the fingerprint depended on
  // resolution, a catalogue analysed at two sizes would miss real duplicates.
  // Resampling to 9x8 must absorb the gap, well under the 8-bit threshold.
  for (const seed of [3, 5, 11, 23]) {
    const original = photoImage(512, 512, seed);
    const grand = resizeImage(original, 256, 256);
    const petit = resizeImage(original, 176, 176);

    const dGrand = dHash(toGray(grand), 256, 256);
    const dPetit = dHash(toGray(petit), 176, 176);
    const d = hammingPair(hexToPair(dGrand), hexToPair(dPetit));
    assert.ok(d <= 4, `dHash: ${d} bits apart between 256px and 176px (seed ${seed})`);

    const aGrand = aHash(toGray(grand), 256, 256);
    const aPetit = aHash(toGray(petit), 176, 176);
    const da = hammingPair(hexToPair(aGrand), hexToPair(aPetit));
    assert.ok(da <= 4, `aHash: ${da} bits apart (seed ${seed})`);
  }
});

test('the sharp/blurry ordering survives a resolution change', () => {
  // Laplacian variance is scale-dependent, so its absolute value changes.
  // What must hold is the ORDER, or a threshold tuned on one catalogue would
  // become wrong after a thumbnail size change.
  const net = photoImage(512, 512, 7);
  const flou = blur(net, 4);
  for (const side of [128, 176, 256]) {
    const vSharp = laplacianVariance(toGray(resizeImage(net, side, side)), side, side);
    const vBlur = laplacianVariance(toGray(resizeImage(flou, side, side)), side, side);
    assert.ok(vSharp > vBlur * 2, `at ${side}px: sharp ${vSharp.toFixed(1)} vs blurred ${vBlur.toFixed(1)}`);
  }
});

test('aHash also yields a usable 64-bit fingerprint', () => {
  const img = photoImage(64, 64, 9);
  const h = aHash(toGray(img), 64, 64);
  assert.equal(h.length, 16);
  assert.equal(hammingPair(hexToPair(h), hexToPair(h)), 0);
});

test('hammingPair counts differing bits', () => {
  assert.equal(hammingPair([0, 0], [0, 0]), 0);
  assert.equal(hammingPair([0, 1], [0, 0]), 1);
  assert.equal(hammingPair([0xffffffff, 0xffffffff], [0, 0]), 64);
});

test('flatBlockRatio is 1 on a flat fill and ~0 on noise', () => {
  assert.equal(flatBlockRatio(toGray(flatImage(64, 64)), 64, 64), 1);
  assert.ok(flatBlockRatio(toGray(noiseImage(64, 64)), 64, 64) < 0.05);
});

test('axialEdgeRatio is higher on a UI than on a photo', () => {
  const ui = axialEdgeRatio(toGray(uiImage(120, 200)), 120, 200);
  const photo = axialEdgeRatio(toGray(photoImage(120, 200)), 120, 200);
  assert.ok(ui > photo, `ui ${ui} should exceed photo ${photo}`);
  assert.ok(ui > 0.8, `ui ${ui}`);
});

test('colorStats measures palette richness', () => {
  const ui = colorStats(uiImage(120, 200));
  const photo = colorStats(photoImage(120, 200));
  assert.ok(ui.paletteFrac < photo.paletteFrac, `ui ${ui.paletteFrac} vs photo ${photo.paletteFrac}`);
  const gray = colorStats(flatImage(32, 32));
  assert.equal(gray.satMean, 0);
  assert.equal(gray.grayFrac, 1);
});

test('textLineScore responds to text lines', () => {
  const doc = textLineScore(toGray(documentImage(120, 160)), 120, 160);
  const flat = textLineScore(toGray(flatImage(120, 160)), 120, 160);
  assert.ok(doc > 0.3, `document ${doc}`);
  assert.equal(flat, 0);
});

test('bandUniformity detects a uniform status bar', () => {
  const img = uiImage(120, 200);
  const gray = toGray(img);
  const top = bandUniformity(gray, 120, 200, 0, 0.04);
  const middle = bandUniformity(gray, 120, 200, 0.4, 0.6);
  assert.ok(top > 0.95, `status bar ${top}`);
  assert.ok(top >= middle);
});

test('screenAspectScore recognises screen formats', () => {
  assert.ok(screenAspectScore(1080, 1920) > 0.9, 'portrait 9:16');
  assert.ok(screenAspectScore(1920, 1080) > 0.9, 'landscape 16:9');
  assert.ok(screenAspectScore(1179, 2556) > 0.5, 'modern iPhone');
  assert.equal(screenAspectScore(0, 100), 0);
});

test('screenAspectScore does not catch native camera formats', () => {
  // These ratios must stay neutral, or nearly every photo would gain
  // "screenshot" points.
  assert.equal(screenAspectScore(4000, 3000), 0, '4:3 phone sensor');
  assert.equal(screenAspectScore(6000, 4000), 0, '3:2 DSLR');
  assert.equal(screenAspectScore(3000, 4000), 0, '3:4 phone portrait');
  assert.equal(screenAspectScore(4000, 6000), 0, '2:3 DSLR portrait');
});

test('skinFaceHeuristic ignores an image with no skin tone', () => {
  const r = skinFaceHeuristic(makeImage(64, 64, () => [30, 90, 200]));
  assert.equal(r.faceScore, 0);
  assert.ok(r.skinFrac < 0.01);
});

test('skinFaceHeuristic responds to a compact skin region with dark features', () => {
  const w = 96, h = 96;
  const cx = 48, cy = 46, rx = 20, ry = 26;
  const img = makeImage(w, h, (x, y) => {
    const inside = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    if (!inside) return [40, 80, 60];               // vegetation background
    // Eyes and mouth: markedly darker than skin.
    const eye = (Math.abs(x - (cx - 8)) < 4 || Math.abs(x - (cx + 8)) < 4) && Math.abs(y - (cy - 6)) < 3;
    const mouth = Math.abs(x - cx) < 8 && Math.abs(y - (cy + 14)) < 2;
    if (eye || mouth) return [45, 30, 28];
    return [222, 172, 142];                         // skin tone
  });
  const r = skinFaceHeuristic(img);
  assert.ok(r.skinFrac > 0.1, `skin fraction ${r.skinFrac}`);
  assert.ok(r.faceScore > 0.5, `face score ${r.faceScore}`);
  assert.ok(r.faceBox, 'a bounding box must be returned');
  const [bx, by, bw, bh] = r.faceBox;
  assert.ok(bw > 0.2 && bh > 0.2, `box ${bw}x${bh}`);
  assert.ok(bx >= 0 && by >= 0 && bx + bw <= 1.01 && by + bh <= 1.01);
});

test('skinFaceHeuristic rejects a skin band with impossible proportions', () => {
  // Very elongated band: plausible colour, impossible face geometry.
  const img = makeImage(96, 96, (x, y) => (y > 40 && y < 48 ? [222, 172, 142] : [20, 20, 20]));
  const r = skinFaceHeuristic(img);
  assert.ok(r.faceScore < 0.5, `score ${r.faceScore} should stay low`);
});
