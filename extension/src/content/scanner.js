/**
 * Library scanning.
 *
 * The Google Photos grid is virtualised: only a few hundred tiles exist in the
 * DOM at once, the rest are recycled. So we harvest while scrolling, recording
 * for each item the scroll offset where it was seen — a landmark used later to
 * bring it back on screen without re-scanning the whole page.
 *
 * The tricky part is knowing when the grid has finished painting. "Nothing is
 * moving" is ambiguous: mid-list it means rendering is done, at the bottom it
 * means the next page has not loaded yet. Conflating the two makes the scanner
 * wrongly conclude the library is exhausted and stop after a few hundred items.
 * Hence the referenced wait (wait for a change *then* for it to settle) and
 * growing patience at the bottom.
 */

import * as dom from './dom-adapter.js';
import { upsertItems, getAllIds, getIdsMissingThumb, getMeta, setMeta } from './db.js';

export const CURSOR_KEY = 'scanCursor';

const DEFAULTS = {
  stepRatio: 0.82,       // fraction of the viewport crossed per step
  settleMinMs: 45,       // minimum delay before probing the render
  settleMaxMs: 1500,     // base wait budget for one step
  backoffCapMs: 9000,    // wait ceiling when loading drags
  pollMs: 35,            // render polling interval
  quietPolls: 2,         // identical polls in a row meaning "settled"
  maxIdleRounds: 8,      // fruitless rounds before giving up
  topUpIdleRounds: 4,    // same, when only picking up new items at the top
  bottomPatience: 5,     // rounds to wait at the bottom before calling it done
  maxNewItems: Infinity, // pass size, in previously unseen items
  waitForThumbs: true,   // wait for images before moving on
  thumbTarget: 0.9,      // coverage aimed for before scrolling again
  // Budget for one stop. It has to scale with how many images are actually
  // missing: a fixed five seconds is generous for the forty tiles of an
  // unzoomed screen and hopeless for the three hundred of a zoomed-out one,
  // where it expires every time and the whole screenful is harvested blind.
  thumbWaitBaseMs: 2500,
  thumbWaitPerImageMs: 45,
  thumbWaitMaxMs: 20000, // ceiling, whatever the arithmetic says
  thumbPollMs: 110,      // coverage polling (pricier than a plain count)
  // How far past the viewport still counts as "waited for". Matches the margin
  // thumbCoverage uses, so the region harvested is the region measured.
  harvestMargin: 0.25,
  // Stops in a row that yielded no usable thumbnail at all before concluding
  // that Google is not delivering images and stopping with an explanation.
  // Grinding on produces a catalogue of items that can never be analysed.
  starvedStopsBeforeGivingUp: 6,
  // Above this many items missing a thumbnail, restart from the top instead of
  // resuming: they sit behind the cursor and a forward pass never reaches them.
  repairFromTopThreshold: 200,
  thumbStallMs: 1200,    // quiet time meaning "no more images are coming"
  coverage: null,        // seam: how loaded the grid is, for tests
  thumbGiveUpRatio: 0.5, // ...but only once at least half have arrived
  olderThanTs: null,     // only handle items older than this date
  seekStepRatio: 2.2,    // wider step while crossing the out-of-scope zone
  seekBacktrack: 1.6,    // step back when crossing the boundary
  thumbSize: 176,
  resume: true,
  overlapRatio: 1.0      // screen heights re-covered when resuming
};

/**
 * Decide where to restart. Pure and isolated so it can be tested: this is the
 * logic easiest to break without noticing.
 *
 * @returns {{startTop:number, reason:string}}
 */
export function planResume(cursor, metrics, opts) {
  if (!opts.resume) return { startTop: 0, reason: 'top-disabled' };

  // A large backlog of items recorded without a thumbnail can only be repaired
  // by passing them again, and they lie *behind* the cursor — a resumed run
  // moves forward and never touches them. So a backlog this size takes
  // priority over resuming: the pass starts from the top, re-reads them along
  // the way, and dedup by id makes the second look cheap.
  if ((opts.pendingRepairs || 0) >= opts.repairFromTopThreshold) {
    return { startTop: 0, reason: 'top-repair' };
  }

  if (!cursor || !Number.isFinite(cursor.scrollTop) || cursor.scrollTop <= 0) {
    return { startTop: 0, reason: 'top-no-cursor' };
  }
  // A library already walked to the end grows from the top: Google Photos puts
  // recent additions at the head of the grid.
  if (cursor.reachedEnd) return { startTop: 0, reason: 'top-completed' };

  // The grid reflows with window width and zoom level, so a saved offset does
  // not point at exactly the same photos next session. Restart earlier and let
  // id-based dedup absorb the overlap.
  const overlap = metrics.clientHeight * Math.max(0, opts.overlapRatio);
  const maxTop = Math.max(0, metrics.scrollHeight - metrics.clientHeight);
  return {
    startTop: Math.max(0, Math.min(cursor.scrollTop - overlap, maxTop)),
    reason: 'resume'
  };
}

