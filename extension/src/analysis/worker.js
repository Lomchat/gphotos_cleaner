/**
 * Analysis worker: downloads a thumbnail, decodes it and extracts a feature
 * vector. A pool of these runs inside the extension's offscreen document, off
 * the photos.google.com thread.
 */

import {
  clamp01, toGray, laplacianVariance, localSharpnessP95, luminanceStats,
  bimodality, dHash, aHash, colorStats, flatBlockRatio, axialEdgeRatio,
  textLineScore, bandUniformity, skinFaceHeuristic, screenAspectScore
} from './features.js';
import { toInputTensor } from './face-postprocess.js';

// Caps, not targets: `draw` only shrinks. Upscaling a smaller thumbnail would
// cost time without adding detail, and would skew sharpness through
// interpolation.
const ANALYSIS_SIDE = 224; // max side for structural analysis
// 160px rather than 128: in a group photo a face spans 6% of the side, i.e.
// 8px at 128 — below any shape analysis. The extra cost is ~0.3ms per image,
// negligible next to the download.
const FACE_SIDE = 160; // max side for the fallback heuristic
// The detector letterboxes into 320x240, so drawing larger than that only
// wastes time. Measured on a real group photo: 7 of 7 faces found at every
// size from 176px up, so no need to fetch bigger thumbnails for people.
const DETECT_SIDE = 320;
const NET_W = 320;
const NET_H = 240;

/** `FaceDetector` only exists behind a Chrome flag; probe once. */
let faceDetector;
function getFaceDetector() {
  if (faceDetector !== undefined) return faceDetector;
  try {
    faceDetector = typeof FaceDetector !== 'undefined'
      ? new FaceDetector({ fastMode: true, maxDetectedFaces: 8 })
      : null;
  } catch {
    faceDetector = null;
  }
  return faceDetector;
}

/**
 * Face detection lives in the offscreen document, on one shared session.
 * This is the worker side of that call: post the tensor, await the answer.
 */
const rpcWaiting = new Map();
let rpcSeq = 0;

function requestDetection(tensor, pad, scoreThreshold) {
  return new Promise((resolve) => {
    const rpcId = `d${++rpcSeq}`;
    rpcWaiting.set(rpcId, resolve);
    // The buffer is transferred, not copied: 900KB per image would otherwise be
    // cloned on every photo.
    self.postMessage({ type: 'detect', rpcId, tensor, pad, scoreThreshold }, [tensor.buffer]);
  });
}

self.onmessage = async (ev) => {
  const msg = ev.data || {};

  if (msg.type === 'detect-result') {
    const resolve = rpcWaiting.get(msg.rpcId);
    if (resolve) {
      rpcWaiting.delete(msg.rpcId);
      resolve(msg.error ? null : msg.result);
    }
    return;
  }

  const { jobId, item } = msg;
  if (!jobId) return;
  try {
    const features = await analyse(item);
    self.postMessage({ jobId, ok: true, features });
  } catch (err) {
    self.postMessage({ jobId, ok: false, error: String((err && err.message) || err) });
  }
};

