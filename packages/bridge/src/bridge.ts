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
  // `${userId}:${envelopeId}` -> the in-flight/settled persistence outcome for
  // that message, so a redelivered envelope (a sequential retry OR a genuinely
  // CONCURRENT duplicate arriving while the first attempt is still pending)
  // never re-runs the agent, and — the R3-6 fix — never sends a false "success"
  // ack before the real outcome is known. A boolean "seen" Set could only
  // distinguish before/after; it could not make a concurrent duplicate WAIT for
  // an in-flight attempt's actual result, so a duplicate arriving while the
  // first append() was still pending sent a bare ack immediately, and if that
  // append then failed, the duplicate had already told the client it
  // succeeded (reproduced: blocking the original append, injecting a
  // duplicate, then rejecting the append produced an ack with zero runs).
  // Bounded FIFO — insertion-ordered Map, oldest evicted past the cap.
  private readonly persisted = new Map<string, Promise<boolean>>();
  // approval.response has no persistence step to gate the ack on (the ack
  // there just means "the server received this envelope", which is always
  // true once we're running this code) — a plain seen-Set is sufficient for
  // its dedup-only need.
  private readonly approvalSeen = new Set<string>();

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

  /** Mark a (userId, envelopeId) seen for approval.response's simple, always-
   *  succeeds dedup. Returns true if it was ALREADY seen. */
  private markApprovalSeen(key: string): boolean {
    if (this.approvalSeen.has(key)) return true;
    this.approvalSeen.add(key);
    if (this.approvalSeen.size > this.dedupCap) {
      const oldest = this.approvalSeen.values().next().value;
      if (oldest !== undefined) this.approvalSeen.delete(oldest);
    }
    return false;
  }

  /**
   * Runs `run()` (the durable-persistence step) AT MOST ONCE per key.
   * A concurrent OR later duplicate for the SAME key awaits the SAME promise
   * instead of starting its own attempt — critical for a truly concurrent
   * duplicate, which must see the REAL eventual outcome rather than assuming
   * success. A failed outcome is NOT remembered: the key is removed so a
   * later, genuinely-new retry (not a duplicate of an in-flight attempt)
   * gets a clean attempt, matching R2-3. Returns `isOriginal: true` only for
   * the call that actually invoked `run()` — callers use this to gate
   * "proceed to run the agent turn" (which must happen exactly once).
   */
  private async claim(key: string, run: () => Promise<boolean>): Promise<{ succeeded: boolean; isOriginal: boolean }> {
    const existing = this.persisted.get(key);
    if (existing) return { succeeded: await existing, isOriginal: false };

    const promise = run();
    this.persisted.set(key, promise);
    const succeeded = await promise.catch(() => false);
    if (!succeeded) {
      this.persisted.delete(key);
    } else if (this.persisted.size > this.dedupCap) {
      const oldest = this.persisted.keys().next().value;
      if (oldest !== undefined) this.persisted.delete(oldest);
    }
    return { succeeded, isOriginal: true };
  }

  private async handleMsg(env: Extract<AnyEnvelope, { kind: 'msg' }>, userId: string): Promise<void> {
    const channel = env.channel;
    const agent = agentAddress(channel);
    const to = userAddress(userId);
    const dedupKey = `${userId}:${env.id}`;

    // Single-flight: only the FIRST caller for this key actually appends; a
    // sequential retry OR a genuinely concurrent duplicate both await the
    // same outcome instead of assuming success. The ack is gated on the real
    // persistence result — a duplicate arriving while the original append()
    // is still pending must NOT ack before that append settles, since if it
    // then fails, an early ack would have already told the client the
    // message was received when it was not (reproduced: blocking the
    // original append, injecting a duplicate, then rejecting the append
    // produced an ack with zero runs under the old boolean-Set design).
    const { succeeded, isOriginal } = await this.claim(dedupKey, async () => {
      const ts = new Date().toISOString();
      await this.store.append({ id: env.id, channel, userId, role: 'user', text: env.payload.text, ts });
      return true;
    });

    if (succeeded) {
      this.hub.sendToUser(userId, createEnvelope('ack', {
        from: agent, to, channel, payload: { refId: env.id, status: 'received' },
      }));
    }
    // Only the original attempt runs the agent turn (never a duplicate, and
    // never after a failed append — a failed append means nothing durable
    // happened, so there is no acked message to act on).
    if (!isOriginal || !succeeded) return;

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
    const channel = env.channel;
    const agent = agentAddress(channel);
    const to = userAddress(userId);
    const { refId, choice, editedText } = env.payload;

    // Ack unconditionally, including on a redelivery: this envelope has no
    // durable-persistence step to gate on (unlike handleMsg's append), so
    // there is no "silently swallowed" risk in acking a duplicate. The ack
    // gives the client round-trip confirmation — without it, "Responded" was
    // shown the instant the browser accepted the send buffer, so a connection
    // drop between that and the server actually receiving it silently lost
    // the decision while the UI claimed success.
    this.hub.sendToUser(userId, createEnvelope('ack', {
      from: agent, to, channel, payload: { refId: env.id, status: 'received' },
    }));

    if (this.markApprovalSeen(`${userId}:${env.id}`)) return;

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
