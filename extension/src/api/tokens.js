/**
 * The credentials `batchexecute` needs, and how they reach us.
 *
 * Google Photos keeps them in `window.WIZ_global_data`, which lives in the
 * page's own JavaScript world. A content script runs in an isolated world and
 * cannot see it — the object simply is not there. So a second content script is
 * injected into the MAIN world, reads the values, and posts them across the
 * boundary. That is the whole reason `src/page/main-world.js` exists, and why
 * it lives outside `src/content/`: everything in there is web-accessible, and
 * the file that reads the session tokens must not be.
 *
 * Field names are Google's obfuscated keys. They are recorded here rather than
 * inlined at the call site because when they change — and one day they will —
 * this is the file to look at, and the names mean nothing without the mapping.
 *
 * Adapted from Google-Photos-Toolkit (xob0t), MIT.
 */

/** Obfuscated key in WIZ_global_data -> what the API calls it. */
export const TOKEN_KEYS = {
  SNlM0e: 'at',      // request token, sent in the body of every call
  FdrFJe: 'sid',     // session id
  cfb2h: 'bl',       // backend release label
  eptZe: 'path',     // base path, e.g. "/" or "/u/1/"
  oPEP7c: 'account', // which signed-in account this page belongs to
  Dbw5Ud: 'rapt'     // present only for the locked folder
};

export const REQUIRED = ['at', 'sid', 'bl'];

/**
 * Pull the tokens out of a WIZ_global_data object.
 *
 * Kept pure so it can be tested without a page: the extraction is trivial, but
 * a silent rename on Google's side turns every later call into a 400 with no
 * clue why, and `missing` is what makes that legible.
 */
export function readTokens(globalData) {
  const out = {};
  if (globalData && typeof globalData === 'object') {
    for (const [key, name] of Object.entries(TOKEN_KEYS)) {
      const value = globalData[key];
      if (typeof value === 'string' && value) out[name] = value;
    }
  }
  // The path is a prefix like "/u/1/"; an empty one means the default account.
  if (typeof out.path !== 'string') out.path = '/';
  if (!out.path.endsWith('/')) out.path += '/';
  const missing = REQUIRED.filter((name) => !out[name]);
  return { tokens: out, missing, ok: missing.length === 0 };
}

/** Message name used across the world boundary and the extension. */
export const TOKENS_EVENT = 'gpc:tokens';
