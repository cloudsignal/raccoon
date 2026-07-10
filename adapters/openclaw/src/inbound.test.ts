import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DispatchFromConfigResult, ReplyDispatcher } from 'openclaw/plugin-sdk/channel-inbound';
import { buildRaccoonInboundRunner, type InboundRunnerOpts, type CheckAllowed } from './inbound.js';

// Mock dispatchReplyFromConfigWithSettledDispatcher before importing the module.
vi.mock('openclaw/plugin-sdk/channel-inbound', () => {
  return {
    dispatchReplyFromConfigWithSettledDispatcher: vi.fn(),
  };
});

// Import the mock AFTER vi.mock so we can configure per-test.
const { dispatchReplyFromConfigWithSettledDispatcher } = await import('openclaw/plugin-sdk/channel-inbound');
const mockDispatch = vi.mocked(dispatchReplyFromConfigWithSettledDispatcher);

describe('buildRaccoonInboundRunner', () => {
  const opts: InboundRunnerOpts = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opaque cfg shim, never constructed by Raccoon
    cfg: {} as any,
    storePath: '/tmp/raccoon-test',
    agentId: 'test-agent',
  };

  const ctx = {
    userId: 'user-123',
    channel: 'coordinator',
    text: 'hello there',
    messageId: 'msg-abc',
  };

  it('yields text from sendFinalReply calls, in order, then completes', async () => {
    mockDispatch.mockImplementation(async ({ dispatcher }) => {
      // Simulate OpenClaw calling the dispatcher with two final payloads.
      dispatcher.sendFinalReply({ text: 'hello' });
      dispatcher.sendFinalReply({ text: ' world' });
      dispatcher.markComplete();

      const result: DispatchFromConfigResult = {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 2 },
      };
      return result;
    });

    const runner = buildRaccoonInboundRunner(opts);
    const chunks: string[] = [];
    for await (const chunk of runner.run(ctx)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['hello', ' world']);
  });

  it('sets CommandAuthorized true, relying on the upstream gate invariant (R2-4)', async () => {
    // CommandAuthorized is unconditionally true in ctxPayload because runOneTurn
    // is only ever reached after gate.checkAllowed has already authorized the
    // sender (proved below, and in the "checkAllowed gate" describe block: a
    // denied user gets an empty iterable and dispatch is never called at all).
    let captured: { ctxPayload: { CommandAuthorized: boolean } } | undefined;
    mockDispatch.mockImplementation(async (arg) => {
      captured = arg as unknown as { ctxPayload: { CommandAuthorized: boolean } };
      arg.dispatcher.sendFinalReply({ text: 'ok' });
      arg.dispatcher.markComplete();
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } } as DispatchFromConfigResult;
    });

    const allowRunner = buildRaccoonInboundRunner(opts, { checkAllowed: () => true });
    for await (const _chunk of allowRunner.run(ctx)) { /* drain */ }
    expect(captured?.ctxPayload.CommandAuthorized).toBe(true);

    // A denied user never reaches runOneTurn (empty iterable, dispatch not
    // called) — so there is no path where CommandAuthorized:true is set for an
    // unauthorized sender.
    captured = undefined;
    mockDispatch.mockClear();
    const denyRunner = buildRaccoonInboundRunner(opts, { checkAllowed: () => false });
    const chunks: string[] = [];
    for await (const chunk of denyRunner.run(ctx)) chunks.push(chunk);
    expect(chunks).toEqual([]);
    expect(mockDispatch).not.toHaveBeenCalled();
    expect(captured).toBeUndefined();
  });

  it('skips sendBlockReply and sendToolResult payloads', async () => {
    mockDispatch.mockImplementation(async ({ dispatcher }) => {
      dispatcher.sendToolResult({ text: 'tool-output' });
      dispatcher.sendBlockReply({ text: 'block-output' });
      dispatcher.sendFinalReply({ text: 'final-only' });
      dispatcher.markComplete();

      const result: DispatchFromConfigResult = {
        queuedFinal: true,
        counts: { tool: 1, block: 1, final: 1 },
      };
      return result;
    });

    const runner = buildRaccoonInboundRunner(opts);
    const chunks: string[] = [];
    for await (const chunk of runner.run(ctx)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['final-only']);
  });

  it('yields nothing when final reply has no text', async () => {
    mockDispatch.mockImplementation(async ({ dispatcher }) => {
      dispatcher.sendFinalReply({ isError: true });
      dispatcher.markComplete();

      const result: DispatchFromConfigResult = {
        queuedFinal: false,
        counts: { tool: 0, block: 0, final: 1 },
      };
      return result;
    });

    const runner = buildRaccoonInboundRunner(opts);
    const chunks: string[] = [];
    for await (const chunk of runner.run(ctx)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
  });

  // --- Fix #1: async streaming path (queue suspend → waitForItem → wake) ---

  it('yields chunks delivered across an async boundary (suspend/wake path)', async () => {
    // The mock enqueues the first chunk synchronously, then yields the event
    // loop before enqueuing the second chunk. This forces the generator to
    // park at waitForItem() — the core of the push-pull queue — and be woken
    // by the later enqueue, exercising the suspend→wake resume path.
    mockDispatch.mockImplementation(async ({ dispatcher }) => {
      dispatcher.sendFinalReply({ text: 'chunk-A' });

      // Suspend: give the generator a chance to consume chunk-A and re-park.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      dispatcher.sendFinalReply({ text: 'chunk-B' });

      // Suspend again before marking complete.
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      dispatcher.markComplete();

      return {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 2 },
      };
    });

    const runner = buildRaccoonInboundRunner(opts);
    const chunks: string[] = [];
    for await (const chunk of runner.run(ctx)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['chunk-A', 'chunk-B']);
  });

  // --- Fix #2: rejection path ---

  it('propagates a rejection that occurs after settling', async () => {
    // The SDK calls markComplete first (settling the queue), but the returned
    // promise still rejects — e.g. an error during teardown.
    mockDispatch.mockImplementation(async ({ dispatcher }) => {
      dispatcher.sendFinalReply({ text: 'ok' });
      dispatcher.markComplete();
      throw new Error('sdk-post-settle-error');
    });

    const runner = buildRaccoonInboundRunner(opts);
    const chunks: string[] = [];

    await expect(async () => {
      for await (const chunk of runner.run(ctx)) {
        chunks.push(chunk);
      }
    }).rejects.toThrow('sdk-post-settle-error');

    // The chunk that arrived before the rejection must still have been yielded.
    expect(chunks).toEqual(['ok']);
  });

  it('propagates a rejection that occurs without the SDK settling', async () => {
    // The SDK throws without calling markComplete() or onSettled. The finally
    // guarantee in the hardened driver wakes the queue so the generator does
    // not hang, and the error surfaces to the consumer.
    mockDispatch.mockImplementation(async () => {
      // No dispatcher calls at all — just reject.
      throw new Error('sdk-no-settle-error');
    });

    const runner = buildRaccoonInboundRunner(opts);

    await expect(async () => {
      // eslint-disable-next-line no-empty -- intentional drain
      for await (const _ of runner.run(ctx)) {}
    }).rejects.toThrow('sdk-no-settle-error');
  });

  // --- Original tests (context-passing) ---

  it('passes the correct ctxPayload fields to dispatch', async () => {
    let capturedCfg: unknown;
    let capturedCtxPayload: unknown;

    mockDispatch.mockImplementation(async ({ cfg, ctxPayload, dispatcher }) => {
      capturedCfg = cfg;
      capturedCtxPayload = ctxPayload;
      dispatcher.markComplete();
      return { queuedFinal: false, counts: { tool: 0, block: 0, final: 0 } };
    });

    const runner = buildRaccoonInboundRunner(opts);
    // Drain the async iterable.
    // eslint-disable-next-line no-empty -- intentional drain
    for await (const _ of runner.run(ctx)) {}

    expect(capturedCfg).toBe(opts.cfg);
    expect(capturedCtxPayload).toMatchObject({
      Body: ctx.text,
      BodyForAgent: ctx.text,
      From: ctx.userId,
      SessionKey: `raccoon:user:${ctx.userId}`,
      AgentId: opts.agentId,
      MessageSid: ctx.messageId,
      CommandAuthorized: true, // no gate wired here -> reachable at all -> upstream-authorized (R2-4)
    });
  });
});

