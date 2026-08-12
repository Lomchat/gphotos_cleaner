/**
 * Listing the library, by asking for it.
 *
 * This replaces the scroll-and-harvest scanner. The old one drove the grid,
 * waited for tiles to render, waited again for their images, and read what it
 * could — which is why a run could list two thousand items and analyse a
 * hundred and twenty: the thumbnails simply had not arrived when it looked.
 *
 * Here a page is five hundred items, complete, with the thumbnail URL included,
 * in one request. Nothing is waited for because nothing is being rendered. The
 * date window, which used to be a "seeking" phase striding past recent photos,
 * is a parameter.
 *
 * What is kept from the old design: the same catalogue shape, so analysis,
 * sorting and the people pass do not know the difference; a per-run limit; and
 * a resume cursor, because a hundred thousand photos is still a hundred
 * thousand photos.
 */

import { listPage, batchInfoAll, PAGE_SIZE } from '../api/photos-api.js';
import { ApiError } from '../api/batchexecute.js';
import { thumbUrl } from '../api/parse.js';
import { upsertItems, getAllIds, getMeta, setMeta } from './db.js';
import { getTokens, refreshTokens } from './tokens-client.js';

export const CURSOR_KEY = 'apiCursor';

const DEFAULTS = {
  olderThanTs: null,     // only list items taken before this instant
  maxNewItems: Infinity, // per-run limit, in previously unseen items
  thumbSize: 176,
  pageSize: PAGE_SIZE,
  resume: true,
  withSizes: true,       // fetch file name and byte size alongside
  source: 1,             // 1 = library, 2 = archive
  maxRetries: 4,
  retryBaseMs: 600,
  // Pages that yield nothing new before concluding the run has caught up with
  // what is already in the catalogue.
  knownPagesBeforeStop: 6
};

/**
 * Where to start reading.
 *
 * Kept pure and separate because it is the one piece of judgement here, and the
 * one most likely to be wrong in a way nobody notices — a resume that silently
 * restarts from the top wastes a run; one that resumes into the wrong window
 * silently omits photos.
 *
 * The cursor stores the window it was made under. A different window is a
 * different question, so its answer cannot be continued.
 */
export function planStart(cursor, opts) {
  const from = opts.olderThanTs ?? null;
  if (!opts.resume) return { beforeTimestamp: from, pageId: null, reason: 'no-resume' };
  if (!cursor) return { beforeTimestamp: from, pageId: null, reason: 'first-run' };
  if ((cursor.olderThanTs ?? null) !== from) {
    return { beforeTimestamp: from, pageId: null, reason: 'window-changed' };
  }
  // The whole window has been walked. New photos arrive at the top, so that is
  // where the next run belongs.
  if (cursor.reachedEnd) return { beforeTimestamp: from, pageId: null, reason: 'completed' };
  if (!cursor.lastTimestamp) return { beforeTimestamp: from, pageId: null, reason: 'no-position' };
  return {
    beforeTimestamp: cursor.lastTimestamp,
    // A page id is a within-session cursor and may not survive; the timestamp
    // beside it is what actually guarantees the position.
    pageId: cursor.pageId || null,
    reason: 'resume'
  };
}

/**
 * One API item, as the catalogue stores it.
 *
 * Pure so the field mapping can be checked without a network: everything
 * downstream — analysis, filters, statistics, the people pass — reads these
 * names, and a rename here is invisible until a filter quietly matches nothing.
 */
export function toRow(item, { thumbSize = 176, order = 0, now = 0, authUser = null } = {}) {
  return {
    id: item.mediaKey,
    url: thumbUrl(item.thumb, thumbSize, { authUser }),
    // The unsized original, as a fallback if the size suffix is ever refused.
    urlRaw: item.thumb || null,
    label: null,             // filled in by the size pass, which knows the name
    ts: item.timestamp ?? null,
    // The API gives the real capture time, so there is no inference to record
    // and nothing to inherit from a neighbour.
    precision: item.timestamp != null ? 'exact' : null,
    dateSource: 'api',
    isVideo: item.isVideo ? 1 : 0,
    duration: item.duration ?? null,
    // Google's own identity for the underlying file — and what the trash call
    // takes. Without it an item cannot be deleted.
    dedupKey: item.dedupKey ?? null,
    isArchived: item.isArchived ? 1 : 0,
    isFavourite: item.isFavourite ? 1 : 0,
    isOwned: item.isOwned === false ? 0 : 1,
    width: item.width ?? null,
    height: item.height ?? null,
    sizeBytes: null,         // the size pass fills these three
    spaceTaken: null,
    fileName: null,
    order,
    discoveredAt: now
  };
}

/**
 * Which signed-in account a session path belongs to.
 *
 * `/u/1/` is the second account. Thumbnail URLs from a secondary account can be
 * refused without it, and the failure looks like an ordinary fetch error — so
 * the number is carried into the URL rather than left to chance. The default
 * account has no prefix and needs nothing.
 */
