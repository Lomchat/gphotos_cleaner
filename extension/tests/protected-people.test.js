/**
 * People whose photos must never be offered for deletion.
 *
 * The whole design turns on one awkward fact: **group ids are positional and
 * rebuilt on every regroup.** Person 3 today is somebody else tomorrow. A
 * protection stored by id would, on the next run, shield the wrong person and
 * expose the one it was meant to protect — which is not a degraded feature,
 * it is the exact opposite of the feature.
 *
 * So protections hold vectors, matched by distance. Everything below either
 * asserts that, or guards the two other ways this could quietly fail: matching
 * groups instead of faces, and a reset taking the list with it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  matchProtected, protectedPhotos, makeProtected, protectedLabel,
  chooseIdentity, looksLikeOnePerson
} from '../src/analysis/protected-people.js';
import { normalise } from '../src/analysis/cluster.js';

const SOURCE = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
const PEOPLE_CLIENT = readFileSync(new URL('../src/content/people-client.js', import.meta.url), 'utf8');
const DB = readFileSync(new URL('../src/content/db.js', import.meta.url), 'utf8');

/** A unit vector pointing mostly along one axis, with a little noise. */
function face(axis, wobble = 0, dim = 32) {
  const v = new Float32Array(dim);
  v[axis] = 1;
  if (wobble) v[(axis + 1) % dim] = wobble;
  return normalise(v);
}

const person = (centroid, over = {}) => ({ id: 'pp_1', name: null, centroid, ...over });

/* ------------------------------------------------------------- matching */

test('a face matches the person it belongs to', () => {
  const hit = matchProtected(face(0, 0.1), [person(face(0))], 0.75);
  assert.ok(hit);
  assert.equal(hit.person.id, 'pp_1');
});

test('a different face matches nobody', () => {
  // Orthogonal vectors sit at distance 1, well past any usable threshold.
  assert.equal(matchProtected(face(5), [person(face(0))], 0.75), null);
});

test('the nearest protected person wins, not the first listed', () => {
  // With several protected people the closest is the honest answer, and it is
  // the name the panel shows as the reason a photo is hidden.
  const list = [
    person(face(3), { id: 'far' }),
    person(face(0, 0.05), { id: 'near' })
  ];
  assert.equal(matchProtected(face(0), list, 0.75).person.id, 'near');
});

test('the threshold decides, and it is the caller\'s', () => {
  // The same slider that groups people, deliberately: "is this the same
  // person?" is one question, and two numbers that must agree but can be set
  // apart is a bug waiting to be filed.
  const v = face(0, 0.9);
  const list = [person(face(0))];
  assert.ok(matchProtected(v, list, 0.75));
  assert.equal(matchProtected(v, list, 0.05), null);
});

test('an empty list protects nothing', () => {
  assert.equal(matchProtected(face(0), [], 0.75), null);
  assert.equal(matchProtected(face(0), undefined, 0.75), null);
});

test('a vector that did not survive storage protects nobody', () => {
  // Rather than throwing, or matching arbitrarily. Refusing to guess is right:
  // the alternative is shielding a person nobody chose.
  assert.equal(matchProtected(null, [person(face(0))], 0.75), null);
  assert.equal(matchProtected(face(0), [{ id: 'x', centroid: null }], 0.75), null);
  assert.equal(matchProtected(face(0), [{ id: 'x' }], 0.75), null);
});

test('a centroid stored as a plain array still matches', () => {
  // It goes through chrome.storage, which serialises to JSON: a Float32Array
  // arrives back as {"0": …} with no length, and every distance from it would
  // come out as 1.
  const stored = Array.from(face(0));
  assert.ok(matchProtected(face(0, 0.05), [person(stored)], 0.75));
});

/* --------------------------------------------------------- which photos */

test('a photo holding a protected face is named', () => {
  const faces = [
    { photoId: 'a', vector: face(0, 0.05) },
    { photoId: 'b', vector: face(7) }
  ];
  const out = protectedPhotos(faces, [person(face(0))], 0.75);
  assert.equal(out.get('a'), 'pp_1');
  assert.equal(out.has('b'), false);
});

