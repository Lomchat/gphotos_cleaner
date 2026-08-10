/**
 * Analyzer refill loop.
 *
 * Continuous mode (analysis while listing runs) must keep three simple, easily
 * broken promises: never analyse the same item twice, never stop just because
 * the queue is momentarily empty, and stop for good once listing is finished
 * and the queue is drained.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { Analyzer } from '../src/content/analyze-client.js';

/**
 * Fake database reproducing the real contracts of `getPending` (only unanalysed
 * items, up to the requested limit) and `saveFeatures`.
 */
function fakeDb(initial = []) {
  const items = new Map(initial.map((it) => [it.id, { ...it, analyzed: 0 }]));
  return {
    items,
    add(list) {
      for (const it of list) if (!items.has(it.id)) items.set(it.id, { ...it, analyzed: 0 });
    },
    getPending: async (limit = Infinity) => {
      const out = [];
      for (const it of items.values()) {
        if (it.analyzed || !it.url) continue;
        out.push(it);
        if (out.length >= limit) break;
      }
      return out;
    },
    saveFeatures: async (results) => {
      for (const r of results) {
        const prev = items.get(r.id);
        if (prev) prev.analyzed = r.ok ? 1 : 0;
      }
    }
  };
}

const makeItems = (n, offset = 0) =>
  Array.from({ length: n }, (_, i) => ({ id: `p${i + offset}`, url: `https://x/${i + offset}` }));

/** Fake engine: succeeds at everything, recording what it received. */
function fakeEngine({ failIds = new Set(), throwOn = null } = {}) {
  const seen = [];
  return {
    seen,
    sendBatch: async (batch) => {
      if (throwOn && batch.some((b) => b.id === throwOn)) throw new Error('engine down');
      for (const b of batch) seen.push(b.id);
      return batch.map((b) => ({
        id: b.id,
        ok: !failIds.has(b.id),
        features: failIds.has(b.id) ? undefined : { v: 1 },
        error: failIds.has(b.id) ? 'simulated failure' : undefined
      }));
    }
  };
}

const noSleep = async () => {};

function analyzer(db, engine, opts = {}) {
  return new Analyzer({
    batchSize: 4,
    inflightBatches: 2,
    idleWaitMs: 0,
    ...opts,
    deps: { getPending: db.getPending, saveFeatures: db.saveFeatures, sendBatch: engine.sendBatch, sleep: noSleep }
  });
}

/* -------------------------------------------------------------- one-shot */

test('processes every pending item exactly once', async () => {
  const db = fakeDb(makeItems(30));
  const engine = fakeEngine();
  const res = await analyzer(db, engine).run();

  assert.equal(res.done, 30);
  assert.equal(res.failed, 0);
  assert.equal(engine.seen.length, 30, 'no item may be sent twice');
  assert.equal(new Set(engine.seen).size, 30);
});

test('never resends an already-analysed item', async () => {
  const db = fakeDb(makeItems(10));
  db.items.get('p0').analyzed = 1;
  db.items.get('p5').analyzed = 1;
  const engine = fakeEngine();
  await analyzer(db, engine).run();

  assert.ok(!engine.seen.includes('p0'));
  assert.ok(!engine.seen.includes('p5'));
  assert.equal(engine.seen.length, 8);
});

test('failures are counted and the item stays analysable later', async () => {
  const db = fakeDb(makeItems(8));
  const engine = fakeEngine({ failIds: new Set(['p3']) });
  const res = await analyzer(db, engine, { maxPerPass: 8 }).run();

  assert.equal(res.done, 7);
  assert.equal(res.failed, 1);
  assert.equal(db.items.get('p3').analyzed, 0, 'a failure must not mark the item as done');
});

test('maxPerPass bounds the work and leaves the rest alone', async () => {
  const db = fakeDb(makeItems(100));
  const engine = fakeEngine();
  const res = await analyzer(db, engine, { maxPerPass: 12 }).run();

  assert.equal(res.done, 12);
  assert.equal(engine.seen.length, 12);
  const remaining = [...db.items.values()].filter((i) => !i.analyzed).length;
  assert.equal(remaining, 88);
});

test('an engine failure stops the pass and surfaces the error', async () => {
  const db = fakeDb(makeItems(20));
  const engine = fakeEngine({ throwOn: 'p8' });
  await assert.rejects(() => analyzer(db, engine).run(), /engine down/);
});

/* ------------------------------------------------------------- continuous */