export function accountFromPath(path) {
  const m = /^\/u\/(\d+)\//.exec(path || '');
  return m ? Number(m[1]) : null;
}

export class ApiScanner {
  constructor(options = {}) {
    const { tokens = null, deps, ...opts } = options;
    this.opts = { ...DEFAULTS, ...opts };
    this.tokens = tokens;
    // The paging loop — resume, the window, the limit, the barren-page stop —
    // is the part with the judgement in it, and every one of its mistakes is
    // silent: a run that lists the wrong slice reports success either way. So
    // storage and credentials go through a seam and the loop is exercised
    // outside a browser.
    this.deps = {
      getAllIds, upsertItems, getMeta, setMeta, getTokens, refreshTokens,
      ...deps
    };
    this.aborted = false;
    this.running = false;
    this.controller = null;
    this.known = new Set();
    this.fresh = new Set();
    this.stats = {
      discovered: 0,
      known: 0,
      pages: 0,
      requests: 0,
      retries: 0,
      skippedRecent: 0,  // newer than the window asked for
      skippedNoThumb: 0, // no preview at all: nothing to analyse
      alreadyKnown: 0,
      sized: 0,
      bytes: 0
    };
  }

  abort() {
    this.aborted = true;
    this.controller?.abort();
  }

  /**
   * @param {(stats)=>void} onProgress
   */
  async run(onProgress = () => {}) {
    if (this.running) throw new Error('A listing is already running');
    this.running = true;
    this.aborted = false;
    this.controller = new AbortController();

    let cursor;
    try {
      // Priming, exactly as before: without it every known item counts as new
      // and the run's limit is spent on nothing.
      this.known = new Set(await this.deps.getAllIds());
      this.stats.known = this.known.size;
      if (!this.tokens) this.tokens = await this.deps.getTokens();
      cursor = this.opts.resume ? await this.deps.getMeta(CURSOR_KEY, null) : null;
    } catch (err) {
      // No session, no database: nothing has started, so nothing is half done —
      // but the flag has to come back down or every later run refuses with "a
      // listing is already running".
      this.running = false;
      throw err;
    }

    const plan = planStart(cursor, this.opts);

    let beforeTimestamp = plan.beforeTimestamp;
    let pageId = plan.pageId;
    let lastTimestamp = beforeTimestamp;
    let reachedEnd = false;
    let limitReached = false;
    let error = null;
    let barrenPages = 0;
    const sizeJobs = [];

    try {
      while (!this.aborted) {
        const page = await this.fetchPage({ beforeTimestamp, pageId });
        this.stats.pages++;

        if (!page.items.length && !page.nextPageId) {
          reachedEnd = true;
          break;
        }

        const rows = [];
        for (const item of page.items) {
          if (item.timestamp != null) lastTimestamp = item.timestamp;

          // Belt and braces on the window. The timestamp parameter is supposed
          // to place us past the recent photos, but the whole run's scope hangs
          // on it, so every item is checked here too — and if the parameter is
          // ignored the skip count says so plainly instead of the run silently
          // listing the wrong half of the library.
          if (this.opts.olderThanTs != null && item.timestamp != null
              && item.timestamp >= this.opts.olderThanTs) {
            this.stats.skippedRecent++;
            continue;
          }
          if (this.known.has(item.mediaKey)) {
            this.stats.alreadyKnown++;
            continue;
          }
          // No preview means nothing to analyse. Recording it would spend a slot
          // on an item no criterion can ever judge.
          if (!item.thumb) {
            this.stats.skippedNoThumb++;
            continue;
          }

          this.known.add(item.mediaKey);
          this.fresh.add(item.mediaKey);
          rows.push(toRow(item, {
            thumbSize: this.opts.thumbSize,
            order: this.known.size,
            now: Date.now(),
            authUser: accountFromPath(this.tokens?.path)
          }));
          if (this.fresh.size >= this.opts.maxNewItems) {
            limitReached = true;
            break;
          }
        }

        if (rows.length) {
          await this.deps.upsertItems(rows);
          barrenPages = 0;
          if (this.opts.withSizes) {
            // Not awaited: the next page can be requested while the sizes for
            // this one are on their way. They are collected before returning.
            sizeJobs.push(this.fillSizes(rows.map((r) => r.id)));
          }
        } else {
          barrenPages++;
        }

        this.stats.discovered = this.fresh.size;
        this.stats.known = this.known.size;
        onProgress({ ...this.stats, lastTimestamp });

        if (limitReached) break;

        // Topping up a library already walked to the end: the new photos are at
        // the head, so once several pages in a row are entirely known there is
        // nothing left to find. The library is still fully covered, and the
        // cursor must keep saying so rather than parking mid-way.
        if (plan.reason === 'completed' && barrenPages >= this.opts.knownPagesBeforeStop) {
          reachedEnd = true;
          break;
        }

        if (!page.nextPageId) {
          reachedEnd = true;
          break;
        }
        pageId = page.nextPageId;
        // Once paging by cursor the timestamp is no longer a starting point but
        // a filter Google would re-apply from scratch; the cursor carries the
        // position on its own.
        beforeTimestamp = null;
      }
    } catch (err) {
      error = err;
    }

    // Sizes are an enrichment, so a failure there must not lose the listing.
    const sized = await Promise.allSettled(sizeJobs);
    for (const s of sized) {
      if (s.status === 'fulfilled' && s.value) {
        this.stats.sized += s.value.count;
        this.stats.bytes += s.value.bytes;
      }
    }

    await this.saveCursor({ lastTimestamp, pageId, reachedEnd });
    this.running = false;

    return {
      discovered: this.fresh.size,
      known: this.known.size,
      pages: this.stats.pages,
      requests: this.stats.requests,
      retries: this.stats.retries,
      skippedRecent: this.stats.skippedRecent,
      skippedNoThumb: this.stats.skippedNoThumb,
      alreadyKnown: this.stats.alreadyKnown,
      sized: this.stats.sized,
      bytes: this.stats.bytes,
      lastTimestamp,
      reachedEnd,
      limitReached,
      aborted: this.aborted,
      resumedFrom: plan.reason,
      error
    };
  }