test('one protected face among strangers is enough', () => {
  // A group photo is protected by whoever in it is protected. Requiring all of
  // them would make the feature useless for the case it exists for.
  const faces = [
    { photoId: 'group', vector: face(9) },
    { photoId: 'group', vector: face(0) }
  ];
  assert.equal(protectedPhotos(faces, [person(face(0))], 0.75).get('group'), 'pp_1');
});

test('nothing is protected when nobody is', () => {
  const faces = [{ photoId: 'a', vector: face(0) }];
  assert.equal(protectedPhotos(faces, [], 0.75).size, 0);
});

/* ------------------------------------------------------------ recording */

test('a protection carries the identity, never an id that will be reused', () => {
  const made = makeProtected({ centroid: face(0), now: 1000 });
  assert.ok(Array.isArray(made.centroid), 'a plain array, for JSON storage');
  assert.equal(made.centroid.length, 32);
  assert.ok(made.id.startsWith('pp_'));
  assert.equal(made.addedAt, 1000);
});

test('two protections made at once do not share an id', () => {
  const a = makeProtected({ centroid: face(0), now: 1000 });
  const b = makeProtected({ centroid: face(1), now: 1000 });
  assert.notEqual(a.id, b.id);
});

test('how the identity was obtained is recorded', () => {
  // "Protected from one face" is a weaker claim than "from a whole group", and
  // the panel should be able to say which.
  assert.equal(makeProtected({ centroid: face(0), from: 'group' }).from, 'group');
  assert.equal(makeProtected({ centroid: face(0) }).from, 'face');
});

test('an unnamed person still has something to call them', () => {
  assert.equal(protectedLabel({ name: null }, 0), 'Protected 1');
  assert.equal(protectedLabel({ name: 'Grandma' }, 3), 'Grandma');
});

/* ----------------------------------------------- faces, never groups */

