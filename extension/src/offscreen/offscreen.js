/**
 * Offscreen document: hosts the pool of analysis workers.
 *
 * Why not create workers from the content script? The page CSP may forbid
 * `worker-src blob:` and `chrome-extension://` URLs. An offscreen document
 * belongs to the extension: its CSP is ours, and it keeps `host_permissions`,
 * so thumbnail fetches need no CORS preflight.
 */

import { detect, startPool, poolStatus } from '../analysis/face-pool.js';
import { analysePhoto } from '../analysis/people-runner.js';
import {
  MODEL as RECOGNITION_MODEL, downloadModel, modelPresent, forgetModel,
  startPool as startRecognitionPool, poolStatus as recognitionStatus
} from '../analysis/recognize-pool.js';

/*
 * Photos in flight, and the workers that carry them — two different numbers.
 *
 * A photo's life here is mostly waiting: fetch the thumbnail, decode it,
 * measure it (~2.7ms of CPU), then wait again on the detection pool. So what
 * decides throughput is how many photos are in flight, and a worker is a poor
 * unit for that: it costs a JS realm and spends nearly all its time idle.
 *
 * Measured on a live library over a warm connection:
 *
 *   16 in flight → 92 img/s    48 in flight → 154 img/s
 *   24 in flight → 138 img/s   96 in flight → 159 img/s
 *
 * Rising steeply to about 48, then flat. An earlier measurement put the
 * ceiling at 16, which was wrong: it was taken on a cold connection, and the
 * pool was sized to that mistake.
 *
 * Each worker therefore carries several jobs at once. It is safe to: every
 * message it handles is independent, replies carry their own job id, and its
 * detection requests are keyed per call. Concurrency now costs a queue slot
 * rather than a thread.
 */
const HW = navigator.hardwareConcurrency || 4;
// Decoding and measuring are the only real CPU here, so the target scales with
// the machine — but stays well above core count, because it is the network
// being kept busy rather than the processor.
const TARGET_INFLIGHT = Math.max(16, Math.min(48, HW * 3));
const WORKER_COUNT = Math.max(4, Math.min(12, HW));
const SLOTS_PER_WORKER = Math.max(1, Math.ceil(TARGET_INFLIGHT / WORKER_COUNT));
const JOB_TIMEOUT_MS = 45000;
const MAX_RESPAWNS = WORKER_COUNT * 3;

/** `{ worker, inflight }` — how many jobs each one is currently carrying. */
const crew = [];
const queue = [];
const pending = new Map();
let jobSeq = 0;
let respawns = 0;
let fatalError = null;

/** The worker with the most free slots, or null when all are full. */
function freeSlot() {
  let best = null;
  for (const entry of crew) {
    if (entry.inflight >= SLOTS_PER_WORKER) continue;
    if (!best || entry.inflight < best.inflight) best = entry;
  }
  return best;
}

function entryOf(worker) {
  return crew.find((e) => e.worker === worker) || null;
}

function spawn() {
  const worker = new Worker(new URL('../analysis/worker.js', import.meta.url), { type: 'module' });

  worker.onmessage = (ev) => {
    const msg = ev.data || {};

    // A detection request means that photo is still in progress, so its slot
    // must NOT be released here.
    if (msg.type === 'detect') {
      handleDetect(worker, msg);
      return;
    }

    const job = pending.get(msg.jobId);
    if (job) finish(job, msg);
    // Free the slot, not the worker: it may still be carrying other photos.
    const entry = entryOf(worker);
    if (entry) entry.inflight = Math.max(0, entry.inflight - 1);
    pump();
  };

  worker.onerror = (err) => {
    // `onerror` mostly signals a module load failure, leaving the worker
    // unusable. Replace it, or the pool drains silently and the queue never
    // empties.
    const message = err?.message || 'worker error';
    err?.preventDefault?.();

    for (const job of [...pending.values()]) {
      if (job.worker === worker) finish(job, { jobId: job.jobId, ok: false, error: message });
    }
    recycle(worker);

    if (respawns > MAX_RESPAWNS && !fatalError) {
      // Replacement quota exhausted: the module itself is broken. Drain the
      // queue with an error rather than leave callers waiting forever.
      fatalError = `Analysis engine unavailable (${message})`;
      drainQueue();
    }
    pump();
  };

  return worker;
}

for (let i = 0; i < WORKER_COUNT; i++) crew.push({ worker: spawn(), inflight: 0 });

/**
 * Answer a worker's detection request.
 *
 * Always replies, even on failure: a worker awaiting an answer that never comes
 * would hold its analysis open until the job timeout, stalling a pool slot for
 * 45 seconds. A `null` result tells it to fall back to the heuristic.
 */
async function handleDetect(worker, msg) {
  let result = null;
  let error = null;
  try {
    result = await detect(msg.tensor, msg.pad, msg.scoreThreshold);
  } catch (err) {
    error = String(err?.message || err);
  }
  worker.postMessage({ type: 'detect-result', rpcId: msg.rpcId, result, error });
}

