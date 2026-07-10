import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createEnvelope, parseEnvelope, type AnyEnvelope } from '@raccoon/protocol';
import { WsHub } from './hub.js';

let hub: WsHub;
afterEach(async () => { await hub?.stop(); });

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function nextMessage(ws: WebSocket): Promise<AnyEnvelope> {
  return new Promise((resolve) => ws.once('message', (d) => resolve(parseEnvelope(JSON.parse(d.toString())))));
}

function nextClose(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

function pairRequest(token: string): string {
  return JSON.stringify(createEnvelope('pair.request', {
    from: 'system', to: 'system', channel: 'pairing', payload: { token, device: 'test' },
  }));
}

describe('WsHub pairing', () => {
  it('grants a session for a valid single-use token', async () => {
    hub = new WsHub({ instance: 'test', channels: ['coordinator'] });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');

    const ws = await connect(port);
    ws.send(pairRequest(token));
    const grant = await nextMessage(ws);
    expect(grant.kind).toBe('pair.grant');
    if (grant.kind !== 'pair.grant') return;
    expect(grant.payload.userId).toBe('u1');
    expect(grant.payload.instance).toBe('test');
    expect(grant.payload.channels).toEqual(['coordinator']);
    expect(grant.payload.sessionToken.length).toBeGreaterThan(20);
    ws.close();
  });

  it('rejects a reused token with 4401', async () => {
    hub = new WsHub({ instance: 'test' });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');

    const ws1 = await connect(port);
    ws1.send(pairRequest(token));
    await nextMessage(ws1);
    ws1.close();

    const ws2 = await connect(port);
    ws2.send(pairRequest(token));
    expect(await nextClose(ws2)).toBe(4401);
  });

  it('rejects an unknown session with 4401 and accepts a granted one', async () => {
    hub = new WsHub({ instance: 'test' });
    const { port } = await hub.start();

    const bad = await connect(port);
    bad.send(JSON.stringify({ session: 'nope' }));
    expect(await nextClose(bad)).toBe(4401);

    const token = hub.issuePairingToken('u1');
    const ws = await connect(port);
    ws.send(pairRequest(token));
    const grant = await nextMessage(ws);
    if (grant.kind !== 'pair.grant') throw new Error('expected grant');
    ws.close();

    const resumed = await connect(port);
    resumed.send(JSON.stringify({ session: grant.payload.sessionToken }));
    const hello = await new Promise<{ ok: boolean; userId: string }>((resolve) =>
      resumed.once('message', (d) => resolve(JSON.parse(d.toString()))));
    expect(hello).toEqual({ ok: true, userId: 'u1' });
    resumed.close();
  });

  it('revokeUser closes live sockets with 4403 and kills the session', async () => {
    hub = new WsHub({ instance: 'test' });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');
    const ws = await connect(port);
    ws.send(pairRequest(token));
    const grant = await nextMessage(ws);
    if (grant.kind !== 'pair.grant') throw new Error('expected grant');

    const closed = nextClose(ws);
    await hub.revokeUser('u1');
    expect(await closed).toBe(4403);

    const resumed = await connect(port);
    resumed.send(JSON.stringify({ session: grant.payload.sessionToken }));
    expect(await nextClose(resumed)).toBe(4401);
  });

  it('revokeUser invalidates an unredeemed pairing token (#8)', async () => {
    hub = new WsHub({ instance: 'test' });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');
    await hub.revokeUser('u1'); // revoke BEFORE the token is redeemed
    const ws = await connect(port);
    ws.send(pairRequest(token));
    expect(await nextClose(ws)).toBe(4401); // the outstanding token no longer grants a session
  });

  it('rate-limits pairing attempts per IP with 4429', async () => {
    hub = new WsHub({ instance: 'test', pairingAttemptsPerMinute: 2 });
    const { port } = await hub.start();
    for (let i = 0; i < 2; i++) {
      const ws = await connect(port);
      ws.send(pairRequest('wrong'));
      await nextClose(ws);
    }
    const ws = await connect(port);
    ws.send(pairRequest('wrong'));
    expect(await nextClose(ws)).toBe(4429);
  });

  it('counts junk frames toward the pairing rate limit', async () => {
    hub = new WsHub({ instance: 'test', pairingAttemptsPerMinute: 2 });
    const { port } = await hub.start();
    for (let i = 0; i < 2; i++) {
      const ws = await connect(port);
      ws.send('not json at all');
      await nextClose(ws);
    }
    const ws = await connect(port);
    ws.send(pairRequest('wrong'));
    expect(await nextClose(ws)).toBe(4429);
  });
});
