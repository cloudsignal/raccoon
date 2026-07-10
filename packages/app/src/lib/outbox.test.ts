import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@raccoon/protocol';
import { closeDbForTests } from './idb.js';
import * as outbox from './outbox.js';

afterEach(async () => { await closeDbForTests(); });

const msg = (text: string) => createEnvelope('msg', {
  from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text },
});

describe('outbox', () => {
  it('enqueues pending entries and lists them oldest-first', async () => {
    const a = await outbox.enqueue(msg('one'));
    const b = await outbox.enqueue(msg('two'));
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
    const first = await outbox.enqueue({ ...msg('first, lower id'), id: 'a-lower' });
    await outbox.enqueue({ ...msg('second, higher id'), id: 'b-higher', ts: first.createdAt });
    const pending = await outbox.listPending();
    expect(pending.map((e) => e.id)).toEqual(['a-lower', 'b-higher']);
  });

  it('settle deletes on ack', async () => {
    const e = await outbox.enqueue(msg('x'));
    await outbox.settle(e.id);
    expect(await outbox.listPending()).toHaveLength(0);
  });

  it('markSending → markSendFailed cycles back to pending until MAX_ATTEMPTS', async () => {
    const e = await outbox.enqueue(msg('x'));
    for (let i = 1; i < outbox.MAX_ATTEMPTS; i += 1) {
      await outbox.markSending(e.id);
      await outbox.markSendFailed(e.id, 'offline');
      expect((await outbox.listPending())).toHaveLength(1);
    }
    await outbox.markSending(e.id);
    await outbox.markSendFailed(e.id, 'offline');
    expect(await outbox.listPending()).toHaveLength(0);
    const all = await outbox.listForChannel('coordinator');
    expect(all[0]!.status).toBe('failed');
    expect(all[0]!.lastError).toBe('offline');
  });

  it('markFailed hard-fails; retry resets to pending', async () => {
    const e = await outbox.enqueue(msg('x'));
    await outbox.markSending(e.id);
    await outbox.markFailed(e.id, 'no ack');
    expect((await outbox.listForChannel('coordinator'))[0]!.status).toBe('failed');
    await outbox.retry(e.id);
    const entry = (await outbox.listPending())[0]!;
    expect(entry.status).toBe('pending');
    expect(entry.attempts).toBe(0);
  });

  it('demoteSending returns in-flight entries to pending', async () => {
    const e = await outbox.enqueue(msg('x'));
    await outbox.markSending(e.id);
    expect(await outbox.listPending()).toHaveLength(0);
    await outbox.demoteSending();
    expect(await outbox.listPending()).toHaveLength(1);
  });

  it('clearAll is serialized against a concurrent demoteSending so no row is resurrected (#R2-1)', async () => {
    // Seed many 'sending' entries so demoteSending()'s per-entry put() loop
    // spans several IDB transactions, giving a real interleaving window.
    const entries = await Promise.all(Array.from({ length: 20 }, (_, i) => outbox.enqueue(msg(`m${i}`))));
    for (const e of entries) await outbox.markSending(e.id);

    // Fire demoteSending() WITHOUT awaiting (mirrors the transport's 'closed'
    // status callback: void outbox.demoteSending()), then immediately clear —
    // mirrors wipeAndReset() racing that callback.
    const demote = outbox.demoteSending();
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
      (id) => outbox.markSending(id),
      (id) => outbox.markSendFailed(id, 'offline'),
      (id) => outbox.markFailed(id, 'no ack'),
      (id) => outbox.retry(id),
    ];
    for (const mutate of mutators) {
      const e = await outbox.enqueue(msg('x'));
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
    const seeded = await outbox.enqueue(msg('x'));
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
      await outbox.markSending(seeded.id);
      expect(count).toBe(1);

      count = 0;
      await outbox.markSendFailed(seeded.id, 'offline');
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
    const e = await outbox.enqueue(msg('x'));
    await outbox.settle(e.id);
    unsub();
    expect(touched).toEqual(['coordinator', 'coordinator']);
  });
});
