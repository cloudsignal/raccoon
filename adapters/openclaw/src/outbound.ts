// adapters/openclaw/src/outbound.ts
//
// Factory for the Raccoon ChannelOutboundAdapter (Task 4, channel-native plan).
//
// WHAT THIS DOES:
//   createRaccoonOutbound(deps) → a ChannelOutboundAdapter that OpenClaw
//   calls when it needs to deliver an agent reply to a Raccoon user.
//
// REAL SDK SHAPE (outbound.types-CHpw9VBQ.d.ts):
//   ChannelOutboundAdapter = {
//     deliveryMode: 'direct' | 'gateway' | 'hybrid';   ← REQUIRED
//     sendText?:    (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
//     sendPayload?: (ctx: ChannelOutboundPayloadContext) => Promise<OutboundDeliveryResult>;
//     chunker?:     ((text, limit, ctx?) => string[]) | null;   ← real SDK field name
//     ...
//   }
//
// CONTRACT NOTE — brief vs. real SDK divergence:
//   The brief described sendText as receiving `interactive?` payloads.
//   The real ChannelOutboundContext does NOT have `interactive`; that field lives
//   in ReplyPayload which arrives via sendPayload (ctx.payload.interactive).
//   We resolve this by implementing BOTH sendText and sendPayload:
//     - sendText: plain text + optional mediaUrls (from ctx; mediaUrls is not on
//       the real ChannelOutboundContext either, so handled via sendPayload fallback).
//     - sendPayload: inspects ctx.payload.interactive / ctx.payload.presentation
//       for buttons-like blocks → OAM approval.request; otherwise delegates to
//       the plain-text path.
//
// OAM CHANNEL SOURCE DECISION:
//   The `channel` for OAM envelopes is taken from the factory parameter (injected
//   at construction time), not from `ctx.accountId` or `channelData`. Rationale:
//   a Raccoon deployment routes all user messages through one named OAM channel
//   (e.g. 'coordinator'); the factory is constructed once per account/channel
//   lifecycle (T7's gateway.startAccount), so the channel is stable. It is
//   injectable via `deps.channel` to support multiple channels in one instance.

import {
  createEnvelope,
  userAddress,
  agentAddress,
  type AnyEnvelope,
} from '@raccoon/protocol';
import type { OutboundHub } from '@raccoon/bridge';
import { chunkReplyText } from './formatting.js';
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelOutboundPayloadContext,
  ChannelOutboundChunkContext,
  OutboundDeliveryResult,
  InteractiveReply,
} from 'openclaw/plugin-sdk/channel-core';
import { ulid } from 'ulid';

// ---------------------------------------------------------------------------
// Factory deps
// ---------------------------------------------------------------------------

