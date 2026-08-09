/**
 * Scan resume logic.
 *
 * A mistake here is invisible: the scan would simply restart in the wrong place
 * and silently skip part of the library, while the user believed everything had
 * been analysed.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  planResume, DateWindow, planThumbRepair, inheritDate, MAX_THUMB_ATTEMPTS
} from '../src/content/scanner.js';
import { tileDateOnly } from '../src/content/dom-adapter.js';

const metrics = (clientHeight = 800, scrollHeight = 40000) => ({ clientHeight, scrollHeight });
const opts = (overrides = {}) => ({ resume: true, overlapRatio: 1, ...overrides });

test('with no cursor, restart from the top', () => {
  const r = planResume(null, metrics(), opts());
  assert.equal(r.startTop, 0);
  assert.equal(r.reason, 'top-no-cursor');
});

test('resume disabled: always from the top', () => {
  const r = planResume({ scrollTop: 20000, reachedEnd: false }, metrics(), opts({ resume: false }));
  assert.equal(r.startTop, 0);
  assert.equal(r.reason, 'top-disabled');
});

test('library already walked: restart from the top to catch additions', () => {
  // Google Photos shows the newest first: additions appear at the top, not
  // where the previous pass stopped.
  const r = planResume({ scrollTop: 39000, reachedEnd: true }, metrics(), opts());
  assert.equal(r.startTop, 0);
  assert.equal(r.reason, 'top-completed');
});

test('normal resume: restart one screen earlier', () => {
  const r = planResume({ scrollTop: 20000, reachedEnd: false }, metrics(800, 40000), opts());
  assert.equal(r.reason, 'resume');
  assert.equal(r.startTop, 19200, 'one screen of overlap absorbs grid reflow');
});

test('the overlap is configurable', () => {
  const r = planResume(
    { scrollTop: 20000, reachedEnd: false },
    metrics(800, 40000),
    opts({ overlapRatio: 2.5 })
  );
  assert.equal(r.startTop, 18000);
});

test('the overlap never pushes below zero', () => {
  const r = planResume({ scrollTop: 300, reachedEnd: false }, metrics(800, 40000), opts());
  assert.equal(r.startTop, 0);
  assert.equal(r.reason, 'resume');
});

test('a position beyond the current grid is clamped', () => {
  // Real case: photos were deleted since the last pass and the grid shrank.
  // Unclamped, we would ask for an impossible scroll and the browser would drop
  // us at the very bottom, skipping everything else.
  const r = planResume({ scrollTop: 90000, reachedEnd: false }, metrics(800, 10000), opts());
  assert.equal(r.startTop, 9200, 'clamped to the furthest reachable position');
  assert.ok(r.startTop <= 10000 - 800);
});

test('a corrupt cursor is ignored rather than propagated', () => {
  for (const bad of [{ scrollTop: NaN }, { scrollTop: undefined }, { scrollTop: -5 }, {}]) {
    const r = planResume(bad, metrics(), opts());
    assert.equal(r.startTop, 0, `cursor ${JSON.stringify(bad)}`);
    assert.equal(r.reason, 'top-no-cursor');
  }
});

/* ------------------------------------------------------------ time window */

const ts = (y, m = 1, d = 1) => new Date(y, m - 1, d).getTime();

test('with no bound, everything is kept and nothing is "seeking"', () => {
  const w = new DateWindow(null);
  for (const t of [ts(1999), ts(2010), null, ts(2026)]) {
    assert.equal(w.consider(t), 'keep');
  }
  assert.equal(w.active, false);
  assert.equal(w.seeking, false, 'with no bound there is no zone to cross');
});

test('"older than" keeps the old and drops the recent', () => {
  // The direction that matters for cleaning: purge the old, protect the new.
  const w = new DateWindow(ts(2020));
  assert.equal(w.consider(ts(2015)), 'keep', 'older than the bound: in scope');
  assert.equal(w.consider(ts(2023)), 'skip', 'newer than the bound: protected');
  assert.equal(w.consider(ts(2020)), 'skip', 'the boundary date itself is protected');
});

test('the seeking phase ends on the first in-scope item', () => {
  const w = new DateWindow(ts(2020));
  assert.equal(w.seeking, true, 'we start inside the recent zone');
  w.consider(ts(2024));
  w.consider(ts(2022));
  assert.equal(w.seeking, true, 'recent items do not end seeking');
  w.consider(ts(2010));
  assert.equal(w.seeking, false, 'the first old-enough item flips the phase');
});

test('an undated item is kept but does not flip the phase', () => {
  // Keep it: better to offer something uncertain than to lose it. Do not flip:
  // leaving the seeking zone on an accident would resume the normal step
  // hundreds of screens too early.
  const w = new DateWindow(ts(2020));
  assert.equal(w.consider(null), 'keep');
  assert.equal(w.seeking, true, 'an unreadable date proves nothing');
  w.consider(ts(2010));
  assert.equal(w.seeking, false);
});

