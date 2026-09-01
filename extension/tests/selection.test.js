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

import { installDom } from './helpers/dom.js';

// Before the panel module is evaluated: `el()` reaches for `document` the
// moment anything calls it.
installDom();

const { Panel } = await import('../src/ui/panel.js');
import { PANEL_CSS } from '../src/ui/styles.js';
import { DEFAULT_FILTERS } from '../src/common/filters.js';

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

/* --------------------------------------------- what a tick has to repaint */

/**
 * The full-screen view is where ticking happens — that is the whole reason it
 * exists — and its footer carries both actions. It was the one thing a tick did
 * not repaint: the summary sat at "0 ticked" and both buttons stayed greyed
 * however many photos were selected, so the selection looked like it had not
 * registered at all.
 *
 * Rebuilding the modal instead is not an option: it would throw away the scroll
 * position of the grid being worked through, which is the bug `paintSelection`
 * was written to avoid in the first place.
 */
function actionPanel(selected = []) {
  const p = {
    state: { selection: new Set(selected), busy: null, byId: new Map() },
    modalTicked: { textContent: '' },
    modalTickButton: { disabled: false },
    modalBinButton: { disabled: false, textContent: '' },
    selectionWeight: Panel.prototype.selectionWeight,
    paintActions: Panel.prototype.paintActions
  };
  p.paintActions();
  return p;
}

test('a selection lights up the actions in the sorting view', () => {
  const p = actionPanel(['a', 'b', 'c']);
  assert.equal(p.modalBinButton.disabled, false);
  assert.equal(p.modalTickButton.disabled, false);
  assert.match(p.modalBinButton.textContent, /Move to bin \(3\)/);
});

test('an empty selection leaves both actions unusable', () => {
  const p = actionPanel([]);
  assert.equal(p.modalBinButton.disabled, true);
  assert.equal(p.modalTickButton.disabled, true);
  assert.equal(p.modalBinButton.textContent, 'Move to bin', 'no count when there is nothing');
});

test('the count in the footer follows the selection', () => {
  const p = actionPanel(['a', 'b']);
  assert.equal(p.modalTicked.textContent, '2');
});

test('a run in progress blocks both actions whatever is selected', () => {
  const p = actionPanel(['a']);
  p.state.busy = 'full';
  p.paintActions();
  assert.equal(p.modalBinButton.disabled, true);
  assert.equal(p.modalTickButton.disabled, true);
});

test('repainting a closed modal is not an error', () => {
  // The modal is torn down whenever it closes; a tick from the panel side must
  // not care.
  const p = {
    state: { selection: new Set(['a']), busy: null, byId: new Map() },
    modalTicked: null, modalTickButton: null, modalBinButton: null,
    selectionWeight: Panel.prototype.selectionWeight,
    paintActions: Panel.prototype.paintActions
  };
  assert.doesNotThrow(() => p.paintActions());
});

test('every tick repaints the actions', () => {
  // paintSelection -> refreshCounters -> paintActions. Without that last link
  // the footer only wakes up on a filter change.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const start = source.indexOf('  refreshCounters() {');
  const block = source.slice(start, source.indexOf('  onFilterChange()', start));
  assert.match(block, /this\.paintActions\(\)/);
});

test('the ticking log survives the footer being repainted', () => {
  // renderFooter runs on every tick and used to build a fresh log element,
  // while a running job held the old one and wrote into nothing.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  assert.match(source, /this\.selectLog \|\|= el\('div', \{ class: 'log' \}\)/);
});

/* --------------------------------------------------- looking at one photo */

/**
 * The full-size view.
 *
 * Both renditions come from the base URL the grid already holds, asked for
 * differently — verified against a live library: `=w1600-h1600` returns a
 * 263KB JPEG, and `=m18` on an 8-second clip returns 697KB of video/mp4, which
 * is the file Google serves to its own player.
 */
const PANEL_SOURCE = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');

function viewerBody() {
  const start = PANEL_SOURCE.indexOf('  openViewer(item) {');
  assert.notEqual(start, -1);
  return PANEL_SOURCE.slice(start, PANEL_SOURCE.indexOf('  closeViewer() {'));
}

