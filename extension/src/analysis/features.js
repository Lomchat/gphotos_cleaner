/**
 * Computer-vision primitives. No dependencies, no external model.
 *
 * Every function is pure and works on already-decoded buffers, so they chain
 * inside a worker with no meaningful overhead.
 *
 * Convention: *scores* are in [0, 1], 1 meaning "strongly present". Raw
 * *measurements* (Laplacian variance, etc.) are kept as-is so the user can
 * threshold them.
 */

export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Rec.709 luminance. */
export function toGray(img) {
  const { data, width: w, height: h } = img;
  const g = new Uint8ClampedArray(w * h);
  for (let p = 0, i = 0; p < g.length; p++, i += 4) {
    // Round, don't truncate: coefficients sum to 1 within float error, and
    // truncating shifts the whole scale one level darker, skewing darkness
    // thresholds and capping white at 254.
    g[p] = (data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722 + 0.5) | 0;
  }
  return g;
}

/** Box-average resize (anti-aliased, suited to downsampling). */
export function resizeGray(src, w, h, nw, nh) {
  const out = new Float32Array(nw * nh);
  const xr = w / nw;
  const yr = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(h - 1, Math.floor(y * yr));
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * yr)));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, Math.floor(x * xr));
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * xr)));
      let s = 0;
      let n = 0;
      for (let yy = y0; yy < y1; yy++) {
        const row = yy * w;
        for (let xx = x0; xx < x1; xx++) {
          s += src[row + xx];
          n++;
        }
      }
      out[y * nw + x] = n ? s / n : 0;
    }
  }
  return out;
}

/* ---------------------------------------------------------------- sharpness */

/**
 * Laplacian variance, the reference sharpness measure. A blurred image
 * concentrates energy in low frequencies, so the Laplacian response collapses.
 */
export function laplacianVariance(gray, w, h) {
  if (w < 3 || h < 3) return 0;
  let sum = 0;
  let sum2 = 0;
  let n = 0;
  for (let y = 1; y < h - 1; y++) {
    const r = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = r + x;
      const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
      sum += v;
      sum2 += v * v;
      n++;
    }
  }
  if (!n) return 0;
  const mean = sum / n;
  return Math.max(0, sum2 / n - mean * mean);
}

/**
 * Best local sharpness. Global Laplacian variance unfairly punishes shallow
 * depth of field (a portrait with bokeh), so we also take a high local
 * quantile, which stays high when *some* area is sharp.
 */
export function localSharpnessP95(gray, w, h, block = 24) {
  const scores = [];
  for (let by = 0; by + block <= h; by += block) {
    for (let bx = 0; bx + block <= w; bx += block) {
      let sum = 0;
      let sum2 = 0;
      let n = 0;
      for (let y = by + 1; y < by + block - 1; y++) {
        const r = y * w;
        for (let x = bx + 1; x < bx + block - 1; x++) {
          const i = r + x;
          const v = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
          sum += v;
          sum2 += v * v;
          n++;
        }
      }
      if (n) scores.push(Math.max(0, sum2 / n - (sum / n) ** 2));
    }
  }
  if (!scores.length) return laplacianVariance(gray, w, h);
  scores.sort((a, b) => a - b);
  return scores[Math.min(scores.length - 1, Math.floor(scores.length * 0.95))];
}

/* -------------------------------------------------------------- brightness */

export function luminanceStats(gray) {
  const hist = new Uint32Array(256);
  let sum = 0;
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i];
    hist[v]++;
    sum += v;
  }
  const n = gray.length;
  const mean = sum / n;
  let sd = 0;
  for (let i = 0; i < 256; i++) sd += hist[i] * (i - mean) ** 2;
  sd = Math.sqrt(sd / n);

  const q = (p) => {
    const target = p * n;
    let acc = 0;
    for (let i = 0; i < 256; i++) {
      acc += hist[i];
      if (acc >= target) return i;
    }
    return 255;
  };

  let dark = 0;
  for (let i = 0; i < 40; i++) dark += hist[i];
  let bright = 0;
  for (let i = 220; i < 256; i++) bright += hist[i];

  return {
    mean,
    sd,
    p05: q(0.05),
    p50: q(0.5),
    p95: q(0.95),
    darkFrac: dark / n,
    brightFrac: bright / n,
    hist
  };
}

