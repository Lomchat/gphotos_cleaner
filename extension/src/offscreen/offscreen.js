/**
 * Offscreen document: hosts the pool of analysis workers.
 *
 * Why not create workers from the content script? The page CSP may forbid
 * `worker-src blob:` and `chrome-extension://` URLs. An offscreen document
 * belongs to the extension: its CSP is ours, and it keeps `host_permissions`,
 * so thumbnail fetches need no CORS preflight.
 */

import { detect, startPool, poolStatus } from '../analysis/face-pool.js';

/*
 * Sized for the network, not the CPU: these workers spend most of their time
 * waiting on a thumbnail (tens of ms) and only ~1.5ms on the classical
 * measurements. Capping at core count would leave the link idle. Face detection
 * is CPU-bound and lives in its own, smaller pool.
 */
const POOL_SIZE = Math.max(8, Math.min(16, (navigator.hardwareConcurrency || 4) * 2));
const JOB_TIMEOUT_MS = 45000;
const MAX_RESPAWNS = POOL_SIZE * 3;

const idle = [];
const queue = [];
const pending = new Map();
let jobSeq = 0;
let respawns = 0;
let fatalError = null;

function spawn() {
  const worker = new Worker(new URL('../analysis/worker.js', import.meta.url), { type: 'module' });

  worker.onmessage = (ev) => {
    const msg = ev.data || {};

    // A detection request means the worker is mid-analysis and still busy, so
    // it must NOT go back to the idle pool here.
    if (msg.type === 'detect') {
      handleDetect(worker, msg);
      return;
    }

    const job = pending.get(msg.jobId);
    if (job) finish(job, msg);
    idle.push(worker);
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

for (let i = 0; i < POOL_SIZE; i++) idle.push(spawn());

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

/** Replace a worker considered lost, within a quota. */
function recycle(worker) {
  if (!worker) return;
  const i = idle.indexOf(worker);
  if (i !== -1) idle.splice(i, 1);
  worker.terminate();
  if (respawns++ < MAX_RESPAWNS) {
    idle.push(spawn());
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
  while (idle.length && queue.length) {
    const worker = idle.pop();
    const job = queue.shift();
    job.worker = worker;
    pending.set(job.jobId, job);
    worker.postMessage({ jobId: job.jobId, item: job.item });
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
        // A worker that stopped answering never returns to `idle`; without a
        // replacement the pool drains job by job until it deadlocks.
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
    Promise.all(
      msg.items.map((item) =>
        submit(item).then((r) => ({
          id: item.id,
          ok: !!r.ok,
          features: r.features,
          error: r.error
        }))
      )
    ).then((results) => sendResponse({ ok: true, results }));
    return true; // async reply
  }

  if (msg.type === 'PING') {
    // Starting the pool here rather than on the first photo keeps the first
    // batch from paying the session start.
    startPool().then(() => {
      sendResponse({
        ok: !fatalError,
        error: fatalError,
        pool: POOL_SIZE,
        idle: idle.length,
        queued: queue.length,
        faceModel: poolStatus()
      });
    });
    return true;
  }

  return false;
});