/**
 * Time window: only handle items older than a date.
 *
 * That is the useful direction for cleaning — purge the old, keep the recent.
 * Since the grid runs newest to oldest, the scan first crosses an out-of-scope
 * zone ("seeking"), then collects everything to the end of the library.
 *
 * An item with an unreadable date is **kept** rather than dropped: better to
 * offer something uncertain than to lose items silently. It does not flip the
 * phase to collecting, though, or one accident would end seeking early.
 */
export class DateWindow {
  constructor(olderThanTs) {
    this.olderThanTs = olderThanTs ?? null;
    this.sawInRange = false;
  }

  get active() {
    return this.olderThanTs != null;
  }

  /** True while crossing the recent, out-of-scope zone. */
  get seeking() {
    return this.active && !this.sawInRange;
  }

  /** @returns {'keep'|'skip'} should this item be recorded? */
  consider(ts) {
    if (!this.active) return 'keep';
    if (ts == null) return 'keep';
    if (ts < this.olderThanTs) {
      this.sawInRange = true;
      return 'keep';
    }
    return 'skip';
  }
}

export class Scanner {
  constructor(options = {}) {
    this.opts = { ...DEFAULTS, ...options };
    this.known = new Set();       // everything already in the catalogue
    this.fresh = new Set();       // new items found during THIS pass
    this.repairable = new Set();  // recorded but missing a thumbnail URL
    this.lastGroupDate = null;    // last date header seen
    this.lastItemDate = null;     // last date read from a tile
    this.window = new DateWindow(this.opts.olderThanTs);
    this.running = false;
    this.aborted = false;
    this.stats = {
      discovered: 0,    // new items this pass
      known: 0,         // catalogue size
      rounds: 0,
      skippedRecent: 0, // skipped as newer than the requested date
      noDate: 0,        // no date at all, not even inherited
      dateCarried: 0,   // date inherited from the previous tile
      noUrl: 0,
      withUrl: 0,    // items recorded with a usable thumbnail
      starved: 0,    // consecutive stops that produced no usable thumbnail
      deferred: 0,   // off-screen and imageless: left for a later stop
      repaired: 0,
      seeking: false,    // crossing the out-of-scope zone
      thumbRatio: 1,     // share of rendered tiles that have an image
      thumbBudgetMs: 0,  // wait allowed for one stop, sized from what is missing
      thumbWaitMs: 0,    // time spent waiting for thumbnails
      waitMs: 0          // time actually spent waiting on renders
    };
  }

  /**
   * Progress measure used to detect a stall.
   *
   * Skipping too-recent items IS progress: without counting them, crossing the
   * out-of-scope zone would look like a failure and the scan would stop before
   * reaching the photos it is meant to handle.
   */
  get progressCount() {
    return this.fresh.size + this.stats.skippedRecent + this.stats.repaired;
  }

  abort() {
    this.aborted = true;
  }

