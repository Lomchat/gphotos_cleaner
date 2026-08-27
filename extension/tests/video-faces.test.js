/**
 * Reading faces out of videos.
 *
 * A video's thumbnail is one arbitrary frame. For the quality criteria that is
 * a reason to exempt videos — a frame can be blurred or black while the video
 * is neither — and that rule was copied to the face pass, where it does not
 * hold: a face legible in that frame is a real face. The cost of copying it
 * was that every video of a protected person stayed on offer.
 *
 * Sampling several frames costs bandwidth in a way nothing else here does, so
 * two things are pinned below with more care than usual: the cap, and the
 * deduplication that keeps one video from counting as five sightings of the
 * same person.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  frameTimes, dedupeFaces, grabFrames, BYTE_CAP, FRAME_COUNT
} from '../src/analysis/video-frames.js';
import { normalise } from '../src/analysis/cluster.js';

const RUNNER = readFileSync(new URL('../src/analysis/people-runner.js', import.meta.url), 'utf8');
const PANEL = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');

/* ------------------------------------------------------ which moments */

test('the sampled moments spread through the middle', () => {
  const times = frameTimes(100, 100, 4);
  assert.equal(times.length, 4);
  assert.ok(times[0] >= 5, 'never the very start: videos open on a fade or a hand');
  assert.ok(times.at(-1) <= 95, 'nor the very end, which is the phone being lowered');
  for (let i = 1; i < times.length; i++) {
    assert.ok(times[i] > times[i - 1], 'and they must advance');
  }
});

test('a very short clip gets one frame, not four of the same picture', () => {
  assert.deepEqual(frameTimes(1, 1, 4), [0.5]);
});

test('sampling never reaches past what was downloaded', () => {
  // The cap means the usable part is often shorter than the video. Seeking
  // beyond it does not fail — it simply never completes.
  const times = frameTimes(600, 45, 4);
  assert.ok(times.every((t) => t <= 45), `asked for ${times.join(', ')} of 45s`);
});

test('a video with no duration is not sampled at all', () => {
  assert.deepEqual(frameTimes(0, 0, 4), []);
  assert.deepEqual(frameTimes(NaN, NaN, 4), []);
});

test('the number of frames never exceeds the seconds available', () => {
  // Four frames of a two-second clip would be the same picture repeatedly.
  assert.ok(frameTimes(2, 2, 4).length <= 2);
});

/* ------------------------------------------- one entry per person, not per frame */

/** A unit vector along one axis, with a little noise. */
function vec(axis, wobble = 0, dim = 32) {
  const v = new Float32Array(dim);
  v[axis] = 1;
  if (wobble) v[(axis + 1) % dim] = wobble;
  return Array.from(normalise(v));
}
const face = (axis, score, wobble = 0) => ({ vector: vec(axis, wobble), score, box: [0, 0, 1, 1] });

test('the same person across four frames is stored once', () => {
  // The rule this protects is not obvious and matters a great deal: two faces
  // sharing a photo id are supposed to be two *different* people. Protection
  // uses exactly that to tell a clean group from a merged one, and the
  // clustering thresholds were measured with it.
  const found = [face(0, 0.9), face(0, 0.8, 0.05), face(0, 0.7, 0.08), face(0, 0.6, 0.03)];
  assert.equal(dedupeFaces(found, 0.55).length, 1);
});

test('two people in one video are both kept', () => {
  const found = [face(0, 0.9), face(7, 0.9), face(0, 0.8, 0.05)];
  assert.equal(dedupeFaces(found, 0.55).length, 2);
});

test('the clearest sighting is the one kept', () => {
  // Whichever frame happened to be sampled first is not the one that should
  // represent the person; the one the detector was most sure of is.
  const found = [face(0, 0.4, 0.2), face(0, 0.99), face(0, 0.5, 0.1)];
  const kept = dedupeFaces(found, 0.55);
  assert.equal(kept.length, 1);
  assert.equal(kept[0].score, 0.99);
});

test('a vector that did not survive is dropped, not stored', () => {
  const found = [{ vector: null, score: 1 }, face(0, 0.9)];
  assert.equal(dedupeFaces(found, 0.55).length, 1);
});

test('nothing found is nothing stored', () => {
  assert.deepEqual(dedupeFaces([], 0.55), []);
});

