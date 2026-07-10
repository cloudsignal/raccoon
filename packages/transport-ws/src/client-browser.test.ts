import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WsHub } from './hub.js';
import { WsClientTransport } from './client.js';

describe('browser-safe client', () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).WebSocket;
  });

  it('has no static top-level ws import', () => {
    const src = readFileSync(fileURLToPath(new URL('./client.ts', import.meta.url)), 'utf8');
    expect(src).not.toMatch(/^import .* from 'ws';?$/m);
  });

  it('uses globalThis.WebSocket when present', async () => {
    let constructed = 0;
    class FakeSocket {
      readyState = 0;
      constructor(_url: string) { constructed += 1; }
      send(_data: string): void {}
      close(): void {}
      addEventListener(_type: string, _l: unknown): void {}
    }
    (globalThis as Record<string, unknown>).WebSocket = FakeSocket;
    try {
      const client = new WsClientTransport({ url: 'ws://127.0.0.1:1/', session: 's' });
      // dial hangs on the fake socket (never opens) — race a short timeout
      void client.connect().catch(() => {});
      await new Promise((r) => setTimeout(r, 50));
      expect(constructed).toBe(1);
      await client.close();
    } finally {
      delete (globalThis as Record<string, unknown>).WebSocket;
    }
  });

  it('fires onAuthError on revoked session (4403) and does not reconnect', async () => {
    const hub = new WsHub({ instance: 't', channels: ['c'] });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');
    const client = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, pairingToken: token, device: 'test' });
    const codes: number[] = [];
    client.onAuthError((code) => codes.push(code));
    await client.connect();
    await hub.revokeUser('u1');
    await new Promise((r) => setTimeout(r, 100));
    expect(codes).toEqual([4403]);
    await new Promise((r) => setTimeout(r, 200));
    expect(codes).toEqual([4403]);
    await client.close();
    await hub.stop();
  });
});
