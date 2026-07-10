import { agentAddress, createEnvelope, userAddress, type AnyEnvelope } from '@raccoon/protocol';
import type { AgentRunner, MessageStore, OutboundHub } from './types.js';

const DEFAULT_HISTORY_CAP = 200;
const GENERIC_ERROR = 'Something went wrong handling that.';

export class RaccoonBridge {
  private readonly hub: OutboundHub;
  private readonly runner: AgentRunner;
  private readonly store: MessageStore;
  private readonly cap: number;

  constructor(opts: { hub: OutboundHub; runner: AgentRunner; store: MessageStore; historyLimitCap?: number }) {
    this.hub = opts.hub;
    this.runner = opts.runner;
    this.store = opts.store;
    this.cap = opts.historyLimitCap ?? DEFAULT_HISTORY_CAP;
  }

  /** Subscribe to the hub. Returns an unsubscribe function. */
  start(): () => void {
    return this.hub.onEnvelope((env, userId) => {
      void this.handle(env, userId);
    });
  }

  private async handle(env: AnyEnvelope, userId: string): Promise<void> {
    if (env.kind === 'msg') return this.handleMsg(env, userId);
    if (env.kind === 'history.request') return this.handleHistory(env, userId);
    // Plan B ignores ack/typing/presence/approval.response and pairing kinds.
  }

  private async handleMsg(env: Extract<AnyEnvelope, { kind: 'msg' }>, userId: string): Promise<void> {
    const channel = env.channel;
    const agent = agentAddress(channel);
    const to = userAddress(userId);
    const ts = new Date().toISOString();

    await this.store.append({ id: env.id, channel, userId, role: 'user', text: env.payload.text, ts });

    this.hub.sendToUser(userId, createEnvelope('ack', {
      from: agent, to, channel, payload: { refId: env.id, status: 'received' },
    }));
    this.hub.sendToUser(userId, createEnvelope('typing', {
      from: agent, to, channel, payload: { state: 'start' },
    }));

    let reply = '';
    let failed = false;
    try {
      for await (const chunk of this.runner.run({ userId, channel, text: env.payload.text, messageId: env.id })) {
        reply += chunk;
      }
    } catch {
      failed = true;
    }

    this.hub.sendToUser(userId, createEnvelope('typing', {
      from: agent, to, channel, payload: { state: 'stop' },
    }));

    if (failed) {
      this.hub.sendToUser(userId, createEnvelope('msg', {
        from: agent, to, channel, payload: { text: GENERIC_ERROR },
      }));
      return;
    }

    const replyEnv = createEnvelope('msg', { from: agent, to, channel, payload: { text: reply } });
    await this.store.append({
      id: replyEnv.id, channel, userId, role: 'agent', text: reply, ts: replyEnv.ts,
    });
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
