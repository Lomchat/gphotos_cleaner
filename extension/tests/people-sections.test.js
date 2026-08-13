/**
 * Acting on a person rather than on photographs.
 *
 * "Rarest people" puts the least-photographed faces first, which answers a
 * question about a *person* — this face appears four times in twenty years —
 * and then offered no way to act on one. The grid splits into a block per
 * person under that order, each tickable whole.
 *
 * Two rules carry the weight. A photo appears once, under the rarest person in
 * it: repeating it would break the flat index the grid and its shift-ranges are
 * built on, and would let "tick everyone here" quietly reach a photo of someone
 * being kept. And "tick all" means every photo of that person, not the ones
 * that happen to be drawn.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { sectionsByPerson, DEFAULT_FILTERS } from '../src/common/filters.js';
import { Panel } from '../src/ui/panel.js';

const photo = (id, people) => ({ id, ts: 1000, people });
const group = (id, size, name = null) => ({ id, size, name });

/* ------------------------------------------------------------- the split */

test('each person gets a block, rarest first', () => {
  const groups = [group(0, 40), group(1, 3), group(2, 12)];
  const sections = sectionsByPerson(
    [photo('a', [0]), photo('b', [1]), photo('c', [2]), photo('d', [0])],
    groups
  );
  assert.deepEqual(sections.map((s) => s.id), [1, 2, 0]);
  assert.deepEqual(sections.map((s) => s.items.length), [1, 1, 2]);
});

test('a photo appears once, under the rarest person in it', () => {
  // A photo holding a stranger and your sister belongs with the stranger:
  // your sister is the reason to keep it, so the stranger is the question.
  const sections = sectionsByPerson(
    [photo('shared', [0, 1])],
    [group(0, 500), group(1, 2)]
  );
  assert.equal(sections.length, 1);
  assert.equal(sections[0].id, 1);
  assert.equal(sections[0].items.length, 1);
});

test('no photo is ever in two blocks', () => {
  // The grid addresses tiles by their index into one flat list. A duplicate
  // would make two tiles claim the same index, and ticking one would tick the
  // other's photo.
  const groups = [group(0, 9), group(1, 4), group(2, 30)];
  const items = [photo('a', [0, 1]), photo('b', [1, 2]), photo('c', [0, 2]), photo('d', [2])];
  const seen = sectionsByPerson(items, groups).flatMap((s) => s.items.map((i) => i.id));
  assert.equal(seen.length, new Set(seen).size);
  assert.equal(seen.length, items.length, 'and none is lost either');
});

test('photos with nobody recognised go last, in their own block', () => {
  // They are not a person. Mixing them in would make "tick all" mean something
  // different at the bottom of the page than at the top.
  const sections = sectionsByPerson(
    [photo('none', []), photo('unread', undefined), photo('someone', [0])],
    [group(0, 5)]
  );
  assert.equal(sections.at(-1).id, null);
  assert.equal(sections.at(-1).items.length, 2);
});

test('a person nobody is left holding produces no empty block', () => {
  const sections = sectionsByPerson([photo('a', [1])], [group(0, 50), group(1, 2)]);
  assert.deepEqual(sections.map((s) => s.id), [1]);
});

test('a group id the photo carries but the grouping dropped is ignored', () => {
  // Groups are rebuilt from the faces and their ids are positional, so a
  // catalogue can hold an assignment that no longer names anything.
  const sections = sectionsByPerson([photo('a', [99])], [group(0, 5)]);
  assert.deepEqual(sections.map((s) => s.id), [null]);
});

test('blocks are ordered by how rare the person is, not by what survived', () => {
  // Someone with four faces in the library is the interesting case even if
  // only one of them matches the criteria currently on screen.
  const sections = sectionsByPerson(
    [photo('a', [0]), photo('b', [0]), photo('c', [0]), photo('d', [1])],
    [group(0, 60), group(1, 4)]
  );
  assert.equal(sections[0].id, 1, 'the rare person leads with one photo');
});

