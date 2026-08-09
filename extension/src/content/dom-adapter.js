/**
 * Google Photos DOM adapter.
 *
 * ALL knowledge of the photos.google.com structure lives here. The markup is
 * obfuscated and changes without notice, so every read tries several
 * strategies, from most stable to most opportunistic, and a failed extraction
 * is reported rather than hidden. When Google reshuffles things, this is the
 * only file to fix.
 *
 * Landmarks assumed stable:
 *  - each tile is an `<a href="./photo/...">`;
 *  - the thumbnail is an `<img>` from a Google image host, whose URL suffix
 *    encodes the requested size;
 *  - the selection checkbox is a `[role="checkbox"]` descendant.
 */

import { parseDateFromText, parseDurationFromText, isVideoLabel } from '../common/dates.js';

/* ------------------------------------------------------------------ tiles */

const TILE_SELECTOR = 'a[href*="/photo/"], a[href*="/search/"][data-latest-bg]';

export function queryTiles(root = document) {
  return Array.from(root.querySelectorAll(TILE_SELECTOR)).filter(isRealTile);
}

function isRealTile(a) {
  const href = a.getAttribute('href') || '';
  if (!/\/photo\//.test(href)) return false;
  // Full-screen viewer links also point at /photo/ but are not grid tiles.
  const r = a.getBoundingClientRect();
  return r.width > 24 && r.height > 24;
}

export function tileId(a) {
  const href = a.getAttribute('href') || '';
  const m = /\/photo\/([^/?#]+)/.exec(href);
  return m ? decodeURIComponent(m[1]) : null;
}

/* -------------------------------------------------------------- thumbnails */

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

/** Read the thumbnail URL, from an `img` or from a CSS background. */
export function tileThumbUrl(a) {
  const img = a.querySelector('img');
  if (img) {
    const src = img.currentSrc || img.src;
    if (isGoogleImageUrl(src)) return src;
    if (img.srcset) {
      const first = img.srcset.split(',')[0]?.trim().split(/\s+/)[0];
      if (isGoogleImageUrl(first)) return first;
    }
  }
  const bgHost = a.matches('[data-latest-bg]') ? a : a.querySelector('[data-latest-bg]');
  const bg = bgHost?.getAttribute('data-latest-bg');
  if (isGoogleImageUrl(bg)) return bg;

  // CSS background: read any descendant's inline style rather than assume the
  // domain in the selector.
  for (const el of a.querySelectorAll('[style*="url("]')) {
    const m = /url\(\s*["']?(https?:\/\/[^"')\s]+)["']?\s*\)/.exec(el.getAttribute('style') || '');
    if (m && isGoogleImageUrl(m[1])) return m[1];
  }
  return null;
}

/** Image hosts actually observed on tiles — used for diagnostics. */
export function observedThumbHosts(limit = 40) {
  const counts = {};
  for (const a of queryTiles().slice(0, limit)) {
    const url = tileThumbUrl(a);
    let key;
    if (url) {
      try { key = new URL(url).hostname; } catch { key = '(unreadable URL)'; }
    } else {
      // Distinguish "no image" from "image from an unrecognised host".
      const img = a.querySelector('img');
      const raw = img && (img.currentSrc || img.src);
      if (!img) key = '(no img tag)';
      else if (!raw) key = '(img without source)';
      else {
        try { key = `! ${new URL(raw, location.href).hostname} (unrecognised)`; }
        catch { key = '! unreadable source'; }
      }
    }
    counts[key] = (counts[key] || 0) + 1;
  }
  return counts;
}

/**
 * Rewrite the size suffix of a Google image URL.
 * `...=w200-h200-no?authuser=0` becomes `...=w256-h256?authuser=0`.
 * A normalised size keeps perceptual hashes comparable across zoom levels.
 */
export function withThumbSize(url, size) {
  if (!url) return null;
  const qi = url.indexOf('?');
  const base = qi === -1 ? url : url.slice(0, qi);
  const query = qi === -1 ? '' : url.slice(qi);
  const cut = base.lastIndexOf('=');
  const opts = cut === -1 ? '' : base.slice(cut);
  const head = cut !== -1 && /^=[-\w]*$/.test(opts) ? base.slice(0, cut) : base;
  return `${head}=w${size}-h${size}${query}`;
}

/* -------------------------------------------------------- tile metadata */

function tileLabel(a) {
  const parts = [
    a.getAttribute('aria-label'),
    a.getAttribute('title'),
    a.querySelector('img')?.getAttribute('alt')
  ];
  const labelledBy = a.getAttribute('aria-labelledby');
  if (labelledBy) {
    for (const id of labelledBy.split(/\s+/)) {
      parts.push(document.getElementById(id)?.textContent);
    }
  }
  return parts.filter(Boolean).join(' · ');
}

/**
 * The duration badge shown in a video tile's corner.
 *
 * The tile's whole text is tested first: walking every descendant was expensive
 * and this runs for each tile on every scroll step. The detailed walk now only
 * isolates the badge when the tile really contains a duration pattern.
 */
function tileDurationText(a) {
  const whole = a.textContent;
  if (!whole || !/\d{1,2}:\d{2}/.test(whole)) return null;
  const trimmed = whole.trim();
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(trimmed)) return trimmed;
  for (const el of a.querySelectorAll('div, span')) {
    const t = el.textContent?.trim();
    if (t && t.length <= 8 && /^\d{1,2}:\d{2}(:\d{2})?$/.test(t)) return t;
  }
  return null;
}

/**
 * Cheap signature of the grid's render state.
 *
 * Detects that a scroll step has finished painting without measuring geometry:
 * `getBoundingClientRect` forces a reflow, and polling it would cost more than
 * the fixed wait we are trying to remove.
 */
export function gridSignature() {
  const nodes = document.querySelectorAll(TILE_SELECTOR);
  if (!nodes.length) return '0';
  const first = nodes[0].getAttribute('href') || '';
  const last = nodes[nodes.length - 1].getAttribute('href') || '';
  // The count of loaded thumbnails is part of the signature. Without it the
  // grid looks "rendered" as soon as the anchors exist, while the `<img>` tags
  // have no source yet — and we would harvest items with no thumbnail, forever
  // unanalysable.
  const loaded = document.querySelectorAll(LOADED_THUMB_SELECTOR).length;
  return `${nodes.length}|${loaded}|${first}|${last}`;
}

const LOADED_THUMB_SELECTOR = 'a[href*="/photo/"] img[src]';

/**
 * Share of rendered tiles whose thumbnail is actually available.
 *
 * Google Photos fills the grid in two passes: anchors first, images second.
 * Scrolling between the two produces items recorded without an image, so the
 * scanner uses this to decide whether it may move on.
 */
export function thumbCoverage() {
  const tiles = document.querySelectorAll(TILE_SELECTOR);
  if (!tiles.length) return { total: 0, ready: 0, ratio: 1 };
  let ready = 0;
  for (const a of tiles) {
    const img = a.querySelector('img');
    if (img && (img.currentSrc || img.getAttribute('src'))) {
      ready++;
      continue;
    }
    if (a.querySelector('[data-latest-bg]')) ready++;
  }
  return { total: tiles.length, ready, ratio: ready / tiles.length };
}

/**
 * @returns {{id, url, label, ts, precision, dateSource, isVideo, duration}}
 */
export function readTile(a, groupDate) {
  const id = tileId(a);
  if (!id) return null;
  const label = tileLabel(a);
  const durText = tileDurationText(a);

  const fromLabel = parseDateFromText(label);
  let ts = fromLabel?.ts ?? null;
  let precision = fromLabel?.precision ?? null;
  let dateSource = fromLabel ? 'label' : null;
  if (ts == null && groupDate) {
    ts = groupDate.ts;
    precision = groupDate.precision;
    dateSource = 'group';
  }

  const duration = parseDurationFromText(label) ?? (durText ? parseDurationFromText(durText) : null);
  const isVideo = duration != null || isVideoLabel(label) || !!durText;

  return {
    id,
    url: tileThumbUrl(a),
    label,
    ts,
    precision,
    dateSource,
    isVideo,
    duration
  };
}

/* ----------------------------------------------------- date group headers */

const HEADER_SELECTOR = '[role="heading"], [data-date], h1, h2, h3';

function readGroupHeader(el) {
  const explicit = el.getAttribute?.('data-date');
  if (explicit) {
    const p = parseDateFromText(explicit);
    if (p) return p;
  }
  const text = (el.textContent || '').trim();
  // A date header is short; long text is something else (an album title).
  if (!text || text.length > 60) return null;
  return parseDateFromText(text);
}

/**
 * Walk the grid in document order, pairing each tile with the date header above
 * it. This is the fallback when a tile's `aria-label` carries no date.
 *
 * `initialGroupDate` is essential: the grid is virtualised, so the current
 * group's header has often been recycled out of the DOM well above the rendered
 * window. Starting from nothing each round would leave the first tiles of every
 * round undated — and since scrolling runs downwards continuously, the header
 * seen last round is still the one in force.
 *
 * @returns {{entries:Array, lastGroupDate:object|null}}
 */
export function walkGridInOrder(container, initialGroupDate = null) {
  const entries = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    acceptNode(node) {
      if (node.matches(TILE_SELECTOR)) return NodeFilter.FILTER_ACCEPT;
      if (node.matches(HEADER_SELECTOR)) return NodeFilter.FILTER_ACCEPT;
      return NodeFilter.FILTER_SKIP;
    }
  });
  let current = initialGroupDate;
  let node = walker.nextNode();
  while (node) {
    if (node.matches(HEADER_SELECTOR)) {
      const d = readGroupHeader(node);
      if (d) current = d;
    } else if (isRealTile(node)) {
      entries.push({ el: node, groupDate: current });
    }
    node = walker.nextNode();
  }
  return { entries, lastGroupDate: current };
}

