/**
 * How far back the library has ever been walked.
 *
 * The months in "only handle photos older than" are relative to today, so they
 * drift: pick *6 months* twice a fortnight apart and you get two different
 * dates, neither of which is where you actually stopped. Work in slices and
 * you have to remember the boundary yourself, or re-walk ground you already
 * covered.
 *
 * So a run records the oldest photo it handled, and that becomes a preset.
 * Two properties make it trustworthy, and both are easy to break:
 *
 *  - it only ever moves **backwards**, so a run bounded to last month cannot
 *    erase the fact that January is done;
 *  - it survives the reset, because it records work that was done rather than
 *    what was found, and no rerun can recover it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Panel } from '../src/ui/panel.js';
import { ApiScanner } from '../src/content/api-scanner.js';

const SOURCE = readFileSync(new URL('../src/ui/panel.js', import.meta.url), 'utf8');

/** The body of one method — not the call sites that share its name. */
function methodBody(name) {
  const start = SOURCE.search(new RegExp(`\\n {2}(?:async )?${name}\\(`));
  assert.notEqual(start, -1, `${name} not found`);
  const rest = SOURCE.slice(start + 1);
  const end = rest.search(/\n {2}(?:\/\*\*|(?:async )?[a-zA-Z_$][\w$]*\()/);
  return end === -1 ? rest : rest.slice(0, end);
}

const DAY = 86400000;
const T0 = Date.UTC(2026, 1, 13); // 13 February 2026, the user's example

/* ------------------------------------------------ what a run reports back */

const TOKENS = { at: 'AT', sid: 'SID', bl: 'BL', path: '/' };

function raw(id, ts) {
  return [id, [`https://lh3.googleusercontent.com/${id}`, 100, 100], ts, `dedup-${id}`,
    0, ts, null, [[1]], null, null, null, null, null, false, {}];
}

/** An API that answers one page, and a store that accepts anything. */
function harness(items, existing = []) {
  const rows = new Map(existing.map((id) => [id, { id }]));
  let meta = null;
  const fetchImpl = async (url, init) => {
    const [rpcid] = JSON.parse(new URLSearchParams(init.body).get('f.req'))[0][0];
    const payload = rpcid === 'lcxiM' ? [items, null, String(T0)] : [[null, []]];
    return {
      ok: true, status: 200,
      text: async () => ")]}'\n\n" + JSON.stringify([['wrb.fr', rpcid, JSON.stringify(payload)]])
    };
  };
  return {
    rows,
    scanner: (opts = {}) => new ApiScanner({
      tokens: TOKENS, fetchImpl, withSizes: false, ...opts,
      deps: {
        getAllIds: async () => [...rows.keys()],
        upsertItems: async (batch) => { for (const r of batch) rows.set(r.id, r); },
        getMeta: async () => meta,
        setMeta: async (_k, v) => { meta = v; },
        getTokens: async () => TOKENS,
        refreshTokens: async () => TOKENS
      }
    })
  };
}

test('a run reports the oldest photo it handled', () => {
  // The user's example: 2,000 photos from 13 February, the last one dated
  // 4 January. That date is what the next run should start from.
  const h = harness([raw('a', T0), raw('b', T0 - 20 * DAY), raw('c', T0 - 40 * DAY)]);
  return h.scanner().run().then((r) => {
    assert.equal(r.oldestHandled, T0 - 40 * DAY);
  });
});

test('photos skipped as too recent do not count as handled', () => {
  // They were seen, not handled. Counting them would move the mark forward to
  // a date nothing was actually done at.
  const cutoff = T0 - 10 * DAY;
  const h = harness([raw('recent', T0), raw('old', T0 - 30 * DAY)]);
  return h.scanner({ olderThanTs: cutoff }).run().then((r) => {
    assert.equal(r.oldestHandled, T0 - 30 * DAY);
  });
});

test('photos already in the catalogue still count as handled', () => {
  // A resumed run that re-walks known ground did reach that far back, and
  // saying otherwise would make the mark jump forward on the second run.
  const h = harness([raw('a', T0), raw('b', T0 - 50 * DAY)], ['a', 'b']);
  return h.scanner().run().then((r) => {
    assert.equal(r.discovered, 0);
    assert.equal(r.oldestHandled, T0 - 50 * DAY);
  });
});

test('a run that handled nothing reports nothing', () => {
  // Rather than a zero, or today, either of which would be a claim.
  const h = harness([]);
  return h.scanner().run().then((r) => {
    assert.equal(r.oldestHandled, null);
  });
});

/* --------------------------------------------------- the mark itself */

function panel(previous = null) {
  const written = [];
  return {
    written,
    state: { progress: previous },
    noteContext: () => false,
    renderAll() {},
    noteProgress: Panel.prototype.noteProgress,
    _storage: written
  };
}

test('the first run sets the mark', async () => {
  const p = panel();
  await p.noteProgress(T0 - 40 * DAY);
  assert.equal(p.state.progress.oldestTs, T0 - 40 * DAY);
});

test('a run that reaches further back moves it', async () => {
  const p = panel({ oldestTs: T0 - 40 * DAY });
  await p.noteProgress(T0 - 90 * DAY);
  assert.equal(p.state.progress.oldestTs, T0 - 90 * DAY);
});

test('a run over recent photos never moves it forward', async () => {
  // The property that makes it safe to offer as a starting point: bounding a
  // run to last month must not erase that January is behind you.
  const p = panel({ oldestTs: T0 - 90 * DAY });
  await p.noteProgress(T0 - 5 * DAY);
  assert.equal(p.state.progress.oldestTs, T0 - 90 * DAY);
});

test('the same date twice changes nothing', async () => {
  const p = panel({ oldestTs: T0 });
  const before = p.state.progress;
  await p.noteProgress(T0);
  assert.equal(p.state.progress, before, 'not even a rewrite');
});

test('a run with nothing to report leaves it alone', async () => {
  const p = panel({ oldestTs: T0 });
  await p.noteProgress(null);
  assert.equal(p.state.progress.oldestTs, T0);
});

/* ------------------------------------------------------ surviving a reset */

test('the reset clears everything except how far you have walked', () => {
  // The whole point. Everything else can be rebuilt by running again; this
  // records work that was done, and no rerun recovers it.
  const body = SOURCE.slice(SOURCE.indexOf('async factoryReset()'), SOURCE.indexOf('async exportJson()'));
  assert.match(body, /storageRemove\(\[SETTINGS_KEY, FILTERS_KEY, PEOPLE_KEY\]\)/);
  assert.equal(/storageRemove\(\[[^\]]*PROGRESS_KEY/.test(body), false,
    'PROGRESS_KEY must not be in the list the reset clears');
  assert.equal(/this\.state\.progress = null/.test(body), false,
    'nor dropped from memory, or it would come back only after a reload');
});

test('the mark has its own key, not a corner of the settings', () => {
  // Stored with the settings it would be removed with them, and the reset
  // would take it by accident rather than by decision.
  assert.match(SOURCE, /const PROGRESS_KEY = 'gpc:progress'/);
  const load = SOURCE.slice(SOURCE.indexOf('async loadPersisted()'), SOURCE.indexOf('  persist()'));
  assert.match(load, /PROGRESS_KEY/, 'and is read back on start-up');
});

test('there is still a way to forget it', () => {
  // Unresettable state is its own trap. The reset leaves it deliberately;
  // that is not the same as it being permanent.
  assert.equal(typeof Panel.prototype.forgetProgress, 'function');
  const body = SOURCE.slice(SOURCE.indexOf('async forgetProgress()'), SOURCE.indexOf('async forgetProgress()') + 400);
  assert.match(body, /storageRemove\(\[PROGRESS_KEY\]\)/);
});

/* ---------------------------------------------------------- the preset */

test('the mark is offered as a starting point', () => {
  const body = methodBody('buildSinceControl');
  assert.match(body, /this\.state\.progress\?\.oldestTs/);
  assert.match(body, /Carry on from \$\{formatDate\(reached\)\}/);
  assert.match(body, /s\.scanOlderThanTs = reached/, 'and pressing it sets the window');
});

test('the note says the mark outlives a reset', () => {
  // Otherwise the one preset that behaves differently from the others gives no
  // sign of it.
  const body = methodBody('buildSinceControl');
  assert.match(body, /Kept even if you reset/);
});

test('nothing is offered before a single run has happened', () => {
  const body = methodBody('buildSinceControl');
  assert.match(body, /if \(reached != null\)/);
});

test('the run records the mark, and says so', () => {
  const body = SOURCE.slice(SOURCE.indexOf('async doFullRun()'), SOURCE.indexOf('  abortAll() {'));
  assert.match(body, /await this\.noteProgress\(scanResult\.oldestHandled\)/);
  assert.match(body, /Reached back to/);
});
