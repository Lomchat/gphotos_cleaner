/**
 * Recognising Google image URLs and rewriting their size.
 *
 * Too narrow a host filter is the extension's most treacherous failure: items
 * are listed, no error is raised, the analysis queue simply stays empty. These
 * tests bound recognition in both directions — wide enough to follow Google's
 * migrations, narrow enough not to fetch images from anywhere else.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { isGoogleImageUrl, withThumbSize } from '../src/content/dom-adapter.js';
import { DEFAULT_BACKEND } from '../src/common/backend.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/* ---------------------------------------------------------- recognition */

const HOTES_VALIDES = [
  'https://lh3.googleusercontent.com/abc=w200-h200-no',
  'https://ci3.googleusercontent.com/xyz',
  'https://play-lh.googleusercontent.com/xyz',
  'https://lh3.google.com/u/0/abc=w200-h200',      // host observed in 2026
  'https://lh5.google.com/abc',
  'https://photos.fife.usercontent.google.com/pw/abc=w200',
  'https://yt3.ggpht.com/abc'
];

test('recognises Google image hosts, including recent ones', () => {
  for (const url of HOTES_VALIDES) {
    assert.equal(isGoogleImageUrl(url), true, url);
  }
});

test('rejects anything not served as an image by Google', () => {
  const invalides = [
    'https://photos.google.com/photo/AF1Qip',   // the page, not an image
    'https://example.com/a.jpg',
    'https://googleusercontent.com.evil.tld/a', // spoofed suffix
    'https://notgoogleusercontent.com/a',
    'https://lh3.google.com.evil.tld/a',
    'https://lhx.google.com/a',                 // not an lh<n> host
    'data:image/png;base64,AAAA',
    'blob:https://photos.google.com/1234',
    '',
    null,
    undefined,
    42
  ];
  for (const url of invalides) {
    assert.equal(isGoogleImageUrl(url), false, String(url));
  }
});

test('the filter tests the host, not a substring of the URL', () => {
  // The classic `indexOf` trap: the domain appears in the path or query of a
  // URL hosted elsewhere.
  assert.equal(isGoogleImageUrl('https://evil.tld/googleusercontent.com/a.jpg'), false);
  assert.equal(isGoogleImageUrl('https://evil.tld/?u=lh3.googleusercontent.com'), false);
});

/* --------------------------------------------------------- size rewrite */

test('replaces an existing size suffix', () => {
  assert.equal(
    withThumbSize('https://lh3.googleusercontent.com/abc=w200-h200-no', 176),
    'https://lh3.googleusercontent.com/abc=w176-h176'
  );
  assert.equal(
    withThumbSize('https://lh3.googleusercontent.com/abc=s512-c', 176),
    'https://lh3.googleusercontent.com/abc=w176-h176'
  );
});

test('adds a suffix when there is none', () => {
  assert.equal(
    withThumbSize('https://lh3.google.com/u/0/abc', 176),
    'https://lh3.google.com/u/0/abc=w176-h176'
  );
});

test('preserves the query string', () => {
  assert.equal(
    withThumbSize('https://lh3.googleusercontent.com/abc=w200-h200?authuser=0', 176),
    'https://lh3.googleusercontent.com/abc=w176-h176?authuser=0'
  );
});

test('does not mistake a path "=" for a size suffix', () => {
  // A base64-encoded id often ends with "=".
  const url = 'https://photos.fife.usercontent.google.com/pw/AP1Gcz9jM=';
  const out = withThumbSize(url, 176);
  assert.ok(out.endsWith('=w176-h176'), out);
  assert.ok(out.startsWith('https://photos.fife.usercontent.google.com/pw/'), out);
});

test('a rewritten URL is still recognised as a Google image', () => {
  for (const url of HOTES_VALIDES) {
    assert.equal(isGoogleImageUrl(withThumbSize(url, 176)), true, url);
  }
});

test('empty input produces no malformed URL', () => {
  assert.equal(withThumbSize(null, 176), null);
  assert.equal(withThumbSize('', 176), null);
});

/* ---------------------------------------------- manifest consistency */

test('every recognised host is covered by a manifest permission', () => {
  // Without host permission the worker's fetch fails CORS: extraction could
  // succeed and analysis would still fail on every image.
  const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
  const motifs = manifest.host_permissions.map((p) => {
    const host = p.replace(/^https:\/\//, '').replace(/\/\*$/, '');
    return new RegExp(`^${host.replace(/\./g, '\\.').replace(/^\*\\\./, '(?:[^/]+\\.)?')}$`, 'i');
  });

  for (const url of HOTES_VALIDES) {
    const hostname = new URL(url).hostname;
    assert.ok(
      motifs.some((re) => re.test(hostname)),
      `${hostname} is recognised by extraction but missing from host_permissions`
    );
  }
});

test('the backend rendition size produces a valid Google URL', () => {
  // The People tab rewrites each catalogue URL to a larger size before sending
  // it. A malformed rewrite means the backend fetches nothing and the whole
  // feature silently finds no faces.
  const catalogued = withThumbSize('https://lh3.googleusercontent.com/abc=w176-h176-no', 176);
  const forBackend = withThumbSize(catalogued, DEFAULT_BACKEND.thumbSize);
  assert.match(forBackend, /=w512-h512/);
  assert.equal(isGoogleImageUrl(forBackend), true);
});

test('resizing twice does not stack size suffixes', () => {
  const once = withThumbSize('https://lh3.googleusercontent.com/abc=w176-h176-no', 512);
  const twice = withThumbSize(once, 512);
  assert.equal(twice, once);
  assert.equal((twice.match(/=w/g) || []).length, 1);
});