test('an empty list produces no blocks at all', () => {
  assert.deepEqual(sectionsByPerson([], [group(0, 3)]), []);
});

test('a block carries what it needs to label itself', () => {
  // The same shape for every order, so the panel renders blocks without
  // knowing which question it is showing the answer to.
  const sections = sectionsByPerson([photo('a', [0])], [group(0, 7, 'Grandma')]);
  assert.equal(sections[0].title, 'Grandma');
  assert.match(sections[0].note, /7 face/);
  assert.ok(sections[0].key, 'and a stable key');
});

test('an unnamed person is still identifiable', () => {
  const sections = sectionsByPerson([photo('a', [3])], [group(3, 2)]);
  assert.equal(sections[0].title, 'Person 4', 'ids are positional; people count from one');
});

/* ------------------------------------------------------- ticking a person */

test('ticking a block takes every photo of that person', () => {
  const p = {
    state: { selection: new Set() },
    anchorIndex: 4, rangePreview: {},
    paintSelection() {}, renderModal() {},
    toggleSection: Panel.prototype.toggleSection
  };
  p.toggleSection(['a', 'b', 'c'], true);
  assert.deepEqual([...p.state.selection].sort(), ['a', 'b', 'c']);
});

test('unticking a block leaves the rest of the selection alone', () => {
  const p = {
    state: { selection: new Set(['a', 'b', 'z']) },
    anchorIndex: null, rangePreview: null,
    paintSelection() {}, renderModal() {},
    toggleSection: Panel.prototype.toggleSection
  };
  p.toggleSection(['a', 'b'], false);
  assert.deepEqual([...p.state.selection], ['z']);
});

test('a bulk tick drops the shift anchor', () => {
  // The anchor belonged to a single click. Extending from it after a block
  // tick would sweep a range the user has no reason to expect.
  const p = {
    state: { selection: new Set() },
    anchorIndex: 7, rangePreview: { from: 1, to: 7 },
    paintSelection() {}, renderModal() {},
    toggleSection: Panel.prototype.toggleSection
  };
  p.toggleSection(['a'], true);
  assert.equal(p.anchorIndex, null);
  assert.equal(p.rangePreview, null);
});

/* ------------------------------------------------- picking someone at all */

/** A panel stand-in holding the filter state the picker touches. */
function picker(personIds = [], enabled = {}) {
  return {
    state: {
      filters: {
        ...structuredClone(DEFAULT_FILTERS),
        personIds: [...personIds],
        enabled: { ...DEFAULT_FILTERS.enabled, ...enabled }
      }
    },
    applyPersonFilters() {},
    togglePerson: Panel.prototype.togglePerson
  };
}

test('picking somebody switches the criterion on', () => {
  // It used to change nothing visible: both people criteria stayed off, the
  // grid did not move, and the picker looked broken.
  const p = picker();
  p.togglePerson(3);
  assert.deepEqual(p.state.filters.personIds, [3]);
  assert.equal(p.state.filters.enabled.withPerson, true);
});

test('a second pick does not re-decide which criterion is on', () => {
  // Someone who chose "without" and then adds a person means to add them to
  // that filter, not to have it flipped to the opposite question.
  const p = picker([1], { withoutPerson: true });
  p.togglePerson(2);
  assert.equal(p.state.filters.enabled.withoutPerson, true);
  assert.equal(p.state.filters.enabled.withPerson, false);
});

test('unpicking the last person switches both criteria off', () => {
  // Neither can match anything now, and a ticked box that filters nothing is
  // exactly what made these two confusing.
  const p = picker([1], { withPerson: true });
  p.togglePerson(1);
  assert.deepEqual(p.state.filters.personIds, []);
  assert.equal(p.state.filters.enabled.withPerson, false);
  assert.equal(p.state.filters.enabled.withoutPerson, false);
});