test('a video is played, a photo is shown', () => {
  const body = viewerBody();
  assert.match(body, /item\.isVideo[\s\S]{0,120}=m18/);
  assert.match(body, /=w1600-h1600/);
  assert.match(body, /controls: true/);
});

test('the size suffix is replaced, never appended', () => {
  // The stored URL already carries `=w176-h176`. Appending would ask for a
  // nonsense size and get a 400.
  assert.match(viewerBody(), /\.split\('='\)\[0\]/);
});

test('opening the view does not tick the photo under it', () => {
  // Every other click in that grid ticks something, so the button has to stop
  // the click from reaching the tile.
  const start = PANEL_SOURCE.indexOf("class: 'zoom'");
  const block = PANEL_SOURCE.slice(start, start + 320);
  assert.match(block, /ev\.stopPropagation\(\)/);
  assert.match(block, /this\.openViewer\(item\)/);
});

test('closing empties the view rather than hiding it', () => {
  // A hidden <video> keeps playing, and the sound would follow the user back
  // into the grid with nothing on screen to explain it.
  const start = PANEL_SOURCE.indexOf('  closeViewer() {');
  const body = PANEL_SOURCE.slice(start, start + 400);
  assert.match(body, /replaceChildren\(\)/);
  assert.match(body, /hidden = true/);
});

test('Escape closes the view before the grid behind it', () => {
  // Closing both at once would lose the user's place in a list they were
  // partway through.
  const start = PANEL_SOURCE.indexOf("if (e.key !== 'Escape') return;");
  const body = PANEL_SOURCE.slice(start, start + 420);
  assert.ok(body.indexOf('closeViewer') < body.indexOf('closeModal'),
    'the viewer must be tested first');
});

/* ------------------------------------------------------ facts on the tile */

test('a tile shows the date, and the size when it is known', () => {
  const start = PANEL_SOURCE.indexOf("el('span', { class: 'facts' }");
  assert.notEqual(start, -1, 'the tile must carry its facts');
  const block = PANEL_SOURCE.slice(start, start + 500);
  assert.match(block, /formatDate/);
  assert.match(block, /itemBytes\(item\) \?/,
    'an unmeasured photo must show nothing rather than 0 B');
});

