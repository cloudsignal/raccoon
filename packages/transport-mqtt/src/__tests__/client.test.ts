import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MqttTransport } from '../client.js';
import { raccoonCodec } from '../codec.js';
import { createEnvelope } from '@raccoon/protocol';

// ---------------------------------------------------------------------------
// Fake mqtt client
// ---------------------------------------------------------------------------

function createFakeMqtt() {
  const listeners: Record<string, Function[]> = {};
  const subscribes: Array<[string, { qos: number }]> = [];
  const publishes: Array<[string, string, { qos: number; retain: boolean }]> = [];
  let ended = false;

  const client = {
    on(event: string, cb: Function) {
      (listeners[event] ??= []).push(cb);
      return client;
    },
    subscribe(topic: string, opts: { qos: number }, cb?: Function) {
      subscribes.push([topic, opts]);
      cb?.(null);
      return client;
    },
    publish(topic: string, payload: string, opts: { qos: number; retain: boolean }, cb?: Function) {
      publishes.push([topic, payload, opts]);
      cb?.(null);
      return client;
    },
    end() {
      ended = true;
    },
    // test helpers
    emit(event: string, ...args: unknown[]) {
      (listeners[event] ?? []).forEach((cb) => cb(...args));
    },
    get subscribes() {
      return subscribes;
    },
    get publishes() {
      return publishes;
    },
    get ended() {
      return ended;
    },
  };
  return client;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TEST_OPTS = {
  url: 'mqtt://localhost:1883',
  instance: 'test-instance',
  userId: 'u1',
  codec: raccoonCodec,
};

function makeTransport(extra?: Partial<typeof TEST_OPTS> & { MqttImpl?: unknown }) {
  return new MqttTransport({ ...TEST_OPTS, ...extra });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Drain a few microtask ticks (compatible with fake timers). */
async function flushMicrotasks(ticks = 4): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

/** Connect a transport and trigger the fake's connect event.
 *  dial() is async (awaits resolveMqttConnect), so we flush microtasks
 *  before emitting 'connect' to ensure listeners are registered. */
async function connectTransport(
  transport: MqttTransport,
  fake: ReturnType<typeof createFakeMqtt>,
): Promise<void> {
  const connectP = transport.connect();
  await flushMicrotasks();
  fake.emit('connect');
  await connectP;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MqttTransport', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connect subscribes to codec topics', async () => {
    const fake = createFakeMqtt();
    const transport = makeTransport({ MqttImpl: () => fake });

    await connectTransport(transport, fake);

    expect(fake.subscribes).toEqual(
      expect.arrayContaining([
        ['raccoon/test-instance/users/u1/outbox', { qos: 1 }],
      ]),
    );
  });

  it('connect publishes onConnect presence', async () => {
    const fake = createFakeMqtt();
    const transport = makeTransport({ MqttImpl: () => fake });

    await connectTransport(transport, fake);

    const presencePubs = fake.publishes.filter(([topic]) =>
      topic === 'raccoon/test-instance/users/u1/presence',
    );
    expect(presencePubs.length).toBeGreaterThan(0);

    const payload = JSON.parse(presencePubs[0][1]) as { state: string; userId: string };
    expect(payload.state).toBe('online');
    expect(payload.userId).toBe('u1');
  });

  it('connect registers will in mqttConnect opts', async () => {
    const fake = createFakeMqtt();
    let capturedOpts: Record<string, unknown> = {};
    const transport = makeTransport({
      MqttImpl: (_url: string, opts: Record<string, unknown>) => {
        capturedOpts = opts;
        return fake;
      },
    });

    await connectTransport(transport, fake);

    expect(capturedOpts['will']).toBeDefined();
    const will = capturedOpts['will'] as { topic: string; payload: string };
    expect(will.topic).toBe('raccoon/test-instance/users/u1/presence');
    const payload = JSON.parse(will.payload) as { state: string };
    expect(payload.state).toBe('offline');
  });

  it('send encodes and publishes to inbox', async () => {
    const fake = createFakeMqtt();
    const transport = makeTransport({ MqttImpl: () => fake });

    await connectTransport(transport, fake);

    const env = createEnvelope('msg', {
      from: 'user:u1',
      to: 'agent:bot',
      channel: 'main',
      payload: { text: 'hello' },
    });

    await transport.send(env);

    const inboxPubs = fake.publishes.filter(([topic]) =>
      topic === 'raccoon/test-instance/users/u1/inbox',
    );
    expect(inboxPubs.length).toBeGreaterThan(0);
    const decoded = JSON.parse(inboxPubs[0][1]) as { kind: string };
    expect(decoded.kind).toBe('msg');
  });

  it('inbound outbox message decodes to a Raccoon envelope', async () => {
    const fake = createFakeMqtt();
    const transport = makeTransport({ MqttImpl: () => fake });

    await connectTransport(transport, fake);

    const received: unknown[] = [];
    transport.onEnvelope((env) => received.push(env));

    const env = createEnvelope('msg', {
      from: 'agent:bot',
      to: 'user:u1',
      channel: 'main',
      payload: { text: 'hi' },
    });

    const outboxTopic = 'raccoon/test-instance/users/u1/outbox';
    fake.emit('message', outboxTopic, Buffer.from(JSON.stringify(env)));

    expect(received).toHaveLength(1);
    expect((received[0] as { kind: string }).kind).toBe('msg');
  });

  it('status transitions: connecting → open → closed', async () => {
    const fake = createFakeMqtt();
    const transport = makeTransport({ MqttImpl: () => fake });

    const statuses: string[] = [];
    transport.onStatus((s) => statuses.push(s));

    await connectTransport(transport, fake);
    await transport.close();

    expect(statuses).toEqual(['connecting', 'open', 'closed']);
  });

  it('reconnects and re-subscribes after unexpected close', async () => {
    vi.useFakeTimers();

    const fakes: ReturnType<typeof createFakeMqtt>[] = [];
    let callCount = 0;
    const transport = makeTransport({
      MqttImpl: () => {
        const fake = createFakeMqtt();
        fakes.push(fake);
        callCount++;
        return fake;
      },
    });

    // First connection — flush microtasks so dial() registers listeners before emit
    const connectP = transport.connect();
    await flushMicrotasks();
    fakes[0].emit('connect');
    await connectP;

    // Unexpected close (not by user)
    fakes[0].emit('close');

    // Advance timers to trigger reconnect (fires dial() in setTimeout callback)
    await vi.runAllTimersAsync();

    // dial() calls resolveMqttConnect (async), so flush microtasks to let it run
    await flushMicrotasks();

    // Second dial should have been triggered
    expect(callCount).toBe(2);

    // Simulate second connect succeeds
    fakes[1].emit('connect');
    await flushMicrotasks();

    // Should re-subscribe
    expect(fakes[1].subscribes).toEqual(
      expect.arrayContaining([
        ['raccoon/test-instance/users/u1/outbox', { qos: 1 }],
      ]),
    );

    await transport.close();
  });

  it('not-authorized error suppresses reconnect', async () => {
    vi.useFakeTimers();

    let callCount = 0;
    const fakes: ReturnType<typeof createFakeMqtt>[] = [];
    const transport = makeTransport({
      MqttImpl: () => {
        const fake = createFakeMqtt();
        fakes.push(fake);
        callCount++;
        return fake;
      },
    });

    // First connection
    const connectP = transport.connect();
    await flushMicrotasks();
    fakes[0].emit('connect');
    await connectP;

    // Auth error then close
    fakes[0].emit('error', new Error('Connection refused: Not authorized'));
    fakes[0].emit('close');

    // Advance timers — reconnect should NOT happen
    await vi.runAllTimersAsync();
    await flushMicrotasks();

    expect(callCount).toBe(1);
  });

  it('user close() emits exactly one closed status (no duplicate)', async () => {
    const fake = createFakeMqtt();
    const transport = makeTransport({ MqttImpl: () => fake });

    const statuses: string[] = [];
    transport.onStatus((s) => statuses.push(s));

    await connectTransport(transport, fake);
    expect(statuses).toEqual(['connecting', 'open']);

    // User initiates close
    const closeP = transport.close();
    await flushMicrotasks();

    // Simulate the fake mqtt close event firing (in real mqtt.js, end() is async)
    fake.emit('close');
    await closeP;

    // Verify exactly one 'closed' was emitted (no duplicate)
    expect(statuses).toEqual(['connecting', 'open', 'closed']);
  });
});
