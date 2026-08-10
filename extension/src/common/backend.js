/**
 * Client for the optional local backend.
 *
 * The extension is fully usable without it. Everything here is written so that
 * a backend which is absent, stopped mid-run, or misconfigured degrades to "no
 * people data" rather than to a broken panel — a failed request must never lose
 * a scan the user has already paid for in time.
 *
 * Thumbnail URLs are sent rather than pixels: the CDN is reachable from the
 * machine anyway, and a batch of 200 URLs is a few kilobytes against ~5 MB of
 * base64.
 */

export const DEFAULT_BACKEND = {
  enabled: false,
  url: 'http://127.0.0.1:8765',
  token: '',
  // Larger than the 176px the in-browser analysis uses. There, transfer is the
  // dominant cost; here the backend fetches from Google itself and spends ~38ms
  // per photo on inference, so bytes are free by comparison.
  //
  // It buys margin where it matters. Measured on a photo of seven strangers,
  // the closest pair of different people sits at:
  //   176px (faces 9-13px)  0.670
  //   512px (faces 28-35px) 0.804
  // Both clear the 0.55 grouping threshold, but 176px clears it by 0.12 and
  // 512px by 0.25 — and a group that merges two people is the failure that
  // gets someone else's photos deleted.
  thumbSize: 512
};

export const BATCH_SIZE = 100;
const HEALTH_TIMEOUT = 2500;
const ANALYSE_TIMEOUT = 180000;

export class BackendError extends Error {
  constructor(message, { status = 0, kind = 'network' } = {}) {
    super(message);
    this.name = 'BackendError';
    this.status = status;
    this.kind = kind; // 'network' | 'auth' | 'model' | 'http'
  }
}

/** Trim a trailing slash so `${base}/health` never becomes `//health`. */
export function normaliseUrl(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function classify(status) {
  if (status === 401) return 'auth';
  if (status === 503) return 'model';
  return 'http';
}

async function request(config, path, { method = 'GET', body, timeout = 15000 } = {}) {
  const base = normaliseUrl(config.url);
  if (!base) throw new BackendError('no backend URL set', { kind: 'http' });

  // AbortController rather than Promise.race: a hung request must actually be
  // released, otherwise a stalled backend leaks a socket per batch.
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), timeout);
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      signal: abort.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(config.token ? { 'X-Cleaner-Token': config.token } : {})
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    throw new BackendError(
      abort.signal.aborted ? 'backend did not answer in time' : 'backend unreachable',
      { kind: 'network' }
    );
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    let detail = `HTTP ${response.status}`;
    try {
      const payload = await response.json();
      if (payload?.detail) detail = String(payload.detail);
    } catch { /* a non-JSON error body is still an error */ }
    throw new BackendError(detail, { status: response.status, kind: classify(response.status) });
  }
  return response.json();
}

/**
 * Is the backend there, and does the token work?
 *
 * /health needs no token so the server can be found first; the token is then
 * probed separately, which is what lets the panel say "running, wrong token"
 * instead of the useless "unavailable".
 */
export async function checkHealth(config) {
  const health = await request(config, '/health', { timeout: HEALTH_TIMEOUT });
  let authOk = true;
  if (health.authRequired) {
    try {
      await request(config, '/known', { method: 'POST', body: { photoIds: [] }, timeout: HEALTH_TIMEOUT });
    } catch (err) {
      if (err.kind !== 'auth') throw err;
      authOk = false;
    }
  }
  return { ...health, authOk };
}

/** Which of these ids the backend has already analysed. */
export async function known(config, photoIds) {
  if (!photoIds.length) return new Set();
  const found = new Set();
  for (let i = 0; i < photoIds.length; i += 500) {
    const res = await request(config, '/known', {
      method: 'POST',
      body: { photoIds: photoIds.slice(i, i + 500) }
    });
    for (const id of res.known) found.add(id);
  }
  return found;
}

