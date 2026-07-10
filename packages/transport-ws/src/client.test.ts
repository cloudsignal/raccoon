import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type AnyEnvelope, type TransportStatus } from '@raccoon/protocol';
import { WsHub } from './hub.js';
import { WsClientTransport } from './client.js';

let hub: WsHub;
let client: WsClientTransport;
afterEach(async () => { await client?.close(); await hub?.stop(); });

function msgTo(agent: string, text: string): AnyEnvelope {
  return createEnvelope('msg', {
    from: 'user:u1', to: `agent:${agent}`, channel: agent, payload: { text },
  });
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
});
