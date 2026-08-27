/**
 * Fetching the recognition model as part of a run.
 *
 * The switch in the Analyse tab is the consent; there is no second button. So
 * the pass has to fetch the model itself, and — more importantly — it has to
 * survive not getting it. A failed download must cost the grouping and nothing
 * else: the visual analysis behind it took minutes and is still worth keeping.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Panel } from '../src/ui/panel.js';

/** A Panel stand-in wired to record what it was asked to do. */
function panel({ modelReady = false, download = { ok: true }, items = null } = {}) {
  const sent = [];
  const logged = [];
  const photos = items ?? [{
    id: 'p1',
    url: 'https://lh3.googleusercontent.com/x=w176-h176',
    isVideo: 0,
    analyzed: 1,
    features: { faceScore: 0.9 }
  }];

  return {
    state: {
      busy: null,
      items: photos,
      settings: {},
      people: { modelReady, groups: [], faceCount: 0, error: null, progress: null }
    },
    sent,
    logged,
    async send(msg) {
      sent.push(msg.type);
      if (msg.type === 'PEOPLE_DOWNLOAD') return download;
      if (msg.type === 'PEOPLE_BATCH') {
        return { ok: true, results: msg.items.map((i) => ({ id: i.id, ok: true, faces: [], skipped: 0 })) };
      }
      return { ok: false };
    },
    saved: [],
    async saveFaces(results, ids) { this.saved.push(ids); },
    log(_t, message) { logged.push(message); },
    renderAll() {},
    // The real ones: a pass repaints progress on every batch, and repainting
    // must be safe on a panel whose nodes have not been built yet.
    progressSummary: Panel.prototype.progressSummary,
    paintProgress: Panel.prototype.paintProgress,
    paintRunStatus: Panel.prototype.paintRunStatus,
    async reload() {},
    async rebuildGroups() {},
    flashStatus() {},
    ensureRecognitionModel: Panel.prototype.ensureRecognitionModel,
    runPeopleScan: Panel.prototype.runPeopleScan
  };
}

test('a run with no model fetches it before scanning', async () => {
  const p = panel({ modelReady: false });
  await p.runPeopleScan({ inline: true, log: {} });
  assert.deepEqual(p.sent, ['PEOPLE_DOWNLOAD', 'PEOPLE_BATCH']);
  assert.equal(p.state.people.modelReady, true);
});

test('a run with the model already there fetches nothing', async () => {
  const p = panel({ modelReady: true });
  await p.runPeopleScan({ inline: true, log: {} });
  assert.equal(p.sent.includes('PEOPLE_DOWNLOAD'), false);
  assert.deepEqual(p.sent, ['PEOPLE_BATCH']);
});

test('a failed download skips the pass instead of throwing', async () => {
  // The run that produced these photos took minutes. Losing it because a CDN
  // was unreachable would be a poor trade.
  const p = panel({ modelReady: false, download: { ok: false, error: 'offline' } });
  const faces = await p.runPeopleScan({ inline: true, log: {} });
  assert.equal(faces, 0);
  assert.equal(p.sent.includes('PEOPLE_BATCH'), false, 'it must not try to scan without a model');
  assert.match(p.state.people.error, /Could not fetch/);
});

test('a failed download says the rest of the run is unaffected', async () => {
  const p = panel({ modelReady: false, download: { ok: false, error: 'offline' } });
  await p.runPeopleScan({ inline: true, log: {} });
  assert.match(p.state.people.error, /everything else is unaffected/i);
});

test('a download failure leaves nothing busy behind', async () => {
  const p = panel({ modelReady: false, download: { ok: false, error: 'offline' } });
  await p.runPeopleScan({ inline: false });
  assert.equal(p.state.busy, null, 'a stuck busy state would block every later run');
});

test('nothing is fetched when there is nothing to read', async () => {
  // No candidate photos: fetching 13 MB to then do nothing would be rude.
  const p = panel({ modelReady: false, items: [] });
  await p.runPeopleScan({ inline: true, log: {} });
  assert.deepEqual(p.sent, []);
});

test('the download is announced in the run log', async () => {
  const p = panel({ modelReady: false });
  await p.runPeopleScan({ inline: true, log: {} });
  assert.ok(p.logged.some((m) => /13 MB/.test(m)),
    'a silent 13 MB download during someone else\'s run is not acceptable');
});

/* ----------------------------------------------------------- concurrency */

/**
 * Where the face pass spends its time.
 *
 * Measured against a live library: one thumbnail takes ~122ms fetched on its
 * own and ~13ms with sixteen outstanding, at 176px and at 512px alike. The link
 * is almost entirely latency, so the only thing that decides throughput is how
 * many requests are in flight — not the size of the image, and not the CPU.
 *
 * The pass therefore has to keep several batches moving, and each photo has to
 * keep several recognitions moving. Both were serial.
 */