/**
 * Date-only read. Keeps the chronological chain intact while passing over
 * already-known tiles, which there is no reason to read in full.
 */
export function tileDateOnly(a) {
  const text = a.getAttribute('aria-label') || a.getAttribute('title') || '';
  return text ? parseDateFromText(text) : null;
}

/* ------------------------------------------------------------- scroller */

let cachedScroller = null;

/** Find the element that actually scrolls the grid. */
export function findScroller() {
  if (cachedScroller && document.contains(cachedScroller) && isScrollable(cachedScroller)) {
    return cachedScroller;
  }
  const tile = document.querySelector(TILE_SELECTOR);
  if (tile) {
    let el = tile.parentElement;
    while (el && el !== document.body) {
      if (isScrollable(el)) {
        cachedScroller = el;
        return el;
      }
      el = el.parentElement;
    }
  }
  // Google Photos sometimes scrolls the window itself.
  const doc = document.scrollingElement || document.documentElement;
  cachedScroller = isScrollable(doc) ? doc : null;
  return cachedScroller;
}

function isScrollable(el) {
  if (!el) return false;
  if (el === document.scrollingElement || el === document.documentElement) {
    return el.scrollHeight > el.clientHeight + 64;
  }
  const style = getComputedStyle(el);
  const oy = style.overflowY;
  return (oy === 'auto' || oy === 'scroll') && el.scrollHeight > el.clientHeight + 64;
}

