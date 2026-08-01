import { describe, expect, it } from 'vitest';
import { parseRaccoonConfig } from './config.js';

const FULL = {
  RACCOON_PORT: '8790',
  RACCOON_INSTANCE_URL: 'wss://raccoon.example.com',
  RACCOON_PUBLIC_ORIGIN: 'http://host.docker.internal:8790/',
  RACCOON_CHANNELS: 'assistant=main-group, researcher=research-group',
  RACCOON_ADMIN_SECRET: 's3cret',
};

describe('parseRaccoonConfig', () => {
  it('parses a full env with defaults applied', () => {
    const cfg = parseRaccoonConfig(FULL);
    expect(cfg).not.toBeNull();
    expect(cfg!.port).toBe(8790);
    expect(cfg!.instance).toBe('nanoclaw');
    expect(cfg!.adminPort).toBe(8791);
    expect(cfg!.adminHost).toBe('127.0.0.1');
    expect(cfg!.dataDir).toBe('./data/raccoon');
    expect(cfg!.turnTimeoutMs).toBe(90_000);
    expect(cfg!.publicOrigin).toBe('http://host.docker.internal:8790'); // trailing slash stripped
    expect(cfg!.channels).toEqual([
      { channel: 'assistant', agentGroup: 'main-group' },
      { channel: 'researcher', agentGroup: 'research-group' },
    ]);
  });

  it('returns null when any required var is missing', () => {
    for (const key of Object.keys(FULL)) {
      const env = { ...FULL, [key]: undefined };
      expect(parseRaccoonConfig(env)).toBeNull();
    }
  });

  it('adminHost never inherits RACCOON_HOST', () => {
    const cfg = parseRaccoonConfig({ ...FULL, RACCOON_HOST: '0.0.0.0' })!;
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.adminHost).toBe('127.0.0.1');
    expect(parseRaccoonConfig({ ...FULL, RACCOON_ADMIN_HOST: '10.0.0.5' })!.adminHost).toBe('10.0.0.5');
  });

  it('honors optional overrides', () => {
    const cfg = parseRaccoonConfig({
      ...FULL,
      RACCOON_HOST: '0.0.0.0',
      RACCOON_INSTANCE: 'myclaw',
      RACCOON_ADMIN_PORT: '9000',
      RACCOON_DATA_DIR: '/data/rc',
      RACCOON_TURN_TIMEOUT_MS: '30000',
      VAPID_PUBLIC_KEY: 'pk',
      VAPID_PRIVATE_KEY: 'sk',
      VAPID_SUBJECT: 'mailto:ops@example.com',
    })!;
    expect(cfg.host).toBe('0.0.0.0');
    expect(cfg.instance).toBe('myclaw');
    expect(cfg.adminPort).toBe(9000);
    expect(cfg.dataDir).toBe('/data/rc');
    expect(cfg.turnTimeoutMs).toBe(30_000);
    expect(cfg.vapid).toEqual({ publicKey: 'pk', privateKey: 'sk', subject: 'mailto:ops@example.com' });
  });

  it('ignores an incomplete vapid triple', () => {
    const cfg = parseRaccoonConfig({ ...FULL, VAPID_PUBLIC_KEY: 'pk' })!;
    expect(cfg.vapid).toBeUndefined();
  });

  it('accepts port 0 (ephemeral bind)', () => {
    expect(parseRaccoonConfig({ ...FULL, RACCOON_PORT: '0', RACCOON_ADMIN_PORT: '0' })!.port).toBe(0);
  });

  it('throws on malformed values', () => {
    expect(() => parseRaccoonConfig({ ...FULL, RACCOON_PORT: 'abc' })).toThrow(/RACCOON_PORT/);
    expect(() => parseRaccoonConfig({ ...FULL, RACCOON_CHANNELS: 'no-equals-sign' })).toThrow(/RACCOON_CHANNELS/);
    expect(() => parseRaccoonConfig({ ...FULL, RACCOON_CHANNELS: 'a=g1,a=g2' })).toThrow(/duplicate/i);
    expect(() => parseRaccoonConfig({ ...FULL, RACCOON_TURN_TIMEOUT_MS: '-5' })).toThrow(/RACCOON_TURN_TIMEOUT_MS/);
  });
});
