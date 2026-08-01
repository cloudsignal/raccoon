// adapters/connector-nanoclaw/src/nanoclaw-e2e.test.ts
//
// END-TO-END workflow test for the NanoClaw connector: a REAL WsClientTransport
// (the simulated PWA) over a real WebSocket against the REAL adapter — real
// createRaccoonEndpoint (WsHub + RaccoonBridge + pairing + FileCredentialStore)
// and the real admin listener. The ONLY fake is the NanoClaw HOST on the far
// side of the ChannelAdapter seam (createFakeHost), which records onInbound /
// onAction exactly as their container manager would.
//
// Sequential `it` blocks share ONE adapter lifecycle (ports, data dir, paired
// client) and walk the DoD workflow in order:
//   setup → admin /pair + PWA pair handshake → chat turn (park + settle) →
//   async fallback deliver → ask_question card → approval tap resolves to the
//   option VALUE → restart from the same data dir + session resume (no
//   re-pair) → admin /revoke rejects the old session.
//
// Client-side patterns (WsClientTransport construction, onGrant/onEnvelope,
// resume, 4401 rejection) mirror connector-openclaw/src/openclaw-e2e.test.ts —
// the known-good reference.

import { mkdtempSync, rmSync } from 'node:fs';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createEnvelope, type AnyEnvelope } from '@raccoon/protocol';
import { WsClientTransport } from '@raccoon/transport-ws';
import { createRaccoonChannelAdapter } from './adapter.js';
import { createFakeHost, type FakeHost } from './test-helpers/fake-host.js';
import type { ChannelAdapter, ChannelSetup, InboundChatContent } from './nanoclaw-types.js';

const ADMIN_SECRET = 'e2e-admin-secret';
const USER_ID = 'u1';
const CHANNEL = 'assistant';
const PLATFORM_ID = `${CHANNEL}:${USER_ID}`;

/** Bind a throwaway server to port 0, read the assigned port, release it. */
async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createNetServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

