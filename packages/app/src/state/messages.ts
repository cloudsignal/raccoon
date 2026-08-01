import { parseAddress, type Attachment, type Envelope, type HistoryMessage } from '@raccoon/protocol';
import type { ConvKey } from '../lib/conv-key.js';

// 'stalled' (#P1-A): the server started the turn but it exceeded the deadline
// and is still running with an UNKNOWN outcome. Terminal for the send state
// but NOT retryable — the UI shows "still working", never a "tap to retry".
export type Delivery = 'pending' | 'sent' | 'delivered' | 'read' | 'failed' | 'stalled';

export interface ChatMessage {
  id: string;
  /** The conversation key this message renders under; a bare channel
   *  pre-multi-pairing, `pairingId/channel` after. */
  channel: ConvKey;
  role: 'user' | 'agent';
  sender: string;
  kind: 'text' | 'approval';
  text: string;
  /** Hub-issued media this message carries (relative /media/... paths). */
  attachments?: Attachment[];
  approval?: { refId: string; title: string; description: string; options: string[] };
  ts: string;
  delivery?: Delivery;
  /** Why a terminal 'failed' delivery is NOT retryable. Currently only
   *  'attachments-expired': the media lease lapsed and the sweep reclaimed
   *  the bytes, so a resend would deliver dead URLs — the bubble surfaces a
   *  specific notice and suppresses the tap-to-retry affordance. */
  failureReason?: string;
  respondedChoice?: string;
  /** Delivery status of the approval.response envelope for respondedChoice
   *  (R2-5): 'pending' until acked, 'delivered' once acked, 'failed' on ack
   *  timeout (matching the same ack/timeout reliability as a plain msg). */
  respondedDelivery?: Delivery;
  /** Id of the approval.response envelope that carried respondedChoice — the
   *  ack/delivery-timeout events that confirm/fail it reference THIS id, not
   *  the approval-request message's own id. */
  responseEnvId?: string;
  /** The editedText that accompanied respondedChoice, if any (#R6-2) — kept
   *  so a failed response's retry can re-send the SAME decision as a fresh
   *  envelope (the settled outbox row can no longer be revived). */
  respondedEditedText?: string;
}

/** Keyed by ConvKey (`pairingId/channel`) — see lib/conv-key.ts. The reducer
 *  treats keys as opaque; collision safety between pairings comes from the
 *  key domain. */
export interface ChatState {
  messages: Record<ConvKey, ChatMessage[]>;
  typing: Record<ConvKey, boolean>;
  unread: Record<ConvKey, number>;
  nextBefore: Record<ConvKey, string | undefined>;
  historyLoaded: Record<ConvKey, boolean>;
}

export const emptyChatState: ChatState = {
  messages: {},
  typing: {},
  unread: {},
  nextBefore: {},
  historyLoaded: {},
};

