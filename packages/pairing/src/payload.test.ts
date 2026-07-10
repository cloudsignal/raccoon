import { describe, expect, it } from 'vitest';
import { buildPairingPayload, parsePairingPayload } from './payload.js';

describe('pairing payload', () => {
  it('builds a versioned JSON payload with ws default', () => {
    const json = buildPairingPayload({ instanceUrl: 'ws://host:8790/', token: 'abc' });
    expect(JSON.parse(json)).toEqual({ v: 1, instanceUrl: 'ws://host:8790/', transport: 'ws', token: 'abc' });
  });

  it('round-trips through parse', () => {
    const json = buildPairingPayload({ instanceUrl: 'ws://h/', token: 't', transport: 'ws' });
    expect(parsePairingPayload(json)).toEqual({ v: 1, instanceUrl: 'ws://h/', transport: 'ws', token: 't' });
  });

  it('rejects empty fields', () => {
    expect(() => buildPairingPayload({ instanceUrl: '', token: 't' })).toThrow();
    expect(() => buildPairingPayload({ instanceUrl: 'ws://h/', token: '' })).toThrow();
  });

  it('rejects malformed or unsupported payloads on parse', () => {
    expect(() => parsePairingPayload('not json')).toThrow();
    expect(() => parsePairingPayload(JSON.stringify({ v: 2, instanceUrl: 'x', transport: 'ws', token: 't' }))).toThrow();
  });
});