async function waitUntil(fn: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitUntil: condition not met within ${ms}ms`);
}

function userMsg(text: string): AnyEnvelope {
  return createEnvelope('msg', {
    from: `user:${USER_ID}`, to: `agent:${CHANNEL}`, channel: CHANNEL, payload: { text },
  });
}

function approvalResponse(refId: string, choice: string): AnyEnvelope {
  return createEnvelope('approval.response', {
    from: `user:${USER_ID}`, to: `agent:${CHANNEL}`, channel: CHANNEL, payload: { refId, choice },
  });
}

const isApprovalRequest = (e: AnyEnvelope): e is Extract<AnyEnvelope, { kind: 'approval.request' }> =>
  e.kind === 'approval.request';

const CARD_CONTENT = {
  type: 'ask_question',
  questionId: 'q-1',
  title: 'Allow?',
  question: '',
  options: [
    { label: 'Allow', selectedLabel: 'Allow', value: 'allow-v' },
    { label: 'Deny', selectedLabel: 'Deny', value: 'deny-v' },
  ],
};

describe('NanoClaw connector e2e (real adapter + endpoint + admin + PWA client; fake host)', () => {
  let dataDir: string;
  let hubPort: number;
  let adminPort: number;
  let env: Record<string, string>;

  let host: FakeHost;
  let setupCallbacks: ChannelSetup;
  // Resolved (and re-armed by nextInbound) each time the wrapped onInbound fires.
  let inboundResolvers: Array<() => void> = [];

  let adapter: ChannelAdapter; // the CURRENT adapter (swapped at restart)
  const clients: WsClientTransport[] = [];
  let received: AnyEnvelope[] = []; // envelopes seen by the CURRENT client
  let session = ''; // sessionToken granted at pairing — the resume credential

  function nextInbound(): Promise<void> {
    return new Promise((r) => inboundResolvers.push(r));
  }

  function newClient(opts: ConstructorParameters<typeof WsClientTransport>[0]): WsClientTransport {
    const client = new WsClientTransport(opts);
    clients.push(client);
    received = [];
    const sink = received;
    client.onEnvelope((e) => sink.push(e));
    return client;
  }

  async function adminPost(path: '/pair' | '/revoke', body: unknown): Promise<Response> {
    return fetch(`http://127.0.0.1:${adminPort}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_SECRET}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  beforeAll(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'rc-nanoclaw-e2e-'));
    hubPort = await freePort();
    adminPort = await freePort();
    env = {
      RACCOON_PORT: String(hubPort),
      RACCOON_ADMIN_PORT: String(adminPort),
      RACCOON_INSTANCE_URL: `ws://127.0.0.1:${hubPort}`,
      RACCOON_PUBLIC_ORIGIN: `http://127.0.0.1:${hubPort}`,
      RACCOON_CHANNELS: `${CHANNEL}=main-group`,
      RACCOON_ADMIN_SECRET: ADMIN_SECRET,
      RACCOON_DATA_DIR: dataDir,
      // Low-ish so an accidentally-unsettled turn cannot stall the per-
      // conversation serialization for long; the flow settles turns promptly.
      RACCOON_TURN_TIMEOUT_MS: '2000',
    };

    host = createFakeHost();
    // The host hands setup() all four callbacks; the fake covers the two the
    // connector consumes, wrapped so the test can await inbound arrival.
    setupCallbacks = {
      onInbound: (platformId, threadId, message) => {
        host.callbacks.onInbound(platformId, threadId, message);
        for (const r of inboundResolvers.splice(0)) r();
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: host.callbacks.onAction,
    };

    adapter = createRaccoonChannelAdapter({ env })!;
    expect(adapter).not.toBeNull();
  });

  afterAll(async () => {
    await Promise.all(clients.map((c) => c.close().catch(() => {})));
    clients.length = 0;
    await adapter?.teardown().catch(() => {});
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('setup() starts the hub and admin listener; isConnected() is true', async () => {
    await adapter.setup(setupCallbacks);
    expect(adapter.isConnected()).toBe(true);
  });

  it('pairs through the admin listener and completes the PWA pair handshake', async () => {
    const res = await adminPost('/pair', { userId: USER_ID });
    expect(res.status).toBe(200);
    const { token } = (await res.json()) as { token: string };
    expect(token.length).toBeGreaterThan(0);

    const client = newClient({ url: `ws://127.0.0.1:${hubPort}/`, pairingToken: token, device: 'iphone' });
    client.onGrant((g) => { session = g.payload.sessionToken; });
    await client.connect();
    expect(session.length).toBeGreaterThan(0);
  });

  it('routes a chat message to the host and settles the parked turn with the reply', async () => {
    const client = clients.at(-1)!;
    const arrival = nextInbound();
    await client.send(userMsg('hi'));
    await arrival;

    const rec = host.inbound.at(-1)!;
    expect(rec.platformId).toBe(PLATFORM_ID);
    expect(rec.threadId).toBeNull();
    expect(rec.message.isMention).toBe(true);
    expect(rec.message.isGroup).toBe(false);
    expect(rec.message.id.length).toBeGreaterThan(0);
    expect(rec.message.timestamp.length).toBeGreaterThan(0);
    const content = rec.message.content as InboundChatContent;
    expect(content.text).toBe('hi');
    expect(content.senderId).toBe(USER_ID);

    await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: 'reply-1' } });
    await waitUntil(() => received.some((e) => e.kind === 'msg' && e.payload.text === 'reply-1'));
  });

  it('delivers a follow-up with no open turn through the async fallback', async () => {
    // The previous turn settled — nothing is parked. deliver() must still
    // reach the connected client via sendAgentEnvelope.
    await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: 'reply-2' } });
    await waitUntil(() => received.some((e) => e.kind === 'msg' && e.payload.text === 'reply-2'));
  });

  it('renders an ask_question card, resolves the tap to the option VALUE, settles the follow-up', async () => {
    const client = clients.at(-1)!;
    const arrival = nextInbound();
    await client.send(userMsg('do the thing'));
    await arrival;

    // The card IS the answer to the parked turn: deliver ends it silently and
    // sends one approval.request carrying the labels.
    received.length = 0;
    await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: CARD_CONTENT });
    await waitUntil(() => received.some(isApprovalRequest));
    const card = received.find(isApprovalRequest)!;
    expect(card.payload.refId).toBe('q-1');
    expect(card.payload.title).toBe('Allow?');
    expect(card.payload.options).toEqual(['Allow', 'Deny']);

    // Tap "Allow" → the host's onAction receives the option VALUE, not the label.
    await client.send(approvalResponse('q-1', 'Allow'));
    await waitUntil(() => host.actions.length > 0);
    expect(host.actions[0]).toEqual({ questionId: 'q-1', selectedOption: 'allow-v', userId: USER_ID });

    // The approval turn parks awaiting the agent's follow-up; deliver settles it.
    await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: 'done' } });
    await waitUntil(() => received.some((e) => e.kind === 'msg' && e.payload.text === 'done'));
  });

  it('restarts from the same data dir and resumes the stored session without re-pairing', async () => {
    await clients.at(-1)!.close();
    await adapter.teardown();
    expect(adapter.isConnected()).toBe(false);

    // A SECOND adapter from the SAME env — same ports, same RACCOON_DATA_DIR,
    // a fresh FileCredentialStore instance reading the persisted sessions.json
    // (models a new process, exactly as a NanoClaw host restart would).
    adapter = createRaccoonChannelAdapter({ env })!;
    await adapter.setup(setupCallbacks);
    expect(adapter.isConnected()).toBe(true);

    // The PWA reconnects with the session it stored — resumes, no re-pair.
    const resumed = newClient({ url: `ws://127.0.0.1:${hubPort}/`, session });
    await resumed.connect();

    const arrival = nextInbound();
    await resumed.send(userMsg('after-restart'));
    await arrival;
    expect(host.inbound.at(-1)!.platformId).toBe(PLATFORM_ID);
    await adapter.deliver(PLATFORM_ID, null, { kind: 'chat', content: { text: 'reply-after-restart' } });
    await waitUntil(() => received.some((e) => e.kind === 'msg' && e.payload.text === 'reply-after-restart'));
  });

  it('revokes the user via the admin listener; the old session no longer resumes', async () => {
    await clients.at(-1)!.close();
    const res = await adminPost('/revoke', { userId: USER_ID });
    expect(res.status).toBe(200);

    // The stored session no longer verifies → the hub closes 4401 and the
    // client, seeing an auth-coded close, rejects instead of reconnecting.
    const stale = new WsClientTransport({ url: `ws://127.0.0.1:${hubPort}/`, session });
    clients.push(stale);
    await expect(stale.connect()).rejects.toThrow(/4401/);
  });
});
