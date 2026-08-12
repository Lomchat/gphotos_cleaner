/**
 * Finding a photo's tile in the Google Photos grid.
 *
 * Listing no longer goes through the DOM — the API returns the whole library
 * without rendering anything. What remains here is the small amount of grid
 * navigation the *ticking* fallback still needs: to click a checkbox you have
 * to have the tile on screen, and the grid is virtualised, so it may not exist
 * yet.
 *
 * Ticking is a fallback now rather than the main path (deletion goes through
 * the API), but it is worth keeping: it is the one action that leaves the final
 * click to Google's own interface.
 */

import * as dom from './dom-adapter.js';

/**
 * Is this element comfortably inside the scroller?
 *
 * `margin` keeps it away from the edges, where Google's own overlays sit and a
 * checkbox can be clipped or covered.
 */
export function isOnScreen(el, { margin = 60, scroller = null } = {}) {
  const view = scroller || dom.findScroller();
  if (!el || !view) return false;
  const box = el.getBoundingClientRect();
  const bounds = view.getBoundingClientRect();
  if (!box.height) return false;
  return box.top >= bounds.top + margin && box.bottom <= bounds.bottom - margin;
}

/**
 * Bring a tile on screen, then wait for it to appear in the DOM.
 *
 * Items listed through the API carry no scroll landmark — there was never a
 * scroll — so the search starts from wherever the grid happens to be and
 * spirals outwards. That is slower than the old landmark jump, which is part of
 * why deletion no longer depends on it.
 */
export async function bringIntoView(item, { timeoutMs = 4000 } = {}) {
  const existing = findTileById(item.id);
  if (existing) {
    // Already on screen: leave the grid where it is. Re-centring every tile
    // meant a scroll and a settle for each of the forty already in front of
    // the user, which is most of the cost of ticking a run.
    if (isOnScreen(existing)) return existing;
    existing.scrollIntoView({ block: 'center' });
    await sleep(90);
    return findTileById(item.id) || existing;
  }

  const scroller = dom.findScroller();
  if (!scroller) return null;

  const start = Math.max(0, (item.anchorTop ?? scroller.scrollTop) - scroller.clientHeight * 0.3);
  scroller.scrollTop = start;
  await sleep(260);

  const deadline = Date.now() + timeoutMs;
  const step = scroller.clientHeight * 0.5;
  let offset = 0;
  let direction = 1;

  while (Date.now() < deadline) {
    const found = findTileById(item.id);
    if (found) {
      found.scrollIntoView({ block: 'center' });
      await sleep(90);
      return findTileById(item.id) || found;
    }
    // Spiral around the starting point: +/-0.5, 1, 1.5 screens.
    offset += direction > 0 ? step : 0;
    direction *= -1;
    scroller.scrollTop = Math.max(0, start + direction * offset);
    await sleep(220);
  }
  return null;
}

export function findTileById(id) {
  for (const a of dom.queryTiles()) {
    if (dom.tileId(a) === id) return a;
  }
  return null;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
