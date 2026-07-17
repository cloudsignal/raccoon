// adapters/openclaw/src/approval-render.ts
//
// Raccoon exec-approval CARD rendering (raccoon issue #4).
//
// WHAT THIS DOES:
//   createRaccoonApprovalCapability() → a ChannelApprovalCapability whose
//   render.exec hooks turn OpenClaw exec-approval requests into compact
//   ReplyPayloads that the EXISTING outbound adapter (outbound.ts,
//   deliverPresentation) renders as a native Raccoon approval.request card.
//
// HOW IT FITS THE PIPELINE (verified against openclaw@2026.6.11 core):
//   1. The agent's exec tool hits `ask=always`/`ask=on-miss` → OpenClaw raises
//      an ExecApprovalRequest and (when cfg.approvals.exec.enabled) the
//      exec-approval forwarder resolves the turn's origin target — channel
//      'raccoon', to 'user:<id>' (set by inbound.ts's FinalizedMsgContext.To).
//   2. The forwarder asks the channel plugin's approvalCapability.render.exec
//      .buildPendingPayload for the payload (falling back to the generic
//      gateway text + buttons when a channel has no renderer).
//   3. The payload is delivered through the channel's normal outbound —
//      sendPayload sees the MessagePresentation and emits ONE
//      approval.request envelope (buttons → card options, command actions
//      recorded in the approval-value store).
//   4. The user taps Allow/Deny → inbound.ts resolves the choice back to its
//      `/approve <id> <decision>` command → OpenClaw resolves the approval →
//      the blocked exec continues.
//
// The presentation.title / text blocks / buttons split matters: outbound.ts's
// deliverPresentation maps title → card title, text/context blocks → card
// description, and the buttons block → the card's tappable options. The
// generic gateway fallback stuffs everything into `text`, which would become
// one wall-of-text card title — this renderer exists to keep the card shaped
// like a card.

import type {
  ExecApprovalRequest,
  ExecApprovalResolved,
} from 'openclaw/plugin-sdk/approval-runtime';
import {
  createChannelApprovalCapability,
  resolveExecApprovalRequestAllowedDecisions,
} from 'openclaw/plugin-sdk/approval-runtime';
import type { ChannelApprovalCapability } from 'openclaw/plugin-sdk/channel-runtime';
import type { ReplyPayload } from 'openclaw/plugin-sdk/reply-runtime';
import type {
  MessagePresentation,
  MessagePresentationButton,
} from 'openclaw/plugin-sdk/interactive-runtime';

// ---------------------------------------------------------------------------
// Decision → button mapping
//
// Labels and styles mirror OpenClaw's own exec-approval action descriptors
// ('Allow Once' success / 'Allow Always' primary / 'Deny' danger) so a user
// who has seen approvals on any other surface recognises the same choices.
// The action is the REAL native slash command — inbound.ts sends an
// isCommand choice back as a standalone `/`-prefixed message, which is the
// documented way OpenClaw's command parser resolves an approval.
// ---------------------------------------------------------------------------

const DECISION_META: ReadonlyArray<{
  decision: 'allow-once' | 'allow-always' | 'deny';
  label: string;
  style: 'success' | 'primary' | 'danger';
}> = [
  { decision: 'allow-once', label: 'Allow Once', style: 'success' },
  { decision: 'allow-always', label: 'Allow Always', style: 'primary' },
  { decision: 'deny', label: 'Deny', style: 'danger' },
];

function buildDecisionButtons(request: ExecApprovalRequest): MessagePresentationButton[] {
  const allowed = resolveExecApprovalRequestAllowedDecisions(request.request);
  return DECISION_META.filter((m) => allowed.includes(m.decision)).map((m) => ({
    label: m.label,
    action: { type: 'command', command: `/approve ${request.id} ${m.decision}` },
    style: m.style,
  }));
}

// ---------------------------------------------------------------------------
// Context line — the compact metadata row under the command
// ---------------------------------------------------------------------------