  /**
   * @param {(stats)=>void} onProgress
   * @returns {Promise<object>}
   */
  async run(onProgress = () => {}) {
    if (this.running) throw new Error('A scan is already running');
    this.running = true;
    this.aborted = false;

    const scroller = dom.findScroller();
    if (!scroller) {
      this.running = false;
      throw new Error(
        'Scroll container not found. Open the main library view on photos.google.com, then try again.'
      );
    }

    // Without this priming, a resumed scan would count every known item as
    // "new" and burn the pass limit on nothing.
    this.known = new Set(await getAllIds());
    // Items recorded without a thumbnail URL: re-read them in passing, or they
    // stay unanalysable forever.
    this.repairable = await getIdsMissingThumb();
    this.stats.known = this.known.size;
    this.opts.pendingRepairs = this.repairable.size;

    const cursor = this.opts.resume ? await getMeta(CURSOR_KEY, null) : null;
    const plan = planResume(cursor, dom.scrollerMetrics() || { clientHeight: 0, scrollHeight: 0 }, this.opts);

    // When only picking up new items, be less patient: additions can only be
    // at the top, so there is no point grinding through known ground.
    const maxIdle = plan.reason === 'top-completed'
      ? this.opts.topUpIdleRounds
      : this.opts.maxIdleRounds;

    const resumeTop = scroller.scrollTop;
    let idleRounds = 0;
    let reachedBottom = false;
    let starved = false;
    let limitReached = false;

    try {
      scroller.scrollTop = plan.startTop;
      await this.waitForRender();

      while (!this.aborted) {
        const before = this.progressCount;
        const wasSeeking = this.window.seeking;

        // Thumbnails arrive after anchors. Harvesting too early records items
        // with no image, which can never be analysed — the costliest scanning
        // defect, since repairing it means walking everything again. Not needed
        // while crossing the recent zone, where only dates are read.
        if (this.opts.waitForThumbs && !this.window.seeking) {
          await this.waitForThumbs();
        }

        await this.harvest(scroller.scrollTop);
        this.stats.rounds++;

        // Starvation is a property of the page, not of our bookkeeping: tiles
        // rendered, none of them carrying an image. Asking instead whether this
        // stop *recorded* anything was wrong — crossing ground already known
        // records nothing by design, so a repair pass from the top looked like
        // starvation and killed itself after six stops.
        const cov = (this.opts.coverage || dom.thumbCoverage)();
        if (cov.total > 0 && cov.ready === 0) {
          if (++this.stats.starved >= this.opts.starvedStopsBeforeGivingUp) {
            starved = true;
            break;
          }
        } else {
          this.stats.starved = 0;
        }
        this.stats.seeking = this.window.seeking;
        onProgress({ ...this.stats, ...dom.scrollerMetrics() });

        if (this.fresh.size >= this.opts.maxNewItems) {
          limitReached = true;
          break;
        }

        // Boundary crossed: the wider step may have flown over items just
        // above. Go back to cover them before resuming the normal step, or the
        // slice closest to the requested date would be missing, silently.
        if (wasSeeking && !this.window.seeking) {
          const ref = dom.gridSignature();
          dom.scrollBy(-scroller.clientHeight * this.opts.seekBacktrack);
          await this.waitForRender({ reference: ref, budgetMs: this.opts.settleMaxMs });
          idleRounds = 0;
          continue;
        }

        idleRounds = this.progressCount === before ? idleRounds + 1 : 0;
        const m = dom.scrollerMetrics();

        if (m?.atBottom) {
          // Reaching the bottom is not the end: Google loads the next page
          // lazily and the container grows. So wait, longer each time, without
          // scrolling further.
          if (idleRounds >= this.opts.bottomPatience) {
            reachedBottom = true;
            break;
          }
          const ref = dom.gridSignature();
          await this.waitForRender({ reference: ref, budgetMs: this.backoffMs(idleRounds) });
          continue;
        }

        if (idleRounds >= maxIdle) break;

        // Nothing is collected while crossing the out-of-scope zone, so cross
        // it in long strides.
        const ratio = this.window.seeking ? this.opts.seekStepRatio : this.opts.stepRatio;
        const ref = dom.gridSignature();
        dom.scrollBy(Math.max(200, scroller.clientHeight * ratio));
        await this.waitForRender({ reference: ref, budgetMs: this.backoffMs(idleRounds) });
      }

      await this.saveCursor(scroller, reachedBottom);
    } finally {
      this.running = false;
      // Put the user back where they were.
      try { scroller.scrollTop = resumeTop; } catch { /* container replaced */ }
    }

    return {
      discovered: this.fresh.size,
      known: this.known.size,
      repaired: this.stats.repaired,
      noUrl: this.stats.noUrl,
      deferred: this.stats.deferred,
      noDate: this.stats.noDate,
      dateCarried: this.stats.dateCarried,
      thumbRatio: this.stats.thumbRatio,
      thumbBudgetMs: this.stats.thumbBudgetMs,
      skippedRecent: this.stats.skippedRecent,
      // Items harvested per stop. This is the number the zoom setting is
      // supposed to move, so it is reported rather than inferred: a display
      // preference that claims a speed-up should have to show it.
      rounds: this.stats.rounds,
      perRound: this.stats.rounds ? this.fresh.size / this.stats.rounds : 0,
      // Where listing actually spends its time. These two respond to opposite
      // fixes, which is why they are reported separately rather than summed:
      //   waitMs      — settling the grid, roughly fixed per stop, so fewer
      //                 stops (a wider viewport) makes it smaller
      //   thumbWaitMs — waiting for images, roughly per tile, so fewer stops
      //                 does nothing: the same images are waited for either way
      waitMs: this.stats.waitMs,
      thumbWaitMs: this.stats.thumbWaitMs,
      stillSeeking: this.window.seeking,
      reachedBottom,
      starved,
      limitReached,
      aborted: this.aborted,
      resumedFrom: plan.reason
    };
  }

