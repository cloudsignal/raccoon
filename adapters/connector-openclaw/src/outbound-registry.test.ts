// adapters/openclaw/src/outbound-registry.test.ts
// Task 7 TDD: the outbound↔hub seam.
//
// The T4 outbound adapter's sendText/sendPayload receive { cfg, to, text,
// accountId? } — NOT a hub. The gateway maintains a per-account transport
// registry (startAccount populates it, stopAccount removes it). The plugin's
// outbound adapter must resolve the running account's hub from that registry
// by accountId and deliver through it.
//
// This test drives `createRegistryOutbound(resolveRunning)` — the registry-
// backed outbound adapter used by raccoonChannelPlugin.outbound.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AnyEnvelope } from '@raccoon/protocol';
import type { OutboundHub } from '@raccoon/bridge';

// The outbound adapter chunks text via the SDK chunker (bundled, unresolvable
// in-workspace) — mock it exactly like outbound.test.ts does.
vi.mock('openclaw/plugin-sdk/reply-chunking', () => ({
  chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
}));

// gateway.ts imports inbound.ts → this bundled SDK module; mock it so the
// import graph loads (we never invoke the inbound runner in this suite).
vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchReplyFromConfigWithSettledDispatcher: vi.fn(),
}));

const { createRegistryOutbound } = await import('./gateway.js');
import type { RunningAccount } from './gateway.js';

function makeFakeHub(): OutboundHub & { envelopes: AnyEnvelope[] } {
  const envelopes: AnyEnvelope[] = [];
  return {
    envelopes,
    sendToUser(_userId: string, env: AnyEnvelope): boolean {
      envelopes.push(env);
      return true;
    },
    onEnvelope(): () => void {
      return () => {};
    },
  };
}

const fakeCfg = { __brand: 'OpenClawConfig' as const } as any;

function makeCtx(to: string, accountId?: string, text = 'hello') {
  return { cfg: fakeCfg, to, text, ...(accountId !== undefined ? { accountId } : {}) };
}

// A RunningAccount whose hub is a fake OutboundHub (structurally narrower than
// WsHub — the registry never hands the raw hub to the outbound adapter, so
// the cast is sound for these tests). The entry's sendAgentEnvelope seam —
// the path createRegistryOutbound actually delivers through — forwards to the
// fake hub, so the suite's envelope assertions observe seam-routed sends.
function makeEntry(hub: OutboundHub, channel: string): RunningAccount {
  return {
    hub: hub as unknown as RunningAccount['hub'],
    channel,
    instanceUrl: 'ws://127.0.0.1:8790/',
    stop: async () => {},
    revoke: async () => {}, // not exercised by this suite (outbound delivery only)
    sendAgentEnvelope: async (userId, env) => hub.sendToUser(userId, env),
  };
}