export type ChatAction =
  // `agentId` stays the bare channel — it feeds the sender label, not the key.
  | { type: 'history'; convKey: ConvKey; agentId: string; messages: HistoryMessage[]; nextBefore?: string; lastRead?: string; active?: boolean }
  // `convKey` — not env.channel — is the state key for env-carrying actions:
  // two pairings can expose the same channel name, so the envelope alone
  // cannot address a conversation. env.channel remains the sender-label fallback.
  | { type: 'message'; env: Envelope<'msg'>; convKey: ConvKey; active: boolean }
  | { type: 'approval'; env: Envelope<'approval.request'>; convKey: ConvKey; active: boolean }
  | { type: 'optimistic'; msg: ChatMessage }
  | { type: 'delivery'; convKey: ConvKey; id: string; delivery: Delivery }
  // `reason` rides along with a locally-decided terminal 'failed' (e.g. the
  // drain-time attachment-lease check) — applied only if the delivery
  // actually lands on 'failed' (the monotonic gate still wins).
  | { type: 'ack'; convKey: ConvKey; refId: string; status: 'received' | 'delivered' | 'read' | 'failed' | 'stalled'; reason?: string }
  | { type: 'typing'; convKey: ConvKey; on: boolean }
  | { type: 'responded'; convKey: ConvKey; refId: string; choice: string; responseId: string; editedText?: string }
  // #R7-2: rehydrate responded/failed state onto approval messages from
  // DURABLE outbox rows after a reload (in-memory respondedChoice/responseEnvId
  // are lost; server history carries the approval REQUEST but not the local
  // response state), so a failed response still shows its retry card.
  | { type: 'reconcile-responses'; convKey: ConvKey; responses: Array<{ refId: string; choice: string; responseId: string; editedText?: string; delivery: Delivery }> }
  // #R8-1: re-render approval CARDS from the durable, identity-scoped
  // approvals store after a reload. Server history reconstructs an
  // approval.request only as a text row, so without this the interactive
  // card (and its retry affordance) is lost. REPLACES a same-id history text
  // row with the card; never clobbers an already-live approval card (which
  // may carry in-memory response state on a reconnect).
  | { type: 'reconcile-approvals'; convKey: ConvKey; approvals: Envelope<'approval.request'>[] }
  | { type: 'read-channel'; convKey: ConvKey }
  // Per-pairing wipe (unpair / auth error / cross-tab wipe): drops every record
  // entry whose ConvKey belongs to `pairingId`. A global 'reset' would wipe the
  // OTHER pairings' live conversations too — this removes exactly one pairing's
  // slice of the state.
  | { type: 'drop-pairing'; pairingId: string }
  | { type: 'reset' };

// 'failed' (#R6-2): the server received the envelope but the turn it drives
// failed terminally server-side — surfaces the retry affordance.
const ACK_DELIVERY: Record<'received' | 'delivered' | 'read' | 'failed' | 'stalled', Delivery> = {
  received: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
  stalled: 'stalled',
};

// #R8-2: server acks must move delivery MONOTONICALLY forward. Acks can be
// reordered or redelivered by the transport, so a delayed 'received' (→sent)
// must not overwrite a terminal 'failed' (which would hide the retry
// affordance) nor downgrade a 'delivered'/'read'. 'failed' is terminal-but-
// recoverable: a genuine 'delivered'/'read' (higher rank) still overrides it,
// but a stale 'sent' (lower rank) does not; and a late 'failed' cannot regress
// a real 'delivered'. A user RETRY is the one intended backward move — it goes
// through the separate 'delivery' action (reset to 'pending'), which is NOT
// gated here, so the next 'received' legitimately advances pending→sent again.
// 'stalled' (#P1-A) sits at the same tier as 'failed' — both are terminal
// non-success states a stale 'sent' must not override and a genuine
// 'delivered' still recovers from. Neither regresses the other (strict-> gate).
const DELIVERY_RANK: Record<Delivery, number> = {
  pending: 0, sent: 1, failed: 2, stalled: 2, delivered: 3, read: 4,
};
function advanceDelivery(current: Delivery | undefined, next: Delivery): Delivery {
  if (current === undefined) return next;
  return DELIVERY_RANK[next] > DELIVERY_RANK[current] ? next : current;
}

function byTs(a: ChatMessage, b: ChatMessage): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
}

function upsert(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  if (list.some((m) => m.id === msg.id)) return list;
  return [...list, msg].sort(byTs);
}

