import { describe, expect, it } from 'vitest';
import {
  createEnvelope,
  parsePairingPayload,
  tryParseEnvelope,
} from './index.js';

describe('protocol extensions (Plan C)', () => {
  it('accepts push.subscribe envelopes', () => {
    const env = createEnvelope('push.subscribe', {
      from: 'user:u1',
      to: 'system',
      channel: 'system',
      payload: {
        subscription: {
          endpoint: 'https://push.example/abc',
          keys: { p256dh: 'k1', auth: 'k2' },
        },
      },
    });
    expect(env.kind).toBe('push.subscribe');
    expect(tryParseEnvelope(JSON.parse(JSON.stringify(env)))).not.toBeNull();
  });

  it('accepts optional editedText on approval.response', () => {
    const env = createEnvelope('approval.response', {
      from: 'user:u1',
      to: 'agent:assistant',
      channel: 'coordinator',
      payload: { refId: 'r1', choice: 'edit', editedText: 'Edited draft body' },
    });
    expect(env.payload.editedText).toBe('Edited draft body');
    // still valid without it
    const plain = createEnvelope('approval.response', {
      from: 'user:u1',
      to: 'agent:assistant',
      channel: 'coordinator',
      payload: { refId: 'r1', choice: 'approve' },
    });
    expect(plain.payload.editedText).toBeUndefined();
  });

  it('accepts optional vapidPublicKey on pair.grant', () => {
    const env = createEnvelope('pair.grant', {
      from: 'system',
      to: 'user:u1',
      channel: 'pairing',
      payload: {
        sessionToken: 's',
        userId: 'u1',
        instance: 'i',
        channels: ['coordinator'],
        vapidPublicKey: 'BPubKey',
      },
    });
    expect(env.payload.vapidPublicKey).toBe('BPubKey');
  });

  it('parses pairing payloads from protocol', () => {
    const parsed = parsePairingPayload(
      JSON.stringify({ v: 1, instanceUrl: 'ws://127.0.0.1:8790/', transport: 'ws', token: 't0k' }),
    );
    expect(parsed).toEqual({ v: 1, instanceUrl: 'ws://127.0.0.1:8790/', transport: 'ws', token: 't0k' });
    expect(() => parsePairingPayload('{"v":2}')).toThrow();
  });
});