describe('createRegistryOutbound (outbound↔hub seam)', () => {
  let hub: OutboundHub & { envelopes: AnyEnvelope[] };
  let running: Map<string, RunningAccount>;

  beforeEach(() => {
    hub = makeFakeHub();
    running = new Map();
    vi.clearAllMocks();
  });

  const resolveRunning = (accountId?: string) => running.get(accountId ?? 'default');

  it('sets deliveryMode to "gateway"', () => {
    const adapter = createRegistryOutbound(resolveRunning);
    expect(adapter.deliveryMode).toBe('gateway');
  });

  it('resolves the running hub by accountId and delivers via it', async () => {
    running.set('default', makeEntry(hub, 'coordinator'));
    const adapter = createRegistryOutbound(resolveRunning);

    const result = await adapter.sendText!(makeCtx('user:alice', 'default') as any);

    expect(hub.envelopes).toHaveLength(1);
    const env = hub.envelopes[0]!;
    expect(env.kind).toBe('msg');
    expect(env.to).toBe('user:alice');
    expect(env.channel).toBe('coordinator');
    expect(result.messageId).toBe(env.id);
  });

  it('defaults to accountId "default" when ctx.accountId is absent', async () => {
    running.set('default', makeEntry(hub, 'coordinator'));
    const adapter = createRegistryOutbound(resolveRunning);

    await adapter.sendText!(makeCtx('user:bob') as any);

    expect(hub.envelopes).toHaveLength(1);
    expect(hub.envelopes[0]!.to).toBe('user:bob');
  });

  it('uses the running account channel (not a hardcoded one) for envelope.channel', async () => {
    running.set('default', makeEntry(hub, 'assistant'));
    const adapter = createRegistryOutbound(resolveRunning);

    await adapter.sendText!(makeCtx('user:u1', 'default') as any);

    expect(hub.envelopes[0]!.channel).toBe('assistant');
    expect(hub.envelopes[0]!.from).toBe('agent:assistant');
  });

  it('throws a clear error when no account is running for the target accountId', async () => {
    const adapter = createRegistryOutbound(resolveRunning);
    await expect(adapter.sendText!(makeCtx('user:alice', 'default') as any)).rejects.toThrow(
      /no running raccoon account/i,
    );
    expect(hub.envelopes).toHaveLength(0);
  });

  it('delivers through the entry sendAgentEnvelope seam, never entry.hub.sendToUser (recording, push-aware path)', async () => {
    // The old wiring passed entry.hub raw to createRaccoonOutbound, bypassing
    // the channel's recording/push-aware seam entirely. Prove the send now
    // routes through sendAgentEnvelope and the raw hub is untouched.
    const seamSends: Array<{ userId: string; env: AnyEnvelope }> = [];
    const entry: RunningAccount = {
      hub: makeFakeHub() as unknown as RunningAccount['hub'],
      channel: 'coordinator',
      instanceUrl: 'ws://127.0.0.1:8790/',
      stop: async () => {},
      revoke: async () => {},
      sendAgentEnvelope: async (userId, env) => { seamSends.push({ userId, env }); return true; },
    };
    running.set('default', entry);
    const adapter = createRegistryOutbound(resolveRunning);

    await adapter.sendText!(makeCtx('user:alice', 'default') as any);

    expect(seamSends).toHaveLength(1);
    expect(seamSends[0]!.userId).toBe('alice');
    expect(seamSends[0]!.env.kind).toBe('msg');
    // The raw hub saw NOTHING — the seam is the one blessed outbound path.
    expect((entry.hub as unknown as { envelopes: AnyEnvelope[] }).envelopes).toHaveLength(0);
  });

  it('sendPayload also resolves the hub from the registry', async () => {
    running.set('default', makeEntry(hub, 'coordinator'));
    const adapter = createRegistryOutbound(resolveRunning);

    const ctx = { ...makeCtx('user:alice', 'default'), payload: { text: 'plain' } };
    const result = await adapter.sendPayload!(ctx as any);

    expect(hub.envelopes).toHaveLength(1);
    expect(hub.envelopes[0]!.kind).toBe('msg');
    expect(result.messageId).toBe(hub.envelopes[0]!.id);
  });

  it('exposes a chunker helper', () => {
    const adapter = createRegistryOutbound(resolveRunning);
    expect(typeof adapter.chunker).toBe('function');
  });

  // R4-1: this wrapper previously dropped presentationCapabilities and
  // renderPresentation entirely — the T4 adapter (createRaccoonOutbound)
  // declared them correctly, but raccoonChannelPlugin.outbound is THIS
  // registry wrapper, not the inner adapter, so OpenClaw never saw them in
  // production and always degraded exec approvals to plain text.

  it('exposes presentationCapabilities.buttons: true (forwarded from the T4 adapter)', () => {
    const adapter = createRegistryOutbound(resolveRunning);
    expect(adapter.presentationCapabilities?.supported).toBe(true);
    expect(adapter.presentationCapabilities?.buttons).toBe(true);
  });

  it('exposes a synchronous renderPresentation that performs no delivery (forwarded from the T4 adapter)', () => {
    const adapter = createRegistryOutbound(resolveRunning);
    expect(typeof adapter.renderPresentation).toBe('function');
    const payload = { text: 'hi' };
    const presentation = { blocks: [] as never[] };
    const result = adapter.renderPresentation!({ payload, presentation, ctx: makeCtx('user:alice', 'default') as any });
    // The registry wrapper is typed as the SDK's ChannelOutboundAdapter, whose
    // renderPresentation return widens to Promise<...> | .... Raccoon's is
    // synchronous; assert + narrow so the field reads below typecheck.
    if (result instanceof Promise) throw new Error('renderPresentation must be synchronous');
    // #R5-1 contract: the presentation is encoded into retained channelData
    // (core strips `presentation` itself before delivery).
    expect(result?.text).toBe('hi');
    expect((result?.channelData as Record<string, unknown>).raccoonPresentation).toEqual(presentation);
    expect(hub.envelopes).toHaveLength(0); // no running-account resolution needed; no delivery side effect
  });
});