test('the marking runs over faces, not over groups', () => {
  // A group needs two faces to exist. A protected person appearing exactly
  // once in a photo would form none, and that photo would be offered for
  // deletion — the single failure this feature exists to prevent.
  const start = PEOPLE_CLIENT.indexOf('export async function regroup');
  const body = PEOPLE_CLIENT.slice(start, PEOPLE_CLIENT.indexOf('export function forDisplay'));
  assert.match(body, /protectedPhotos\(faces, protect, eps\)/);
  assert.equal(/protectedPhotos\(groups/.test(body), false);
});

test('the marking rides on work already being done', () => {
  // regroup already holds every face vector. Loading them again elsewhere
  // would be forty megabytes for an answer that is already in hand.
  const start = PEOPLE_CLIENT.indexOf('export async function regroup');
  const body = PEOPLE_CLIENT.slice(start, PEOPLE_CLIENT.indexOf('export function forDisplay'));
  assert.match(body, /db\.savePeople\(assignments, guarded\)/);
});

test('lifting a protection removes the mark rather than falsifying it', () => {
  // A row carrying `protectedBy: null` still reads as a decision to anything
  // that only checks whether the field is there.
  const start = DB.indexOf('export async function savePeople');
  const body = DB.slice(start, DB.indexOf('export async function getFacesForPhoto'));
  assert.match(body, /const \{ protectedBy: _was, \.\.\.rest \} = get\.result/);
  assert.match(body, /if \(guard\) row\.protectedBy = guard/);
});

test('one photo\'s faces are found by index, not by scanning', () => {
  // The viewer asks for this every time a photo is opened; a scan would make
  // opening one cost more the longer the library is.
  const start = DB.indexOf('export async function getFacesForPhoto');
  const body = DB.slice(start, start + 600);
  assert.match(body, /index\('photoId'\)/);
});

/* ------------------------------------------------------ surviving a reset */

test('the reset does not take the protected list with it', () => {
  // The point the user made, and the one that matters: a reset dropping this
  // would leave the next run offering exactly the photos it was told never to
  // touch.
  const body = SOURCE.slice(SOURCE.indexOf('async factoryReset()'), SOURCE.indexOf('async exportJson()'));
  assert.match(body, /storageRemove\(\[SETTINGS_KEY, FILTERS_KEY, PEOPLE_KEY\]\)/);
  assert.equal(/storageRemove\(\[[^\]]*PROTECTED_KEY/.test(body), false);
  assert.equal(/this\.state\.protect = \[\]/.test(body), false,
    'nor dropped from memory, or it would return only after a reload');
});

test('the list has its own storage key, not a corner of the settings', () => {
  assert.match(SOURCE, /const PROTECTED_KEY = 'gpc:protected'/);
  const load = SOURCE.slice(SOURCE.indexOf('async loadPersisted()'), SOURCE.indexOf('  persist()'));
  assert.match(load, /PROTECTED_KEY/, 'and is read back on start-up');
});

test('there is still a way to lift one', () => {
  // Unresettable state is its own trap. The reset leaving it is not the same
  // as it being permanent.
  assert.match(SOURCE, /async unprotect\(id\)/);
  assert.match(SOURCE, /this\.state\.protect\.filter\(\(p\) => p\.id !== id\)/);
});

/* --------------------------------------------------------------- the panel */

test('protected photos are narrowed out of the same pool', () => {
  const start = SOURCE.indexOf('  recompute() {');
  const body = SOURCE.slice(start, SOURCE.indexOf('  renderAll() {', start));
  assert.match(body, /hideProtected/);
  assert.match(body, /!it\.protectedBy/);
  assert.match(body, /this\.state\.protectedCount/, 'and how many were hidden is countable');
});

test('the grouping is redone when the list changes', () => {
  // The marks live on the items; without this a protection would take effect
  // only after the next face pass.
  const start = SOURCE.indexOf('  async protectFace(');
  const body = SOURCE.slice(start, SOURCE.indexOf('  async unprotect('));
  assert.match(body, /rebuildGroups\(\{ quiet: true \}\)/);
  const un = SOURCE.slice(SOURCE.indexOf('  async unprotect('), SOURCE.indexOf('  async renameProtected('));
  assert.match(un, /rebuildGroups\(\{ quiet: true \}\)/);
});

/* -------------------------------------------- whose identity gets stored */

/** A group as `forDisplay` hands it over. */
const group = (centroid, over = {}) => ({
  id: 0, name: null, centroid, size: 6, photoIds: ['a', 'b', 'c', 'd', 'e', 'f'],
  spread: 0.1, ...over
});

test('a tight group of one person is borrowed', () => {
  // It generalises better: the centroid has averaged away the lighting and the
  // angle of any single shot.
  const out = chooseIdentity(face(0, 0.05), [group(face(0), { name: 'Ada' })], 0.55);
  assert.equal(out.from, 'group');
  assert.equal(out.name, 'Ada');
});

test('a group holding two people is not borrowed', () => {
  // The bug this fixes: on a photo of four friends, protecting one protected
  // all four, because the nearest group had merged them and its centroid spoke
  // for everybody in it.
  const mixed = group(face(0), { size: 8, photoIds: ['a', 'b', 'c'] });
  const out = chooseIdentity(face(0, 0.05), [mixed], 0.55);
  assert.equal(out.from, 'face', 'more faces than photographs means merged people');
});

test('a group too loose to stand for anybody is not borrowed', () => {
  // Technically unmixed and still a poor identity: its centroid sits between
  // several people rather than on one.
  const loose = group(face(0), { spread: 0.5 });
  assert.equal(chooseIdentity(face(0, 0.05), [loose], 0.55).from, 'face');
});

test('a group of somebody else is not borrowed', () => {
  assert.equal(chooseIdentity(face(9), [group(face(0))], 0.55).from, 'face');
});

test('with no groups at all the face is the identity', () => {
  const v = face(0);
  const out = chooseIdentity(v, [], 0.55);
  assert.equal(out.from, 'face');
  assert.equal(out.centroid, v, 'the face itself, unchanged');
});

test('an unusable vector still yields something storable', () => {
  // Rather than throwing inside a click handler.
  assert.equal(chooseIdentity(null, [group(face(0))], 0.55).from, 'face');
});

test('one photograph contributing two faces marks a group as mixed', () => {
  // Not a heuristic about faces — a fact about photographs, and the same
  // signal the clustering thresholds were measured with.
  assert.equal(looksLikeOnePerson(group(face(0)), 0.55), true);
  assert.equal(looksLikeOnePerson(group(face(0), { size: 7 }), 0.55), false);
  assert.equal(looksLikeOnePerson(group(face(0), { photoIds: [] }), 0.55), false);
  assert.equal(looksLikeOnePerson(null, 0.55), false);
});

test('protecting an already-protected face does nothing', () => {
  const start = SOURCE.indexOf('  async protectFace(');
  const body = SOURCE.slice(start, SOURCE.indexOf('  async unprotect('));
  assert.match(body, /if \(matchProtected\(face\.vector, this\.state\.protect, eps\)\) return/);
});

test('the hiding can be seen from the other side', () => {
  // A filter with no way to check what it removed is one people stop trusting.
  const start = SOURCE.indexOf('  renderProtected() {');
  const body = SOURCE.slice(start, SOURCE.indexOf('  /* ------------------------------------------------------------ onglet 2 */'));
  assert.match(body, /Show their photos anyway/);
  assert.match(body, /hideProtected = !e\.target\.checked/);
});

test('the grid says what it is hiding, and where to go about it', () => {
  // The count belongs where the hiding happens; the editing belongs where
  // there is room to show a face. Two places to change the same thing is how
  // they end up disagreeing.
  const start = SOURCE.indexOf('  buildProtectedSection() {');
  const body = SOURCE.slice(start, SOURCE.indexOf('  /* ------------------------------------------------------------- decisions */'));
  assert.match(body, /kept out of this grid/);
  assert.match(body, /this\.state\.tab = 'protect'/);
  assert.equal(/renameProtected/.test(body), false, 'editing lives in the tab');
});

test('the strip is loaded per photo, and only for the photo still open', () => {
  // Vectors are 2 KB each, and a slow read could otherwise paint the faces of
  // a photo the user has already moved on from.
  const start = SOURCE.indexOf('  async paintViewerFaces(');
  const body = SOURCE.slice(start, SOURCE.indexOf('  /**\n   * Wheel to zoom'));
  assert.match(body, /db\.getFacesForPhoto\(item\.id\)/);
  assert.match(body, /this\.state\.viewing\?\.id !== item\.id/);
  assert.match(body, /host\.isConnected/);
});

test('a face already protected offers no second protection', () => {
  const start = SOURCE.indexOf('  async paintViewerFaces(');
  const body = SOURCE.slice(start, SOURCE.indexOf('  /**\n   * Wheel to zoom'));
  assert.match(body, /const hit = matchProtected\(/);
  assert.match(body, /hit\s*\n?\s*\?/, 'it shows who they are instead of a button');
});

test('a photo whose faces were never read says so', () => {
  // Silence there is indistinguishable from "nobody in this photo", which is a
  // different and much stronger claim.
  const start = SOURCE.indexOf('  async paintViewerFaces(');
  const body = SOURCE.slice(start, SOURCE.indexOf('  /**\n   * Wheel to zoom'));
  assert.match(body, /item\.peopleScanned/);
  assert.match(body, /have not been read/);
});

/* ------------------------------------------------- the panel sees the marks */

test('the panel re-reads the catalogue after the marks are written', () => {
  // The bug this fixes: regroup writes `protectedBy` into the database, but
  // `recompute` filters the copy the panel is holding. Skipping the reload
  // left protected photos in the grid until something else happened to
  // refresh — which looked exactly like protection not working.
  const start = SOURCE.indexOf('  async rebuildGroups(');
  const body = SOURCE.slice(start, SOURCE.indexOf('  async rereadAllFaces('));
  assert.match(body, /await this\.reload\(\)/);
  assert.equal(/if \(!quiet\) await this\.reload\(\)/.test(body), false,
    'the reload is correctness, not presentation: it may not be gated on quiet');
});

test('quiet only silences the busy state', () => {
  const start = SOURCE.indexOf('  async rebuildGroups(');
  const body = SOURCE.slice(start, SOURCE.indexOf('  async rereadAllFaces('));
  assert.match(body, /if \(!quiet\) \{[\s\S]{0,200}busy = 'people'/);
});
