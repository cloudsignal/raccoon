import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { AnyEnvelope } from '@raccoon/protocol';
import type { AgentRunner } from '@raccoon/bridge';
import { createRaccoonChannelAdapter, RACCOON_CHANNEL_DEFAULTS } from './adapter.js';
import type { RaccoonEndpoint, RaccoonEndpointOptions } from './endpoint.js';

const ENV = {
  RACCOON_PORT: '0',
  RACCOON_ADMIN_PORT: '0', // ephemeral — the Task 9 admin listener must not bind a real port in tests
  RACCOON_INSTANCE_URL: 'ws://localhost',
  RACCOON_PUBLIC_ORIGIN: 'http://host.docker.internal:8790',
  RACCOON_CHANNELS: 'assistant=main-group',
  RACCOON_ADMIN_SECRET: 's3cret',
  // Per-run temp dir: setup creates a REAL FileCredentialStore even with a
  // fake endpoint — never write into the repo, never share locks across runs.
  RACCOON_DATA_DIR: mkdtempSync(join(tmpdir(), 'rc-adapter-')),
};

function fakeEndpointFactory() {
  const sent: AnyEnvelope[] = [];
  let lastOpts: RaccoonEndpointOptions | null = null;
  let inboundHandler: ((env: AnyEnvelope, userId: string) => void) | null = null;
  const endpoint = {
    hub: {
      // url must satisfy the protocol's /media/<ULID>/<name> attachment schema
      media: { save: vi.fn(async () => ({ ok: true as const, attachment: { url: '/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/f.png', mime: 'image/png' } })) },
      onEnvelope: vi.fn((h: (env: AnyEnvelope, userId: string) => void) => ((inboundHandler = h), () => { inboundHandler = null; })),
    },
    bridge: {},
    store: {},
    start: vi.fn(async () => ({ port: 8790 })),
    stop: vi.fn(async () => {}),
    pair: vi.fn(),
    revoke: vi.fn(),
    sendAgentEnvelope: vi.fn(async (_u: string, env: AnyEnvelope) => (sent.push(env), true)),
  } as unknown as RaccoonEndpoint;
  const create = (opts: RaccoonEndpointOptions) => ((lastOpts = opts), endpoint);
  return {
    endpoint, sent, create,
    runner: () => lastOpts!.runner as AgentRunner,
    opts: () => lastOpts!,
    fireInbound: (userId: string) => inboundHandler?.({ kind: 'ack' } as unknown as AnyEnvelope, userId),
  };
}

async function collect(iter: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const d of iter) out.push(d);
  return out;
}

const CARD_CONTENT = {
  type: 'ask_question',
  questionId: 'q-9',
  title: 'Deploy?',
  question: 'Now?',
  options: [{ label: 'Yes', selectedLabel: 'Yes', value: 'deploy-now' }, { label: 'No', selectedLabel: 'No', value: 'abort' }],
};

