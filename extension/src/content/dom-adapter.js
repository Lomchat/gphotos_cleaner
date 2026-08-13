/**
 * Google Photos DOM adapter.
 *
 * ALL knowledge of the photos.google.com structure lives here. The markup is
 * obfuscated and changes without notice, so every read tries several
 * strategies, from most stable to most opportunistic, and a failed extraction
 * is reported rather than hidden. When Google reshuffles things, this is the
 * only file to fix.
 *
 * It used to be much larger. Listing the library, reading dates off tiles,
 * waiting for thumbnails to paint, measuring how much of the grid had rendered
 * — all of that is gone, because the API answers those questions directly and
 * without rendering anything. What is left serves the ticking fallback: find a
 * tile, find its checkbox, click it convincingly.
 *
 * Landmarks assumed stable:
 *  - each tile is an `<a href="./photo/...">`;
 *  - the thumbnail URL suffix encodes the requested size;
 *  - the selection checkbox is a `[role="checkbox"]` descendant.
 */

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

/**
 * The media key in a tile's href.
 *
 * This is the same identifier the API returns, which is what lets a catalogue
 * built from the API address tiles in the page at all.
 */
export function tileId(a) {
  const href = a.getAttribute('href') || '';
  const m = /\/photo\/([^/?#]+)/.exec(href);
  return m ? decodeURIComponent(m[1]) : null;
}

/* -------------------------------------------------------------- thumbnails */

// Re-exported so the page-facing code keeps one import, while the API layer can
// reach the same functions without depending on anything DOM.
export { isGoogleImageUrl, withThumbSize } from '../common/images.js';

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
    const m = /^(\d[\d\s .,]*)\s*(?:élément|photo|item|selected|sélectionn)/i.exec(t) ||
      /(?:sélectionné|selected)\D*(\d[\d\s .,]*)$/i.exec(t);
    if (m) {
      const n = parseInt(m[1].replace(/[\s .,]/g, ''), 10);
      if (Number.isFinite(n)) return n;
    }
  }
  return null;
}

export function isVisible(el) {
  if (!el || !el.isConnected) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 1 || r.height < 1) return false;
  const s = getComputedStyle(el);
  return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0';
}