/**
 * Bimodality (normalised Otsu criterion): high for ink-on-paper documents, low
 * for a continuous natural scene.
 */
export function bimodality(hist, n) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += i * hist[i];
  let sumB = 0;
  let wB = 0;
  let best = 0;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (total - sumB) / wF;
    const between = (wB / n) * (wF / n) * (mB - mF) ** 2;
    if (between > best) best = between;
  }
  // Normalised by the theoretical maximum variance (128²).
  return clamp01(best / (128 * 128));
}

/* -------------------------------------------------------- perceptual hashes */

/** 64-bit dHash (horizontal gradient on a 9x8 grid) as 16 hex chars. */
export function dHash(gray, w, h) {
  const s = resizeGray(gray, w, h, 9, 8);
  const bits = new Uint8Array(64);
  let k = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits[k++] = s[y * 9 + x] > s[y * 9 + x + 1] ? 1 : 0;
    }
  }
  return bitsToHex(bits);
}

/** 64-bit aHash (mean threshold) as 16 hex chars. */
export function aHash(gray, w, h) {
  const s = resizeGray(gray, w, h, 8, 8);
  let m = 0;
  for (let i = 0; i < 64; i++) m += s[i];
  m /= 64;
  const bits = new Uint8Array(64);
  for (let i = 0; i < 64; i++) bits[i] = s[i] > m ? 1 : 0;
  return bitsToHex(bits);
}

function bitsToHex(bits) {
  let out = '';
  for (let i = 0; i < 64; i += 4) {
    const v = (bits[i] << 3) | (bits[i + 1] << 2) | (bits[i + 2] << 1) | bits[i + 3];
    out += v.toString(16);
  }
  return out;
}

const POP = new Uint8Array(256);
for (let i = 0; i < 256; i++) POP[i] = (i & 1) + POP[i >> 1];

/** Split a 64-bit hex hash into two 32-bit integers. */
export function hexToPair(hex) {
  if (!hex || hex.length !== 16) return null;
  return [parseInt(hex.slice(0, 8), 16) >>> 0, parseInt(hex.slice(8), 16) >>> 0];
}

export function hammingPair(a, b) {
  if (!a || !b) return 64;
  let d = 0;
  let x = (a[0] ^ b[0]) >>> 0;
  d += POP[x & 255] + POP[(x >>> 8) & 255] + POP[(x >>> 16) & 255] + POP[(x >>> 24) & 255];
  x = (a[1] ^ b[1]) >>> 0;
  d += POP[x & 255] + POP[(x >>> 8) & 255] + POP[(x >>> 16) & 255] + POP[(x >>> 24) & 255];
  return d;
}

/* ------------------------------------------------------------------- colour */

