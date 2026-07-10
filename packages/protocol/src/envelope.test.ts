import { describe, expect, it } from 'vitest';
import { OAM_VERSION, createEnvelope, parseEnvelope, tryParseEnvelope } from './envelope.js';

describe('envelope', () => {
  it('creates a msg envelope with oam version, ulid id and ISO ts', () => {
    const env = createEnvelope('msg', {
      from: 'user:u1',
      to: 'agent:coordinator',
      channel: 'coordinator',
      payload: { text: 'hello' },
    });
    expect(env.oam).toBe(OAM_VERSION);
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

  it('rejects unknown kind', () => {
    expect(() =>
      parseEnvelope({ oam: '0.1', id: 'x', kind: 'nope', from: 'system', to: 'user:u1', channel: 'c', ts: new Date().toISOString(), payload: {} }),
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