test('the seeking phase never reopens', () => {
  // The grid is chronological: once the boundary is crossed, a stray recent
  // item must not send the scanner back into fast-skim mode.
  const w = new DateWindow(ts(2020));
  w.consider(ts(2010));
  assert.equal(w.seeking, false);
  w.consider(ts(2025));
  assert.equal(w.seeking, false, 'a stray recent item does not restart seeking');
});

/* ------------------------------------------------------------ date carry */

test('a read date is never overwritten by a carry', () => {
  const clean = { ts: ts(2021, 5, 3), precision: 'day', dateSource: 'label' };
  assert.equal(inheritDate(clean, { ts: ts(1999), precision: 'day' }), null);
});

test('a missing date is taken from the previous tile', () => {
  const r = inheritDate({ ts: null }, { ts: ts(2022, 3, 14), precision: 'day' });
  assert.equal(r.ts, ts(2022, 3, 14));
  assert.equal(r.precision, 'day');
  assert.equal(r.dateSource, 'carried', 'a carry must stay distinguishable from a read');
});

test('with no previous date, nothing is invented', () => {
  // At the very start of a scan, or after a jump, there is nothing to carry: a
  // fabricated date would be worse than a missing one.
  assert.equal(inheritDate({ ts: null }, null), null);
  assert.equal(inheritDate({ ts: null }, { ts: null }), null);
  assert.equal(inheritDate({ ts: null }, {}), null);
});

test('the neighbour precision is preserved', () => {
  assert.equal(inheritDate({ ts: null }, { ts: ts(2020), precision: 'month' }).precision, 'month');
  assert.equal(inheritDate({ ts: null }, { ts: ts(2020) }).precision, 'day', 'fallback value');
});

test('a missing item raises no error', () => {
  assert.equal(inheritDate(null, { ts: ts(2020), precision: 'day' }), null);
});

test('tileDateOnly reads the date without the rest of the metadata', () => {
  const tile = (attrs) => ({ getAttribute: (n) => attrs[n] ?? null });
  const r = tileDateOnly(tile({ 'aria-label': 'Photo prise le 5 janv. 2023, 15:04:05' }));
  assert.equal(new Date(r.ts).getFullYear(), 2023);
  assert.equal(tileDateOnly(tile({ 'aria-label': 'Sélectionner la photo' })), null);
  assert.equal(tileDateOnly(tile({})), null, 'no readable attribute');
  // Falls back to `title` when `aria-label` is missing.
  assert.ok(tileDateOnly(tile({ title: '12 décembre 2019' })));
});

/* --------------------------------------------------- thumbnail recovery */

test('nothing to do when no thumbnail is missing', () => {
  assert.deepEqual(planThumbRepair({ missing: 0 }), { mode: 'none', count: 0 });
});

test('a handful of items is recovered one by one', () => {
  // Common case after the fix: a few items seen just before their image
  // arrived. Bringing each back on screen costs a second or two.
  assert.equal(planThumbRepair({ missing: 10 }).mode, 'targeted');
  assert.equal(planThumbRepair({ missing: 500 }).mode, 'targeted', 'the threshold is inclusive');
});

test('above the threshold, a fresh pass is preferred', () => {
  // Recovering 10,000 items one by one would take hours, where walking the
  // grid again picks them up along the way.
  const p = planThumbRepair({ missing: 9848 });
  assert.equal(p.mode, 'rescan');
  assert.equal(p.count, 9848, 'the volume is reported so it can be announced');
});

test('the threshold is configurable', () => {
  assert.equal(planThumbRepair({ missing: 40, targetedLimit: 20 }).mode, 'rescan');
  assert.equal(planThumbRepair({ missing: 40, targetedLimit: 100 }).mode, 'targeted');
});

test('disabled recovery proposes nothing', () => {
  assert.equal(planThumbRepair({ missing: 10, enabled: false }).mode, 'none');
  assert.equal(planThumbRepair({ missing: 99999, enabled: false }).mode, 'none');
});

test('the attempt count is bounded', () => {
  // Unbounded, an item that will never have a preview (video still processing,
  // unsupported format) would be fished out on every run and the work would
  // never finish.
  assert.ok(MAX_THUMB_ATTEMPTS >= 1 && MAX_THUMB_ATTEMPTS <= 5,
    `unreasonable bound: ${MAX_THUMB_ATTEMPTS}`);
});

test('the resume point is never past the stored position', () => {
  // Safety invariant: resuming past where we stopped would skip items that
  // were never listed.
  for (const scrollTop of [0, 500, 5000, 25000, 39000]) {
    for (const overlapRatio of [0, 0.5, 1, 3]) {
      const r = planResume({ scrollTop, reachedEnd: false }, metrics(800, 40000), opts({ overlapRatio }));
      assert.ok(r.startTop <= scrollTop, `startTop ${r.startTop} > cursor ${scrollTop}`);
    }
  }
});
