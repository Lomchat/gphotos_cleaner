/**
 * One face-recognition worker: owns a single ONNX session and turns 112x112
 * face patches into identity vectors.
 *
 * The model is not vendored. InsightFace weights are licensed for
 * non-commercial research use, and this repository is MIT — shipping the file
 * would redistribute it under terms the repository cannot grant. It is fetched
 * once, on an explicit action by the user, and cached locally from then on.
 *
 * Runtime: onnxruntime-web (MIT), vendored.
 */

import { openModelCache, readModel } from './model-cache.js';

const VENDOR = new URL('../../vendor/', import.meta.url).href;
const SIZE = 112;

let session = null;
let inputName = 'input';

self.onmessage = async (ev) => {
  const msg = ev.data || {};

  if (msg.type === 'init') {
    try {
      const bytes = await readModel(await openModelCache(), msg.modelKey);
      if (!bytes) throw new Error('model not downloaded yet');

      const ort = await import(`${VENDOR}onnxruntime/ort.wasm.bundle.min.mjs`);
      ort.env.wasm.wasmPaths = `${VENDOR}onnxruntime/`;
      // No cross-origin isolation here, so SharedArrayBuffer is unavailable and
      // extra threads do nothing. Throughput comes from running several of
      // these workers, not from threading one.
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';

      session = await ort.InferenceSession.create(new Uint8Array(bytes), {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all'
      });
      inputName = session.inputNames[0];
      self.ortTensor = ort.Tensor;
      self.postMessage({ type: 'ready', dim: session.outputMetadata?.[0]?.dims?.at(-1) ?? null });
    } catch (err) {
      self.postMessage({ type: 'init-failed', error: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === 'embed') {
    if (!session) {
      self.postMessage({ type: 'embed-result', rpcId: msg.rpcId, error: 'no session' });
      return;
    }
    try {
      const out = await session.run({
        [inputName]: new self.ortTensor('float32', msg.tensor, [1, 3, SIZE, SIZE])
      });
      const raw = out[session.outputNames[0]].data;

      // Normalised here rather than by the caller: the vector crosses a
      // postMessage boundary and every consumer needs it on the unit sphere.
      // Doing it once, at the source, removes a step someone can forget.
      let sum = 0;
      for (let i = 0; i < raw.length; i++) sum += raw[i] * raw[i];
      const norm = Math.sqrt(sum) || 1;
      const vector = new Float32Array(raw.length);
      for (let i = 0; i < raw.length; i++) vector[i] = raw[i] / norm;

      self.postMessage({ type: 'embed-result', rpcId: msg.rpcId, vector }, [vector.buffer]);
    } catch (err) {
      self.postMessage({ type: 'embed-result', rpcId: msg.rpcId, error: String(err?.message || err) });
    }
  }
};
