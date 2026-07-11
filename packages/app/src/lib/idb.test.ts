import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDb, closeDbForTests, kvGet, __setBlockedTimeoutMsForTests } from './idb.js';

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

  it('a blocked open (a peer holds a handler-less older connection) rejects within the bound instead of pending forever (#R10)', async () => {
    __setBlockedTimeoutMsForTests(50); // real short bound, so no fake-timer/setImmediate fragility
    let held: IDBDatabase | undefined;
    try {
      // Emulate the OLD v1 bundle: a raw v1 connection with NO onversionchange
      // handler — it will NEVER yield to a newer-version open.
      held = await new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open('raccoon-app', 1);
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
      // compiled DB_VERSION=2 → blocked by the held v1 conn; must REJECT within
      // the bound rather than pend forever.
      await expect(openDb()).rejects.toThrow(/blocked/);
      // Cache was reset by the rejection: with the blocker gone, a fresh open works.
      held.close();
      held = undefined;
      await expect(openDb()).resolves.toBeDefined();
    } finally {
      __setBlockedTimeoutMsForTests(10_000);
      held?.close();
    }
  });

  it('a synchronous indexedDB.open throw rejects and does not poison the cache (#R10)', async () => {
    const spy = vi.spyOn(indexedDB, 'open').mockImplementationOnce(() => { throw new Error('open blew up'); });
    await expect(openDb()).rejects.toThrow('open blew up');
    spy.mockRestore();
    // The cache was nulled on the synchronous throw → the next call reopens cleanly.
    await expect(openDb()).resolves.toBeDefined();
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
