/**
 * Drives selection inside Google Photos.
 *
 * The extension never deletes anything. It ticks the chosen items in Google
 * Photos and hands control back: you click "Move to bin" yourself, in Google's
 * own UI, with its own counter and confirmation.
 *
 * That choice removes every irreversible code path at once — finding the delete
 * button, handling the confirmation dialog, batching, verifying a counter
 * before destroying. What remains is one action undone by a single click.
 */

import * as dom from './dom-adapter.js';
import { bringIntoView, sleep, findTileById } from './scanner.js';

const DEFAULTS = {
  clickDelayMs: 90,
  hoverSettleMs: 40
};

export class Selector {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.aborted = false;
  }

  abort() {
    this.aborted = true;
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
        const tile = await bringIntoView(item);
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
    dom.hover(tile);
    await sleep(this.opts.hoverSettleMs);

    let cb = dom.findCheckbox(tile);
    if (!cb) {
      // The checkbox may only be inserted on hover; retry.
      await sleep(160);
      const again = findTileById(item.id) || tile;
      dom.hover(again);
      await sleep(80);
      cb = dom.findCheckbox(again);
    }
    if (!cb) return 'checkbox not found';
    if (dom.isChecked(cb)) return true;

    dom.realClick(cb);
    await sleep(this.opts.clickDelayMs);
    const fresh = dom.findCheckbox(findTileById(item.id) || tile);
    if (fresh && !dom.isChecked(fresh)) return 'checkbox stayed unchecked';
    return true;
  }
}