test('unpicking one of several leaves the criterion on', () => {
  const p = picker([1, 2], { withPerson: true });
  p.togglePerson(2);
  assert.deepEqual(p.state.filters.personIds, [1]);
  assert.equal(p.state.filters.enabled.withPerson, true);
});

/* --------------------------------------------------------------- wiring */

const SOURCE = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');

test('which orders split the grid is decided in one place', () => {
  // Three of them answer a question about a group; the rest rank a property of
  // one photograph. Spreading that decision across the panel is how an order
  // gets half-wired.
  const body = SOURCE.slice(SOURCE.indexOf('  recompute() {'), SOURCE.indexOf('  renderAll() {'));
  assert.match(body, /sectionsForSort\(/);
  assert.equal(/sort === 'rarePeople'|sort === 'oldest'|sort === 'similar'/.test(body), false,
    'the panel must not re-decide which orders section themselves');
});

test('the flat list is rebuilt from the blocks, in the order shown', () => {
  // Tiles are addressed by index into it. A list in a different order from the
  // grid would tick the wrong photographs.
  const body = SOURCE.slice(SOURCE.indexOf('  recompute() {'), SOURCE.indexOf('  renderAll() {'));
  assert.match(body, /this\.state\.filtered = this\.state\.sections\.flatMap/);
  assert.match(body, /this\.state\.sections = sections && sections\.length \? sections : null/,
    'an order with no blocks must fall back to a plain grid');
});

test('a block tick repaints, and never re-renders', () => {
  // Re-rendering to update one button label would scroll the user back to the
  // top of the grid they were working through — the failure `paintSelection`
  // exists to avoid, and the third one of its kind in this file's history.
  const body = SOURCE.slice(SOURCE.indexOf('  toggleSection('), SOURCE.indexOf('  toggleSection(') + 900);
  assert.match(body, /this\.paintSelection\(\)/);
  assert.equal(/this\.render(Modal|All|Scan)\(\)/.test(body), false,
    'the block button label is repainted by paintActions instead');
});

test('a block button follows the selection under it', () => {
  // Ticking the last photo of a person by hand must flip that block's button,
  // or it offers to tick what is already ticked.
  const button = { textContent: '' };
  const p = {
    state: { selection: new Set(['a']), busy: null },
    sectionButtons: [{ ids: ['a', 'b'], button }],
    modalTicked: null, modalTickButton: null, modalBinButton: null,
    paintActions: Panel.prototype.paintActions
  };
  p.paintActions();
  assert.equal(button.textContent, 'Tick all 2');

  p.state.selection.add('b');
  p.paintActions();
  assert.equal(button.textContent, 'Untick all 2');
});

test('tick-all covers the whole block, not the part on screen', () => {
  const body = SOURCE.slice(SOURCE.indexOf('  buildSections('), SOURCE.indexOf('  toggleSection('));
  assert.match(body, /const ids = section\.items\.map/,
    'the ids must come from the section, never from the rendered slice');
  assert.match(body, /shown/, 'while only the drawn part is built');
});

/* ------------------------------------------------------ blocks by day */

import { sectionsByDay, sectionsBySimilarity, sectionsForSort, SORTS } from '../src/common/filters.js';

const dated = (id, iso) => ({ id, ts: new Date(iso).getTime() });

test('a day becomes a block', () => {
  const sections = sectionsByDay([
    dated('a', '2024-03-02T09:00:00'),
    dated('b', '2024-03-02T18:00:00'),
    dated('c', '2024-03-05T10:00:00')
  ]);
  assert.equal(sections.length, 2);
  assert.deepEqual(sections.map((s) => s.items.length), [2, 1]);
  assert.match(sections[0].title, /2024-03-02/);
});

test('the blocks keep the order they were given', () => {
  // Oldest and newest are opposite buttons. Re-sorting here would make the
  // blocks disagree with the one the user pressed.
  const newestFirst = [dated('c', '2024-03-05T10:00:00'), dated('a', '2024-03-02T09:00:00')];
  assert.deepEqual(sectionsByDay(newestFirst).map((s) => s.items[0].id), ['c', 'a']);
});

test('undated photos get their own block rather than a wrong day', () => {
  const sections = sectionsByDay([dated('a', '2024-03-02T09:00:00'), { id: 'x', ts: null }]);
  assert.equal(sections.at(-1).title, 'No date');
  assert.equal(sections.at(-1).items.length, 1);
});

test('a list that is not in date order produces more blocks, not a wrong one', () => {
  // Splitting consecutive runs cannot invent a day that is not there.
  const sections = sectionsByDay([
    dated('a', '2024-03-02T09:00:00'),
    dated('b', '2024-03-05T09:00:00'),
    dated('c', '2024-03-02T11:00:00')
  ]);
  assert.equal(sections.length, 3);
  for (const s of sections) assert.equal(s.items.length, 1);
});

/* ------------------------------------------------ blocks by lookalike */

test('each set of lookalikes becomes a block, biggest first', () => {
  const groups = new Map([['r1', ['a', 'b']], ['r2', ['c', 'd', 'e']]]);
  const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }));
  const sections = sectionsBySimilarity(items, groups);
  assert.deepEqual(sections.map((s) => s.items.length), [3, 2]);
  assert.match(sections[0].title, /3 lookalikes/);
});