  /** Wait budget, growing while nothing new appears. */
  backoffMs(idleRounds) {
    return Math.min(
      this.opts.backoffCapMs,
      Math.round(this.opts.settleMaxMs * (1 + idleRounds * 1.6))
    );
  }

  async saveCursor(scroller, reachedEnd) {
    try {
      await setMeta(CURSOR_KEY, {
        scrollTop: reachedEnd ? 0 : scroller.scrollTop,
        reachedEnd,
        known: this.known.size,
        clientHeight: scroller.clientHeight,
        scrollHeight: scroller.scrollHeight,
        updatedAt: Date.now()
      });
    } catch {
      // A cursor that fails to save only costs the resume benefit.
    }
  }

  /**
   * Wait for the grid to finish painting.
   *
   * With `reference`, we do not simply wait for stillness: we wait for the
   * signature to CHANGE from that reference, then settle. Without that, a grid
   * that has not started loading looks like one that has finished rendering —
   * exactly what made the scanner call the end of the library too early.
   *
   * @returns {Promise<boolean>} true if a change was observed
   */
  async waitForRender({ reference = null, budgetMs = null } = {}) {
    const budget = budgetMs ?? this.opts.settleMaxMs;
    const started = Date.now();
    await sleep(this.opts.settleMinMs);

    let last = dom.gridSignature();
    let changed = reference == null || last !== reference;
    let quiet = 0;

    while (Date.now() - started < budget) {
      const sig = dom.gridSignature();
      if (sig !== last) {
        last = sig;
        changed = true;
        quiet = 0;
      } else if (changed && ++quiet >= this.opts.quietPolls) {
        break;
      }
      await sleep(this.opts.pollMs);
    }

    this.stats.waitMs += Date.now() - started;
    return changed;
  }

  /**
   * Wait for rendered tiles to have their thumbnails.
   *
   * Not aiming for 100%: some items legitimately have no preview (videos being
   * processed, exotic formats), and waiting for them would stall every round to
   * the ceiling. We also stop as soon as coverage stops improving.
   */
  /**
   * Wait for the images behind the tiles that were just rendered.
   *
   * Tiles arrive before their images, and harvesting in between records items
   * with no thumbnail — the costliest defect here, because repairing one means
   * walking the whole grid again.
   *
   * The early exit exists for the tail: the last image or two that will never
   * come. It used to fire after three quiet polls, about a third of a second,
   * which is shorter than Google takes to deliver the *first* image on a large
   * library — so on a slow grid it triggered before anything had arrived and
   * the five-second budget was never reached. Measured on a real run: 1,836 of
   * 2,000 items harvested with no image at all.
   *
   * Two changes. Quiet time is counted in milliseconds rather than polls, so it
   * does not depend on the polling rate. And giving up early requires most
   * images to be in already: "none have arrived yet" means the page has not
   * started, which is the opposite of "no more are coming".
   */
  async waitForThumbs() {
    const started = Date.now();
    let best = -1;
    let lastGain = Date.now();

    // Sized from what is actually missing right now, not from a constant.
    const first = (this.opts.coverage || dom.thumbCoverage)();
    this.stats.thumbRatio = first.ratio;
    const missing = Math.max(0, first.total - first.ready);
    const budget = Math.min(
      this.opts.thumbWaitMaxMs,
      this.opts.thumbWaitBaseMs + missing * this.opts.thumbWaitPerImageMs
    );
    this.stats.thumbBudgetMs = budget;

    while (Date.now() - started < budget) {
      const cov = (this.opts.coverage || dom.thumbCoverage)();
      this.stats.thumbRatio = cov.ratio;
      if (cov.total === 0 || cov.ratio >= this.opts.thumbTarget) break;

      if (cov.ready > best) {
        best = cov.ready;
        lastGain = Date.now();
      } else if (
        cov.ratio >= this.opts.thumbGiveUpRatio &&
        Date.now() - lastGain >= this.opts.thumbStallMs
      ) {
        break; // the tail is not coming; the rest is here
      }
      await sleep(this.opts.thumbPollMs);
    }
    this.stats.thumbWaitMs += Date.now() - started;
  }

