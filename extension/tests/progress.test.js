/**
 * What "done" means, and what it costs to show it.
 *
 * A run has two stages over the same library: measure every thumbnail, then
 * read faces in the photos that contain one. Counting only the first made the
 * ring read 100% while the face pass still had thousands of photos to go —
 * a completion figure that is wrong in the one direction it must never be.
 *
 * And showing progress used to cost a full re-render of the tab, several times
 * a second: the panel appeared to reload in a loop, and the log the running job
 * was writing into was replaced underneath it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Panel } from '../src/ui/panel.js';

const SOURCE = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');

/** A panel stand-in holding just the state the progress methods read. */
function panel(items, { scanPeople = true, liveFaces = null } = {}) {
  return {
    state: { items, settings: { scanPeople } },
    liveFaces,
    progressSummary: Panel.prototype.progressSummary,
    paintProgress: Panel.prototype.paintProgress,
    paintRunStatus: Panel.prototype.paintRunStatus
  };
}

/** `faces` mirrors what the People pass records: [] means read, undefined not. */
const photo = (id, over = {}) => ({
  id, url: `u/${id}`, analyzed: 1,
  features: { faceScore: 0.9 }, ...over
});

/* --------------------------------------------------------- the arithmetic */

test('an empty catalogue is at zero, not at one hundred', () => {
  const s = panel([]).progressSummary();
  assert.equal(s.ratio, 0);
  assert.equal(s.complete, false, 'nothing done is not everything done');
});

test('thumbnails measured but faces unread is not complete', () => {
  // The bug this file exists for. Every photo is analysed, so the old figure
  // was 100% — while the face pass had ten photos still to read.
  const items = Array.from({ length: 10 }, (_, i) => photo(`p${i}`));
  const s = panel(items).progressSummary();

  assert.equal(s.pending, 0, 'measurement really is finished');
  assert.equal(s.facePending, 10);
  assert.ok(s.ratio < 1, `ratio was ${s.ratio}`);
  assert.equal(s.complete, false);
});

test('both stages finished is complete, and exactly 100%', () => {
  const items = Array.from({ length: 10 }, (_, i) => photo(`p${i}`, { peopleScanned: 1, people: [] }));
  const s = panel(items).progressSummary();
  assert.equal(s.facePending, 0);
  assert.equal(s.ratio, 1);
  assert.equal(s.complete, true);
});

test('a library with nobody in it reaches 100% on measurement alone', () => {
  // The face stage is weighted by the photos it actually covers. A landscape
  // library has no identity work to do, and must not be held below 100%
  // waiting for a stage that will never have anything to run.
  const items = Array.from({ length: 5 }, (_, i) =>
    photo(`p${i}`, { features: { faceScore: 0.01 } }));
  const s = panel(items).progressSummary();
  assert.equal(s.faceTotal, 0);
  assert.equal(s.ratio, 1);
  assert.equal(s.complete, true);
});

test('grouping switched off drops the face stage from the figure', () => {
  const items = Array.from({ length: 10 }, (_, i) => photo(`p${i}`));
  const s = panel(items, { scanPeople: false }).progressSummary();
  assert.equal(s.faceTotal, 0);
  assert.equal(s.complete, true, 'a stage nobody asked for cannot hold the run open');
});

test('the face stage is weighted by its own size, not counted as a half', () => {
  // 100 photos, 10 with a face: reading all 10 is worth 10/110, not 50%.
  const items = Array.from({ length: 100 }, (_, i) =>
    photo(`p${i}`, { features: { faceScore: i < 10 ? 0.9 : 0.01 } }));
  const s = panel(items).progressSummary();
  assert.equal(s.total, 100);
  assert.equal(s.faceTotal, 10);
  assert.ok(Math.abs(s.ratio - 100 / 110) < 1e-9, `ratio was ${s.ratio}`);
});

test('unmeasured thumbnails still dominate the figure', () => {
  const items = [
    ...Array.from({ length: 5 }, (_, i) => photo(`done${i}`, { peopleScanned: 1, people: [] })),
    ...Array.from({ length: 5 }, (_, i) => ({ id: `todo${i}`, url: 'u', analyzed: 0 }))
  ];
  const s = panel(items).progressSummary();
  assert.equal(s.pending, 5);
  assert.equal(s.complete, false);
  assert.ok(s.ratio < 1);
});

test('a running pass supplies its own counters instead of a rescan', () => {
  // The pass knows exactly where it is; deriving it again from the catalogue
  // on every repaint would walk every item several times a second.
  const items = Array.from({ length: 10 }, (_, i) => photo(`p${i}`));
  const s = panel(items, { liveFaces: { done: 7, total: 10, faces: 12 } }).progressSummary();
  assert.equal(s.faceDone, 7);
  assert.equal(s.facePending, 3);
  assert.ok(Math.abs(s.ratio - 17 / 20) < 1e-9);
});

test('the ring never goes backwards when the pass starts', () => {
  // The face stage joins the denominator the moment the pass begins. If its
  // size were counted before any of it was done, the figure would drop.
  const items = Array.from({ length: 10 }, (_, i) => photo(`p${i}`));
  const before = panel(items).progressSummary().ratio;
  const atStart = panel(items, { liveFaces: { done: 0, total: 10, faces: 0 } }).progressSummary().ratio;
  assert.equal(atStart, before, 'the same work is outstanding either way');
});

