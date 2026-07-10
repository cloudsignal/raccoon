import { describe, expect, it } from 'vitest';
import type { AnyEnvelope } from '@raccoon/protocol';
import { enablePushFlow, unsubscribeCurrentPush, urlBase64ToUint8Array, type PushEnv } from './push-client.js';

const sub = { endpoint: 'https://push.example/1', keys: { p256dh: 'p', auth: 'a' } };

function env(overrides: Partial<PushEnv>): PushEnv {
  return {
    permission: () => 'default',
    requestPermission: async () => 'granted',
    getSubscription: async () => sub,
    currentEndpoint: async () => sub.endpoint,
    unsubscribeLocal: async () => {},
    ...overrides,
  };
}

describe('push client', () => {
  it('decodes url-safe base64 vapid keys', () => {
    const bytes = urlBase64ToUint8Array('AQID');
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  it('subscribes and sends push.subscribe on grant', async () => {
    const sent: AnyEnvelope[] = [];
    const ok = await enablePushFlow({
      env: env({}),
      vapidPublicKey: 'BKey',
      userId: 'u1',
      send: async (e) => { sent.push(e); },
    });
    expect(ok).toBe(true);
    expect(sent[0]!.kind).toBe('push.subscribe');
    expect(sent[0]!.kind === 'push.subscribe' && sent[0]!.payload.subscription).toEqual(sub);
  });

  it('returns false when permission is denied', async () => {
    const sent: AnyEnvelope[] = [];
    const ok = await enablePushFlow({
      env: env({ permission: () => 'denied' }),
      vapidPublicKey: 'BKey',
      userId: 'u1',
      send: async (e) => { sent.push(e); },
    });
    expect(ok).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('returns false when the user dismisses the prompt', async () => {
    const ok = await enablePushFlow({
      env: env({ requestPermission: async () => 'default' }),
      vapidPublicKey: 'BKey',
      userId: 'u1',
      send: async () => {},
    });
    expect(ok).toBe(false);
  });

  it('returns false when the subscription cannot be obtained', async () => {
    const ok = await enablePushFlow({
      env: env({ getSubscription: async () => null }),
      vapidPublicKey: 'BKey',
      userId: 'u1',
      send: async () => {},
    });
    expect(ok).toBe(false);
  });

  it('returns false instead of throwing when send fails', async () => {
    const ok = await enablePushFlow({
      env: env({}),
      vapidPublicKey: 'BKey',
      userId: 'u1',
      send: async () => { throw new Error('transport not open'); },
    });
    expect(ok).toBe(false);
  });
});

describe('unsubscribeCurrentPush (#R2-6)', () => {
  it('sends push.unsubscribe with the current endpoint, then tears down the local subscription', async () => {
    const sent: AnyEnvelope[] = [];
    let unsubscribedLocally = false;
    await unsubscribeCurrentPush({
      env: env({ unsubscribeLocal: async () => { unsubscribedLocally = true; } }),
      userId: 'u1',
      send: async (e) => { sent.push(e); },
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.kind).toBe('push.unsubscribe');
    expect(sent[0]!.kind === 'push.unsubscribe' && sent[0]!.payload.endpoint).toBe(sub.endpoint);
    expect(unsubscribedLocally).toBe(true);
  });

  it('still tears down locally when there is no current subscription', async () => {
    let unsubscribedLocally = false;
    const sent: AnyEnvelope[] = [];
    await unsubscribeCurrentPush({
      env: env({ currentEndpoint: async () => null, unsubscribeLocal: async () => { unsubscribedLocally = true; } }),
      userId: 'u1',
      send: async (e) => { sent.push(e); },
    });
    expect(sent).toHaveLength(0); // nothing to unsubscribe server-side
    expect(unsubscribedLocally).toBe(true);
  });

  it('still tears down locally when the server send fails (device is unpairing regardless)', async () => {
    let unsubscribedLocally = false;
    await unsubscribeCurrentPush({
      env: env({ unsubscribeLocal: async () => { unsubscribedLocally = true; } }),
      userId: 'u1',
      send: async () => { throw new Error('transport not open'); },
    });
    expect(unsubscribedLocally).toBe(true);
  });
});