/** "in 12m" / "in 3h" / "now" for the card's expiry hint. */
export function formatExpiresIn(expiresAtMs: number, nowMs: number): string {
  const ms = expiresAtMs - nowMs;
  if (ms <= 0) return 'now';
  const minutes = Math.ceil(ms / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rem = minutes % 60;
  return rem > 0 ? `in ${hours}h ${rem}m` : `in ${hours}h`;
}

function buildContextLine(request: ExecApprovalRequest, nowMs: number): string {
  const r = request.request;
  const parts: string[] = [];
  if (r.agentId) parts.push(`Agent: ${r.agentId}`);
  if (r.host) parts.push(`Host: ${r.host}`);
  if (r.cwd) parts.push(`CWD: ${r.cwd}`);
  parts.push(`Expires ${formatExpiresIn(request.expiresAtMs, nowMs)}`);
  return parts.join(' · ');
}

/**
 * The command shown on the card. Full and untruncated on purpose: an approval
 * surface that hides part of the command it approves is a security bug, not a
 * layout nicety (a malicious tail could ride past any cutoff). The card body
 * scrolls; a long command is the operator's problem to read, not ours to hide.
 */
function commandDisplay(request: ExecApprovalRequest): string {
  return request.request.command;
}

// ---------------------------------------------------------------------------
// render.exec hooks
// ---------------------------------------------------------------------------

export function buildRaccoonExecPendingPayload(params: {
  request: ExecApprovalRequest;
  nowMs: number;
}): ReplyPayload {
  const { request, nowMs } = params;
  const command = commandDisplay(request);
  const warning = request.request.warningText?.trim();

  const presentation: MessagePresentation = {
    title: 'Exec approval required',
    blocks: [
      ...(warning ? [{ type: 'text', text: warning } as const] : []),
      { type: 'text', text: command },
      { type: 'context', text: buildContextLine(request, nowMs) },
      { type: 'buttons', buttons: buildDecisionButtons(request) },
    ],
  };

  // The text fallback is what a degraded (no-presentation) delivery shows;
  // it must still carry the command and a typable resolution path.
  const decisions = resolveExecApprovalRequestAllowedDecisions(request.request).join('|');
  const text = [
    'Exec approval required:',
    command,
    buildContextLine(request, nowMs),
    `Reply with: /approve ${request.id} ${decisions}`,
  ].join('\n');

  return { text, presentation };
}

const DECISION_LABEL: Record<string, string> = {
  'allow-once': 'allowed once',
  'allow-always': 'allowed always',
  deny: 'denied',
};

export function buildRaccoonExecResolvedPayload(params: {
  resolved: ExecApprovalResolved;
}): ReplyPayload {
  const { resolved } = params;
  const verdict = DECISION_LABEL[resolved.decision] ?? resolved.decision;
  const by = resolved.resolvedBy ? ` by ${resolved.resolvedBy}` : '';
  return { text: `Exec approval ${verdict}${by}.` };
}

// ---------------------------------------------------------------------------
// Capability factory
// ---------------------------------------------------------------------------

/**
 * The channel approval capability the raccoonChannelPlugin registers.
 * render-only on purpose:
 *   - no authorizeActorAction — Raccoon is a 1:1 paired-device DM channel;
 *     the pairing + allowFrom gate that admitted the sender IS the approval
 *     authorization (OpenClaw's /approve handler defaults to authorized when
 *     a channel registers no authorizeActorAction — same-chat trust model,
 *     identical to approving from the terminal that started the run).
 *   - no delivery/nativeRuntime — delivery rides the exec-approval
 *     forwarder + the channel's ordinary outbound; there is no separate
 *     native approval transport to manage.
 */
export function createRaccoonApprovalCapability(): ChannelApprovalCapability {
  return createChannelApprovalCapability({
    render: {
      exec: {
        buildPendingPayload: ({ request, nowMs }) =>
          buildRaccoonExecPendingPayload({ request, nowMs }),
        buildResolvedPayload: ({ resolved }) =>
          buildRaccoonExecResolvedPayload({ resolved }),
      },
    },
  });
}
