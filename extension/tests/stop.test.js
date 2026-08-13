/**
 * Stopping a run.
 *
 * `scanFaces` has honoured an abort signal between batches since it was
 * written, and there is a test for it. Nobody ever passed one — so Stop did
 * nothing at all during the face pass, which is the longest stage of a run and
 * therefore the one people actually want to stop. A mechanism with a test and
 * no caller is worse than no mechanism: it reads as covered.
 *
 * These tests are about the wiring, and about the two things that make a stop
 * feel broken even when it works: no acknowledgement while the batch in flight
 * finishes, and a completion message afterwards that claims the run finished.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Panel } from '../src/ui/panel.js';

const SOURCE = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');

/** A panel stand-in that really runs the face pass. */
function panel(count, { onBatch = null } = {}) {
  const photos = Array.from({ length: count }, (_, i) => ({
    id: `p${i}`, url: `https://lh3.googleusercontent.com/p${i}=w176-h176`,
    analyzed: 1, features: { faceScore: 0.9 }
  }));

  const p = {
    state: {
      busy: null,
      items: photos,
      settings: { scanPeople: true },
      people: { modelReady: true, groups: [], faceCount: 0, error: null, progress: null }
    },
    batches: 0,
    statuses: [],
    logged: [],
    async send(msg) {
      if (msg.type !== 'PEOPLE_BATCH') return { ok: true };
      p.batches++;
      onBatch?.(p);
      return { ok: true, results: msg.items.map((i) => ({ id: i.id, ok: true, faces: [], skipped: 0 })) };
    },
    async saveFaces() {},
    log(_t, message) { p.logged.push(message); },
    setStatus(patch) { p.statuses.push(patch); },
    flashStatus(label) { p.statuses.push({ label }); },
    renderAll() {},
    async reload() {},
    async rebuildGroups() {},
    progressSummary: Panel.prototype.progressSummary,
    paintProgress: Panel.prototype.paintProgress,
    paintRunStatus: Panel.prototype.paintRunStatus,
    abortAll: Panel.prototype.abortAll,
    runPeopleScan: Panel.prototype.runPeopleScan
  };
  return p;
}

/* ---------------------------------------------------------- the wiring */

test('Stop really stops the face pass', async () => {
  // 60 photos is five batches of twelve. Stopping during the first must not
  // let the other four run.
  const p = panel(60, { onBatch: (self) => { if (self.batches === 1) self.abortAll(); } });
  await p.runPeopleScan();

  assert.equal(p.batches, 1, `${p.batches} batches ran after Stop`);
});

test('an unstopped pass still reads everything', async () => {
  // The guard against a signal that is aborted from the start, or a break in
  // the wrong place: this is what a normal run has to keep doing.
  const p = panel(36);
  await p.runPeopleScan();
  assert.equal(p.batches, 3);
});

test('what was read before the stop is kept, not thrown away', async () => {
  // The pass is minutes long. Discarding a stopped run's work would make Stop
  // a punishment, and the next run would redo all of it.
  let saved = 0;
  const p = panel(60, { onBatch: (self) => { if (self.batches === 2) self.abortAll(); } });
  p.saveFaces = async (results) => { saved += results.length; };
  await p.runPeopleScan();

  assert.equal(p.batches, 2);
  assert.equal(saved, 24, 'both completed batches were saved');
});

test('a stopped pass says stopped, not done', async () => {
  const p = panel(60, { onBatch: (self) => { if (self.batches === 1) self.abortAll(); } });
  await p.runPeopleScan({ log: {} });
  assert.ok(p.logged.some((m) => /stopped/i.test(m)), p.logged.join(' | '));
  assert.equal(p.logged.some((m) => /Faces done/i.test(m)), false);
});

test('a finished pass still says done', async () => {
  const p = panel(24);
  await p.runPeopleScan({ log: {} });
  assert.ok(p.logged.some((m) => /Faces done/i.test(m)), p.logged.join(' | '));
});

test('the run is released after a stop, so the next one can start', async () => {
  // A busy flag left set behind a stopped run disables every button, and only
  // a page reload clears it.
  const p = panel(60, { onBatch: (self) => { if (self.batches === 1) self.abortAll(); } });
  await p.runPeopleScan();

  assert.equal(p.state.busy, null);
  assert.equal(p.aborting, false, 'or the next run would start already stopping');
  assert.equal(p.runAbort, null);
});

/* -------------------------------------------------- the acknowledgement */

test('the click is acknowledged before the stop takes effect', async () => {
  // A stage checks between batches, and the batch in flight has to come back
  // first — several seconds at 512px. A button that looks inert meanwhile is
  // a button people press again and then call broken.
  const p = panel(60, { onBatch: (self) => { if (self.batches === 1) self.abortAll(); } });
  p.runButton = { textContent: 'Stop', disabled: false };
  await p.runPeopleScan();

  assert.match(p.statuses.map((s) => s.label).join(' | '), /Stopping/);
});

