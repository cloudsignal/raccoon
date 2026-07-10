import { describe, expect, it } from 'vitest';
import { createEnvelope, type AnyEnvelope } from '@raccoon/protocol';
import { InMemorySubscriptionStore } from './memory-store.js';
import { withPushFallback } from './fallback.js';
import type { PushPayload, PushSubscriptionJson } from './types.js';

class FakeHub {
  online = new Set<string>();
  handlers = new Set<(env: AnyEnvelope, userId: string) => void>();
  delivered: Array<{ userId: string; env: AnyEnvelope }> = [];
  sendToUser(userId: string, env: AnyEnvelope): boolean {
    if (!this.online.has(userId)) return false;
    this.delivered.push({ userId, env });
    return true;
  }
  onEnvelope(h: (env: AnyEnvelope, userId: string) => void): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }
  emit(env: AnyEnvelope, userId: string): void {
    for (const h of this.handlers) h(env, userId);
  }
}

class FakeSender {
  readonly vendor = 'webpush' as const;
  sent: Array<{ sub: PushSubscriptionJson; payload: PushPayload }> = [];
  failWith: number | null = null;
  async send(sub: PushSubscriptionJson, payload: PushPayload): Promise<void> {
    if (this.failWith) { const e = new Error('gone') as Error & { statusCode: number }; e.statusCode = this.failWith; throw e; }
    this.sent.push({ sub, payload });
  }
}

// No return annotation on purpose: TS infers keys-present, which satisfies both
// the push.subscribe envelope payload (keys required) and the keys-optional
// PushSubscriptionJson store/sender usages below.
const sub = (endpoint: string) => ({ endpoint, keys: { p256dh: 'p', auth: 'a' } });
const msgTo = (userId: string) => createEnvelope('msg', {
  from: 'agent:coordinator', to: `user:${userId}`, channel: 'coordinator', payload: { text: 'hello there' },
});

describe('withPushFallback', () => {
  it('captures push.subscribe envelopes into the store and swallows them', async () => {
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    const { hub } = withPushFallback(inner, { store, sender: new FakeSender() });
    const seen: AnyEnvelope[] = [];
    hub.onEnvelope((env) => seen.push(env));
    inner.emit(createEnvelope('push.subscribe', {
      from: 'user:u1', to: 'system', channel: 'system',
      payload: { subscription: sub('https://push.example/1') },
    }), 'u1');
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.list('u1')).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  it('delivers over socket when online, pushes when offline', async () => {
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    const sender = new FakeSender();
    const { hub } = withPushFallback(inner, { store, sender });
    await store.add('u1', sub('https://push.example/1'));

    inner.online.add('u1');
    expect(hub.sendToUser('u1', msgTo('u1'))).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(sender.sent).toHaveLength(0);

    inner.online.delete('u1');
    expect(hub.sendToUser('u1', msgTo('u1'))).toBe(false);
    await new Promise((r) => setTimeout(r, 10));
    expect(sender.sent).toHaveLength(1);
    expect(sender.sent[0]!.payload).toEqual({ title: 'coordinator', body: 'hello there' });
  });

  it('drops expired subscriptions on 410', async () => {
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    const sender = new FakeSender();
    sender.failWith = 410;
    const { hub } = withPushFallback(inner, { store, sender });
    await store.add('u1', sub('https://push.example/1'));
    hub.sendToUser('u1', msgTo('u1'));
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.list('u1')).toHaveLength(0);
  });

  it('does not push for non-notifiable kinds (typing)', async () => {
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    const sender = new FakeSender();
    const { hub } = withPushFallback(inner, { store, sender });
    await store.add('u1', sub('https://push.example/1'));
    hub.sendToUser('u1', createEnvelope('typing', {
      from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { state: 'start' },
    }));
    await new Promise((r) => setTimeout(r, 10));
    expect(sender.sent).toHaveLength(0);
  });

  it('contains store failures — a rejecting store never escapes as unhandled rejection', async () => {
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    store.list = async () => { throw new Error('db down'); };
    const { hub } = withPushFallback(inner, { store, sender: new FakeSender() });
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown) => rejections.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      hub.sendToUser('u1', msgTo('u1'));
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
  });
});