/* ------------------------------------------------------------ repainting */

test('repainting is safe before anything has been rendered', () => {
  // It fires from a running pass, which can outlive a tab switch or a reset.
  const p = panel([photo('a')]);
  assert.doesNotThrow(() => p.paintProgress());
});

test('repainting writes the numbers into the nodes that already exist', () => {
  const items = Array.from({ length: 10 }, (_, i) => photo(`p${i}`));
  const p = panel(items, { liveFaces: { done: 5, total: 10, faces: 8 } });
  const attrs = {};
  p.ringC = 100;
  p.ringFill = { setAttribute: (k, v) => { attrs[k] = v; } };
  p.ringValue = { textContent: '' };
  p.ringLabel = { textContent: '' };
  p.peopleBar = { style: {} };
  p.peopleLabel = { textContent: '' };

  p.paintProgress();

  assert.equal(p.ringValue.textContent, '75%');
  assert.equal(p.ringLabel.textContent, 'analysed', 'not "done" while faces remain');
  assert.equal(attrs['stroke-dashoffset'], '25.0');
  assert.equal(p.peopleBar.style.width, '50%');
  assert.match(p.peopleLabel.textContent, /5 \/ 10 read · 8 face/);
});

test('the face pass repaints rather than re-rendering', () => {
  // renderScan() does replaceChildren() on the whole tab. Called on every
  // batch it made the panel look like it was reloading in a loop, and replaced
  // the log elements the run was still writing into.
  const start = SOURCE.indexOf('const totals = await scanFaces(');
  const block = SOURCE.slice(start, SOURCE.indexOf('if (totals.errors.length)', start));
  assert.match(block, /this\.paintProgress\(\)/);
  assert.equal(/this\.render(Scan|All)\(\)/.test(block), false,
    'a progress tick must not rebuild the tab it is reporting into');
});

test('a log element replaced by a render is dropped, not written to', () => {
  const lines = [];
  const target = { isConnected: false, prepend: () => lines.push(1) };
  Panel.prototype.log.call({}, target, 'hello');
  assert.deepEqual(lines, [], 'writing into a detached node reports nothing to anyone');
});

/* ---------------------------------------------------------------- badge */

test('the badge names every stage of the run at once', () => {
  // Listing and analysis overlap, and the face pass follows on the same button
  // press. A badge that stopped mentioning a stage would read as that stage
  // having failed.
  let shown = null;
  const p = {
    runCounts: { listed: 1200, analysed: 900, facesDone: 40, facesTotal: 300, listingDone: true },
    progressSummary: () => ({ ratio: 0.5 }),
    setStatus: (patch) => { shown = patch; },
    paintRunStatus: Panel.prototype.paintRunStatus
  };
  p.paintRunStatus();
  assert.match(shown.label, /Listing 1,200/);
  assert.match(shown.label, /Analysing 900/);
  assert.match(shown.label, /Faces 40\/300/);
  assert.equal(shown.ratio, 0.5);
});

test('the badge stays unquantified while the library size is unknown', () => {
  // Listing does not know the total until its last page. A bar against a
  // moving denominator goes backwards, which reads as a regression.
  let shown = null;
  const p = {
    runCounts: { listed: 500, analysed: 200, facesDone: 0, facesTotal: 0, listingDone: false },
    progressSummary: () => ({ ratio: 0.9 }),
    setStatus: (patch) => { shown = patch; },
    paintRunStatus: Panel.prototype.paintRunStatus
  };
  p.paintRunStatus();
  assert.equal(shown.ratio, null);
  assert.equal(/Faces/.test(shown.label), false, 'a stage that has not started is not announced');
});

test('the badge says nothing when no run is in progress', () => {
  let called = false;
  const p = {
    runCounts: null,
    setStatus: () => { called = true; },
    paintRunStatus: Panel.prototype.paintRunStatus
  };
  p.paintRunStatus();
  assert.equal(called, false);
});

test('the run clears its counters when it ends, however it ends', () => {
  const start = SOURCE.indexOf('async doFullRun()');
  const block = SOURCE.slice(start, SOURCE.indexOf('abortAll()', start));
  const tail = block.slice(block.lastIndexOf('} finally {'));
  assert.match(tail, /this\.runCounts = null/);
  assert.match(tail, /this\.liveFaces = null/,
    'a stale live count would hold the completion figure below 100% forever');
});

/* ------------------------------------------------------------- the hero */

test('the header does not claim the library is analysed while faces remain', () => {
  const start = SOURCE.indexOf('buildHero(s) {');
  const block = SOURCE.slice(start, SOURCE.indexOf('buildRing(', start));
  assert.match(block, /s\.facePending/,
    'the outstanding face count must reach the title beside the ring');
  const claim = block.indexOf("'Library analysed'");
  const guard = block.indexOf('s.facePending');
  assert.ok(guard < claim, 'the guard must come before the claim it prevents');
});
