/** Synthetic image generators for the vision primitive tests. */

export function makeImage(width, height, fn) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = fn(x, y);
      const i = (y * width + x) * 4;
      data[i] = r;
      data[i + 1] = g;
      data[i + 2] = b;
      data[i + 3] = 255;
    }
  }
  return { data, width, height };
}

/** Deterministic pseudo-random generator (xorshift32). */
export function rng(seed = 1) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13; s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5; s >>>= 0;
    return s / 4294967296;
  };
}

/** White noise: rich in high frequencies, therefore "sharp". */
export function noiseImage(w, h, seed = 7) {
  const r = rng(seed);
  return makeImage(w, h, () => {
    const v = Math.floor(r() * 256);
    return [v, v, v];
  });
}

/** Smooth gradient: no high frequencies, therefore "blurred". */
export function smoothImage(w, h) {
  return makeImage(w, h, (x, y) => {
    const v = Math.floor(128 + 100 * Math.sin((x / w) * Math.PI) * Math.cos((y / h) * Math.PI));
    return [v, v, v];
  });
}

/** Pseudo screenshot: rectangular blocks, small palette, status bar. */
export function uiImage(w, h) {
  return makeImage(w, h, (x, y) => {
    if (y < h * 0.04) return [24, 24, 28];          // uniform status bar
    if (y < h * 0.14) return [66, 133, 244];        // app header
    if (x > w * 0.08 && x < w * 0.92) {
      const band = Math.floor((y - h * 0.14) / (h * 0.09));
      if (band % 2 === 0) return [255, 255, 255];
      return [240, 240, 242];
    }
    return [250, 250, 250];
  });
}

/** Pseudo document: white paper and regular text lines. */
export function documentImage(w, h) {
  return makeImage(w, h, (x, y) => {
    const line = Math.floor(y / 9) % 2 === 0;
    const inMargin = x < w * 0.12 || x > w * 0.88 || y < h * 0.08;
    if (!line || inMargin) return [246, 245, 242];
    // Characters: short-pitch dark/light alternation.
    return x % 5 < 3 ? [30, 30, 32] : [246, 245, 242];
  });
}

/** "Natural" photo: colour gradients, oblique edges, texture. */
export function photoImage(w, h, seed = 3) {
  const r = rng(seed);
  return makeImage(w, h, (x, y) => {
    const base = 90 + 60 * Math.sin((x + y) / 17) + 40 * Math.cos(x / 9 - y / 13);
    const n = (r() - 0.5) * 40;
    return [clamp(base + n + 30), clamp(base + n), clamp(base + n - 25)];
  });
}

export function flatImage(w, h, level = 128) {
  return makeImage(w, h, () => [level, level, level]);
}

function clamp(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/**
 * Configurable synthetic portrait.
 *
 * Covers the cases a naive detector fails on: dark skin, colour cast (indoors,
 * shade), a tiny face from a group photo, a head merged with neck and shoulders.
 */
export function portraitImage(o = {}) {
  const {
    size = 160,
    skin = [222, 172, 142],
    bg = [40, 80, 60],
    cast = [1, 1, 1],
    faceR = 0.17,
    center = [0.5, 0.42],
    neck = false
  } = o;

  const cx = center[0] * size;
  const cy = center[1] * size;
  const rx = faceR * size;
  const ry = faceR * 1.3 * size;
  const tint = (c) => [
    clamp(c[0] * cast[0]), clamp(c[1] * cast[1]), clamp(c[2] * cast[2])
  ];
  const skinT = tint(skin);
  const bgT = tint(bg);
  // Features: markedly darker than skin, like eyes and a mouth.
  const featT = tint([skin[0] * 0.22, skin[1] * 0.2, skin[2] * 0.22]);

  return makeImage(size, size, (x, y) => {
    const inFace = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
    const inNeck = neck &&
      y > cy + ry * 0.75 &&
      (Math.abs(x - cx) < rx * 0.45 || (y > cy + ry * 1.25 && Math.abs(x - cx) < rx * 2.2));

    if (inFace) {
      const eye = Math.abs(y - (cy - ry * 0.22)) < Math.max(1, ry * 0.09) &&
        (Math.abs(x - (cx - rx * 0.38)) < Math.max(1, rx * 0.2) ||
         Math.abs(x - (cx + rx * 0.38)) < Math.max(1, rx * 0.2));
      const mouth = Math.abs(y - (cy + ry * 0.45)) < Math.max(1, ry * 0.07) &&
        Math.abs(x - cx) < rx * 0.35;
      return eye || mouth ? featT : skinT;
    }
    if (inNeck) return skinT;
    return bgT;
  });
}

/**
 * Box-average resample. Simulates the same photo served by Google at two
 * different resolutions.
 */
export function resizeImage(img, nw, nh) {
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(nw * nh * 4);
  const xr = w / nw;
  const yr = h / nh;
  for (let y = 0; y < nh; y++) {
    const y0 = Math.min(h - 1, Math.floor(y * yr));
    const y1 = Math.min(h, Math.max(y0 + 1, Math.floor((y + 1) * yr)));
    for (let x = 0; x < nw; x++) {
      const x0 = Math.min(w - 1, Math.floor(x * xr));
      const x1 = Math.min(w, Math.max(x0 + 1, Math.floor((x + 1) * xr)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = y0; yy < y1; yy++) {
        for (let xx = x0; xx < x1; xx++) {
          const i = (yy * w + xx) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const o = (y * nw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: nw, height: nh };
}

/** Box blur, to degrade a sharp image. */
export function blur(img, radius = 3) {
  const { data, width: w, height: h } = img;
  const out = new Uint8ClampedArray(data.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, n = 0;
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const i = (yy * w + xx) * 4;
          r += data[i]; g += data[i + 1]; b += data[i + 2]; n++;
        }
      }
      const o = (y * w + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return { data: out, width: w, height: h };
}
