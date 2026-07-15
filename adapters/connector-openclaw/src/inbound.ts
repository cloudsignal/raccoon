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
import { dispatchReplyFromConfigWithSettledDispatcher } from 'openclaw/plugin-sdk/channel-inbound';
import type {
  FinalizedMsgContext,
  ReplyDispatchKind,
  ReplyDispatcher,
  ReplyPayload,
} from 'openclaw/plugin-sdk/reply-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import type { DispatchFromConfigResult } from './openclaw-missing-types.js';
import type { ApprovalChoice, ApprovalValueStore } from './approval-values.js';

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
  /** The gateway account id (e.g. 'default'). Populated into
   *  FinalizedMsgContext.AccountId so OpenClaw can resolve per-provider
   *  command authorization (commands.allowFrom.raccoon) correctly. */
  accountId: string;
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

/**
 * Render an approval decision as text OpenClaw can act on.
 *
 * R4-2: when `resolved` is a REAL OpenClaw slash command (isCommand: true —
 * e.g. an exec-approval action, {type:'command', command:'approve <id>
 * allow-once'}), it must be sent back as a STANDALONE message starting with
 * `/` — confirmed contract: "commands sent as standalone messages starting
 * with /". The previous implementation always wrapped the choice in a
 * `[approval.response ...]` bracket tag, which never starts with `/`, so
 * OpenClaw's command parser never recognized it and treated exec-approval
 * clicks as ordinary agent text — the approval itself never actually
 * resolved.
 *
 * A free-text edit is never sent as a command, regardless of what the
 * clicked button's action was — appending user-authored text to a command
 * line would be both nonsensical and unsafe.
 *
 * When `resolved` is absent (the refId was never remembered here, resolution
 * failed exact-choice/ownership/expiry validation — see approval-values.ts)
 * or is a non-command choice, falls back to the descriptive bracket-tag text
 * carrying the refId, so OpenClaw still sees which pending request this turn
 * answers instead of an unrelated-looking message.
 */
function buildApprovalText(
  approval: NonNullable<AgentContext['approval']>,
  resolved: ApprovalChoice | undefined,
  editValidated: boolean,
): string {
  if (resolved?.isCommand && approval.editedText === undefined) {
    // Normalize to EXACTLY one leading slash (#R5-2): OpenClaw supplies
    // action.command WITH its slash, and the store preserves values
    // verbatim, so blindly prepending '/' produced '//approve …' — which
    // OpenClaw's command parser does not recognize as a command at all.
    return `/${resolved.value.replace(/^\/+/, '')}`;
  }
  if (approval.editedText !== undefined) {
    // #R7-CQ: only correlate the edit to its refId if it passed validation
    // (this user's own, still-valid, real approval). An unvalidated edit is
    // delivered as a plain, uncorrelated message — it must not tag itself to
    // a refId it has no authorized claim to.
    return editValidated
      ? `[approval.response refId=${approval.refId} choice=${approval.choice}] ${approval.editedText}`
      : approval.editedText;
  }
  return `[approval.response refId=${approval.refId} choice=${resolved?.value ?? approval.choice}]`;
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
  // reached OpenClaw as an unstructured, unrelated-looking message. Resolve
  // the label back to its ApprovalChoice via the same store the outbound
  // adapter recorded it into, scoped to THIS user (ctx.userId) — see
  // approval-values.ts for the ownership/expiry/exact-choice validation
  // this performs. buildApprovalText then either sends a REAL OpenClaw
  // slash command (isCommand) or the descriptive bracket-tag fallback
  // carrying the refId, so OpenClaw/the agent can correlate this turn to
  // the specific pending approval either way.
  //
  // #R5-8: resolve() no longer consumes — resolvedApproval.commit() below
  // (after a successful dispatch) does. Consuming at resolve burned the
  // approval on any transient dispatch failure.
  //
  // #R6-1b: only resolve (and therefore RESERVE, #R6-1) for a real click. An
  // edited free-text response can never execute the command — it goes out as
  // bracket text regardless — so reserving the approval for the duration of
  // its (possibly long) turn would make a concurrent real Allow/Deny find the
  // approval taken and degrade to ordinary text (acked as success) while the
  // edit later rolls the reservation back. Skipping resolve() for edits
  // leaves the approval free for the click that actually acts on it.
  const resolvedApproval = ctx.approval && ctx.approval.editedText === undefined
    ? opts.approvalValues?.resolve(ctx.approval.refId, ctx.userId, ctx.approval.choice)
    : undefined;
  // #R7-CQ: an EDITED response never reserves (above), but it must still be a
  // VALIDATED answer to this user's own, still-valid, real approval before it
  // is correlated to that refId. Otherwise a crafted edit could tag itself to
  // ANOTHER user's / an expired / an unlisted-choice refId. Validate
  // (read-only: ownership + TTL + exact-choice); if it fails, drop the refId
  // correlation and treat the text as a plain, uncorrelated message.
  const editValidated = ctx.approval !== undefined
    && ctx.approval.editedText !== undefined
    && (opts.approvalValues?.validate(ctx.approval.refId, ctx.userId, ctx.approval.choice) ?? false);
  const approvalText = ctx.approval
    ? buildApprovalText(ctx.approval, resolvedApproval?.choice, editValidated)
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
    // Provider + SenderId let OpenClaw resolve commands.allowFrom.raccoon
    // correctly. Without these, an operator setting a per-provider allowlist
    // (commands.allowFrom.raccoon = [...]) cannot have it enforced: OpenClaw
    // can't attribute the message to the 'raccoon' provider or this specific
    // sender, and falls back to authorizing anyone. ChatType is always
    // 'direct' (Raccoon's capabilities declare chatTypes: ['direct'] only).
    Provider: 'raccoon',
    SenderId: ctx.userId,
    ChatType: 'direct',
    AccountId: opts.accountId,
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

  let reservationSettled = false;
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

    // #R5-8/#R6-1: the turn dispatched successfully — commit (final,
    // replay-proof consumption). resolvedApproval only exists for a real
    // click now (#R6-1b: edits never resolve/reserve), so there is no
    // edited-path rollback to do here.
    resolvedApproval?.commit();
    reservationSettled = true;
  } catch (err) {
    // #R5-8/#R6-1: the dispatch failed — release the reservation so a retry
    // can resolve the command again, instead of the approval being burned.
    resolvedApproval?.rollback();
    reservationSettled = true;
    throw err;
  } finally {
    // #R8-CQ: if the CONSUMER exited early (break / return) the reservation
    // was neither committed nor rolled back here — and resolve() already
    // REMOVED the entry, so the store's TTL can NOT recover it (the earlier
    // comment claiming so was wrong). The turn is not cancellable and runs to
    // completion in the background, so settle the reservation on ITS eventual
    // outcome: commit on success, rollback on failure (so a background
    // dispatch failure still frees the approval for retry). commit/rollback
    // are single-use, so this is a no-op if the try/catch already settled.
    if (!reservationSettled && resolvedApproval) {
      dispatchPromise.then(() => resolvedApproval.commit(), () => resolvedApproval.rollback());
    }
    // Suppress any late dispatchPromise rejection so it can't surface as an
    // unhandled rejection.
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
