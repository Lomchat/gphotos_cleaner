/**
 * Talking to Google Photos' internal `batchexecute` endpoint.
 *
 * This is the same transport the web app uses on itself: a POST carrying one
 * or more RPC calls, each identified by an obfuscated id, with arguments as a
 * JSON string nested inside another JSON string. Nothing about it is
 * documented, and Google can change it without notice — which is exactly why
 * the wire format lives in one small file with the shape written down, rather
 * than smeared across the call sites.
 *
 * Adapted from Google-Photos-Toolkit (xob0t), MIT.
 *
 * The envelope, for when it breaks:
 *
 *   POST <path>data/batchexecute?rpcids=<id>&f.sid=<sid>&bl=<bl>&pageId=none&rt=c
 *   body: f.req=<urlencoded [[[ id, "<json args>", null, "generic" ]]]>&at=<token>
 *
 *   response: )]}'\n\n[["wrb.fr","<id>","<json result>",...]]
 *
 * The `)]}'` prefix is anti-JSON-hijacking padding; the useful line is the one
 * containing `wrb.fr`, and the payload is a JSON string inside that array.
 */

/** Thrown for anything the caller might reasonably act on. */
export class ApiError extends Error {
  constructor(message, { status = 0, kind = 'http', rpcid = null } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind; // 'http' | 'auth' | 'shape' | 'network'
    this.rpcid = rpcid;
  }
}

/**
 * Build the query string that identifies the call and the session.
 *
 * `pageId=none` is a constant, not an oversight: pagination happens inside the
 * request body, and this parameter means something else entirely. Sending a
 * cursor here does nothing and hides the fact that the real one was forgotten.
 */
export function buildQuery(rpcid, tokens, { sourcePath = null } = {}) {
  const params = new URLSearchParams({
    rpcids: rpcid,
    'source-path': sourcePath || tokens.path || '/',
    'f.sid': tokens.sid,
    bl: tokens.bl,
    pageId: 'none',
    // "c" asks for the compact, single-shot response rather than a stream.
    rt: 'c'
  });
  // Present only inside the locked folder, and required there.
  if (tokens.rapt) params.set('rapt', tokens.rapt);
  return params.toString();
}

/** Build the form body. `at` authorises the call; without it Google answers 400. */
export function buildBody(rpcid, args, tokens) {
  const envelope = [[[rpcid, JSON.stringify(args), null, 'generic']]];
  return `f.req=${encodeURIComponent(JSON.stringify(envelope))}&at=${encodeURIComponent(tokens.at)}&`;
}

/**
 * Pull the payload out of a batchexecute response.
 *
 * Split out and pure because this is where a change on Google's side will show
 * up first, and because the failure modes are worth telling apart: a login page
 * instead of a payload is a different problem from a renamed field.
 */
export function parseEnvelope(text, rpcid) {
  if (typeof text !== 'string' || !text) {
    throw new ApiError('empty response', { kind: 'shape', rpcid });
  }
  if (/^\s*<!doctype html/i.test(text) || /^\s*<html/i.test(text)) {
    throw new ApiError('got a web page instead of data — the session may have expired', {
      kind: 'auth', rpcid
    });
  }

  const line = text.split('\n').find((l) => l.includes('wrb.fr'));
  if (!line) {
    throw new ApiError('no wrb.fr frame in the response', { kind: 'shape', rpcid });
  }

  let frames;
  try {
    frames = JSON.parse(line);
  } catch {
    throw new ApiError('the wrb.fr frame was not JSON', { kind: 'shape', rpcid });
  }

  // A frame is ["wrb.fr", rpcid, "<payload json>", ...]. With one rpcid per
  // call there is normally one frame, but pick by id rather than by position:
  // Google interleaves its own calls when it feels like it.
  const frame = frames.find?.((f) => Array.isArray(f) && f[0] === 'wrb.fr' && (!rpcid || f[1] === rpcid))
    ?? frames.find?.((f) => Array.isArray(f) && f[0] === 'wrb.fr');
  if (!frame) throw new ApiError('no frame for this call', { kind: 'shape', rpcid });

  const payload = frame[2];
  // A null payload is a legitimate "nothing here", not a failure: an empty
  // page at the end of the library comes back this way.
  if (payload == null) return null;
  try {
    return JSON.parse(payload);
  } catch {
    throw new ApiError('the payload was not JSON', { kind: 'shape', rpcid });
  }
}

/**
 * One call.
 *
 * `fetchImpl` is injectable so the transport can be exercised without a
 * browser; everything above it is pure, so the only thing a test cannot reach
 * is the request itself.
 */
export async function call(rpcid, args, tokens, {
  sourcePath = null,
  fetchImpl = globalThis.fetch,
  signal = null
} = {}) {
  if (!tokens?.at || !tokens?.sid || !tokens?.bl) {
    throw new ApiError('not signed in, or the page has not published its tokens yet', {
      kind: 'auth', rpcid
    });
  }

  const query = buildQuery(rpcid, tokens, { sourcePath });
  const url = `https://photos.google.com${tokens.path || '/'}data/batchexecute?${query}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      credentials: 'include',
      signal,
      headers: { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8' },
      body: buildBody(rpcid, args, tokens)
    });
  } catch (err) {
    if (signal?.aborted) throw new ApiError('cancelled', { kind: 'network', rpcid });
    throw new ApiError(`could not reach Google Photos (${err?.message || err})`, {
      kind: 'network', rpcid
    });
  }

  if (!response.ok) {
    throw new ApiError(`HTTP ${response.status}`, {
      status: response.status,
      kind: response.status === 401 || response.status === 403 ? 'auth' : 'http',
      rpcid
    });
  }

  return parseEnvelope(await response.text(), rpcid);
}