export interface RaccoonOutboundDeps {
  /**
   * The hub that delivers OAM envelopes to connected Raccoon users.
   * Structurally matches @raccoon/bridge OutboundHub.
   */
  hub: OutboundHub;
  /**
   * OAM channel name to use as envelope.channel and the source agent address.
   * Typically the agent's role name (e.g. 'coordinator'). Injectable so that
   * multi-channel Raccoon deployments can construct one adapter per channel.
   */
  channel: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Parse a Raccoon target string of the form `user:<userId>` and return the
 * userId portion. Throws if the format is unexpected.
 */
function parseRaccoonUserId(to: string): string {
  const prefix = 'user:';
  if (!to.startsWith(prefix)) {
    throw new Error(
      `raccoon outbound: malformed target "${to}" (expected "user:<id>")`,
    );
  }
  const id = to.slice(prefix.length);
  if (id.length === 0) {
    throw new Error(
      `raccoon outbound: malformed target "${to}" (user id portion is empty)`,
    );
  }
  return id;
}

/**
 * Send one or more OAM `msg` envelopes for the given text chunks in order.
 * Returns the id of the FIRST envelope (used as messageId in the result).
 */
function sendMsgChunks(
  hub: OutboundHub,
  channel: string,
  userId: string,
  chunks: string[],
): string {
  const nonEmpty = chunks.filter((c) => c.length > 0);
  if (nonEmpty.length === 0) {
    throw new Error('raccoon outbound: nothing to send (empty reply text)');
  }
  let firstId = '';
  for (const chunk of nonEmpty) {
    const env = createEnvelope('msg', {
      from: agentAddress(channel),
      to: userAddress(userId),
      channel,
      payload: { text: chunk },
    });
    hub.sendToUser(userId, env);
    if (firstId === '') firstId = env.id;
  }
  return firstId;
}

/**
 * Try to extract a buttons block from an InteractiveReply (deprecated shape).
 * Returns the button labels as string[] if a 'buttons' block is found, or null
 * if there is no mappable buttons block.
 */
function extractButtonOptions(interactive: InteractiveReply): string[] | null {
  for (const block of interactive.blocks) {
    if (block.type === 'buttons' && block.buttons.length > 0) {
      return block.buttons.map((b) => b.label);
    }
  }
  return null;
}

/**
 * Extract all option labels from a non-buttons interactive (e.g. select blocks)
 * for use in the text fallback.
 */
function extractAllOptionLabels(interactive: InteractiveReply): string[] {
  const labels: string[] = [];
  for (const block of interactive.blocks) {
    if (block.type === 'select' && block.options.length > 0) {
      for (const opt of block.options) {
        labels.push(opt.label);
      }
    } else if (block.type === 'buttons' && block.buttons.length > 0) {
      for (const btn of block.buttons) {
        labels.push(btn.label);
      }
    }
  }
  return labels;
}

/**
 * Build an OutboundDeliveryResult with the given messageId.
 * The `channel` field is typed as `Exclude<ChannelId, "none">` in the real SDK;
 * we cast to string & {} which is the external-plugin-safe widened form.
 */
function makeResult(messageId: string, channelName: string): OutboundDeliveryResult {
  return {
    channel: channelName as OutboundDeliveryResult['channel'],
    messageId,
  };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a ChannelOutboundAdapter that routes OpenClaw's outbound replies to
 * a Raccoon user via OAM envelopes over the given hub.
 *
 * @param deps.hub     - Hub that sends OAM envelopes to connected Raccoon users.
 * @param deps.channel - OAM channel name (e.g. 'coordinator'); used as
 *                       envelope.channel and the from: agent:<channel> address.
 */
export function createRaccoonOutbound(deps: RaccoonOutboundDeps): ChannelOutboundAdapter {
  const { hub, channel } = deps;

  // ------------------------------------------------------------------
  // sendText — plain text delivery
  //
  // ctx.to = 'user:<raccoonUserId>'
  // ctx.text = the agent's reply text
  //
  // OpenClaw calls this for plain text replies. mediaUrls (if needed) arrive
  // via sendPayload (payload.mediaUrls). The real ChannelOutboundContext does
  // not carry mediaUrls directly; if a caller provides them we'd handle via
  // sendPayload. This function therefore handles the minimal sendText surface.
  // ------------------------------------------------------------------
  async function sendText(ctx: ChannelOutboundContext): Promise<OutboundDeliveryResult> {
    const userId = parseRaccoonUserId(ctx.to);
    const chunks = chunkReplyText(ctx.text);
    const firstId = sendMsgChunks(hub, channel, userId, chunks);
    return makeResult(firstId, channel);
  }

  // ------------------------------------------------------------------
  // sendPayload — handles interactive (approval-style) payloads
  //
  // ctx.payload.interactive?: InteractiveReply (deprecated but still used)
  // ctx.payload.presentation?: MessagePresentation (newer shape — not yet
  //   mapped; falls through to text delivery; a future task can add
  //   presentationCapabilities and render natively).
  //
  // Interactive mapping strategy:
  //   - Find a 'buttons' block → emit one OAM approval.request envelope.
  //   - No 'buttons' block (e.g. select-only) → text fallback that includes
  //     the option labels as a plain list (all envelopes are 'msg').
  //   - No interactive at all → delegate to plain text path (same as sendText).
  // ------------------------------------------------------------------
  async function sendPayload(
    ctx: ChannelOutboundPayloadContext,
  ): Promise<OutboundDeliveryResult> {
    const userId = parseRaccoonUserId(ctx.to);
    const payload = ctx.payload;

    // Normalise the interactive field.
    const interactive = payload.interactive as InteractiveReply | undefined;

    if (interactive && Array.isArray(interactive.blocks) && interactive.blocks.length > 0) {
      // Try to extract button options → approval.request.
      const options = extractButtonOptions(interactive);
      if (options !== null) {
        // Map to OAM approval.request.
        const refId = ulid();
        const title =
          typeof payload.text === 'string' && payload.text.trim().length > 0
            ? payload.text.trim()
            : 'Approval required';
        const env = createEnvelope('approval.request', {
          from: agentAddress(channel),
          to: userAddress(userId),
          channel,
          payload: {
            refId,
            title,
            description: '',
            options,
          },
        });
        hub.sendToUser(userId, env);
        return makeResult(env.id, channel);
      }

      // Unmappable interactive (e.g. select-only): text fallback listing options.
      const labels = extractAllOptionLabels(interactive);
      const baseText =
        typeof payload.text === 'string' && payload.text.trim().length > 0
          ? payload.text.trim()
          : 'Please choose one of the following options:';
      const optionsList = labels.map((l, i) => `${i + 1}. ${l}`).join('\n');
      const fallbackText = labels.length > 0
        ? `${baseText}\n\n${optionsList}`
        : baseText;
      const chunks = chunkReplyText(fallbackText);
      const firstId = sendMsgChunks(hub, channel, userId, chunks);
      return makeResult(firstId, channel);
    }

    // No interactive — plain text path (same logic as sendText).
    const text =
      typeof payload.text === 'string' && payload.text.length > 0
        ? payload.text
        : ctx.text;
    const chunks = chunkReplyText(text);
    const firstId = sendMsgChunks(hub, channel, userId, chunks);
    return makeResult(firstId, channel);
  }

  // ------------------------------------------------------------------
  // chunker — public helper exposed on the adapter object
  // OpenClaw core calls this to pre-chunk text using the channel's
  // preferred strategy. Field name and signature mirror the real SDK
  // (outbound.types-CHpw9VBQ.d.ts line 205):
  //   chunker?: ((text: string, limit: number, ctx?: ChannelOutboundChunkContext) => string[]) | null
  // The ctx parameter is accepted for SDK compat but not used here — the
  // formatting.ts limit/mode defaults are sufficient for the Raccoon channel.
  // ------------------------------------------------------------------
  function chunker(text: string, limit: number, _ctx?: ChannelOutboundChunkContext): string[] {
    return chunkReplyText(text, limit);
  }

  return {
    deliveryMode: 'gateway',
    sendText,
    sendPayload,
    chunker,
  };
}
