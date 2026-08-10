/**
 * Choosing what the People pass reads, and what it keeps.
 *
 * The pass costs a second download per photo, so picking the wrong candidates
 * is expensive rather than merely wrong. And the batching has to survive a
 * failure mid-run: on a large library the pass is minutes long, and losing it
 * to one bad response would be unforgivable.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { candidates, pending, scanFaces } from '../src/content/people-client.js';
import { PEOPLE_RENDER_PX, MIN_FACE_PX } from '../src/analysis/people-runner.js';

function photo(id, overrides = {}) {
  const { features = {}, ...rest } = overrides;
  return {
    id,
    url: `https://lh3.googleusercontent.com/${id}=w176-h176-no`,
    isVideo: 0,
    analyzed: 1,
    features: { faceScore: 0.9, ...features },
    ...rest
  };
}

/* ------------------------------------------------------------ candidates */

test('only photos the analysis thinks contain a face are read', () => {
  const items = [
    photo('face'),
    photo('landscape', { features: { faceScore: 0.02 } })
  ];
  assert.deepEqual(candidates(items).map((i) => i.id), ['face']);
});

test('videos are never read', () => {
  // Their thumbnail is one arbitrary frame; an identity from it means nothing.
  assert.deepEqual(candidates([photo('v', { isVideo: 1 })]), []);
});

test('photos with no thumbnail URL are skipped', () => {
  assert.deepEqual(candidates([photo('x', { url: null })]), []);
});

test('photos the main analysis has not measured are skipped', () => {
  // Without a face score there is nothing to select on, and reading the whole
  // library at full rendition is exactly the cost this filter exists to avoid.
  assert.deepEqual(candidates([photo('x', { analyzed: 0 })]), []);
});

test('a photo already read is not read twice', () => {
  const items = [photo('a'), photo('b', { peopleScanned: 1 })];
  assert.deepEqual(pending(items).map((i) => i.id), ['a']);
});

test('the face-score threshold can be loosened', () => {
  const items = [photo('faint', { features: { faceScore: 0.2 } })];
  assert.equal(candidates(items).length, 0);
  assert.equal(candidates(items, { minFaceScore: 0.1 }).length, 1);
});

/* ------------------------------------------------------------------ scan */

/** Persistence is injected, so these run with no IndexedDB in sight. */
const noSave = async () => {};

test('photos are sent at the larger rendition, not the catalogue size', async () => {
  const sent = [];
  await scanFaces([photo('a')], {
    save: noSave,
    send: async (m) => { sent.push(m); return { ok: true, results: [{ id: 'a', ok: true, faces: [] }] }; }
  });
  assert.match(sent[0].items[0].url, new RegExp(`=w${PEOPLE_RENDER_PX}-h${PEOPLE_RENDER_PX}`));
});

test('the pass reports how many faces it found', async () => {
  const totals = await scanFaces([photo('a'), photo('b')], {
    save: noSave,
    send: async (m) => ({
      ok: true,
      results: m.items.map((it) => ({ id: it.id, ok: true, faces: [{}, {}], skipped: 0 }))
    })
  });
  assert.equal(totals.scanned, 2);
  assert.equal(totals.faces, 4);
});

test('faces too small to identify are counted, not silently dropped', async () => {
  // The user is told; a photo that yielded nothing usable should not look
  // identical to one with nobody in it.
  const totals = await scanFaces([photo('a')], {
    save: noSave,
    send: async () => ({ ok: true, results: [{ id: 'a', ok: true, faces: [], skipped: 3 }] })
  });
  assert.equal(totals.tooSmall, 3);
});

test('one failed photo does not fail its batch', async () => {
  const totals = await scanFaces([photo('a'), photo('b')], {
    save: noSave,
    send: async (m) => ({
      ok: true,
      results: [
        { id: m.items[0].id, ok: true, faces: [{}] },
        { id: m.items[1].id, ok: false, error: 'thumbnail HTTP 404' }
      ]
    })
  });
  assert.equal(totals.scanned, 1);
  assert.equal(totals.failed, 1);
});

test('an engine-level failure stops the run instead of repeating it', async () => {
  // A missing model will not fix itself on the next batch; retrying a thousand
  // times would just take longer to say the same thing.
  let calls = 0;
  const many = Array.from({ length: 60 }, (_, i) => photo(`p${i}`));
  const totals = await scanFaces(many, {
    send: async () => { calls++; return { ok: false, error: 'recognition unavailable' }; }
  });
  assert.equal(calls, 1);
  assert.match(totals.errors[0], /unavailable/);
});

test('an abort signal stops the run between batches', async () => {
  const controller = new AbortController();
  let calls = 0;
  const many = Array.from({ length: 60 }, (_, i) => photo(`p${i}`));
  await scanFaces(many, {
    save: noSave,
    signal: controller.signal,
    send: async (m) => {
      if (++calls === 2) controller.abort();
      return { ok: true, results: m.items.map((it) => ({ id: it.id, ok: true, faces: [] })) };
    }
  });
  assert.equal(calls, 2);
});

test('an empty list makes no request', async () => {
  let calls = 0;
  const totals = await scanFaces([], { save: noSave, send: async () => { calls++; return { ok: true, results: [] }; } });
  assert.equal(calls, 0);
  assert.equal(totals.scanned, 0);
});

/* ----------------------------------------------------------- thresholds */

test('the rendition and the minimum face size agree with each other', () => {
  // 512px was chosen because it puts typical faces above MIN_FACE_PX. If the
  // rendition ever shrinks below that, the pass would discard its own work.
  assert.ok(PEOPLE_RENDER_PX >= 384, 'too small a rendition halves the grouping margin');
  assert.ok(MIN_FACE_PX >= 21, 'below ~21px the headroom over the threshold collapses');
  assert.ok(MIN_FACE_PX < PEOPLE_RENDER_PX / 4, 'the floor must not reject ordinary faces');
});
