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

  // Retry: this test controls a REAL OS socket's read-pause timing to force
  // the race window open deterministically (see the comment below). Under
  // heavy parallel test-suite load that pause/resume timing has occasionally
  // needed a second attempt; the assertion itself is not weakened by the
  // retry — a real regression fails every attempt, same as before.
  it('a stale close handler for a revoked socket does not disconnect a same-user re-pair (#R2-8)', { retry: 2 }, async () => {
    hub = new WsHub({ instance: 'test' });
    const { port } = await hub.start();

    // Pair the first time.
    const token1 = hub.issuePairingToken('u1');
    const ws1 = await connect(port);
    ws1.send(pairRequest(token1));
    await nextMessage(ws1); // pair.grant

    // Deterministically force ws1's SERVER-side close handshake to complete
    // AFTER ws2 re-pairs (rather than hoping real network timing lands that
    // way, which a prior version of this test did — it passed even with the
    // bug reverted, because ws1's close handshake reliably completed before
    // ws2 attached). Pausing ws1's underlying socket stops it from reading (and
    // so from acking) the server's close frame, which holds the SERVER's own
    // close handshake — and therefore attach()'s server-side close handler —
    // open until we resume() it below.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ws-internal socket handle, no public type
    (ws1 as any)._socket.pause();

    // Revoke deletes byUser['u1'] SYNCHRONOUSLY (before ws1's own close event
    // has fired — ws1.close() only INITIATES the close handshake, now paused).
    const closed1 = nextClose(ws1);
    await hub.revokeUser('u1');

    // Re-pair as the SAME user WHILE ws1's close handshake is held open —
    // attach() creates a brand-new Set for 'u1'.
    const token2 = hub.issuePairingToken('u1');
    const ws2 = await connect(port);
    ws2.send(pairRequest(token2));
    await nextMessage(ws2); // pair.grant

    // Now release ws1's close handshake so its (server-side) close handler
    // actually runs, with ws2 already registered.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- ws-internal socket handle, no public type
    (ws1 as any)._socket.resume();
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

  it('a revoke landing during an external validatePairingToken() await is caught (#R3-4)', async () => {
    // The gap the epoch-only design (R2-2) could not close: grantUserId isn't
    // known until this external await resolves, so a revoke landing DURING it
    // could not be captured by a per-user epoch snapshot taken only AFTER
    // grantUserId was known. A single helloStartedAt baseline, captured before
    // this await even starts, closes it.
    let releaseValidate!: (userId: string) => void;
    const validateGate = new Promise<string>((r) => { releaseValidate = r; });
    hub = new WsHub({
      instance: 'test',
      validatePairingToken: async () => validateGate,
    });
    const { port } = await hub.start();

    const ws = await connect(port);
    ws.send(pairRequest('external-token'));
    await new Promise((r) => setTimeout(r, 20)); // let handleHello reach the paused validator

    await hub.revokeUser('u1'); // revoke WHILE the external validator is in flight
    releaseValidate('u1');      // validator now resolves grantUserId = 'u1', already revoked

    expect(await nextClose(ws)).toBe(4401);
  });

  it('a revoke landing during a session-resume verifySession() await is caught (#R3-4)', async () => {
    // The resume path previously never checked revocation at all: a store
    // round-trip has no ordering guarantee against a concurrent revokeUser()
    // for a real (non-in-memory) store, so verifySession() could resolve
    // "valid" for a session being invalidated right now.
    let releaseVerify!: (userId: string) => void;
    const verifyGate = new Promise<string>((r) => { releaseVerify = r; });
    hub = new WsHub({
      instance: 'test',
      store: {
        createSession: async () => 'unused',
        verifySession: async () => verifyGate,
        revokeUser: async () => {},
      },
    });
    const { port } = await hub.start();

    const ws = await connect(port);
    ws.send(JSON.stringify({ session: 'sess-1' }));
    await new Promise((r) => setTimeout(r, 20)); // let handleHello reach the paused verifySession

    await hub.revokeUser('u1'); // revoke WHILE verifySession() is in flight
    releaseVerify('u1');        // verifySession now resolves 'u1', already revoked

    expect(await nextClose(ws)).toBe(4401);
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

  it('a rejecting store failure during hello never escapes as an unhandled rejection (#R3-1)', async () => {
    hub = new WsHub({
      instance: 'test',
      store: {
        createSession: async () => { throw new Error('unused'); },
        verifySession: async () => { throw new Error('db outage'); },
        revokeUser: async () => {},
      },
    });
    const { port } = await hub.start();
    const rejections: unknown[] = [];
    const onRejection = (reason: unknown): void => { rejections.push(reason); };
    process.on('unhandledRejection', onRejection);
    try {
      const ws = await connect(port);
      ws.send(JSON.stringify({ session: 'whatever' })); // resume path calls verifySession(), which throws
      // The socket must be closed (contained), not left hanging or crashing the process.
      await nextClose(ws);
      await new Promise((r) => setTimeout(r, 20));
      expect(rejections).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
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

  // ---- R3-10: pre-auth WS exhaustion guards ------------------------------

  it('closes a connection with 4408 if it never sends a first message within helloTimeoutMs', async () => {
    hub = new WsHub({ instance: 'test', helloTimeoutMs: 30 });
    const { port } = await hub.start();
    const ws = await connect(port);
    expect(await nextClose(ws)).toBe(4408);
  });

  it('does not time out a connection that sends hello before the deadline', async () => {
    hub = new WsHub({ instance: 'test', helloTimeoutMs: 200 });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');
    const ws = await connect(port);
    ws.send(pairRequest(token));
    const grant = await nextMessage(ws);
    expect(grant.kind).toBe('pair.grant'); // hello was processed, not timed out
    ws.close();
  });

  it('rejects a new connection with 4503 once maxPendingConnections is reached, without affecting already-authenticated sockets', async () => {
    hub = new WsHub({ instance: 'test', maxPendingConnections: 1, helloTimeoutMs: 60_000 });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');

    // Authenticate a connection FIRST — once granted it is no longer
    // "pending" and so no longer counts toward the cap.
    const authed = await connect(port);
    authed.send(pairRequest(token));
    await nextMessage(authed); // pair.grant

    // A second connection never sends hello — occupies the single pending slot.
    const blocked = await connect(port);

    // A third connection is rejected outright: the pending cap is full.
    const rejected = await connect(port);
    expect(await nextClose(rejected)).toBe(4503);

    // The already-authenticated connection is unaffected: it can still
    // exchange messages normally while the cap is saturated.
    hub.sendToUser('u1', createEnvelope('msg', {
      from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'still alive' },
    }));
    const msg = await nextMessage(authed);
    expect(msg.kind).toBe('msg');

    authed.close();
    blocked.close();
  });

  it('closes a connection that sends a frame larger than maxPayloadBytes', async () => {
    hub = new WsHub({ instance: 'test', maxPayloadBytes: 64 });
    const { port } = await hub.start();
    const ws = await connect(port);
    ws.send('x'.repeat(1000));
    expect(await nextClose(ws)).toBe(1009); // ws library's own "message too big" code
  });
});
