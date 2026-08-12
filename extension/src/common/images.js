/**
 * Google image URLs: recognising them, and asking for a size.
 *
 * Neutral ground. Both halves of the extension need this — the API listing,
 * which receives a bare base URL and must attach a size, and the page adapter,
 * which finds URLs already carrying one — and neither should have to import the
 * other to get it.
 */

/**
 * Google image hosts.
 *
 * Never hard-code a single domain: Google migrates image serving between
 * `googleusercontent.com`, `lh<n>.google.com`, `*.usercontent.google.com` and
 * `ggpht.com` without notice. Too narrow a filter raises no visible error — the
 * URL is simply absent, the analysis queue stays empty, and the extension looks
 * like it does nothing.
 */
const GOOGLE_IMAGE_HOST =
  /(?:^|\.)(?:googleusercontent\.com|ggpht\.com|usercontent\.google\.com)$|^lh\d+\.google\.com$/i;

/** @returns {boolean} true if the URL points at a Google-served image. */
export function isGoogleImageUrl(url) {
  if (!url || typeof url !== 'string') return false;
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    return GOOGLE_IMAGE_HOST.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * Set the size suffix of a Google image URL.
 *
 * `...=w200-h200-no?authuser=0` becomes `...=w256-h256?authuser=0`, and a URL
 * with no suffix at all gets one — which is the case for every URL the API
 * returns, since it hands back the base and expects the caller to say how big
 * a copy it wants.
 *
 * A normalised size is what keeps perceptual hashes comparable between passes.
 */
export function withThumbSize(url, size) {
  if (!url) return null;
  const qi = url.indexOf('?');
  const base = qi === -1 ? url : url.slice(0, qi);
  const query = qi === -1 ? '' : url.slice(qi);
  const cut = base.lastIndexOf('=');
  const opts = cut === -1 ? '' : base.slice(cut);
  // Only treat the tail as a size suffix if it looks like one: a path segment
  // containing "=" must not be mistaken for options and truncated.
  const head = cut !== -1 && /^=[-\w]*$/.test(opts) ? base.slice(0, cut) : base;
  return `${head}=w${size}-h${size}${query}`;
}
