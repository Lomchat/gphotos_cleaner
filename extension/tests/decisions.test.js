/**
 * Remembering what has already been decided, and overlapping the two passes.
 *
 * Two changes that share a theme: not doing the same work twice.
 *
 * Without decisions the tool is a one-off. Look through two thousand photos,
 * keep eighteen hundred, and the next visit offers the same eighteen hundred
 * again — so the second run is worse than the first, because the answers are
 * all still there and none of them is new.
 *
 * And the face pass used to start only once the analysis had finished, so a
 * run cost the sum of both. The analysis is bound by the link; the face pass
 * mostly by the detection and recognition pools. Each spent its time waiting
 * on something the other was not using.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Panel } from '../src/ui/panel.js';

const SOURCE = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
const DB = readFileSync(new URL('../src/content/db.js', import.meta.url), 'utf8');

/** The body of one method, from its declaration to the start of the next. */
function methodBody(name) {
  const start = SOURCE.search(new RegExp(`\\n {2}(?:async )?${name}\\(`));
  assert.notEqual(start, -1, `${name} not found`);
  const rest = SOURCE.slice(start + 1);
  const end = rest.search(/\n {2}(?:\/\*\*|(?:async )?[a-zA-Z_$][\w$]*\()/);
  return end === -1 ? rest : rest.slice(0, end);
}

/* -------------------------------------------------------------- decisions */

test('keeping marks what was shown and spared, never the whole library', () => {
  // Only what was on screen has been looked at. Marking anything else would
  // record a judgement nobody made.
  const body = methodBody('keepRest');
  assert.match(body, /this\.state\.filtered/);
  assert.equal(/this\.state\.items/.test(body), false,
    'the catalogue is not the same thing as what is on screen');
  assert.match(body, /!this\.state\.selection\.has/, 'and the ticked ones are not spared');
});

test('a decision survives the run that made it', () => {
  // On the item, in IndexedDB, beside the analysis rather than in it: it is a
  // fact about the user, not a measurement of the photo.
  assert.match(DB, /export async function markKept/);
  assert.match(DB, /kept: 1, keptAt/);
  assert.match(DB, /export async function clearKept/);
});

test('unkeeping removes the mark rather than setting it false', () => {
  // A row carrying `kept: false` reads as decided-and-rejected to anything
  // that only checks for the field.
  const start = DB.indexOf('export async function markKept');
  const body = DB.slice(start, DB.indexOf('/** Forget every', start));
  assert.match(body, /const \{ kept: _k, keptAt: _a, \.\.\.rest \} = get\.result/);
});

test('hidden decisions narrow what the filters see, not what they mean', () => {
  // The number beside a criterion has to equal what ticking it selects. A
  // predicate would have to be added to every criterion and to the counter,
  // and the two would drift; one pool cannot.
  const body = methodBody('recompute');
  assert.match(body, /const pool = this\.state\.settings\.hideKept/);
  assert.match(body, /countPerCriterion\(pool,/);
  assert.match(body, /applyFilters\(pool,/);
});

test('the duplicate cache knows the pool changed under it', () => {
  // Its key is what decides whether the grouping is recomputed. Without the
  // pool in it, hiding decisions would leave clusters built from photos that
  // are no longer shown.
  const body = methodBody('duplicateSelection');
  assert.match(body, /hideKept/);
});

test('hidden photos are always visible as a number', () => {
  // A library that looks empty with no explanation is the worst outcome here.
  const body = methodBody('buildKeptNote');
  assert.match(body, /keptCount/);
  assert.match(body, /Show|Hide/, 'and can be put back');
  assert.match(body, /forgetDecisions\(\)/, 'and forgotten entirely');
});

test('decisions are on by default, because that is the point', () => {
  assert.match(SOURCE, /hideKept: true/);
});

test('the methods the decision buttons call all exist', () => {
  for (const name of ['keepRest', 'forgetDecisions', 'buildKeptNote']) {
    assert.equal(typeof Panel.prototype[name], 'function', `${name} is missing`);
  }
});

/* --------------------------------------------------------- the two passes */

test('the face pass runs alongside the analysis, not after it', () => {
  const body = methodBody('doFullRun');
  const people = body.indexOf('const peopleTask');
  const analyse = body.indexOf('const analyzeTask');
  assert.ok(people !== -1 && analyse !== -1);
  assert.ok(people < analyse,
    'started first, so the model download overlaps with the first thumbnails');
  assert.match(body, /moreComing: \(\) => analysisRunning/);
});

test('the streaming pass asks the database, not the panel state', () => {
  // `this.state.items` is a snapshot taken before the run; the photos it needs
  // are the ones the analysis is finishing right now.
  const body = methodBody('runPeopleScan');
  assert.match(body, /db\.getPeopleCandidates\(/);
});

test('candidates are found by cursor, not by loading the catalogue', () => {
  // This is asked roughly once a second for as long as a run lasts.
  const start = DB.indexOf('export async function getPeopleCandidates');
  const body = DB.slice(start, DB.indexOf('export async function deleteItems', start));
  assert.match(body, /openCursor/);
  assert.equal(/getAll\(\)/.test(body), false);
  assert.match(body, /out\.length >= limit/, 'and stops at the limit it was given');
});

test('a photo already read is never handed to the pass again', () => {
  // The loop asks repeatedly; without this it would return the same photos
  // every time and never terminate.
  const start = DB.indexOf('export async function getPeopleCandidates');
  const body = DB.slice(start, DB.indexOf('export async function deleteItems', start));
  assert.match(body, /!v\.peopleScanned/);
  assert.match(body, /faceScore/, 'and only photos the analysis thinks hold a face');
});

test('a fixed list still works, for the catch-up button', () => {
  // Reading photos analysed before grouping was switched on is not a
  // streaming problem, and should not be made into one.
  const body = methodBody('runPeopleScan');
  assert.match(body, /const todo = moreComing \? \[\] : pendingPeople/);
  assert.match(body, /\} else if \(todo\.length\) \{\s*\n\s*await runChunk\(todo\);/);
});

test('totals add up across chunks rather than being replaced', () => {
  // Streaming there is no single call whose return value is the answer.
  const body = methodBody('runPeopleScan');
  assert.match(body, /totals\[key\] \+= part\[key\]/);
  assert.match(body, /totals\.errors\.push\(\.\.\.part\.errors\)/);
});

test('progress counts the whole pass, not the chunk in hand', () => {
  // A figure that restarted at zero on every chunk would be worse than none.
  const body = methodBody('runPeopleScan');
  assert.match(body, /const read = done \+ inChunk/);
  assert.match(body, /queued \+= batch\.length/, 'and the total grows as work is found');
});
