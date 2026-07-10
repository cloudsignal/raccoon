// adapters/openclaw/src/outbound.test.ts
//
// TDD tests for the Raccoon outbound adapter (Task 4).
//
// DESIGN NOTES:
// The real ChannelOutboundAdapter.sendText signature (per outbound.types-CHpw9VBQ.d.ts) is:
//   sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>
//
// ctx.interactive does NOT exist on ChannelOutboundContext; interactive payloads are
// delivered via sendPayload (ChannelOutboundPayloadContext = ChannelOutboundContext & {
//   payload: ReplyPayload }), where payload.interactive?: InteractiveReply (deprecated)
// or payload.presentation?: MessagePresentation (current shape).
//
// The factory's sendText handles plain text + mediaUrls (via ctx.text).
// The factory's sendPayload handles interactive/presentation payloads.
//
// The brief's "sendText handles interactive" is reconciled by implementing sendPayload.
// This matches the real SDK surface; the brief used a simplified contract map that
// conflated the two ctx shapes.
//
// Mock strategy:
//   - `@raccoon/protocol` is NOT mocked; createEnvelope/userAddress/agentAddress run for real.
//   - `openclaw/plugin-sdk/reply-chunking` IS mocked (same reason as formatting.test.ts:
//     the real SDK bundle's internal relative imports don't resolve in the Raccoon workspace).
//   - OutboundHub is a hand-rolled fake (interface, not implementation).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { AnyEnvelope } from '@raccoon/protocol';
import type { OutboundHub } from '@raccoon/bridge';

// Mock the chunking SDK (bundled — internal relative imports unresolvable in workspace).
vi.mock('openclaw/plugin-sdk/reply-chunking', () => ({
  chunkMarkdownTextWithMode: vi.fn(),
}));

const { chunkMarkdownTextWithMode } = await import('openclaw/plugin-sdk/reply-chunking');
const mockChunk = vi.mocked(chunkMarkdownTextWithMode);

// Import the module under test AFTER the mock is established.
const { createRaccoonOutbound } = await import('./outbound.js');

// ---------------------------------------------------------------------------
// Fake OutboundHub
// ---------------------------------------------------------------------------

function makeFakeHub(): OutboundHub & { envelopes: AnyEnvelope[] } {
  const envelopes: AnyEnvelope[] = [];
  return {
    envelopes,
    sendToUser(_userId: string, env: AnyEnvelope): boolean {
      envelopes.push(env);
      return true;
    },
    onEnvelope(_handler: (env: AnyEnvelope, userId: string) => void): () => void {
      return () => {};
    },
  };
}

// Minimal OpenClawConfig shim (opaque pass-through).
const fakeCfg = { __brand: 'OpenClawConfig' as const } as import('openclaw/plugin-sdk/channel-inbound').OpenClawConfig;

// ---------------------------------------------------------------------------
// Helper: build a minimal ChannelOutboundContext-like object for sendText tests.
// The actual ChannelOutboundContext from the shim is used by the implementation;
// we construct a compatible plain object here.
// ---------------------------------------------------------------------------

function makeCtx(text: string, to: string, extra?: Record<string, unknown>) {
  return { cfg: fakeCfg, to, text, ...extra };
}

// ---------------------------------------------------------------------------
// Test suites
// ---------------------------------------------------------------------------

