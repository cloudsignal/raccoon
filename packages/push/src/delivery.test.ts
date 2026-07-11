import { describe, expect, it } from 'vitest';
import { InMemorySubscriptionStore } from './memory-store.js';
import { sendPushToUser } from './delivery.js';
import { vendorOf } from './vendor.js';
import { VapidPushSender } from './vapid.js';
import type { PushPayload, PushSender, PushSubscriptionJson, SubscriptionStore } from './types.js';

class FakeSender implements PushSender {
  readonly vendor = 'webpush' as const;
  sent: Array<{ sub: PushSubscriptionJson; payload: PushPayload }> = [];
  failWith: number | null = null;
  async send(sub: PushSubscriptionJson, payload: PushPayload): Promise<void> {
    if (this.failWith) {
      const e = new Error('gone') as Error & { statusCode: number };
      e.statusCode = this.failWith;
      throw e;
    }
    this.sent.push({ sub, payload });
  }
}

const webSub = (endpoint: string): PushSubscriptionJson => ({
  endpoint,
  keys: { p256dh: 'p', auth: 'a' },
});
const customSub = (id: string): PushSubscriptionJson => ({ endpoint: `x-vendor:${id}` });
const payload: PushPayload = { title: 'coordinator', body: 'hello', tag: 'coordinator', data: { url: '/chat?c=coordinator', channel: 'coordinator' } };

describe('vendorOf', () => {
  it('derives the vendor from a custom (non-http) endpoint scheme', () => {
    expect(vendorOf(customSub('reg1'))).toBe('x-vendor');
  });
  it('http(s) endpoints resolve to webpush', () => {
    expect(vendorOf(webSub('https://push.example/1'))).toBe('webpush');
  });
});

describe('sendPushToUser', () => {
  it('fans out to all matching subscriptions and reports the count', async () => {
    const store = new InMemorySubscriptionStore();
    await store.add('u1', webSub('https://push.example/1'));
    await store.add('u1', webSub('https://push.example/2'));
    const sender = new FakeSender();
    const delivered = await sendPushToUser(store, sender, 'u1', payload);
    expect(delivered).toBe(2);
    expect(sender.sent).toHaveLength(2);
    expect(sender.sent[0].payload.tag).toBe('coordinator');
  });

  it('skips subscriptions whose vendor does not match the sender', async () => {
    const store = new InMemorySubscriptionStore();
    await store.add('u1', webSub('https://push.example/1'));
    await store.add('u1', customSub('reg1'));
    const sender = new FakeSender(); // vendor: webpush
    const delivered = await sendPushToUser(store, sender, 'u1', payload);
    expect(delivered).toBe(1);
    expect(sender.sent[0].sub.endpoint).toBe('https://push.example/1');
    // custom-vendor row is untouched, not pruned
    expect(await store.list('u1')).toHaveLength(2);
  });

  it('prunes dead endpoints on 410 and never throws', async () => {
    const store = new InMemorySubscriptionStore();
    await store.add('u1', webSub('https://push.example/dead'));
    const sender = new FakeSender();
    sender.failWith = 410;
    const delivered = await sendPushToUser(store, sender, 'u1', payload);
    expect(delivered).toBe(0);
    expect(await store.list('u1')).toHaveLength(0);
  });

  it('a stale 410 does NOT delete a subscription re-added on the same endpoint with fresh keys (#R7-4)', async () => {
    const store = new InMemorySubscriptionStore();
    const endpoint = 'https://push.example/reissued';
    const oldSub: PushSubscriptionJson = { endpoint, keys: { p256dh: 'old', auth: 'old' } };
    await store.add('u1', oldSub);

    // The send fails 410 for the OLD sub, but WHILE it was in flight the user
    // re-subscribed the SAME endpoint with NEW keys — the prune must target
    // the exact old registration, not blow away the new one.
    const newSub: PushSubscriptionJson = { endpoint, keys: { p256dh: 'new', auth: 'new' } };
    const sender = new FakeSender();
    sender.send = async () => {
      // Simulate the re-subscribe landing mid-delivery.
      await store.remove('u1', endpoint);
      await store.add('u1', newSub);
      const e = new Error('gone') as Error & { statusCode: number }; e.statusCode = 410; throw e;
    };

    await sendPushToUser(store, sender, 'u1', payload);
    const rows = await store.list('u1');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual(newSub); // the re-added subscription survived
  });
});

describe('sendPushToUser revocation fence (#R6-6)', () => {
  it('aborts after the store snapshot if the user was revoked while it was in flight', async () => {
    // The reviewer's exact shape: delivery snapshots subscriptions, a revoke
    // completes while that snapshot is in flight, and the captured
    // subscription must NOT then receive. Gate list() to hold the snapshot
    // open; flip the fence (the revoke) before releasing it.
    const store = new InMemorySubscriptionStore();
    await store.add('u1', webSub('https://push.example/1'));
    let revoked = false;
    const gated: SubscriptionStore = {
      list: async (uid: string) => {
        revoked = true; // the revoke lands while we're snapshotting
        return store.list(uid);
      },
      add: (uid, s) => store.add(uid, s),
      remove: (uid, ep) => store.remove(uid, ep),
      clear: (uid) => store.clear(uid),
    };
    const sender = new FakeSender();
    const delivered = await sendPushToUser(gated, sender, 'u1', payload, () => revoked);
    expect(delivered).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  it('aborts before any send if the user was already revoked at the call', async () => {
    const store = new InMemorySubscriptionStore();
    await store.add('u1', webSub('https://push.example/1'));
    const sender = new FakeSender();
    const delivered = await sendPushToUser(store, sender, 'u1', payload, () => true);
    expect(delivered).toBe(0);
    expect(sender.sent).toHaveLength(0);
  });

  it('delivers normally when the fence never trips', async () => {
    const store = new InMemorySubscriptionStore();
    await store.add('u1', webSub('https://push.example/1'));
    const sender = new FakeSender();
    const delivered = await sendPushToUser(store, sender, 'u1', payload, () => false);
    expect(delivered).toBe(1);
  });
});

describe('InMemorySubscriptionStore.removeIfMatches (#R8-CQ)', () => {
  it('removes an endpoint only when the stored sub is byte-identical', async () => {
    const store = new InMemorySubscriptionStore();
    const endpoint = 'https://push.example/e';
    const oldSub: PushSubscriptionJson = { endpoint, keys: { p256dh: 'old', auth: 'old' } };
    await store.add('u1', oldSub);

    // A re-add with fresh keys on the same endpoint…
    const newSub: PushSubscriptionJson = { endpoint, keys: { p256dh: 'new', auth: 'new' } };
    await store.add('u1', newSub);
    // …a stale prune targeting the OLD sub must NOT remove the new one.
    await store.removeIfMatches('u1', oldSub);
    expect(await store.list('u1')).toEqual([newSub]);

    // Pruning the CURRENT sub does remove it.
    await store.removeIfMatches('u1', newSub);
    expect(await store.list('u1')).toEqual([]);
  });
});

describe('VapidPushSender guard', () => {
  it('rejects keyless subscriptions with a descriptive error', async () => {
    const sender = new VapidPushSender({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:x@y.z' });
    await expect(sender.send(customSub('reg1'), payload)).rejects.toThrow(/no keys/);
  });
  it('declares the webpush vendor', () => {
    const sender = new VapidPushSender({ publicKey: 'pub', privateKey: 'priv', subject: 'mailto:x@y.z' });
    expect(sender.vendor).toBe('webpush');
  });
});
