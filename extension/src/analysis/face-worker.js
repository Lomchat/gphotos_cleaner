/**
 * One face-detection worker: owns a single ONNX session and answers detection
 * requests. Several of these run in parallel, because WebAssembly inference is
 * single-threaded here and one session caps throughput at about 9 images per
 * second — measured in Chrome, not extrapolated.
 *
 * Model: UltraFace RFB-320 (MIT). Runtime: onnxruntime-web (MIT). Both vendored.
 */

import { decodeDetections, summarise, unpadBoxes } from './face-postprocess.js';

const VENDOR = new URL('../../vendor/', import.meta.url).href;
const NET_W = 320;
const NET_H = 240;

let session = null;
let inputName = 'input';

self.onmessage = async (ev) => {
  const msg = ev.data || {};

  if (msg.type === 'init') {
    try {
      const ort = await import(`${VENDOR}onnxruntime/ort.wasm.bundle.min.mjs`);
      ort.env.wasm.wasmPaths = `${VENDOR}onnxruntime/`;
      // No cross-origin isolation in an offscreen document, so SharedArrayBuffer
      // is unavailable and extra threads do nothing. Measured: 1, 2 and 4
      // threads all land within noise of each other.
      ort.env.wasm.numThreads = 1;
      ort.env.logLevel = 'error';

      const res = await fetch(`${VENDOR}models/ultraface-rfb320.onnx`);
      if (!res.ok) throw new Error(`model HTTP ${res.status}`);
      session = await ort.InferenceSession.create(
        new Uint8Array(await res.arrayBuffer()),
        { executionProviders: ['wasm'], graphOptimizationLevel: 'all' }
      );
      inputName = session.inputNames[0];
      self.ortTensor = ort.Tensor;
      self.postMessage({ type: 'ready' });
    } catch (err) {
      self.postMessage({ type: 'init-failed', error: String(err?.message || err) });
    }
    return;
  }

  if (msg.type === 'detect') {
    if (!session) {
      self.postMessage({ type: 'detect-result', rpcId: msg.rpcId, error: 'no session' });
      return;
    }
    try {
      const out = await session.run({
        [inputName]: new self.ortTensor('float32', msg.tensor, [1, 3, NET_H, NET_W])
      });
      const names = session.outputNames;
      const faces = unpadBoxes(
        decodeDetections(out[names[0]].data, out[names[1]].data, {
          scoreThreshold: msg.scoreThreshold
        }),
        msg.pad
      );
      self.postMessage({ type: 'detect-result', rpcId: msg.rpcId, result: summarise(faces) });
    } catch (err) {
      self.postMessage({ type: 'detect-result', rpcId: msg.rpcId, error: String(err?.message || err) });
    }
  }
};
