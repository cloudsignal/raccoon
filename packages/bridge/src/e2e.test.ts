import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type AnyEnvelope } from '@raccoon/protocol';
import { WsHub, WsClientTransport } from '@raccoon/transport-ws';
import { RaccoonBridge } from './bridge.js';
import { InMemoryMessageStore } from './message-store.js';
import type { AgentContext, AgentRunner } from './types.js';

let hub: WsHub;
let client: WsClientTransport;
afterEach(async () => { await client?.close(); await hub?.stop(); });

const upperRunner: AgentRunner = {
  async *run(ctx: AgentContext) {
    // Two deltas, to prove the bridge concatenates.
    yield ctx.text.toUpperCase();
    yield '!';
  },
};

describe('bridge e2e over ws transport', () => {
  it('a paired client gets ack + typing + concatenated reply, then history', async () => {
    hub = new WsHub({ instance: 'test', channels: ['coordinator'] });
    const { port } = await hub.start();
    const bridge = new RaccoonBridge({ hub, runner: upperRunner, store: new InMemoryMessageStore() });
    bridge.start();

    const token = hub.issuePairingToken('u1');
    client = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, pairingToken: token, device: 'e2e' });
    const received: AnyEnvelope[] = [];
    client.onEnvelope((env) => received.push(env));
    await client.connect();

    await client.send(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'hi' },
    }));
    await new Promise((r) => setTimeout(r, 150));

    expect(received.map((e) => e.kind)).toEqual(['ack', 'typing', 'typing', 'msg']);
    const reply = received[3];
    if (reply.kind === 'msg') expect(reply.payload.text).toBe('HI!');

    // History round-trip.
    received.length = 0;
    await client.send(createEnvelope('history.request', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator',
      payload: { channel: 'coordinator', limit: 50 },
    }));
    await new Promise((r) => setTimeout(r, 100));

    expect(received).toHaveLength(1);
    const page = received[0];
    expect(page.kind).toBe('history.page');
    if (page.kind === 'history.page') {
      expect(page.payload.messages.map((m) => [m.role, m.text])).toEqual([
        ['user', 'hi'],
        ['agent', 'HI!'],
      ]);
    }
  });
});
