/**
 * Zooming the page out while the scanner lists items.
 *
 * Google Photos renders exactly the tiles that fit the viewport and nothing
 * beyond it — measured on a real library: zero tiles below the fold. Zooming
 * out multiplies the viewport in CSS pixels, so one screen holds several times
 * more tiles and the scanner makes proportionally fewer stops. Each stop costs
 * a fixed settle wait, which is the dominant cost of listing, so fewer stops is
 * the whole point.
 *
 * CSS `zoom` on the page does not work here, and it is worth writing down why:
 * it enlarges the scroll container (measured 775px to 3340px) but leaves
 * `window.innerHeight` untouched, and Google Photos sizes its virtual window
 * from the window, not from the container. The tile count did not move. Only
 * real browser zoom changes what the page believes its viewport to be.
 */

/**
 * 25% is not a choice, it is Chrome's floor.
 *
 * The browser's zoom range is 25% to 500%, and `chrome.tabs.setZoom` clamps to
 * it — asking for 10% silently gives 25%. So there is no "more zoomed out" to
 * offer past this, whatever the grid could theoretically hold.
 */
export const MIN_FACTOR = 0.25;

/**
 * The number is the page's scale, so *smaller* means more thumbnails per
 * screen: 25% fits roughly sixteen times the area of 100%. Anything above 100%
 * would fit fewer, which is the opposite of the point.
 *
 * The smallest step Chrome allows: about sixteen times the tiles per screen,
 * so the scan makes roughly a sixteenth of the stops. Each stop costs a settle
 * wait whatever it holds, which is what makes listing slow.
 *
 * This is only safe now that a stop waits for the images it can actually see,
 * with a budget that grows with how many are missing. Before that, more tiles
 * per screen simply meant more of them harvested before their image arrived.
 */
export const DEFAULT_FACTOR = 0.25;

// Chrome's own preset steps, so the browser applies exactly what was asked for
// rather than snapping to a neighbour.
export const ZOOM_STEPS = [
  { factor: 1, label: '100%' },
  { factor: 0.75, label: '75%' },
  { factor: 0.5, label: '50%' },
  { factor: 0.33, label: '33%' },
  { factor: 0.25, label: '25%' }
];

/**
 * Apply a zoom factor to this tab.
 *
 * @returns {Promise<number|null>} the factor actually applied, or null if the
 *   browser refused — the caller carries on at normal zoom rather than failing
 *   a run over a display preference.
 */
export async function setZoom(factor, send = chrome.runtime.sendMessage) {
  const clamped = Math.min(1, Math.max(MIN_FACTOR, Number(factor) || 1));
  try {
    const res = await send({ type: 'SET_ZOOM', factor: clamped });
    return res?.ok ? (res.factor ?? clamped) : null;
  } catch {
    return null;
  }
}

/**
 * Keep the panel legible while the page shrinks.
 *
 * Browser zoom scales everything in the tab, our panel included, and a control
 * surface at a third of its size is unusable exactly when someone wants to
 * watch progress or press stop. Counter-scaling the host restores its apparent
 * size; the page behind it stays zoomed out, which is the point.
 */
export function counterScale(host, factor) {
  if (!host) return;
  if (!factor || factor >= 1) {
    host.style.zoom = '';
    return;
  }
  host.style.zoom = String(1 / factor);
}

/**
 * Run `work` with the page zoomed out, and put the zoom back whatever happens.
 *
 * The restore lives in `finally` and also on `pagehide`: a run interrupted by a
 * reload or a crash must not leave someone's library at 33% with no idea why.
 */
export async function withZoom(factor, { host, send, work }) {
  if (!factor || factor >= 1) return { applied: null, result: await work() };

  const applied = await setZoom(factor, send);
  if (applied == null) return { applied: null, result: await work() };

  counterScale(host, applied);
  const restore = () => { setZoom(1, send); counterScale(host, 1); };

  // Guarded rather than assumed: the restore has to work whether or not there
  // is a window to hang it on, and the rule this module exists to keep is that
  // the zoom always goes back.
  const view = typeof window === 'undefined' ? null : window;
  view?.addEventListener('pagehide', restore, { once: true });

  try {
    return { applied, result: await work() };
  } finally {
    view?.removeEventListener('pagehide', restore);
    restore();
  }
}
