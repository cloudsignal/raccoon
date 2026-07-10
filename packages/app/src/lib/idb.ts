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
 * Wipe all local, identity-scoped state: the entire `kv` store (session, read
 * markers, push-enabled flag) AND the `outbox`. Used on unpair / terminal
 * auth-error so that pairing the device as a different user cannot inherit the
 * prior user's session, read state, or queued-but-unsent messages.
 */
export async function wipeLocal(): Promise<void> {
  await withStore('kv', 'readwrite', (s) => { s.clear(); });
  await withStore('outbox', 'readwrite', (s) => { s.clear(); });
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
