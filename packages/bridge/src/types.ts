import type { AnyEnvelope, HistoryMessage } from '@raccoon/protocol';

/** The subset of a transport hub the bridge needs. Plan A's WsHub
 *  structurally satisfies this; MQTT and other transport hubs will too. */
export interface OutboundHub {
  sendToUser(userId: string, env: AnyEnvelope): boolean;
  onEnvelope(handler: (env: AnyEnvelope, userId: string) => void): () => void;
}

export interface AgentContext {
  userId: string;
  channel: string;
  text: string;
  messageId: string;
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
}

export interface MessageStore {
  append(m: StoredMessage): Promise<void>;
  page(
    channel: string,
    opts: { userId: string; before?: string; limit: number },
  ): Promise<{ messages: HistoryMessage[]; nextBefore?: string }>;
}
