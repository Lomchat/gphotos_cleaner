/**
 * Reading Google's positional arrays.
 *
 * Every field here is an index into an unnamed array. Get one wrong and there
 * is no error: a date becomes null, a video looks like a photo, a size reads
 * zero — and the filters built on top quietly stop matching. So each index is
 * pinned by a test, and the two directions that matter most are covered: a
 * complete item, and a truncated one from some future release.
 *
 * The dedup key gets its own attention. It is what the trash call takes, so
 * reading it from the wrong position would mean deleting the wrong thing, or
 * nothing at all.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseItem, parseTimelinePage, parseMediaInfo, parseMediaInfoPage, thumbUrl
} from '../src/api/parse.js';

/** A library item in the shape Google actually sends. */
function rawItem(overrides = {}) {
  const opts = {
    163238866: [true],           // favourite
    76647426: [12500],           // duration, milliseconds
    396644657: ['a description'],
    ...(overrides.options || {})
  };
  const raw = [
    'MEDIA_KEY',                             // 0
    ['https://lh3.googleusercontent.com/x', 4032, 3024], // 1 thumb, w, h
    1700000000000,                           // 2 taken
    'DEDUP_KEY',                             // 3
    -18000000,                               // 4 timezone offset
    1700000100000,                           // 5 uploaded
    null,                                    // 6
    [[1, 2], [3]],                           // 7 ownership flags
    null, null, null, null, null,            // 8..12
    false,                                   // 13 archived
    opts
  ];
  return Object.assign(raw, overrides.raw || {});
}

/* ------------------------------------------------------------------ items */

test('a complete item yields every field the catalogue stores', () => {
  const item = parseItem(rawItem());
  assert.equal(item.mediaKey, 'MEDIA_KEY');
  assert.equal(item.thumb, 'https://lh3.googleusercontent.com/x');
  assert.equal(item.width, 4032);
  assert.equal(item.height, 3024);
  assert.equal(item.timestamp, 1700000000000);
  assert.equal(item.creationTimestamp, 1700000100000);
  assert.equal(item.timezoneOffset, -18000000);
  assert.equal(item.dedupKey, 'DEDUP_KEY');
  assert.equal(item.isFavourite, true);
  assert.equal(item.description, 'a description');
});

test('a duration means a video, and is stored in seconds', () => {
  // Milliseconds on the wire, seconds in the filters. Mixing them up makes a
  // twelve-second clip look like a three-hour one.
  const item = parseItem(rawItem());
  assert.equal(item.isVideo, true);
  assert.equal(item.duration, 13);
});

test('no duration means a photo, and no invented length', () => {
  const item = parseItem(rawItem({ options: { 76647426: undefined } }));
  assert.equal(item.isVideo, false);
  assert.equal(item.duration, null);
});

test('an item shared by somebody else is marked as not owned', () => {
  // Deleting one frees nothing and Google would refuse anyway, so the deletion
  // planner needs to be able to leave it alone.
  const raw = rawItem();
  raw[7] = [[1, 27]];
  assert.equal(parseItem(raw).isOwned, false);
  assert.equal(parseItem(rawItem()).isOwned, true);
});

test('a truncated item degrades to missing values, never to an exception', () => {
  // One short array in a page of five hundred must not lose the other 499.
  const item = parseItem(['ONLY_A_KEY']);
  assert.equal(item.mediaKey, 'ONLY_A_KEY');
  assert.equal(item.thumb, null);
  assert.equal(item.timestamp, null);
  assert.equal(item.dedupKey, null);
  assert.equal(item.isVideo, false);
});

test('anything that is not an item is dropped, not half-read', () => {
  assert.equal(parseItem(null), null);
  assert.equal(parseItem([]), null);
  assert.equal(parseItem([null, 'x']), null);
  assert.equal(parseItem('nonsense'), null);
});

test('a numeric string timestamp is still a number afterwards', () => {
  const raw = rawItem();
  raw[2] = '1700000000000';
  assert.equal(parseItem(raw).timestamp, 1700000000000);
});