export function scrollerMetrics() {
  const s = findScroller();
  if (!s) return null;
  return {
    scrollTop: s.scrollTop,
    clientHeight: s.clientHeight,
    scrollHeight: s.scrollHeight,
    atBottom: s.scrollTop + s.clientHeight >= s.scrollHeight - 4
  };
}

export function scrollTo(top) {
  const s = findScroller();
  if (!s) return;
  s.scrollTop = Math.max(0, top);
}

export function scrollBy(delta) {
  const s = findScroller();
  if (!s) return;
  s.scrollTop = Math.max(0, s.scrollTop + delta);
}

/* ---------------------------------------------------------------- selection */

const CHECKBOX_SELECTOR = '[role="checkbox"], [aria-checked]';

/** Find the checkbox tied to a tile. */
export function findCheckbox(a) {
  const direct = a.querySelector(CHECKBOX_SELECTOR);
  if (direct) return direct;
  // Depending on the version, the checkbox is a sibling of the link.
  let el = a.parentElement;
  for (let depth = 0; el && depth < 3; depth++, el = el.parentElement) {
    const cb = el.querySelector(CHECKBOX_SELECTOR);
    if (cb) return cb;
    // Do not climb past the container holding a single tile.
    if (el.querySelectorAll(TILE_SELECTOR).length > 1) break;
  }
  return null;
}

