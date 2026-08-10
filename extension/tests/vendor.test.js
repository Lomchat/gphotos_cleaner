/**
 * The vendored model file.
 *
 * It is a binary nobody reads in a diff, so its identity is pinned here. The
 * point is not tamper-proofing — it is that re-vendoring by hand is exactly the
 * kind of change that silently undoes work done to the file.
 *
 * This copy has had its weights removed from the graph inputs. An exporter of
 * the era listed all 245 of them there, which blocks constant folding: measured
 * in Chrome, session creation took 1207 ms instead of 100 ms and each inference
 * 81.7 ms instead of 53.6 ms, for detections identical to 2.4e-7.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';

const MODEL = new URL('../vendor/models/ultraface-rfb320.onnx', import.meta.url);
const EXPECTED_SHA256 = 'b63e0028667fd9e7e5dcc56ebd91e85281b8df1498b4c3c5799de9229305c0b1';
const EXPECTED_BYTES = 1259725;

test('the detector model is the copy that was measured', () => {
  const bytes = readFileSync(MODEL);
  assert.equal(bytes.length, EXPECTED_BYTES);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), EXPECTED_SHA256,
    'the vendored model changed; re-run the initializer cleanup and re-measure before updating this hash');
});

test('the model still declares exactly one real input', () => {
  // ONNX is protobuf, but an input name is a plain length-prefixed string in
  // it, so the one name the code feeds must be present.
  const text = readFileSync(MODEL).toString('latin1');
  assert.ok(text.includes('input'), 'the image input is missing');
  assert.ok(text.includes('scores') && text.includes('boxes'), 'the outputs are missing');
});

test('the workers ask the runtime to keep quiet about optimisations', () => {
  // Without this the native graph builder narrates every fold it declines,
  // hundreds of lines per session, which buries anything real.
  for (const file of ['face-worker.js', 'recognize-worker.js']) {
    const src = readFileSync(new URL(`../src/analysis/${file}`, import.meta.url), 'utf8');
    assert.match(src, /logSeverityLevel:\s*3/, `${file} does not quieten the runtime`);
  }
});