test('ticking from the full-size view does not restart the video', () => {
  // Rebuilding the sheet rebuilds the <video> with it, and playback jumps back
  // to the start. The button is repainted instead, like every other control
  // that follows the selection.
  const start = PANEL_SOURCE.indexOf('  openViewer(item) {');
  const body = PANEL_SOURCE.slice(start, PANEL_SOURCE.indexOf('  closeViewer() {'));
  assert.match(body, /this\.viewerTickButton = el\('button'/);
  assert.equal(/onclick[\s\S]{0,200}this\.openViewer\(item\)/.test(body), false,
    'the viewer must not re-open itself to update one label');
});

test('the viewer tick follows the selection while it is open', () => {
  const button = { textContent: '', className: '' };
  const p = {
    state: { selection: new Set(), busy: null, byId: new Map() },
    viewerTickButton: button, viewerTickId: 'a',
    sectionButtons: null, modalTicked: null, modalTickButton: null, modalBinButton: null,
    selectionWeight: Panel.prototype.selectionWeight,
    paintActions: Panel.prototype.paintActions
  };
  p.paintActions();
  assert.match(button.textContent, /Tick this one/);

  p.state.selection.add('a');
  p.paintActions();
  assert.match(button.textContent, /Ticked/);
  assert.match(button.className, /primary/);
});

/* ------------------------------------------------- what covers what, on a tile */

/**
 * Four things are written over a thumbnail: the tick mark, the view button,
 * the criterion tags and the facts. Absolute positioning gives no warning when
 * two of them land in the same place — the later one simply wins, and the
 * earlier one stops working. It happened twice in one change: the view button
 * was put on the tick mark, and the facts bar over the tags bar.
 */
const CSS = PANEL_CSS;

/** The declarations of one rule, as written. */
function rule(selector) {
  const at = CSS.indexOf(`${selector} {`);
  assert.notEqual(at, -1, `${selector} is not in the stylesheet`);
  return CSS.slice(at, CSS.indexOf('}', at));
}

test('the view button is not on top of the tick mark', () => {
  // The mark is the control the whole grid is built around. A 22px button over
  // a 17px checkbox means every click meant for it opens the picture instead.
  const mark = rule('.thumb .mark');
  const zoom = rule('.thumb .zoom');
  assert.match(mark, /left:\s*4px/);
  assert.match(zoom, /right:\s*4px/, 'the button belongs in the opposite corner');
  assert.equal(/left:\s*4px/.test(zoom), false);
});

test('a hidden view button does not swallow clicks', () => {
  // opacity: 0 still receives them, which is how it took the tick's clicks
  // even on tiles nobody was hovering.
  assert.match(rule('.thumb .zoom'), /pointer-events:\s*none/);
  assert.match(CSS, /\.thumb:hover \.zoom[^{]*\{[^}]*pointer-events:\s*auto/);
});

test('the bar over the bottom of a tile is one bar', () => {
  // Two overlays anchored to bottom:0 stack, and the later one wins.
  assert.match(rule('.thumb .overlay'), /bottom:\s*0/);
  const tags = rule('.thumb .tags');
  const facts = rule('.thumb .facts');
  for (const [name, body] of [['tags', tags], ['facts', facts]]) {
    assert.equal(/position:\s*absolute/.test(body), false,
      `.thumb .${name} must sit inside the bar, not float over the tile`);
  }
});

test('the bar does not take clicks away from the tile', () => {
  // It is a label. Ticking has to work everywhere on a thumbnail, including
  // the strip where the date is written.
  assert.match(rule('.thumb .overlay'), /pointer-events:\s*none/);
});

test('nothing else claims the corner the bar occupies', () => {
  // The video badge sat at bottom-right, under the facts.
  assert.match(rule('.thumb.video::after'), /display:\s*none/);
});

/* --------------------------------------------------------- what sits above what */

/**
 * The viewer opens from inside the sorting grid, so it is by definition the
 * innermost thing on screen. It was written with the panel's z-index, which
 * put it *under* the modal — and the modal has an opaque background, so the
 * photo was rendered exactly where nobody could see it.
 *
 * These raw numbers are near the ceiling of what a page may use and are
 * indistinguishable at a glance, which is how the wrong rung got copied. The
 * ladder is named now, and the order is asserted rather than left to whoever
 * reads four nine-digit numbers carefully enough.
 */
function layer(name) {
  const m = new RegExp(String.raw`--z-${name}:\s*(\d+)`).exec(PANEL_CSS);
  assert.ok(m, `--z-${name} is not defined`);
  return Number(m[1]);
}

test('the layers are a strict ladder, in the order they overlap', () => {
  const badge = layer('badge');
  const panel = layer('panel');
  const modal = layer('modal');
  const viewer = layer('viewer');
  assert.ok(badge < panel, 'the panel covers the badge that opens it');
  assert.ok(panel < modal, 'the sorting view covers the panel');
  assert.ok(modal < viewer, 'and the viewer covers the sorting view it opens from');
});

test('no two layers share a rung', () => {
  // The original bug: the viewer was given the panel's number, which reads as
  // deliberate and is impossible to spot by eye.
  const values = ['badge', 'panel', 'modal', 'viewer'].map(layer);
  assert.equal(new Set(values).size, values.length, `duplicate z-index: ${values.join(', ')}`);
});

test('nothing hard-codes a raw stacking number any more', () => {
  // A literal 2147483002 tells the next reader nothing about what it must sit
  // above, which is exactly how this went wrong.
  const stray = [...PANEL_CSS.matchAll(/z-index:\s*(214748\d+)/g)].map((m) => m[1]);
  assert.deepEqual(stray, [], `raw z-index values left in the stylesheet: ${stray.join(', ')}`);
});

test('the viewer covers the whole window, not a corner of it', () => {
  const rule = PANEL_CSS.slice(PANEL_CSS.indexOf('.viewer {'), PANEL_CSS.indexOf('}', PANEL_CSS.indexOf('.viewer {')));
  assert.match(rule, /position:\s*fixed/);
  assert.match(rule, /inset:\s*0/);
});

/* ------------------------------------------------------- opening by right-click */

test('right-clicking a tile opens it', () => {
  // The button in the corner is 22px and only appears on hover. Judging a grid
  // means looking closely at a great many photos, and the whole tile is
  // already under the pointer.
  const start = PANEL_SOURCE.indexOf('  buildThumb(item, index = 0) {');
  const block = PANEL_SOURCE.slice(start, PANEL_SOURCE.indexOf('item.url ?', start));
  assert.match(block, /oncontextmenu:/);
  assert.match(block, /this\.openViewer\(item\)/);
});

test('the browser menu does not also appear', () => {
  // Left alone it would open over the photo the viewer is about to show.
  const start = PANEL_SOURCE.indexOf('oncontextmenu:');
  const handler = PANEL_SOURCE.slice(start, start + 160);
  assert.match(handler, /ev\.preventDefault\(\)/);
});

test('right-clicking never ticks the photo as well', () => {
  // `click` does not fire for the secondary button, so the two gestures cannot
  // collide — but the handler must not call pickThumb itself either.
  const start = PANEL_SOURCE.indexOf('oncontextmenu:');
  const handler = PANEL_SOURCE.slice(start, start + 160);
  assert.equal(/pickThumb/.test(handler), false);
});

test('the corner button stays', () => {
  // Right-click is a shortcut, not a replacement: nothing on screen announces
  // it, and a feature with no visible affordance is one most people never find.
  assert.match(PANEL_SOURCE, /class: 'zoom'/);
});

/* ------------------------------------------------- filtering does not select */

/**
 * A criterion is a guess. The screenshot detector is "fair" by its own README,
 * blur has a threshold somebody dragged, and "no people" leans on a model.
 * Switching one on used to tick everything it caught — turning that guess into
 * a selection, a thousand photos one click from the bin before anyone had
 * looked at one of them.
 *
 * Filtering shows. Selecting is the judgement, and it stays deliberate.
 */
test('a filter that matches everything selects nothing', () => {
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const start = source.indexOf('  recompute() {');
  const body = source.slice(start, source.indexOf('  renderAll() {', start));
  assert.equal(/this\.state\.selection = new Set\(/.test(body), false,
    'recompute must never build a selection, only shrink one');
});

test('a selection survives a reorder but not a photo leaving the grid', () => {
  // Reordering shows the same photos differently, so the ticks stand. A photo
  // no longer matching has left the answer, and a count that included it would
  // describe something invisible.
  const keep = { id: 'stays' };
  const p = {
    state: {
      items: [keep], filtered: [keep], sections: null,
      selection: new Set(['stays', 'gone']),
      settings: { hideKept: false, mediaLens: 'all' },
      counts: {}, people: { groups: [] }, filters: structuredClone(DEFAULT_FILTERS)
    }
  };
  // The narrowing step, as recompute performs it.
  const visible = new Set(p.state.filtered.map((it) => it.id));
  for (const id of p.state.selection) if (!visible.has(id)) p.state.selection.delete(id);

  assert.deepEqual([...p.state.selection], ['stays']);
});

test('taking a whole answer is a button, and it says how many', () => {
  // The only way to do at once what filtering used to do by itself, so it has
  // to be findable and it has to state its size. What it takes is the grid,
  // not the list behind it — and the number has to track that as the grid
  // grows, or the button understates itself.
  const label = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('  tickAllLabel() {'), PANEL_SOURCE.indexOf('  showMore('));
  assert.match(label, /Math\.min\(this\.state\.renderLimit, this\.state\.filtered\.length\)/);
  assert.match(label, /Tick all\$\{n \? ` \(\$\{nf\(n\)\}\)` : ''\}/);

  const at = PANEL_SOURCE.indexOf('this.modalTickAll = el(');
  assert.match(PANEL_SOURCE.slice(at, at + 400), /disabled: !this\.state\.filtered\.length/,
    'and offers nothing when there is nothing to take');
  assert.match(PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('  paintMore() {'), PANEL_SOURCE.indexOf('  paintMore() {') + 300),
    /this\.modalTickAll\.textContent = this\.tickAllLabel\(\)/,
    'repainted as the grid grows, never left stale');
});

/* --------------------------------------------- a magnified image must be caged */

/**
 * A face crop is an image several hundred per cent wide, absolutely
 * positioned. Two properties on its container keep that from being a disaster,
 * and neither announces itself in a diff:
 *
 *   position — without it the image climbs to the nearest positioned ancestor
 *              and lays the photograph across the whole panel
 *   overflow — without it the image spills out of the circle
 *
 * Both were once written only into the viewer strip's copy of the rule, and
 * the Protected tab, which reused the class, got neither.
 */
test('the crop container cages what is inside it', () => {
  const rule = PANEL_CSS.slice(PANEL_CSS.indexOf('.crop {'), PANEL_CSS.indexOf('}', PANEL_CSS.indexOf('.crop {')));
  assert.match(rule, /position:\s*relative/);
  assert.match(rule, /overflow:\s*hidden/);
});

test('the caging is written once, not per place it is used', () => {
  // Two copies is how one of them ended up missing both properties.
  const containers = [...PANEL_CSS.matchAll(/^\.[\w-]+ \.crop \{([^}]*)\}/gm)].map((m) => m[1]);
  for (const body of containers) {
    assert.equal(/position:|overflow:/.test(body), false,
      `a per-context .crop rule is re-declaring the caging: ${body.trim()}`);
  }
});

