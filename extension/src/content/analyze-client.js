/**
 * Analysis client: sends thumbnails to the engine (offscreen document, via the
 * service worker) and persists the results.
 *
 * This step is almost entirely network-bound: feature extraction takes ~1.5ms
 * per image against tens of milliseconds to download the thumbnail. Throughput
 * therefore depends on requests in flight, not on compute.
 *
 * Hence several batches in flight at all times. Sequential sending would wait
 * for the slowest thumbnail of each batch before starting the next, leaving the
 * engine idle through every trough.
 *
 * Two modes: one-shot (process what the database holds, then stop) and
 * continuous (keep refilling while the scan can still produce new items, so
 * both stages run together).
 *
 * Database and engine access go through injectable `deps`: the refill loop,
 * budget accounting and abort handling are the easiest parts to break
 * unnoticed, and deserve testing outside the browser.
 */

import { getPending as dbGetPending, saveFeatures as dbSaveFeatures } from './db.js';
import { sleep as realSleep } from './tiles.js';
import { sendMessage, isContextLost } from './runtime.js';

const DEFAULTS = {
  batchSize: 24,
  inflightBatches: 3,
  maxPerPass: Infinity,
  idleWaitMs: 700
};

export class Analyzer {
  constructor(options = {}) {
    const { deps, ...opts } = options;
    this.opts = { ...DEFAULTS, ...opts };
    this.deps = {
      getPending: dbGetPending,
      saveFeatures: dbSaveFeatures,
      sendBatch: (items) => defaultSendBatch(items, this.deps.sleep),
      sleep: realSleep,
      ...deps
    };
    this.running = false;
    this.aborted = false;
    this.stats = { done: 0, failed: 0, total: 0, spent: emptySpent() };
  }

  /**
   * Accumulate where the time went.
   *
   * These are worker-seconds, not wall-clock: several run at once, so they add
   * up to more than the run took. That is the point — the ratio between them is
   * what says which phase to attack, and the total says how much room there is.
   */
  addSpent(spent) {
    for (const phase of ['fetch', 'decode', 'features', 'detect', 'photos']) {
      this.stats.spent[phase] += spent[phase] || 0;
    }
  }

  abort() {
    this.aborted = true;
  }

  /**
   * Adjust concurrency mid-run. Used to throttle analysis during a concurrent
   * scan: both compete for the same link, and starving the grid would slow the
   * scan — the one stage that cannot be parallelised.
   */
  setInflight(n) {
    this.opts.inflightBatches = Math.max(1, n | 0);
  }

  async engineStatus() {
    try {
      return await sendMessage({ type: 'ENGINE_STATUS' });
    } catch (err) {
      return { ok: false, error: String(err?.message || err) };
    }
  }

  /**
   * @param {(stats)=>void} onProgress
   * @param {{waitForMore?: () => boolean}} [options]
   *        `waitForMore` returns true while new items may still appear (scan in
   *        progress). Omit it for one-shot mode.
   */
  async run(onProgress = () => {}, { waitForMore = null } = {}) {
    if (this.running) throw new Error('An analysis is already running');
    this.running = true;
    this.aborted = false;
    this.stats = { done: 0, failed: 0, total: 0, spent: emptySpent() };

    let budget = this.opts.maxPerPass;

    try {
      while (!this.aborted && budget > 0) {
        // A refill chunk covers two full concurrency rounds: enough that the
        // queue never empties between database reads, without holding a long
        // list of items in advance.
        const chunkSize = Math.min(budget, this.opts.batchSize * this.opts.inflightBatches * 2);
        const pending = await this.deps.getPending(chunkSize);

        if (!pending.length) {
          if (waitForMore && waitForMore() && !this.aborted) {
            await this.deps.sleep(this.opts.idleWaitMs);
            continue;
          }
          break;
        }

        budget -= pending.length;
        this.stats.total += pending.length;
        onProgress({ ...this.stats, streaming: !!waitForMore });

        await this.processChunk(pending, onProgress, !!waitForMore);
      }
      return { ...this.stats, aborted: this.aborted };
    } finally {
      this.running = false;
    }
  }

  /** Process one refill chunk with `inflightBatches` requests in flight. */
  async processChunk(pending, onProgress, streaming) {
    const batches = [];
    for (let i = 0; i < pending.length; i += this.opts.batchSize) {
      batches.push(
        pending.slice(i, i + this.opts.batchSize).map((it) => ({
          id: it.id,
          url: it.url,
          urlRaw: it.urlRaw || null
        }))
      );
    }

    // `next` is shared between runners: execution being single-threaded,
    // `next++` is indivisible and acts as the queue.
    let next = 0;
    let fatal = null;

    const runners = Array.from(
      { length: Math.min(this.opts.inflightBatches, batches.length) },
      async () => {
        while (!this.aborted && !fatal) {
          const index = next++;
          if (index >= batches.length) return;
          try {
            const reply = await this.deps.sendBatch(batches[index]);
            const results = reply.results || reply;
            if (reply.spent) this.addSpent(reply.spent);
            await this.deps.saveFeatures(results);
            for (const r of results) {
              if (r.ok) this.stats.done++;
              else this.stats.failed++;
            }
            onProgress({ ...this.stats, streaming });
          } catch (err) {
            // Capturing the error here rather than letting it reject also
            // stops the other runners; otherwise `Promise.all` would return
            // while they kept writing to the database and notifying a UI that
            // is no longer listening.
            fatal = fatal || err;
            return;
          }
        }
      }
    );

    await Promise.all(runners);
    if (fatal) throw fatal;
  }
}

function emptySpent() {
  return { fetch: 0, decode: 0, features: 0, detect: 0, photos: 0 };
}

/**
 * One round-trip to the engine, retried if the service worker was recycled.
 *
 * A recycled worker is transient and worth a second attempt. A reloaded
 * extension is not — it will fail identically forever — so that case is
 * reported straight away, with the only instruction that helps.
 */
async function defaultSendBatch(items, sleep) {
  let res;
  try {
    res = await sendMessage({ type: 'ANALYZE_BATCH', items });
  } catch (first) {
    if (isContextLost(first)) throw first;
    await sleep(400);
    try {
      res = await sendMessage({ type: 'ANALYZE_BATCH', items });
    } catch (err) {
      if (isContextLost(err)) throw err;
      throw new Error(
        `Analysis engine unreachable (${String(err?.message || err)}). Reload the page.`
      );
    }
  }
  if (!res?.ok) throw new Error(res?.error || 'Invalid reply from the analysis engine');
  return res;
}
