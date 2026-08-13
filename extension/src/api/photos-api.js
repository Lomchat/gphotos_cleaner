/**
 * The handful of Google Photos calls this extension needs.
 *
 * Four of them. That is the whole surface, against roughly eleven hundred lines
 * of DOM scrolling it replaces — and the reason the trade is worth making even
 * though an undocumented endpoint is no more stable than an undocumented DOM.
 *
 * Adapted from Google-Photos-Toolkit (xob0t), MIT.
 */

import { call, ApiError } from './batchexecute.js';
import { parseTimelinePage, parseMediaInfoPage } from './parse.js';

/** Obfuscated call ids, with what each one is for. */
export const RPC = {
  byTakenDate: 'lcxiM',   // the timeline, newest first, paginated
  batchInfo: 'EWgK9e',    // file name and byte size for many items at once
  moveToTrash: 'XwAOJf',  // to the bin, recoverable for 60 days
  itemInfo: 'VrseUb'      // one item, in full
};

/** Where the timeline is read from. */
export const SOURCE = { library: 1, archive: 2, both: 3 };

/** Google refuses much more than this per page; 500 is what the app itself asks for. */
export const PAGE_SIZE = 500;

/**
 * A page of the library, newest first.
 *
 * @param {number|null} beforeTimestamp start from this instant, or the top
 * @param {string|null} pageId the cursor from the previous page
 */
export async function listPage(tokens, {
  beforeTimestamp = null,
  pageId = null,
  pageSize = PAGE_SIZE,
  source = SOURCE.library,
  fetchImpl,
  signal
} = {}) {
  // The cursor is the first element of the request, not a query parameter.
  const args = [pageId, beforeTimestamp, pageSize, null, 1, source];
  const payload = await call(RPC.byTakenDate, args, tokens, { fetchImpl, signal });
  // A null payload is the end of the library, not an error.
  if (payload == null) return { items: [], nextPageId: null, lastTimestamp: null };
  return parseTimelinePage(payload);
}

/**
 * File name and byte size for a batch of items.
 *
 * Sent in chunks because the request carries every key inline and a long
 * enough one is rejected outright rather than truncated.
 */
export async function batchInfo(tokens, mediaKeys, { fetchImpl, signal } = {}) {
  if (!mediaKeys.length) return [];
  const keys = mediaKeys.map((k) => [k]);
  // The long tail of nulls is a field mask: Google returns only what is asked
  // for, and this is the shape that yields name, size and quota usage.
  const mask = new Array(36).fill(null);
  mask[24] = [];
  mask[35] = [];
  const args = [[[keys], [mask]]];
  const payload = await call(RPC.batchInfo, args, tokens, { fetchImpl, signal });
  return payload == null ? [] : parseMediaInfoPage(payload);
}

export const INFO_CHUNK = 200;

/** Same, over any number of items. */
export async function batchInfoAll(tokens, mediaKeys, { onProgress, fetchImpl, signal } = {}) {
  const out = [];
  for (let i = 0; i < mediaKeys.length; i += INFO_CHUNK) {
    if (signal?.aborted) break;
    const slice = mediaKeys.slice(i, i + INFO_CHUNK);
    try {
      out.push(...await batchInfo(tokens, slice, { fetchImpl, signal }));
    } catch (err) {
      // One bad chunk must not cost the rest: sizes are an enrichment, and a
      // library without them is still perfectly usable.
      if (err instanceof ApiError && err.kind === 'auth') throw err;
    }
    onProgress?.({ done: Math.min(i + INFO_CHUNK, mediaKeys.length), total: mediaKeys.length });
  }
  return out;
}

/**
 * Move items to the bin.
 *
 * Recoverable: Google keeps trashed items for 60 days, and this is the same
 * operation its own "Move to bin" button performs. It takes dedup keys, not
 * media keys — passing the wrong ones silently trashes nothing, which is why
 * the caller checks what came back.
 */
export async function moveToTrash(tokens, dedupKeys, { fetchImpl, signal } = {}) {
  if (!dedupKeys.length) return { requested: 0 };
  // [null, 1, keys, 3] — the 1 is "to trash". Restoring is [null, 3, keys, 2],
  // which this extension deliberately does not implement: Google's own bin
  // does it, and a restore path here would be one more thing to get wrong.
  const args = [null, 1, dedupKeys, 3];
  await call(RPC.moveToTrash, args, tokens, { fetchImpl, signal });
  return { requested: dedupKeys.length };
}

export const TRASH_CHUNK = 100;

/**
 * Same, in batches, reporting progress.
 *
 * Chunked because one request per photo would be thousands of round trips, and
 * one request for thousands of photos is the kind of thing that gets refused
 * wholesale — losing the whole operation rather than one batch of it.
 */
export async function moveToTrashAll(tokens, dedupKeys, { onProgress, fetchImpl, signal } = {}) {
  const totals = { requested: 0, done: 0, failed: 0, errors: [] };
  for (let i = 0; i < dedupKeys.length; i += TRASH_CHUNK) {
    if (signal?.aborted) break;
    const slice = dedupKeys.slice(i, i + TRASH_CHUNK);
    try {
      await moveToTrash(tokens, slice, { fetchImpl, signal });
      totals.done += slice.length;
    } catch (err) {
      totals.failed += slice.length;
      if (totals.errors.length < 3) totals.errors.push(err.message);
      if (err instanceof ApiError && err.kind === 'auth') break;
    }
    totals.requested += slice.length;
    onProgress?.({ done: totals.requested, total: dedupKeys.length, trashed: totals.done });
  }
  return totals;
}
