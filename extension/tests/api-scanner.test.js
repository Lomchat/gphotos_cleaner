/**
 * Where a run starts, and what it stores.
 *
 * Both are silent when wrong. A resume that restarts in the wrong place skips
 * part of the library while the user believes everything was covered — the same
 * failure the old scroll cursor had, in a new form. And the row mapping is the
 * seam between Google's field names and every filter, sort and statistic in the
 * extension: rename one here and a criterion simply stops matching.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { planStart, toRow, accountFromPath } from '../src/content/api-scanner.js';
import { parseItem } from '../src/api/parse.js';

const opts = (o = {}) => ({ resume: true, olderThanTs: null, ...o });
const cursor = (c = {}) => ({
  olderThanTs: null, lastTimestamp: 1700000000000, pageId: 'CURSOR',
  reachedEnd: false, known: 500, ...c
});

/* ------------------------------------------------------------- where to start */

test('with no cursor, start at the newest photo', () => {
  const r = planStart(null, opts());
  assert.equal(r.beforeTimestamp, null);
  assert.equal(r.pageId, null);
  assert.equal(r.reason, 'first-run');
});

test('a date window becomes the starting point, not a filter to grind through', () => {
  // This is the whole reason the API is worth using: "only photos before 2020"
  // is a parameter, where the old scanner had to scroll past everything newer.
  const r = planStart(null, opts({ olderThanTs: 1577836800000 }));
  assert.equal(r.beforeTimestamp, 1577836800000);
});

test('resume disabled always starts at the top', () => {
  const r = planStart(cursor(), opts({ resume: false }));
  assert.equal(r.beforeTimestamp, null);
  assert.equal(r.reason, 'no-resume');
});

test('a normal resume continues from the recorded date', () => {
  const r = planStart(cursor(), opts());
  assert.equal(r.beforeTimestamp, 1700000000000);
  assert.equal(r.pageId, 'CURSOR');
  assert.equal(r.reason, 'resume');
});

test('a cursor from a different window is not continued', () => {
  // It answers a different question. Continuing it would list the wrong slice
  // of the library and report it as progress on this one.
  const r = planStart(cursor({ olderThanTs: 111 }), opts({ olderThanTs: 222 }));
  assert.equal(r.beforeTimestamp, 222);
  assert.equal(r.pageId, null);
  assert.equal(r.reason, 'window-changed');
});

test('a window switched off is also a change', () => {
  const r = planStart(cursor({ olderThanTs: 111 }), opts({ olderThanTs: null }));
  assert.equal(r.reason, 'window-changed');
});

test('a library already walked restarts at the top, where new photos arrive', () => {
  const r = planStart(cursor({ reachedEnd: true }), opts());
  assert.equal(r.beforeTimestamp, null);
  assert.equal(r.pageId, null);
  assert.equal(r.reason, 'completed');
});

test('a cursor with no position is treated as no cursor', () => {
  const r = planStart(cursor({ lastTimestamp: null }), opts());
  assert.equal(r.reason, 'no-position');
  assert.equal(r.pageId, null);
});

test('the page id is never carried without the date that anchors it', () => {
  // A page id is a within-session cursor and may expire. Every plan that drops
  // the date must drop the id too, or a stale id would silently resume from
  // wherever Google decides.
  for (const c of [cursor({ reachedEnd: true }), cursor({ lastTimestamp: null }), null]) {
    const r = planStart(c, opts());
    if (r.beforeTimestamp == null) assert.equal(r.pageId, null);
  }
});

/* ------------------------------------------------------------ what it stores */

const raw = (over = {}) => [
  over.key || 'KEY',
  ['https://lh3.googleusercontent.com/abc', 4032, 3024],
  over.ts === undefined ? 1700000000000 : over.ts,
  'DEDUP',
  0,
  1700000100000,
  null,
  [[1]],
  null, null, null, null, null,
  over.archived || false,
  over.options || {}
];

test('a listed item becomes a catalogue row the analysis can use', () => {
  const row = toRow(parseItem(raw()), { thumbSize: 176, order: 7, now: 1234 });
  assert.equal(row.id, 'KEY');
  assert.equal(row.url, 'https://lh3.googleusercontent.com/abc=w176-h176');
  assert.equal(row.urlRaw, 'https://lh3.googleusercontent.com/abc');
  assert.equal(row.ts, 1700000000000);
  assert.equal(row.order, 7);
  assert.equal(row.discoveredAt, 1234);
});

test('the dedup key is carried into the row, or nothing can be deleted', () => {
  assert.equal(toRow(parseItem(raw())).dedupKey, 'DEDUP');
});

test('a date from the API is exact, and says where it came from', () => {
  // The old listing inferred dates from tile labels and neighbours. Recording
  // the source keeps the two distinguishable in a catalogue holding both.
  const row = toRow(parseItem(raw()));
  assert.equal(row.precision, 'exact');
  assert.equal(row.dateSource, 'api');
});

test('a video is flagged the way the filters expect', () => {
  const row = toRow(parseItem(raw({ options: { 76647426: [65000] } })));
  assert.equal(row.isVideo, 1, 'numeric, like the rest of the catalogue');
  assert.equal(row.duration, 65);
});

test('booleans are stored as 0/1, matching what was there before', () => {
  const row = toRow(parseItem(raw({ archived: true })));
  assert.equal(row.isArchived, 1);
  assert.equal(row.isFavourite, 0);
  assert.equal(row.isOwned, 1);
});

test('sizes are left empty for the metadata pass to fill', () => {
  const row = toRow(parseItem(raw()));
  assert.equal(row.sizeBytes, null);
  assert.equal(row.fileName, null);
  assert.equal(row.label, null);
});

/* ------------------------------------------------------------------ account */

test('the account number is read off the session path', () => {
  assert.equal(accountFromPath('/u/1/'), 1);
  assert.equal(accountFromPath('/u/0/'), 0);
  assert.equal(accountFromPath('/'), null, 'the default account needs nothing');
  assert.equal(accountFromPath(undefined), null);
  assert.equal(accountFromPath('/album/x/'), null);
});