function finish(job, result) {
  pending.delete(job.jobId);
  clearTimeout(job.timer);
  job.resolve(result);
}

/**
 * Replace a worker considered lost, within a quota.
 *
 * Everything it was carrying goes with it, so its whole slot count is released
 * rather than decremented — the replacement starts empty.
 */
function recycle(worker) {
  if (!worker) return;
  const i = crew.findIndex((e) => e.worker === worker);
  if (i !== -1) crew.splice(i, 1);
  worker.terminate();
  if (respawns++ < MAX_RESPAWNS) {
    crew.push({ worker: spawn(), inflight: 0 });
    pump();
  }
}

function drainQueue() {
  while (queue.length) {
    const job = queue.shift();
    clearTimeout(job.timer);
    job.resolve({ jobId: job.jobId, ok: false, error: fatalError });
  }
}

function pump() {
  while (queue.length) {
    const entry = freeSlot();
    if (!entry) return;
    const job = queue.shift();
    entry.inflight++;
    job.worker = entry.worker;
    pending.set(job.jobId, job);
    entry.worker.postMessage({ jobId: job.jobId, item: job.item });
  }
}

function submit(item) {
  return new Promise((resolve) => {
    const jobId = `j${++jobSeq}`;
    if (fatalError) return resolve({ jobId, ok: false, error: fatalError });

    const job = { jobId, item, resolve };
    // Without a deadline, one hung request would block the whole batch, and
    // therefore the UI waiting on that batch.
    job.timer = setTimeout(() => {
      if (pending.has(jobId)) {
        pending.delete(jobId);
        job.resolve({ jobId, ok: false, error: 'timed out' });
        // A worker that stopped answering never frees the slots it holds;
        // without a replacement the pool bleeds capacity job by job until it
        // deadlocks. `recycle` drops the whole worker, releasing all of them at
        // once, so there is no separate decrement to do here.
        recycle(job.worker);
      } else {
        const i = queue.indexOf(job);
        if (i !== -1) queue.splice(i, 1);
        job.resolve({ jobId, ok: false, error: 'timed out while queued' });
      }
    }, JOB_TIMEOUT_MS);

    queue.push(job);
    pump();
  });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'offscreen') return false;

  if (msg.type === 'ANALYZE_BATCH') {
    // The per-photo timing rides back on the features and is summed here, then
    // stripped: it answers "where does the time go" and has no business being
    // written into the catalogue.
    const spent = { fetch: 0, decode: 0, features: 0, detect: 0, photos: 0 };
    Promise.all(
      msg.items.map((item) =>
        submit(item).then((r) => {
          const features = r.features;
          if (features?._spent) {
            for (const phase of ['fetch', 'decode', 'features', 'detect']) {
              spent[phase] += features._spent[phase] || 0;
            }
            spent.photos++;
            delete features._spent;
          }
          return { id: item.id, ok: !!r.ok, features, error: r.error };
        })
      )
    ).then((results) => sendResponse({ ok: true, results, spent }));
    return true; // async reply
  }

  if (msg.type === 'PEOPLE_STATUS') {
    modelPresent().then((present) => sendResponse({
      ok: true, present, model: RECOGNITION_MODEL, pool: recognitionStatus()
    }));
    return true;
  }

  if (msg.type === 'PEOPLE_DOWNLOAD') {
    // Progress goes out as its own message rather than on the reply: the reply
    // resolves once, at the end, and a 13 MB download on a slow link is long
    // enough that a silent button reads as a crash.
    downloadModel(({ received, total }) => {
      chrome.runtime.sendMessage({ type: 'PEOPLE_PROGRESS', received, total }).catch(() => {});
    })
      .then((r) => startRecognitionPool().then((n) => sendResponse({ ok: n > 0, ...r, workers: n })))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg.type === 'PEOPLE_FORGET') {
    forgetModel().then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: true }));
    return true;
  }

  if (msg.type === 'PEOPLE_BATCH') {
    // Parallel across the photos of a batch, and each photo fans its own faces
    // out across the recognition pool. The comment here used to claim that
    // second part while `analysePhoto` awaited each face in turn.
    Promise.all(msg.items.map((item) => analysePhoto(item)))
      .then((results) => sendResponse({ ok: true, results }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }

  if (msg.type === 'PING') {
    // Starting the pool here rather than on the first photo keeps the first
    // batch from paying the session start.
    startPool().then(() => {
      sendResponse({
        ok: !fatalError,
        error: fatalError,
        pool: TARGET_INFLIGHT,
        workers: WORKER_COUNT,
        idle: crew.reduce((n, e) => n + (SLOTS_PER_WORKER - e.inflight), 0),
        queued: queue.length,
        faceModel: poolStatus()
      });
    });
    return true;
  }

  return false;
});
