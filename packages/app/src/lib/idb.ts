const DB_NAME = 'raccoon-app';
// v2 (#R8-1): added the 'approvals' store — a durable, identity-scoped record
// of approval REQUESTS so a reload can re-render the approval card (server
// history carries the request only as text, with no way to reconstruct the
// interactive card).
const DB_VERSION = 2;

type StoreName = 'kv' | 'outbox' | 'approvals';

let dbPromise: Promise<IDBDatabase> | null = null;

export function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('kv')) db.createObjectStore('kv');
      if (!db.objectStoreNames.contains('outbox')) {
        const outbox = db.createObjectStore('outbox', { keyPath: 'id' });
        outbox.createIndex('channel', 'channel');
      }
      if (!db.objectStoreNames.contains('approvals')) {
        const approvals = db.createObjectStore('approvals', { keyPath: 'key' });
        approvals.createIndex('channel', 'channel');
      }
    };
    // #P1-D: a multi-tab PWA schema upgrade must not hang. Without these
    // handlers, a tab holding an older-version connection blocks a newer tab's
    // open indefinitely, and every await openDb() (i.e. every kvGet/withStore)
    // wedges. `blocked` is transient — do NOT reject (onsuccess still fires
    // once the other tab yields); just surface it so a genuine hang is
    // diagnosable.
    req.onblocked = () => {
      console.warn('[idb] open blocked: another tab is holding an older DB version open');
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onversionchange = () => {
        // A newer tab needs to upgrade the schema — yield so it isn't blocked,
        // and drop the cached connection so the next openDb() reconnects at
        // the new version (a transaction on this now-closed db would throw).
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      // #P1-D (adv): do NOT leave a rejected promise cached. A tab superseded by
      // a higher DB version reopens at its (now lower) compiled DB_VERSION and
      // gets a VersionError here; caching that rejection would make EVERY later
      // kvGet/withStore reject forever off the same cached promise. Nulling lets
      // the next call re-attempt (it still fails until the tab reloads to newer
      // code, but it is not permanently poisoned, and a normal transient error
      // can recover).
      dbPromise = null;
      reject(req.error);
    };
  });
  return dbPromise;
}

export async function withStore<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const request = fn(tx.objectStore(store));
    let result: T | undefined;
    if (request) request.onsuccess = () => { result = request.result; };
    tx.oncomplete = () => resolve(result as T);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Run `fn` against a single IndexedDB transaction that stays open across
 * multiple chained requests (e.g. a get followed by a put computed from its
 * result), instead of `withStore`'s one-request-per-call. Requests issued
 * from `fn` via `await promisifyRequest(...)` keep the transaction alive
 * (modern IndexedDB tolerates microtask-spaced requests within one
 * transaction; it does not require same-tick synchronous issuance).
 *
 * This is the primitive that makes a get-then-put sequence ATOMIC as one
 * transaction rather than two separate ones — the actual fix for the outbox
 * cross-tab race (see outbox.ts): IndexedDB serializes 'readwrite'
 * transactions with overlapping store scopes, INCLUDING across different
 * browser tabs sharing the same origin's database (it's a single shared
 * storage engine, not a per-tab one). Two transactions can still interleave
 * with a third transaction landing between them; ONE transaction cannot be
 * interleaved by anything.
 */
export function withTransaction<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  fn: (s: IDBObjectStore) => Promise<T>,
): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result: T;
    let ran = false;
    fn(tx.objectStore(store))
      .then((r) => { result = r; ran = true; })
      .catch((err) => {
        reject(err);
        try { tx.abort(); } catch { /* transaction may already be finishing */ }
      });
    tx.oncomplete = () => { if (ran) resolve(result); };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  }));
}

/**
 * Like withTransaction but spanning MULTIPLE stores in ONE transaction (#P1-E2)
 * — `fn` receives the raw IDBTransaction and reads each store via
 * tx.objectStore(name). Used to make a cross-store cleanup atomic: e.g.
 * deleting an approval REQUEST (approvals store) and settling its response row
 * (outbox store) together, so a crash between them can't leave an unanswered
 * approval with no response record. Same keep-alive/abort semantics as
 * withTransaction.
 */