test('photos nothing resembles go last, together', () => {
  const groups = new Map([['r1', ['a', 'b']]]);
  const items = ['a', 'b', 'lonely'].map((id) => ({ id }));
  const sections = sectionsBySimilarity(items, groups);
  assert.equal(sections.at(-1).items.length, 1);
  assert.match(sections.at(-1).title, /Nothing resembles/);
});

test('a set whose members were all filtered out leaves no empty block', () => {
  const groups = new Map([['r1', ['a', 'b']], ['r2', ['gone1', 'gone2']]]);
  const sections = sectionsBySimilarity([{ id: 'a' }, { id: 'b' }], groups);
  assert.equal(sections.length, 1);
});

test('no lookalikes at all is a single block, not an error', () => {
  const sections = sectionsBySimilarity([{ id: 'a' }], new Map());
  assert.equal(sections.length, 1);
  assert.equal(sections[0].items.length, 1);
});

/* ----------------------------------------------------- which order splits */

test('only the orders that ask about a group get blocks', () => {
  const items = [dated('a', '2024-03-02T09:00:00')];
  const ctx = { groups: [group(0, 3)], duplicates: new Map() };
  for (const key of ['oldest', 'newest', 'similar']) {
    assert.ok(sectionsForSort(items, key, ctx), `${key} should split`);
  }
  for (const key of ['suspicion', 'noPeople', 'blurry', 'dark', 'biggest']) {
    assert.equal(sectionsForSort(items, key, ctx), null, `${key} should not split`);
  }
});

test('rarest people falls back to a plain grid before there are any people', () => {
  // Otherwise every photo lands in one giant "nobody recognised" block, which
  // is a grouping that says nothing.
  const items = [{ id: 'a' }];
  assert.equal(sectionsForSort(items, 'rarePeople', { groups: [], duplicates: new Map() }), null);
  assert.ok(sectionsForSort(items, 'rarePeople', { groups: [group(0, 2)], duplicates: new Map() }));
});

test('the lookalike order ranks by how big the set is', () => {
  const ctx = { similarSize: new Map([['a', 5], ['b', 2]]) };
  assert.equal(SORTS.similar.key({ id: 'a' }, ctx), 5);
  assert.equal(SORTS.similar.key({ id: 'b' }, ctx), 2);
  assert.equal(SORTS.similar.key({ id: 'lonely' }, ctx), null, 'and sinks what has no set');
  assert.equal(SORTS.similar.dir, -1);
});

test('the lookalike order works before anything has been grouped', () => {
  assert.equal(SORTS.similar.key({ id: 'a' }, {}), null);
});
