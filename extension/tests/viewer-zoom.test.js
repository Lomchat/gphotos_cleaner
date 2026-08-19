/**
 * Looking closely at one photo: zooming it, and walking to the next.
 *
 * A zoom that drifts still zooms — it just fights whoever is using it, and a
 * screenshot cannot tell you which one you have. The property that decides it
 * is that the point under the cursor stays under the cursor; everything else
 * here follows from that or protects it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MIN_SCALE, MAX_SCALE, wheelPixels, clampScale, scaleAfterWheel,
  zoomAbout, clampPan, resetView, transformFor
} from '../src/ui/viewer-zoom.js';
import { neighbourOf } from '../src/ui/panel.js';

/** Where a content point ends up on screen under a given view. */
const project = (view, contentOffset) => view.x + contentOffset * view.scale;

/** And the inverse: what content sits under a screen point. */
const contentUnder = (view, screenOffset) => (screenOffset - view.x) / view.scale;

/* --------------------------------------------------------- the wheel itself */

test('a wheel is measured in pixels, whatever the device reports', () => {
  // A notched mouse reports lines and a trackpad reports pixels. Taken raw,
  // one would zoom a hundred times faster than the other.
  assert.equal(wheelPixels({ deltaY: 100, deltaMode: 0 }), 100);
  assert.equal(wheelPixels({ deltaY: 3, deltaMode: 1 }), 48);
  assert.equal(wheelPixels({ deltaY: 1, deltaMode: 2 }), 400);
  assert.equal(wheelPixels({}), 0);
});

test('scrolling up zooms in, down zooms out', () => {
  assert.ok(scaleAfterWheel(2, -100) > 2);
  assert.ok(scaleAfterWheel(2, 100) < 2);
});

test('a step feels the same at any magnification', () => {
  // Exponential, not additive: a fixed increment crawls at 1x and leaps at 6x.
  const from1 = scaleAfterWheel(1, -100) / 1;
  const from4 = scaleAfterWheel(4, -100) / 4;
  assert.ok(Math.abs(from1 - from4) < 1e-9, `${from1} vs ${from4}`);
});

test('the scale stays between fitted and useful', () => {
  assert.equal(clampScale(0.2), MIN_SCALE, 'below fitted there is nothing to see');
  assert.equal(clampScale(500), MAX_SCALE, 'past this the browser only interpolates');
  assert.equal(clampScale(NaN), MIN_SCALE, 'and nonsense resets rather than breaks');
});

test('scrolling out at the bottom does not go further', () => {
  assert.equal(scaleAfterWheel(MIN_SCALE, 1000), MIN_SCALE);
});

/* ----------------------------------------------- the point under the cursor */

test('what is under the cursor stays under the cursor', () => {
  // The whole reason this module exists. Zooming about the centre instead
  // pushes what you were looking at towards the edge on every step.
  const before = { scale: 1, x: 0, y: 0 };
  const px = 220;
  const held = contentUnder(before, px);

  const after = zoomAbout(before, 3, px, 0);
  assert.ok(Math.abs(project(after, held) - px) < 1e-9,
    `the point moved to ${project(after, held)} instead of staying at ${px}`);
});

test('it holds when already zoomed and panned', () => {
  // The case a naive implementation gets wrong: correct from the origin,
  // adrift once the view has been moved.
  const before = { scale: 2.5, x: -140, y: 60 };
  const px = -80;
  const py = 210;
  const heldX = contentUnder(before, px);
  const heldY = (py - before.y) / before.scale;

  const after = zoomAbout(before, 5, px, py);
  assert.ok(Math.abs(project(after, heldX) - px) < 1e-9);
  assert.ok(Math.abs((after.y + heldY * after.scale) - py) < 1e-9);
});

test('zooming about the centre leaves the view centred', () => {
  const after = zoomAbout({ scale: 1, x: 0, y: 0 }, 4, 0, 0);
  assert.equal(after.x, 0);
  assert.equal(after.y, 0);
});

test('zooming back out retraces the way in', () => {
  // Otherwise a wheel up-then-down leaves the picture somewhere it never was.
  const start = { scale: 1, x: 0, y: 0 };
  const px = 130;
  const py = -75;
  const zoomedIn = zoomAbout(start, 4, px, py);
  const back = zoomAbout(zoomedIn, 1, px, py);
  assert.ok(Math.abs(back.x - start.x) < 1e-9, `x drifted to ${back.x}`);
  assert.ok(Math.abs(back.y - start.y) < 1e-9, `y drifted to ${back.y}`);
});

