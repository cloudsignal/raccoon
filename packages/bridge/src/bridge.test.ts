import { describe, expect, it } from 'vitest';
import { createEnvelope, type AnyEnvelope } from '@raccoon/protocol';
import { RaccoonBridge } from './bridge.js';
import { InMemoryMessageStore } from './message-store.js';
import type { AgentContext, AgentRunner, OutboundHub } from './types.js';

/** Fake hub: captures sends, lets tests inject inbound envelopes. */
class FakeHub implements OutboundHub {
  sent: Array<{ userId: string; env: AnyEnvelope }> = [];
  private handler: ((env: AnyEnvelope, userId: string) => void) | null = null;
  sendToUser(userId: string, env: AnyEnvelope): boolean {
    this.sent.push({ userId, env });
    return true;
  }
  onEnvelope(handler: (env: AnyEnvelope, userId: string) => void): () => void {
    this.handler = handler;
    return () => { this.handler = null; };
  }
  inject(env: AnyEnvelope, userId: string): void {
    this.handler?.(env, userId);
  }
}

const echoRunner: AgentRunner = {
  async *run(ctx: AgentContext) { yield `you said: ${ctx.text}`; },
};

function userMsg(text: string, channel = 'coordinator'): AnyEnvelope {
  return createEnvelope('msg', {
    from: 'user:u1', to: `agent:${channel}`, channel, payload: { text },
  });
}

// A bridge run is async; give microtasks + the runner time to flush.
const settle = () => new Promise((r) => setTimeout(r, 20));

describe('RaccoonBridge', () => {
  it('acks, shows typing, replies, and stores both sides', async () => {
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    const bridge = new RaccoonBridge({ hub, runner: echoRunner, store });
    bridge.start();

    const inbound = userMsg('hello');
    hub.inject(inbound, 'u1');
    await settle();

    const kinds = hub.sent.map((s) => s.env.kind);
    expect(kinds).toEqual(['ack', 'typing', 'typing', 'msg']);

    const ack = hub.sent[0].env;
    if (ack.kind === 'ack') expect(ack.payload).toEqual({ refId: inbound.id, status: 'received' });
    const t1 = hub.sent[1].env; if (t1.kind === 'typing') expect(t1.payload.state).toBe('start');
    const t2 = hub.sent[2].env; if (t2.kind === 'typing') expect(t2.payload.state).toBe('stop');

    const reply = hub.sent[3].env;
    expect(reply.kind).toBe('msg');
    if (reply.kind === 'msg') {
      expect(reply.payload.text).toBe('you said: hello');
      expect(reply.from).toBe('agent:coordinator');
      expect(reply.to).toBe('user:u1');
    }

    const page = await store.page('coordinator', { userId: 'u1', limit: 10 });
    expect(page.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'hello'],
      ['agent', 'you said: hello'],
    ]);
  });

  it('sends a generic error reply and does not store a partial agent turn when the runner throws', async () => {
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    const boom: AgentRunner = { async *run() { throw new Error('secret internal detail'); } };
    const bridge = new RaccoonBridge({ hub, runner: boom, store });
    bridge.start();

    hub.inject(userMsg('trigger'), 'u1');
    await settle();

    const kinds = hub.sent.map((s) => s.env.kind);
    expect(kinds).toEqual(['ack', 'typing', 'typing', 'msg']);
    const reply = hub.sent[3].env;
    if (reply.kind === 'msg') {
      expect(reply.payload.text).toBe('Something went wrong handling that.');
      expect(reply.payload.text).not.toContain('secret');
    }
    const page = await store.page('coordinator', { userId: 'u1', limit: 10 });
    expect(page.messages.map((m) => m.role)).toEqual(['user']); // no agent row
  });

  it('answers history.request with a history.page capped at historyLimitCap', async () => {
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    const bridge = new RaccoonBridge({ hub, runner: echoRunner, store, historyLimitCap: 2 });
    bridge.start();

    for (let i = 0; i < 3; i++) {
      await store.append({ id: `m${i}`, channel: 'coordinator', userId: 'u1', role: 'user', text: `t${i}`, ts: `2026-07-04T10:0${i}:00.000Z` });
    }

    hub.inject(createEnvelope('history.request', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator',
      payload: { channel: 'coordinator', limit: 100 },
    }), 'u1');
    await settle();

    expect(hub.sent).toHaveLength(1);
    const page = hub.sent[0].env;
    expect(page.kind).toBe('history.page');
    if (page.kind === 'history.page') {
      expect(page.payload.messages.map((m) => m.id)).toEqual(['m1', 'm2']); // capped to 2
      expect(page.payload.nextBefore).toBe('m1');
    }
  });

  it('ignores non-actionable inbound kinds', async () => {
    const hub = new FakeHub();
    const bridge = new RaccoonBridge({ hub, runner: echoRunner, store: new InMemoryMessageStore() });
    bridge.start();
    hub.inject(createEnvelope('typing', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { state: 'start' },
    }), 'u1');
    await settle();
    expect(hub.sent).toHaveLength(0);
  });

  it('does not send a msg (or crash) when the agent yields an empty reply (#3)', async () => {
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    const empty: AgentRunner = { async *run() { /* yields nothing */ } };
    const bridge = new RaccoonBridge({ hub, runner: empty, store });
    bridge.start();
    hub.inject(userMsg('hi'), 'u1');
    await settle();
    // ack + typing start/stop, but NO trailing empty 'msg' (which would be a
    // protocol-invalid envelope and, unawaited, crash the process).
    expect(hub.sent.map((s) => s.env.kind)).toEqual(['ack', 'typing', 'typing']);
    const page = await store.page('coordinator', { userId: 'u1', limit: 10 });
    expect(page.messages.map((m) => m.role)).toEqual(['user']); // no empty agent row
  });

  it('re-acks but does not re-run the agent on a redelivered message (#5)', async () => {
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    let runs = 0;
    const counting: AgentRunner = { async *run() { runs += 1; yield `r${runs}`; } };
    const bridge = new RaccoonBridge({ hub, runner: counting, store });
    bridge.start();
    const inbound = userMsg('once');
    hub.inject(inbound, 'u1');
    await settle();
    hub.inject(inbound, 'u1'); // redelivery: identical envelope id
    await settle();
    expect(runs).toBe(1); // the agent turn ran exactly once
    // first turn: ack, typing, typing, msg ; redelivery: just a re-ack.
    expect(hub.sent.map((s) => s.env.kind)).toEqual(['ack', 'typing', 'typing', 'msg', 'ack']);
  });

  it('routes approval.response to the runner and replies (#6)', async () => {
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    const seen: AgentContext[] = [];
    const capture: AgentRunner = { async *run(ctx) { seen.push(ctx); yield `handled ${ctx.text}`; } };
    const bridge = new RaccoonBridge({ hub, runner: capture, store });
    bridge.start();
    hub.inject(createEnvelope('approval.response', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator',
      payload: { refId: 'req-1', choice: 'edit', editedText: 'Better draft' },
    }), 'u1');
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]!.text).toBe('Better draft'); // editedText preferred over raw choice
    expect(seen[0]!.approval).toEqual({ refId: 'req-1', choice: 'edit', editedText: 'Better draft' });
    // Fire-and-forget: no ack, just typing + the agent reply.
    expect(hub.sent.map((s) => s.env.kind)).toEqual(['typing', 'typing', 'msg']);
    const reply = hub.sent[2]!.env;
    if (reply.kind === 'msg') expect(reply.payload.text).toBe('handled Better draft');
  });
});