  async harvest(scrollTop) {
    const scroller = dom.findScroller();
    if (!scroller) return;
    const { entries, lastGroupDate } = dom.walkGridInOrder(scroller, this.lastGroupDate);
    this.lastGroupDate = lastGroupDate;
    const batch = [];

    // The region we waited for. Google renders far more tiles than it loads
    // images for, and `waitForThumbs` only ever asked about the visible ones —
    // so harvesting the whole rendered range recorded hundreds of items whose
    // image was never coming. Harvest what was waited for, and let the rest
    // come back on a later stop: consecutive steps overlap by more than 80%,
    // so every tile is visible at some point.
    // Fails open on purpose. Deciding "not waited for" without being able to
    // measure would defer every tile, the pass would collect nothing, and the
    // scan would look like it had simply found an empty library. Recording an
    // item that turns out to have no image is recoverable; collecting nothing
    // at all is not.
    const view = scroller.getBoundingClientRect?.();
    const slack = view ? view.height * this.opts.harvestMargin : 0;
    const inWaitedRegion = (el) => {
      if (!view || !view.height) return true;
      const box = el.getBoundingClientRect?.();
      if (!box || !box.height) return true;
      return box.bottom >= view.top - slack && box.top <= view.bottom + slack;
    };

    for (const { el, groupDate } of entries) {
      // Read the id first: overlap between steps exceeds 80%, and fully
      // reading already-known tiles was most of the work per round.
      const id = dom.tileId(el);
      if (!id) continue;
      const repairing = this.repairable.has(id);
      if (this.known.has(id) && !repairing) {
        // Known tile: re-read only its date, to keep the chronological chain
        // that undated tiles depend on.
        const d = dom.tileDateOnly(el);
        if (d) this.lastItemDate = d;
        continue;
      }

      const read = dom.readTile(el, groupDate);
      if (!read) continue;

      if (read.ts != null) {
        this.lastItemDate = { ts: read.ts, precision: read.precision };
      } else {
        const reporte = inheritDate(read, this.lastItemDate);
        if (reporte) {
          Object.assign(read, reporte);
          this.stats.dateCarried++;
        }
      }

      if (this.window.consider(read.ts) === 'skip') {
        this.stats.skippedRecent++;
        // Marked known so it is not re-read every step, but never stored: it
        // stays out of the catalogue and therefore out of the analysis.
        this.known.add(id);
        continue;
      }

      if (repairing) {
        // Repairing an existing entry: not a discovery, so it must neither
        // count towards the pass nor consume its limit.
        if (!read.url) continue;
        this.repairable.delete(id);
        this.stats.repaired++;
      } else {
        // Not while seeking: that phase takes long strides without waiting for
        // images at all, so its steps can exceed the waited region and a
        // deferred tile might never be passed again.
        if (!read.url && !this.window.seeking && !inWaitedRegion(el)) {
          // Off screen and imageless: Google had no reason to load it yet.
          // Recording it now would spend one of the run's slots on an item
          // that cannot be analysed, and mark it known so nothing revisits it.
          this.stats.deferred++;
          continue;
        }
        this.known.add(read.id);
        this.fresh.add(read.id);
        if (read.url) this.stats.withUrl++;
        if (!read.url) {
          this.stats.noUrl++;
          // Waited for and still no image. Register for repair: it will be
          // re-read next time we pass it, this scan or a later one. Otherwise
          // it counts as "known" and stays unanalysable forever.
          this.repairable.add(read.id);
        }
        if (read.ts == null) this.stats.noDate++;
      }

      batch.push({
        id: read.id,
        url: read.url ? dom.withThumbSize(read.url, this.opts.thumbSize) : null,
        // URL exactly as found in the page: a fallback if the host does not
        // understand the rewritten size suffix.
        urlRaw: read.url || null,
        label: read.label,
        ts: read.ts,
        precision: read.precision,
        dateSource: read.dateSource,
        isVideo: read.isVideo ? 1 : 0,
        duration: read.duration ?? null,
        anchorTop: scrollTop,
        order: this.known.size,
        discoveredAt: Date.now()
      });

      if (this.fresh.size >= this.opts.maxNewItems) break;
    }

    if (batch.length) {
      this.stats.discovered = this.fresh.size;
      this.stats.known = this.known.size;
      await upsertItems(batch);
    }
  }
}

