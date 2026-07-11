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
  //
  // R4-7: `turnDone` tracks whether the AGENT TURN for this key (not just its
  // append) has finished. Eviction (see evictCompleted()) only ever removes
  // entries with turnDone === true — never one whose turn is still running.
  // The append promise resolving (isOriginal's `succeeded`) is NOT the same
  // event: claim() used to become eviction-eligible the instant append
  // succeeded, while the (potentially slow, LLM-backed) agent turn was still
  // in progress. If enough OTHER keys arrived in the meantime and pushed the
  // map over dedupCap, THIS key — mid-turn — could be evicted; a redelivery
  // of the same envelope then found no record of it and re-ran the turn from
  // scratch, alongside the original still finishing (reproduced at cap 1:
  // two appends and runs, ["B","A","A"] — B's insertion evicted A while A's
  // own turn was still active).
  // Bounded FIFO — insertion-ordered Map, oldest COMPLETED entry evicted past
  // the cap.
  private readonly persisted = new Map<string, { promise: Promise<boolean>; turnDone: boolean }>();
  // approval.response dedup + OUTCOME tracking (#R6-2b). Value is the turn's
  // state for that (userId, envelopeId):
  //   'running' — the turn is in flight; a duplicate re-acks 'received'.
  //   'ok'      — the turn succeeded; a duplicate re-acks the terminal
  //               'delivered' so a client that lost the first terminal ack
  //               (socket drop / reload) can still settle instead of being
  //               stuck in the durable 'processing' state.
  // A FAILED turn deletes the key entirely (so a retry re-runs — see the
  // failure path in handleApprovalResponse). Only 'ok' entries are eviction-
  // eligible; a 'running' entry is never evicted mid-turn (same #R4-7 rule
  // as `persisted`).
  private readonly approvalSeen = new Map<string, 'running' | 'ok'>();

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

  /** Evict the oldest entries whose turn has completed, until back at or
   *  under cap — or until no completed entries remain, in which case the
   *  map is left temporarily over cap rather than evicting an entry whose
   *  turn is still running (#R4-7). Safe to delete already-visited/current
   *  keys mid-iteration (well-defined for Map's forward iterator). */
  private evictCompleted<V>(map: Map<string, V>, cap: number, isDone: (v: V) => boolean): void {
    if (map.size <= cap) return;
    for (const [key, value] of map) {
      if (map.size <= cap) break;
      if (isDone(value)) map.delete(key);
    }
  }

  private approvalAck(userId: string, channel: string, envId: string, status: 'received' | 'delivered' | 'failed'): void {
    this.hub.sendToUser(userId, createEnvelope('ack', {
      from: agentAddress(channel), to: userAddress(userId), channel, payload: { refId: envId, status },
    }));
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
   * "proceed to run the agent turn" (which must happen exactly once), and
   * `markTurnDone()`, which the ORIGINAL caller MUST call once that turn
   * finishes (success or failure) so evictCompleted() knows this entry is
   * finally safe to evict (#R4-7) — never before then, no matter how many
   * other keys arrive and push the map over cap in the meantime.
   */
  private async claim(
    key: string,
    run: () => Promise<boolean>,
  ): Promise<{ succeeded: boolean; isOriginal: boolean; markTurnDone: () => void }> {
    const existing = this.persisted.get(key);
    if (existing) return { succeeded: await existing.promise, isOriginal: false, markTurnDone: () => {} };

    const promise = run();
    const entry = { promise, turnDone: false };
    this.persisted.set(key, entry);
    const succeeded = await promise.catch(() => false);
    if (!succeeded) {
      this.persisted.delete(key);
    } else {
      this.evictCompleted(this.persisted, this.dedupCap, (v) => v.turnDone);
    }
    return { succeeded, isOriginal: true, markTurnDone: () => { entry.turnDone = true; } };
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
    const { succeeded, isOriginal, markTurnDone } = await this.claim(dedupKey, async () => {
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

    // R4-7: markTurnDone() only after the turn (success OR failure) fully
    // resolves — a `finally` so a throw from runTurn/emitReply still marks
    // it, rather than leaving the entry permanently ineligible for eviction.
    try {
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
    } finally {
      markTurnDone();
    }
  }

  /** Route a user's approval decision to the agent as a turn.
   *
   *  Ack lifecycle (#R6-2 / #R6-2b): the client keeps its outbox row in a
   *  durable 'processing' state on 'received' and only settles it on a
   *  TERMINAL ack — 'delivered' (success) or 'failed'. So this must emit a
   *  terminal ack for every outcome, and re-emit the right one on a
   *  duplicate: a client that lost the first terminal ack (socket drop,
   *  reload) re-drives the same envelope, and dedup must tell it the real
   *  outcome instead of stranding it. 'received' before a duplicate that has
   *  already SUCCEEDED would leave the client stuck in 'processing' forever. */
  private async handleApprovalResponse(env: Extract<AnyEnvelope, { kind: 'approval.response' }>, userId: string): Promise<void> {
    const channel = env.channel;
    const agent = agentAddress(channel);
    const to = userAddress(userId);
    const { refId, choice, editedText } = env.payload;
    const key = `${userId}:${env.id}`;

    const prior = this.approvalSeen.get(key);
    if (prior !== undefined) {
      // Duplicate: never re-run. Re-emit the outcome-appropriate ack so a
      // client that lost the original can converge — 'delivered' if the turn
      // already succeeded, 'received' while it is still running.
      this.approvalAck(userId, channel, env.id, prior === 'ok' ? 'delivered' : 'received');
      return;
    }

    this.approvalSeen.set(key, 'running');
    // Only 'ok' entries are eviction-eligible; a 'running' turn is never
    // evicted (same #R4-7 rule as `persisted`).
    this.evictCompleted(this.approvalSeen, this.dedupCap, (v) => v === 'ok');
    this.approvalAck(userId, channel, env.id, 'received'); // server got it; client → 'processing'

    this.hub.sendToUser(userId, createEnvelope('typing', { from: agent, to, channel, payload: { state: 'start' } }));
    let ok = false;
    try {
      const { reply, failed } = await this.runTurn({
        userId, channel, text: editedText ?? choice, messageId: env.id,
        approval: { refId, choice, ...(editedText !== undefined ? { editedText } : {}) },
      });
      if (!failed) { await this.emitReply(userId, channel, reply); ok = true; }
    } catch {
      // emitReply (store.append) or an unexpected throw: treat as failure.
      ok = false;
    } finally {
      this.hub.sendToUser(userId, createEnvelope('typing', { from: agent, to, channel, payload: { state: 'stop' } }));
    }

    if (ok) {
      this.approvalSeen.set(key, 'ok');
      this.approvalAck(userId, channel, env.id, 'delivered'); // TERMINAL success → client settles
    } else {
      // #R6-2: keep the decision retryable end to end. Forget the envelope so
      // a redelivery/retry re-runs (matching claim()'s failed-append
      // semantics), tell the client machine-readably (it holds the row in
      // 'processing' and only a terminal ack releases it), and surface the
      // error text.
      this.approvalSeen.delete(key);
      this.approvalAck(userId, channel, env.id, 'failed');
      this.hub.sendToUser(userId, createEnvelope('msg', { from: agent, to, channel, payload: { text: GENERIC_ERROR } }));
    }
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