export function colorStats(img) {
  const { data } = img;
  const n = data.length / 4;
  let satSum = 0;
  let satHigh = 0;
  let grayish = 0;
  // Palette quantised to 4 bits per channel, so 4096 bins.
  const bins = new Uint32Array(4096);
  for (let i = 0; i < data.length; i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
    const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
    const s = mx === 0 ? 0 : (mx - mn) / mx;
    satSum += s;
    if (s > 0.35) satHigh++;
    if (mx - mn < 18) grayish++;
    bins[((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4)]++;
  }
  let used = 0;
  const floor = Math.max(1, n * 0.0004);
  for (let i = 0; i < 4096; i++) if (bins[i] >= floor) used++;
  return {
    satMean: satSum / n,
    satHighFrac: satHigh / n,
    grayFrac: grayish / n,
    paletteUsed: used,
    paletteFrac: used / 4096
  };
}

/* -------------------------------------------------------------- structure */

/**
 * Fraction of near-uniform 8x8 blocks. Screenshots and documents contain large
 * flat areas (UI backgrounds, margins).
 */
export function flatBlockRatio(gray, w, h, block = 8, varThreshold = 12) {
  let flat = 0;
  let total = 0;
  for (let by = 0; by + block <= h; by += block) {
    for (let bx = 0; bx + block <= w; bx += block) {
      let s = 0;
      let s2 = 0;
      for (let y = by; y < by + block; y++) {
        const r = y * w;
        for (let x = bx; x < bx + block; x++) {
          const v = gray[r + x];
          s += v;
          s2 += v * v;
        }
      }
      const nn = block * block;
      const varr = s2 / nn - (s / nn) ** 2;
      if (varr < varThreshold) flat++;
      total++;
    }
  }
  return total ? flat / total : 0;
}

/**
 * Share of gradient energy aligned to the axes. Software interfaces are made of
 * rectangles, so their edges are strictly horizontal or vertical, which nature
 * produces only marginally.
 */
export function axialEdgeRatio(gray, w, h) {
  if (w < 3 || h < 3) return 0;
  let axial = 0;
  let total = 0;
  const TOL = Math.tan((12 * Math.PI) / 180);
  for (let y = 1; y < h - 1; y++) {
    const r = y * w;
    for (let x = 1; x < w - 1; x++) {
      const i = r + x;
      const gx =
        -gray[i - w - 1] - 2 * gray[i - 1] - gray[i + w - 1] +
        gray[i - w + 1] + 2 * gray[i + 1] + gray[i + w + 1];
      const gy =
        -gray[i - w - 1] - 2 * gray[i - w] - gray[i - w + 1] +
        gray[i + w - 1] + 2 * gray[i + w] + gray[i + w + 1];
      const mag = Math.abs(gx) + Math.abs(gy);
      if (mag < 40) continue;
      total += mag;
      const ax = Math.abs(gx);
      const ay = Math.abs(gy);
      if (ay <= ax * TOL || ax <= ay * TOL) axial += mag;
    }
  }
  return total ? axial / total : 0;
}

/**
 * Detect text lines: count light/dark alternations along each pixel row. Text
 * produces many, regularly, alternating with empty leading.
 */
export function textLineScore(gray, w, h) {
  if (w < 16 || h < 16) return 0;
  const rowScore = new Float32Array(h);
  for (let y = 0; y < h; y++) {
    const r = y * w;
    let trans = 0;
    let prev = gray[r] > 128;
    for (let x = 1; x < w; x++) {
      const cur = gray[r + x] > 128;
      if (cur !== prev && Math.abs(gray[r + x] - gray[r + x - 1]) > 30) trans++;
      prev = cur;
    }
    rowScore[y] = trans / w;
  }
  // A "text" row shows a notable transition density.
  let texty = 0;
  for (let y = 0; y < h; y++) if (rowScore[y] > 0.06) texty++;
  const textyFrac = texty / h;

  // Text/leading alternation: count contiguous runs.
  let runs = 0;
  let inRun = false;
  for (let y = 0; y < h; y++) {
    const on = rowScore[y] > 0.06;
    if (on && !inRun) runs++;
    inRun = on;
  }
  const runFrac = Math.min(1, runs / Math.max(4, h / 10));
  return clamp01(textyFrac * 0.6 + runFrac * 0.4);
}

/**
 * Uniformity of a horizontal band (status bar / navigation bar).
 * @param {number} from start, as a fraction of height
 * @param {number} to   end, as a fraction of height
 */
export function bandUniformity(gray, w, h, from, to) {
  const y0 = Math.max(0, Math.floor(h * from));
  const y1 = Math.min(h, Math.ceil(h * to));
  if (y1 - y0 < 1) return 0;
  let s = 0;
  let s2 = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    const r = y * w;
    for (let x = 0; x < w; x++) {
      const v = gray[r + x];
      s += v;
      s2 += v * v;
      n++;
    }
  }
  const varr = s2 / n - (s / n) ** 2;
  return clamp01(1 - varr / 400);
}

/* ---------------------------------------------- human presence (heuristic) */

/**
 * Grey-world balance gains.
 *
 * Tungsten light, shade or fluorescent lighting casts a tint that pushes skin
 * outside any fixed range — a leading cause of missed faces. Gains are clamped:
 * on a strongly coloured image (grass, sea, sunset) a full correction would
 * manufacture fake skin.
 */
function greyWorldGains(data, n) {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  for (let i = 0; i < data.length; i += 4) {
    sr += data[i];
    sg += data[i + 1];
    sb += data[i + 2];
  }
  const mr = sr / n;
  const mg = sg / n;
  const mb = sb / n;
  const grey = (mr + mg + mb) / 3;
  const bound = (v) => (v < 0.75 ? 0.75 : v > 1.35 ? 1.35 : v);
  return {
    r: bound(mr > 1 ? grey / mr : 1),
    g: bound(mg > 1 ? grey / mg : 1),
    b: bound(mb > 1 ? grey / mb : 1)
  };
}