describe('createRaccoonChannelAdapter', () => {
  it('returns null when env is incomplete', () => {
    expect(createRaccoonChannelAdapter({ env: {} })).toBeNull();
  });

  it('declares identity; defaults constant covers dm, group, and mentions', () => {
    const adapter = createRaccoonChannelAdapter({ env: ENV, createEndpoint: fakeEndpointFactory().create })!;
    expect(adapter.channelType).toBe('raccoon');
    expect(adapter.supportsThreads).toBe(false);
    expect(adapter.name).toBe('raccoon');
    expect(RACCOON_CHANNEL_DEFAULTS.mentions).toBe('dm-only');
    expect(RACCOON_CHANNEL_DEFAULTS.dm).toMatchObject({ engageMode: 'pattern', engagePattern: '.', threads: false });
    expect(RACCOON_CHANNEL_DEFAULTS.group.threads).toBe(false);
  });

  it('setup starts the endpoint with channels and a bridge deadline above the park timeout', async () => {
    const f = fakeEndpointFactory();
    const adapter = createRaccoonChannelAdapter({ env: ENV, createEndpoint: f.create })!;
    await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });
    expect(f.opts().channels).toEqual(['assistant']);
    expect(f.opts().turnDeadlineMs).toBe(120_000); // 90s park + 30s margin
    expect(adapter.isConnected()).toBe(true);
    await adapter.teardown();
    expect(adapter.isConnected()).toBe(false);
    expect((f.endpoint.stop as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });

  it('deliver settles a parked turn; unmatched deliver goes through sendAgentEnvelope', async () => {
    const f = fakeEndpointFactory();
    const adapter = createRaccoonChannelAdapter({ env: ENV, createEndpoint: f.create })!;
    const onInbound = vi.fn();
    await adapter.setup({ onInbound, onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });

    const runP = collect(f.runner().run({ userId: 'u1', channel: 'assistant', text: 'hi', messageId: 'm1' }));
    await new Promise((r) => setTimeout(r, 10));
    expect(onInbound).toHaveBeenCalledOnce();
    await adapter.deliver('assistant:u1', null, { kind: 'chat', content: { text: 'the reply' } });
    await expect(runP).resolves.toEqual(['the reply']);
    expect(f.sent).toHaveLength(0); // settled through the bridge, not sent directly

    const id = await adapter.deliver('assistant:u1', null, { kind: 'chat', content: { text: 'part 2' } });
    expect(id).toBeTruthy();
    expect(f.sent).toHaveLength(1);
    expect(f.sent[0]!.kind).toBe('msg');
    await adapter.teardown();
  });

  it('deliver maps a card to approval.request, remembers values, ends the parked turn silently', async () => {
    const f = fakeEndpointFactory();
    const adapter = createRaccoonChannelAdapter({ env: ENV, createEndpoint: f.create })!;
    const onAction = vi.fn();
    await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction });

    const runP = collect(f.runner().run({ userId: 'u1', channel: 'assistant', text: 'deploy', messageId: 'm2' }));
    await new Promise((r) => setTimeout(r, 10));
    const id = await adapter.deliver('assistant:u1', null, { kind: 'chat', content: CARD_CONTENT });
    expect(id).toBeTruthy();
    await expect(runP).resolves.toEqual([]); // parked turn ended without text
    expect(f.sent[0]!.kind).toBe('approval.request');
    expect((f.sent[0]!.payload as { options: string[] }).options).toEqual(['Yes', 'No']);

    // approval turn resolves the LABEL back to the option VALUE
    const approvalP = collect(f.runner().run({
      userId: 'u1', channel: 'assistant', text: 'Yes', messageId: 'm3',
      approval: { refId: 'q-9', choice: 'Yes' },
    }));
    await new Promise((r) => setTimeout(r, 10));
    expect(onAction).toHaveBeenCalledWith('q-9', 'deploy-now', 'u1');
    await adapter.deliver('assistant:u1', null, { kind: 'chat', content: { text: 'deployed' } });
    await expect(approvalP).resolves.toEqual(['deployed']);
    await adapter.teardown();
  });

  it('buffers an offline approval card and replays it when the user comes back', async () => {
    const f = fakeEndpointFactory();
    const adapter = createRaccoonChannelAdapter({ env: ENV, createEndpoint: f.create })!;
    await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });

    const send = f.endpoint.sendAgentEnvelope as ReturnType<typeof vi.fn>;
    send.mockResolvedValueOnce(false); // no live socket: push reduces cards to text — must buffer
    await adapter.deliver('assistant:u1', null, { kind: 'chat', content: CARD_CONTENT });
    expect(send).toHaveBeenCalledTimes(1);

    f.fireInbound('u1'); // any inbound envelope proves the socket is live
    await new Promise((r) => setTimeout(r, 10));
    expect(send).toHaveBeenCalledTimes(2); // same approval.request re-sent
    expect((send.mock.calls[1]![1] as AnyEnvelope).kind).toBe('approval.request');

    f.fireInbound('u1'); // replayed successfully — nothing left to flush
    await new Promise((r) => setTimeout(r, 10));
    expect(send).toHaveBeenCalledTimes(2);
    await adapter.teardown();
  });

  it('deliver with files routes through the media path', async () => {
    const f = fakeEndpointFactory();
    const adapter = createRaccoonChannelAdapter({ env: ENV, createEndpoint: f.create })!;
    await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });
    await adapter.deliver('assistant:u1', null, {
      kind: 'chat', content: { text: 'a file' },
      files: [{ filename: 'f.png', data: Buffer.from('x') }],
    });
    expect(f.sent).toHaveLength(1);
    expect((f.sent[0]!.payload as { attachments: unknown[] }).attachments).toHaveLength(1);
    await adapter.teardown();
  });

  it('deliver never throws on malformed platformId or contentless message', async () => {
    const f = fakeEndpointFactory();
    const adapter = createRaccoonChannelAdapter({ env: ENV, createEndpoint: f.create })!;
    await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });
    await expect(adapter.deliver('nocolon', null, { kind: 'chat', content: { text: 'x' } })).resolves.toBeUndefined();
    await expect(adapter.deliver('assistant:u1', null, { kind: 'chat', content: {} })).resolves.toBeUndefined();
    await adapter.teardown();
  });

  it('teardown during an in-flight flush neither throws nor resurrects the buffer', async () => {
    const f = fakeEndpointFactory();
    const adapter = createRaccoonChannelAdapter({ env: ENV, createEndpoint: f.create })!;
    await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });
    const send = f.endpoint.sendAgentEnvelope as ReturnType<typeof vi.fn>;

    // Buffer TWO cards offline — the F1 TypeError needed a second loop
    // iteration re-reading the (nulled) endpoint after the first await.
    send.mockResolvedValueOnce(false);
    await adapter.deliver('assistant:u1', null, { kind: 'chat', content: CARD_CONTENT });
    send.mockResolvedValueOnce(false);
    await adapter.deliver('assistant:u1', null, { kind: 'chat', content: { ...CARD_CONTENT, questionId: 'q-10' } });

    // Park the flush's first re-send on a controllable gate.
    let release!: (live: boolean) => void;
    send.mockImplementationOnce(() => new Promise<boolean>((r) => { release = r; }));
    const rejections: unknown[] = [];
    const onRejection = (err: unknown) => rejections.push(err);
    process.on('unhandledRejection', onRejection);
    try {
      f.fireInbound('u1'); // starts the flush; it parks awaiting the gate
      await adapter.teardown(); // nulls endpoint + clears the buffer while flush is parked
      release(false); // resolves false post-teardown — must drop, not TypeError or re-buffer
      await new Promise((r) => setTimeout(r, 10));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    // 2 deliver sends + 2 flush sends against the captured endpoint — no more.
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('starts and stops the admin server with the adapter', async () => {
    const f = fakeEndpointFactory();
    const adapter = createRaccoonChannelAdapter({ env: ENV, createEndpoint: f.create })!;
    await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });
    await adapter.teardown();
    await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() }); // rebind works — nothing leaked
    await adapter.teardown();
  });

  it('setTyping sends a typing start envelope', async () => {
    const f = fakeEndpointFactory();
    const adapter = createRaccoonChannelAdapter({ env: ENV, createEndpoint: f.create })!;
    await adapter.setup({ onInbound: vi.fn(), onInboundEvent: vi.fn(), onMetadata: vi.fn(), onAction: vi.fn() });
    await adapter.setTyping!('assistant:u1', null);
    expect(f.sent[0]!.kind).toBe('typing');
    expect((f.sent[0]!.payload as { state: string }).state).toBe('start');
    await adapter.teardown();
  });
});
