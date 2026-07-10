import { agentAddress, createEnvelope, userAddress, type AnyEnvelope } from '@raccoon/protocol';
import type { AgentContext, AgentRunner, MessageStore, OutboundHub } from './types.js';

const DEFAULT_HISTORY_CAP = 200;
const DEFAULT_DEDUP_CAP = 500;
const GENERIC_ERROR = 'Something went wrong handling that.';

export class RaccoonBridge {
  private readonly hub: OutboundHub;
  private readonly runner: AgentRunner;
  private readonly store: MessageStore;
  private readonly cap: number;
  private readonly dedupCap: number;
  // `${userId}:${envelopeId}` of turns already processed, so a redelivered
  // envelope (e.g. the client retried after a lost ack) does not re-run the
  // agent. Bounded FIFO — insertion-ordered Set, oldest evicted past the cap.
  private readonly processed = new Set<string>();

  constructor(opts: { hub: OutboundHub; runner: AgentRunner; store: MessageStore; historyLimitCap?: number; dedupCap?: number }) {
    this.hub = opts.hub;
    this.runner = opts.runner;
    this.store = opts.store;
    this.cap = opts.historyLimitCap ?? DEFAULT_HISTORY_CAP;
    this.dedupCap = opts.dedupCap ?? DEFAULT_DEDUP_CAP;
  }

  /** Subscribe to the hub. Returns an unsubscribe function. */
  start(): () => void {
    return this.hub.onEnvelope((env, userId) => {
      // Contain every turn: a rejected handler must never escape as an unhandled
      // promise rejection, which would crash the host process.
      this.handle(env, userId).catch((err) => {
        console.error('[raccoon-bridge] handler error:', err);
      });
    });
  }

  private async handle(env: AnyEnvelope, userId: string): Promise<void> {
    if (env.kind === 'msg') return this.handleMsg(env, userId);
    if (env.kind === 'approval.response') return this.handleApprovalResponse(env, userId);
    if (env.kind === 'history.request') return this.handleHistory(env, userId);
    // ack / typing / presence / pairing kinds are inbound-irrelevant to the agent.
  }

  /** Mark a (userId, envelopeId) processed. Returns true if it was ALREADY seen. */
  private markSeen(key: string): boolean {
    if (this.processed.has(key)) return true;
    this.processed.add(key);
    if (this.processed.size > this.dedupCap) {
      const oldest = this.processed.values().next().value;
      if (oldest !== undefined) this.processed.delete(oldest);
    }
    return false;
  }

  /** Revert a markSeen() call. Used when the durable step that "seen" is meant
   *  to guarantee (persisting the inbound message) fails, so a subsequent
   *  retry gets a clean attempt instead of being silently swallowed as an
   *  already-processed duplicate. */
  private unmarkSeen(key: string): void {
    this.processed.delete(key);
  }

  private async handleMsg(env: Extract<AnyEnvelope, { kind: 'msg' }>, userId: string): Promise<void> {
    const channel = env.channel;
    const agent = agentAddress(channel);
    const to = userAddress(userId);

    // Idempotency: a redelivered message must re-ack (so the client settles its
    // outbox) but must NOT re-run the agent turn (double LLM/tool execution).
    // markSeen() is called EAGERLY (before the append below) so a genuinely
    // concurrent duplicate delivery is caught immediately rather than racing
    // into a double append. If the append then fails, unmarkSeen() rolls this
    // back: without that, marking-then-persisting meant a transient store
    // failure silently discarded the message forever — a later retry would
    // find it already "seen" and get nothing but a bare ack, with no append
    // and no agent run.
    const dedupKey = `${userId}:${env.id}`;
    if (this.markSeen(dedupKey)) {
      this.hub.sendToUser(userId, createEnvelope('ack', {
        from: agent, to, channel, payload: { refId: env.id, status: 'received' },
      }));
      return;
    }

    const ts = new Date().toISOString();
    try {
      await this.store.append({ id: env.id, channel, userId, role: 'user', text: env.payload.text, ts });
    } catch (err) {
      this.unmarkSeen(dedupKey);
      throw err;
    }

    this.hub.sendToUser(userId, createEnvelope('ack', {
      from: agent, to, channel, payload: { refId: env.id, status: 'received' },
    }));
    this.hub.sendToUser(userId, createEnvelope('typing', {
      from: agent, to, channel, payload: { state: 'start' },
    }));

    const { reply, failed } = await this.runTurn({ userId, channel, text: env.payload.text, messageId: env.id });

    this.hub.sendToUser(userId, createEnvelope('typing', {
      from: agent, to, channel, payload: { state: 'stop' },
    }));

    if (failed) {
      this.hub.sendToUser(userId, createEnvelope('msg', { from: agent, to, channel, payload: { text: GENERIC_ERROR } }));
      return;
    }
    await this.emitReply(userId, channel, reply);
  }