test('the image inside is positioned and unconstrained', () => {
  // max-width would otherwise shrink it back to the frame and the offsets
  // would frame the wrong part of the photograph.
  const rule = PANEL_CSS.slice(PANEL_CSS.indexOf('.crop img {'), PANEL_CSS.indexOf('}', PANEL_CSS.indexOf('.crop img {')));
  assert.match(rule, /position:\s*absolute/);
  assert.match(rule, /max-width:\s*none/);
  assert.match(rule, /object-fit:\s*fill/);
});

/* --------------------------------------------- the budget needs a way out */

/**
 * Only three hundred tiles are drawn at once, which is a display budget and
 * not a filter. The way past it has to reach every view.
 *
 * It once lived inside the branch that draws a flat grid, so an order that
 * groups — by day, by person, by likeness — spent the budget on its first few
 * blocks, dropped every block past them without a word, and offered no way to
 * ask for more. Sorted oldest-first that reads as a library which stops after
 * about a month.
 */
const MORE = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('  paintMore() {'), PANEL_SOURCE.indexOf('  /**\n   * The grid, split into blocks.'));

test('the way past the render budget is outside the branch that splits the grid', () => {
  const start = PANEL_SOURCE.indexOf('    } else if (this.state.sections) {');
  const body = PANEL_SOURCE.slice(start, start + 1600);

  // Neither arm may own it — both are cut by the same budget.
  const flatArm = body.slice(body.indexOf('} else {'), body.indexOf('    // Outside the branch'));
  assert.equal(/Show more/.test(flatArm), false, 'the flat arm must not own it');
  assert.match(body, /this\.moreBox = el/);
  assert.match(MORE, /Show more \(\$\{nf\(left\)\} left\)/);
});