export function withStores<T>(
  stores: StoreName[],
  mode: IDBTransactionMode,
  fn: (tx: IDBTransaction) => Promise<T>,
): Promise<T> {
  return openDb().then((db) => new Promise<T>((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    let result: T;
    let ran = false;
    fn(tx)
      .then((r) => { result = r; ran = true; })
      .catch((err) => {
        reject(err);
        try { tx.abort(); } catch { /* transaction may already be finishing */ }
      });
    tx.oncomplete = () => { if (ran) resolve(result); };
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
  }));
}

export function kvGet<T>(key: string): Promise<T | undefined> {
  return withStore<T | undefined>('kv', 'readonly', (s) => s.get(key) as IDBRequest<T | undefined>);
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  await withStore('kv', 'readwrite', (s) => { s.put(value, key); });
}

export async function kvDel(key: string): Promise<void> {
  await withStore('kv', 'readwrite', (s) => { s.delete(key); });
}

/**
 * ATOMIC read-modify-write of one kv key in a SINGLE transaction (#R8-4).
 * `fn(current)` returns the next value (or undefined to leave unchanged).
 * Because IDB serializes 'readwrite' transactions on a store across ALL tabs,
 * two concurrent kvUpdate() calls run one-after-another — so e.g. a lazy
 * epoch mint converges: the first writes the epoch, the second sees it and
 * leaves it. Returns the resulting stored value.
 */
export function kvUpdate<T>(key: string, fn: (current: T | undefined) => T | undefined): Promise<T | undefined> {
  return withTransaction<T | undefined>('kv', 'readwrite', async (s) => {
    const current = await promisifyRequest(s.get(key) as IDBRequest<T | undefined>);
    const next = fn(current);
    if (next !== undefined) await promisifyRequest(s.put(next, key));
    return next !== undefined ? next : current;
  });
}

/**
 * ATOMIC compare-and-delete of one kv key in a SINGLE transaction (#R8-4):
 * delete only if `predicate(currentValue)` holds. Returns whether it deleted.
 * The read and the delete cannot interleave, so a value re-saved between them
 * (e.g. a newer session written by a concurrent re-pair) is NOT deleted.
 */
export function kvDeleteIf<T>(key: string, predicate: (value: T) => boolean): Promise<boolean> {
  return withTransaction<boolean>('kv', 'readwrite', async (s) => {
    const current = await promisifyRequest(s.get(key) as IDBRequest<T | undefined>);
    if (current === undefined || !predicate(current)) return false;
    await promisifyRequest(s.delete(key));
    return true;
  });
}

/**
 * Clear every kv key EXCEPT `session` (#R8-4). Used by a wipe that has
 * already compare-and-cleared the session key itself — so it can drop read
 * markers / the push flag without risking deletion of a session a concurrent
 * re-pair may have written since.
 */
export async function wipeKvExceptSession(): Promise<void> {
  await withTransaction('kv', 'readwrite', async (s) => {
    const keys = await promisifyRequest(s.getAllKeys() as IDBRequest<IDBValidKey[]>);
    for (const k of keys) {
      if (k !== 'session') await promisifyRequest(s.delete(k));
    }
  });
}

/**
 * Wipe the `kv` store (session, read markers, push-enabled flag). Used on
 * unpair / terminal auth-error so that pairing the device as a different user
 * cannot inherit the prior user's session or read state.
 *
 * Does NOT clear the outbox — that must go through `outbox.clearAll()`, which
 * is serialized against `outbox.demoteSending()` (a transport-status-driven
 * write that a plain `withStore('outbox', ...).clear()` call here could race:
 * demoteSending() snapshots then rewrites rows across several transactions, so
 * an unserialized clear can land between two of its writes and have a stale
 * row resurrected back into the store afterward). Callers should wipe BOTH
 * via `wipeAndReset()` in the app's transport layer, not this function alone.
 */
export async function wipeLocal(): Promise<void> {
  await withStore('kv', 'readwrite', (s) => { s.clear(); });
}

export async function closeDbForTests(): Promise<void> {
  if (dbPromise) {
    const db = await dbPromise.catch(() => null);
    db?.close();
    dbPromise = null;
  }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}