/* ------------------------------------------------------------------ pages */

test('a page carries its items and the cursor for the next one', () => {
  const page = parseTimelinePage([[rawItem(), rawItem()], 'NEXT_PAGE', '1699999999999']);
  assert.equal(page.items.length, 2);
  assert.equal(page.nextPageId, 'NEXT_PAGE');
  assert.equal(page.lastTimestamp, 1699999999999);
});

test('the last page has no cursor', () => {
  const page = parseTimelinePage([[rawItem()], null, '1']);
  assert.equal(page.nextPageId, null);
});

test('unreadable entries are dropped without losing the page', () => {
  const page = parseTimelinePage([[rawItem(), null, ['x'], rawItem()], null, '1']);
  assert.equal(page.items.length, 3, 'only the null goes');
});

test('an empty page is not an error', () => {
  assert.deepEqual(parseTimelinePage([[], null, null]).items, []);
  assert.deepEqual(parseTimelinePage(null).items, []);
});

/* ------------------------------------------------------------- media info */

test('the metadata response gives a name and a size', () => {
  const raw = ['MEDIA_KEY', [null, null, null, 'IMG_0042.HEIC', null, null,
    1700000000000, null, null, 4194304, [1, 3145728, 2]]];
  const info = parseMediaInfo(raw);
  assert.equal(info.mediaKey, 'MEDIA_KEY');
  assert.equal(info.fileName, 'IMG_0042.HEIC');
  assert.equal(info.size, 4194304);
  assert.equal(info.spaceTaken, 3145728, 'what it costs against the quota');
  assert.equal(info.takesUpSpace, true);
  assert.equal(info.isOriginalQuality, true);
});

test('quota flags stay null when Google did not say', () => {
  // null is "unknown", false is "does not count". Collapsing them would tell
  // the user a photo is free when nobody knows.
  const info = parseMediaInfo(['KEY', [null, null, null, 'a.jpg', null, null, null, null, null, 10, []]]);
  assert.equal(info.takesUpSpace, null);
  assert.equal(info.isOriginalQuality, null);
});

test('the metadata list is two levels deep, not one', () => {
  // payload[0][1], and nothing tells you so: the wrong depth returns an empty
  // array, and the only symptom is a library where nothing has a size.
  const row = ['KEY', [null, null, null, 'a.jpg', null, null, null, null, null, 99, [1, 99, 2]]];
  const parsed = parseMediaInfoPage([[null, [row, row]]]);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].size, 99);
});

test('a metadata response with nothing in it yields nothing', () => {
  assert.deepEqual(parseMediaInfoPage(null), []);
  assert.deepEqual(parseMediaInfoPage([[null, null]]), []);
});

/* ------------------------------------------------------------ thumbnails */

test('a bare base URL is given the size asked for', () => {
  assert.equal(
    thumbUrl('https://lh3.googleusercontent.com/abc', 176),
    'https://lh3.googleusercontent.com/abc=w176-h176'
  );
});

test('the account travels with the URL when there is one', () => {
  // A thumbnail from a secondary account can be refused without it, and the
  // failure looks like an ordinary fetch error.
  assert.equal(
    thumbUrl('https://lh3.googleusercontent.com/abc', 512, { authUser: 1 }),
    'https://lh3.googleusercontent.com/abc=w512-h512?authuser=1'
  );
  assert.equal(
    thumbUrl('https://lh3.googleusercontent.com/abc', 512, { authUser: 0 }),
    'https://lh3.googleusercontent.com/abc=w512-h512?authuser=0',
    'account zero is a real account, not "none"'
  );
});

test('asking twice does not stack size suffixes', () => {
  const once = thumbUrl('https://lh3.googleusercontent.com/abc', 176);
  assert.equal(thumbUrl(once, 512), 'https://lh3.googleusercontent.com/abc=w512-h512');
});

test('no base URL produces no URL at all', () => {
  assert.equal(thumbUrl(null, 176), null);
  assert.equal(thumbUrl('', 176), null);
});
