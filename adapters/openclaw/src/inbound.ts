// adapters/openclaw/src/inbound.ts
// Bridges Raccoon's AgentRunner to OpenClaw's real inbound pipeline.
// Uses dispatchReplyFromConfigWithSettledDispatcher from
// openclaw/plugin-sdk/channel-inbound to drive a full agent turn, then
// collects ReplyPayload chunks via an async push-pull queue.
//
// Streaming-chunk policy (v1):
//   - We yield payload.text ONLY when OpenClaw calls sendFinalReply (one text
//     per full agent turn). Block payloads (sendBlockReply) and tool payloads
//     (sendToolResult) are intentionally skipped because the bridge
//     concatenates all yielded strings before sending one msg envelope to the
//     client. Forwarding block payloads would produce duplicate or partial
//     text. Streaming chunk-by-chunk to the client is a later concern; when
//     that work lands, replace this filter with yielding all non-empty
//     payload.text regardless of which send method called it.

import type { AgentContext, AgentRunner } from '@raccoon/bridge';
import {
  dispatchReplyFromConfigWithSettledDispatcher,
  type DispatchFromConfigResult,
  type FinalizedMsgContext,
  type OpenClawConfig,
  type ReplyDispatchKind,
  type ReplyDispatcher,
  type ReplyPayload,
} from 'openclaw/plugin-sdk/channel-inbound';
import type { ApprovalValueStore } from './approval-values.js';

export interface InboundRunnerOpts {
  /** The loaded OpenClaw config object (passed through from gateway context). */
  cfg: OpenClawConfig;
  /**
   * Filesystem path to the agent store directory.
   * Currently unused — reserved for Task 7's buildInboundReplyDispatchBase
   * wiring, which will pass it to the real dispatch base.
   */
  storePath: string;
  /** OpenClaw agent id to target for this channel. */
  agentId: string;
  /** Same store the outbound adapter records button values into (see
   *  approval-values.ts). Used to resolve ctx.approval.choice (a label) back
   *  to the button's real value before it reaches OpenClaw. */
  approvalValues?: ApprovalValueStore;
}

/**
 * Optional allowlist gate for the inbound runner.
 *
 * When provided and it returns false for a userId, the runner yields NOTHING
 * and does NOT invoke the agent. When absent, all users are allowed (backward-
 * compatible with the T1 behavior).
 */
export type CheckAllowed = (userId: string) => boolean;

export interface InboundRunnerGateOpts {
  /** If present and returns false, the user is denied — no agent run. */
  checkAllowed?: CheckAllowed;
}

/**
 * Builds an AgentRunner that drives OpenClaw's real inbound pipeline per
 * Raccoon message. Session key convention: `raccoon:user:<userId>`.
 *
 * @param opts - Static runner options (cfg, storePath, agentId).
 * @param gate - Optional allowlist gate. When absent, all users are allowed.
 */
export function buildRaccoonInboundRunner(
  opts: InboundRunnerOpts,
  gate?: InboundRunnerGateOpts,
): AgentRunner {
  return {
    run(ctx: AgentContext): AsyncIterable<string> {
      // Check allowlist gate before invoking the agent.
      if (gate?.checkAllowed && !gate.checkAllowed(ctx.userId)) {
        // Return an empty async iterable — no agent run, no reply.
        return (async function* () {})();
      }
      return runOneTurn(opts, ctx);
    },
  };
}

/** Render an approval decision as text carrying its refId and resolved value,
 *  so OpenClaw sees which pending request this turn answers instead of an
 *  unrelated-looking message. `resolvedValue` is the button's real value
 *  (falling back to its label) — see approval-values.ts. */
function buildApprovalText(
  approval: NonNullable<AgentContext['approval']>,
  resolvedValue: string,
): string {
  const tag = `[approval.response refId=${approval.refId} choice=${resolvedValue}]`;
  return approval.editedText !== undefined ? `${tag} ${approval.editedText}` : tag;
}

