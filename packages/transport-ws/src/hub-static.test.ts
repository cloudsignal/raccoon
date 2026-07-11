import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WsHub } from './hub.js';
import { WsClientTransport } from './client.js';
import type { Envelope } from '@raccoon/protocol';

let dir: string;
let hub: WsHub;
let port: number;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'raccoon-static-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>app</title>');
  writeFileSync(join(dir, 'version.json'), '{"buildId":"test1"}');
  mkdirSync(join(dir, 'assets'));
  writeFileSync(join(dir, 'assets', 'main-abc123.js'), 'console.log(1)');
  hub = new WsHub({ instance: 't', channels: ['c'], staticDir: dir, vapidPublicKey: 'BKey' });
  port = (await hub.start()).port;
});

afterEach(async () => {
  await hub.stop();
  rmSync(dir, { recursive: true, force: true });
});

describe('WsHub static serving', () => {
  it('serves index.html at / with no-store', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toContain('app');
  });

  it('serves version.json with no-store', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/version.json`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ buildId: 'test1' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('serves hashed assets as immutable', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/assets/main-abc123.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toContain('immutable');
    expect(res.headers.get('content-type')).toContain('javascript');
  });

  it('falls back to index.html for extensionless SPA paths', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/anything/deep`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('app');
  });

  it('404s missing files with extensions and rejects traversal', async () => {
    expect((await fetch(`http://127.0.0.1:${port}/nope.js`)).status).toBe(404);
    expect((await fetch(`http://127.0.0.1:${port}/..%2f..%2fetc%2fpasswd`)).status).toBe(400);
  });

  it('404s when the resolved path is unreadable (directory masquerading as a file)', async () => {
    mkdirSync(join(dir, 'trap.js'));
    const res = await fetch(`http://127.0.0.1:${port}/trap.js`);
    expect(res.status).toBe(404);
  });

  it('404s all HTTP when staticDir is not set', async () => {
    const bare = new WsHub({ instance: 'b', channels: [] });
    const p = (await bare.start()).port;
    expect((await fetch(`http://127.0.0.1:${p}/`)).status).toBe(404);
    await bare.stop();
  });

  it('includes vapidPublicKey in pair.grant when configured', async () => {
    const token = hub.issuePairingToken('u1');
    const client = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, pairingToken: token, device: 't' });
    const grants: Envelope<'pair.grant'>[] = [];
    client.onGrant((g) => grants.push(g));
    await client.connect();
    expect(grants[0]?.payload.vapidPublicKey).toBe('BKey');
    await client.close();
  });
});

describe('WsHub start failures', () => {
  it('rejects start() when the port is taken instead of crashing the process', async () => {
    const a = new WsHub({ instance: 'a', channels: [] });
    const { port: taken } = await a.start();
    const b = new WsHub({ instance: 'b', channels: [], port: taken });
    await expect(b.start()).rejects.toThrow(/EADDRINUSE|address already in use/);
    await a.stop();
    await b.stop();
  });
});

describe('WsHub external pairing validation', () => {
  it('grants sessions via validatePairingToken and still honors built-in tokens', async () => {
    const hub2 = new WsHub({
      instance: 'ext',
      channels: ['coordinator'],
      validatePairingToken: async (token) => (token === 'ext-good' ? 'user-77' : null),
    });
    const { port: p } = await hub2.start();

    const ok = new WsClientTransport({ url: `ws://127.0.0.1:${p}/`, pairingToken: 'ext-good', device: 't' });
    const grants: Envelope<'pair.grant'>[] = [];
    ok.onGrant((g) => grants.push(g));
    await ok.connect();
    expect(grants[0]?.payload.userId).toBe('user-77');
    await ok.close();

    const builtin = hub2.issuePairingToken('user-88');
    const ok2 = new WsClientTransport({ url: `ws://127.0.0.1:${p}/`, pairingToken: builtin, device: 't' });
    const grants2: Envelope<'pair.grant'>[] = [];
    ok2.onGrant((g) => grants2.push(g));
    await ok2.connect();
    expect(grants2[0]?.payload.userId).toBe('user-88');
    await ok2.close();

    const bad = new WsClientTransport({ url: `ws://127.0.0.1:${p}/`, pairingToken: 'ext-nope', device: 't' });
    await expect(bad.connect()).rejects.toThrow(/4401/);
    await hub2.stop();
  });
});

import { grantAbandoned } from './hub.js';

describe('grantAbandoned (#R8-6)', () => {
  it('abandons a just-minted grant when the deadline aborted OR the socket is no longer open', () => {
    // The whole point: the socket-not-open case must abandon even when the
    // abort signal has NOT yet fired (createSession resolved in the window
    // before the close-event abort callback ran).
    expect(grantAbandoned(false, false)).toBe(true);  // socket closing, signal not aborted → abandon (the #R8-6 gap)
    expect(grantAbandoned(true, true)).toBe(true);     // deadline aborted, socket still "open" → abandon
    expect(grantAbandoned(true, false)).toBe(true);    // both
    expect(grantAbandoned(false, true)).toBe(false);   // healthy: open + not aborted → grant proceeds
  });
});