test('the button says so too, without rebuilding the tab', () => {
  // Re-rendering here would replace the log elements the run is writing into.
  const button = { textContent: 'Stop', disabled: false };
  const p = {
    state: { busy: 'full' }, aborting: false, runButton: button,
    setStatus() {}, abortAll: Panel.prototype.abortAll
  };
  p.abortAll();
  assert.equal(button.textContent, 'Stopping…');
  assert.equal(button.disabled, true);

  const body = SOURCE.slice(SOURCE.indexOf('  abortAll() {'), SOURCE.indexOf('  abortAll() {') + 900);
  assert.equal(/this\.render(All|Scan)\(\)/.test(body), false,
    'acknowledge by repainting the button, not by rebuilding the tab');
});

test('pressing Stop twice does nothing the second time', () => {
  let aborts = 0;
  const p = {
    state: { busy: 'full' }, aborting: false,
    runAbort: { abort: () => aborts++ },
    setStatus() {}, abortAll: Panel.prototype.abortAll
  };
  p.abortAll();
  p.abortAll();
  assert.equal(aborts, 1);
});

test('Stop while nothing runs is not an error', () => {
  const p = {
    state: { busy: null }, aborting: false,
    setStatus() { throw new Error('should not have touched the badge'); },
    abortAll: Panel.prototype.abortAll
  };
  assert.doesNotThrow(() => p.abortAll());
  assert.equal(p.aborting, false);
});

test('every stage of a run is told to stop', () => {
  const told = [];
  const p = {
    state: { busy: 'full' }, aborting: false,
    runAbort: { abort: () => told.push('signal') },
    scanner: { abort: () => told.push('listing') },
    analyzer: { abort: () => told.push('analysis') },
    trasher: { abort: () => told.push('bin') },
    setStatus() {}, abortAll: Panel.prototype.abortAll
  };
  p.abortAll();
  assert.deepEqual(told.sort(), ['analysis', 'bin', 'listing', 'signal']);
});

/* ------------------------------------------------------------ the button */

test('a standalone face pass is stoppable, not merely disabled', () => {
  // It is as long as a full run. With the button disabled the only way out was
  // to reload the page.
  assert.match(SOURCE, /const running = this\.state\.busy === 'full' \|\| this\.state\.busy === 'people'/);
});

test('the run button reflects that a stop is already under way', () => {
  const start = SOURCE.indexOf('this.runButton = el(');
  const block = SOURCE.slice(start, start + 700);
  assert.match(block, /this\.aborting \? 'Stopping…' : 'Stop'/);
  assert.match(block, /running && this\.aborting/, 'and cannot be pressed again');
});

/* --------------------------------------------------------------- the run */

test('a stopped run leaves the face pass no way to continue', () => {
  // It no longer starts *after* the analysis — the two overlap — so "do not
  // begin it" has become "the loop that feeds it must notice". Its streaming
  // loop is gated on the same flag Stop sets, and scanFaces gets the signal.
  const body = SOURCE.slice(SOURCE.indexOf('async runPeopleScan('), SOURCE.indexOf('async rebuildGroups('));
  assert.match(body, /while \(!this\.aborting\)/,
    'the loop asking for more work must stop asking');
  assert.match(body, /signal: this\.runAbort\?\.signal/);
});

test('the face pass is told when no more photos are coming', () => {
  // Otherwise it waits for work that will never arrive and the run never ends.
  const body = SOURCE.slice(SOURCE.indexOf('async doFullRun()'), SOURCE.indexOf('  abortAll() {'));
  assert.match(body, /analysisRunning = true/);
  assert.match(body, /analysisRunning = false/);
  const started = body.indexOf('moreComing: () => analysisRunning');
  const cleared = body.indexOf('analysisRunning = false');
  assert.ok(started !== -1 && started < cleared, 'and told only once the analysis has settled');
});

test('a stopped run reports a stop, at every level that reports anything', () => {
  const start = SOURCE.indexOf('async doFullRun()');
  const block = SOURCE.slice(start, SOURCE.indexOf('  abortAll() {', start));
  assert.match(block, /Analysis stopped: /);
  assert.match(block, /'Stopped · ' : 'Done · '/);
});

test('the run clears its abort state however it ends', () => {
  const start = SOURCE.indexOf('async doFullRun()');
  const block = SOURCE.slice(start, SOURCE.indexOf('  abortAll() {', start));
  const tail = block.slice(block.lastIndexOf('} finally {'));
  assert.match(tail, /this\.runAbort = null/);
  assert.match(tail, /this\.aborting = false/);
});
