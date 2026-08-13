/**
 * Deleting, at last.
 *
 * Until now this extension ticked checkboxes and stopped, because driving the
 * grid was the only thing it could do and a mis-click there is unrecoverable.
 * The API removes that constraint: `moveItemsToTrash` is the same operation
 * Google's own "Move to bin" button performs, and it is reversible — items sit
 * in the bin for sixty days and can be restored from it.
 *
 * That reversibility is what makes this acceptable to ship, and it is the only
 * deletion this file will ever do. There is no permanent-delete call here, on
 * purpose: a bug in this extension must never be able to destroy a photo.
 *
 * The planning is pure and separate, because "which of these can actually be
 * deleted, and what will that free" is what the confirmation shows, and a
 * confirmation that overstates what it is about to do is worse than none.
 */

import { moveToTrashAll } from '../api/photos-api.js';
import { deleteItems } from './db.js';
import { getTokens } from './tokens-client.js';

/**
 * Sort a selection into what can be binned and what cannot.
 *
 * Two things stop an item. It may predate the API listing, in which case the
 * catalogue never recorded the key the call needs — the DOM never exposed it.
 * Or it may belong to somebody else, shared into the library; binning it is not
 * ours to do and Google would refuse anyway.
 */
export function planTrash(items) {
  const deletable = [];
  const noKey = [];
  const notOwned = [];
  let bytes = 0;

  for (const item of items) {
    if (item.isOwned === 0) { notOwned.push(item); continue; }
    if (!item.dedupKey) { noKey.push(item); continue; }
    deletable.push(item);
    bytes += item.spaceTaken || item.sizeBytes || 0;
  }

  return {
    deletable,
    noKey,
    notOwned,
    bytes,
    // What the confirmation quantifies. Sizes are only known for items listed
    // through the API with the size pass on, so a partial figure is reported as
    // partial rather than as the whole truth.
    sizedCount: deletable.filter((i) => i.spaceTaken || i.sizeBytes).length
  };
}

export class Trasher {
  constructor(options = {}) {
    const { tokens = null, ...opts } = options;
    this.opts = opts;
    this.tokens = tokens;
    this.controller = null;
    this.aborted = false;
  }

  abort() {
    this.aborted = true;
    this.controller?.abort();
  }

  /**
   * Move a selection to the bin, then forget it locally.
   *
   * The catalogue is dropped only for what Google confirmed taking, and only
   * after: a row removed for an item still in the library would hide it from
   * every later run, which is the quiet kind of wrong.
   */
  async run(items, onProgress = () => {}) {
    const plan = planTrash(items);
    if (!plan.deletable.length) return { ...plan, trashed: 0, failed: 0, errors: [] };

    this.controller = new AbortController();
    if (!this.tokens) this.tokens = await getTokens();

    const keys = plan.deletable.map((i) => i.dedupKey);
    const byKey = new Map(plan.deletable.map((i) => [i.dedupKey, i.id]));

    const totals = await moveToTrashAll(this.tokens, keys, {
      fetchImpl: this.opts.fetchImpl,
      signal: this.controller.signal,
      onProgress: (p) => onProgress({ ...p, total: keys.length })
    });

    // `moveToTrashAll` reports how many keys were in batches that came back
    // clean, in order, so the first N are the ones that went through.
    const confirmed = keys.slice(0, totals.done).map((k) => byKey.get(k)).filter(Boolean);
    if (confirmed.length) await deleteItems(confirmed);

    return {
      ...plan,
      trashed: totals.done,
      failed: totals.failed,
      errors: totals.errors,
      removedLocally: confirmed.length,
      aborted: this.aborted
    };
  }
}

/** Bytes, in the units a person reads. */
export function formatBytes(n) {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value >= 100 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}
