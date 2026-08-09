/**
 * UltraFace RFB-320 output decoding.
 *
 * The model does the hard part itself: `boxes` already contains decoded corners
 * normalised to [0, 1], and `scores` is post-softmax. No prior-box generation,
 * no variance decoding — which is exactly why this model was chosen over YuNet,
 * whose twelve raw outputs must be decoded by hand and cannot be tested without
 * ground truth.
 *
 * What remains is thresholding and non-maximum suppression. Both are pure, so
 * they are unit-tested rather than trusted.
 */

/** Intersection over union of two [x1, y1, x2, y2] boxes. */
export function iou(a, b) {
  const x1 = Math.max(a[0], b[0]);
  const y1 = Math.max(a[1], b[1]);
  const x2 = Math.min(a[2], b[2]);
  const y2 = Math.min(a[3], b[3]);
  const w = x2 - x1;
  const h = y2 - y1;
  if (w <= 0 || h <= 0) return 0;
  const inter = w * h;
  const areaA = Math.max(0, a[2] - a[0]) * Math.max(0, a[3] - a[1]);
  const areaB = Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);
  const union = areaA + areaB - inter;
  return union <= 0 ? 0 : inter / union;
}

/**
 * Greedy non-maximum suppression, highest score first.
 * @param {Array<{box:number[], score:number}>} candidates
 * @param {number} iouThreshold
 * @param {number} limit hard cap on kept boxes
 */
export function nonMaxSuppression(candidates, iouThreshold = 0.35, limit = 64) {
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const kept = [];
  for (const c of sorted) {
    if (kept.length >= limit) break;
    let overlaps = false;
    for (const k of kept) {
      if (iou(c.box, k.box) > iouThreshold) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) kept.push(c);
  }
  return kept;
}

/**
 * Turn raw model output into a list of faces.
 *
 * @param {Float32Array|number[]} scores flat [N*2], probability per class
 * @param {Float32Array|number[]} boxes  flat [N*4], normalised x1,y1,x2,y2
 * @param {object} opts
 * @returns {Array<{box:number[], score:number}>} boxes clamped to [0, 1]
 */
export function decodeDetections(scores, boxes, opts = {}) {
  const { scoreThreshold = 0.6, iouThreshold = 0.35, limit = 64, minSide = 0.012 } = opts;
  const n = Math.min(scores.length >> 1, boxes.length >> 2);
  const candidates = [];

  for (let i = 0; i < n; i++) {
    const score = scores[i * 2 + 1]; // index 0 is background
    if (score < scoreThreshold) continue;

    const x1 = clamp01(boxes[i * 4]);
    const y1 = clamp01(boxes[i * 4 + 1]);
    const x2 = clamp01(boxes[i * 4 + 2]);
    const y2 = clamp01(boxes[i * 4 + 3]);
    if (x2 <= x1 || y2 <= y1) continue;
    // Degenerate slivers are model noise, never faces.
    if (x2 - x1 < minSide || y2 - y1 < minSide) continue;

    candidates.push({ box: [x1, y1, x2, y2], score });
  }

  return nonMaxSuppression(candidates, iouThreshold, limit);
}

function clamp01(v) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Summarise detections into the fields the rest of the pipeline consumes.
 *
 * `faceScore` stays on the same [0, 1] scale as the heuristic it replaces, so
 * saved thresholds keep their meaning. It is the best detection confidence:
 * one confident face is enough to call a photo "has people".
 */
export function summarise(faces) {
  if (!faces.length) {
    return { faceScore: 0, faceCount: 0, faceBox: null, faceArea: 0 };
  }
  let best = faces[0];
  let area = 0;
  for (const f of faces) {
    if (f.score > best.score) best = f;
    area += (f.box[2] - f.box[0]) * (f.box[3] - f.box[1]);
  }
  return {
    faceScore: Math.min(1, best.score),
    faceCount: faces.length,
    faceBox: [best.box[0], best.box[1], best.box[2] - best.box[0], best.box[3] - best.box[1]],
    faceArea: Math.min(1, area)
  };
}

/**
 * Letterbox an RGBA image into the model's NCHW input tensor.
 *
 * Letterboxing rather than stretching: UltraFace is trained on 4:3, and
 * squashing a 9:16 phone photo into it distorts faces enough to lose them.
 * The padding offsets are returned so boxes can be mapped back to the original
 * frame.
 *
 * @param {{data:Uint8ClampedArray, width:number, height:number}} img
 * @param {number} netW
 * @param {number} netH
 */
export function toInputTensor(img, netW = 320, netH = 240) {
  const { data, width: w, height: h } = img;
  const scale = Math.min(netW / w, netH / h);
  const dw = Math.max(1, Math.round(w * scale));
  const dh = Math.max(1, Math.round(h * scale));
  const ox = Math.floor((netW - dw) / 2);
  const oy = Math.floor((netH - dh) / 2);

  const plane = netW * netH;
  const out = new Float32Array(3 * plane);
  // UltraFace normalisation: (pixel - 127) / 128.
  out.fill(0); // padding sits at the mean, i.e. neutral grey

  for (let y = 0; y < dh; y++) {
    const sy = Math.min(h - 1, Math.floor(y / scale));
    const rowOut = (y + oy) * netW + ox;
    const rowIn = sy * w;
    for (let x = 0; x < dw; x++) {
      const sx = Math.min(w - 1, Math.floor(x / scale));
      const i = (rowIn + sx) * 4;
      const o = rowOut + x;
      out[o] = (data[i] - 127) / 128;
      out[plane + o] = (data[i + 1] - 127) / 128;
      out[2 * plane + o] = (data[i + 2] - 127) / 128;
    }
  }

  return { tensor: out, pad: { ox, oy, dw, dh, netW, netH } };
}

/**
 * Map boxes from letterboxed model space back to the original frame, still
 * normalised to [0, 1]. Without this, every box on a non-4:3 photo is offset by
 * the padding — a silent, systematic error.
 */
export function unpadBoxes(faces, pad) {
  const { ox, oy, dw, dh, netW, netH } = pad;
  return faces
    .map((f) => {
      const [x1, y1, x2, y2] = f.box;
      const nx1 = (x1 * netW - ox) / dw;
      const ny1 = (y1 * netH - oy) / dh;
      const nx2 = (x2 * netW - ox) / dw;
      const ny2 = (y2 * netH - oy) / dh;
      return {
        score: f.score,
        box: [clamp01(nx1), clamp01(ny1), clamp01(nx2), clamp01(ny2)]
      };
    })
    .filter((f) => f.box[2] > f.box[0] && f.box[3] > f.box[1]);
}
