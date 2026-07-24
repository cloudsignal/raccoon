import type { AnyEnvelope, Attachment, HistoryMessage } from '@raccoon/protocol';

/** The subset of a transport hub the bridge needs. Plan A's WsHub
 *  structurally satisfies this; MQTT and other transport hubs will too. */
export interface OutboundHub {
  sendToUser(userId: string, env: AnyEnvelope): boolean;
  onEnvelope(handler: (env: AnyEnvelope, userId: string) => void): () => void;
}

/** The subset of a media store the bridge needs: the PERMANENT-reference
 *  transition for hub-issued attachment paths (see handleMsg — the bridge is
 *  the standalone reference point). transport-ws's MediaStore structurally
 *  satisfies this (hosts wire `media: hub.media`); the bridge itself stays
 *  transport-agnostic. */
export interface MediaReferencer {
  reference(paths: string[]): Promise<{ known: Attachment[]; unknown: string[] }>;
}

export interface AgentContext {
  userId: string;
  channel: string;
  text: string;
  messageId: string;
  /** Hub-issued media the user attached (validated media paths). Runners
   *  that do not model media can ignore this. */
  attachments?: Attachment[];
  /** Present when this turn is the user's response to an approval.request.
   *  `text` carries the edited text (if any) or the chosen option; `approval`
   *  gives the runner the original request id and the raw choice. Runners that
   *  do not model approvals can ignore it and treat the turn as plain text. */
  approval?: { refId: string; choice: string; editedText?: string };
}

/** The framework seam. An implementation runs one user turn and yields
 *  the agent's reply as text deltas. The bridge shows a typing indicator
 *  while iterating and sends one msg envelope with the concatenated text
 *  when iteration completes. (Streaming partial msgs to the client is a
 *  later concern.) */
export interface AgentRunner {
  run(ctx: AgentContext): AsyncIterable<string>;
}

export interface StoredMessage {
  id: string;
  channel: string;
  userId: string;
  role: 'user' | 'agent';
  text: string;
  ts: string;
  /** Hub-issued attachments as CLAIMED by the client at append time. The row
   *  is written BEFORE the permanent-reference call (append-then-reference —
   *  see handleMsg), and v1 deliberately has no row-update machinery: the
   *  store-canonical values feed the RUNNER only; history canonicalization is
   *  a non-goal. */
  attachments?: Attachment[];
}

export interface MessageStore {
  append(m: StoredMessage): Promise<void>;
  page(
    channel: string,
    opts: { userId: string; before?: string; limit: number },
  ): Promise<{ messages: HistoryMessage[]; nextBefore?: string }>;
}
