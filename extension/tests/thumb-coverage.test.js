/**
 * Detecting thumbnail loading.
 *
 * Google Photos fills the grid in two passes: anchors first, images second.
 * Scrolling in between records items with no thumbnail, which analysis can
 * never process — repairing them means walking the whole library again. So the
 * render signature must reflect the state of the IMAGES, not just the
 * structure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { thumbCoverage, gridSignature } from '../src/content/dom-adapter.js';

const LOADED_SELECTOR = 'a[href*="/photo/"] img[src]';

/**
 * Minimal DOM. `tiles`: [{ href, src, bg }] — a missing `src` means a tile
 * whose image has not arrived yet.
 */
function installFakeDom(tiles) {
  const node = (t) => ({
    getAttribute: (name) => (name === 'href' ? t.href : null),
    querySelector: (sel) => {
      if (sel === 'img') {
        return t.hasImg === false
          ? null
          : { currentSrc: '', getAttribute: (n) => (n === 'src' ? t.src ?? null : null) };
      }
      if (sel === '[data-latest-bg]') return t.bg ? {} : null;
      return null;
    }
  });
  const nodes = tiles.map(node);

  globalThis.document = {
    querySelectorAll: (sel) =>
      sel === LOADED_SELECTOR ? tiles.filter((t) => t.src).map(() => ({})) : nodes
  };
}

function tile(i, extra = {}) {
  return { href: `./photo/ID${i}`, ...extra };
}

test.afterEach(() => {
  delete globalThis.document;
});

/* -------------------------------------------------------------- coverage */

test('full coverage when every image is present', () => {
  installFakeDom([0, 1, 2].map((i) => tile(i, { src: `https://lh3.google.com/${i}` })));
  const c = thumbCoverage();
  assert.equal(c.total, 3);
  assert.equal(c.ready, 3);
  assert.equal(c.ratio, 1);
});

test('zero coverage when no image has arrived', () => {
  installFakeDom([0, 1, 2, 3].map((i) => tile(i)));
  const c = thumbCoverage();
  assert.equal(c.total, 4);
  assert.equal(c.ready, 0);
  assert.equal(c.ratio, 0);
});

test('partial coverage measured exactly', () => {
  installFakeDom([
    tile(0, { src: 'https://lh3.google.com/a' }),
    tile(1),
    tile(2, { src: 'https://lh3.google.com/c' }),
    tile(3)
  ]);
  assert.equal(thumbCoverage().ratio, 0.5);
});

test('a CSS background counts as an available thumbnail', () => {
  // Some Google Photos versions use a background rather than an <img>.
  installFakeDom([tile(0, { hasImg: false, bg: true }), tile(1, { hasImg: false })]);
  const c = thumbCoverage();
  assert.equal(c.ready, 1);
  assert.equal(c.ratio, 0.5);
});

test('an empty grid does not stall the scan', () => {
  // Returning 0 would make the scanner wait to the ceiling every round, when
  // there is simply nothing to load.
  installFakeDom([]);
  const c = thumbCoverage();
  assert.equal(c.total, 0);
  assert.equal(c.ratio, 1, 'no tiles means nothing to wait for');
});

/* ------------------------------------------------------------- signature */

test('the signature changes when a thumbnail arrives', () => {
  // The heart of the fix: without it the grid looks "rendered" as soon as the
  // anchors are placed, and the scanner scrolls too early.
  const tiles = [tile(0), tile(1), tile(2)];
  installFakeDom(tiles);
  const avant = gridSignature();

  tiles[1].src = 'https://lh3.google.com/b';
  installFakeDom(tiles);
  const apres = gridSignature();

  assert.notEqual(avant, apres, 'an arriving image must be perceptible');
});

test('the signature is stable when nothing moves', () => {
  const tiles = [tile(0, { src: 'x' }), tile(1, { src: 'y' })];
  installFakeDom(tiles);
  const a = gridSignature();
  installFakeDom(tiles);
  assert.equal(gridSignature(), a);
});

test('the signature distinguishes two grid positions', () => {
  installFakeDom([tile(0, { src: 'x' }), tile(1, { src: 'y' })]);
  const haut = gridSignature();
  installFakeDom([tile(8, { src: 'x' }), tile(9, { src: 'y' })]);
  assert.notEqual(gridSignature(), haut, 'scrolling must be perceptible');
});

test('an empty grid has its own signature', () => {
  installFakeDom([]);
  assert.equal(gridSignature(), '0');
});
