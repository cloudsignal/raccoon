import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type AnyEnvelope, type TransportStatus } from '@raccoon/protocol';
import WebSocket from 'ws';
import { WsHub } from './hub.js';
import { WsClientTransport, type WsClientOptions } from './client.js';

let hub: WsHub;
let client: WsClientTransport;
afterEach(async () => { await client?.close(); await hub?.stop(); });

function msgTo(agent: string, text: string): AnyEnvelope {
  return createEnvelope('msg', {
    from: 'user:u1', to: `agent:${agent}`, channel: agent, payload: { text },
  });
}

// A client-side WebSocket ctor that DROPS incoming `pair.confirmed` frames,
// simulating a confirm ACK lost in transit AFTER the hub already durably
// promoted the session. Everything else passes through to a real `ws` socket.
type WsImpl = NonNullable<WsClientOptions['WebSocketImpl']>;
function dropConfirmedWs(): WsImpl {
  class DropConfirmed {
    private ws: WebSocket;
    constructor(url: string) { this.ws = new WebSocket(url); }
    get readyState(): number { return this.ws.readyState; }
    send(data: string): void { this.ws.send(data); }
    close(code?: number, reason?: string): void { this.ws.close(code, reason); }
    addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void {
      if (type === 'message') {
        this.ws.addEventListener('message', (event: { data: unknown }) => {
          try {
            const parsed = JSON.parse(String(event.data)) as { kind?: string };
            if (parsed?.kind === 'pair.confirmed') return; // dropped in transit
          } catch { /* non-JSON — pass through */ }
          listener(event);
        });
      } else {
        this.ws.addEventListener(type as 'open', listener as () => void);
      }
    }
  }
  return DropConfirmed as unknown as WsImpl;
}

