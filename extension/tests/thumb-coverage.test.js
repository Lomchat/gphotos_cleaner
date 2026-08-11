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

/* -------------------------------------------------- only what is on screen */

/**
 * Google loads images for the tiles a user can see and leaves the rest of its
 * rendered range blank. Counting every tile in the document therefore made the
 * 90% target unreachable: the wait expired at every stop and the screenful was
 * harvested with no images at all. It got worse the more tiles were rendered —
 * which is exactly what zooming the page out does.
 */
function installViewportDom(tiles, { viewTop = 0, viewHeight = 800 } = {}) {
  const node = (t) => ({
    getAttribute: (name) => (name === 'href' ? t.href : null),
    getBoundingClientRect: () => ({ top: t.top, bottom: t.top + 100, height: 100 }),
    querySelector: (sel) => {
      if (sel === 'img') {
        return t.src ? { currentSrc: '', getAttribute: (n) => (n === 'src' ? t.src : null) } : null;
      }
      return null;
    }
  });
  const nodes = tiles.map(node);
  globalThis.document = { querySelectorAll: () => nodes };
  return { top: viewTop, bottom: viewTop + viewHeight, height: viewHeight };
}

test('tiles far below the fold do not count against coverage', () => {
  // 4 on screen with images, 40 rendered far below without: the old count gave
  // 9% and waited forever; the honest answer is 100%.
  const onScreen = [0, 100, 200, 300].map((top, i) => ({ href: `./photo/A${i}`, top, src: 'x' }));
  const farBelow = Array.from({ length: 40 }, (_, i) => ({ href: `./photo/B${i}`, top: 4000 + i * 100 }));
  const viewport = installViewportDom([...onScreen, ...farBelow]);
  const cov = thumbCoverage({ viewport });
  assert.equal(cov.total, 4, 'only the visible tiles are counted');
  assert.equal(cov.ratio, 1);
});

test('a tile just past the edge still counts, within the margin', () => {
  // The margin exists because Google starts loading slightly ahead, and a hard
  // cut at the fold would flip the ratio around every scroll.
  const viewport = installViewportDom([{ href: './photo/A', top: 850 }], { viewHeight: 800 });
  assert.equal(thumbCoverage({ margin: 0.25, viewport }).total, 1);
  assert.equal(thumbCoverage({ margin: 0, viewport }).total, 0);
});

test('missing images on screen still drag the ratio down', () => {
  const tiles = [
    { href: './photo/A', top: 0, src: 'x' },
    { href: './photo/B', top: 100 },
    { href: './photo/C', top: 200 },
    { href: './photo/D', top: 300 }
  ];
  const viewport = installViewportDom(tiles);
  assert.equal(thumbCoverage({ viewport }).ratio, 0.25);
});

test('with nothing on screen the scan is not blocked', () => {
  const viewport = installViewportDom([{ href: './photo/A', top: 9000 }]);
  assert.equal(thumbCoverage({ viewport }).ratio, 1, 'no visible tile means nothing to wait for');
});