/**
 * Skin-tone membership. Union of two rules, not intersection: requiring both
 * rejected dark skin, backlit faces and anything with a colour cast. Precision
 * gained, recall collapsed.
 */
function isSkinPixel(r, g, b) {
  // A grey or near-white pixel is never skin. Without this floor a light
  // screenshot reads as 75% skin: the normalised components of a slightly warm
  // white land squarely inside the range.
  const mx = r > g ? (r > b ? r : b) : g > b ? g : b;
  const mn = r < g ? (r < b ? r : b) : g < b ? g : b;
  if (mx - mn < 15) return false;
  // Skin is redder than green at every complexion.
  if (r - g < 8 || r <= b) return false;

  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  // Chrominance range, widened downwards for dark skin and shadow.
  if (y > 32 && cb >= 74 && cb <= 138 && cr >= 130 && cr <= 182) return true;

  // Normalised-component rule: independent of brightness, so it tolerates
  // underexposure.
  const sum = r + g + b;
  if (sum < 60) return false;
  const nr = r / sum;
  const ng = g / sum;
  return nr >= 0.33 && nr <= 0.52 && ng >= 0.24 && ng <= 0.365;
}

/**
 * Estimate whether a person is present. This is NOT a trained face detector,
 * and the criterion is named accordingly throughout the UI.
 *
 * Two signals combine: the **geometry** of a skin region (compact oval, dark
 * internal features), and the **skin area**, which alone makes a person likely
 * when geometry fails — profile, three-quarter, partly occluded, or merged with
 * neck and arms.
 *
 * Tuning deliberately favours **recall**. The two errors do not cost the same:
 * wrongly seeing someone merely protects a photo, while missing a person puts
 * their photo on a list headed for the bin.
 */
