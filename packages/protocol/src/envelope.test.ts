import { describe, expect, it } from 'vitest';
import { PROTOCOL_VERSION, createEnvelope, parseEnvelope, tryParseEnvelope } from './envelope.js';

describe('envelope', () => {
  it('creates a msg envelope with protocol version, ulid id and ISO ts', () => {
    const env = createEnvelope('msg', {
      from: 'user:u1',
      to: 'agent:coordinator',
      channel: 'coordinator',
      payload: { text: 'hello' },
    });
    expect(env.raccoon).toBe(PROTOCOL_VERSION);
    expect(env.kind).toBe('msg');
    expect(env.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(Number.isNaN(Date.parse(env.ts))).toBe(false);
  });

  it('round-trips through JSON + parseEnvelope', () => {
    const env = createEnvelope('ack', {
      from: 'agent:coordinator',
      to: 'user:u1',
      channel: 'coordinator',
      payload: { refId: 'abc', status: 'delivered' },
    });
    const parsed = parseEnvelope(JSON.parse(JSON.stringify(env)));
    expect(parsed).toEqual(env);
  });

  it('accepts a stalled ack status (#P1-A) and a pair.confirm envelope (#P1-C)', () => {
    const stalled = createEnvelope('ack', {
      from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'abc', status: 'stalled' },
    });
    expect(parseEnvelope(JSON.parse(JSON.stringify(stalled))).payload).toEqual({ refId: 'abc', status: 'stalled' });

    const confirm = createEnvelope('pair.confirm', {
      from: 'system', to: 'system', channel: 'pairing',
      payload: { sessionToken: 'sess-1' },
    });
    expect(confirm.kind).toBe('pair.confirm');
    expect(parseEnvelope(JSON.parse(JSON.stringify(confirm)))).toEqual(confirm);
    // pair.confirm requires a non-empty sessionToken.
    expect(tryParseEnvelope({ ...confirm, payload: { sessionToken: '' } })).toBeNull();
  });

  it('rejects unknown kind', () => {
    expect(() =>
      parseEnvelope({ raccoon: '0.1', id: 'x', kind: 'nope', from: 'system', to: 'user:u1', channel: 'c', ts: new Date().toISOString(), payload: {} }),
    ).toThrow();
  });

  it('rejects msg without text', () => {
    const env = createEnvelope('msg', {
      from: 'user:u1', to: 'agent:a', channel: 'c', payload: { text: 'x' },
    });
    const bad = { ...env, payload: {} };
    expect(tryParseEnvelope(bad)).toBeNull();
  });

  it('rejects bad address', () => {
    const env = createEnvelope('typing', {
      from: 'user:u1', to: 'agent:a', channel: 'c', payload: { state: 'start' },
    });
    expect(tryParseEnvelope({ ...env, from: 'robot:u1' })).toBeNull();
  });
});
