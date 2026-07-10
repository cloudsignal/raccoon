import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@raccoon/protocol';
import { closeDbForTests } from './idb.js';
import * as outbox from './outbox.js';

afterEach(async () => { await closeDbForTests(); });

const msg = (text: string) => createEnvelope('msg', {
  from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text },
});
const TAB = 'test-tab-1';
const FROM = 'user:u1';
const SCOPE = 'ws://x/::user:u1';

describe('outbox', () => {
  it('enqueues pending entries and lists them oldest-first', async () => {
    const a = await outbox.enqueue(msg('one'), SCOPE);
    const b = await outbox.enqueue(msg('two'), SCOPE);
    const pending = await outbox.listPending();
    expect(pending.map((e) => e.id)).toEqual([a.id, b.id]);
    expect(pending[0]!.status).toBe('pending');
    expect(pending[0]!.channel).toBe('coordinator');
  });

  it('listPending falls back to id when two entries share the same createdAt, and does not throw', async () => {
    // See outbox.ts's byCreatedAt comment: the old comparator violated
    // Array.prototype.sort's contract for a tie (returned 1, never 0). No
    // observable misordering was pinned down from this specifically, but
    // exercise the tie path so it stays well-defined going forward.
    const first = await outbox.enqueue({ ...msg('first, lower id'), id: 'a-lower' }, SCOPE);
    await outbox.enqueue({ ...msg('second, higher id'), id: 'b-higher', ts: first.createdAt }, SCOPE);
    const pending = await outbox.listPending();
    expect(pending.map((e) => e.id)).toEqual(['a-lower', 'b-higher']);
  });

  it('settle deletes on ack', async () => {
    const e = await outbox.enqueue(msg('x'), SCOPE);
    await outbox.settle(e.id);
    expect(await outbox.listPending()).toHaveLength(0);
  });

  it('markSending → markSendFailed cycles back to pending until MAX_ATTEMPTS', async () => {
    const e = await outbox.enqueue(msg('x'), SCOPE);
    for (let i = 1; i < outbox.MAX_ATTEMPTS; i += 1) {
      const token = await outbox.markSending(e.id, TAB, SCOPE);
      await outbox.markSendFailed(e.id, 'offline', token!);
      expect((await outbox.listPending())).toHaveLength(1);
    }
    const token = await outbox.markSending(e.id, TAB, SCOPE);
    await outbox.markSendFailed(e.id, 'offline', token!);
    expect(await outbox.listPending()).toHaveLength(0);
    const all = await outbox.listForChannel('coordinator');
    expect(all[0]!.status).toBe('failed');
    expect(all[0]!.lastError).toBe('offline');
  });

  it('markFailed hard-fails; retry resets to pending', async () => {
    const e = await outbox.enqueue(msg('x'), SCOPE);
    const token = await outbox.markSending(e.id, TAB, SCOPE);
    await outbox.markFailed(e.id, 'no ack', token!);
    expect((await outbox.listForChannel('coordinator'))[0]!.status).toBe('failed');
    await outbox.retry(e.id);
    const entry = (await outbox.listPending())[0]!;
    expect(entry.status).toBe('pending');
    expect(entry.attempts).toBe(0);
  });

  it('demoteSending returns in-flight entries to pending', async () => {
    const e = await outbox.enqueue(msg('x'), SCOPE);
    await outbox.markSending(e.id, TAB, SCOPE);
    expect(await outbox.listPending()).toHaveLength(0);
    await outbox.demoteSending(TAB);
    expect(await outbox.listPending()).toHaveLength(1);
  });

  it('markSending is a pending-only compare-and-set: only the first of two racing tabs claims the row (#R4-4)', async () => {
    const e = await outbox.enqueue(msg('x'), SCOPE);
    // Two tabs both saw the row as 'pending' in their own listPending()
    // snapshot and both call markSending() for it.
    const claimedByTabA = await outbox.markSending(e.id, 'tab-a', SCOPE);
    const claimedByTabB = await outbox.markSending(e.id, 'tab-b', SCOPE);
    expect(claimedByTabA).toBeTruthy();
    expect(claimedByTabB).toBeNull(); // already 'sending' by the time tab-b's CAS runs
    const entry = (await outbox.listForChannel('coordinator'))[0]!;
    expect(entry.status).toBe('sending');
    expect(entry.attempts).toBe(1); // NOT incremented twice
  });

  it('markSending refuses to claim a row enqueued under a different identity scope (#R5-3)', async () => {
    // A stale tab still running as user:other enqueued this row after another
    // tab wiped/re-paired. The current tab must NEVER claim — and therefore
    // never send — a row written under a different identity, no matter how
    // it survived into the store.
    const foreign = createEnvelope('msg', {
      from: 'user:other', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'not yours' },
    });
    const e = await outbox.enqueue(foreign, 'ws://x/::user:other');
    const token = await outbox.markSending(e.id, TAB, SCOPE); // SCOPE is u1's
    expect(token).toBeNull();
    const entry = (await outbox.listForChannel('coordinator'))[0]!;
    expect(entry.status).toBe('pending'); // untouched
    expect(entry.attempts).toBe(0);
  });

  it('markSending refuses a same-userId row from a DIFFERENT instance (#R6-3)', async () => {
    // User ids are instance-local: instance A's u1 and instance B's u1 are
    // different people. env.from alone ('user:u1' both times) cannot tell
    // them apart — only the persisted full scope (url + user) can. A stale
    // row queued against instance A must never transmit through a session
    // paired to instance B.
    const e = await outbox.enqueue(msg('meant for instance A'), 'wss://instance-a/::user:u1');
    const token = await outbox.markSending(e.id, TAB, 'wss://instance-b/::user:u1');
    expect(token).toBeNull();
    expect((await outbox.listForChannel('coordinator'))[0]!.status).toBe('pending');
    // The matching scope still claims it.
    expect(await outbox.markSending(e.id, TAB, 'wss://instance-a/::user:u1')).toBeTruthy();
  });

  it('markFailed reports whether it applied, so a stale timeout cannot drive UI state (#R6-7)', async () => {
    const e = await outbox.enqueue(msg('x'), SCOPE);
    const token = await outbox.markSending(e.id, TAB, SCOPE);
    expect(await outbox.markFailed(e.id, 'no ack', 'stale-token')).toBe(false); // no-op AND says so
    expect(await outbox.markFailed(e.id, 'no ack', token!)).toBe(true);
  });

  it('retry() only revives a terminally-failed row — never a live claim (#R6-7)', async () => {
    // A stale tab's "Tap to retry" (shown off its own stale failure) must
    // not reset a row another tab is actively sending back to 'pending',
    // which would queue a duplicate transmission.
    const e = await outbox.enqueue(msg('x'), SCOPE);
    const token = await outbox.markSending(e.id, TAB, SCOPE);
    expect(await outbox.retry(e.id)).toBe(false);
    expect((await outbox.listForChannel('coordinator'))[0]!.status).toBe('sending'); // untouched
    await outbox.markFailed(e.id, 'no ack', token!);
    expect(await outbox.retry(e.id)).toBe(true);
    expect((await outbox.listPending())[0]!.status).toBe('pending');
  });

  it('a successful claim broadcasts its lease expiry so other tabs can schedule recovery (#R6-5)', async () => {
    // A tab that claims a row and then crashes leaves nothing behind to
    // trigger another tab's sweep — boot-time and close-time sweeps have
    // both already run. The claim broadcast is what lets every OTHER tab
    // schedule a look at exactly the moment this claim's lease lapses.
    const received: Array<{ type: string; leaseExpiresAt: number }> = [];
    const bc = new BroadcastChannel('raccoon-outbox');
    bc.addEventListener('message', (ev) => received.push((ev as MessageEvent).data));
    try {
      const e = await outbox.enqueue(msg('x'), SCOPE);
      await outbox.markSending(e.id, TAB, SCOPE);
      await new Promise((r) => setTimeout(r, 20)); // BC delivery is async
      expect(received).toHaveLength(1);
      expect(received[0]!.type).toBe('claimed');
      const entry = (await outbox.listForChannel('coordinator'))[0]!;
      expect(received[0]!.leaseExpiresAt).toBe(entry.leaseExpiresAt);
    } finally {
      bc.close();
    }
  });

  it('a stale owner\'s failure/timeout writes cannot touch a row re-claimed by a newer owner (#R5-5)', async () => {
    const e = await outbox.enqueue(msg('x'), SCOPE);
    // Tab A claims, then hangs; its lease expires; the row is demoted and
    // re-claimed by tab B.
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - outbox.SEND_LEASE_MS - 1000);
    const tokenA = await outbox.markSending(e.id, 'tab-a', SCOPE);
    dateNowSpy.mockRestore();
    await outbox.demoteSending('tab-b'); // expired lease → requeued
    const tokenB = await outbox.markSending(e.id, 'tab-b', SCOPE);
    expect(tokenA).toBeTruthy();
    expect(tokenB).toBeTruthy();
    expect(tokenB).not.toBe(tokenA);

    // Tab A's long-delayed ack-timeout fires with its STALE claim: must not
    // flip tab B's live in-flight row to 'failed'.
    await outbox.markFailed(e.id, 'no ack', tokenA!);
    let entry = (await outbox.listForChannel('coordinator'))[0]!;
    expect(entry.status).toBe('sending');

    // Tab A's long-delayed send rejection likewise must not demote it back
    // to 'pending' (which would queue a THIRD transmission).
    await outbox.markSendFailed(e.id, 'send failed', tokenA!);
    entry = (await outbox.listForChannel('coordinator'))[0]!;
    expect(entry.status).toBe('sending');

    // The CURRENT owner's writes still apply.
    await outbox.markFailed(e.id, 'no ack', tokenB!);
    entry = (await outbox.listForChannel('coordinator'))[0]!;
    expect(entry.status).toBe('failed');
  });

  it('demoteSending does not reclaim another tab\'s row whose lease has not expired (#R4-4)', async () => {
    const e = await outbox.enqueue(msg('x'), SCOPE);
    await outbox.markSending(e.id, 'tab-a', SCOPE); // fresh, non-expired lease
    await outbox.demoteSending('tab-b'); // a DIFFERENT tab's boot-time (or close-triggered) call
    // Still 'sending', owned by tab-a — tab-b must not have touched it.
    expect(await outbox.listPending()).toEqual([]);
    const entry = (await outbox.listForChannel('coordinator'))[0]!;
    expect(entry.status).toBe('sending');
  });

  it('demoteSending reclaims another tab\'s row once its lease has expired (crashed-tab recovery)', async () => {
    const e = await outbox.enqueue(msg('x'), SCOPE);
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - outbox.SEND_LEASE_MS - 1000);
    await outbox.markSending(e.id, 'crashed-tab', SCOPE); // backdated: already-expired lease
    dateNowSpy.mockRestore();
    await outbox.demoteSending('tab-b');
    expect(await outbox.listPending()).toHaveLength(1);
  });

  it('demoteSending always reclaims its OWN tab\'s row, lease or no lease (same-tab close)', async () => {
    const e = await outbox.enqueue(msg('x'), SCOPE);
    await outbox.markSending(e.id, 'tab-a', SCOPE); // fresh lease, owned by tab-a
    await outbox.demoteSending('tab-a'); // tab-a's own transport closed — must reclaim immediately
    expect(await outbox.listPending()).toHaveLength(1);
  });

  it('demoteSending reports the earliest still-valid foreign lease expiry so the caller can re-check then (#R5-4)', async () => {
    // A crashed tab's still-unexpired lease is (correctly) skipped — but the
    // caller must learn WHEN to look again, or a boot-time demote that ran
    // seconds after the crash leaves the row 'sending' forever on a stable
    // connection (nothing else ever calls demoteSending again).
    const e = await outbox.enqueue(msg('x'), SCOPE);
    await outbox.markSending(e.id, 'crashed-tab', SCOPE); // fresh lease from another tab
    const entry = (await outbox.listForChannel('coordinator'))[0]!;

    const nextExpiry = await outbox.demoteSending('tab-b');
    expect(nextExpiry).toBe(entry.leaseExpiresAt); // skipped row's expiry, to reschedule against
    expect(await outbox.listPending()).toEqual([]); // and it was indeed skipped, not requeued

    // Nothing skipped → nothing to re-check.
    await outbox.demoteSending('crashed-tab'); // own-tab reclaim
    expect(await outbox.demoteSending('tab-b')).toBeNull();
  });

  it('clearAll is serialized against a concurrent demoteSending so no row is resurrected (#R2-1)', async () => {
    // Seed many 'sending' entries so demoteSending()'s per-entry put() loop
    // spans several IDB transactions, giving a real interleaving window.
    const entries = await Promise.all(Array.from({ length: 20 }, (_, i) => outbox.enqueue(msg(`m${i}`), SCOPE)));
    for (const e of entries) await outbox.markSending(e.id, TAB, SCOPE);

    // Fire demoteSending() WITHOUT awaiting (mirrors the transport's 'closed'
    // status callback: void outbox.demoteSending(tabId)), then immediately clear —
    // mirrors wipeAndReset() racing that callback.
    const demote = outbox.demoteSending(TAB);
    await outbox.clearAll();
    await demote;

    // Whichever fired first, the serialization queue guarantees clearAll's
    // clear() cannot land in the middle of demoteSending()'s writes: no row
    // survives.
    expect(await outbox.listPending()).toEqual([]);
    expect(await outbox.listForChannel('coordinator')).toEqual([]);
  });

  it('clearAll is serialized against EVERY mutator, not only demoteSending (#R2-1 follow-up)', async () => {
    // A third-party review proved by execution that the original fix only
    // serialized demoteSending()/clearAll(): a markSending() call (fired from
    // an in-flight drain()'s attempt()) racing a concurrent clearAll() (fired
    // from unpair()'s wipe) still resurrected a row. Exercise each remaining
    // mutator the same way: fire it unawaited, then immediately clearAll(),
    // and confirm no row survives regardless of interleaving.
    const mutators: Array<(id: string) => Promise<unknown>> = [
      (id) => outbox.markSending(id, TAB, SCOPE),
      (id) => outbox.markSendFailed(id, 'offline', 'any-token'),
      (id) => outbox.markFailed(id, 'no ack', 'any-token'),
      (id) => outbox.retry(id),
    ];
    for (const mutate of mutators) {
      const e = await outbox.enqueue(msg('x'), SCOPE);
      const op = mutate(e.id);
      await outbox.clearAll();
      await op;
      expect(await outbox.listForChannel('coordinator')).toEqual([]);
    }
  });

  it('every mutator is exactly ONE IndexedDB transaction, the property cross-tab safety depends on (#R3-5)', async () => {
    // The fix's cross-tab guarantee rests on a spec-level fact, not anything
    // this codebase implements: IndexedDB serializes 'readwrite' transactions
    // with overlapping store scopes IN THE ORDER THEY WERE CREATED, across
    // ALL connections to a database — including connections opened by
    // different browser tabs, since a database's storage is shared per
    // origin, not per tab. (A module-local promise queue like the old
    // opChain, by contrast, only orders calls within ONE tab's JS realm —
    // reproduced 25/25 by a third-party review racing a second tab's own
    // connection against it.) That spec guarantee only helps if each mutator
    // is a SINGLE transaction: a get-then-put split across TWO transactions
    // still has a gap between them for another connection's transaction to
    // land in, no matter how strictly each individual transaction is
    // serialized. So the property to verify here is structural: every
    // mutator opens exactly one transaction, with no way for anything else
    // to interleave inside it.
    const seeded = await outbox.enqueue(msg('x'), SCOPE);
    // Patch the PROTOTYPE, not a specific connection instance: outbox.ts
    // mutates through its own internal connection (idb.ts's module-scope
    // dbPromise), which this test has no handle to. Patching the prototype
    // intercepts .transaction() calls from any IDBDatabase instance.
    const originalTransaction = IDBDatabase.prototype.transaction;
    let count = 0;
    IDBDatabase.prototype.transaction = function (this: IDBDatabase, ...args: Parameters<typeof originalTransaction>) {
      count += 1;
      return originalTransaction.apply(this, args);
    } as typeof IDBDatabase.prototype.transaction;
    try {
      count = 0;
      const token = await outbox.markSending(seeded.id, TAB, SCOPE);
      expect(count).toBe(1);

      count = 0;
      await outbox.markSendFailed(seeded.id, 'offline', token!);
      expect(count).toBe(1);

      count = 0;
      await outbox.retry(seeded.id);
      expect(count).toBe(1);

      count = 0;
      await outbox.settle(seeded.id);
      expect(count).toBe(1);

      count = 0;
      await outbox.clearAll();
      expect(count).toBe(1);
    } finally {
      IDBDatabase.prototype.transaction = originalTransaction;
    }
  });

  it('notifies subscribers with the touched channel', async () => {
    const touched: string[] = [];
    const unsub = outbox.subscribe((c) => touched.push(c));
    const e = await outbox.enqueue(msg('x'), SCOPE);
    await outbox.settle(e.id);
    unsub();
    expect(touched).toEqual(['coordinator', 'coordinator']);
  });
});