describe('createRaccoonOutbound', () => {
  let hub: OutboundHub & { envelopes: AnyEnvelope[] };

  beforeEach(() => {
    hub = makeFakeHub();
    vi.clearAllMocks();
  });

  // ---- deliveryMode -------------------------------------------------------

  it('sets deliveryMode to "gateway"', () => {
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    expect(adapter.deliveryMode).toBe('gateway');
  });

  // ---- to parsing ---------------------------------------------------------

  it('parses "user:alice" → userId "alice" and sends one msg envelope', async () => {
    mockChunk.mockReturnValueOnce(['hello']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    const result = await adapter.sendText!(makeCtx('hello', 'user:alice'));
    expect(hub.envelopes).toHaveLength(1);
    const env = hub.envelopes[0]!;
    expect(env.kind).toBe('msg');
    expect(env.to).toBe('user:alice');
    // messageId = id of the first (only) envelope
    expect(result.messageId).toBe(env.id);
  });

  it('parses "user:bob-123" → userId "bob-123"', async () => {
    mockChunk.mockReturnValueOnce(['hi']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    await adapter.sendText!(makeCtx('hi', 'user:bob-123'));
    expect(hub.envelopes[0]!.to).toBe('user:bob-123');
  });

  // ---- short text → single envelope --------------------------------------

  it('short text → exactly one msg envelope with that text as payload', async () => {
    const text = 'Short reply.';
    mockChunk.mockReturnValueOnce([text]);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    await adapter.sendText!(makeCtx(text, 'user:alice'));
    expect(hub.envelopes).toHaveLength(1);
    const env = hub.envelopes[0]!;
    expect(env.kind).toBe('msg');
    if (env.kind === 'msg') {
      expect(env.payload.text).toBe(text);
    }
  });

  it('messageId equals the id of the single envelope', async () => {
    mockChunk.mockReturnValueOnce(['hello world']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    const result = await adapter.sendText!(makeCtx('hello world', 'user:alice'));
    expect(result.messageId).toBe(hub.envelopes[0]!.id);
  });

  // ---- long text → multiple envelopes in order ---------------------------

  it('long text → multiple msg envelopes IN ORDER', async () => {
    mockChunk.mockReturnValueOnce(['chunk-1', 'chunk-2', 'chunk-3']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    await adapter.sendText!(makeCtx('x'.repeat(20000), 'user:alice'));
    expect(hub.envelopes).toHaveLength(3);
    if (hub.envelopes[0]!.kind === 'msg') expect(hub.envelopes[0]!.payload.text).toBe('chunk-1');
    if (hub.envelopes[1]!.kind === 'msg') expect(hub.envelopes[1]!.payload.text).toBe('chunk-2');
    if (hub.envelopes[2]!.kind === 'msg') expect(hub.envelopes[2]!.payload.text).toBe('chunk-3');
  });

  it('long text → messageId equals the id of the FIRST envelope', async () => {
    mockChunk.mockReturnValueOnce(['part-A', 'part-B']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    const result = await adapter.sendText!(makeCtx('x'.repeat(20000), 'user:alice'));
    expect(result.messageId).toBe(hub.envelopes[0]!.id);
    // Sanity: not the id of the second envelope.
    expect(result.messageId).not.toBe(hub.envelopes[1]!.id);
  });

  // ---- OAM envelope fields ------------------------------------------------

  it('msg envelopes carry correct from (agent:<channel>), to, channel', async () => {
    mockChunk.mockReturnValueOnce(['hello']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    await adapter.sendText!(makeCtx('hello', 'user:alice'));
    const env = hub.envelopes[0]!;
    expect(env.from).toBe('agent:coordinator');
    expect(env.to).toBe('user:alice');
    expect(env.channel).toBe('coordinator');
  });

  it('uses the channel from the factory option in envelope.channel', async () => {
    mockChunk.mockReturnValueOnce(['hi']);
    const adapter = createRaccoonOutbound({ hub, channel: 'assistant' });
    await adapter.sendText!(makeCtx('hi', 'user:u1'));
    expect(hub.envelopes[0]!.channel).toBe('assistant');
    expect(hub.envelopes[0]!.from).toBe('agent:assistant');
  });

  // ---- chunking delegation -----------------------------------------------

  it('delegates to chunkMarkdownTextWithMode with limit 8000 and mode newline', async () => {
    mockChunk.mockReturnValueOnce(['x']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    await adapter.sendText!(makeCtx('some text', 'user:alice'));
    expect(mockChunk).toHaveBeenCalledWith('some text', 8000, 'newline');
  });

  // ---- chunker public helper ---------------------------------------------

  it('chunker delegates to the same chunking helper with the given limit', async () => {
    mockChunk.mockReturnValueOnce(['a', 'b']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    const result = adapter.chunker!('hello', 4096);
    expect(mockChunk).toHaveBeenCalledWith('hello', 4096, 'newline');
    expect(result).toEqual(['a', 'b']);
  });

  // ---- interactive → approval.request ------------------------------------

  it('interactive buttons → one approval.request envelope', async () => {
    // Note: the buttons path does NOT call chunkReplyText — it emits an
    // approval.request envelope directly. No mockReturnValueOnce needed here.
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    // sendPayload is the correct hook for interactive payloads in the real SDK.
    const ctx = {
      ...makeCtx('Choose:', 'user:alice'),
      payload: {
        text: 'Choose:',
        interactive: {
          blocks: [
            {
              type: 'buttons' as const,
              buttons: [
                { label: 'Approve' },
                { label: 'Edit' },
                { label: 'Skip' },
              ],
            },
          ],
        },
      },
    };
    const result = await adapter.sendPayload!(ctx);
    expect(hub.envelopes).toHaveLength(1);
    const env = hub.envelopes[0]!;
    expect(env.kind).toBe('approval.request');
    if (env.kind === 'approval.request') {
      // Exact count: 3 buttons, no extras.
      expect(env.payload.options).toHaveLength(3);
      expect(env.payload.options).toContain('Approve');
      expect(env.payload.options).toContain('Edit');
      expect(env.payload.options).toContain('Skip');
    }
    expect(result.messageId).toBe(env.id);
  });

  it('interactive buttons → approval.request with refId and title from text', async () => {
    // Note: buttons path emits approval.request without calling chunkReplyText.
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    const ctx = {
      ...makeCtx('Pick one:', 'user:alice'),
      payload: {
        text: 'Pick one:',
        interactive: {
          blocks: [
            {
              type: 'buttons' as const,
              buttons: [{ label: 'Yes' }, { label: 'No' }],
            },
          ],
        },
      },
    };
    await adapter.sendPayload!(ctx);
    const env = hub.envelopes[0]!;
    expect(env.kind).toBe('approval.request');
    if (env.kind === 'approval.request') {
      // refId is a non-empty string.
      expect(env.payload.refId).toBeTruthy();
      // title comes from the payload text.
      expect(env.payload.title).toBeTruthy();
    }
  });

  it('remembers each button label -> value (falling back to label) in the approval-value store (#R2-5)', async () => {
    const remember = vi.fn();
    const adapter = createRaccoonOutbound({
      hub, channel: 'coordinator',
      approvalValues: { remember, resolve: (_refId: string, label: string) => label },
    });
    const ctx = {
      ...makeCtx('Choose:', 'user:alice'),
      payload: {
        text: 'Choose:',
        interactive: {
          blocks: [
            {
              type: 'buttons' as const,
              buttons: [
                { label: 'Approve', value: 'approve:task-42' },
                { label: 'Skip' }, // no value -> falls back to its own label
              ],
            },
          ],
        },
      },
    };
    await adapter.sendPayload!(ctx);
    const env = hub.envelopes[0]!;
    expect(env.kind).toBe('approval.request');
    expect(remember).toHaveBeenCalledTimes(1);
    const [refIdArg, labelToValue] = remember.mock.calls[0]!;
    expect(refIdArg).toBe(env.kind === 'approval.request' ? env.payload.refId : undefined);
    expect(labelToValue.get('Approve')).toBe('approve:task-42');
    expect(labelToValue.get('Skip')).toBe('Skip');
  });

  // ---- unmappable interactive → text fallback ----------------------------

  it('unmappable interactive (no buttons block) → text fallback listing options', async () => {
    // Return a single-element array with the full text so option labels flow through.
    mockChunk.mockReturnValueOnce(['Choose:\n\n1. Option A\n2. Option B']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    // A "select" block only — no buttons block → unmappable.
    const ctx = {
      ...makeCtx('Choose:', 'user:alice'),
      payload: {
        text: 'Choose:',
        interactive: {
          blocks: [
            {
              type: 'select' as const,
              options: [{ label: 'Option A' }, { label: 'Option B' }],
            },
          ],
        },
      },
    };
    const result = await adapter.sendPayload!(ctx);
    // Fallback: all envelopes are msg kind.
    for (const env of hub.envelopes) {
      expect(env.kind).toBe('msg');
    }
    // The fallback text passed to the chunk helper included the option labels.
    // We verify indirectly: the sent envelope text contains them (since the mock
    // returns our pre-built fallback string, we know the labels were included in
    // the chunk call). We additionally assert the chunk helper was called.
    expect(mockChunk).toHaveBeenCalledOnce();
    const chunkCallArg = mockChunk.mock.calls[0]![0];
    expect(chunkCallArg).toContain('Option A');
    expect(chunkCallArg).toContain('Option B');
    // Envelopes sent with the mocked chunk text.
    const combinedText = hub.envelopes
      .filter((e) => e.kind === 'msg')
      .map((e) => (e.kind === 'msg' ? e.payload.text : ''))
      .join('\n');
    expect(combinedText).toContain('Option A');
    expect(combinedText).toContain('Option B');
    // messageId is the first envelope's id.
    expect(result.messageId).toBe(hub.envelopes[0]!.id);
  });

  it('sendPayload with no interactive falls through to sendText behaviour', async () => {
    mockChunk.mockReturnValueOnce(['plain text']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    const ctx = {
      ...makeCtx('plain text', 'user:alice'),
      payload: { text: 'plain text' },
    };
    const result = await adapter.sendPayload!(ctx);
    expect(hub.envelopes).toHaveLength(1);
    expect(hub.envelopes[0]!.kind).toBe('msg');
    expect(result.messageId).toBe(hub.envelopes[0]!.id);
  });

  // ---- hub.sendToUser called with raw userId ------------------------------

  it('hub.sendToUser is called with the raw userId (not the "user:" prefixed form)', async () => {
    mockChunk.mockReturnValueOnce(['hello']);
    const sendSpy = vi.spyOn(hub, 'sendToUser');
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    await adapter.sendText!(makeCtx('hello', 'user:alice'));
    // sendToUser must receive the bare userId 'alice', not 'user:alice'.
    expect(sendSpy).toHaveBeenCalledOnce();
    expect(sendSpy.mock.calls[0]![0]).toBe('alice');
  });

  // ---- empty chunk guard --------------------------------------------------

  it('throws if chunker returns empty array (nothing to send)', async () => {
    mockChunk.mockReturnValueOnce([]);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    await expect(adapter.sendText!(makeCtx('', 'user:alice'))).rejects.toThrow(
      'raccoon outbound: nothing to send (empty reply text)',
    );
    expect(hub.envelopes).toHaveLength(0);
  });

  it('throws if chunker returns only empty strings', async () => {
    mockChunk.mockReturnValueOnce(['', '']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    await expect(adapter.sendText!(makeCtx('', 'user:alice'))).rejects.toThrow(
      'raccoon outbound: nothing to send (empty reply text)',
    );
    expect(hub.envelopes).toHaveLength(0);
  });

  // ---- malformed target guard ---------------------------------------------

  it('throws a clear error for to = "user:" (empty id portion)', async () => {
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    await expect(adapter.sendText!(makeCtx('hello', 'user:'))).rejects.toThrow(
      'raccoon outbound: malformed target "user:"',
    );
  });

  it('throws a clear error for to without "user:" prefix', async () => {
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    await expect(adapter.sendText!(makeCtx('hello', 'alice'))).rejects.toThrow(
      'raccoon outbound: malformed target "alice"',
    );
  });

  // ---- R3-9: presentationCapabilities + renderPresentation ---------------

  it('declares presentationCapabilities.buttons: true (and does not overclaim charts)', () => {
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    expect(adapter.presentationCapabilities?.supported).toBe(true);
    expect(adapter.presentationCapabilities?.buttons).toBe(true);
    expect(adapter.presentationCapabilities?.charts).toBe(false);
  });

  it('renderPresentation: a buttons block → one approval.request envelope with title, description, and options', async () => {
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    const result = await adapter.renderPresentation!({
      payload: { text: 'Deploy to prod?' },
      presentation: {
        title: 'Confirm deploy',
        blocks: [
          { type: 'context', text: 'Build #482, main@a1b2c3' },
          { type: 'buttons', buttons: [{ label: 'Approve' }, { label: 'Reject' }] },
        ],
      },
      ctx: makeCtx('Deploy to prod?', 'user:alice'),
    });
    expect(hub.envelopes).toHaveLength(1);
    const env = hub.envelopes[0]!;
    expect(env.kind).toBe('approval.request');
    if (env.kind === 'approval.request') {
      expect(env.payload.title).toBe('Confirm deploy');
      expect(env.payload.description).toBe('Build #482, main@a1b2c3');
      expect(env.payload.options).toEqual(['Approve', 'Reject']);
    }
    expect(result.messageId).toBe(env.id);
  });

  it('renderPresentation: falls back to payload.text as title when presentation.title is absent', async () => {
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    await adapter.renderPresentation!({
      payload: { text: 'Pick one:' },
      presentation: { blocks: [{ type: 'buttons', buttons: [{ label: 'Yes' }, { label: 'No' }] }] },
      ctx: makeCtx('Pick one:', 'user:alice'),
    });
    const env = hub.envelopes[0]!;
    if (env.kind === 'approval.request') expect(env.payload.title).toBe('Pick one:');
  });

  it('renderPresentation: resolves a callback action value (never reinterpreted as a command) via the approval-value store', async () => {
    const remember = vi.fn();
    const adapter = createRaccoonOutbound({
      hub, channel: 'coordinator',
      approvalValues: { remember, resolve: (_refId: string, label: string) => label },
    });
    await adapter.renderPresentation!({
      payload: { text: 'Choose:' },
      presentation: {
        blocks: [{
          type: 'buttons',
          buttons: [
            { label: 'Approve', action: { type: 'callback', value: 'cb:approve-task-42' } },
            { label: 'Legacy', value: 'legacy:value' },
            { label: 'Bare' },
          ],
        }],
      },
      ctx: makeCtx('Choose:', 'user:alice'),
    });
    const env = hub.envelopes[0]!;
    expect(remember).toHaveBeenCalledTimes(1);
    const [refIdArg, labelToValue] = remember.mock.calls[0]!;
    expect(refIdArg).toBe(env.kind === 'approval.request' ? env.payload.refId : undefined);
    expect(labelToValue.get('Approve')).toBe('cb:approve-task-42');
    expect(labelToValue.get('Legacy')).toBe('legacy:value');
    expect(labelToValue.get('Bare')).toBe('Bare');
  });

  it('renderPresentation: a select block (no buttons) renders as an approval.request too, not a text fallback', async () => {
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    const result = await adapter.renderPresentation!({
      payload: { text: 'Pick a region:' },
      presentation: {
        blocks: [{
          type: 'select',
          options: [{ label: 'us-east', value: 'region:us-east' }, { label: 'eu-west' }],
        }],
      },
      ctx: makeCtx('Pick a region:', 'user:alice'),
    });
    expect(hub.envelopes).toHaveLength(1);
    const env = hub.envelopes[0]!;
    expect(env.kind).toBe('approval.request');
    if (env.kind === 'approval.request') expect(env.payload.options).toEqual(['us-east', 'eu-west']);
    expect(result.messageId).toBe(env.id);
  });

  it('renderPresentation: no buttons/select → renders text/context blocks as plain msg text', async () => {
    mockChunk.mockReturnValueOnce(['Line one.\n\nLine two.']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    const result = await adapter.renderPresentation!({
      payload: { text: 'fallback (unused)' },
      presentation: {
        blocks: [
          { type: 'text', text: 'Line one.' },
          { type: 'divider' },
          { type: 'context', text: 'Line two.' },
        ],
      },
      ctx: makeCtx('fallback (unused)', 'user:alice'),
    });
    expect(hub.envelopes).toHaveLength(1);
    const env = hub.envelopes[0]!;
    expect(env.kind).toBe('msg');
    if (env.kind === 'msg') expect(env.payload.text).toBe('Line one.\n\nLine two.');
    expect(result.messageId).toBe(env.id);
  });

  it('renderPresentation: an empty presentation (no blocks with content) falls back to payload.text', async () => {
    mockChunk.mockReturnValueOnce(['plain fallback text']);
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    await adapter.renderPresentation!({
      payload: { text: 'plain fallback text' },
      presentation: { blocks: [] },
      ctx: makeCtx('plain fallback text', 'user:alice'),
    });
    const env = hub.envelopes[0]!;
    expect(env.kind).toBe('msg');
    if (env.kind === 'msg') expect(env.payload.text).toBe('plain fallback text');
  });

  it('sendPayload with payload.presentation (no interactive) also renders buttons, not silently dropping them', async () => {
    const adapter = createRaccoonOutbound({ hub, channel: 'coordinator' });
    const ctx = {
      ...makeCtx('Confirm?', 'user:alice'),
      payload: {
        text: 'Confirm?',
        presentation: { blocks: [{ type: 'buttons', buttons: [{ label: 'Yes' }, { label: 'No' }] }] },
      },
    };
    const result = await adapter.sendPayload!(ctx);
    expect(hub.envelopes).toHaveLength(1);
    const env = hub.envelopes[0]!;
    expect(env.kind).toBe('approval.request');
    if (env.kind === 'approval.request') expect(env.payload.options).toEqual(['Yes', 'No']);
    expect(result.messageId).toBe(env.id);
  });
});
