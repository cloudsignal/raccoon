import type { AgentRunner } from '@raccoon/bridge';
import type { ChannelSetup, InboundChatContent, InboundMessage } from './nanoclaw-types.js';
import type { ApprovalValueStore } from './approvals.js';
import { absolutizeMediaPaths, toNanoClawAttachments } from './media.js';
import { toPlatformId } from './platform-id.js';
import type { TurnStore } from './turns.js';

export interface HostCallbacks {
  onInbound: ChannelSetup['onInbound'];
  onAction: ChannelSetup['onAction'];
}

/** The raccoon side of the seam: forwards a user turn into NanoClaw's host
 *  callbacks and parks awaiting the matching deliver() (settled by the
 *  adapter). Turns are SERIALIZED per conversation here because the raccoon
 *  bridge runs each envelope handler independently — without this, two rapid
 *  messages would open overlapping turns and receive each other's replies.
 *  Timeout yields nothing; the late reply flows out via the adapter's async
 *  deliver fallback, so nothing is dropped. */
export function buildNanoClawRunner(deps: {
  host: () => HostCallbacks | null;
  turns: TurnStore;
  approvalValues: ApprovalValueStore;
  publicOrigin: string;
  turnTimeoutMs: number;
}): AgentRunner {
  const chains = new Map<string, Promise<void>>();

  return {
    async *run(ctx) {
      const platformId = toPlatformId(ctx.channel, ctx.userId);

      // Per-conversation mutex: wait for the previous turn, register ourselves.
      const prev = chains.get(platformId) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => { release = r; });
      const chained = prev.then(() => mine);
      chains.set(platformId, chained);
      await prev;

      try {
        // Resolve the host AFTER the mutex: a queued turn must see the
        // CURRENT lifecycle state, not the one captured when it enqueued —
        // otherwise it would run against a torn-down adapter's callbacks.
        const host = deps.host();
        if (!host) throw new Error('raccoon adapter not set up (setup() has not run)');

        if (ctx.approval) {
          // Fail closed on a lost mapping: never answer a card with a guessed
          // value (wrong-action risk when values differ from labels).
          const value = deps.approvalValues.resolveValue(ctx.approval.refId, ctx.approval.choice);
          if (value === null) {
            console.error(`raccoon: approval ${ctx.approval.refId} has no value mapping (restart/eviction) — not answering`);
            return;
          }
          // Open BEFORE forwarding: a host that delivers synchronously must
          // find the turn already registered.
          const reply = deps.turns.open(platformId, deps.turnTimeoutMs);
          await host.onAction(ctx.approval.refId, value, ctx.userId);
          const text = await reply;
          if (text !== null && text.length > 0) yield text;
          return;
        }

        const reply = deps.turns.open(platformId, deps.turnTimeoutMs);
        const attachments = toNanoClawAttachments(ctx.attachments, deps.publicOrigin);
        const content: InboundChatContent = {
          sender: ctx.userId,
          senderId: ctx.userId,
          text: absolutizeMediaPaths(ctx.text, deps.publicOrigin),
          ...(attachments.length > 0 ? { attachments } : {}),
          isFromMe: false,
        };
        const message: InboundMessage = {
          id: ctx.messageId,
          kind: 'chat',
          content,
          timestamp: new Date().toISOString(),
          // Required: the router's auto-create/registration flow for unwired
          // conversations only fires on mentions; raccoon chats are DMs.
          isMention: true,
          isGroup: false,
        };
        await host.onInbound(platformId, null, message);

        const text = await reply;
        if (text !== null && text.length > 0) yield text;
      } finally {
        release();
        if (chains.get(platformId) === chained) chains.delete(platformId);
      }
    },
  };
}