test('a photo embeds its faces together, not one after another', () => {
  const source = readFileSync(new URL('../src/analysis/people-runner.js', import.meta.url), 'utf8');
  // The work moved into `facesInBitmap` when videos arrived, so a video could
  // run it once per sampled frame. The rule it has to keep did not change.
  const body = source.slice(source.indexOf('async function facesInBitmap'));
  assert.match(body, /Promise\.all\(usable\.map/,
    'a group photo of seven was seven sequential round trips to the pool');
  assert.equal(/for \(const face of boxes\)[\s\S]{0,200}await embed\(/.test(body), false,
    'the sequential loop must not come back');
});

test('a photo is reported unread rather than half read when the pool dies', () => {
  // A missing vector means the recogniser is gone, not that one face is odd.
  // Keeping the others would store a photo whose faces are silently incomplete.
  const source = readFileSync(new URL('../src/analysis/people-runner.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function facesInBitmap'));
  assert.match(body, /vectors\.some\(\(v\) => !v\)/);
  assert.match(body, /recognition unavailable/);
});

test('the pass runs several batches at once', () => {
  const source = readFileSync(new URL('../src/content/people-client.js', import.meta.url), 'utf8');
  assert.match(source, /INFLIGHT_BATCHES = \d/);
  assert.match(source, /Promise\.all\(\s*Array\.from\(\{ length: Math\.max\(1, Math\.min\(inflight/,
    'batches must be pipelined, not awaited one at a time');
});

test('the panel drives both stages from the same setting', () => {
  // They are bound by the same link. Two separate numbers would invite tuning
  // one and wondering why the other did not move.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const start = source.indexOf('const part = await scanFaces(');
  assert.notEqual(start, -1);
  assert.match(source.slice(start, start + 600), /inflight: this\.state\.settings\.analyzeInflight/);
});

/**
 * Photos in flight is what decides throughput, and a worker is a poor unit for
 * it: it costs a JS realm and spends nearly all its time waiting. Measured on a
 * live library over a warm connection — 16 in flight = 92 img/s, 24 = 138,
 * 48 = 154, 96 = 159 — so the useful target is around 48, well past any
 * plausible worker count.
 *
 * An earlier reading put the ceiling at 16 and the pool was sized to it. That
 * reading was taken on a cold connection and was simply wrong, which is the
 * reason these numbers are pinned here rather than left in a comment.
 */
const OFFSCREEN = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf8');

/** Evaluate one of the pool's sizing constants for a given core count. */
function sizing(cores) {
  const pick = (name) => {
    const m = new RegExp(`const ${name} = ([^;]+);`).exec(OFFSCREEN);
    assert.ok(m, `${name} must stay a plain bounded expression`);
    // eslint-disable-next-line no-new-func
    return Function('HW', `return ${m[1]};`)(cores);
  };
  const target = pick('TARGET_INFLIGHT');
  const workers = pick('WORKER_COUNT');
  const slots = Math.max(1, Math.ceil(target / workers));
  return { target, workers, slots, capacity: workers * slots };
}

test('photos in flight are decoupled from worker threads', () => {
  // Sized as one job per worker, reaching 48 in flight would mean 48 threads.
  const big = sizing(20);
  assert.ok(big.slots > 1, 'a worker must carry several photos at once');
  assert.ok(big.workers <= 12, `${big.workers} threads is a lot for a queue depth`);
});

test('a capable machine reaches the measured plateau', () => {
  const big = sizing(20);
  assert.ok(big.target >= 48, `target is ${big.target}, short of the 48 that measured 154 img/s`);
  assert.ok(big.capacity >= big.target, 'the slots must actually exist to be filled');
});

test('a modest machine still stays well above its core count', () => {
  // The link is being kept busy, not the processor: four cores still want far
  // more than four requests outstanding.
  const small = sizing(4);
  assert.ok(small.target >= 16, `target is ${small.target} on four cores`);
  assert.ok(small.capacity >= small.target);
});

test('the target never runs away on a huge machine', () => {
  const huge = sizing(128);
  assert.ok(huge.target <= 48, `target is ${huge.target}: past the plateau it is only queue`);
  assert.ok(huge.workers <= 12);
});

test('a slot is released when its photo ends, not when the worker frees up', () => {
  // The whole point: a worker carrying four photos must free one slot per
  // reply, and none while a detection request is outstanding.
  assert.match(OFFSCREEN, /entry\.inflight = Math\.max\(0, entry\.inflight - 1\)/);
  const at = OFFSCREEN.indexOf("if (msg.type === 'detect')");
  assert.notEqual(at, -1);
  assert.match(OFFSCREEN.slice(at - 260, at), /must NOT be released here/);
});

test('a worker that dies takes its whole load with it', () => {
  // Decrementing one slot for a worker that is gone would leak the rest, and
  // the pool would bleed capacity until it deadlocked.
  const body = OFFSCREEN.slice(OFFSCREEN.indexOf('function recycle('), OFFSCREEN.indexOf('function drainQueue'));
  assert.match(body, /crew\.findIndex/);
  assert.match(body, /crew\.splice/);
  assert.match(body, /inflight: 0/, 'the replacement starts empty');
});
