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
import { PANEL_CSS } from '../src/ui/styles.js';
import { DEFAULT_FILTERS, CRITERION_TESTS, CRITERION_LABELS } from '../src/common/filters.js';

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
    'sorts', 'sortbar', 'ranged'
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

test('every criterion needing the People pass says so in its hint', () => {
  for (const crit of CRITERIA.filter((c) => c.needsPeople)) {
    assert.match(crit.hint, /people/i, `${crit.key} does not point at the People tab`);
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
