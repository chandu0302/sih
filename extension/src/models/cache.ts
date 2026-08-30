/**
 * SIH 26171 — model weight cache (IndexedDB).
 *
 * Model weights are megabytes. Without this, every side-panel open re-fetches
 * them; with it, the download happens once per profile.
 *
 * THE GOVERNING RULE: a cache failure must never break inference.
 *
 * Every function here degrades instead of throwing — getCachedModel() resolves
 * to null (meaning "just download it"), cacheModel() resolves regardless. The
 * failure modes are real and not exotic: IndexedDB is unavailable in some
 * private-browsing modes, the origin's quota can be exhausted by a few large
 * models, a blocked upgrade leaves open() hanging forever, and a corrupted
 * store throws on read. Every one of those should cost a re-download, not a
 * dead feature. This is why nothing here rejects.
 */

const DB_NAME = 'sih-models';
const DB_VERSION = 1;
const STORE = 'weights';

/**
 * open() fires neither onsuccess nor onerror when an upgrade is blocked by
 * another tab holding an older version. Without a timeout the returned promise
 * never settles and the caller's `await` hangs forever — the whole panel
 * appears frozen with no error anywhere. Bound it.
 */
const OPEN_TIMEOUT_MS = 3000;

function indexedDbFactory(): IDBFactory | undefined {
  // `typeof` rather than a truthiness check: in a service worker or a test
  // running under the node environment the identifier is simply not defined,
  // and referencing it directly is a ReferenceError, not undefined.
  if (typeof indexedDB === 'undefined') return undefined;
  return indexedDB;
}

/** Resolves to null rather than rejecting when the DB cannot be opened. */
function openDb(): Promise<IDBDatabase | null> {
  const factory = indexedDbFactory();
  if (!factory) return Promise.resolve(null);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (db: IDBDatabase | null) => {
      if (settled) return;
      settled = true;
      resolve(db);
    };

    const timer = setTimeout(() => {
      console.warn('[SIH] model cache: IndexedDB open timed out; skipping cache');
      finish(null);
    }, OPEN_TIMEOUT_MS);

    const settleWith = (db: IDBDatabase | null) => {
      clearTimeout(timer);
      finish(db);
    };

    try {
      const request = factory.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE)) {
          // Keyed by URL: the model's identity for caching purposes is where
          // it came from, so a re-pointed spec.url misses rather than serving
          // stale weights under the same logical model id.
          db.createObjectStore(STORE);
        }
      };

      request.onsuccess = () => settleWith(request.result);
      request.onerror = () => {
        console.warn('[SIH] model cache: IndexedDB unavailable', request.error);
        settleWith(null);
      };
      request.onblocked = () => {
        console.warn('[SIH] model cache: IndexedDB upgrade blocked by another context');
        settleWith(null);
      };
    } catch (err) {
      // Some privacy modes throw synchronously from open().
      console.warn('[SIH] model cache: IndexedDB open threw', err);
      settleWith(null);
    }
  });
}

/**
 * Read cached weights for a URL.
 *
 * Returns null on a miss AND on every failure — the caller cannot distinguish
 * them, and should not need to: both mean "download it".
 */
export async function getCachedModel(url: string): Promise<ArrayBuffer | null> {
  const db = await openDb();
  if (!db) return null;

  try {
    return await new Promise<ArrayBuffer | null>((resolve) => {
      const tx = db.transaction(STORE, 'readonly');
      const request = tx.objectStore(STORE).get(url);

      request.onsuccess = () => {
        const value: unknown = request.result;
        // Guard the type: a corrupted or older-format entry must not be
        // handed to the ONNX runtime as if it were weights.
        resolve(value instanceof ArrayBuffer ? value : null);
      };
      request.onerror = () => {
        console.warn('[SIH] model cache: read failed', request.error);
        resolve(null);
      };
      tx.onabort = () => resolve(null);
    });
  } catch (err) {
    console.warn('[SIH] model cache: read threw', err);
    return null;
  } finally {
    db.close();
  }
}

/**
 * Store weights for a URL. Never throws; a failure just means the next load
 * re-downloads.
 *
 * QuotaExceededError is the expected failure here — a few models at several MB
 * each can exhaust a constrained origin quota. It surfaces on the transaction's
 * onabort, not always on the request, so both are handled.
 */
export async function cacheModel(url: string, buf: ArrayBuffer): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');

      tx.oncomplete = () => resolve();
      tx.onabort = () => {
        // Quota exhaustion lands here.
        console.warn('[SIH] model cache: write aborted (quota?)', tx.error);
        resolve();
      };
      tx.onerror = () => {
        console.warn('[SIH] model cache: write failed', tx.error);
        resolve();
      };

      tx.objectStore(STORE).put(buf, url);
    });
  } catch (err) {
    console.warn('[SIH] model cache: write threw', err);
  } finally {
    db.close();
  }
}

/** Drop every cached model. For a diagnostics button or a corrupted store. */
export async function clearModelCache(): Promise<void> {
  const db = await openDb();
  if (!db) return;

  try {
    await new Promise<void>((resolve) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.oncomplete = () => resolve();
      tx.onabort = () => resolve();
      tx.onerror = () => resolve();
      tx.objectStore(STORE).clear();
    });
  } catch {
    // Nothing to do; clearing is best-effort by construction.
  } finally {
    db.close();
  }
}