async function fetchOne(url) {
  // Google thumbnails carry a token in the URL, so usually no cookie is needed.
  // Some accounts still require the session, hence the retry with credentials.
  let res = await fetch(url, { credentials: 'omit', cache: 'force-cache' });
  if (!res.ok && (res.status === 401 || res.status === 403)) {
    res = await fetch(url, { credentials: 'include', cache: 'no-store' });
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${hostOf(url)}`);
  const blob = await res.blob();
  if (!blob.size) throw new Error('Empty thumbnail');
  return createImageBitmap(blob);
}

function hostOf(url) {
  try { return new URL(url).hostname; } catch { return 'unknown host'; }
}

/**
 * Fetch the thumbnail, falling back to the untouched URL.
 *
 * Rewriting the size suffix (`=w176-h176`) follows Google's image grammar, but
 * not every host honours it identically. Rather than lose the item, fall back
 * to the exact URL found in the page — necessarily valid, since the browser is
 * already displaying it.
 */
async function fetchBitmap(item) {
  try {
    return await fetchOne(item.url);
  } catch (err) {
    if (!item.urlRaw || item.urlRaw === item.url) throw err;
    try {
      return await fetchOne(item.urlRaw);
    } catch {
      throw err; // the original error is the more informative one
    }
  }
}

function draw(bitmap, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(8, Math.round(bitmap.width * scale));
  const h = Math.max(8, Math.round(bitmap.height * scale));
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

/**
 * Per-phase timing, so "the analysis is slow" can be answered rather than
 * guessed at. The four phases respond to completely different fixes — a bigger
 * fetch pool, a smaller rendition, cheaper maths, more detection workers — and
 * a single total says nothing about which.
 */
function stopwatch() {
  let mark = performance.now();
  const spent = { fetch: 0, decode: 0, features: 0, detect: 0 };
  return {
    spent,
    lap(phase) {
      const now = performance.now();
      spent[phase] += now - mark;
      mark = now;
    }
  };
}

async function analyse(item) {
  const clock = stopwatch();
  const bitmap = await fetchBitmap(item);
  clock.lap('fetch');
  const natW = bitmap.width;
  const natH = bitmap.height;

  const img = draw(bitmap, ANALYSIS_SIDE);
  clock.lap('decode');
  const { width: w, height: h } = img;
  const gray = toGray(img);

  const lum = luminanceStats(gray);
  const color = colorStats(img);
  const lapVar = laplacianVariance(gray, w, h);
  const localSharp = localSharpnessP95(gray, w, h);
  const flat = flatBlockRatio(gray, w, h);
  const axial = axialEdgeRatio(gray, w, h);
  const text = textLineScore(gray, w, h);
  const topBar = bandUniformity(gray, w, h, 0, 0.045);
  const bottomBar = bandUniformity(gray, w, h, 0.955, 1);
  const bimodal = bimodality(lum.hist, gray.length);
  const aspectScore = screenAspectScore(natW, natH);

  /* ---- people -------------------------------------------------------- */
  //
  // Three tiers, best first. The trained model is the only one that actually
  // works; the other two exist so the extension still functions when
  // WebAssembly is blocked or the vendored model is missing.
  let faceScore = 0;
  let faceCount = 0;
  let faceArea = 0;
  let faceBox = null;
  let faceMethod = null;
  let skinFrac = 0;

  clock.lap('features');

  // `draw` never upscales, so when the thumbnail is smaller than both caps the
  // two draws produce byte-identical pixels. At the default 176px that is every
  // photo: a second canvas, a second drawImage and a second getImageData, for
  // an image we already have.
  const detW = Math.max(natW, natH) <= Math.min(ANALYSIS_SIDE, DETECT_SIDE)
    ? img
    : draw(bitmap, DETECT_SIDE);
  const prepared = toInputTensor(detW, NET_W, NET_H);
  const detected = await requestDetection(prepared.tensor, prepared.pad, 0.6);
  clock.lap('detect');
  if (detected) {
    faceScore = detected.faceScore;
    faceCount = detected.faceCount;
    faceArea = detected.faceArea;
    faceBox = detected.faceBox;
    faceMethod = 'ultraface';
  }

  if (!faceMethod) {
    const native = getFaceDetector();
    if (native) {
      try {
        const faces = await native.detect(await createImageBitmap(img));
        faceCount = faces.length;
        faceScore = faces.length ? 1 : 0;
        faceMethod = 'FaceDetector';
      } catch { /* fall through to the heuristic */ }
    }
  }

  if (!faceMethod) {
    const small = draw(bitmap, FACE_SIDE);
    const r = skinFaceHeuristic(small);
    faceScore = r.faceScore;
    skinFrac = r.skinFrac;
    faceBox = r.faceBox;
    faceCount = r.faceScore >= 0.5 ? 1 : 0;
    faceMethod = 'heuristic';
  }
  bitmap.close();

  /* ---- composed scores ------------------------------------------------ */

  // Blur: take the better of the two measures, sparing shallow-depth-of-field
  // photos where only the subject is sharp.
  const sharp = Math.max(lapVar, localSharp * 0.75);
  // A very dark image mechanically has little gradient, so normalise sharpness
  // by the contrast actually available.
  const contrastFactor = Math.max(0.35, Math.min(1, lum.sd / 45));
  const blurScore = clamp01(1 / (1 + sharp / (110 * contrastFactor)));

  const darkScore = clamp01(
    clamp01((95 - lum.mean) / 95) * 0.5 +
    clamp01(lum.darkFrac * 1.4) * 0.3 +
    clamp01((70 - lum.p95) / 70) * 0.2
  );

  const brightScore = clamp01(
    clamp01((lum.mean - 195) / 60) * 0.6 + clamp01((lum.brightFrac - 0.4) / 0.5) * 0.4
  );

  // Screenshot: orthogonal geometry, flat areas, small palette, screen aspect
  // ratio, uniform status bar.
  const screenshotScore = clamp01(
    clamp01((axial - 0.42) / 0.35) * 0.3 +
    clamp01((flat - 0.15) / 0.45) * 0.25 +
    clamp01((0.11 - color.paletteFrac) / 0.1) * 0.15 +
    aspectScore * 0.15 +
    clamp01(Math.max(topBar, bottomBar) - 0.55) * 0.15
  );

  // Document: light desaturated background, bimodal histogram, text lines.
  const documentScore = clamp01(
    clamp01((lum.mean - 130) / 90) * 0.2 +
    clamp01((0.18 - color.satMean) / 0.18) * 0.2 +
    bimodal * 0.2 +
    text * 0.3 +
    clamp01((axial - 0.4) / 0.4) * 0.1
  );

  return {
    v: 1,
    // Side actually analysed: sharpness is scale-dependent, and this trace
    // reveals a catalogue built at mixed sizes.
    srcSide: Math.max(w, h),
    natW,
    natH,
    aspect: natH ? natW / natH : 0,
    lapVar: round(lapVar),
    localSharp: round(localSharp),
    lumMean: round(lum.mean, 2),
    lumSd: round(lum.sd, 2),
    lumP05: lum.p05,
    lumP50: lum.p50,
    lumP95: lum.p95,
    darkFrac: round(lum.darkFrac, 4),
    brightFrac: round(lum.brightFrac, 4),
    satMean: round(color.satMean, 4),
    grayFrac: round(color.grayFrac, 4),
    paletteFrac: round(color.paletteFrac, 4),
    flatRatio: round(flat, 4),
    axialRatio: round(axial, 4),
    textScore: round(text, 4),
    bimodality: round(bimodal, 4),
    topBar: round(topBar, 3),
    bottomBar: round(bottomBar, 3),
    aspectScore: round(aspectScore, 3),
    dhash: dHash(gray, w, h),
    ahash: aHash(gray, w, h),
    faceScore: round(faceScore, 3),
    faceCount,
    faceArea: round(faceArea, 4),
    faceBox: faceBox ? faceBox.map((v) => round(v, 4)) : null,
    faceMethod,
    skinFrac: round(skinFrac, 4),
    blurScore: round(blurScore, 3),
    darkScore: round(darkScore, 3),
    brightScore: round(brightScore, 3),
    screenshotScore: round(screenshotScore, 3),
    documentScore: round(documentScore, 3),
    // Not persisted with the item: the caller strips it after aggregating.
    _spent: clock.spent
  };
}

function round(v, digits = 1) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