  /** Route a user's approval decision to the agent as a turn. Previously dropped,
   *  which left the requesting agent waiting forever while the UI showed
   *  "Responded". Approval responses are fire-and-forget from the client (no ack),
   *  so we only dedup and run the turn. */
  private async handleApprovalResponse(env: Extract<AnyEnvelope, { kind: 'approval.response' }>, userId: string): Promise<void> {
    if (this.markSeen(`${userId}:${env.id}`)) return;
    const channel = env.channel;
    const agent = agentAddress(channel);
    const to = userAddress(userId);
    const { refId, choice, editedText } = env.payload;

    this.hub.sendToUser(userId, createEnvelope('typing', {
      from: agent, to, channel, payload: { state: 'start' },
    }));

    const { reply, failed } = await this.runTurn({
      userId, channel, text: editedText ?? choice, messageId: env.id,
      approval: { refId, choice, ...(editedText !== undefined ? { editedText } : {}) },
    });

    this.hub.sendToUser(userId, createEnvelope('typing', {
      from: agent, to, channel, payload: { state: 'stop' },
    }));

    if (failed) {
      this.hub.sendToUser(userId, createEnvelope('msg', { from: agent, to, channel, payload: { text: GENERIC_ERROR } }));
      return;
    }
    await this.emitReply(userId, channel, reply);
  }

  /** Drain one agent turn to a string, never throwing. */
  private async runTurn(ctx: AgentContext): Promise<{ reply: string; failed: boolean }> {
    let reply = '';
    try {
      for await (const chunk of this.runner.run(ctx)) reply += chunk;
      return { reply, failed: false };
    } catch {
      return { reply: '', failed: true };
    }
  }

  /** Persist + send the agent reply. Skips an empty reply: an empty agent turn (or
   *  an allowlist denial that yields nothing) must not build a protocol-invalid
   *  empty `msg` envelope — createEnvelope would throw, and with the old unawaited
   *  handler that surfaced as an unhandled rejection and crashed the process. */
  private async emitReply(userId: string, channel: string, reply: string): Promise<void> {
    if (reply.length === 0) return;
    const replyEnv = createEnvelope('msg', {
      from: agentAddress(channel), to: userAddress(userId), channel, payload: { text: reply },
    });
    await this.store.append({ id: replyEnv.id, channel, userId, role: 'agent', text: reply, ts: replyEnv.ts });
    this.hub.sendToUser(userId, replyEnv);
  }

  private async handleHistory(env: Extract<AnyEnvelope, { kind: 'history.request' }>, userId: string): Promise<void> {
    const limit = Math.min(env.payload.limit, this.cap);
    const page = await this.store.page(env.payload.channel, { userId, before: env.payload.before, limit });
    this.hub.sendToUser(userId, createEnvelope('history.page', {
      from: agentAddress(env.payload.channel),
      to: userAddress(userId),
      channel: env.payload.channel,
      payload: { channel: env.payload.channel, messages: page.messages, ...(page.nextBefore ? { nextBefore: page.nextBefore } : {}) },
    }));
  }
}