/* ------------------------------------------------------------ the fetch */

test('a video is fetched with a byte range, never whole', () => {
  // 96 KB per second, measured. Uncapped, this library alone would be 5.3 GB.
  let asked = null;
  return grabFrames('https://example.test/v=m18', {
    duration: 600,
    fetchImpl: async (url, init) => { asked = init; return { ok: false, status: 500 }; },
    documentImpl: { createElement: () => ({ addEventListener() {}, removeEventListener() {} }) }
  }).then(() => {
    assert.match(asked.headers.Range, /^bytes=0-\d+$/);
    assert.ok(Number(asked.headers.Range.split('-')[1]) < 8 * 1024 * 1024,
      'the cap has to stay a cap');
  });
});

test('the bytes are fetched rather than handed to a video element', () => {
  // A cross-origin video taints the canvas, and a tainted canvas cannot be
  // read — which is the entire point. Fetched, they become a blob URL, which
  // is same-origin and readable.
  const source = readFileSync(new URL('../src/analysis/video-frames.js', import.meta.url), 'utf8');
  assert.match(source, /createObjectURL/);
  assert.match(source, /credentials: 'include'/);
});

test('a failure returns nothing rather than throwing', async () => {
  // The caller falls back to the poster frame, which is what the pass did
  // before videos were read at all. A video that cannot be decoded is then no
  // worse off than it was.
  const out = await grabFrames('https://example.test/v=m18', {
    fetchImpl: async () => { throw new Error('offline'); },
    documentImpl: { createElement: () => ({ addEventListener() {}, removeEventListener() {} }) }
  });
  assert.deepEqual(out.frames, []);
  assert.match(out.reason, /offline/);
});

test('no document means no frames, and no exception', async () => {
  const out = await grabFrames('https://example.test/v=m18', { documentImpl: null });
  assert.deepEqual(out.frames, []);
});

/* --------------------------------------------------------- the fallback */

test('a video that cannot be sampled falls back to its cover frame', () => {
  const body = RUNNER.slice(RUNNER.indexOf('export async function analysePhoto'));
  assert.match(body, /item\.isVideo && options\.sampleVideo/);
  assert.match(body, /Straight on to the poster frame below/);
  assert.match(body, /fetchBitmap\(item\.url\)/, 'the old path is still the fallback');
});

test('sampling is asked for, never assumed', () => {
  // It costs bandwidth. Something that expensive may not happen by default.
  assert.match(PANEL, /sampleVideoFaces: false/);
  const body = RUNNER.slice(RUNNER.indexOf('export async function analysePhoto'));
  assert.match(body, /options\.sampleVideo/);
});

test('the switch states what it will download', () => {
  // Measured from durations already in the catalogue, not guessed, and on the
  // switch rather than in a note somewhere else.
  const start = PANEL.indexOf('  buildVideoFaceOption() {');
  const body = PANEL.slice(start, PANEL.indexOf('  /**\n   * Order buttons above the preview.'));
  assert.match(body, /formatBytes\(bytes\)/);
  assert.match(body, /96 \* 1024/, 'the measured rate');
  assert.match(body, /Math\.min\(it\.duration \|\| 0, 45\)/, 'capped, as the sampler caps it');
});

test('the video path actually deduplicates before storing', () => {
  // A mechanism with a test and no caller reads as covered. Removing the call
  // leaves every unit test above passing while a video contributes five
  // sightings of one person to the catalogue.
  const start = RUNNER.indexOf('async function analyseVideo');
  const body = RUNNER.slice(start, RUNNER.indexOf('export async function analysePhoto'));
  assert.match(body, /faces: dedupeFaces\(found/);
  assert.equal(/faces: found\b/.test(body), false,
    'the raw per-frame list must never be what is returned');
});

test('every decoded frame is released', () => {
  // Four ImageBitmaps per video, held until something drops them. On a library
  // of two thousand videos that is not a leak anyone would spot from the
  // symptoms.
  const start = RUNNER.indexOf('async function analyseVideo');
  const body = RUNNER.slice(start, RUNNER.indexOf('export async function analysePhoto'));
  assert.match(body, /finally \{[\s\S]{0,120}frame\.close\?\.\(\)/);
});