/**
 * Fill a missing date by carrying it from the previous tile.
 *
 * The grid is strictly chronological, so a tile flanked by dated items almost
 * always shares its neighbour's date. Accurate to the day, that beats "unknown
 * date" — which drops the item from statistics and every time filter, making it
 * invisible to sorting.
 *
 * The carry is traced (`dateSource: 'carried'`) so it stays distinguishable
 * from a date actually read.
 */
export function inheritDate(read, lastKnown) {
  if (!read || read.ts != null) return null;
  if (!lastKnown || lastKnown.ts == null) return null;
  return {
    ts: lastKnown.ts,
    precision: lastKnown.precision || 'day',
    dateSource: 'carried'
  };
}

/** Repair attempts after which we give up on an item. */
export const MAX_THUMB_ATTEMPTS = 3;

/**
 * Decide how to recover missing thumbnails. Pure, because it is policy rather
 * than mechanism, and deserves to be readable and tested.
 *
 * It is a cost trade-off: bringing items back on screen one by one costs a
 * second or two each — excellent for a handful, absurd for thousands, where a
 * fresh pass over the grid picks them up far faster.
 *
 * @returns {{mode:'none'|'targeted'|'rescan', count:number}}
 */
export function planThumbRepair({ missing, enabled = true, targetedLimit = 500 }) {
  if (!enabled || missing <= 0) return { mode: 'none', count: missing };
  if (missing <= targetedLimit) return { mode: 'targeted', count: missing };
  return { mode: 'rescan', count: missing };
}

/**
 * Targeted repair: bring each thumbnail-less item back on screen and re-read it
 * once its image arrives.
 *
 * Every attempt is counted, successful or not — an item that will never have a
 * preview has to leave the queue eventually, or it returns on every run.
 */
export async function repairThumbnails(items, options = {}) {
  const {
    thumbSize = 176,
    waitMs = 3000,
    pollMs = 120,
    onProgress = () => {},
    shouldStop = () => false
  } = options;

  const batch = [];
  let repaired = 0;
  let failed = 0;

  for (let i = 0; i < items.length; i++) {
    if (shouldStop()) break;
    const item = items[i];
    const attempts = (item.thumbAttempts || 0) + 1;

    let url = null;
    const tile = await bringIntoView(item, { timeoutMs: 3500 });
    if (tile) {
      const deadline = Date.now() + waitMs;
      while (Date.now() < deadline) {
        url = dom.tileThumbUrl(findTileById(item.id) || tile);
        if (url) break;
        await sleep(pollMs);
      }
    }

    if (url) {
      repaired++;
      batch.push({
        id: item.id,
        url: dom.withThumbSize(url, thumbSize),
        urlRaw: url,
        thumbAttempts: attempts
      });
    } else {
      failed++;
      // No URL: write only the counter, so existing fields are not overwritten
      // with missing values.
      batch.push({ id: item.id, thumbAttempts: attempts });
    }
    onProgress({ done: i + 1, total: items.length, repaired, failed });
  }

  if (batch.length) await upsertItems(batch);
  return { repaired, failed, attempted: repaired + failed };
}

/** Clear the cursor: the next scan restarts from the top. */
export async function resetCursor() {
  await setMeta(CURSOR_KEY, null);
}

export function readCursor() {
  return getMeta(CURSOR_KEY, null);
}

/**
 * Bring a tile back on screen using its recorded scroll landmark, then wait for
 * it to appear in the DOM.
 */
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

  // The grid reflows with window width, so the landmark is approximate. Use it
  // as a starting point, then sweep around it.
  const start = Math.max(0, (item.anchorTop ?? 0) - scroller.clientHeight * 0.3);
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
    // Spiral search around the landmark: +/-0.5, 1, 1.5 screens.
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
