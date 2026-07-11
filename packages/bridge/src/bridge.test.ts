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

  it('a redelivery after a transient append failure re-attempts persistence and the agent run (#R2-3)', async () => {
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    let appendCalls = 0;
    const originalAppend = store.append.bind(store);
    store.append = async (m) => {
      appendCalls += 1;
      if (appendCalls === 1) throw new Error('transient store failure');
      return originalAppend(m);
    };
    let runs = 0;
    const counting: AgentRunner = { async *run() { runs += 1; yield `r${runs}`; } };
    const bridge = new RaccoonBridge({ hub, runner: counting, store });
    bridge.start();

    const inbound = userMsg('please persist me');
    hub.inject(inbound, 'u1'); // first attempt: append() throws
    await settle();
    // The failed attempt must NOT have acked (it never reached the ack call)
    // and must not have crashed the process (start()'s catch contains it).
    expect(hub.sent).toHaveLength(0);
    expect(appendCalls).toBe(1);
    expect(runs).toBe(0);

    hub.inject(inbound, 'u1'); // redelivery: SAME envelope id, client retried
    await settle();

    // The retry must be treated as a FRESH attempt, not silently swallowed as
    // "already seen": the failed attempt's 1 append call, plus this attempt's
    // 2 (user message + agent reply), plus one agent run, full ack/typing/msg.
    expect(appendCalls).toBe(3);
    expect(runs).toBe(1);
    expect(hub.sent.map((s) => s.env.kind)).toEqual(['ack', 'typing', 'typing', 'msg']);
    const page = await store.page('coordinator', { userId: 'u1', limit: 10 });
    expect(page.messages.map((m) => [m.role, m.text])).toEqual([
      ['user', 'please persist me'],
      ['agent', 'r1'],
    ]);
  });

  it('a duplicate arriving while the original append is still pending does not get a premature ack when that append then fails (#R3-6)', async () => {
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    const gate: { release?: () => void } = {};
    let appendCalls = 0;
    const originalAppend = store.append.bind(store);
    store.append = async (m) => {
      appendCalls += 1;
      if (appendCalls === 1) {
        // Block the FIRST append (the original attempt) until the test releases it.
        await new Promise<void>((resolve) => { gate.release = resolve; });
        throw new Error('store failure after the duplicate arrived');
      }
      return originalAppend(m);
    };
    let runs = 0;
    const counting: AgentRunner = { async *run() { runs += 1; yield `r${runs}`; } };
    const bridge = new RaccoonBridge({ hub, runner: counting, store });
    bridge.start();

    const inbound = userMsg('race me');
    hub.inject(inbound, 'u1'); // original: append() called, now blocked
    await Promise.resolve(); // let the handler reach and await store.append()

    hub.inject(inbound, 'u1'); // genuinely concurrent duplicate: SAME envelope id
    await Promise.resolve();
    await Promise.resolve();

    // Neither delivery may have acked yet: the real outcome (failure) isn't
    // known. The old boolean-Set design acked the duplicate immediately here.
    expect(hub.sent).toHaveLength(0);

    gate.release?.();
    await settle();

    // Once the original append rejects, NEITHER delivery acks, and the agent
    // never runs for a message that was never durably persisted.
    expect(hub.sent).toHaveLength(0);
    expect(runs).toBe(0);
    expect(appendCalls).toBe(1); // the duplicate awaited the SAME in-flight attempt, no second append call
  });

  it('dedup eviction never removes a key whose agent turn is still running, even at cap 1 (#R4-7)', async () => {
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    const runsFor: Record<string, number> = { A: 0, B: 0 };
    const appendsFor: Record<string, number> = { A: 0, B: 0 };
    const originalAppend = store.append.bind(store);
    store.append = async (m) => {
      if (m.text === 'A' || m.text === 'B') appendsFor[m.text] = (appendsFor[m.text] ?? 0) + 1;
      return originalAppend(m);
    };
    const gate: { release?: () => void } = {};
    const runner: AgentRunner = {
      async *run(ctx) {
        runsFor[ctx.text] = (runsFor[ctx.text] ?? 0) + 1;
        if (ctx.text === 'A') {
          // A's turn blocks — simulates a slow LLM/tool-backed turn still in
          // progress when other messages arrive.
          await new Promise<void>((resolve) => { gate.release = resolve; });
        }
        yield `handled ${ctx.text}`;
      },
    };
    // Cap 1: any second concurrently-tracked key immediately exceeds it,
    // maximizing eviction pressure — matches the reviewer's cap-1 repro.
    const bridge = new RaccoonBridge({ hub, runner, store, dedupCap: 1 });
    bridge.start();

    const envA = userMsg('A');
    hub.inject(envA, 'u1'); // A's append succeeds; its turn starts and blocks on the gate
    await settle();
    expect(appendsFor['A']).toBe(1);
    expect(runsFor['A']).toBe(1);

    const envB = userMsg('B');
    hub.inject(envB, 'u1'); // B's append succeeds too — the map now holds 2 keys, over cap(1)
    await settle(); // B's turn (unblocked) runs to completion

    expect(appendsFor['B']).toBe(1);
    expect(runsFor['B']).toBe(1);

    // A's entry must NOT have been evicted despite being the oldest and the
    // map exceeding cap: its turn was (and still is) running. Redeliver A's
    // SAME envelope while A's own turn is still blocked.
    hub.inject(envA, 'u1');
    await settle();

    // Recognized as an in-flight duplicate: no second append, no second run.
    expect(appendsFor['A']).toBe(1);
    expect(runsFor['A']).toBe(1);

    gate.release?.(); // let A's turn finish
    await settle();
    expect(runsFor['A']).toBe(1); // still exactly once, even after completing
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
    // received ack (R2-5) → typing → reply msg → typing stop → terminal
    // 'delivered' ack (#R6-2b) so the client settles its durable row.
    expect(hub.sent.map((s) => s.env.kind)).toEqual(['ack', 'typing', 'msg', 'typing', 'ack']);
    const first = hub.sent[0]!.env; if (first.kind === 'ack') expect(first.payload.status).toBe('received');
    const reply = hub.sent[2]!.env;
    if (reply.kind === 'msg') expect(reply.payload.text).toBe('handled Better draft');
    const last = hub.sent[4]!.env; if (last.kind === 'ack') expect(last.payload.status).toBe('delivered');
  });

  it('acks a redelivered approval.response without re-running the agent (#R2-5)', async () => {
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    let runs = 0;
    const counting: AgentRunner = { async *run() { runs += 1; yield 'ok'; } };
    const bridge = new RaccoonBridge({ hub, runner: counting, store });
    bridge.start();
    const env = createEnvelope('approval.response', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator',
      payload: { refId: 'req-1', choice: 'approve' },
    });
    hub.inject(env, 'u1');
    await settle();
    hub.inject(env, 'u1'); // redelivery: same envelope id
    await settle();

    expect(runs).toBe(1); // redelivery never re-runs the agent
    const acks = hub.sent.filter((s) => s.env.kind === 'ack');
    // First delivery: 'received' then terminal 'delivered'. Redelivery (turn
    // already 'ok'): re-emits the terminal 'delivered' so a client that lost
    // the first one still settles — never 'received', which would strand it
    // in 'processing' (#R6-2b).
    expect(acks.map((a) => a.env.kind === 'ack' ? a.env.payload.status : '')).toEqual(['received', 'delivered', 'delivered']);
    for (const a of acks) if (a.env.kind === 'ack') expect(a.env.payload.refId).toBe(env.id);
  });

  it('a failed approval turn emits a machine-readable failed ack and permits a retry to re-run (#R6-2)', async () => {
    // Previously the bridge acked 'received' and marked the envelope seen
    // BEFORE dispatch, then converted the runner's exception into a generic
    // error text — so the client had settled its outbox row and hidden the
    // approval controls, the redelivery was dropped as already-seen, and the
    // retained approval mapping (R5-8/R6-1) was unreachable in production.
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    let runs = 0;
    const flaky: AgentRunner = {
      async *run() {
        runs += 1;
        if (runs === 1) throw new Error('transient dispatch outage');
        yield 'approved!';
      },
    };
    const bridge = new RaccoonBridge({ hub, runner: flaky, store });
    bridge.start();
    const env = createEnvelope('approval.response', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator',
      payload: { refId: 'req-1', choice: 'Approve' },
    });
    hub.inject(env, 'u1');
    await settle();

    // The failure is surfaced as a FAILED ack for this envelope — the
    // client's approval card keys respondedDelivery off exactly this, which
    // re-enables its controls ("Tap to retry").
    const failedAcks = hub.sent.filter((s) => s.env.kind === 'ack' && s.env.payload.status === 'failed');
    expect(failedAcks).toHaveLength(1);
    if (failedAcks[0]!.env.kind === 'ack') expect(failedAcks[0]!.env.payload.refId).toBe(env.id);

    // And the envelope is no longer "seen": a redelivery (or the client's
    // retry re-sending it) actually re-runs the turn, which now succeeds.
    hub.inject(env, 'u1');
    await settle();
    expect(runs).toBe(2);
    const reply = hub.sent.filter((s) => s.env.kind === 'msg').at(-1)!.env;
    if (reply.kind === 'msg') expect(reply.payload.text).toBe('approved!');
  });

  it('a redelivery AFTER success re-emits the terminal delivered ack, never received (#R6-2b)', async () => {
    // The stuck-processing bug: the client keeps its outbox row in a durable
    // 'processing' state on 'received' and only a TERMINAL ack releases it.
    // A redelivery of an already-succeeded approval must therefore re-emit
    // 'delivered', not 'received' — otherwise a client that lost the first
    // 'delivered' (socket drop / reload) re-drives the envelope and is put
    // right back into 'processing' with nothing ever settling it.
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    let runs = 0;
    const runner: AgentRunner = { async *run() { runs += 1; yield 'done'; } };
    const bridge = new RaccoonBridge({ hub, runner, store });
    bridge.start();
    const env = createEnvelope('approval.response', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator',
      payload: { refId: 'req-1', choice: 'Approve' },
    });
    hub.inject(env, 'u1');
    await settle();
    hub.sent.length = 0; // ignore the first delivery's acks; focus on the redelivery

    hub.inject(env, 'u1'); // redelivery after success
    await settle();

    expect(runs).toBe(1); // not re-run
    const acks = hub.sent.filter((s) => s.env.kind === 'ack');
    expect(acks).toHaveLength(1);
    if (acks[0]!.env.kind === 'ack') {
      expect(acks[0]!.env.payload.status).toBe('delivered'); // terminal, not 'received'
      expect(acks[0]!.env.payload.refId).toBe(env.id);
    }
  });

  it('a send that throws mid-approval does not strand the key on running — a redelivery re-runs to a terminal outcome (#R7-1a)', async () => {
    // hub.sendToUser can throw on a broken socket. If it threw while the key
    // was still 'running' (e.g. the 'received' ack or typing start), the old
    // code left it stuck: a redelivery saw 'running' and only re-emitted
    // 'received', so the client sat in 'processing' forever.
    let sendCalls = 0;
    let runs = 0;
    class ThrowingHub extends FakeHub {
      sendToUser(userId: string, env: AnyEnvelope): boolean {
        sendCalls += 1;
        if (sendCalls === 1) throw new Error('socket broke'); // the first send (the 'received' ack)
        return super.sendToUser(userId, env);
      }
    }
    const hub = new ThrowingHub();
    const store = new InMemoryMessageStore();
    const runner: AgentRunner = { async *run() { runs += 1; yield 'ok'; } };
    const bridge = new RaccoonBridge({ hub, runner, store });
    bridge.start();
    const env = createEnvelope('approval.response', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator',
      payload: { refId: 'req-1', choice: 'Approve' },
    });
    hub.inject(env, 'u1');
    await settle();

    // The first attempt's 'received' ack threw → the key must NOT be stuck on
    // 'running'. A redelivery re-runs the turn to a real terminal outcome
    // (delivered), rather than being deduped into another 'received'.
    hub.inject(env, 'u1');
    await settle();

    expect(runs).toBeGreaterThanOrEqual(1);
    const delivered = hub.sent.filter((s) => s.env.kind === 'ack' && s.env.payload.status === 'delivered');
    expect(delivered.length).toBeGreaterThanOrEqual(1); // reached a terminal outcome
  });

  it('approval dedup eviction never removes a key whose agent turn is still running, even at cap 1 (#R4-7)', async () => {
    const hub = new FakeHub();
    const store = new InMemoryMessageStore();
    const runsFor: Record<string, number> = { A: 0, B: 0 };
    const gate: { release?: () => void } = {};
    const runner: AgentRunner = {
      async *run(ctx) {
        runsFor[ctx.text] = (runsFor[ctx.text] ?? 0) + 1;
        if (ctx.text === 'A') await new Promise<void>((resolve) => { gate.release = resolve; });
        yield `handled ${ctx.text}`;
      },
    };
    const bridge = new RaccoonBridge({ hub, runner, store, dedupCap: 1 });
    bridge.start();

    const envA = createEnvelope('approval.response', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator',
      payload: { refId: 'req-A', choice: 'A' },
    });
    hub.inject(envA, 'u1'); // A's turn starts and blocks
    await settle();
    expect(runsFor['A']).toBe(1);

    const envB = createEnvelope('approval.response', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator',
      payload: { refId: 'req-B', choice: 'B' },
    });
    hub.inject(envB, 'u1'); // B's own turn runs to completion — approvalSeen now holds 2 keys, over cap(1)
    await settle();
    expect(runsFor['B']).toBe(1);

    // A must still be recognized as in-flight despite being the oldest
    // entry and the map exceeding cap.
    hub.inject(envA, 'u1');
    await settle();
    expect(runsFor['A']).toBe(1); // no second run

    gate.release?.();
    await settle();
    expect(runsFor['A']).toBe(1);
  });
});