export function isChecked(cb) {
  return cb?.getAttribute('aria-checked') === 'true';
}

/**
 * Simulate hover: in some versions the checkbox only becomes interactive on
 * `pointerover`, and a bare `click()` fails there silently.
 */
export function hover(el) {
  const opts = { bubbles: true, cancelable: true, view: window };
  el.dispatchEvent(new PointerEvent('pointerover', opts));
  el.dispatchEvent(new MouseEvent('mouseover', opts));
  el.dispatchEvent(new PointerEvent('pointerenter', { ...opts, bubbles: false }));
  el.dispatchEvent(new MouseEvent('mousemove', opts));
}

export function realClick(el) {
  const rect = el.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;
  const base = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 };
  el.dispatchEvent(new PointerEvent('pointerdown', { ...base, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mousedown', base));
  el.dispatchEvent(new PointerEvent('pointerup', { ...base, isPrimary: true }));
  el.dispatchEvent(new MouseEvent('mouseup', base));
  el.dispatchEvent(new MouseEvent('click', base));
}

/* ------------------------------------------------------------ action bar */

/** Read the "N selected" counter from the action bar. */
export function readSelectionCount() {
  const nodes = document.querySelectorAll('[aria-live], [role="status"], span, div');
  for (const el of nodes) {
    if (!isVisible(el)) continue;
    const t = el.textContent?.trim();
    if (!t || t.length > 40) continue;
    const m = /^(\d[\d\s .,]*)\s*(?:élément|photo|item|selected|sélectionn)/i.exec(t) ||
      /(?:sélectionné|selected)\D*(\d[\d\s .,]*)$/i.exec(t);
    if (m) {
      const n = parseInt(m[1].replace(/[\s .,]/g, ''), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

/** Leave selection mode (Escape key). */
export function exitSelectionMode() {
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true })
  );
}

export function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
}

/* ----------------------------------------------------------- diagnostics */

/** Human-readable report: which DOM landmarks still respond. */
export function diagnose() {
  const scroller = findScroller();
  const tiles = queryTiles();
  const sample = tiles.slice(0, 12).map((t) => readTile(t, null)).filter(Boolean);
  const withUrl = sample.filter((s) => s.url).length;
  const withDate = sample.filter((s) => s.ts != null).length;
  const firstCb = tiles.length ? findCheckbox(tiles[0]) : null;

  // Labels no date could be read from. This is the only information that lets
  // us fix the parser when Google changes its format.
  const labelsSansDate = [];
  for (const t of tiles.slice(0, 60)) {
    if (labelsSansDate.length >= 3) break;
    const texte = t.getAttribute('aria-label') || t.getAttribute('title') || '';
    if (texte && !parseDateFromText(texte)) labelsSansDate.push(texte.slice(0, 90));
  }

  const entetes = Array.from(document.querySelectorAll(HEADER_SELECTOR))
    .filter((el) => readGroupHeader(el)).length;

  return {
    scrollerFound: !!scroller,
    headersVisible: entetes,
    labelsSansDate,
    scrollerTag: scroller ? `${scroller.tagName.toLowerCase()}${scroller.className ? '.' + String(scroller.className).split(/\s+/)[0] : ''}` : null,
    tilesVisible: tiles.length,
    sampleSize: sample.length,
    thumbUrlOk: withUrl,
    dateFromLabelOk: withDate,
    checkboxFound: !!firstCb,
    selectionCount: readSelectionCount(),
    exampleLabel: sample[0]?.label || null,
    // Without this, a Google image-host change means an empty analysis queue
    // and no clue why.
    thumbHosts: observedThumbHosts()
  };
}
