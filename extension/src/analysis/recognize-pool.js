/**
 * Pool of face-recognition workers, plus the one-time model download.
 *
 * Sizing from measurement in Chrome: one session embeds a face in ~148 ms, and
 * throughput scales with workers much as detection does. Six workers put ten
 * thousand photos at roughly four and a half minutes — faster than the local
 * service this replaced, which paid HTTP and JPEG decoding on every photo.
 *
 * Each session carries its own 13 MB of weights, so the pool is kept small.
 */

import {
  openModelCache, readModel, writeModel, hasModel, deleteModel, looksLikeOnnx
} from './model-cache.js';

export const MODEL = {
  key: 'buffalo_s',
  label: 'ArcFace buffalo_s (MobileFaceNet)',
  url: 'https://huggingface.co/immich-app/buffalo_s/resolve/main/recognition/model.onnx',
  bytes: 13616099,
  licence: 'InsightFace weights — non-commercial research use'
};

const POOL_SIZE = Math.max(2, Math.min(6, Math.round((navigator.hardwareConcurrency || 4) / 4)));

const idle = [];
const queue = [];
const waiting = new Map();
let started = null;
let unavailable = null;
let dim = null;
let seq = 0;

/* ------------------------------------------------------------- download */

export async function modelPresent() {
  try {
    return await hasModel(await openModelCache(), MODEL.key);
  } catch {
    return false;
  }
}

/**
 * Fetch the model once, reporting progress.
 *
 * Streamed rather than read in one go so the panel can show a bar: 13 MB on a
 * slow link is long enough that a frozen button reads as a crash.
 */
export async function downloadModel(onProgress) {
  const db = await openModelCache();
  if (await hasModel(db, MODEL.key)) return { cached: true, bytes: MODEL.bytes };

  // No host permission is needed and none is asked for: both the redirect and
  // the CDN answer with permissive CORS headers, so an ordinary cross-origin
  // fetch from the offscreen document succeeds. Widening host_permissions for
  // a once-per-install download would be a permanent cost for a one-off need.
  const response = await fetch(MODEL.url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`download failed: HTTP ${response.status}`);

  const total = Number(response.headers.get('content-length')) || MODEL.bytes;
  const chunks = [];
  let received = 0;

  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.({ received, total });
  }

  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) { bytes.set(chunk, at); at += chunk.length; }

  // A rate limit or a captive portal answers 200 with an HTML page. Caching
  // that would give a permanent failure the user cannot diagnose.
  if (!looksLikeOnnx(bytes.buffer, MODEL.bytes)) {
    throw new Error('the download did not return a model file');
  }

  await writeModel(db, MODEL.key, bytes.buffer, { url: MODEL.url });
  return { cached: false, bytes: received };
}

export async function forgetModel() {
  await deleteModel(await openModelCache(), MODEL.key);
  for (const worker of idle.splice(0)) worker.terminate();
  started = null;
  unavailable = null;
  dim = null;
}

/* ----------------------------------------------------------------- pool */

function spawn() {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./recognize-worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (ev) => {
      const msg = ev.data || {};
      if (msg.type === 'ready') {
        if (msg.dim) dim = msg.dim;
        resolve(worker);
        return;
      }
      if (msg.type === 'init-failed') {
        unavailable = msg.error;
        worker.terminate();
        resolve(null);
        return;
      }
      if (msg.type === 'embed-result') {
        const pending = waiting.get(msg.rpcId);
        if (pending) {
          waiting.delete(msg.rpcId);
          pending(msg.error ? null : msg.vector);
        }
        idle.push(worker);
        pump();
      }
    };
    worker.onerror = () => resolve(null);
    worker.postMessage({ type: 'init', modelKey: MODEL.key });
  });
}

export function startPool() {
  if (started) return started;
  started = (async () => {
    const workers = (await Promise.all(
      Array.from({ length: POOL_SIZE }, () => spawn())
    )).filter(Boolean);
    if (!workers.length) {
      unavailable = unavailable || 'recognition model unavailable';
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
      { type: 'embed', rpcId: job.rpcId, tensor: job.tensor },
      [job.tensor.buffer]
    );
  }
}

/**
 * @returns {Promise<Float32Array|null>} null when recognition is unavailable,
 *          so the caller records "no identity" rather than failing the photo.
 */
export async function embed(tensor) {
  const n = await startPool();
  if (!n) return null;
  return new Promise((resolve) => {
    queue.push({ rpcId: `e${++seq}`, tensor, resolve });
    pump();
  });
}

export function poolStatus() {
  return {
    model: MODEL.label,
    size: POOL_SIZE,
    ready: idle.length + waiting.size,
    queued: queue.length,
    dim,
    error: unavailable
  };
}
