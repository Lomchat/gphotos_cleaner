import test from 'node:test';
import assert from 'node:assert/strict';

import {
  parseDateFromText, parseDurationFromText, isVideoLabel,
  dayKey, monthKey, yearKey, formatDate
} from '../src/common/dates.js';

function ymd(ts) {
  const d = new Date(ts);
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

test('reads French Google Photos labels', () => {
  const r = parseDateFromText('Photo prise le 5 janv. 2023, 15:04:05');
  assert.deepEqual(ymd(r.ts), [2023, 1, 5]);
  assert.equal(r.precision, 'day');
  assert.equal(new Date(r.ts).getHours(), 15);
  assert.equal(new Date(r.ts).getMinutes(), 4);
});

test('reads full French month names', () => {
  assert.deepEqual(ymd(parseDateFromText('12 décembre 2019').ts), [2019, 12, 12]);
  assert.deepEqual(ymd(parseDateFromText('1er août 2021').ts), [2021, 8, 1]);
  assert.deepEqual(ymd(parseDateFromText('3 février 2020').ts), [2020, 2, 3]);
});

test('reads English labels, including AM/PM times', () => {
  const r = parseDateFromText('Photo taken on Jan 5, 2023, 3:04:05 PM');
  assert.deepEqual(ymd(r.ts), [2023, 1, 5]);
  assert.equal(new Date(r.ts).getHours(), 15);

  const am = parseDateFromText('March 9, 2018, 12:30:00 AM');
  assert.deepEqual(ymd(am.ts), [2018, 3, 9]);
  assert.equal(new Date(am.ts).getHours(), 0, 'midnight reads as 12:00 AM');
});

test('reads numeric and ISO formats', () => {
  assert.deepEqual(ymd(parseDateFromText('2023-01-05').ts), [2023, 1, 5]);
  assert.deepEqual(ymd(parseDateFromText('05/01/2023').ts), [2023, 1, 5], 'day-first by default');
  assert.deepEqual(ymd(parseDateFromText('20230105').ts), [2023, 1, 5]);
});

test('disambiguates day and month where possible', () => {
  // 25 cannot be a month, so a month-first reading is impossible.
  assert.deepEqual(ymd(parseDateFromText('12/25/2022').ts), [2022, 12, 25]);
});

test('falls back to month or year precision', () => {
  const m = parseDateFromText('janvier 2023');
  assert.equal(m.precision, 'month');
  assert.deepEqual(ymd(m.ts), [2023, 1, 1]);

  const y = parseDateFromText('Souvenirs de 2016');
  assert.equal(y.precision, 'year');
  assert.deepEqual(ymd(y.ts), [2016, 1, 1]);
});

test('does not mistake a video duration for a clock time', () => {
  const r = parseDateFromText('Vidéo - Durée : 0:32 - prise le 5 janv. 2023');
  assert.deepEqual(ymd(r.ts), [2023, 1, 5]);
  assert.equal(new Date(r.ts).getHours(), 0, 'no time may be taken from the duration');
});

test('returns null when no date is readable', () => {
  assert.equal(parseDateFromText(''), null);
  assert.equal(parseDateFromText(null), null);
  assert.equal(parseDateFromText('Sélectionner la photo'), null);
});

test('extracts video durations', () => {
  assert.equal(parseDurationFromText('Vidéo - 0:32'), 32);
  assert.equal(parseDurationFromText('Video · 1:04:20'), 3860);
  assert.equal(parseDurationFromText('2:05'), 125, 'a purely numeric label is a duration badge');
  assert.equal(parseDurationFromText('Photo prise le 5 janv. 2023, 15:04:05'), null,
    'a clock time in a photo label must not read as a duration');
});

test('recognises video labels', () => {
  assert.ok(isVideoLabel('Vidéo prise le 5 janvier'));
  assert.ok(isVideoLabel('Video taken on Jan 5'));
  assert.ok(!isVideoLabel('Photo prise le 5 janvier'));
});

test('produces sortable aggregation keys', () => {
  const ts = new Date(2023, 0, 5, 12).getTime();
  assert.equal(dayKey(ts), '2023-01-05');
  assert.equal(monthKey(ts), '2023-01');
  assert.equal(yearKey(ts), '2023');
  // Lexicographic order must match chronological order.
  const keys = [new Date(2023, 8, 1), new Date(2023, 10, 1), new Date(2024, 0, 1)]
    .map((d) => monthKey(d.getTime()));
  assert.deepEqual([...keys].sort(), keys);
});

test('formats dates according to precision', () => {
  const ts = new Date(2023, 0, 5, 12).getTime();
  assert.match(formatDate(ts, 'day'), /2023/);
  assert.equal(formatDate(ts, 'year'), '2023');
  assert.match(formatDate(ts, 'month'), /January 2023/);
  assert.equal(formatDate(null), 'Unknown date');
});
