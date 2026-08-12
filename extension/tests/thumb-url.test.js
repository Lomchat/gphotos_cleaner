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
import { PEOPLE_RENDER_PX } from '../src/analysis/people-runner.js';

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

test('the People pass rendition produces a valid Google URL', () => {
  // The People pass re-reads each photo at a larger size. A malformed rewrite
  // means it fetches nothing and the whole feature silently finds no faces.
  const catalogued = withThumbSize('https://lh3.googleusercontent.com/abc=w176-h176-no', 176);
  const forPeople = withThumbSize(catalogued, PEOPLE_RENDER_PX);
  assert.match(forPeople, new RegExp(`=w${PEOPLE_RENDER_PX}-h${PEOPLE_RENDER_PX}`));
  assert.equal(isGoogleImageUrl(forPeople), true);
});

test('resizing twice does not stack size suffixes', () => {
  const once = withThumbSize('https://lh3.googleusercontent.com/abc=w176-h176-no', 512);
  const twice = withThumbSize(once, 512);
  assert.equal(twice, once);
  assert.equal((twice.match(/=w/g) || []).length, 1);
});

/* ------------------------------------------------------- fetching them */

/**
 * Thumbnail URLs from the API need the session cookie, and no size suffix
 * changes that — measured on a live library across `=w176-h176`, `-no`,
 * `-k-no`, `=s176` and the bare URL: 403 without credentials, 200 with them.
 *
 * There has always been a retry for that case. What matters now is that it is
 * remembered: URLs from the API are *all* of that kind, so an unconditional
 * retry means two requests per photo, and fetching is the dominant cost of a
 * run. These are source-level checks because both files run inside a worker.
 */
for (const file of ['../src/analysis/worker.js', '../src/analysis/people-runner.js']) {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  const name = file.split('/').pop();

  test(`${name} still falls back to credentials on a refusal`, () => {
    assert.match(source, /credentials: 'omit'/);
    assert.match(source, /credentials: 'include'/);
  });

  test(`${name} does not pay for that fallback twice per photo`, () => {
    assert.match(source, /needsCookie/,
      'the refusing host must be remembered, or every thumbnail costs two requests');
    const guard = source.indexOf('needsCookie.has(');
    const add = source.indexOf('needsCookie.add(');
    assert.ok(guard !== -1 && add !== -1 && guard < add,
      'the check must come before the first fetch, not after it');
  });

  test(`${name} learns the host rather than assuming it`, () => {
    // Hard-coding "the API hosts need cookies" would not correct itself if
    // Google went back to token-bearing URLs.
    assert.equal(/needsCookie = new Set\(\[/.test(source), false,
      'the set must start empty and be filled by what actually refused');
  });
}
