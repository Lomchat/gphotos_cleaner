/**
 * Ticking thumbnails, one at a time or by the run.
 *
 * This is the last thing between a user and a list handed to Google Photos, so
 * the rules have to be boring and predictable. The case worth guarding is the
 * one that looks harmless: Shift over a partly-ticked run. If each tile merely
 * toggled, a photo the user had deliberately spared would flip into the
 * selection without anyone noticing.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Panel } from '../src/ui/panel.js';

/** A Panel stand-in with just the state the selection methods touch. */
function panel(ids, selected = []) {
  const painted = [];
  const fake = {
    state: {
      filtered: ids.map((id) => ({ id })),
      selection: new Set(selected)
    },
    anchorIndex: null,
    rangePreview: null,
    shiftHeld: false,
    renderAll() { this.rendered = (this.rendered || 0) + 1; },
    // Ticking repaints rather than re-rendering, so the grid keeps its scroll
    // position. The double counts both, and the tests below assert that a tick
    // never reaches for the heavy one.
    paintSelection() { this.repainted = (this.repainted || 0) + 1; },
    paintRangePreview() { painted.push(this.rangePreview); },
    pickThumb: Panel.prototype.pickThumb,
    previewRange: Panel.prototype.previewRange,
    clearRangePreview: Panel.prototype.clearRangePreview,
    visibleItems: Panel.prototype.visibleItems
  };
  fake.painted = painted;
  return fake;
}

const sel = (p) => [...p.state.selection].sort();

/* ------------------------------------------------------------ one at a time */

test('a plain click ticks', () => {
  const p = panel(['a', 'b', 'c']);
  p.pickThumb('b', 1, false);
  assert.deepEqual(sel(p), ['b']);
});

test('a second plain click unticks', () => {
  const p = panel(['a', 'b', 'c'], ['b']);
  p.pickThumb('b', 1, false);
  assert.deepEqual(sel(p), []);
});

test('a plain click moves the anchor', () => {
  const p = panel(['a', 'b', 'c']);
  p.pickThumb('c', 2, false);
  assert.equal(p.anchorIndex, 2);
});

/* -------------------------------------------------------------- by the run */

test('Shift fills the run between the anchor and the click', () => {
  const p = panel(['a', 'b', 'c', 'd', 'e']);
  p.pickThumb('b', 1, false);
  p.pickThumb('d', 3, true);
  assert.deepEqual(sel(p), ['b', 'c', 'd']);
});

test('the run works backwards too', () => {
  const p = panel(['a', 'b', 'c', 'd', 'e']);
  p.pickThumb('d', 3, false);
  p.pickThumb('b', 1, true);
  assert.deepEqual(sel(p), ['b', 'c', 'd']);
});

test('Shift from an unticked anchor clears the run instead of toggling it', () => {
  // The rule that matters: the anchor decides, so the whole run ends in one
  // known state. Toggling each tile would flip photos the user had spared.
  const p = panel(['a', 'b', 'c', 'd'], ['a', 'b', 'c', 'd']);
  p.pickThumb('b', 1, false);        // unticks b, anchor = 1
  p.pickThumb('d', 3, true);
  assert.deepEqual(sel(p), ['a']);
});

test('a mixed run ends uniform, never half-flipped', () => {
  const p = panel(['a', 'b', 'c', 'd', 'e'], ['c']);
  p.pickThumb('a', 0, false);        // ticks a, anchor = 0
  p.pickThumb('e', 4, true);
  assert.deepEqual(sel(p), ['a', 'b', 'c', 'd', 'e']);
});

test('Shift on the anchor itself changes nothing beyond it', () => {
  const p = panel(['a', 'b', 'c']);
  p.pickThumb('b', 1, false);
  p.pickThumb('b', 1, true);
  assert.deepEqual(sel(p), ['b']);
});

test('Shift with no anchor yet behaves like a plain click', () => {
  const p = panel(['a', 'b', 'c']);
  p.pickThumb('c', 2, true);
  assert.deepEqual(sel(p), ['c']);
  assert.equal(p.anchorIndex, 2);
});

test('a stale anchor past the end of the list is ignored', () => {
  // The grid reorders under the user; an index kept from a longer list must not
  // silently address the wrong photos.
  const p = panel(['a', 'b']);
  p.anchorIndex = 9;
  p.pickThumb('a', 0, true);
  assert.deepEqual(sel(p), ['a']);
});