  /**
   * One page, retried on the failures worth retrying.
   *
   * A rotated request token reads as an authorisation failure; asking the page
   * for a fresh one costs a round trip and saves a reload, so it is tried once
   * before giving up. Everything else backs off: Google rate-limits, and
   * hammering it is how a listing turns into a lockout.
   */
  async fetchPage({ beforeTimestamp, pageId }) {
    let lastError = null;
    for (let attempt = 0; attempt <= this.opts.maxRetries; attempt++) {
      if (this.aborted) throw new ApiError('cancelled', { kind: 'network' });
      try {
        this.stats.requests++;
        return await listPage(this.tokens, {
          beforeTimestamp,
          pageId,
          pageSize: this.opts.pageSize,
          source: this.opts.source,
          fetchImpl: this.opts.fetchImpl,
          signal: this.controller?.signal
        });
      } catch (err) {
        lastError = err;
        const kind = err instanceof ApiError ? err.kind : 'network';
        if (kind === 'auth' && attempt === 0) {
          this.tokens = await this.deps.refreshTokens().catch(() => this.tokens);
          continue;
        }
        // A malformed response is not a transient failure: retrying it four
        // times only delays telling the user that the format has changed.
        if (kind === 'shape') throw err;
        if (attempt === this.opts.maxRetries) break;
        this.stats.retries++;
        await sleep(this.opts.retryBaseMs * Math.pow(2, attempt));
      }
    }
    throw lastError;
  }

  /** File name and byte size for a batch just listed. */
  async fillSizes(ids) {
    if (!ids.length) return { count: 0, bytes: 0 };
    let infos;
    try {
      infos = await batchInfoAll(this.tokens, ids, {
        fetchImpl: this.opts.fetchImpl,
        signal: this.controller?.signal
      });
    } catch {
      return { count: 0, bytes: 0 };
    }
    const rows = [];
    let bytes = 0;
    for (const info of infos) {
      if (!info?.mediaKey) continue;
      bytes += info.spaceTaken || info.size || 0;
      rows.push({
        id: info.mediaKey,
        fileName: info.fileName,
        // The label is what the grid shows under a tile; the file name is the
        // only human-readable thing the API offers, so it stands in.
        label: info.fileName,
        sizeBytes: info.size ?? null,
        spaceTaken: info.spaceTaken ?? null,
        takesUpSpace: info.takesUpSpace === null ? null : (info.takesUpSpace ? 1 : 0),
        isOriginalQuality: info.isOriginalQuality === null ? null : (info.isOriginalQuality ? 1 : 0)
      });
    }
    if (rows.length) await this.deps.upsertItems(rows);
    return { count: rows.length, bytes };
  }

  async saveCursor({ lastTimestamp, pageId, reachedEnd }) {
    try {
      await this.deps.setMeta(CURSOR_KEY, {
        olderThanTs: this.opts.olderThanTs ?? null,
        lastTimestamp: reachedEnd ? null : lastTimestamp,
        pageId: reachedEnd ? null : pageId,
        reachedEnd,
        known: this.known.size,
        updatedAt: Date.now()
      });
    } catch {
      // A cursor that fails to save only costs the resume benefit.
    }
  }
}

/** Clear the cursor: the next listing restarts from the top. */
export async function resetCursor() {
  await setMeta(CURSOR_KEY, null);
}

export function readCursor() {
  return getMeta(CURSOR_KEY, null);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
