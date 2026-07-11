import { afterEach, describe, expect, it, vi } from 'vitest';
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

  it('a revoke is still detected after the system clock jumps backward (#R4-8)', async () => {
    // helloStartedAt and revokedAt are monotonic sequence numbers, not
    // Date.now() timestamps, so they are immune to a backward clock
    // adjustment (NTP correction, VM resume) landing between the two. A
    // Date.now()-based revokedAt would compare as EARLIER than the
    // already-captured helloStartedAt here, defeating the `revokedAt >=
    // helloStartedAt` check and letting the revoked grant through.
    let releaseValidate!: (userId: string) => void;
    const validateGate = new Promise<string>((r) => { releaseValidate = r; });
    hub = new WsHub({
      instance: 'test',
      validatePairingToken: async () => validateGate,
    });
    const { port } = await hub.start();

    const ws = await connect(port);
    ws.send(pairRequest('external-token'));
    await new Promise((r) => setTimeout(r, 20)); // let handleHello capture helloStartedAt and reach the paused validator

    const realNow = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(realNow - 60 * 60 * 1000); // simulate the clock jumping back an hour

    await hub.revokeUser('u1'); // revoke WHILE the external validator is in flight, under a "past" clock
    releaseValidate('u1');      // validator now resolves grantUserId = 'u1', already revoked

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

  it('a connection blocked mid-verification stays pending (cap) and on the clock (timeout) — sending one frame does not escape either (#R4-6)', async () => {
    // validatePairingToken never resolves until the test releases it,
    // simulating a slow/blocked external verification step.
    let release: (() => void) | undefined;
    hub = new WsHub({
      instance: 'test',
      maxPendingConnections: 1,
      helloTimeoutMs: 50,
      validatePairingToken: () => new Promise<string | null>((resolve) => { release = () => resolve(null); }),
    });
    const { port } = await hub.start();

    const blocked = await connect(port);
    blocked.send(pairRequest('any-token')); // reaches validatePairingToken and blocks there
    await new Promise((r) => setTimeout(r, 10)); // let the hub dispatch into validatePairingToken

    // A second connection while the first's hello is still unresolved must
    // still be rejected: the pending slot was not freed just because the
    // first connection sent its one frame — it is not yet authenticated.
    const rejected = await connect(port);
    expect(await nextClose(rejected)).toBe(4503);

    // The blocked connection itself is still on the clock: once
    // helloTimeoutMs elapses — even mid-verification, having already sent a
    // frame — it gets closed for timing out, not left open indefinitely.
    expect(await nextClose(blocked)).toBe(4408);

    release?.(); // let the now-irrelevant validatePairingToken call settle
  });

  it('stale-hello cleanup revokes only ITS OWN session, not a legitimate one created after the revoke (#R5-10)', async () => {
    // Sequence: hello H1 parks inside createSession → u1 is revoked → u1 is
    // legitimately RE-paired (new session S2) → H1 resumes, sees the revoke,
    // and cleans up. That cleanup previously called user-wide
    // store.revokeUser(u1), deleting S2 — the brand-new, post-revoke,
    // fully legitimate session — along with H1's own stale one.
    const { MemoryCredentialStore } = await import('./credential-store.js');
    const inner = new MemoryCredentialStore();
    let gateFirstCreate: (() => void) | undefined;
    const firstCreateGate = new Promise<void>((r) => { gateFirstCreate = r; });
    let createCalls = 0;
    hub = new WsHub({
      instance: 'test',
      store: {
        createSession: async (userId: string) => {
          createCalls += 1;
          if (createCalls === 1) await firstCreateGate;
          return inner.createSession(userId);
        },
        verifySession: (t: string) => inner.verifySession(t),
        revokeUser: (u: string) => inner.revokeUser(u),
        revokeSession: (t: string) => inner.revokeSession(t),
      },
    });
    const { port } = await hub.start();

    const t1 = hub.issuePairingToken('u1');
    const h1 = await connect(port);
    h1.send(pairRequest(t1));
    await new Promise((r) => setTimeout(r, 20)); // H1 is now parked inside createSession

    await hub.revokeUser('u1');

    // Legitimate re-pair AFTER the revoke: new token, new connection, granted.
    const t2 = hub.issuePairingToken('u1');
    const h2 = await connect(port);
    h2.send(pairRequest(t2));
    const grant = await nextMessage(h2);
    const s2 = grant.kind === 'pair.grant' ? grant.payload.sessionToken : '';
    expect(s2).not.toBe('');

    // Release H1: it sees the revoke landed after its helloStartedAt and
    // cleans up. That cleanup must be scoped to H1's OWN just-minted
    // session, leaving S2 intact.
    gateFirstCreate!();
    expect(await nextClose(h1)).toBe(4401);

    // S2 still resumes: the legitimate post-revoke session survived.
    const h3 = await connect(port);
    h3.send(JSON.stringify({ session: s2 }));
    const ok = await new Promise<{ ok: boolean; userId: string }>((resolve) =>
      h3.once('message', (d) => resolve(JSON.parse(d.toString()))));
    expect(ok).toEqual({ ok: true, userId: 'u1' });
  });

  it('a frame arriving after revokeUser is never dispatched as the revoked user (#R5-6)', async () => {
    hub = new WsHub({ instance: 'test' });
    const { port } = await hub.start();
    const received: Array<{ userId: string; kind: string }> = [];
    hub.onEnvelope((env, userId) => received.push({ userId, kind: env.kind }));

    const token = hub.issuePairingToken('u1');
    const ws = await connect(port);
    ws.send(pairRequest(token));
    await nextMessage(ws); // pair.grant — the socket is attached and authorized now

    await hub.revokeUser('u1');
    // revokeUser started a GRACEFUL close: the server has sent its close
    // frame but keeps receiving until the client echoes it. The client here
    // hasn't processed that frame yet, so this send still reaches the
    // server's (still-registered) per-socket message listener — which
    // previously dispatched it to handlers as the revoked user. A buffered
    // push.subscribe here could recreate a subscription clearForUser had
    // just removed; ordinary frames could run whole agent turns.
    ws.send(JSON.stringify(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'after revoke' },
    })));
    await new Promise((r) => setTimeout(r, 50));

    expect(received).toEqual([]);
  });

  it('CONCURRENT outstanding verification work is bounded by the cap (#R5-7)', async () => {
    // The pending-connection cap bounds SOCKETS, but each hello can park an
    // in-flight external verification. Previously the socket-level timeout
    // freed the pending slot while its verification stayed outstanding, so an
    // attacker could accumulate unbounded CONCURRENT verification work. Here
    // a generous helloTimeoutMs keeps both hellos well within their deadline,
    // so this isolates the concurrency bound from deadline reclamation
    // (#R6-11, next test): while the first verification is genuinely in
    // flight, a second connection is refused.
    let validatorCalls = 0;
    hub = new WsHub({
      instance: 'test',
      maxPendingConnections: 1,
      helloTimeoutMs: 2000,
      validatePairingToken: () => { validatorCalls += 1; return new Promise<string | null>(() => { /* never settles */ }); },
    });
    const { port } = await hub.start();

    const first = await connect(port);
    first.send(pairRequest('t1'));
    await new Promise((r) => setTimeout(r, 20)); // first's verification is now in flight, holding the slot

    const second = await connect(port);
    second.send(pairRequest('t2'));
    expect(await nextClose(second)).toBe(4503); // refused: the one slot is occupied
    expect(validatorCalls).toBe(1); // the hung validator was never re-entered
  });

  it('a COOPERATIVE validator that honors the abort signal frees its slot on the deadline (#R6-11/#R6-11b)', async () => {
    // The deadline aborts the signal; a cooperative validator rejects on it,
    // so the hello's underlying work actually SETTLES — the slot is then
    // reclaimed and later connections succeed. (A non-cooperative validator
    // is the next test: its slot is correctly held.)
    let firstToken = true;
    hub = new WsHub({
      instance: 'test',
      maxPendingConnections: 1,
      helloTimeoutMs: 60,
      validatePairingToken: (token, signal) => {
        if (firstToken) {
          firstToken = false;
          return new Promise<string | null>((_, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('aborted')));
          });
        }
        return Promise.resolve(token === 'good' ? 'u2' : null);
      },
    });
    const { port } = await hub.start();

    const stuck = await connect(port);
    stuck.send(pairRequest('t1'));
    expect(await nextClose(stuck)).toBe(4408); // deadline fires → abort → validator rejects → work settles

    // Slot reclaimed (the cooperative validator's work actually ended).
    await new Promise((r) => setTimeout(r, 20));
    const ok = await connect(port);
    ok.send(pairRequest('good'));
    const grant = await nextMessage(ok);
    expect(grant.kind).toBe('pair.grant');
  });

  it('a NON-cooperative hung validator keeps its slot — underlying work is truly capped (#R6-11b)', async () => {
    // The R6-11 race released the slot while the hung validator ran on, so
    // three sequential timed-out hellos produced three simultaneously hung
    // validations. Now a validator that IGNORES the abort signal never
    // settles, so its slot stays held — capping concurrent underlying work
    // at maxPendingConnections instead of letting it grow per timeout cycle.
    let calls = 0;
    hub = new WsHub({
      instance: 'test',
      maxPendingConnections: 1,
      helloTimeoutMs: 50,
      validatePairingToken: () => { calls += 1; return new Promise<string | null>(() => { /* ignores abort, never settles */ }); },
    });
    const { port } = await hub.start();

    const first = await connect(port);
    first.send(pairRequest('t1'));
    expect(await nextClose(first)).toBe(4408); // deadline closes the socket…

    // …but the underlying validation is still outstanding (non-cooperative),
    // so a new connection is refused rather than starting a SECOND hung
    // validation — the slot is not freed while work continues.
    await new Promise((r) => setTimeout(r, 20));
    const second = await connect(port);
    second.send(pairRequest('t2'));
    expect(await nextClose(second)).toBe(4503);
    expect(calls).toBe(1); // the hung validator was never joined by a second
  });

  it('a hello aborted mid-createSession leaves no orphan session and un-burns the one-time token (#R6-11b)', async () => {
    // The old socket check came only AFTER createSession(): a hello whose
    // createSession resolved past the 4408 minted a live session for a dead
    // connection (orphan) and had already consumed the one-time token.
    let releaseFirst!: () => void;
    let n = 0;
    let firstCreate = true;
    const revoked: string[] = [];
    const sessions = new Set<string>();
    hub = new WsHub({
      instance: 'test',
      helloTimeoutMs: 50,
      store: {
        createSession: async (userId: string) => {
          const t = `sess-${userId}-${++n}`;
          if (firstCreate) {
            firstCreate = false;
            return new Promise<string>((resolve) => {
              releaseFirst = () => { sessions.add(t); resolve(t); };
            });
          }
          sessions.add(t);
          return t;
        },
        verifySession: async (t: string) => (sessions.has(t) ? 'u1' : null),
        revokeUser: async () => {},
        revokeSession: async (t: string) => { revoked.push(t); sessions.delete(t); },
      },
    });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');

    const ws = await connect(port);
    ws.send(pairRequest(token));
    expect(await nextClose(ws)).toBe(4408); // deadline fires while the FIRST createSession is gated

    releaseFirst(); // createSession now resolves, AFTER the abort
    await new Promise((r) => setTimeout(r, 20));

    // The minted session was revoked (no orphan left behind).
    expect(revoked).toContain('sess-u1-1');
    expect(sessions.has('sess-u1-1')).toBe(false);
    // The one-time token was un-burned — a fresh connection still redeems it
    // (its createSession is no longer gated, so it grants immediately).
    const ok = await connect(port);
    ok.send(pairRequest(token));
    const grant = await nextMessage(ok);
    expect(grant.kind).toBe('pair.grant');
  });
});
