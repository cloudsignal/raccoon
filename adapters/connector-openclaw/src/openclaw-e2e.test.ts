// adapters/connector-openclaw/src/openclaw-e2e.test.ts
//
// END-TO-END workflow test for the OpenClaw connector, driven through its REAL
// public seams wired to a REAL WsHub + REAL WsClientTransport over a real
// WebSocket on an ephemeral port:
//
//   createRaccoonChannel  (real hub + bridge + pairing + push wiring)
//   buildRaccoonInboundRunner  (real inbound runner → real ReplyDispatcher)
//   createRaccoonOutbound      (real presentation → approval.request rendering)
//   createApprovalValueStore   (real Allow/Deny/Edit correlation + reservation)
//   issuePairing / WsClientTransport  (real QR/token pairing + resume)
//
// The ONLY thing stubbed is `dispatchReplyFromConfigWithSettledDispatcher` — the
// one call that would invoke a live model. openclaw@2026.6.11 ships no
// deterministic/echo model provider (its only provider is 'anthropic'), so a
// real model turn cannot run in CI. The stub still drives the connector's
// REAL dispatcher (buildDispatcher in inbound.ts) with REAL ReplyPayload shapes,
// and it captures the FinalizedMsgContext.Body the connector actually hands
// OpenClaw — so the approval-resolution assertions verify the real inbound
// pipeline, not a mock of it. Types are the real OpenClaw published types
// (MessagePresentation, ChannelOutboundPayloadContext, ReplyPayload,
// FinalizedMsgContext) — there are no handwritten shims here.
//
// Covers the DoD workflow: pair the PWA → send a message → reply (final reply
// only; the connector forwards sendFinalReply, not block/tool chunks — the
// client receives ONE concatenated msg, not incremental streaming) →
// approval request → Allow / Deny / Edit → disconnect + reconnect → restart the
// connector and resume the stored session → unpair and reject the old session.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type AnyEnvelope } from '@raccoon/protocol';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WsClientTransport, FileCredentialStore, type CredentialStore } from '@raccoon/transport-ws';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import type { ChannelOutboundPayloadContext } from 'openclaw/plugin-sdk/channel-runtime';
import type { MessagePresentation, MessagePresentationButton } from 'openclaw/plugin-sdk/interactive-runtime';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-runtime';
import type { DispatchFromConfigResult } from './openclaw-missing-types.js';

// Stub only the live-model call (see header). vi.mock is hoisted above imports.
vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchReplyFromConfigWithSettledDispatcher: vi.fn(),
}));
const { dispatchReplyFromConfigWithSettledDispatcher } = await import('openclaw/plugin-sdk/channel-inbound');
const mockDispatch = vi.mocked(dispatchReplyFromConfigWithSettledDispatcher);

// Connector under test (real code; picks up the hoisted mock via inbound.ts).
import { buildRaccoonInboundRunner } from './inbound.js';
import { createRaccoonChannel } from './plugin.js';
import { createRaccoonOutbound } from './outbound.js';
import { createApprovalValueStore } from './approval-values.js';
import { buildRaccoonExecPendingPayload, buildRaccoonExecResolvedPayload } from './approval-render.js';

// The opaque config the runner passes to (mocked) dispatch — never read here.
const cfg = {} as OpenClawConfig;

// Every FinalizedMsgContext.Body the connector handed OpenClaw, in order. The
// approval assertions read this to prove the real inbound resolution ran.
let dispatchedBodies: string[] = [];

beforeEach(() => {
  dispatchedBodies = [];
  // The stubbed turn echoes the resolved Body back through the REAL dispatcher.
  mockDispatch.mockImplementation(async ({ ctxPayload, dispatcher }) => {
    const body = ctxPayload.Body ?? '';
    dispatchedBodies.push(body);
    dispatcher.sendFinalReply({ text: `reply:${body}` } as ReplyPayload);
    dispatcher.markComplete();
    return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } } as DispatchFromConfigResult;
  });
});

// ---------------------------------------------------------------------------
// Lifecycle tracking + cleanup
// ---------------------------------------------------------------------------

