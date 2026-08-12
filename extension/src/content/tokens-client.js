/**
 * The isolated-world half of the token bridge.
 *
 * `main-world.js` posts what it finds in `WIZ_global_data`; this listens, maps
 * the obfuscated keys through `readTokens`, and hands the result to whoever
 * asked. Callers never touch `postMessage` themselves.
 *
 * Two things make this more than a variable holding a message payload:
 *
 *   - the panel may load before the page has published anything, so `get()`
 *     asks and waits rather than returning nothing;
 *   - the request token is rotated on a long-lived tab, so a call that comes
 *     back "not signed in" can ask for a fresh copy with `refresh()` instead of
 *     making the user reload.
 */

import { readTokens, TOKENS_EVENT } from '../api/tokens.js';

/** Raised when the page never published usable credentials. */
export class TokenError extends Error {
  constructor(message, missing = []) {
    super(message);
    this.name = 'TokenError';
    this.missing = missing;
  }
}

let cached = null;      // last usable set
let lastMissing = [];   // what was absent, for the message
let listening = false;
let waiters = [];

function accept(raw) {
  const { tokens, missing, ok } = readTokens(raw);
  lastMissing = missing;
  if (!ok) return;
  cached = tokens;
  const pending = waiters;
  waiters = [];
  for (const resolve of pending) resolve(tokens);
}

function listen() {
  if (listening) return;
  listening = true;
  window.addEventListener('message', (event) => {
    // Only our own page, only our own message. Anything else on this origin is
    // Google's own traffic and has no business here.
    if (event.source !== window) return;
    if (event.data?.source !== TOKENS_EVENT) return;
    accept(event.data.raw);
  });
}

function ask() {
  window.postMessage({ source: `${TOKENS_EVENT}:request` }, window.location.origin);
}

/**
 * The credentials, waiting for them if they have not arrived yet.
 *
 * @param {{timeoutMs?: number, force?: boolean}} options
 *        `force` discards what we have and waits for a fresh copy — used after
 *        a call comes back unauthorised.
 */
export function getTokens({ timeoutMs = 8000, force = false } = {}) {
  listen();
  if (cached && !force) return Promise.resolve(cached);
  if (force) cached = null;

  return new Promise((resolve, reject) => {
    let done = false;
    const settle = (tokens) => {
      if (done) return;
      done = true;
      clearInterval(poll);
      clearTimeout(timer);
      resolve(tokens);
    };
    waiters.push(settle);

    // Asked repeatedly rather than once: the MAIN-world script may not be
    // running yet, and a single request into the void would simply be lost.
    ask();
    const poll = setInterval(ask, 300);

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      clearInterval(poll);
      waiters = waiters.filter((w) => w !== settle);
      reject(new TokenError(
        lastMissing.length
          ? `Google Photos did not publish ${lastMissing.join(', ')}. Reload the page while signed in.`
          : 'Could not read the Google Photos session. Reload the page while signed in.',
        lastMissing
      ));
    }, timeoutMs);
  });
}

/** Ask the page for a fresh set, e.g. after an expired request token. */
export function refreshTokens(options = {}) {
  return getTokens({ ...options, force: true });
}

/** Start listening early, so the first `getTokens` is usually instant. */
export function primeTokens() {
  listen();
  ask();
}
