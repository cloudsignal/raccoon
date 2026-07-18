import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { DispatchFromConfigResult } from './openclaw-missing-types.js';
import { buildRaccoonInboundRunner, type InboundRunnerOpts, type CheckAllowed } from './inbound.js';
import { createApprovalValueStore } from './approval-values.js';

// Mock dispatchReplyFromConfigWithSettledDispatcher before importing the module.
vi.mock('openclaw/plugin-sdk/channel-inbound', () => {
  return {
    dispatchReplyFromConfigWithSettledDispatcher: vi.fn(),
  };
});

// Mock the operator approvals gateway client (issue #5: card taps resolve
// approvals DIRECTLY, without dispatching a chat turn on the session).
vi.mock('openclaw/plugin-sdk/approval-gateway-runtime', () => {
  return {
    resolveApprovalOverGateway: vi.fn(),
  };
});

// Import the mocks AFTER vi.mock so we can configure per-test.
const { dispatchReplyFromConfigWithSettledDispatcher } = await import('openclaw/plugin-sdk/channel-inbound');
const mockDispatch = vi.mocked(dispatchReplyFromConfigWithSettledDispatcher);
const { resolveApprovalOverGateway } = await import('openclaw/plugin-sdk/approval-gateway-runtime');
const mockResolveGateway = vi.mocked(resolveApprovalOverGateway);

beforeEach(() => {
  mockResolveGateway.mockReset();
  mockResolveGateway.mockResolvedValue(undefined);
  // Reset call history too: several tests assert mockDispatch was NOT called
  // for the direct gateway path, which needs a clean slate per test.
  mockDispatch.mockReset();
});

