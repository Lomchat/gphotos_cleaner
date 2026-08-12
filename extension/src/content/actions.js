/**
 * Drives selection inside Google Photos.
 *
 * This ticks the chosen items and hands control back: you click "Move to bin"
 * yourself, in Google's own UI, with its own counter and confirmation. It was
 * once the only thing the extension could do; now that the API can bin items
 * directly it is the alternative, kept for anyone who would rather see the
 * selection in Photos before parting with it.
 *
 * Nothing here is irreversible — the worst outcome is a tick in the wrong box,
 * undone by clicking it again.
 *
 * Speed comes from not doing work that was never needed. The first version
 * scrolled every tile to the centre of the screen and then slept a fixed 90 ms,
 * whether or not the tile was already in front of the user and whether or not
 * the click had already registered. On a screenful of forty tiles that is
 * thirty-nine pointless scrolls and about nine seconds of sleeping.
 */

import * as dom from './dom-adapter.js';
import { bringIntoView, sleep, findTileById, isOnScreen } from './tiles.js';

const DEFAULTS = {
  pollMs: 12,           // how often to look for a state change
  checkTimeoutMs: 700,  // how long to wait for a checkbox to take
  hoverTimeoutMs: 400,  // how long to wait for a hover-inserted checkbox
  // A tile this close to the edge may have its checkbox clipped or covered by
  // Google's own overlays, so it is scrolled even though it is technically on
  // screen.
  edgeMarginPx: 60
};

/** Poll until `read` returns something truthy, or give up. */
async function waitFor(read, timeoutMs, pollMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() >= deadline) return null;
    await sleep(pollMs);
  }
}

export class Selector {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.aborted = false;
  }

  abort() {
    this.aborted = true;
  }

  /**
   * Is this tile usable where it sits, without moving the grid?
   *
   * Scrolling is the expensive part, and most of a run's items are already on
   * screen: they were listed together, so they render together.
   */
  isReachable(tile) {
    return isOnScreen(tile, { margin: this.opts.edgeMarginPx });
  }

  /**
   * Tick the given items in the Google Photos grid.
   *
   * @param {Array<{id:string, anchorTop:number}>} items
   * @param {(e:{done:number, total:number, selected:number})=>void} onProgress
   */
  async run(items, onProgress = () => {}) {
    this.aborted = false;
    const selected = [];
    const failed = [];

    for (let i = 0; i < items.length; i++) {
      if (this.aborted) break;
      const item = items[i];
      try {
        // Only scroll when the tile is not already usable where it is. Items
        // arrive in grid order, so a scroll typically brings the next several
        // dozen into reach at once.
        let tile = findTileById(item.id);
        if (!this.isReachable(tile)) tile = await bringIntoView(item);

        if (!tile) {
          failed.push({ id: item.id, reason: 'tile not found after scrolling' });
        } else {
          const ok = await this.check(item, tile);
          if (ok === true) selected.push(item.id);
          else failed.push({ id: item.id, reason: ok });
        }
      } catch (err) {
        failed.push({ id: item.id, reason: String(err?.message || err) });
      }
      onProgress({ done: i + 1, total: items.length, selected: selected.length });
    }

    return {
      requested: items.length,
      selected,
      failed,
      // What Google Photos reports on its side. Informational only, but a
      // mismatch signals checkboxes that did not take.
      reported: dom.readSelectionCount(),
      aborted: this.aborted
    };
  }

  /** @returns {Promise<true|string>} true, or the failure reason */
  async check(item, tile) {
    // Try without hovering first: on many tiles the checkbox is already in the
    // DOM, and hovering then sleeping was pure cost.
    let cb = dom.findCheckbox(tile);
    if (!cb) {
      dom.hover(tile);
      cb = await waitFor(
        () => dom.findCheckbox(findTileById(item.id) || tile),
        this.opts.hoverTimeoutMs,
        this.opts.pollMs
      );
    }
    if (!cb) return 'checkbox not found';
    if (dom.isChecked(cb)) return true;

    dom.realClick(cb);

    // Wait for the box to actually take, rather than for a fixed delay chosen
    // to be safe on a slow day. Most clicks register within a frame or two.
    const took = await waitFor(
      () => {
        const fresh = dom.findCheckbox(findTileById(item.id) || tile);
        return fresh && dom.isChecked(fresh);
      },
      this.opts.checkTimeoutMs,
      this.opts.pollMs
    );
    return took ? true : 'checkbox stayed unchecked';
  }
}
