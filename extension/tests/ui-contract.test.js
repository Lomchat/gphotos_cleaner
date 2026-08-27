/**
 * Internal interface contracts.
 *
 * Nothing checks these links at runtime: a slider bound to a non-existent
 * setting yields `undefined`, the filter then lets everything through, and
 * nothing says so. A "reset to default" button with no default resets to
 * `undefined` too. These errors are silent and dangerous, because they end up
 * in front of a selection button.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { CRITERIA, Panel } from '../src/ui/panel.js';

const DEFAULT_SETTINGS_SOURCE = readFileSync(
  new URL('../src/ui/panel.js', import.meta.url), 'utf8'
);
import { PANEL_CSS } from '../src/ui/styles.js';
import {
  DEFAULT_FILTERS, CRITERION_TESTS, CRITERION_LABELS, SORTS, SORT_KEYS
} from '../src/common/filters.js';

/* ------------------------------------------------------ criteria <-> filters */

test('every UI criterion has a matching predicate', () => {
  for (const crit of CRITERIA) {
    assert.ok(CRITERION_TESTS[crit.key], `"${crit.key}" has no predicate`);
    assert.ok(CRITERION_LABELS[crit.key], `"${crit.key}" has no label`);
    assert.equal(typeof DEFAULT_FILTERS.enabled[crit.key], 'boolean',
      `"${crit.key}" has no default enabled state`);
  }
});

test('no predicate is orphaned from the UI', () => {
  // A filterable but undisplayed criterion would be unreachable.
  const exposes = new Set(CRITERIA.map((c) => c.key));
  for (const key of Object.keys(CRITERION_TESTS)) {
    assert.ok(exposes.has(key), `predicate "${key}" is exposed nowhere`);
  }
});

test('every slider drives a setting that really exists', () => {
  // Without this guarantee `filters[prop]` is `undefined`, and the predicate
  // comparison silently becomes always false (or always true).
  for (const crit of CRITERIA) {
    for (const c of crit.controls || []) {
      if (c.type === 'daterange') {
        assert.ok('from' in DEFAULT_FILTERS && 'to' in DEFAULT_FILTERS);
        continue;
      }
      assert.ok(c.prop, `a control of "${crit.key}" has no property`);
      assert.ok(c.prop in DEFAULT_FILTERS,
        `"${c.prop}" (criterion ${crit.key}) is missing from DEFAULT_FILTERS`);
      assert.notEqual(DEFAULT_FILTERS[c.prop], undefined,
        `"${c.prop}" has no default: the reset button would do nothing`);
    }
  }
});

test('slider bounds contain their default value', () => {
  // An out-of-range default is silently clamped by the browser, so the reset
  // button would never return to it.
  for (const crit of CRITERIA) {
    for (const c of crit.controls || []) {
      if (c.type === 'select' || c.type === 'daterange') continue;
      const v = DEFAULT_FILTERS[c.prop];
      assert.ok(typeof v === 'number', `${c.prop} should be numeric`);
      assert.ok(v >= c.min && v <= c.max,
        `${c.prop} = ${v} is outside [${c.min}, ${c.max}]`);
    }
  }
});

test('dropdowns offer their default value', () => {
  for (const crit of CRITERIA) {
    for (const c of crit.controls || []) {
      if (c.type !== 'select') continue;
      const values = c.options.map(([v]) => v);
      assert.ok(values.includes(DEFAULT_FILTERS[c.prop]),
        `${c.prop}: the default "${DEFAULT_FILTERS[c.prop]}" is not offered`);
    }
  }
});

test('every criterion carries an explanation and an icon', () => {
  const icons = new Set();
  for (const crit of CRITERIA) {
    assert.ok(crit.label && crit.label.length > 2, `${crit.key} has no label`);
    assert.ok(crit.hint && crit.hint.length > 20,
      `${crit.key} has no explanation: the user must be able to judge before ticking`);
    assert.ok(crit.icon, `${crit.key} has no icon`);
    // Two criteria sharing an icon blur together at a glance, which cancels the
    // whole benefit of having icons.
    assert.equal(icons.has(crit.icon), false, `icon ${crit.icon} already used`);
    icons.add(crit.icon);
  }
});

