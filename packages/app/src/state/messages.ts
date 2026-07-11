import { parseAddress, type Envelope, type HistoryMessage } from '@raccoon/protocol';

export type Delivery = 'pending' | 'sent' | 'delivered' | 'read' | 'failed';

export interface ChatMessage {
  id: string;
  channel: string;
  role: 'user' | 'agent';
  sender: string;
  kind: 'text' | 'approval';
  text: string;
  approval?: { refId: string; title: string; description: string; options: string[] };
  ts: string;
  delivery?: Delivery;
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

export interface ChatState {
  messages: Record<string, ChatMessage[]>;
  typing: Record<string, boolean>;
  unread: Record<string, number>;
  nextBefore: Record<string, string | undefined>;
  historyLoaded: Record<string, boolean>;
}

export const emptyChatState: ChatState = {
  messages: {},
  typing: {},
  unread: {},
  nextBefore: {},
  historyLoaded: {},
};

export type ChatAction =
  | { type: 'history'; channel: string; agentId: string; messages: HistoryMessage[]; nextBefore?: string; lastRead?: string; active?: boolean }
  | { type: 'message'; env: Envelope<'msg'>; active: boolean }
  | { type: 'approval'; env: Envelope<'approval.request'>; active: boolean }
  | { type: 'optimistic'; msg: ChatMessage }
  | { type: 'delivery'; channel: string; id: string; delivery: Delivery }
  | { type: 'ack'; channel: string; refId: string; status: 'received' | 'delivered' | 'read' | 'failed' }
  | { type: 'typing'; channel: string; on: boolean }
  | { type: 'responded'; channel: string; refId: string; choice: string; responseId: string; editedText?: string }
  // #R7-2: rehydrate responded/failed state onto approval messages from
  // DURABLE outbox rows after a reload (in-memory respondedChoice/responseEnvId
  // are lost; server history carries the approval REQUEST but not the local
  // response state), so a failed response still shows its retry card.
  | { type: 'reconcile-responses'; channel: string; responses: Array<{ refId: string; choice: string; responseId: string; editedText?: string; delivery: Delivery }> }
  | { type: 'read-channel'; channel: string }
  | { type: 'reset' };

// 'failed' (#R6-2): the server received the envelope but the turn it drives
// failed terminally server-side — surfaces the retry affordance.
const ACK_DELIVERY: Record<'received' | 'delivered' | 'read' | 'failed', Delivery> = {
  received: 'sent',
  delivered: 'delivered',
  read: 'read',
  failed: 'failed',
};

function byTs(a: ChatMessage, b: ChatMessage): number {
  return a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0;
}

function upsert(list: ChatMessage[], msg: ChatMessage): ChatMessage[] {
  if (list.some((m) => m.id === msg.id)) return list;
  return [...list, msg].sort(byTs);
}

function patch(state: ChatState, channel: string, list: ChatMessage[]): ChatState {
  return { ...state, messages: { ...state.messages, [channel]: list } };
}

export function chatReducer(state: ChatState, action: ChatAction): ChatState {
  switch (action.type) {
    case 'reset':
      return emptyChatState;
    case 'history': {
      const existing = state.messages[action.channel] ?? [];
      const seen = new Set(existing.map((m) => m.id));
      const incoming: ChatMessage[] = [];
      for (const h of action.messages) {
        if (seen.has(h.id)) continue;
        seen.add(h.id);
        incoming.push({
          id: h.id,
          channel: action.channel,
          role: h.role,
          sender: h.role === 'agent' ? action.agentId : 'you',
          kind: 'text' as const,
          text: h.text,
          ts: h.ts,
          ...(h.role === 'user' ? { delivery: 'sent' as const } : {}),
        });
      }
      const merged = [...existing, ...incoming].sort(byTs);
      const firstLoad = !state.historyLoaded[action.channel];
      let unread: number;
      if (firstLoad) {
        unread = action.lastRead
          ? merged.filter((m) => m.role === 'agent' && m.ts > action.lastRead!).length
          : state.unread[action.channel] ?? 0;
      } else if (action.active) {
        // The user is viewing this channel; catch-up messages are seen, not unread.
        unread = state.unread[action.channel] ?? 0;
      } else {
        // Background catch-up (#10): count newly-arrived agent messages missed while
        // disconnected toward the unread badge.
        const missed = incoming.filter(
          (m) => m.role === 'agent' && (!action.lastRead || m.ts > action.lastRead!),
        ).length;
        unread = (state.unread[action.channel] ?? 0) + missed;
      }
      return {
        ...patch(state, action.channel, merged),
        unread: { ...state.unread, [action.channel]: unread },
        nextBefore: { ...state.nextBefore, [action.channel]: action.nextBefore },
        historyLoaded: { ...state.historyLoaded, [action.channel]: true },
      };
    }
    case 'message': {
      const from = parseAddress(action.env.from);
      const isAgent = from.type === 'agent';
      const channel = action.env.channel;
      const msg: ChatMessage = {
        id: action.env.id,
        channel,
        role: isAgent ? 'agent' : 'user',
        sender: isAgent ? (from.id ?? channel) : 'you',
        kind: 'text',
        text: action.env.payload.text,
        ts: action.env.ts,
        ...(isAgent ? {} : { delivery: 'sent' as const }),
      };
      const list = upsert(state.messages[channel] ?? [], msg);
      if (list === state.messages[channel]) return state;
      const bump = isAgent && !action.active;
      return {
        ...patch(state, channel, list),
        typing: isAgent ? { ...state.typing, [channel]: false } : state.typing,
        unread: bump ? { ...state.unread, [channel]: (state.unread[channel] ?? 0) + 1 } : state.unread,
      };
    }
    case 'approval': {
      const from = parseAddress(action.env.from);
      const channel = action.env.channel;
      const msg: ChatMessage = {
        id: action.env.id,
        channel,
        role: 'agent',
        sender: from.id ?? channel,
        kind: 'approval',
        text: action.env.payload.description,
        approval: { ...action.env.payload },
        ts: action.env.ts,
      };
      const list = upsert(state.messages[channel] ?? [], msg);
      if (list === state.messages[channel]) return state;
      const bump = !action.active;
      return {
        ...patch(state, channel, list),
        typing: { ...state.typing, [channel]: false },
        unread: bump ? { ...state.unread, [channel]: (state.unread[channel] ?? 0) + 1 } : state.unread,
      };
    }
    case 'optimistic':
      return patch(state, action.msg.channel, upsert(state.messages[action.msg.channel] ?? [], action.msg));
    case 'delivery': {
      const list = (state.messages[action.channel] ?? []).map((m) => {
        if (m.id === action.id) return { ...m, delivery: action.delivery };
        if (m.responseEnvId === action.id) return { ...m, respondedDelivery: action.delivery };
        return m;
      });
      return patch(state, action.channel, list);
    }
    case 'ack': {
      const list = (state.messages[action.channel] ?? []).map((m) => {
        if (m.id === action.refId) return { ...m, delivery: ACK_DELIVERY[action.status] };
        if (m.responseEnvId === action.refId) return { ...m, respondedDelivery: ACK_DELIVERY[action.status] };
        return m;
      });
      return patch(state, action.channel, list);
    }
    case 'typing':
      return { ...state, typing: { ...state.typing, [action.channel]: action.on } };
    case 'responded': {
      const list = (state.messages[action.channel] ?? []).map((m) =>
        m.kind === 'approval' && m.approval?.refId === action.refId
          ? { ...m, respondedChoice: action.choice, respondedDelivery: 'pending' as const, responseEnvId: action.responseId, respondedEditedText: action.editedText }
          : m,
      );
      return patch(state, action.channel, list);
    }
    case 'reconcile-responses': {
      if (action.responses.length === 0) return state;
      const byRef = new Map(action.responses.map((r) => [r.refId, r]));
      const list = (state.messages[action.channel] ?? []).map((m) => {
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
      return patch(state, action.channel, list);
    }
    case 'read-channel':
      return { ...state, unread: { ...state.unread, [action.channel]: 0 } };
  }
}
