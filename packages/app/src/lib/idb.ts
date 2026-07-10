const DB_NAME = 'raccoon-app';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
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
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function withStore<T>(
  store: 'kv' | 'outbox',
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
  store: 'kv' | 'outbox',
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