test('continuous mode waits for listing to produce new items', async () => {
  const db = fakeDb([]);           // queue empty at start
  const engine = fakeEngine();
  let scanning = true;
  let rounds = 0;

  const a = analyzer(db, engine);
  const run = a.run(() => {}, {
    waitForMore: () => {
      // Simulates a scan dropping items in waves.
      if (++rounds === 2) db.add(makeItems(6, 0));
      if (rounds === 5) db.add(makeItems(6, 100));
      if (rounds >= 8) scanning = false;
      return scanning;
    }
  });

  const res = await run;
  assert.equal(res.done, 12, 'both waves must be analysed');
  assert.equal(new Set(engine.seen).size, 12);
});

test('continuous mode stops once listing is done and the queue is empty', async () => {
  const db = fakeDb(makeItems(5));
  const engine = fakeEngine();
  const res = await analyzer(db, engine).run(() => {}, { waitForMore: () => false });

  assert.equal(res.done, 5);
  assert.equal(res.aborted, false);
});

test('one-shot mode does not loop on an empty queue', async () => {
  const db = fakeDb([]);
  const engine = fakeEngine();
  const res = await analyzer(db, engine).run();
  assert.equal(res.total, 0);
  assert.equal(engine.seen.length, 0);
});

test('abort is honoured even in continuous mode', async () => {
  const db = fakeDb(makeItems(200));
  const engine = fakeEngine();
  const a = analyzer(db, engine, { batchSize: 2, inflightBatches: 1 });

  let seen = 0;
  const res = await a.run(
    (st) => {
      seen = st.done;
      if (seen >= 4) a.abort();
    },
    { waitForMore: () => true } // listing never ends; only abort can stop it
  );

  assert.equal(res.aborted, true);
  assert.ok(res.done < 200, `aborted after ${res.done} items`);
  const remaining = [...db.items.values()].filter((i) => !i.analyzed).length;
  assert.ok(remaining > 0, 'remaining work must be kept for a resume');
});

/* ------------------------------------------------------------ concurrency */

test('setInflight takes effect on the next refill chunk', async () => {
  const db = fakeDb(makeItems(40));
  const engine = fakeEngine();
  const a = analyzer(db, engine, { batchSize: 4, inflightBatches: 1 });

  a.setInflight(4);
  assert.equal(a.opts.inflightBatches, 4);
  a.setInflight(0);
  assert.equal(a.opts.inflightBatches, 1, 'concurrency cannot drop to zero');

  const res = await a.run();
  assert.equal(res.done, 40);
});

test('two successive passes split the work without overlap', async () => {
  // Reproduces real usage: a bounded pass, then a resume.
  const db = fakeDb(makeItems(50));
  const engine = fakeEngine();

  const r1 = await analyzer(db, engine, { maxPerPass: 20 }).run();
  const r2 = await analyzer(db, engine, { maxPerPass: 20 }).run();
  const r3 = await analyzer(db, engine, { maxPerPass: 20 }).run();

  assert.equal(r1.done, 20);
  assert.equal(r2.done, 20);
  assert.equal(r3.done, 10, 'the last pass only finds the remainder');
  assert.equal(new Set(engine.seen).size, 50, 'no item analysed twice');
});

/* ------------------------------------------------------------ timing seam */

test('the worker reports where each photo spent its time', () => {
  // "The analysis is slow" cannot be answered without this, and guessing has
  // been wrong twice: the phases respond to completely different fixes.
  const source = readFileSync(new URL('../src/analysis/worker.js', import.meta.url), 'utf8');
  for (const phase of ['fetch', 'decode', 'features', 'detect']) {
    assert.ok(source.includes(`lap('${phase}')`), `${phase} is not timed`);
  }
  assert.match(source, /_spent: clock\.spent/, 'the timing must ride back with the features');
});

test('the detection image is not drawn twice when it would be identical', () => {
  // draw() never upscales, so below both caps the two draws produce the same
  // pixels — a second canvas and a second getImageData for nothing.
  const source = readFileSync(new URL('../src/analysis/worker.js', import.meta.url), 'utf8');
  assert.match(source, /Math\.max\(natW, natH\) <= Math\.min\(ANALYSIS_SIDE, DETECT_SIDE\)/);
});

test('the timing never reaches the catalogue', () => {
  // It is diagnostics, not a measurement of the photo. Persisting it would put
  // a stopwatch reading into every row.
  const source = readFileSync(new URL('../src/offscreen/offscreen.js', import.meta.url), 'utf8');
  assert.match(source, /delete features\._spent/,
    'the offscreen document must strip the timing before saving');
});
