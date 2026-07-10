import { describe, expect, it } from 'vitest';
import { createEnvelope, type AnyEnvelope } from '@raccoon/protocol';
import { InMemorySubscriptionStore } from './memory-store.js';
import { withPushFallback } from './fallback.js';
import { MAX_SUBSCRIPTIONS_PER_USER } from './endpoint-guard.js';
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
      payload: { subscription: sub('https://fcm.googleapis.com/fcm/send/1') },
    }), 'u1');
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.list('u1')).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });

  it('rejects an unsafe (internal) web-push endpoint at subscribe (SSRF guard, #9)', async () => {
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    withPushFallback(inner, { store, sender: new FakeSender() });
    inner.emit(createEnvelope('push.subscribe', {
      from: 'user:u1', to: 'system', channel: 'system',
      payload: { subscription: sub('https://169.254.169.254/latest/meta-data/') },
    }), 'u1');
    await new Promise((r) => setTimeout(r, 10));
    expect(await store.list('u1')).toHaveLength(0);
  });

  it('caps stored subscriptions per user (#9 fan-out limit)', async () => {
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    withPushFallback(inner, { store, sender: new FakeSender() });
    for (let i = 0; i < MAX_SUBSCRIPTIONS_PER_USER + 5; i++) {
      inner.emit(createEnvelope('push.subscribe', {
        from: 'user:u1', to: 'system', channel: 'system',
        payload: { subscription: sub(`https://fcm.googleapis.com/fcm/send/${i}`) },
      }), 'u1');
      await new Promise((r) => setTimeout(r, 1)); // serialise the fire-and-forget adds
    }
    await new Promise((r) => setTimeout(r, 20));
    expect((await store.list('u1')).length).toBe(MAX_SUBSCRIPTIONS_PER_USER);
  });

  it('push.unsubscribe removes the stored subscription and is swallowed like push.subscribe (#R2-6)', async () => {
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    await store.add('u1', sub('https://push.example/1'));
    const { hub } = withPushFallback(inner, { store, sender: new FakeSender() });
    const seen: AnyEnvelope[] = [];
    hub.onEnvelope((env) => seen.push(env));

    inner.emit(createEnvelope('push.unsubscribe', {
      from: 'user:u1', to: 'system', channel: 'system',
      payload: { endpoint: 'https://push.example/1' },
    }), 'u1');
    await new Promise((r) => setTimeout(r, 10));

    expect(await store.list('u1')).toHaveLength(0);
    expect(seen).toHaveLength(0); // swallowed, not forwarded to consumers
  });

  it('push.unsubscribe is scoped to the sender\'s own userId (cannot remove another user\'s subscription)', async () => {
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    await store.add('victim', sub('https://push.example/victim-1'));
    withPushFallback(inner, { store, sender: new FakeSender() });

    // 'attacker' tries to unsubscribe victim's endpoint; the hub always passes
    // the AUTHENTICATED userId of the sender (here 'attacker'), so remove() is
    // scoped to attacker's own (empty) subscription list and cannot touch it.
    inner.emit(createEnvelope('push.unsubscribe', {
      from: 'user:attacker', to: 'system', channel: 'system',
      payload: { endpoint: 'https://push.example/victim-1' },
    }), 'attacker');
    await new Promise((r) => setTimeout(r, 10));

    expect(await store.list('victim')).toHaveLength(1);
  });

  it('a concurrent unsubscribe for the same endpoint is serialized after an in-flight subscribe, not resurrected (#R3-12)', async () => {
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    // Must pass the SSRF/vendor-allowlist guard (unlike 'https://push.example/1',
    // used elsewhere in this file only to seed the store directly, bypassing
    // addSubscription) — otherwise addSubscription returns before ever calling
    // store.list(), and the gate below never engages.
    const endpoint = 'https://fcm.googleapis.com/fcm/send/1';
    await store.add('u1', sub(endpoint));

    // Gate store.list() so the subscribe's list -> cap-check -> add sequence
    // stays in flight while we inject a concurrent unsubscribe for the same
    // endpoint. Without per-user serialization covering BOTH operations, the
    // unsubscribe's remove() (which doesn't depend on list()) could complete
    // BEFORE the gated subscribe's add() runs, so the subscribe would
    // resurrect the very endpoint the client had just asked to remove.
    const gate: { release?: () => void } = {};
    const originalList = store.list.bind(store);
    let listCalls = 0;
    store.list = async (userId: string) => {
      listCalls += 1;
      if (listCalls === 1) await new Promise<void>((resolve) => { gate.release = resolve; });
      return originalList(userId);
    };

    withPushFallback(inner, { store, sender: new FakeSender() });

    inner.emit(createEnvelope('push.subscribe', {
      from: 'user:u1', to: 'system', channel: 'system', payload: { subscription: sub(endpoint) },
    }), 'u1');
    await new Promise((r) => setTimeout(r, 10)); // let the subscribe reach the gated list() call
    expect(listCalls).toBe(1); // sanity: the gate actually engaged

    inner.emit(createEnvelope('push.unsubscribe', {
      from: 'user:u1', to: 'system', channel: 'system', payload: { endpoint },
    }), 'u1');
    await new Promise((r) => setTimeout(r, 10)); // unsubscribe must NOT run yet — it's queued behind the subscribe

    gate.release?.();
    await new Promise((r) => setTimeout(r, 20));

    // The unsubscribe was the later-arriving op: once properly serialized, it
    // runs AFTER the subscribe completes and the endpoint ends up removed.
    expect(await originalList('u1')).toHaveLength(0);
  });

  it('clearForUser (revoke) is serialized after an in-flight subscribe, not left resurrected (#R4-5)', async () => {
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/1';

    // Gate store.list() so the subscribe's list -> cap-check -> add sequence
    // stays in flight while revoke's clearForUser() races it. Without
    // serialization, clearForUser's store.clear() (which doesn't depend on
    // list()) could complete BEFORE the gated subscribe's add() runs,
    // leaving one subscription behind for a user who was just revoked —
    // reproduced by blocking add(), completing revoke, then releasing add().
    const gate: { release?: () => void } = {};
    const originalList = store.list.bind(store);
    let listCalls = 0;
    store.list = async (userId: string) => {
      listCalls += 1;
      if (listCalls === 1) await new Promise<void>((resolve) => { gate.release = resolve; });
      return originalList(userId);
    };

    const { clearForUser } = withPushFallback(inner, { store, sender: new FakeSender() });

    inner.emit(createEnvelope('push.subscribe', {
      from: 'user:u1', to: 'system', channel: 'system', payload: { subscription: sub(endpoint) },
    }), 'u1');
    await new Promise((r) => setTimeout(r, 10)); // let the subscribe reach the gated list() call
    expect(listCalls).toBe(1); // sanity: the gate actually engaged

    const revoked = clearForUser('u1'); // races the in-flight subscribe
    await new Promise((r) => setTimeout(r, 10)); // clear must NOT run yet — queued behind the subscribe
    expect(await originalList('u1')).toHaveLength(0); // store.add() hasn't landed yet either

    gate.release?.();
    await revoked;
    await new Promise((r) => setTimeout(r, 20)); // let the (now-unblocked) subscribe's own add() land, if it hasn't already

    // clearForUser was the later-arriving op: once properly serialized, it
    // runs AFTER the subscribe's add() completes, so the user ends up with
    // ZERO subscriptions — not one resurrected by the race.
    expect(await originalList('u1')).toHaveLength(0);
  });

  it('clearForUser propagates a store.clear() failure instead of resolving as success (#R5-9)', async () => {
    // The per-user FIFO chain must swallow op failures INTERNALLY (so one
    // failed op never wedges the chain) — but the promise clearForUser hands
    // its caller must reflect the clear's real outcome. Previously it
    // inherited the chain's own swallowed link, so a revoke reported success
    // while the user's push subscriptions were all still active.
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    store.clear = async () => { throw new Error('db outage'); };
    const { clearForUser } = withPushFallback(inner, { store, sender: new FakeSender() });

    await expect(clearForUser('u1')).rejects.toThrow('db outage');
  });

  it('a failed clearForUser does not wedge the per-user chain — later ops still run (#R5-9)', async () => {
    const inner = new FakeHub();
    const store = new InMemorySubscriptionStore();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/after-failure';
    const originalClear = store.clear.bind(store);
    let failNext = true;
    store.clear = async (userId: string) => {
      if (failNext) { failNext = false; throw new Error('db outage'); }
      return originalClear(userId);
    };
    const { clearForUser } = withPushFallback(inner, { store, sender: new FakeSender() });

    await expect(clearForUser('u1')).rejects.toThrow('db outage');

    // The chain is still alive: a subsequent subscribe for the same user
    // must land normally.
    inner.emit(createEnvelope('push.subscribe', {
      from: 'user:u1', to: 'system', channel: 'system', payload: { subscription: sub(endpoint) },
    }), 'u1');
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.list('u1')).toHaveLength(1);
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