function patch(state: ChatState, key: ConvKey, list: ChatMessage[]): ChatState {
  return { ...state, messages: { ...state.messages, [key]: list } };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return emptyChatState;
    case 'history': {
      const key = action.convKey;
      const existing = state.messages[key] ?? [];
      const seen = new Set(existing.map((m) => m.id));
      const incoming: ChatMessage[] = [];
      for (const h of action.messages) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        incoming.push({
          id: h.id,
          channel: key,
          role: h.role,
          sender: h.role === 'agent' ? action.agentId : 'you',
          kind: 'text' as const,
          text: h.text,
          ...(h.attachments?.length ? { attachments: h.attachments } : {}),
          ts: h.ts,
          ...(h.role === 'user' ? { delivery: 'sent' as const } : {}),
        });
      }
      const merged = [...existing, ...incoming].sort(byTs);
      const firstLoad = !state.historyLoaded[key];
      let unread: number;
      if (firstLoad) {
        unread = action.lastRead
          ? merged.filter((m) => m.role === 'agent' && m.ts > action.lastRead!).length
          : state.unread[key] ?? 0;
      } else if (action.active) {
        // The user is viewing this channel; catch-up messages are seen, not unread.
        unread = state.unread[key] ?? 0;
      } else {
        // Background catch-up (#10): count newly-arrived agent messages missed while
        // disconnected toward the unread badge.
        const missed = incoming.filter(
          (m) => m.role === 'agent' && (!action.lastRead || m.ts > action.lastRead!),
        ).length;
        unread = (state.unread[key] ?? 0) + missed;
      }
      return {
        ...patch(state, key, merged),
        unread: { ...state.unread, [key]: unread },
        nextBefore: { ...state.nextBefore, [key]: action.nextBefore },
        historyLoaded: { ...state.historyLoaded, [key]: true },
      };
    }
    case 'message': {
      const from = parseAddress(action.env.from);
      const isAgent = from.type === 'agent';
      const key = action.convKey;
      const msg: ChatMessage = {
        id: action.env.id,
        channel: key,
        role: isAgent ? 'agent' : 'user',
        // Sender label stays env-derived — the bare channel, not the ConvKey.
        sender: isAgent ? (from.id ?? action.env.channel) : 'you',
        kind: 'text',
        text: action.env.payload.text,
        ...(action.env.payload.attachments?.length ? { attachments: action.env.payload.attachments } : {}),
        ts: action.env.ts,
        ...(isAgent ? {} : { delivery: 'sent' as const }),
      };
      const list = upsert(state.messages[key] ?? [], msg);
      if (list === state.messages[key]) {
        // Dedupe no-op (same id redelivered) — the reply DID arrive, so a
        // live typing indicator must still clear; nothing else changes (in
        // particular the unread badge must not double-count).
        if (isAgent && state.typing[key]) {
          return { ...state, typing: { ...state.typing, [key]: false } };
        }
        return state;
      }
      const bump = isAgent && !action.active;
      return {
        ...patch(state, key, list),
        typing: isAgent ? { ...state.typing, [key]: false } : state.typing,
        unread: bump ? { ...state.unread, [key]: (state.unread[key] ?? 0) + 1 } : state.unread,
      };
    }
    case 'approval': {
      const from = parseAddress(action.env.from);
      const key = action.convKey;
      const msg: ChatMessage = {
        id: action.env.id,
        channel: key,
        role: 'agent',
        // Sender label stays env-derived — the bare channel, not the ConvKey.
        sender: from.id ?? action.env.channel,
        kind: 'approval',
        text: action.env.payload.description,
        approval: { ...action.env.payload },
        ts: action.env.ts,
      };
      const list = upsert(state.messages[key] ?? [], msg);
      if (list === state.messages[key]) {
        // Same dedupe-no-op rescue as 'message' above.
        if (state.typing[key]) {
          return { ...state, typing: { ...state.typing, [key]: false } };
        }
        return state;
      }
      const bump = !action.active;
      return {
        ...patch(state, key, list),
        typing: { ...state.typing, [key]: false },
        unread: bump ? { ...state.unread, [key]: (state.unread[key] ?? 0) + 1 } : state.unread,
      };
    }
    case 'optimistic':
      return patch(state, action.msg.channel, upsert(state.messages[action.msg.channel] ?? [], action.msg));
    case 'delivery': {
      const list = (state.messages[action.convKey] ?? []).map((m) => {
        // An explicit delivery override (the retry reset) supersedes any
        // recorded failure reason.
        if (m.id === action.id) return { ...m, delivery: action.delivery, failureReason: undefined };
        if (m.responseEnvId === action.id) return { ...m, respondedDelivery: action.delivery };
        return m;
      });
      return patch(state, action.convKey, list);
    }
    case 'ack': {
      const next = ACK_DELIVERY[action.status];
      const list = (state.messages[action.convKey] ?? []).map((m) => {
        if (m.id === action.refId) {
          const delivery = advanceDelivery(m.delivery, next);
          // Carry the failure reason only when the row actually lands on
          // 'failed' — a higher-rank 'delivered' must not pick up a stale one.
          return { ...m, delivery, ...(delivery === 'failed' && action.reason !== undefined ? { failureReason: action.reason } : {}) };
        }
        if (m.responseEnvId === action.refId) return { ...m, respondedDelivery: advanceDelivery(m.respondedDelivery, next) };
        return m;
      });
      return patch(state, action.convKey, list);
    }
    case 'typing': {
      if ((state.typing[action.convKey] ?? false) === action.on) return state;
      return { ...state, typing: { ...state.typing, [action.convKey]: action.on } };
    }
    case 'responded': {
      const list = (state.messages[action.convKey] ?? []).map((m) =>
        m.kind === 'approval' && m.approval?.refId === action.refId
          ? { ...m, respondedChoice: action.choice, respondedDelivery: 'pending' as const, responseEnvId: action.responseId, respondedEditedText: action.editedText }
          : m,
      );
      return patch(state, action.convKey, list);
    }
    case 'reconcile-approvals': {
      if (action.approvals.length === 0) return state;
      const existing = state.messages[action.convKey] ?? [];
      const byId = new Map(existing.map((m) => [m.id, m]));
      let changed = false;
      for (const env of action.approvals) {
        const prior = byId.get(env.id);
        // Leave a live approval card untouched — it may carry in-memory
        // response state a reconnect must not wipe.
        if (prior && prior.kind === 'approval') continue;
        const from = parseAddress(env.from);
        byId.set(env.id, {
          id: env.id,
          channel: action.convKey,
          role: 'agent',
          // Sender label stays env-derived — the bare channel, not the ConvKey.
          sender: from.id ?? env.channel,
          kind: 'approval',
          text: env.payload.description,
          approval: { ...env.payload },
          ts: env.ts,
        });
        changed = true;
      }
      if (!changed) return state;
      return patch(state, action.convKey, [...byId.values()].sort(byTs));
    }
    case 'reconcile-responses': {
      if (action.responses.length === 0) return state;
      const byRef = new Map(action.responses.map((r) => [r.refId, r]));
      const list = (state.messages[action.convKey] ?? []).map((m) => {
        if (m.kind !== 'approval' || !m.approval) return m;
        const r = byRef.get(m.approval.refId);
        // Only fill in a response the message doesn't already have (don't
        // clobber live in-session state with a durable snapshot).
        if (!r || m.respondedChoice !== undefined) return m;
        return {
          ...m,
          respondedChoice: r.choice,
          respondedDelivery: r.delivery,
          responseEnvId: r.responseId,
          respondedEditedText: r.editedText,
        };
      });
      return patch(state, action.convKey, list);
    }
    case 'read-channel':
      return { ...state, unread: { ...state.unread, [action.convKey]: 0 } };
    case 'drop-pairing': {
      const prefix = `${action.pairingId}/`;
      const strip = <T,>(rec: Record<ConvKey, T>): Record<ConvKey, T> => {
        const next: Record<ConvKey, T> = {};
        for (const k of Object.keys(rec)) {
          if (!k.startsWith(prefix)) next[k] = rec[k]!;
        }
        return next;
      };
      return {
        messages: strip(state.messages),
        typing: strip(state.typing),
        unread: strip(state.unread),
        nextBefore: strip(state.nextBefore),
        historyLoaded: strip(state.historyLoaded),
      };
    }
  }
}
