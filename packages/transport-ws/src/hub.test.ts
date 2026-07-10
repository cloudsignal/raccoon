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

  it('a stale close handler for a revoked socket does not disconnect a same-user re-pair (#R2-8)', async () => {
    hub = new WsHub({ instance: 'test' });
    const { port } = await hub.start();

    // Pair the first time.
    const token1 = hub.issuePairingToken('u1');
    const ws1 = await connect(port);
    ws1.send(pairRequest(token1));
    await nextMessage(ws1); // pair.grant

    // Revoke deletes byUser['u1'] SYNCHRONOUSLY (before ws1's own close event
    // has fired — ws1.close() only INITIATES the close handshake).
    const closed1 = nextClose(ws1);
    await hub.revokeUser('u1');

    // Re-pair as the SAME user BEFORE ws1's close event has finished — attach()
    // creates a brand-new Set for 'u1'.
    const token2 = hub.issuePairingToken('u1');
    const ws2 = await connect(port);
    ws2.send(pairRequest(token2));
    await nextMessage(ws2); // pair.grant

    // Now let ws1's close handshake actually complete (its close handler runs
    // on the server as part of this).
    expect(await closed1).toBe(4403);

    // The old code unconditionally deleted byUser['u1'] once ws1's (now
    // orphaned) Set emptied, wiping out ws2's registration. Confirm ws2 is
    // still registered: a message sent to 'u1' must still reach it.
    const received = nextMessage(ws2);
    const delivered = hub.sendToUser('u1', createEnvelope('typing', {
      from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { state: 'start' },
    }));
    expect(delivered).toBe(true);
    expect((await received).kind).toBe('typing');
  });

  it('a revoke racing an in-flight token redemption does not leave a live session (#R2-2)', async () => {
    // A store whose createSession() pauses until released, so we can revoke
    // the user WHILE a redemption for them is mid-flight — the reviewer's
    // exact repro: pause createSession(), revoke, resume, then check the
    // minted session does not verify afterward.
    let releaseCreate!: (token: string) => void;
    const createGate = new Promise<string>((r) => { releaseCreate = r; });
    const sessions = new Map<string, string>();
    hub = new WsHub({
      instance: 'test',
      store: {
        createSession: async (userId) => {
          const token = await createGate;
          sessions.set(token, userId);
          return token;
        },
        verifySession: async (t) => sessions.get(t) ?? null,
        revokeUser: async (userId) => {
          for (const [t, u] of sessions) if (u === userId) sessions.delete(t);
        },
      },
    });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');

    const ws = await connect(port);
    ws.send(pairRequest(token));
    await new Promise((r) => setTimeout(r, 20)); // let handleHello reach the paused createSession()

    await hub.revokeUser('u1'); // revoke WHILE createSession() is in flight
    releaseCreate('sess-1');    // let createSession() resolve, minting a session for the now-revoked user

    // The connection must be closed rather than granted a live session: the
    // hub must detect the revoke happened mid-redemption.
    expect(await nextClose(ws)).toBe(4401);

    // And the minted session must not verify for a fresh connection either —
    // proving it was actively killed, not just that this socket was dropped.
    const resumed = await connect(port);
    resumed.send(JSON.stringify({ session: 'sess-1' }));
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
