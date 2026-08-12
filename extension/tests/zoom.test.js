/**
 * Zooming the page out while listing.
 *
 * The rule that matters is the boring one: whatever happens, the zoom goes
 * back. Leaving somebody's library at a third of its size, with no memory of
 * having asked for it, would be a worse failure than the slow scan this is
 * meant to fix.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  setZoom, counterScale, withZoom, ZOOM_STEPS, MIN_FACTOR, DEFAULT_FACTOR
} from '../src/content/zoom.js';

/** Minimal host stand-in: only `style.zoom` is ever touched. */
function host() {
  return { style: { zoom: '' } };
}

function sender(reply = { ok: true }) {
  const calls = [];
  const send = async (msg) => { calls.push(msg); return typeof reply === 'function' ? reply(msg) : reply; };
  send.calls = calls;
  return send;
}

/* ------------------------------------------------------------- the steps */

test('the offered steps start at "leave it alone"', () => {
  assert.equal(ZOOM_STEPS[0].factor, 1);
});

test('no step goes below the readable floor', () => {
  for (const step of ZOOM_STEPS) {
    assert.ok(step.factor >= MIN_FACTOR, `${step.factor} is below ${MIN_FACTOR}`);
    assert.ok(step.factor <= 1);
    assert.ok(step.label);
  }
});

test('the default is a step that is actually offered', () => {
  assert.ok(ZOOM_STEPS.some((s) => s.factor === DEFAULT_FACTOR));
});

/* -------------------------------------------------------------- setZoom */

test('the factor is passed to the background', async () => {
  const send = sender();
  await setZoom(0.33, send);
  assert.deepEqual(send.calls, [{ type: 'SET_ZOOM', factor: 0.33 }]);
});

test('an absurd factor is clamped rather than obeyed', async () => {
  const send = sender();
  await setZoom(0.01, send);
  assert.equal(send.calls[0].factor, MIN_FACTOR);
  await setZoom(9, send);
  assert.equal(send.calls[1].factor, 1);
});

test('a refusal is reported as null, not thrown', async () => {
  // A browser that will not zoom is a reason to carry on at normal size, never
  // a reason to fail a run that takes minutes.
  assert.equal(await setZoom(0.5, sender({ ok: false, error: 'no tab' })), null);
});

test('a messaging failure is also just null', async () => {
  const send = async () => { throw new Error('port closed'); };
  assert.equal(await setZoom(0.5, send), null);
});

/* --------------------------------------------------------- counter-scale */

test('the panel is scaled back up by the inverse', () => {
  const h = host();
  counterScale(h, 0.25);
  assert.equal(h.style.zoom, '4');
});

test('at normal zoom the panel carries no scaling at all', () => {
  const h = host();
  counterScale(h, 0.5);
  counterScale(h, 1);
  assert.equal(h.style.zoom, '');
});

test('a missing host is not an error', () => {
  assert.doesNotThrow(() => counterScale(null, 0.5));
});

/* -------------------------------------------------------------- withZoom */

test('the zoom is restored when the work finishes', async () => {
  const send = sender();
  const h = host();
  await withZoom(0.33, { host: h, send, work: async () => 'done' });
  assert.equal(send.calls.at(-1).factor, 1);
  assert.equal(h.style.zoom, '');
});

test('the zoom is restored when the work throws', async () => {
  // The case that matters: a run that dies halfway must not leave the library
  // shrunk with no explanation.
  const send = sender();
  const h = host();
  await assert.rejects(() => withZoom(0.33, {
    host: h, send, work: async () => { throw new Error('scan failed'); }
  }));
  assert.equal(send.calls.at(-1).factor, 1);
  assert.equal(h.style.zoom, '');
});

test('the work still runs when the browser refuses to zoom', async () => {
  const send = sender({ ok: false });
  let ran = false;
  const out = await withZoom(0.33, { host: host(), send, work: async () => { ran = true; return 7; } });
  assert.equal(ran, true);
  assert.equal(out.result, 7);
  assert.equal(out.applied, null);
});

test('a factor of 1 touches nothing', async () => {
  const send = sender();
  const h = host();
  const out = await withZoom(1, { host: h, send, work: async () => 'x' });
  assert.equal(send.calls.length, 0, 'no zoom request should be made');
  assert.equal(h.style.zoom, '');
  assert.equal(out.applied, null);
});

test('the work result is passed through', async () => {
  const out = await withZoom(0.5, { host: host(), send: sender(), work: async () => ({ discovered: 12 }) });
  assert.deepEqual(out.result, { discovered: 12 });
});

test('the panel is counter-scaled while the work runs', async () => {
  const h = host();
  let during = null;
  await withZoom(0.25, {
    host: h,
    send: sender({ ok: true, factor: 0.25 }),
    work: async () => { during = h.style.zoom; }
  });
  assert.equal(during, '4', 'the panel must stay legible during the run');
  assert.equal(h.style.zoom, '', 'and go back afterwards');
});

test('the factor the browser actually applied is the one compensated for', async () => {
  // Chrome may snap to its own zoom steps; scaling by what we asked for rather
  // than what we got would leave the panel subtly the wrong size.
  const h = host();
  await withZoom(0.33, {
    host: h,
    send: sender({ ok: true, factor: 0.5 }),
    work: async () => { assert.equal(h.style.zoom, '2'); }
  });
});

/* -------------------------------------------------- the shape of the scale */

test('the steps run downwards: smaller page, more thumbnails', () => {
  // The number is the page's scale, not a quantity of anything. A step above
  // 100% would fit fewer thumbnails, which is the opposite of the point.
  const factors = ZOOM_STEPS.map((s) => s.factor);
  assert.deepEqual(factors, [...factors].sort((a, b) => b - a), 'steps must descend');
  assert.equal(Math.max(...factors), 1, 'nothing above 100%: that fits fewer');
});

test('the smallest step is the browser floor, not a taste', () => {
  // Chrome's zoom range is 25%–500% and setZoom clamps to it, so offering 10%
  // would silently give 25% and lie about what it did.
  assert.equal(Math.min(...ZOOM_STEPS.map((s) => s.factor)), MIN_FACTOR);
  assert.equal(MIN_FACTOR, 0.25);
});

test('every step is one Chrome already has', () => {
  // Asking for a value between Chrome's presets makes it snap to a neighbour,
  // so the panel would be counter-scaling by a factor the page is not using.
  const chromePresets = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1];
  for (const { factor } of ZOOM_STEPS) {
    assert.ok(chromePresets.includes(factor), `${factor} is not a Chrome zoom step`);
  }
});

test('the default is a step that is actually offered', () => {
  assert.ok(ZOOM_STEPS.some((s) => s.factor === DEFAULT_FACTOR));
});

test('the default never asks for less than Chrome can give', () => {
  assert.ok(DEFAULT_FACTOR >= MIN_FACTOR);
  assert.ok(DEFAULT_FACTOR <= 1);
});

test('the neutral step is labelled by its size, not as an absence', () => {
  // "Off" left the direction of the other numbers to be guessed at.
  assert.equal(ZOOM_STEPS.find((s) => s.factor === 1).label, '100%');
});

test('an ask below the floor is clamped, never silently obeyed', async () => {
  const send = sender();
  await setZoom(0.05, send);
  assert.equal(send.calls[0].factor, MIN_FACTOR);
});
