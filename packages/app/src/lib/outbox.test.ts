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

  it('notifies subscribers with the touched channel', async () => {
    const touched: string[] = [];
    const unsub = outbox.subscribe((c) => touched.push(c));
    const e = await outbox.enqueue(msg('x'));
    await outbox.settle(e.id);
    unsub();
    expect(touched).toEqual(['coordinator', 'coordinator']);
  });
});