// ---------------------------------------------------------------------------
// Inbound allowlist gate — Task 5
// ---------------------------------------------------------------------------

describe('buildRaccoonInboundRunner with checkAllowed gate', () => {
  // Clear the shared mockDispatch between tests in this suite so call counts
  // don't bleed over from the earlier test group.
  beforeEach(() => {
    mockDispatch.mockReset();
  });

  const opts: InboundRunnerOpts = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    cfg: {} as any,
    storePath: '/tmp/raccoon-test',
    agentId: 'test-agent',
  };

  const ctx = {
    userId: 'user-123',
    channel: 'coordinator',
    text: 'hello',
    messageId: 'msg-gate',
  };

  it('yields nothing and does NOT call dispatch when checkAllowed returns false (denied)', async () => {
    // checkAllowed denies this user
    const checkAllowed: CheckAllowed = vi.fn().mockReturnValue(false);

    const runner = buildRaccoonInboundRunner(opts, { checkAllowed });
    const chunks: string[] = [];
    for await (const chunk of runner.run(ctx)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([]);
    // dispatch was never called — agent was not invoked
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('passes through and calls dispatch when checkAllowed returns true (allowed)', async () => {
    const checkAllowed: CheckAllowed = vi.fn().mockReturnValue(true);

    mockDispatch.mockImplementation(async ({ dispatcher }) => {
      dispatcher.sendFinalReply({ text: 'hi' });
      dispatcher.markComplete();
      const result: DispatchFromConfigResult = {
        queuedFinal: true,
        counts: { tool: 0, block: 0, final: 1 },
      };
      return result;
    });

    const runner = buildRaccoonInboundRunner(opts, { checkAllowed });
    const chunks: string[] = [];
    for await (const chunk of runner.run(ctx)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['hi']);
    expect(mockDispatch).toHaveBeenCalled();
  });

  it('allows all users when checkAllowed is absent (backward-compatible)', async () => {
    mockDispatch.mockImplementation(async ({ dispatcher }) => {
      dispatcher.sendFinalReply({ text: 'open' });
      dispatcher.markComplete();
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } };
    });

    // No gate — existing T1 behavior preserved
    const runner = buildRaccoonInboundRunner(opts);
    const chunks: string[] = [];
    for await (const chunk of runner.run(ctx)) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual(['open']);
  });
});