test('what is left is counted against the whole list, not the blocks drawn', () => {
  assert.match(MORE, /const total = this\.state\.filtered\.length/);
  assert.match(MORE, /const drawn = Math\.min\(this\.state\.renderLimit, total\)/);
  assert.match(MORE, /const left = total - drawn/);
});

test('a long list can be opened in one go rather than six hundred at a time', () => {
  // Four thousand photos is seven presses otherwise, and the count on the
  // button is the only thing telling you the list did not end.
  assert.match(MORE, /Show all \$\{nf\(total\)\}/);
  assert.match(MORE, /this\.showMore\(total\)/);
  assert.match(MORE, /left > 600/, 'and it is not offered when it would do nothing');
});

test('the buttons go when there is nothing left behind them', () => {
  assert.match(MORE, /if \(left <= 0\) \{ this\.moreBox\.replaceChildren\(\); return; \}/);
});

test('a block says how many of its photos are drawn when not all are', () => {
  // Without it a half-drawn day looks like a day with fewer photos in it.
  const body = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('  sectionNote(section, count) {'), PANEL_SOURCE.indexOf('  buildSectionBlock('));
  assert.match(body, /count < section\.items\.length \? `\$\{nf\(count\)\} shown`/);
});

/* ------------------------------------------- showing more continues, not restarts */

