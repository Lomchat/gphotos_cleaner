/**
 * Local storage for a downloaded model.
 *
 * The recognition model is 13 MB and cannot live in the repository: InsightFace
 * weights are for non-commercial research use, and this project is MIT. So it
 * is fetched once, on an explicit action, and kept here — in the extension's
 * own IndexedDB, not the page's, so it survives across sites and reloads.
 *
 * `chrome.storage` is not an option: it serialises to JSON, which would turn
 * 13 MB of binary into ~35 MB of text on every read.
 */

const DB_NAME = 'gp-cleaner-models';
const DB_VERSION = 1;
const STORE = 'models';

export function openModelCache() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'key' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export async function readModel(db, key) {
  const row = await wrap(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
  return row ? row.bytes : null;
}

export async function writeModel(db, key, bytes, meta = {}) {
  const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
  return wrap(store.put({ key, bytes, savedAt: Date.now(), ...meta }));
}

export async function hasModel(db, key) {
  const row = await wrap(db.transaction(STORE, 'readonly').objectStore(STORE).get(key));
  return !!row && row.bytes?.byteLength > 0;
}

export async function deleteModel(db, key) {
  return wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(key));
}

/**
 * Decide whether a downloaded blob is really the model.
 *
 * A captive portal, a rate limit or a moved file all answer 200 with an HTML
 * page. Writing that to the cache would give a permanent, confusing failure —
 * the download "succeeds" and the session then refuses to start, every time,
 * with no way for the user to tell why.
 */
export function looksLikeOnnx(bytes, expectedBytes = 0) {
  if (!bytes || bytes.byteLength < 1024) return false;
  if (expectedBytes && Math.abs(bytes.byteLength - expectedBytes) > expectedBytes * 0.25) {
    return false;
  }
  // ONNX files are protobuf; the first field is ir_version, tag 0x08.
  const head = new Uint8Array(bytes, 0, 16);
  if (head[0] !== 0x08) return false;
  // "<!DOCTYPE" / "<html" would start with 0x3c.
  return head[0] !== 0x3c;
}
