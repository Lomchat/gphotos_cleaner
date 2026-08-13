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
  const body = source.slice(source.indexOf('export async function analysePhoto'));
  assert.match(body, /Promise\.all\(\s*usable\.map/,
    'a group photo of seven was seven sequential round trips to the pool');
  assert.equal(/for \(const face of boxes\)[\s\S]{0,200}await embed\(/.test(body), false,
    'the sequential loop must not come back');
});

test('a photo is reported unread rather than half read when the pool dies', () => {
  // A missing vector means the recogniser is gone, not that one face is odd.
  // Keeping the others would store a photo whose faces are silently incomplete.
  const source = readFileSync(new URL('../src/analysis/people-runner.js', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function analysePhoto'));
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
  const start = source.indexOf('const totals = await scanFaces(');
  assert.match(source.slice(start, start + 500), /inflight: this\.state\.settings\.analyzeInflight/);
});

test('the fetch pool is sized above the fetch ceiling, not at it', () => {
  // Workers block on the detection pool after measuring, so a pool sized at the
  // ceiling keeps fewer fetches outstanding than the ceiling allows.
  const source = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf8');
  const m = /const POOL_SIZE = Math\.max\((\d+), Math\.min\((\d+),/.exec(source);
  assert.ok(m, 'the pool size must stay a bounded expression');
  assert.ok(Number(m[2]) > 16, `cap is ${m[2]}, at or below the measured fetch ceiling`);
  assert.ok(Number(m[1]) >= 12, `floor is ${m[1]}: a modest machine is still latency-bound`);
});