/**
 * Pressing "Show more" is pressing "continue".
 *
 * A render replaces every node in the grid, and the scroll position goes with
 * them — back to the top of a list the user had just scrolled to the bottom of
 * in order to press the button. This is the fifth bug of that shape in this
 * file's history, which is why the rule in CLAUDE.md is repaint, never
 * re-render.
 */
const SHOW_MORE = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('  showMore(limit) {'), PANEL_SOURCE.indexOf('  growSections(to) {'));

test('showing more appends rather than rendering', () => {
  assert.equal(/this\.render(Modal|All|Scan)\(\)/.test(SHOW_MORE), false,
    'a render would send the user back to the top of the list they were reading');
  assert.match(SHOW_MORE, /this\.flatGrid\.append\(this\.buildThumb/);
  assert.match(SHOW_MORE, /this\.growSections\(to\)/);
});

test('the appended tiles pick up where the drawn ones stopped', () => {
  // Off by one here draws a duplicate row or skips a photo, and neither is
  // visible in a grid of hundreds.
  assert.match(SHOW_MORE, /const from = Math\.min\(this\.state\.renderLimit, total\)/);
  assert.match(SHOW_MORE, /for \(let i = from; i < to; i\+\+\)/);
});

test('showing more past the end of the list does nothing at all', () => {
  assert.match(SHOW_MORE, /const to = Math\.max\(from, Math\.min\(limit, total\)\)/);
  assert.match(SHOW_MORE, /if \(to === from\) return/);
});

test('the new tiles are marked and the counts move', () => {
  // They arrive unmarked; a selection made before pressing would look emptied.
  assert.match(SHOW_MORE, /this\.paintSelection\(\)/);
  assert.match(SHOW_MORE, /this\.paintActions\(\)/);
  assert.match(SHOW_MORE, /this\.paintMore\(\)/);
});

test('a block entirely off screen is inserted above the buttons, not after them', () => {
  const body = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('  growSections(to) {'), PANEL_SOURCE.indexOf('  sectionNote(section, count) {'));
  assert.match(body, /this\.moreBox\.before\(rec\.node\)/);
});

test('block records line up with sections by position, without searching', () => {
  // A find() per section per press is quadratic over a library split by day.
  const body = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('  growSections(to) {'), PANEL_SOURCE.indexOf('  sectionNote(section, count) {'));
  assert.match(body, /let rec = this\.sectionBlocks\[idx\]/);
  assert.equal(/\.find\(/.test(body), false);
});

test('the records are sparse, and reading them says so', () => {
  // Blocks past the budget have no record until drawn.
  const body = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('  paintActions() {'), PANEL_SOURCE.indexOf('  paintActions() {') + 1600);
  assert.match(body, /for \(const rec of this\.sectionBlocks \|\| \[\]\)/);
  assert.match(body, /if \(!rec\) continue/);
});

test('a closed modal forgets the nodes it was appending into', () => {
  // Appending into a detached grid is invisible, and would hide the fact that
  // it never ran.
  const body = PANEL_SOURCE.slice(PANEL_SOURCE.indexOf('    if (!this.state.modalOpen) {'), PANEL_SOURCE.indexOf('    const shown = this.state.filtered'));
  for (const held of ['sectionBlocks', 'flatGrid', 'moreBox', 'modalTickAll']) {
    assert.match(body, new RegExp(`this\\.${held} = null`), `${held} outlives the modal`);
  }
});

/* ------------------------------------------- and the arithmetic, run for real */

/**
 * The source checks above cannot see an off-by-one, and an off-by-one here
 * draws a duplicate row or skips a photo — neither of which is visible in a
 * grid of hundreds. So the append is run against stub nodes.
 */
function fakePanel(filtered, { sections = null, limit = 3 } = {}) {
  const drawn = [];
  const p = {
    state: { filtered, sections, renderLimit: limit, selection: new Set() },
    flatGrid: sections ? null : { append: (t) => drawn.push(t) },
    sectionBlocks: sections ? [] : null,
    moreBox: { before: (node) => drawn.push(node) },
    buildThumb: (item, i) => ({ id: item.id, i }),
    buildSectionBlock: Panel.prototype.buildSectionBlock,
    sectionNote: Panel.prototype.sectionNote,
    growSections: Panel.prototype.growSections,
    showMore: Panel.prototype.showMore,
    paintMore() {}, paintSelection() {}, paintActions() {},
    toggleSection() {}
  };
  return { p, drawn };
}

