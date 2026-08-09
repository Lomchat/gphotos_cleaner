/**
 * IndexedDB persistence.
 *
 * The catalogue can reach tens of thousands of entries, which rules out
 * `chrome.storage` (quota, and whole-blob JSON serialisation on every write).
 * The database lives on the photos.google.com origin, so analysis survives page
 * reloads.
 */

const DB_NAME = 'gp-cleaner';
const DB_VERSION = 1;
const STORE_ITEMS = 'items';
const STORE_META = 'meta';

let dbPromise = null;

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_ITEMS)) {
        const store = db.createObjectStore(STORE_ITEMS, { keyPath: 'id' });
        store.createIndex('ts', 'ts');
        store.createIndex('analyzed', 'analyzed');
      }
      if (!db.objectStoreNames.contains(STORE_META)) {
        db.createObjectStore(STORE_META, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(store, mode) {
  return open().then((db) => db.transaction(store, mode).objectStore(store));
}

function wrap(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Insert or update tiles found by the scanner. Existing analysis fields are
 * preserved, so re-scanning never destroys work already done.
 */
export async function upsertItems(items) {
  if (!items.length) return { added: 0, updated: 0 };
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_ITEMS, 'readwrite');
    const store = t.objectStore(STORE_ITEMS);
    let added = 0;
    let updated = 0;
    for (const item of items) {
      const get = store.get(item.id);
      get.onsuccess = () => {
        const prev = get.result;
        if (prev) {
          updated++;
          store.put({
            ...prev,
            ...item,
            // Never overwrite a known date with a missing one.
            ts: item.ts ?? prev.ts,
            precision: item.precision ?? prev.precision,
            features: prev.features,
            analyzed: prev.analyzed,
            analysisError: prev.analysisError
          });
        } else {
          added++;
          store.put({ ...item, analyzed: 0, features: null, analysisError: null });
        }
      };
    }
    t.oncomplete = () => resolve({ added, updated });
    t.onerror = () => reject(t.error);
  });
}

export async function saveFeatures(results) {
  if (!results.length) return;
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_ITEMS, 'readwrite');
    const store = t.objectStore(STORE_ITEMS);
    for (const r of results) {
      const get = store.get(r.id);
      get.onsuccess = () => {
        const prev = get.result;
        if (!prev) return;
        store.put({
          ...prev,
          analyzed: r.ok ? 1 : 0,
          features: r.ok ? r.features : prev.features,
          analysisError: r.ok ? null : r.error || 'failed'
        });
      };
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getAll() {
  const store = await tx(STORE_ITEMS, 'readonly');
  return wrap(store.getAll());
}

export async function countAll() {
  const store = await tx(STORE_ITEMS, 'readonly');
  return wrap(store.count());
}

/**
 * Ids only. The scanner uses this to know what it already has without loading
 * the whole catalogue: at 50,000 entries `getAll` moves tens of megabytes for a
 * simple membership test.
 */
export async function getAllIds() {
  const store = await tx(STORE_ITEMS, 'readonly');
  return wrap(store.getAllKeys());
}

/**
 * Tiles found but not yet analysed.
 *
 * Walks the `analyzed` index with a cursor instead of loading everything: when
 * 49,000 of 50,000 entries are already done, reading all of them to keep 1,000
 * moves megabytes for nothing. The cursor also stops at the limit.
 */
export async function getPending(limit = Infinity) {
  const store = await tx(STORE_ITEMS, 'readonly');
  return new Promise((resolve, reject) => {
    const out = [];
    const req = store.index('analyzed').openCursor(IDBKeyRange.only(0));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor || out.length >= limit) return resolve(out);
      // No thumbnail URL means nothing to analyse; don't re-queue it.
      if (cursor.value.url) out.push(cursor.value);
      if (out.length >= limit) return resolve(out);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Ids of recorded items whose thumbnail URL is missing.
 *
 * Repairs a catalogue built while URL extraction was failing: without this
 * those items stay forever unanalysable, since the scanner treats them as known
 * and never re-reads them.
 */
export async function getIdsMissingThumb() {
  const store = await tx(STORE_ITEMS, 'readonly');
  return new Promise((resolve, reject) => {
    const out = new Set();
    const req = store.index('analyzed').openCursor(IDBKeyRange.only(0));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(out);
      if (!cursor.value.url) out.add(cursor.value.id);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * Items without a thumbnail still eligible for targeted repair.
 *
 * The attempt counter is essential: some items will never have a preview (video
 * still processing, unsupported format). Without it every run would fish them
 * out again and the work would never finish.
 */
export async function getItemsMissingThumb(maxAttempts = 3) {
  const store = await tx(STORE_ITEMS, 'readonly');
  return new Promise((resolve, reject) => {
    const out = [];
    const req = store.index('analyzed').openCursor(IDBKeyRange.only(0));
    req.onsuccess = () => {
      const cursor = req.result;
      if (!cursor) return resolve(out);
      const v = cursor.value;
      if (!v.url && (v.thumbAttempts || 0) < maxAttempts) out.push(v);
      cursor.continue();
    };
    req.onerror = () => reject(req.error);
  });
}

export async function markIds(ids, patch) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_ITEMS, 'readwrite');
    const store = t.objectStore(STORE_ITEMS);
    for (const id of ids) {
      const get = store.get(id);
      get.onsuccess = () => {
        if (get.result) store.put({ ...get.result, ...patch });
      };
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function clearAll() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const t = db.transaction([STORE_ITEMS, STORE_META], 'readwrite');
    t.objectStore(STORE_ITEMS).clear();
    t.objectStore(STORE_META).clear();
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
  });
}

export async function getMeta(key, fallback = null) {
  const store = await tx(STORE_META, 'readonly');
  const row = await wrap(store.get(key));
  return row ? row.value : fallback;
}

export async function setMeta(key, value) {
  const store = await tx(STORE_META, 'readwrite');
  return wrap(store.put({ key, value }));
}