describe('WsClientTransport', () => {
  it('pairs, reports open, and round-trips envelopes', async () => {
    hub = new WsHub({ instance: 'test', channels: ['coordinator'] });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');

    const statuses: TransportStatus[] = [];
    client = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, pairingToken: token, device: 'vitest' });
    client.onStatus((s) => statuses.push(s));

    let granted = '';
    client.onGrant((g) => { granted = g.payload.sessionToken; });

    const fromHub: AnyEnvelope[] = [];
    client.onEnvelope((env) => fromHub.push(env));

    const fromClient = new Promise<AnyEnvelope>((resolve) =>
      hub.onEnvelope((env) => resolve(env)));

    await client.connect();
    expect(statuses).toContain('open');
    expect(granted.length).toBeGreaterThan(20);

    await client.send(msgTo('coordinator', 'hi'));
    const received = await fromClient;
    expect(received.kind).toBe('msg');

    hub.sendToUser('u1', createEnvelope('ack', {
      from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
      payload: { refId: received.id, status: 'received' },
    }));
    await new Promise((r) => setTimeout(r, 100));
    expect(fromHub.map((e) => e.kind)).toContain('ack');
  });

  it('connect() does NOT report open until the hub ACKs pair.confirmed (deferred success, #R10)', async () => {
    // A store that never promotes → the hub never sends pair.confirmed, so a
    // transient confirm/store failure must surface as a NON-open connection,
    // not a false "paired".
    const sessions = new Map<string, string>();
    hub = new WsHub({
      instance: 'test',
      store: {
        createSession: async (u: string) => { const t = `tok-${u}`; sessions.set(t, u); return t; },
        verifySession: async (t: string) => sessions.get(t) ?? null,
        confirmSession: async () => false, // never promotes → never ACKs
        revokeUser: async () => {},
      },
    });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');
    client = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, pairingToken: token, device: 'vitest' });
    const statuses: TransportStatus[] = [];
    client.onStatus((s) => statuses.push(s));
    let resolved = false;
    const connectP = client.connect().then(() => { resolved = true; }).catch(() => { /* rejects on close */ });
    await new Promise((r) => setTimeout(r, 150)); // ample for grant + confirm round-trip
    expect(resolved).toBe(false); // no pair.confirmed → success deferred
    expect(statuses).not.toContain('open');
    await client.close();
    await connectP;
  });

  it('resumes with a session token', async () => {
    hub = new WsHub({ instance: 'test' });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');

    const first = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, pairingToken: token, device: 'vitest' });
    let session = '';
    first.onGrant((g) => { session = g.payload.sessionToken; });
    await first.connect();
    await first.close();

    client = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, session });
    await client.connect();
    await client.send(msgTo('coordinator', 'resumed'));
  });

  it('does not reconnect after 4401', async () => {
    hub = new WsHub({ instance: 'test' });
    const { port } = await hub.start();
    client = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, session: 'bogus' });
    await expect(client.connect()).rejects.toThrow(/4401/);
  });

  it('send() rejects while closed', async () => {
    hub = new WsHub({ instance: 'test' });
    const { port } = await hub.start();
    client = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, session: 'x' });
    await expect(client.send(msgTo('coordinator', 'nope'))).rejects.toThrow(/not open/);
  });

  it('reconnects with session after the hub restarts on the same port', async () => {
    const first = new WsHub({ instance: 'test' });
    const { port } = await first.start();
    const token = first.issuePairingToken('u1');

    client = new WsClientTransport({
      url: `ws://127.0.0.1:${port}/`, pairingToken: token, device: 'vitest', maxBackoffMs: 500,
    });
    let session = '';
    client.onGrant((g) => { session = g.payload.sessionToken; });
    await client.connect();
    expect(session.length).toBeGreaterThan(20);

    // Subscribe to onStatus BEFORE starting the new hub so we don't miss a fast reconnect.
    const reopened = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      client.onStatus((s) => { if (s === 'open') { clearTimeout(timer); resolve(true); } });
    });

    // Restart a hub on the same port with a store that recognizes the session.
    await first.stop();
    hub = new WsHub({ instance: 'test', port, store: {
      createSession: async () => { throw new Error('unused'); },
      verifySession: async (t) => (t === session ? 'u1' : null),
      confirmSession: async () => true,
      revokeUser: async () => {},
    }});
    await hub.start();

    // Wait for the client's backoff to re-dial and resume.
    expect(await reopened).toBe(true);

    const echoed = new Promise<AnyEnvelope>((resolve) => hub.onEnvelope((env) => resolve(env)));
    await client.send(msgTo('coordinator', 'after-restart'));
    const got = await echoed;
    expect(got.kind).toBe('msg');
  });

  it('recovers a LOST pair.confirmed by resuming the durably-adopted session, with no ghost session (#R10)', async () => {
    // The hub DOES promote (confirmSession → true) and sends pair.confirmed,
    // but the client's socket drops that frame. The client must NOT hang and
    // must NOT re-pair: it closes the socket on the confirm-ack timeout, then
    // reconnects RESUMING the session it adopted at grant time — the same one
    // the hub durably promoted. No second createSession (no ghost session).
    let createCount = 0;
    const sessions = new Map<string, string>();
    hub = new WsHub({
      instance: 'test',
      store: {
        createSession: async (u: string) => {
          createCount += 1;
          const t = `sess-${u}-${createCount}`;
          sessions.set(t, u);
          return t;
        },
        verifySession: async (t: string) => sessions.get(t) ?? null,
        confirmSession: async () => true, // durably promotes → hub emits pair.confirmed
        revokeUser: async () => {},
      },
    });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');

    client = new WsClientTransport({
      url: `ws://127.0.0.1:${port}/`,
      pairingToken: token,
      device: 'vitest',
      WebSocketImpl: dropConfirmedWs(), // pair.confirmed never reaches the client
      confirmAckTimeoutMs: 200,         // fire the lost-ACK recovery fast (vs 10s default)
      maxBackoffMs: 300,
    });

    // Capture grants: recovery MUST re-surface the adopted grant so a host that
    // paired learns the session token (persists it, reports paired). Without it,
    // the socket opens but the pairing is a ghost (durable server session, no
    // client-side session) — the exact defect this test guards.
    const grants: string[] = [];
    client.onGrant((g) => grants.push(g.payload.sessionToken));

    const opened = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      client.onStatus((s) => { if (s === 'open') { clearTimeout(timer); resolve(true); } });
    });

    // The FIRST dial rejects: with pair.confirmed dropped, the confirm-ack timer
    // closes the socket and connect() rejects on that handshake-phase close.
    // Recovery happens on the background reconnect.
    await client.connect().catch(() => { /* expected: lost ACK closes the first dial */ });

    // The reconnect resumes the adopted+promoted session and reports open — with
    // exactly ONE createSession (the initial provisional), proving no ghost and
    // that the client resumed rather than re-paired.
    expect(await opened).toBe(true);
    expect(createCount).toBe(1);

    // The grant was surfaced exactly once, carrying the durably-promoted session
    // token — so a host can persist it and report a real (non-ghost) pairing.
    expect(grants).toEqual(['sess-u1-1']);

    // The resumed connection is fully live: the hub receives a subsequent send.
    const echoed = new Promise<AnyEnvelope>((resolve) => hub.onEnvelope((env) => resolve(env)));
    await client.send(msgTo('coordinator', 'after-recovery'));
    expect((await echoed).kind).toBe('msg');
  });

  it('awaits onAdoptGrant BEFORE sending pair.confirm — durable adoption precedes server confirmation (#P1-B)', async () => {
    const confirmCalls: string[] = [];
    const sessions = new Map<string, string>();
    hub = new WsHub({
      instance: 'test',
      store: {
        createSession: async (u: string) => { const t = `tok-${u}`; sessions.set(t, u); return t; },
        verifySession: async (t: string) => sessions.get(t) ?? null,
        confirmSession: async (t: string) => { confirmCalls.push(t); return true; },
        revokeUser: async () => {},
      },
    });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');
    let releaseAdopt!: () => void;
    const adoptGate = new Promise<void>((r) => { releaseAdopt = r; });
    let adoptCalled = false;
    client = new WsClientTransport({
      url: `ws://127.0.0.1:${port}/`, pairingToken: token, device: 'vitest',
      onAdoptGrant: async () => { adoptCalled = true; await adoptGate; },
    });
    const connectP = client.connect();
    await new Promise((r) => setTimeout(r, 100)); // grant arrived; onAdoptGrant is now gating
    expect(adoptCalled).toBe(true);
    expect(confirmCalls).toEqual([]); // NOT confirmed yet — the server must not promote before durable adoption
    releaseAdopt(); // durable adoption completes → the client may now confirm
    await connectP;
    expect(confirmCalls).toEqual(['tok-u1']); // confirmed exactly once (the session token), AFTER adoption
  });

  it('an onAdoptGrant rejection aborts pairing — the server never promotes the session (#P1-B)', async () => {
    const confirmCalls: string[] = [];
    hub = new WsHub({
      instance: 'test',
      store: {
        createSession: async (u: string) => `tok-${u}`,
        verifySession: async () => null, // provisional never resumable
        confirmSession: async (t: string) => { confirmCalls.push(t); return true; },
        revokeUser: async () => {},
      },
    });
    const { port } = await hub.start();
    const token = hub.issuePairingToken('u1');
    client = new WsClientTransport({
      url: `ws://127.0.0.1:${port}/`, pairingToken: token, device: 'vitest', confirmAckTimeoutMs: 200,
      onAdoptGrant: async () => { throw new Error('persist failed'); },
    });
    await expect(client.connect()).rejects.toThrow();
    await new Promise((r) => setTimeout(r, 150));
    expect(confirmCalls).toEqual([]); // adoption failed → confirm never sent → server never promotes (no ghost)
  });

  it('reconnects a session-backed client that starts while the hub is down (#4 offline-start)', async () => {
    // Prime a real session, then take the hub down so the next client starts offline.
    const first = new WsHub({ instance: 'test' });
    const { port } = await first.start();
    const token = first.issuePairingToken('u1');
    const primer = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, pairingToken: token, device: 'vitest' });
    let session = '';
    primer.onGrant((g) => { session = g.payload.sessionToken; });
    await primer.connect();
    await primer.close();
    await first.stop(); // hub is now DOWN

    // A session-backed client that has NEVER opened. Before the fix this never
    // retried (the handshake-phase close returned before scheduleReconnect, which
    // itself only ran for wasOpen || everOpened).
    client = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, session, maxBackoffMs: 300 });
    const reopened = new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), 5_000);
      client.onStatus((s) => { if (s === 'open') { clearTimeout(timer); resolve(true); } });
    });
    // The first dial fails (hub down); the reconnect loop must keep trying.
    await client.connect().catch(() => { /* expected: initial dial fails while offline */ });

    // Bring the hub back up on the same port with a store that knows the session.
    hub = new WsHub({ instance: 'test', port, store: {
      createSession: async () => { throw new Error('unused'); },
      verifySession: async (t) => (t === session ? 'u1' : null),
      confirmSession: async () => true,
      revokeUser: async () => {},
    }});
    await hub.start();

    expect(await reopened).toBe(true);
  });
});