/**
 * Send items in batches, reporting progress as each one lands.
 *
 * One failing batch does not abort the rest: on a library of 20k photos a
 * single transient error would otherwise throw away everything analysed so far.
 */
export async function analyse(config, items, {
  onBatch, signal, batchSize = BATCH_SIZE, fetchData
} = {}) {
  const totals = { analysed: 0, failed: 0, skipped: 0, batches: 0, retried: 0, errors: [] };

  for (let i = 0; i < items.length; i += batchSize) {
    if (signal?.aborted) break;
    const slice = items.slice(i, i + batchSize);
    try {
      let res = await request(config, '/analyse', {
        method: 'POST',
        body: { items: slice.map(({ photoId, url }) => ({ photoId, url })) },
        timeout: ANALYSE_TIMEOUT
      });

      // The backend fetches thumbnails itself, which is far cheaper than
      // shipping pixels. But it does so without the browser's session, so a URL
      // the page can read may still be refused server-side. Rather than declare
      // the whole feature broken, resend just those photos as bytes — the
      // extension is already allowed to read them.
      if (fetchData && res.failed.length) {
        const retry = await withData(res.failed, slice, fetchData);
        if (retry.length) {
          const second = await request(config, '/analyse', {
            method: 'POST', body: { items: retry, force: true }, timeout: ANALYSE_TIMEOUT
          });
          totals.retried += second.analysed.length;
          res = {
            ...res,
            analysed: res.analysed.concat(second.analysed),
            failed: second.failed
          };
        }
      }

      totals.analysed += res.analysed.length;
      totals.failed += res.failed.length;
      totals.skipped += res.skipped.length;
      totals.batches += 1;
      onBatch?.({ ...res, done: Math.min(i + batchSize, items.length), total: items.length });
    } catch (err) {
      totals.errors.push(err.message);
      // A bad token or a missing model will not fix itself on the next batch.
      if (err.kind === 'auth' || err.kind === 'model') break;
    }
  }
  return totals;
}

/** Re-fetch failed photos in the page and package them as base64. */
async function withData(failed, slice, fetchData) {
  const byId = new Map(slice.map((it) => [it.photoId, it]));
  const out = [];
  for (const { photoId } of failed) {
    const source = byId.get(photoId);
    if (!source) continue;
    try {
      const data = await fetchData(source);
      if (data) out.push({ photoId, data });
    } catch { /* a photo that cannot be read either way is simply left out */ }
  }
  return out;
}

export async function group(config, { incremental = true, eps = 0.55 } = {}) {
  return request(config, '/group', {
    method: 'POST',
    body: { incremental, eps },
    timeout: 120000
  });
}

export async function listGroups(config) {
  const res = await request(config, '/groups');
  return res.groups;
}

export async function groupPhotos(config, groupId) {
  const res = await request(config, `/groups/${groupId}/photos`);
  return res.photoIds;
}

export async function renameGroup(config, groupId, name) {
  return request(config, `/groups/${groupId}/name`, { method: 'POST', body: { name } });
}

export async function clearBackend(config) {
  return request(config, '/data', { method: 'DELETE' });
}

/**
 * Turn "photo ids per group" into "group ids per photo", which is what the
 * filters need. Photos absent from every group stay absent from the map, so
 * "not analysed" stays distinguishable from "nobody in it".
 */
export function invertGroups(groupsWithPhotos) {
  const byPhoto = new Map();
  for (const { id, photoIds } of groupsWithPhotos) {
    for (const photoId of photoIds) {
      if (!byPhoto.has(photoId)) byPhoto.set(photoId, []);
      byPhoto.get(photoId).push(id);
    }
  }
  for (const list of byPhoto.values()) list.sort((a, b) => a - b);
  return byPhoto;
}

/** A short label for a group, named or not. */
export function groupLabel(group) {
  return group.name || `Person ${group.id + 1}`;
}
