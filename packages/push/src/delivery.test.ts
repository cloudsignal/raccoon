import { describe, expect, it } from 'vitest';
import { InMemorySubscriptionStore } from './memory-store.js';
import { sendPushToUser } from './delivery.js';
import { vendorOf } from './vendor.js';
import { VapidPushSender } from './vapid.js';
import type { PushPayload, PushSender, PushSubscriptionJson } from './types.js';

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