async function* runOneTurn(opts: InboundRunnerOpts, ctx: AgentContext): AsyncIterable<string> {
  // Async push-pull queue:
  //   - OpenClaw calls dispatcher.sendFinalReply() → enqueue() pushes text
  //   - OpenClaw calls dispatcher.markComplete()    → done = true, wake loop
  //   - generator pull loop yields and drains until done
  const queue: string[] = [];
  let done = false;
  let resolve: (() => void) | null = null;

  function enqueue(text: string): void {
    queue.push(text);
    resolve?.();
    resolve = null;
  }

  function wake(): void {
    resolve?.();
    resolve = null;
  }

  function waitForItem(): Promise<void> {
    if (queue.length > 0 || done) return Promise.resolve();
    return new Promise<void>((r) => {
      resolve = r;
    });
  }

  const sessionKey = `raccoon:user:${ctx.userId}`;

  // When this turn is a response to an approval.request, ctx.text is already
  // editedText ?? choice (set by RaccoonBridge), but that alone previously
  // reached OpenClaw as an unstructured, unrelated-looking message: the refId
  // and the button's real value (as opposed to its display label) were both
  // silently dropped. Resolve the label back to its value via the same store
  // the outbound adapter recorded it into, and prefix with the refId so
  // OpenClaw/the agent can correlate this turn to the specific pending
  // approval, instead of treating it as an arbitrary new chat message.
  const approvalText = ctx.approval
    ? buildApprovalText(ctx.approval, opts.approvalValues?.resolve(ctx.approval.refId, ctx.approval.choice) ?? ctx.approval.choice)
    : ctx.text;

  // Build a minimal FinalizedMsgContext from the Raccoon AgentContext.
  const ctxPayload: FinalizedMsgContext = {
    Body: approvalText,
    BodyForAgent: approvalText,
    CommandBody: approvalText,
    BodyForCommands: approvalText,
    From: ctx.userId,
    SessionKey: sessionKey,
    AgentId: opts.agentId,
    MessageSid: ctx.messageId,
    // INVARIANT: runOneTurn is private and reachable from exactly one call
    // site (run(), above), which already returns an empty iterable — never
    // reaching this function — when gate.checkAllowed denies the user. So by
    // the time we build this payload, the channel's own dmPolicy/allowFrom
    // gate has already authorized this sender. Per OpenClaw's documented
    // command-authorization fallback chain, "channel allowlists / pairing
    // access" is a recognized authorization source when OpenClaw's own
    // commands.allowFrom is not configured — which is exactly what our gate
    // represents. An operator wanting a STRICTER, command-specific allowlist
    // should set OpenClaw's own `commands.allowFrom` (per OpenClaw's docs,
    // this becomes the sole authorization source once configured,
    // superseding this). See adapters/openclaw/src/inbound.test.ts for the
    // test asserting the invariant this relies on.
    CommandAuthorized: true,
  };

  // Build the dispatcher that funnels final payloads into our queue.
  const dispatcher: ReplyDispatcher = buildDispatcher({
    onFinal(payload: ReplyPayload): void {
      if (payload.text) enqueue(payload.text);
    },
    onSettled(): void {
      done = true;
      wake();
    },
  });

  // Drive the agent turn.
  // The finally block guarantees settlement even if the SDK throws synchronously
  // or rejects without calling onSettled — preventing the generator from hanging
  // at waitForItem() indefinitely.
  //
  // NOTE: the underlying turn is not cancellable in v1. If the consumer breaks
  // early (for..of break / generator.return()), dispatchPromise continues
  // running in the background. The .catch(() => {}) in the finally branch
  // prevents an unhandled-rejection if it later rejects after the consumer
  // has gone away.
  const dispatchPromise: Promise<DispatchFromConfigResult> = (async () => {
    try {
      return await dispatchReplyFromConfigWithSettledDispatcher({
        cfg: opts.cfg,
        ctxPayload,
        dispatcher,
        onSettled(): void {
          done = true;
          wake();
        },
      });
    } finally {
      // Guaranteed settlement: covers synchronous throws and rejects that
      // occur without the SDK having called onSettled / markComplete.
      done = true;
      wake();
    }
  })();

  try {
    // Pull yielded texts as they arrive.
    while (true) {
      await waitForItem();
      while (queue.length > 0) {
        yield queue.shift()!;
      }
      if (done) break;
    }

    // Await the dispatch promise to propagate any errors thrown by OpenClaw.
    await dispatchPromise;
  } finally {
    // Guard: if the consumer exits early (break / return), suppress any
    // subsequent rejection from dispatchPromise so it cannot become an
    // unhandled rejection. The turn is not cancellable — it runs to
    // completion in the background.
    dispatchPromise.catch(() => {});
  }
}

// ---- Internal dispatcher builder ----

interface DispatcherCallbacks {
  onFinal: (payload: ReplyPayload) => void;
  onSettled: () => void;
}

function buildDispatcher(callbacks: DispatcherCallbacks): ReplyDispatcher {
  // Minimal ReplyDispatcher implementing the required interface.
  // OpenClaw calls sendFinalReply / sendBlockReply / sendToolResult to deliver
  // payloads. markComplete() is called when the turn is fully settled.
  const queued: Record<ReplyDispatchKind, number> = { tool: 0, block: 0, final: 0 };
  const failed: Record<ReplyDispatchKind, number> = { tool: 0, block: 0, final: 0 };

  let pendingDelivers = 0;
  let idleResolve: (() => void) | null = null;

  function trackDelivery(kind: ReplyDispatchKind, run: () => void): boolean {
    queued[kind] = (queued[kind] ?? 0) + 1;
    pendingDelivers++;
    try {
      run();
    } finally {
      pendingDelivers--;
      if (pendingDelivers === 0) {
        idleResolve?.();
        idleResolve = null;
      }
    }
    return true;
  }

  return {
    sendToolResult(payload: ReplyPayload): boolean {
      // Skipped per v1 streaming-chunk policy (see module header).
      return trackDelivery('tool', () => { void payload; });
    },

    sendBlockReply(payload: ReplyPayload): boolean {
      // Skipped per v1 streaming-chunk policy (see module header).
      return trackDelivery('block', () => { void payload; });
    },

    sendFinalReply(payload: ReplyPayload): boolean {
      return trackDelivery('final', () => { callbacks.onFinal(payload); });
    },

    waitForIdle(): Promise<void> {
      if (pendingDelivers === 0) return Promise.resolve();
      return new Promise<void>((r) => {
        idleResolve = r;
      });
    },

    getQueuedCounts(): Record<ReplyDispatchKind, number> {
      return { ...queued };
    },

    getFailedCounts(): Record<ReplyDispatchKind, number> {
      return { ...failed };
    },

    markComplete(): void {
      callbacks.onSettled();
    },
  };
}