/* -------------------------------------------------------------- stylesheet */

test('the stylesheet contains no backtick', () => {
  // It lives in a template literal: a backtick ends the string and breaks the
  // whole file, and therefore the whole panel.
  assert.equal(PANEL_CSS.includes('`'), false,
    'a backtick in the CSS would end the template literal');
});

test('the stylesheet is syntactically balanced', () => {
  const opening = (PANEL_CSS.match(/\{/g) || []).length;
  const closing = (PANEL_CSS.match(/\}/g) || []).length;
  assert.equal(opening, closing, 'unbalanced braces');
  assert.equal((PANEL_CSS.match(/\/\*/g) || []).length,
    (PANEL_CSS.match(/\*\//g) || []).length, 'unclosed comment');
});

test('every class used by the panel is defined', () => {
  // A class set by the JS but absent from the CSS yields an invisible or
  // misplaced element, with no error at all.
  const critical = [
    'badge', 'panel', 'modal', 'layout', 'side', 'main', 'grid', 'thumb',
    'score', 'chip', 'reset', 'count', 'stale', 'filter', 'controls',
    'slider', 'banner', 'kpi', 'progress', 'log', 'summary', 'buttons',
    'hero', 'ring', 'center', 'milestones', 'ms', 'icon', 'mark', 'num',
    'people', 'person', 'faces', 'field', 'card-title', 'tiny',
    'sorts', 'sortbar', 'ranged',
    // Blocks, the facts on a tile, the full-size view and the hint mark.
    'group-block', 'faces-strip', 'crop', 'guarded', 'facts', 'zoom', 'viewer', 'sheet', 'stage', 'backdrop', 'why'
  ];
  for (const cls of critical) {
    assert.ok(new RegExp(`\\.${cls}[\\s,:.{\\[]`).test(PANEL_CSS),
      `class "${cls}" is used by the panel but missing from the CSS`);
  }
});

/* ------------------------------------------------------------ people tab */

test('the people criteria are flagged as needing the People pass', () => {
  // The panel greys nothing out on its own: without this flag the hint would
  // be the only thing telling a user why ticking the box does nothing.
  for (const key of ['withPerson', 'withoutPerson']) {
    const crit = CRITERIA.find((c) => c.key === key);
    assert.ok(crit, `${key} is missing from the UI`);
    assert.equal(crit.needsPeople, true, `${key} should be flagged needsPeople`);
  }
});

test('criteria that work on the thumbnail alone are not flagged', () => {
  const local = CRITERIA.filter((c) => !c.needsPeople).map((c) => c.key);
  assert.ok(local.includes('noFace'));
  assert.ok(local.includes('duplicates'));
});

test('every criterion needing the People pass explains itself', () => {
  // There is no tab to send anyone to any more: the picker sits directly under
  // these criteria, so the hint has to stand on its own.
  for (const crit of CRITERIA.filter((c) => c.needsPeople)) {
    assert.ok(crit.hint.length > 30, `${crit.key} has no real explanation`);
  }
});

test('each reason the people criteria are blocked is distinct and actionable', () => {
  // Three different fixes — fetch the model, read the photos, pick somebody.
  // One vague "unavailable" would leave the user guessing at all three.
  const reason = (people, personIds) => Panel.prototype.peopleBlockReason.call({
    state: { people, filters: { personIds } }
  });
  const noModel = reason({ modelReady: false, groups: [] }, []);
  const noGroups = reason({ modelReady: true, groups: [] }, []);
  const noPick = reason({ modelReady: true, groups: [{ id: 0 }] }, []);
  const ready = reason({ modelReady: true, groups: [{ id: 0 }] }, [0]);

  assert.match(noModel, /model/i);
  assert.match(noGroups, /analysis/i);
  assert.match(noPick, /tick/i);
  assert.equal(ready, null);
  assert.equal(new Set([noModel, noGroups, noPick]).size, 3);
});

test('a blocked people criterion is never left active in the filters', () => {
  // The UI renders it unticked; if the state disagrees the predicate keeps
  // running and photos stay selected under a filter the user cannot see.
  const filters = {
    ...DEFAULT_FILTERS,
    enabled: { ...DEFAULT_FILTERS.enabled, withPerson: true, withoutPerson: true },
    personIds: [0]
  };
  const fake = {
    state: { filters, people: { modelReady: false, groups: [] } },
    peopleBlockReason: Panel.prototype.peopleBlockReason,
    syncBlockedCriteria: Panel.prototype.syncBlockedCriteria
  };
  fake.syncBlockedCriteria();
  assert.equal(filters.enabled.withPerson, false);
  assert.equal(filters.enabled.withoutPerson, false);
});

test('a usable people criterion is left alone', () => {
  const filters = {
    ...DEFAULT_FILTERS,
    enabled: { ...DEFAULT_FILTERS.enabled, withPerson: true },
    personIds: [0]
  };
  const fake = {
    state: { filters, people: { modelReady: true, groups: [{ id: 0 }] } },
    peopleBlockReason: Panel.prototype.peopleBlockReason,
    syncBlockedCriteria: Panel.prototype.syncBlockedCriteria
  };
  fake.syncBlockedCriteria();
  assert.equal(filters.enabled.withPerson, true);
});

test('criteria that need no backend are untouched by the sync', () => {
  const filters = {
    ...DEFAULT_FILTERS,
    enabled: { ...DEFAULT_FILTERS.enabled, blurry: true },
    personIds: []
  };
  const fake = {
    state: { filters, people: { modelReady: false, groups: [] } },
    peopleBlockReason: Panel.prototype.peopleBlockReason,
    syncBlockedCriteria: Panel.prototype.syncBlockedCriteria
  };
  fake.syncBlockedCriteria();
  assert.equal(filters.enabled.blurry, true);
});

/* ------------------------------------------------------------- rendering */

test('optional blocks never print the word "null"', () => {
  // Node.append(null) inserts the literal text "null" — it does not skip the
  // way el() does for its own children. Every optional section in the panel is
  // appended through put(), which does skip.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const direct = source.match(/^\s*(?:t|this\.\w+)\.append\($/gm) || [];
  assert.equal(direct.length, 0,
    `${direct.length} bare .append( call(s) remain; use put(target, ...) so absent blocks stay silent`);
});

test('the panel asks whether the model is already downloaded when it starts', () => {
  // Whether the model exists lives in the offscreen document's storage, not in
  // the panel's. Without this call `modelReady` stays false on every load and a
  // model fetched yesterday is offered for download again — which is exactly
  // what happened.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const mount = source.slice(source.indexOf('async mount()'), source.indexOf('async loadPersisted'));
  assert.match(mount, /refreshPeopleState\(\)/,
    'mount() must refresh the recognition-model state');
});

/** The body of one method, from its declaration to the start of the next one. */
function methodBody(source, name) {
  // `async` is part of the declaration, so matching the bare name would miss
  // exactly the methods that do the interesting work.
  const start = source.search(new RegExp(`\\n {2}(?:async )?${name}\\(`));
  assert.notEqual(start, -1, `${name} not found`);
  const rest = source.slice(start + 1);
  const end = rest.search(/\n {2}(?:\/\*\*|(?:async )?[a-zA-Z_$][\w$]*\()/);
  return end === -1 ? rest : rest.slice(0, end);
}

test('the people picker starts no run of its own', () => {
  // Reading photos belongs with the analysis that feeds it, in one place, so
  // there is never a second pass to remember.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const section = methodBody(source, 'buildPeopleSection');
  assert.equal(/runPeopleScan\(/.test(section), false,
    'the face pass is started from the Analyse tab');
  assert.equal(/downloadRecognitionModel\(/.test(section), false,
    'the model download lives in the Analyse tab');
});

test('there is no People tab left to reach', () => {
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  assert.equal(/renderPeople\s*\(/.test(source), false, 'renderPeople should be gone');
  assert.equal(/tabs\.people/.test(source), false, 'the tab node should be gone');
  assert.equal(/'people', 'People'/.test(source), false, 'the nav entry should be gone');
});

test('the picker is rendered beside the criteria it parameterises', () => {
  // Orphaned, the two people criteria could be ticked with no way to say who.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const modal = methodBody(source, 'renderModal');
  assert.match(modal, /buildPeopleSection\(\)/,
    'the sorting view must render the people picker');
});

test('grouping is one switch, with no separate download step', () => {
  // Asking twice for the same decision only strands people who ticked the box
  // and then wondered why nothing happened.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const block = methodBody(source, 'buildPeopleOption');
  assert.equal(/Download the model/.test(block), false,
    'the download button should be gone; the run fetches it');
  assert.match(block, /scanPeople/, 'the switch belongs in the Analyse tab');
  assert.match(block, /runPeopleScan\(/,
    'so does the catch-up button for photos analysed before it was switched on');
});

test('the switch says what it will download, before anything runs', () => {
  // The switch is the consent, so the disclosure sits on it rather than in a
  // dialog after the fact. Three facts, and no more than three: how big, that
  // it is the only non-photo download, and how to decline. The licence — why it
  // is not bundled — belongs in the README, not in front of a button.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const block = methodBody(source, 'buildPeopleOption');
  assert.match(block, /13 MB/, 'the size must be stated');
  assert.match(block, /not your photos|not one of your photos/,
    'that it is the only non-photo download must be stated');
  assert.match(block, /Untick to skip/, 'declining must be offered');
});

test('grouping is on by default', () => {
  assert.equal(DEFAULT_SETTINGS_SOURCE.includes('scanPeople: true'), true,
    'the switch ships ticked');
});

test('the pass fetches the model itself, and gives up gracefully', () => {
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const scan = methodBody(source, 'runPeopleScan');
  assert.match(scan, /ensureRecognitionModel\(/,
    'the scan must fetch the model rather than refusing to start');

  const ensure = methodBody(source, 'ensureRecognitionModel');
  assert.match(ensure, /return false/,
    'a failed download must be survivable: the visual analysis is worth keeping');
});

test('every method the panel calls on itself exists', () => {
  // A doc comment missing its closing marker swallows the method below it and
  // the file still parses cleanly — the failure only shows up as a TypeError
  // in the browser, at render time, with the panel already half-drawn.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const called = new Set([...source.matchAll(/this\.([a-zA-Z_$][\w$]*)\(/g)].map((m) => m[1]));
  const missing = [...called].filter((name) => typeof Panel.prototype[name] !== 'function');
  assert.deepEqual(missing, [], `called but not defined: ${missing.join(', ')}`);
});

test('no doc comment is left unclosed', () => {
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const opened = (source.match(/\/\*/g) || []).length;
  const closed = (source.match(/\*\//g) || []).length;
  assert.equal(opened, closed, 'an unclosed comment hides everything after it');
});

test('a blocked criterion only offers a way out when the fix is elsewhere', () => {
  // When the answer is "tick someone", the picker sits directly below. A button
  // sending the user to another tab would be worse than no button at all.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const build = methodBody(source, 'buildCriterion');
  const gate = build.indexOf('people.groups.length');
  const button = build.indexOf('Open the Analyse tab');
  assert.notEqual(gate, -1, 'the button must be gated on whether any people exist');
  assert.ok(gate < button, 'the gate must come before the button it guards');
});

test('filtering shows, and never selects', () => {
  // Switching a criterion on used to tick everything it caught. But a
  // criterion is a guess — the screenshot detector is "fair", blur has a
  // threshold someone dragged — and turning a guess into a selection puts a
  // thousand photos one click from the bin before anyone has looked at one.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const body = methodBody(source, 'recompute');
  assert.equal(/selection = new Set\(r\.items/.test(body), false,
    'recompute must never fill the selection from what a filter matched');
  assert.equal(/selection = new Set\(this\.state\.filtered/.test(body), false);
});

test('a selection never outlives what is on screen', () => {
  // The footer count and the weight beside it have to describe something
  // visible, or the confirmation quotes a number nobody can account for.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const body = methodBody(source, 'recompute');
  assert.match(body, /const visible = new Set\(this\.state\.filtered\.map/);
  assert.match(body, /if \(!visible\.has\(id\)\) this\.state\.selection\.delete\(id\)/);
});

test('the similarity slider writes to the setting, not to the filters', () => {
  // resetButton() restores DEFAULT_FILTERS entries. The threshold is a setting,
  // so pointing that helper at it would write undefined and quietly disable
  // grouping altogether.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const body = methodBody(source, 'buildEpsControl');
  assert.equal(/resetButton\(\[/.test(body), false,
    'the filter reset helper must not be used for a setting');
  assert.match(body, /s\.peopleEps = SHIPPED_EPS/, 'its own reset must restore the default');
  assert.match(body, /rebuildGroups\(\)/, 'changing it must regroup');
});

test('the similarity slider spans the measured window and beyond', () => {
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const body = methodBody(source, 'buildEpsControl');
  assert.match(body, /min: 0\.45/, 'must reach below the same-person floor');
  assert.match(body, /max: 0\.7/, 'must reach past the stranger threshold, with a warning');
  assert.match(body, /mixed\?|different people/i, 'the risky end must say what goes wrong');
});

/* ------------------------------------------------- the criteria column */

test('a criterion explains itself on demand, not permanently', () => {
  // Thirteen criteria each with a paragraph under it filled the column four at
  // a time. The text is worth reading once, not on every visit.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const body = methodBody(source, 'buildCriterion');
  assert.match(body, /class: 'why', title: crit\.hint/,
    'the hint must move onto a mark that can be hovered');
  assert.equal(/el\('div', \{ class: 'hint' \}, blocked \|\| crit\.hint\)/.test(body), false,
    'and must not also be printed under every one');
});

test('the reason a criterion is blocked stays on screen', () => {
  // That is not an explanation of what it does — it is why it cannot be used,
  // and hiding it leaves a greyed box with no account of itself.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const body = methodBody(source, 'buildCriterion');
  assert.match(body, /blocked \? el\('div', \{ class: 'hint' \}, blocked\) : null/);
});

test('every criterion still carries a hint worth showing', () => {
  // Now that it lives in a tooltip, an empty one would leave a mark that does
  // nothing when hovered.
  for (const crit of CRITERIA) {
    assert.ok(crit.hint && crit.hint.length > 20, `${crit.key} has nothing to show`);
  }
});

test('the Analyse tab offers the way on to sorting', () => {
  // The analysis is a means; when it finishes the next step is always the
  // same one, two tabs away.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const body = methodBody(source, 'buildHero');
  assert.match(body, /this\.openModal\(\)/);
  assert.match(body, /s\.total\s*\n?\s*\?/, 'and only once there is something to sort');
});

test('every order has a label and an explanation', () => {
  // The order bar shows the hint of whichever is active, so a missing one
  // leaves the line under the buttons blank.
  for (const key of SORT_KEYS) {
    assert.ok(SORTS[key].label, `${key} has no label`);
    assert.ok(SORTS[key].hint && SORTS[key].hint.length > 20, `${key} has no explanation`);
  }
});

test('each order that needs a pass says which one', () => {
  // Shown and disabled rather than hidden, with the reason: a button that
  // vanishes reads as a bug, and one that does nothing reads as broken.
  const source = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');
  const body = methodBody(source, 'buildSortBar');
  for (const flag of ['needsPeople', 'needsSizes', 'needsSimilar']) {
    assert.match(body, new RegExp(`sort\.${flag}`), `${flag} is declared but never checked`);
  }
  const declared = SORT_KEYS.filter((k) => SORTS[k].needsPeople || SORTS[k].needsSizes || SORTS[k].needsSimilar);
  assert.ok(declared.length >= 3, 'the gated orders should still be gated');
});
