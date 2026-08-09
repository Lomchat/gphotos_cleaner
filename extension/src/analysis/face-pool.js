/**
 * Pool of face-detection workers, hosted by the offscreen document.
 *
 * Sizing comes from measurement in Chrome, not from a guess. One session runs
 * ~9 images per second; throughput scales almost linearly with workers (2 → 18,
 * 4 → 38, 6 → 51). A single shared session would have capped the whole pipeline
 * at roughly sixteen minutes for ten thousand photos.
 *
 * The pool stays smaller than the fetch pool on purpose: detection is CPU-bound
 * while fetching is not, and each session carries its own WebAssembly heap.
 */

const POOL_SIZE = Math.max(2, Math.min(6, Math.round((navigator.hardwareConcurrency || 4) / 4)));

const idle = [];
const queue = [];
const waiting = new Map();
let started = null;
let unavailable = null;
let seq = 0;

function spawn() {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./face-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'ready') {
        resolve(worker);
        return;
      }
      if (msg.type === 'init-failed') {
        worker.terminate();
        resolve(null);
        return;
      }
      if (msg.type === 'detect-result') {
        const pending = waiting.get(msg.rpcId);
        if (pending) {
          waiting.delete(msg.rpcId);
          pending(msg.error ? null : msg.result);
        }
        idle.push(worker);
        pump();
      }
    };
    worker.onerror = () => resolve(null);
    worker.postMessage({ type: 'init' });
  });
}

/**
 * Start the pool once. A total failure is remembered, not retried per photo:
 * if WebAssembly is blocked or the model is missing, every call must fall back
 * to the heuristic immediately rather than pay a failed load ten thousand times.
 */
export function startPool() {
  if (started) return started;
  started = (async () => {
    const workers = (await Promise.all(
      Array.from({ length: POOL_SIZE }, () => spawn())
    )).filter(Boolean);

    if (!workers.length) {
      unavailable = 'face model unavailable (WebAssembly blocked, or model missing)';
      return 0;
    }
    idle.push(...workers);
    pump();
    return workers.length;
  })();
  return started;
}

function pump() {
  while (idle.length && queue.length) {
    const worker = idle.pop();
    const job = queue.shift();
    waiting.set(job.rpcId, job.resolve);
    worker.postMessage(
      { type: 'detect', rpcId: job.rpcId, tensor: job.tensor, pad: job.pad, scoreThreshold: job.scoreThreshold },
      [job.tensor.buffer]
    );
  }
}

/**
 * @returns {Promise<object|null>} null when detection is unavailable, so the
 *          caller falls back instead of failing the photo.
 */
export async function detect(tensor, pad, scoreThreshold = 0.6) {
  const n = await startPool();
  if (!n) return null;
  return new Promise((resolve) => {
    queue.push({ rpcId: `f${++seq}`, tensor, pad, scoreThreshold, resolve });
    pump();
  });
}

export function poolStatus() {
  return {
    model: 'UltraFace RFB-320',
    size: POOL_SIZE,
    ready: idle.length + waiting.size,
    queued: queue.length,
    error: unavailable
  };
}