type Channel = ReturnType<typeof createRaccoonChannel>;
const channels: Channel[] = [];
const clients: WsClientTransport[] = [];
const storeFilesToClean: string[] = [];

afterEach(async () => {
  await Promise.all(clients.map((c) => c.close().catch(() => {})));
  clients.length = 0;
  await Promise.all(channels.map((c) => c.stop().catch(() => {})));
  channels.length = 0;
  for (const d of storeFilesToClean.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Stand up the connector: real runner + real channel (+ real outbound). */
function buildConnector(opts: { port?: number; sessionStore?: CredentialStore } = {}) {
  const approvalValues = createApprovalValueStore();
  const runner = buildRaccoonInboundRunner({
    cfg, storePath: '/tmp/raccoon-e2e', agentId: 'coordinator', accountId: 'default', approvalValues,
  });
  const channel = createRaccoonChannel({
    instance: 'e2e',
    instanceUrl: 'ws://127.0.0.1/',
    port: opts.port ?? 0,
    channels: ['coordinator'],
    runner,
    ...(opts.sessionStore ? { sessionStore: opts.sessionStore } : {}),
  });
  channels.push(channel);
  const outbound = createRaccoonOutbound({ hub: channel.hub, channel: 'coordinator', approvalValues });
  return { channel, outbound, approvalValues };
}

function userMsg(text: string): AnyEnvelope {
  return createEnvelope('msg', {
    from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text },
  });
}

function approvalResponse(refId: string, choice: string, editedText?: string): AnyEnvelope {
  return createEnvelope('approval.response', {
    from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator',
    payload: { refId, choice, ...(editedText !== undefined ? { editedText } : {}) },
  });
}

/** A ChannelOutboundPayloadContext carrying a real MessagePresentation with a
 *  buttons block — exactly what OpenClaw hands the outbound adapter at an
 *  exec-approval gate. Constructed like outbound.test.ts (plain object). */
function approvalCtx(title: string, buttons: MessagePresentationButton[]): ChannelOutboundPayloadContext {
  const presentation = {
    title,
    blocks: [
      { type: 'text', text: title },
      { type: 'buttons', buttons },
    ],
  } satisfies MessagePresentation;
  return { cfg, to: 'user:u1', text: title, payload: { text: title, presentation } } as ChannelOutboundPayloadContext;
}

async function waitUntil(fn: () => boolean, ms = 4000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitUntil: condition not met within ${ms}ms`);
}

function newClient(opts: ConstructorParameters<typeof WsClientTransport>[0]): { client: WsClientTransport; received: AnyEnvelope[] } {
  const client = new WsClientTransport(opts);
  clients.push(client);
  const received: AnyEnvelope[] = [];
  client.onEnvelope((e) => received.push(e));
  return { client, received };
}

const isApprovalRequest = (e: AnyEnvelope): e is Extract<AnyEnvelope, { kind: 'approval.request' }> =>
  e.kind === 'approval.request';

/** Send an approval presentation and return the refId the client received. */
async function raiseApproval(
  outbound: ReturnType<typeof createRaccoonOutbound>,
  received: AnyEnvelope[],
  title: string,
  suffix: string,
): Promise<string> {
  received.length = 0;
  await outbound.sendPayload!(approvalCtx(title, [
    { label: 'Allow', action: { type: 'command', command: `approve ${suffix} allow-once` } },
    { label: 'Deny', action: { type: 'command', command: `deny ${suffix}` } },
  ]));
  await waitUntil(() => received.some(isApprovalRequest));
  return received.find(isApprovalRequest)!.payload.refId;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('OpenClaw connector e2e (real hub + client + connector; only the model call stubbed)', () => {
  it('pairs, receives a reply, resolves Allow/Deny/Edit approvals, then reconnects', async () => {
    const { channel, outbound } = buildConnector();
    const { port } = await channel.start();

    // 1. Generate a pairing QR/token (real @raccoon/pairing path).
    const pairing = await channel.pair('u1');
    expect(pairing.token.length).toBeGreaterThan(0);
    expect(pairing.qr.length).toBeGreaterThan(0);

    // 2. Pair the PWA — real WsClientTransport over a real WebSocket.
    const { client, received } = newClient({ url: `ws://127.0.0.1:${port}/`, pairingToken: pairing.token, device: 'iphone' });
    let session = '';
    client.onGrant((g) => { session = g.payload.sessionToken; });
    await client.connect();
    expect(session.length).toBeGreaterThan(0);

    // 3. Send a message → reply (msg → bridge → runner → dispatcher → one msg).
    await client.send(userMsg('hi'));
    await waitUntil(() => received.some((e) => e.kind === 'msg' && e.payload.text === 'reply:hi'));

    // 4 + 5a. Approval request → ALLOW resolves to the REAL /command.
    const refAllow = await raiseApproval(outbound, received, 'Deploy deploy-42 to prod?', 'deploy-42');
    expect(received.find(isApprovalRequest)!.payload.options).toEqual(['Allow', 'Deny']);
    dispatchedBodies.length = 0;
    await client.send(approvalResponse(refAllow, 'Allow'));
    await waitUntil(() => dispatchedBodies.includes('/approve deploy-42 allow-once'));

    // 5b. DENY (fresh approval — a resolve is one-shot) → the REAL deny command.
    const refDeny = await raiseApproval(outbound, received, 'Deploy deploy-43?', 'deploy-43');
    dispatchedBodies.length = 0;
    await client.send(approvalResponse(refDeny, 'Deny'));
    await waitUntil(() => dispatchedBodies.includes('/deny deploy-43'));

    // 5c. EDIT → free text, correlated to its refId (validated, not executed).
    const refEdit = await raiseApproval(outbound, received, 'Deploy deploy-44?', 'deploy-44');
    dispatchedBodies.length = 0;
    await client.send(approvalResponse(refEdit, 'Allow', 'hold off until tomorrow'));
    await waitUntil(() => dispatchedBodies.some((b) => b.includes('hold off until tomorrow') && b.includes(`refId=${refEdit}`)));
    // An edit is delivered as text, NEVER as an executable slash command.
    expect(dispatchedBodies.every((b) => !b.startsWith('/'))).toBe(true);

    // 6. Disconnect, then reconnect with the stored session and keep chatting.
    await client.close();
    const { client: resumed, received: afterReconnect } = newClient({ url: `ws://127.0.0.1:${port}/`, session });
    await resumed.connect();
    await resumed.send(userMsg('back'));
    await waitUntil(() => afterReconnect.some((e) => e.kind === 'msg' && e.payload.text === 'reply:back'));
  });

  // Issue #4 — the exec-approval → card bridge, end to end on the connector's
  // side of the seam: the EXACT ReplyPayload our approvalCapability.render.exec
  // hook hands the exec-approval forwarder, delivered through the REAL
  // outbound (presentation → approval.request card), tapped on a REAL client,
  // resolved by the REAL inbound to the native /approve slash command that
  // unblocks the waiting exec. (The forwarder itself is OpenClaw core — its
  // delivery contract is "payloads through the channel outbound", which is
  // what this simulates; the full gateway loop is a live-rig check.)
  it('renders an exec-approval as a card and resolves the tap to /approve <id> <decision>', async () => {
    const { channel, outbound } = buildConnector();
    const { port } = await channel.start();
    const pairing = await channel.pair('u1');
    const { client, received } = newClient({ url: `ws://127.0.0.1:${port}/`, pairingToken: pairing.token, device: 'iphone' });
    await client.connect();

    // The forwarder-side payload our capability produces for a pending exec.
    const nowMs = Date.now();
    const pending = buildRaccoonExecPendingPayload({
      request: {
        id: 'apr-e2e-1',
        createdAtMs: nowMs,
        expiresAtMs: nowMs + 30 * 60_000,
        request: { command: 'date', agentId: 'main', host: 'gateway' },
      },
      nowMs,
    });

    // Deliver it the way the forwarder does: through the channel outbound.
    received.length = 0;
    await outbound.sendPayload!({
      cfg, to: 'user:u1', text: pending.text ?? '', payload: pending,
    } as ChannelOutboundPayloadContext);

    // One approval.request card: compact title, the command in the
    // description, decision labels as options.
    await waitUntil(() => received.some(isApprovalRequest));
    const card = received.find(isApprovalRequest)!;
    expect(card.payload.title).toBe('Exec approval required');
    expect(card.payload.description).toContain('date');
    expect(card.payload.options).toEqual(['Allow Once', 'Allow Always', 'Deny']);

    // Tap "Allow Once" → the REAL native approve command reaches dispatch.
    dispatchedBodies.length = 0;
    await client.send(approvalResponse(card.payload.refId, 'Allow Once'));
    await waitUntil(() => dispatchedBodies.includes('/approve apr-e2e-1 allow-once'));

    // The resolved payload is plain text → an ordinary msg bubble.
    received.length = 0;
    const resolved = buildRaccoonExecResolvedPayload({
      resolved: { id: 'apr-e2e-1', decision: 'allow-once', resolvedBy: 'u1', ts: nowMs },
    });
    await outbound.sendPayload!({
      cfg, to: 'user:u1', text: resolved.text ?? '', payload: resolved,
    } as ChannelOutboundPayloadContext);
    await waitUntil(() => received.some((e) => e.kind === 'msg' && e.payload.text === 'Exec approval allowed once by u1.'));
  });

  it('restarts the connector on the same port and resumes the stored session (persistent store)', async () => {
    // Back each lifecycle with a SEPARATE FileCredentialStore instance reading
    // the SAME on-disk file — so the "restart" gets a fresh store object (as a
    // new process would), NOT the same in-memory object. Durability rides the
    // file, exactly as production does (gateway.startAccount wires a
    // FileCredentialStore at <storePath>/sessions.json). The truly-new-process
    // variant is exercised by the release gate.
    const storeDir = mkdtempSync(join(tmpdir(), 'raccoon-e2e-store-'));
    storeFilesToClean.push(storeDir);
    const storePath = join(storeDir, 'sessions.json');

    const first = buildConnector({ sessionStore: new FileCredentialStore({ path: storePath }) });
    const { port } = await first.channel.start();
    const pairing = await first.channel.pair('u1');
    const paired = newClient({ url: `ws://127.0.0.1:${port}/`, pairingToken: pairing.token, device: 'iphone' });
    let session = '';
    paired.client.onGrant((g) => { session = g.payload.sessionToken; });
    await paired.client.connect();
    expect(session.length).toBeGreaterThan(0);
    await paired.client.close();

    // Restart: stop the connector, stand a NEW one up on the SAME port with a
    // FRESH store instance reading the same persisted file (models a new process).
    await first.channel.stop();
    channels.length = 0; // first is stopped; don't double-stop in afterEach
    const second = buildConnector({ port, sessionStore: new FileCredentialStore({ path: storePath }) });
    await second.channel.start();

    // The PWA reconnects with the session it stored — resumes, no re-pair.
    const { client: resumed, received } = newClient({ url: `ws://127.0.0.1:${port}/`, session });
    await resumed.connect();
    await resumed.send(userMsg('after-restart'));
    await waitUntil(() => received.some((e) => e.kind === 'msg' && e.payload.text === 'reply:after-restart'));
  });

  it('unpairs a user and rejects the old session with 4401', async () => {
    const { channel } = buildConnector();
    const { port } = await channel.start();
    const pairing = await channel.pair('u1');
    const { client } = newClient({ url: `ws://127.0.0.1:${port}/`, pairingToken: pairing.token, device: 'iphone' });
    let session = '';
    client.onGrant((g) => { session = g.payload.sessionToken; });
    await client.connect();
    expect(session.length).toBeGreaterThan(0);
    await client.close();

    // Unpair via the channel's real revoke (what makeRaccoonRevokeHandler calls).
    await channel.revoke('u1');

    // The old session no longer verifies → the hub closes 4401 and the client,
    // seeing an auth-coded close, rejects and does NOT reconnect.
    const stale = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, session });
    clients.push(stale);
    await expect(stale.connect()).rejects.toThrow(/4401/);
  });
});