test('a zoom that changes nothing moves nothing', () => {
  const view = { scale: MAX_SCALE, x: 40, y: -12 };
  const after = zoomAbout(view, MAX_SCALE * 2, 300, 300);
  assert.equal(after.x, 40);
  assert.equal(after.y, -12);
  assert.equal(after.scale, MAX_SCALE);
});

/* ------------------------------------------------------------------ panning */

test('a fitted picture cannot be dragged off centre', () => {
  // At 1x there is nothing hidden to reveal, so the only honest position is
  // centred — which is also what makes returning to 1x read as a reset.
  const out = clampPan({ scale: 1, x: 400, y: -300 },
    { mediaW: 800, mediaH: 600, stageW: 1000, stageH: 700 });
  assert.equal(out.x, 0);
  assert.equal(out.y, 0);
});

test('a zoomed picture may be moved by exactly what it overflows', () => {
  // 800 wide at 2x is 1600, in a 1000 stage: 600 hidden, 300 either side.
  const bounds = { mediaW: 800, mediaH: 600, stageW: 1000, stageH: 700 };
  assert.equal(clampPan({ scale: 2, x: 1000, y: 0 }, bounds).x, 300);
  assert.equal(clampPan({ scale: 2, x: -1000, y: 0 }, bounds).x, -300);
  assert.equal(clampPan({ scale: 2, x: 120, y: 0 }, bounds).x, 120, 'and is free within it');
});

test('the two axes are clamped independently', () => {
  // A tall photo in a wide stage overflows vertically long before it
  // overflows horizontally; one shared limit would either pin it or free it
  // in both directions at once.
  const out = clampPan({ scale: 2, x: 999, y: 999 },
    { mediaW: 400, mediaH: 600, stageW: 1000, stageH: 700 });
  assert.equal(out.x, 0, 'still narrower than the stage at 2x');
  assert.equal(out.y, 250, '600 at 2x is 1200 in a 700 stage');
});

test('the picture measured is the one on screen, not the stage', () => {
  // `object-fit: contain` means a photo rarely fills its stage. Clamping
  // against the stage would let a letterboxed picture be dragged out of sight.
  const bounds = { mediaW: 300, mediaH: 300, stageW: 1000, stageH: 700 };
  assert.equal(clampPan({ scale: 3, x: 500, y: 0 }, bounds).x, 0,
    '300 at 3x is 900, still inside a 1000 stage');
});

test('a picture that has not loaded yet clamps to centred', () => {
  // `offsetWidth` is 0 until it arrives, and the alternative is NaN offsets.
  const out = clampPan({ scale: 4, x: 50, y: 50 }, {});
  assert.equal(out.x, 0);
  assert.equal(out.y, 0);
});

/* ------------------------------------------------------------- the transform */

test('the reset view is fitted and centred', () => {
  assert.deepEqual(resetView(), { scale: MIN_SCALE, x: 0, y: 0 });
});

test('the transform translates before it scales', () => {
  // The other order multiplies the offsets by the scale, so a pan would
  // accelerate as you zoom in and the clamp arithmetic would be wrong.
  const css = transformFor({ scale: 2, x: 10, y: -20 });
  assert.ok(css.indexOf('translate') < css.indexOf('scale'), css);
  assert.match(css, /translate\(10\.0px, -20\.0px\)/);
  assert.match(css, /scale\(2\.000\)/);
});

/* ----------------------------------------------------------------- the wiring */

const SOURCE = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
const BIND = SOURCE.slice(SOURCE.indexOf('  bindViewerZoom('), SOURCE.indexOf('  closeViewer() {'));

test('the wheel does not also scroll what is behind the viewer', () => {
  // The grid is a list being worked through; scrolling it invisibly would
  // land the user somewhere else the moment they closed the photo.
  assert.match(BIND, /ev\.preventDefault\(\)/);
  assert.match(BIND, /\{ passive: false \}/,
    'a passive listener cannot preventDefault, and Chrome makes wheel passive by default');
});

