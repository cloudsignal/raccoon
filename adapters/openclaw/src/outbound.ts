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
import type { ApprovalValueStore } from './approval-values.js';
import type {
  ChannelOutboundAdapter,
  ChannelOutboundContext,
  ChannelOutboundPayloadContext,
  ChannelOutboundChunkContext,
  ChannelOutboundSendContext,
  OutboundDeliveryResult,
  InteractiveReply,
  InteractiveReplyButton,
  MessagePresentation,
  MessagePresentationButton,
  MessagePresentationOption,
  ReplyPayload,
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
  /**
   * Optional label -> value correlation store (see approval-values.ts).
   * When provided, every approval.request built from a buttons block records
   * each button's real `value` (falling back to its `label` when the SDK
   * didn't supply one), so the inbound runner can resolve the underlying
   * value once the human's choice comes back as a plain label string.
   */
  approvalValues?: ApprovalValueStore;
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
 * Returns the full button list (label AND optional value) if a 'buttons'
 * block is found, or null if there is no mappable buttons block. Returning
 * the full buttons (not just labels) lets the caller preserve each button's
 * `value` via the approval-value correlation store (see approval-values.ts).
 */
function findButtonsBlock(interactive: InteractiveReply): InteractiveReplyButton[] | null {
  for (const block of interactive.blocks) {
    if (block.type === 'buttons' && block.buttons.length > 0) return block.buttons;
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
// MessagePresentation helpers (R3-9 — real renderPresentation adoption)
// ---------------------------------------------------------------------------

/** First 'buttons' block's buttons, or null if none. */
function findPresentationButtons(presentation: MessagePresentation): MessagePresentationButton[] | null {
  for (const block of presentation.blocks) {
    if (block.type === 'buttons' && block.buttons.length > 0) return block.buttons;
  }
  return null;
}

/** First 'select' block's options, or null if none. Raccoon renders a select
 *  block the same way as a buttons block (a row of choice buttons) — its UI
 *  has no separate dropdown control, so this is a faithful native render,
 *  not a degraded fallback. */
function findPresentationSelect(presentation: MessagePresentation): MessagePresentationOption[] | null {
  for (const block of presentation.blocks) {
    if (block.type === 'select' && block.options.length > 0) return block.options;
  }
  return null;
}

/**
 * Resolve a button's underlying value: prefer the modern `action` field
 * ('callback' carries opaque plugin data; 'command' names a native slash
 * command Raccoon has no dispatcher for, so its command string is passed
 * through as the resolved value for whatever consumes the approval response
 * downstream), falling back to the legacy `value` field, then the label.
 * Per the spec, a 'callback' action's value must never be reinterpreted as a
 * slash command — this function only ever returns it as an opaque string.
 */
function resolvePresentationButtonValue(b: MessagePresentationButton): string {
  if (b.action?.type === 'callback') return b.action.value;
  if (b.action?.type === 'command') return b.action.command;
  return b.value ?? b.label;
}

/** Join the presentation's 'text'/'context' blocks (and blank lines for
 *  'divider') into a single string. 'chart' blocks are omitted — Raccoon
 *  declares presentationCapabilities.charts: false and has no faithful plain
 *  text rendering for chart data. */
function presentationTextBlocks(presentation: MessagePresentation): string {
  const lines: string[] = [];
  for (const block of presentation.blocks) {
    if (block.type === 'text' || block.type === 'context') lines.push(block.text);
    else if (block.type === 'divider') lines.push('');
  }
  return lines.join('\n').trim();
}

/**
 * Render a MessagePresentation to OAM envelopes: a buttons or select block
 * becomes one approval.request (select options rendered as choice buttons —
 * see findPresentationSelect); otherwise the presentation's text/context
 * blocks are sent as plain msg text, falling back to `fallbackText` if the
 * presentation carries no renderable text of its own.
 */
async function deliverPresentation(
  hub: OutboundHub,
  channel: string,
  approvalValues: ApprovalValueStore | undefined,
  userId: string,
  presentation: MessagePresentation,
  fallbackText: string,
): Promise<OutboundDeliveryResult> {
  const buttons = findPresentationButtons(presentation);
  const selectOptions = buttons === null ? findPresentationSelect(presentation) : null;

  if (buttons !== null || selectOptions !== null) {
    const choices: Array<{ label: string; value: string }> = buttons !== null
      ? buttons.map((b) => ({ label: b.label, value: resolvePresentationButtonValue(b) }))
      : selectOptions!.map((o) => ({ label: o.label, value: o.value ?? o.label }));

    const refId = ulid();
    const title = presentation.title?.trim()
      || (fallbackText.trim().length > 0 ? fallbackText.trim() : 'Approval required');
    const description = presentationTextBlocks(presentation);
    const env = createEnvelope('approval.request', {
      from: agentAddress(channel),
      to: userAddress(userId),
      channel,
      payload: { refId, title, description, options: choices.map((c) => c.label) },
    });
    approvalValues?.remember(refId, new Map(choices.map((c) => [c.label, c.value])));
    hub.sendToUser(userId, env);
    return makeResult(env.id, channel);
  }

  const rendered = presentationTextBlocks(presentation);
  const text = rendered.length > 0 ? rendered : fallbackText;
  const chunks = chunkReplyText(text);
  const firstId = sendMsgChunks(hub, channel, userId, chunks);
  return makeResult(firstId, channel);
}

/** Type guard: does this ReplyPayload.presentation value look like a real
 *  MessagePresentation (has a `blocks` array)? presentation is typed
 *  `unknown` on ReplyPayload per the real SDK, so callers must narrow it. */
function asMessagePresentation(presentation: unknown): MessagePresentation | null {
  if (presentation && typeof presentation === 'object' && Array.isArray((presentation as MessagePresentation).blocks)) {
    return presentation as MessagePresentation;
  }
  return null;
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
  const { hub, channel, approvalValues } = deps;

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
      // Try to extract a buttons block → approval.request.
      const buttons = findButtonsBlock(interactive);
      if (buttons !== null) {
        const options = buttons.map((b) => b.label);
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
        // Remember each button's real value (falling back to its label when
        // the SDK didn't supply one) so the inbound runner can resolve it once
        // the human's choice comes back as one of these labels. Without this,
        // a button like {label:"Approve", value:"approve:task-42"} lost its
        // value entirely — OpenClaw only ever saw "Approve" as an unrelated
        // turn, breaking any correlation to the pending action.
        approvalValues?.remember(refId, new Map(buttons.map((b) => [b.label, b.value ?? b.label])));
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

    // No (mappable) interactive: check payload.presentation too. This is the
    // REAL delivery path for the modern MessagePresentation shape (R4-1
    // correction) — renderPresentation (below) is a pure, side-effect-free
    // transform; core calls it, then routes the transformed payload back
    // through sendPayload/sendText for actual delivery, since Raccoon is a
    // 'gateway'-mode channel (all real sends go through this adapter's own
    // methods, never a core-generic path). A caller that reaches sendPayload
    // directly with only `presentation` set (no `interactive`) hits the same
    // branch, so there's exactly one delivery path regardless of how it got here.
    const presentation = asMessagePresentation(payload.presentation);
    if (presentation) {
      const fallbackText = typeof payload.text === 'string' && payload.text.length > 0 ? payload.text : ctx.text;
      return deliverPresentation(hub, channel, approvalValues, userId, presentation, fallbackText);
    }

    // No interactive/presentation — plain text path (same logic as sendText).
    const text =
      typeof payload.text === 'string' && payload.text.length > 0
        ? payload.text
        : ctx.text;
    const chunks = chunkReplyText(text);
    const firstId = sendMsgChunks(hub, channel, userId, chunks);
    return makeResult(firstId, channel);
  }

  // ------------------------------------------------------------------
  // renderPresentation — PURE TRANSFORM, no delivery (R4-1 correction).
  //
  // Confirmed signature (docs.openclaw.ai/plan/ui-channels, 2026-07-10):
  //   renderPresentation?: (params: { payload: ReplyPayload; presentation:
  //     MessagePresentation; ctx: ChannelOutboundSendContext }) => ReplyPayload | null
  // — SYNCHRONOUS, returning a transformed ReplyPayload for core to send
  // through the channel's OWN delivery hooks, not a value this function
  // delivers itself. Core's sequence: resolve capabilities → degrade
  // unsupported blocks → call renderPresentation → send the result via the
  // channel's transport. For a 'gateway'-mode channel (Raccoon), "the
  // channel's transport" IS sendPayload/sendText — there is no separate
  // core-generic delivery path.
  //
  // The original implementation called deliverPresentation() here directly,
  // performing hub.sendToUser() as a side effect and returning an
  // OutboundDeliveryResult — a materially different, incompatible contract
  // that (a) never matched what core actually expects back from this hook
  // and (b) risked a double-send if core ALSO routed the transformed payload
  // through sendPayload afterward. Since sendPayload already fully handles
  // payload.presentation (see above), the correct transform here is the
  // identity: hand the presentation straight back attached to the payload,
  // and let sendPayload perform the one real delivery.
  // ------------------------------------------------------------------
  function renderPresentation(args: {
    payload: ReplyPayload;
    presentation: MessagePresentation;
    ctx: ChannelOutboundSendContext;
  }): ReplyPayload | null {
    return { ...args.payload, presentation: args.presentation };
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
    // Declares which MessagePresentation block types Raccoon renders
    // natively (confirmed shape: docs.openclaw.ai/plugins/message-presentation).
    // `limits` is intentionally omitted: protocol.ts's approval.request payload
    // has no numeric length/count caps beyond non-empty strings, so there is
    // nothing real to report there.
    presentationCapabilities: {
      supported: true,
      buttons: true,
      selects: true,
      context: true,
      divider: true,
      charts: false,
    },
    renderPresentation,
  };
}