const items = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, ts: i }));

test('appending continues from the last drawn tile, with no gap and no repeat', () => {
  const { p, drawn } = fakePanel(items, { limit: 3 });
  p.showMore(7);
  assert.deepEqual(drawn.map((t) => t.i), [3, 4, 5, 6]);
  assert.deepEqual(drawn.map((t) => t.id), ['p3', 'p4', 'p5', 'p6']);
  assert.equal(p.state.renderLimit, 7);
});

test('appending twice in a row never redraws what is already there', () => {
  const { p, drawn } = fakePanel(items, { limit: 2 });
  p.showMore(5);
  p.showMore(8);
  assert.deepEqual(drawn.map((t) => t.i), [2, 3, 4, 5, 6, 7]);
});

test('asking past the end stops at the end', () => {
  const { p, drawn } = fakePanel(items, { limit: 8 });
  p.showMore(9999);
  assert.deepEqual(drawn.map((t) => t.i), [8, 9]);
  assert.equal(p.state.renderLimit, 10);
});

test('asking for less than is drawn changes nothing', () => {
  const { p, drawn } = fakePanel(items, { limit: 6 });
  p.showMore(2);
  assert.deepEqual(drawn, []);
  assert.equal(p.state.renderLimit, 6, 'and never shrinks the grid under the user');
});

/* --- the same, split into blocks, where a block can be half drawn --- */

const blocks = [
  { title: 'day one', items: items.slice(0, 4) },
  { title: 'day two', items: items.slice(4, 6) },
  { title: 'day three', items: items.slice(6, 10) }
];

function sectioned(limit) {
  const { p } = fakePanel(items, { sections: blocks, limit });
  // Build what the first render would have built, through the same path.
  let start = 0;
  blocks.forEach((section, idx) => {
    const offset = start;
    start += section.items.length;
    const count = Math.max(0, Math.min(section.items.length, limit - offset));
    if (!count) return;
    p.sectionBlocks[idx] = p.buildSectionBlock.call(p, section, offset, count);
  });
  return p;
}

test('a half-drawn block is filled in before the next one is started', () => {
  const p = sectioned(2);                    // day one showing 2 of 4
  assert.deepEqual(p.sectionBlocks[0].ids, ['p0', 'p1']);
  assert.equal(p.sectionBlocks[1], undefined);

  p.showMore(5);                             // day one whole, day two started
  assert.deepEqual(p.sectionBlocks[0].ids, ['p0', 'p1', 'p2', 'p3']);
  assert.deepEqual(p.sectionBlocks[1].ids, ['p4']);
  assert.equal(p.sectionBlocks[2], undefined, 'a block past the budget stays undrawn');
});

test('tile indices stay global across blocks', () => {
  // They address the flat list — the viewer steps through it with the arrow
  // keys, and paintSelection reads them back.
  const p = sectioned(2);
  const seen = [];
  p.buildThumb = (item, i) => { seen.push([item.id, i]); return {}; };
  p.showMore(8);
  assert.deepEqual(seen, [['p2', 2], ['p3', 3], ['p4', 4], ['p5', 5], ['p6', 6], ['p7', 7]]);
});

test('a block ticks what it has drawn, and that grows with it', () => {
  const p = sectioned(2);
  const rec = p.sectionBlocks[0];
  let asked = null;
  p.toggleSection = (ids) => { asked = [...ids]; };

  rec.button.fire('click');
  assert.deepEqual(asked, ['p0', 'p1'], 'half a block ticks its half');

  p.showMore(10);
  rec.button.fire('click');
  assert.deepEqual(asked, ['p0', 'p1', 'p2', 'p3'], 'and the whole of it once whole');
});

test('a block header stops saying "shown" once all of it is', () => {
  const p = sectioned(2);
  assert.match(p.sectionBlocks[0].note.textContent, /2 shown/);
  p.showMore(10);
  assert.equal(/shown/.test(p.sectionBlocks[0].note.textContent), false);
  assert.match(p.sectionBlocks[0].note.textContent, /4 photo\(s\)/);
});