test('the view is reset per photo, not carried between them', () => {
  // Otherwise the next photo opens at 6x, off-centre, showing a corner of
  // something with no clue why.
  assert.match(BIND, /let view = resetView\(\)/);
});

test('dragging is only offered when there is somewhere to go', () => {
  // At 1x a drag would swallow clicks meant for a video's controls.
  assert.match(BIND, /view\.scale <= MIN_SCALE \|\| ev\.button !== 0/);
});

test('there is a way back to fitted', () => {
  // A zoom whose only exit is the wheel is one people scroll at until it
  // gives up.
  assert.match(BIND, /dblclick/);
  assert.match(BIND, /view = resetView\(\)/);
});

test('the clamp measures the picture once it has loaded', () => {
  // Its laid-out size is 0 until then, and the limits depend on it.
  assert.match(BIND, /addEventListener\('load', apply\)/);
  assert.match(BIND, /addEventListener\('loadedmetadata', apply\)/);
});

/* ------------------------------------------------------ walking the grid */

/**
 * Arrow keys move through the grid as it is currently ordered — and the same
 * change fixes Escape, which had never worked on the common path: the only
 * keydown listener was on the panel wrapper, and right-clicking a tile (the
 * usual way in) focuses nothing, so the event never arrived.
 */

const list = ['a', 'b', 'c', 'd'].map((id) => ({ id }));

test('the arrows step through the order on screen', () => {
  assert.equal(neighbourOf(list, 'b', 1).id, 'c');
  assert.equal(neighbourOf(list, 'b', -1).id, 'a');
});

test('the ends stop rather than wrap', () => {
  // Arriving back at the first photo after the last one reads as a glitch
  // rather than as an end.
  assert.equal(neighbourOf(list, 'd', 1), null);
  assert.equal(neighbourOf(list, 'a', -1), null);
});

test('a photo no longer in the list goes nowhere', () => {
  // Binning one rebuilds the list underneath the viewer. A stale index would
  // address whatever has moved into its place.
  assert.equal(neighbourOf(list, 'gone', 1), null);
  assert.equal(neighbourOf([], 'a', 1), null);
});

test('stepping walks the flat list the grid is built from', () => {
  // Not the catalogue: the order and the criteria have already decided what is
  // worth looking at, and blocks are flattened in the order they appear.
  const body = SOURCE.slice(SOURCE.indexOf('  stepViewer('), SOURCE.indexOf('  closeViewer() {'));
  assert.match(body, /this\.visibleItems\(\)/);
  assert.equal(/this\.state\.items/.test(body), false);
});

test('Escape closes the photo, from the photo', () => {
  const body = SOURCE.slice(SOURCE.indexOf('  onViewerKey('), SOURCE.indexOf('  stepViewer('));
  assert.match(body, /ev\.key === 'Escape'/);
  assert.match(body, /this\.closeViewer\(\)/);
});

test('the viewer can hear its own keys', () => {
  // The bug behind all of this: focus was never moved, so nothing reached the
  // listener on the panel wrapper.
  assert.match(SOURCE, /class: 'viewer', hidden: true, tabIndex: -1/);
  assert.match(SOURCE, /this\.viewer\.focus\(\{ preventScroll: true \}\)/);
  assert.match(SOURCE, /this\.viewer\.addEventListener\('keydown'/);
});

test('a focused video keeps its own arrow keys', () => {
  // They seek, which is the right answer for something deliberately clicked
  // into. Stepping away from a player nobody asked to leave would be worse.
  const body = SOURCE.slice(SOURCE.indexOf('  onViewerKey('), SOURCE.indexOf('  stepViewer('));
  assert.match(body, /ev\.target instanceof HTMLMediaElement/);
});

test('the way through is shown, not only bound', () => {
  // Arrow keys announce themselves to nobody.
  const body = SOURCE.slice(SOURCE.indexOf('  openViewer(item) {'), SOURCE.indexOf('  bindViewerZoom('));
  assert.match(body, /class: 'step'/);
  assert.match(body, /Previous photo \(←\)/);
  assert.match(body, /disabled: !neighbourOf\(shown, item\.id, delta\)/,
    'and a step with nowhere to go says so');
  assert.match(body, /\$\{nf\(at \+ 1\)\} \/ \$\{nf\(shown\.length\)\}/, 'with a position');
});
