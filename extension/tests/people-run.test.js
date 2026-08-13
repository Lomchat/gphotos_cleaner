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