export function skinFaceHeuristic(img) {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const gains = greyWorldGains(data, n);
  const mask = new Uint8Array(n);
  let skin = 0;

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = data[i];
    const g = data[i + 1];
    const b = data[i + 2];
    // Test raw AND corrected values. Correcting alone pushes skin that was
    // already in range back out; testing raw alone misses photos with a colour
    // cast. The union keeps both.
    if (
      isSkinPixel(r, g, b) ||
      isSkinPixel(
        Math.min(255, r * gains.r),
        Math.min(255, g * gains.g),
        Math.min(255, b * gains.b)
      )
    ) {
      mask[p] = 1;
      skin++;
    }
  }

  const skinFrac = skin / n;
  if (skinFrac < 0.004) return { faceScore: 0, skinFrac, faceBox: null };

  // Opening: erase isolated pixels. Foliage, walls and sand produce scattered
  // tint noise forming no region; without this it accumulated into a misleading
  // "skin area".
  const opened = dilate(erode(mask, w, h), w, h);
  // Radius-2 closing: fill holes left by eyes, brows and glasses, without
  // welding two distinct regions together.
  const closed = erode(erode(dilate(dilate(opened, w, h), w, h), w, h), w, h);

  const gray = toGray(img);
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  let best = { faceScore: 0, faceBox: null };
  let maxCompFrac = 0;
  let label = 0;

  // A face in a group photo covers under 1% of the frame, so thresholds must
  // go far lower than for a portrait.
  const minSide = Math.max(5, Math.round(Math.min(w, h) * 0.05));

  for (let start = 0; start < n; start++) {
    if (!closed[start] || labels[start] !== -1) continue;
    let sp = 0;
    stack[sp++] = start;
    labels[start] = label;
    let minX = w;
    let maxX = -1;
    let minY = h;
    let maxY = -1;
    let area = 0;

    while (sp > 0) {
      const p = stack[--sp];
      const x = p % w;
      const y = (p / w) | 0;
      area++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      if (x > 0 && closed[p - 1] && labels[p - 1] === -1) { labels[p - 1] = label; stack[sp++] = p - 1; }
      if (x < w - 1 && closed[p + 1] && labels[p + 1] === -1) { labels[p + 1] = label; stack[sp++] = p + 1; }
      if (y > 0 && closed[p - w] && labels[p - w] === -1) { labels[p - w] = label; stack[sp++] = p - w; }
      if (y < h - 1 && closed[p + w] && labels[p + w] === -1) { labels[p + w] = label; stack[sp++] = p + w; }
    }
    label++;

    const bw = maxX - minX + 1;
    const bh = maxY - minY + 1;
    const areaFrac = area / n;
    if (areaFrac > maxCompFrac) maxCompFrac = areaFrac;
    if (areaFrac < 0.0015 || bw < minSide || bh < minSide) continue;

    // Loose aspect and fill: a head merged with neck, shoulders or a hand is
    // still a person. These bounds now only reject long horizontal bands and
    // thread-like leftovers.
    const aspect = bw / bh;
    const fill = area / (bw * bh);
    if (aspect < 0.35 || aspect > 3) continue;
    if (fill < 0.3) continue;

    // A face contains pixels markedly darker than surrounding skin (eyes,
    // nostrils, mouth, hair at the edge).
    let inside = 0;
    let dark = 0;
    let sum = 0;
    for (let y = minY; y <= maxY; y++) {
      const r0 = y * w;
      for (let x = minX; x <= maxX; x++) {
        sum += gray[r0 + x];
        inside++;
      }
    }
    const meanIn = sum / inside;
    for (let y = minY; y <= maxY; y++) {
      const r0 = y * w;
      for (let x = minX; x <= maxX; x++) if (gray[r0 + x] < meanIn * 0.62) dark++;
    }
    const darkFrac = dark / inside;

    const aspectScore = 1 - Math.min(1, Math.abs(aspect - 0.8) / 1.1);
    const fillScore = clamp01((fill - 0.3) / 0.5);
    const featureScore = clamp01((darkFrac - 0.008) / 0.11);
    const sizeScore = clamp01(Math.min(areaFrac / 0.012, (0.85 - areaFrac) / 0.4));
    const score = clamp01(
      aspectScore * 0.24 + fillScore * 0.18 + featureScore * 0.34 + sizeScore * 0.24
    );

    if (score > best.faceScore) {
      best = { faceScore: score, faceBox: [minX / w, minY / h, bw / w, bh / h] };
    }
  }

  // Fallback: one large CONTIGUOUS skin region makes a person likely even when
  // geometry fails. Based on the largest component rather than total area, so
  // scattered tint noise never qualifies. Capped, because this signal alone
  // proves nothing.
  const presence = clamp01((maxCompFrac - 0.01) / 0.09) * 0.7;

  return {
    faceScore: Math.max(best.faceScore, presence),
    faceBox: best.faceBox,
    skinFrac
  };
}

function dilate(src, w, h) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (src[i]) { out[i] = 1; continue; }
      if (
        (x > 0 && src[i - 1]) || (x < w - 1 && src[i + 1]) ||
        (y > 0 && src[i - w]) || (y < h - 1 && src[i + w])
      ) out[i] = 1;
    }
  }
  return out;
}

function erode(src, w, h) {
  const out = new Uint8Array(src.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!src[i]) continue;
      const ok =
        (x === 0 || src[i - 1]) && (x === w - 1 || src[i + 1]) &&
        (y === 0 || src[i - w]) && (y === h - 1 || src[i + w]);
      if (ok) out[i] = 1;
    }
  }
  return out;
}

/* ----------------------------------------------------------- aspect ratios */

/**
 * Screen-specific aspect ratios.
 *
 * 4:3 and 3:2 are deliberately absent: they are above all the native ratios of
 * camera sensors, and including them would give nearly every ordinary photo
 * "screenshot" points. What remains are ratios a camera practically never
 * produces — very tall phone screens, and the 16:9 / 16:10 of desktop captures.
 */
const SCREEN_ASPECTS = [
  9 / 16, 9 / 18, 9 / 19.5, 9 / 20, 9 / 21, 10 / 16,
  16 / 9, 18 / 9, 19.5 / 9, 20 / 9, 21 / 9, 16 / 10
];

/** How close an aspect ratio is to a common screen format. */
export function screenAspectScore(width, height) {
  if (!width || !height) return 0;
  const a = width / height;
  let best = 1;
  for (const t of SCREEN_ASPECTS) best = Math.min(best, Math.abs(a - t) / t);
  return clamp01(1 - best / 0.035);
}
