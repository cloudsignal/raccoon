import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { openDb, closeDbForTests, kvGet } from './idb.js';

afterEach(async () => { await closeDbForTests(); });

describe('idb multi-tab upgrade coordination (#P1-D)', () => {
  it('yields to a newer-version open from another tab (onversionchange closes our connection)', async () => {
    // "Tab A": our app connection, opened via the code under test.
    const dbA = await openDb();
    const name = dbA.name;
    const nextVer = dbA.version + 1; // simulate the NEXT schema bump from another tab

    // "Tab B": a newer-version open. If dbA registered onversionchange→close,
    // this proceeds; without the fix it fires 'blocked' and never succeeds.
    const outcome = await new Promise<{ blocked: boolean }>((resolve, reject) => {
      const r = indexedDB.open(name, nextVer);
      let blocked = false;
      r.onblocked = () => { blocked = true; };
      r.onupgradeneeded = () => { /* empty upgrade is fine */ };
      r.onsuccess = () => { r.result.close(); resolve({ blocked }); };
      r.onerror = () => reject(r.error);
    });

    expect(outcome.blocked).toBe(false);
  });

  it('drops the cached connection on versionchange so the next open does not hand out a closed db', async () => {
    const dbA = await openDb();
    // Cache is live: a second openDb returns the SAME instance.
    expect(await openDb()).toBe(dbA);

    // A real newer tab opens a higher version — this fires dbA.onversionchange,
    // whose handler must close dbA AND null the cache.
    const bumped = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open(dbA.name, dbA.version + 1);
      r.onupgradeneeded = () => { /* empty */ };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });

    // The cache must be cleared: a subsequent openDb() must NOT return the now
    // stale, CLOSED dbA. With the reset it issues a fresh open (which here
    // rejects VersionError because v+1 is committed — a superseded tab must
    // reload); WITHOUT the reset it would resolve to the closed dbA and any
    // .transaction() on it would throw InvalidStateError.
    let reopened: IDBDatabase | null = null;
    try { reopened = await openDb(); } catch { reopened = null; }
    expect(reopened).not.toBe(dbA);

    bumped.close();
  });

  it('does not cache a rejected open — a superseded VersionError re-attempts on the next call (#P1-D adv)', async () => {
    const dbA = await openDb();
    const name = dbA.name;
    const higher = dbA.version + 1;
    // Commit a higher version (and close it), so our compiled-DB_VERSION open
    // becomes a downgrade that errors. onversionchange closed dbA + nulled the
    // cache already.
    await new Promise<void>((res, rej) => {
      const r = indexedDB.open(name, higher);
      r.onupgradeneeded = () => { /* empty */ };
      r.onsuccess = () => { r.result.close(); res(); };
      r.onerror = () => rej(r.error);
    });

    const a = openDb();
    await a.catch(() => { /* expected VersionError */ });
    // The rejected open must NOT stay cached: the next call is a FRESH attempt
    // (distinct promise), not the poisoned rejection returned forever.
    const b = openDb();
    expect(b).not.toBe(a);
    await b.catch(() => {});
  });
});