describe('buildRaccoonInboundRunner', () => {
  const opts: InboundRunnerOpts = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opaque cfg shim, never constructed by Raccoon
    cfg: {} as any,
    storePath: '/tmp/raccoon-test',
    agentId: 'test-agent',
    accountId: 'default',
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

  it('resolves an approval choice (a label) back to its real value via the shared store, and surfaces the refId (#R2-5)', async () => {
    let capturedBody: string | undefined;
    mockDispatch.mockImplementation(async (arg) => {
      capturedBody = (arg.ctxPayload as { Body: string }).Body;
      arg.dispatcher.sendFinalReply({ text: 'ok' });
      arg.dispatcher.markComplete();
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } } as DispatchFromConfigResult;
    });

    // Simulate what outbound.ts does when it builds an approval.request whose
    // 'Approve' button carries a distinct machine value (non-command — a
    // legacy/callback-style value, not a native slash command).
    const store = createApprovalValueStore();
    store.remember('req-1', ctx.userId, new Map([
      ['Approve', { value: 'approve:task-42', isCommand: false }],
      ['Skip', { value: 'Skip', isCommand: false }],
    ]));

    const runner = buildRaccoonInboundRunner({ ...opts, approvalValues: store });
    const approvalCtx = { ...ctx, text: 'Approve', approval: { refId: 'req-1', choice: 'Approve' } };
    for await (const _chunk of runner.run(approvalCtx)) { /* drain */ }

    // The resolved VALUE (not the label) and the refId must both be present —
    // previously the label alone reached OpenClaw with no refId at all.
    expect(capturedBody).toContain('approve:task-42');
    expect(capturedBody).toContain('req-1');
    expect(capturedBody).not.toBe('Approve'); // not just the raw label

    // A refId never remembered here (e.g. a request built elsewhere) falls
    // back to the raw label rather than throwing or losing the choice.
    const unknownRefCtx = { ...ctx, text: 'approve', approval: { refId: 'unknown-req', choice: 'approve' } };
    for await (const _chunk of runner.run(unknownRefCtx)) { /* drain */ }
    expect(capturedBody).toContain('approve');
    expect(capturedBody).toContain('unknown-req');
  });

  it('resolves an approve-command tap DIRECTLY over the approvals gateway — no chat turn dispatched (#5)', async () => {
    const store = createApprovalValueStore();
    store.remember('req-2', ctx.userId, new Map([
      ['Approve', { value: 'approve req-2 allow-once', isCommand: true }],
    ]));

    const runner = buildRaccoonInboundRunner({ ...opts, approvalValues: store });
    const approvalCtx = { ...ctx, text: 'Approve', approval: { refId: 'req-2', choice: 'Approve' } };
    const chunks: string[] = [];
    for await (const chunk of runner.run(approvalCtx)) chunks.push(chunk);

    // Direct resolution: dispatching a /approve chat turn on the same
    // sessionKey rebinds the session while the exec turn is blocked in
    // waitDecision, dropping the completion follow-up (issue #5).
    expect(mockResolveGateway).toHaveBeenCalledTimes(1);
    expect(mockResolveGateway).toHaveBeenCalledWith({
      cfg: opts.cfg,
      approvalId: 'req-2',
      decision: 'allow-once',
      senderId: ctx.userId,
      clientDisplayName: `Chat approval (raccoon:${ctx.userId})`,
    });
    expect(mockDispatch).not.toHaveBeenCalled();
    // Success is silent: the forwarder's resolved payload is the confirmation.
    expect(chunks).toEqual([]);
  });

  it('an approve command that already carries its leading slash parses the same (#R5-2 lineage)', async () => {
    // OpenClaw supplies action.command WITH its leading slash; the stored
    // value preserves it verbatim. The tap intercept must parse both forms
    // to the same gateway resolution.
    const store = createApprovalValueStore();
    store.remember('req-4', ctx.userId, new Map([
      ['Approve', { value: '/approve req-4 allow-once', isCommand: true }],
    ]));

    const runner = buildRaccoonInboundRunner({ ...opts, approvalValues: store });
    const approvalCtx = { ...ctx, text: 'Approve', approval: { refId: 'req-4', choice: 'Approve' } };
    for await (const _chunk of runner.run(approvalCtx)) { /* drain */ }

    expect(mockResolveGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'req-4', decision: 'allow-once' }),
    );
    expect(mockDispatch).not.toHaveBeenCalled();
  });

  it('a NON-approve command choice still dispatches as a standalone slash command, single-slashed (#R4-2/#R5-2)', async () => {
    let capturedBody: string | undefined;
    mockDispatch.mockImplementation(async (arg) => {
      capturedBody = (arg.ctxPayload as { Body: string }).Body;
      arg.dispatcher.sendFinalReply({ text: 'ok' });
      arg.dispatcher.markComplete();
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } } as DispatchFromConfigResult;
    });

    // '/deny deploy-9' is a command but NOT `approve <id> <decision>` — it
    // keeps the ordinary dispatch path (OpenClaw's command parser handles it),
    // normalized to exactly one leading slash.
    const store = createApprovalValueStore();
    store.remember('req-4b', ctx.userId, new Map([
      ['Deny', { value: '/deny deploy-9', isCommand: true }],
    ]));

    const runner = buildRaccoonInboundRunner({ ...opts, approvalValues: store });
    const approvalCtx = { ...ctx, text: 'Deny', approval: { refId: 'req-4b', choice: 'Deny' } };
    for await (const _chunk of runner.run(approvalCtx)) { /* drain */ }

    expect(capturedBody).toBe('/deny deploy-9');
    expect(mockResolveGateway).not.toHaveBeenCalled();
  });

  it('does NOT send a command-type choice as a slash command when the user edited the text instead (#R4-2)', async () => {
    let capturedBody: string | undefined;
    mockDispatch.mockImplementation(async (arg) => {
      capturedBody = (arg.ctxPayload as { Body: string }).Body;
      arg.dispatcher.sendFinalReply({ text: 'ok' });
      arg.dispatcher.markComplete();
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } } as DispatchFromConfigResult;
    });

    const store = createApprovalValueStore();
    store.remember('req-3', ctx.userId, new Map([
      ['edit', { value: 'approve req-3 allow-once', isCommand: true }],
    ]));

    const runner = buildRaccoonInboundRunner({ ...opts, approvalValues: store });
    const approvalCtx = {
      ...ctx, text: 'my custom reply',
      approval: { refId: 'req-3', choice: 'edit', editedText: 'my custom reply' },
    };
    for await (const _chunk of runner.run(approvalCtx)) { /* drain */ }

    expect(capturedBody).not.toMatch(/^\//);
    expect(capturedBody).toContain('my custom reply');
  });

  it('competing responses to one approval cannot both act — the loser degrades to the bracket tag (#R6-1)', async () => {
    // The bridge dedups by ENVELOPE id, not refId, so two distinct clicks
    // (Allow, then Deny — two envelopes, same refId) both reach the runner.
    // With resolution-as-reservation, only the first resolves the approval
    // (now directly over the gateway); the second must degrade to the
    // non-command bracket tag, never a competing decision.
    const bodies: string[] = [];
    mockDispatch.mockImplementation(async (arg) => {
      bodies.push((arg.ctxPayload as { Body: string }).Body);
      arg.dispatcher.sendFinalReply({ text: 'ok' });
      arg.dispatcher.markComplete();
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } } as DispatchFromConfigResult;
    });

    const store = createApprovalValueStore();
    store.remember('req-7', ctx.userId, new Map([
      ['Allow', { value: 'approve req-7 allow-once', isCommand: true }],
      ['Deny', { value: 'approve req-7 deny', isCommand: true }],
    ]));

    const runner = buildRaccoonInboundRunner({ ...opts, approvalValues: store });
    const allow = { ...ctx, text: 'Allow', approval: { refId: 'req-7', choice: 'Allow' } };
    const deny = { ...ctx, text: 'Deny', approval: { refId: 'req-7', choice: 'Deny' } };

    // CONCURRENT taps: park Allow's gateway resolution mid-flight (its
    // reservation already taken) while Deny arrives. Deny's resolve() finds
    // the entry reserved and degrades to the bracket tag.
    let releaseAllow!: () => void;
    const allowGate = new Promise<void>((r) => { releaseAllow = r; });
    mockResolveGateway.mockImplementationOnce(async () => { await allowGate; });

    const allowDone = (async () => { for await (const _chunk of runner.run(allow)) { /* drain */ } })();
    await new Promise((r) => setTimeout(r, 10)); // Allow reserved + parked in gateway resolution
    const denyDone = (async () => { for await (const _chunk of runner.run(deny)) { /* drain */ } })();
    await new Promise((r) => setTimeout(r, 10)); // Deny degraded + dispatched while Allow is mid-flight
    releaseAllow();
    await Promise.all([allowDone, denyDone]);

    expect(mockResolveGateway).toHaveBeenCalledTimes(1); // only Allow acted
    expect(mockResolveGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'req-7', decision: 'allow-once' }),
    );
    expect(bodies).toHaveLength(1); // only the degraded loser dispatched a turn
    expect(bodies[0]).not.toMatch(/^\//); // degraded, not a competing command
    expect(bodies[0]).toContain('req-7'); // still correlated for the agent
  });

  it('an edited response does not reserve the approval, so a concurrent real click still resolves it (#R6-1b)', async () => {
    // An edited free-text response can NEVER act on the approval (it goes out
    // as bracket text). Reserving the approval for the duration of its
    // (potentially long) turn would make a concurrent real Allow degrade to
    // ordinary text while the edit later rolls back. The edit must not
    // reserve at all.
    const bodies: string[] = [];
    let releaseEdit!: () => void;
    const editGate = new Promise<void>((r) => { releaseEdit = r; });
    mockDispatch
      .mockImplementationOnce(async (arg) => { // the edited turn — parks mid-flight
        bodies.push((arg.ctxPayload as { Body: string }).Body);
        await editGate;
        arg.dispatcher.sendFinalReply({ text: 'ok' });
        arg.dispatcher.markComplete();
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } } as DispatchFromConfigResult;
      });

    const store = createApprovalValueStore();
    store.remember('req-8', ctx.userId, new Map([
      ['Allow', { value: 'approve req-8 allow-once', isCommand: true }],
    ]));
    const runner = buildRaccoonInboundRunner({ ...opts, approvalValues: store });

    const editTurn = (async () => {
      for await (const _ of runner.run({
        ...ctx, text: 'wait, let me explain',
        approval: { refId: 'req-8', choice: 'Allow', editedText: 'wait, let me explain' },
      })) { /* drain */ }
    })();
    await new Promise((r) => setTimeout(r, 10)); // edit turn is parked mid-flight

    // The real Allow click, while the edit is still running: it must resolve
    // the approval (directly over the gateway), not find it reserved.
    for await (const _ of runner.run({ ...ctx, text: 'Allow', approval: { refId: 'req-8', choice: 'Allow' } })) { /* drain */ }
    releaseEdit();
    await editTurn;

    expect(bodies[0]).not.toMatch(/^\//); // the edit went out as bracket text
    expect(mockResolveGateway).toHaveBeenCalledWith( // the real click still acted
      expect.objectContaining({ approvalId: 'req-8', decision: 'allow-once' }),
    );
  });

  it('an edited response is correlated to its refId only when it VALIDATES against the caller\'s own approval (#R7-CQ)', async () => {
    const bodies: string[] = [];
    mockDispatch.mockImplementation(async (arg) => {
      bodies.push((arg.ctxPayload as { Body: string }).Body);
      arg.dispatcher.sendFinalReply({ text: 'ok' });
      arg.dispatcher.markComplete();
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } } as DispatchFromConfigResult;
    });

    const store = createApprovalValueStore();
    // The approval belongs to a DIFFERENT user; ctx.userId does not own it.
    store.remember('req-x', 'someone-else', new Map([['Approve', { value: 'approve req-x allow-once', isCommand: true }]]));
    const runner = buildRaccoonInboundRunner({ ...opts, approvalValues: store });

    // An edited response from ctx.userId, tagging another user's refId, must
    // NOT be correlated (no bracket tag / refId leakage) — just plain text.
    await (async () => {
      for await (const _ of runner.run({
        ...ctx, text: 'sneaky', approval: { refId: 'req-x', choice: 'Approve', editedText: 'sneaky' },
      })) { /* drain */ }
    })();
    expect(bodies[0]).toBe('sneaky');
    expect(bodies[0]).not.toContain('req-x'); // no cross-user refId correlation

    // The SAME user's own valid approval, edited, IS correlated.
    store.remember('req-y', ctx.userId, new Map([['Approve', { value: 'approve req-y allow-once', isCommand: true }]]));
    await (async () => {
      for await (const _ of runner.run({
        ...ctx, text: 'my note', approval: { refId: 'req-y', choice: 'Approve', editedText: 'my note' },
      })) { /* drain */ }
    })();
    expect(bodies[1]).toContain('req-y'); // correlated
    expect(bodies[1]).toContain('my note');
    expect(bodies[1]).not.toMatch(/^\//); // still not a command (edited)
  });

  it('a failed gateway resolution does not burn the approval — it yields an error line and a retry tap still resolves (#R5-8 lineage)', async () => {
    mockResolveGateway
      .mockRejectedValueOnce(new Error('unknown or expired approval id'))
      .mockResolvedValueOnce(undefined);

    const store = createApprovalValueStore();
    store.remember('req-5', ctx.userId, new Map([
      ['Approve', { value: 'approve req-5 allow-once', isCommand: true }],
    ]));

    const runner = buildRaccoonInboundRunner({ ...opts, approvalValues: store });
    const approvalCtx = { ...ctx, text: 'Approve', approval: { refId: 'req-5', choice: 'Approve' } };

    // First tap: resolution fails. The user gets a plain error line (never a
    // throw that would surface as a failed ack with no explanation), and the
    // reservation rolls back — the entry is NOT consumed.
    const chunks: string[] = [];
    for await (const chunk of runner.run(approvalCtx)) chunks.push(chunk);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toContain('unknown or expired approval id');
    expect(mockDispatch).not.toHaveBeenCalled();

    // Retry tap: the mapping is still there and resolves again.
    for await (const _chunk of runner.run(approvalCtx)) { /* drain */ }
    expect(mockResolveGateway).toHaveBeenCalledTimes(2);
    expect(mockResolveGateway).toHaveBeenLastCalledWith(
      expect.objectContaining({ approvalId: 'req-5', decision: 'allow-once' }),
    );
  });

  it('a transient dispatch failure does not burn a NON-approve command choice — the retry still dispatches it (#R5-8)', async () => {
    let capturedBody: string | undefined;
    mockDispatch
      .mockImplementationOnce(async () => { throw new Error('transient dispatch outage'); })
      .mockImplementationOnce(async (arg) => {
        capturedBody = (arg.ctxPayload as { Body: string }).Body;
        arg.dispatcher.sendFinalReply({ text: 'ok' });
        arg.dispatcher.markComplete();
        return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } } as DispatchFromConfigResult;
      });

    const store = createApprovalValueStore();
    store.remember('req-5b', ctx.userId, new Map([
      ['Deny', { value: 'deny deploy-5b', isCommand: true }],
    ]));

    const runner = buildRaccoonInboundRunner({ ...opts, approvalValues: store });
    const approvalCtx = { ...ctx, text: 'Deny', approval: { refId: 'req-5b', choice: 'Deny' } };
    // First attempt: dispatch throws. The store entry must NOT have been
    // consumed — nothing was actually delivered to OpenClaw.
    await expect(async () => {
      for await (const _chunk of runner.run(approvalCtx)) { /* drain */ }
    }).rejects.toThrow('transient dispatch outage');

    // Retry (the bridge redelivers / the user clicks again): still resolves
    // to the real slash command instead of degrading to the bracket tag.
    for await (const _chunk of runner.run(approvalCtx)) { /* drain */ }
    expect(capturedBody).toBe('/deny deploy-5b');
  });

  it('an edited response does not consume the command mapping — a later real click still resolves it (#R5-8)', async () => {
    const bodies: string[] = [];
    mockDispatch.mockImplementation(async (arg) => {
      bodies.push((arg.ctxPayload as { Body: string }).Body);
      arg.dispatcher.sendFinalReply({ text: 'ok' });
      arg.dispatcher.markComplete();
      return { queuedFinal: true, counts: { tool: 0, block: 0, final: 1 } } as DispatchFromConfigResult;
    });

    const store = createApprovalValueStore();
    store.remember('req-6', ctx.userId, new Map([
      ['Approve', { value: 'approve req-6 allow-once', isCommand: true }],
    ]));

    const runner = buildRaccoonInboundRunner({ ...opts, approvalValues: store });
    // The user types a free-text reply first — delivered as the bracket-tag
    // fallback, which does NOT act on the still-pending OpenClaw approval.
    const edited = {
      ...ctx, text: 'tell me more first',
      approval: { refId: 'req-6', choice: 'Approve', editedText: 'tell me more first' },
    };
    for await (const _chunk of runner.run(edited)) { /* drain */ }

    // Then actually clicks Approve. The mapping must still be there, and it
    // resolves directly over the gateway (no second turn on the session).
    const clicked = { ...ctx, text: 'Approve', approval: { refId: 'req-6', choice: 'Approve' } };
    for await (const _chunk of runner.run(clicked)) { /* drain */ }

    expect(bodies[0]).not.toMatch(/^\//);
    expect(bodies).toHaveLength(1); // the click did not dispatch a turn
    expect(mockResolveGateway).toHaveBeenCalledWith(
      expect.objectContaining({ approvalId: 'req-6', decision: 'allow-once' }),
    );
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
      // Issue #4: the routable reply target, in the outbound adapter's own
      // 'user:<id>' format. OpenClaw persists it as the session origin's `to`
      // and hands it to the exec tool as turnSourceTo — without it the
      // exec-approval forwarder resolves NO delivery target for this channel.
      To: `user:${ctx.userId}`,
      SessionKey: `raccoon:user:${ctx.userId}`,
      AgentId: opts.agentId,
      MessageSid: ctx.messageId,
      CommandAuthorized: true, // no gate wired here -> reachable at all -> upstream-authorized (R2-4)
      // R3-3: without these, commands.allowFrom.raccoon cannot be enforced by
      // OpenClaw (it can't attribute the message to a provider/sender).
      Provider: 'raccoon',
      SenderId: ctx.userId,
      ChatType: 'direct',
      AccountId: opts.accountId,
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
    accountId: 'default',
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