test('the run covers every tile between the ends, inclusive', () => {
  const p = panel(['a', 'b', 'c', 'd', 'e', 'f']);
  p.pickThumb('a', 0, false);
  p.pickThumb('f', 5, true);
  assert.equal(p.state.selection.size, 6);
});

/* ---------------------------------------------------------------- preview */

test('holding Shift outlines the run that a click would take', () => {
  const p = panel(['a', 'b', 'c', 'd']);
  p.pickThumb('a', 0, false);
  p.shiftHeld = true;
  p.previewRange(2);
  assert.deepEqual(p.rangePreview, { from: 0, to: 2 });
});

test('the outline follows the pointer', () => {
  const p = panel(['a', 'b', 'c', 'd']);
  p.pickThumb('a', 0, false);
  p.shiftHeld = true;
  p.previewRange(1);
  p.previewRange(3);
  assert.deepEqual(p.rangePreview, { from: 0, to: 3 });
});

test('nothing is outlined without Shift', () => {
  const p = panel(['a', 'b', 'c']);
  p.pickThumb('a', 0, false);
  p.previewRange(2);
  assert.equal(p.rangePreview, null);
});

test('nothing is outlined before an anchor exists', () => {
  const p = panel(['a', 'b', 'c']);
  p.shiftHeld = true;
  p.previewRange(2);
  assert.equal(p.rangePreview, null);
});

test('clicking clears the outline so it cannot linger over a stale range', () => {
  const p = panel(['a', 'b', 'c']);
  p.pickThumb('a', 0, false);
  p.shiftHeld = true;
  p.previewRange(2);
  p.pickThumb('c', 2, true);
  assert.equal(p.rangePreview, null);
});

test('releasing Shift repaints, so the outline actually disappears', () => {
  const p = panel(['a', 'b', 'c']);
  p.pickThumb('a', 0, false);
  p.shiftHeld = true;
  p.previewRange(2);
  p.clearRangePreview();
  assert.equal(p.rangePreview, null);
  assert.equal(p.painted.at(-1), null, 'the repaint must have been asked for');
});

test('the outline describes exactly what the click will take', () => {
  // The promise the dashed border makes. If these two ever disagree the
  // preview becomes a lie told right before a deletion list is built.
  const p = panel(['a', 'b', 'c', 'd', 'e']);
  p.pickThumb('b', 1, false);
  p.shiftHeld = true;
  p.previewRange(3);
  const promised = [];
  for (let i = p.rangePreview.from; i <= p.rangePreview.to; i++) promised.push(p.state.filtered[i].id);

  p.pickThumb('d', 3, true);
  assert.deepEqual(sel(p), promised.sort());
});

/* ------------------------------------------------------- keeping the place */

test('ticking repaints in place instead of rebuilding the grid', () => {
  // The modal renders with replaceChildren, which discards the scroll position.
  // Ticking a photo halfway down a long grid used to throw the user back to the
  // top — every single time.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const pick = source.slice(source.indexOf('\n  pickThumb('), source.indexOf('\n  previewRange('));
  assert.equal(/renderAll\(\)/.test(pick), false,
    'a tick must not re-render: it would lose the scroll position');
  assert.match(pick, /paintSelection\(\)/);
});

test('tick all and untick all keep the place too', () => {
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const modal = source.slice(source.indexOf('Tick all'), source.indexOf('Untick all') + 400);
  assert.equal(/renderAll\(\)/.test(modal), false,
    'the bulk buttons must repaint, not re-render');
});

test('the repaint updates the marks, the counters and the footer', () => {
  // A tick that changed the border but not the count would be worse than a
  // rebuild: the number under the button is what the user reads before acting.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const paint = source.slice(source.indexOf('\n  paintSelection()'), source.indexOf('\n  previewRange('));
  for (const call of ['classList.toggle', 'refreshCounters()', 'renderFooter()']) {
    assert.ok(paint.includes(call), `paintSelection must call ${call}`);
  }
});

test('a tick repaints and never re-renders', () => {
  const p = panel(['a', 'b', 'c']);
  p.pickThumb('b', 1, false);
  assert.equal(p.repainted, 1);
  assert.equal(p.rendered, undefined, 're-rendering would lose the scroll position');
});
