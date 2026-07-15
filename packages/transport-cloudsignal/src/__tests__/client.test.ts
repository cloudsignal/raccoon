import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudSignalTransport } from '../client.js';
import type { CloudSignalTransportOptions, TokenProvider } from '../client.js';
import { raccoonCodec } from '@raccoon/transport-mqtt';
import { createEnvelope } from '@raccoon/protocol';

// ---------------------------------------------------------------------------
// Fake CloudSignalClient
// ---------------------------------------------------------------------------

function createFakeCloudSignalClient() {
  let messageHandler: ((topic: string, message: string) => void) | null = null;
  const subscribed: string[] = [];
  const transmitted: Array<[string, string, { qos?: 0 | 1 | 2; retain?: boolean } | undefined]> = [];
  let connectCalled = false;
  let destroyCalled = false;
  let connectOpts: Record<string, unknown> = {};

  // Exposed callback setters (mirror real SDK's property assignment model)
  let onConnectionStatusChangeCb: ((connected: boolean) => void) | null = null;
  let onAuthErrorCb: ((err: Error) => void) | null = null;
  // #R10: let a test control what transmit() returns (a rejecting or deferred
  // publish promise) to model a broker/PUBACK failure.
  let transmitImpl: (() => void | Promise<void>) | null = null;

  const client = {
    get onConnectionStatusChange() { return onConnectionStatusChangeCb; },
    set onConnectionStatusChange(cb: ((connected: boolean) => void) | null) { onConnectionStatusChangeCb = cb; },
    get onAuthError() { return onAuthErrorCb; },
    set onAuthError(cb: ((err: Error) => void) | null) { onAuthErrorCb = cb; },

    async connectWithToken(opts: Record<string, unknown>): Promise<void> {
      connectCalled = true;
      connectOpts = opts;
    },
    async subscribe(topic: string, _qos?: 0 | 1 | 2): Promise<void> {
      subscribed.push(topic);
    },
    async unsubscribe(_topic: string): Promise<void> {},
    transmit(topic: string, message: string, options?: { qos?: 0 | 1 | 2; retain?: boolean }): void | Promise<void> {
      transmitted.push([topic, message, options]);
      if (transmitImpl) return transmitImpl();
    },
    destroy() {
      destroyCalled = true;
    },
    onMessage(handler: (topic: string, message: string) => void) {
      messageHandler = handler;
    },

    // --- test helpers ---
    emit(topic: string, message: string) {
      messageHandler?.(topic, message);
    },
    fireAuthError(err: Error) {
      onAuthErrorCb?.(err);
    },
    fireConnectionStatusChange(connected: boolean) {
      onConnectionStatusChangeCb?.(connected);
    },
    get connectCalled() { return connectCalled; },
    get connectOpts() { return connectOpts; },
    get destroyCalled() { return destroyCalled; },
    get subscribed() { return subscribed; },
    get transmitted() { return transmitted; },
    setTransmitImpl(fn: (() => void | Promise<void>) | null) { transmitImpl = fn; },
  };

  return client;
}

type FakeClient = ReturnType<typeof createFakeCloudSignalClient>;

// ---------------------------------------------------------------------------
// Fake TokenProvider
// ---------------------------------------------------------------------------

function createFakeTokenProvider(token = 'test-token'): TokenProvider & { callCount: number } {
  let callCount = 0;
  return {
    get callCount() { return callCount; },
    async getExternalToken() {
      callCount++;
      return token;
    },
  };
}

// ---------------------------------------------------------------------------
// Fake pwa-sdk CloudSignalPWA
// ---------------------------------------------------------------------------

function createFakePwa(registrationId = 'push-reg-123') {
  let registeredForPush = false;

  return {
    async initialize() {},
    async registerForPush() {
      registeredForPush = true;
      return { registrationId };
    },
    isRegistered() { return registeredForPush; },
    canInstall() { return false; },
    clearBadge() {},
    async showInstallPrompt() {},
    on(_event: string, _handler: unknown) {},
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_OPTS = {
  host: 'wss://mqtt.cloudsignal.io',
  organizationId: 'org-test',
  tokenServiceUrl: 'https://api.cloudsignal.io/v2/tokens',
  instance: 'test-instance',
  userId: 'u1',
  codec: raccoonCodec,
};

function makeTransport(
  extra?: Partial<CloudSignalTransportOptions> & { ClientImpl?: unknown },
  tokenProvider?: TokenProvider,
) {
  const tokens = tokenProvider ?? createFakeTokenProvider();
  return new CloudSignalTransport({ ...BASE_OPTS, ...extra, tokens });
}

/** Drain a few microtask ticks so async work inside connect() completes. */
async function flushMicrotasks(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i++) await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CloudSignalTransport', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetAllMocks();
  });

  // -------------------------------------------------------------------------
  // 1. connect() — token exchange + subscribe + onConnect publish
  // -------------------------------------------------------------------------

  describe('connect()', () => {
    it('calls getExternalToken once', async () => {
      const fake = createFakeCloudSignalClient();
      const tokens = createFakeTokenProvider('tok-abc');
      const transport = makeTransport({ ClientImpl: () => fake }, tokens);

      await transport.connect();

      expect(tokens.callCount).toBe(1);
    });

    it('passes token to connectWithToken as externalToken', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      await transport.connect();

      expect(fake.connectOpts['externalToken']).toBe('test-token');
      expect(fake.connectOpts['host']).toBe(BASE_OPTS.host);
      expect(fake.connectOpts['organizationId']).toBe(BASE_OPTS.organizationId);
    });

    it('subscribes to all codec topics after connect', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      await transport.connect();

      const ctx = { instance: BASE_OPTS.instance, userId: BASE_OPTS.userId };
      const expectedSubs = raccoonCodec.subscriptions(ctx).map((s) => s.topic);
      for (const topic of expectedSubs) {
        expect(fake.subscribed).toContain(topic);
      }
    });

    it('transmits onConnect messages after connect', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      await transport.connect();

      const ctx = { instance: BASE_OPTS.instance, userId: BASE_OPTS.userId };
      const onConnectMsgs = raccoonCodec.onConnect?.(ctx) ?? [];
      // Presence message should be among transmits
      expect(onConnectMsgs.length).toBeGreaterThan(0);
      const transmittedTopics = fake.transmitted.map(([t]) => t);
      for (const msg of onConnectMsgs) {
        expect(transmittedTopics).toContain(msg.topic);
      }
    });

    it('passes will params derived from codec.will() to connectWithToken', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      await transport.connect();

      const ctx = { instance: BASE_OPTS.instance, userId: BASE_OPTS.userId };
      const will = raccoonCodec.will?.(ctx);
      if (will) {
        expect(fake.connectOpts['willTopic']).toBe(will.topic);
        const willPayload = fake.connectOpts['willMessage'] as string;
        expect(JSON.parse(willPayload)).toMatchObject({ state: 'offline' });
      }
    });

    it('sets status to open after successful connect', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      const statuses: string[] = [];
      transport.onStatus((s) => statuses.push(s));

      await transport.connect();

      expect(statuses).toContain('open');
    });
  });

  // -------------------------------------------------------------------------
  // 2. send() — codec encode → client.transmit
  // -------------------------------------------------------------------------

  describe('send()', () => {
    it('encodes envelope and transmits to codec-specified topic', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      await transport.connect();

      const env = createEnvelope('msg', {
        from: 'user:u1',
        to: 'agent:bot',
        channel: 'main',
        payload: { text: 'hello' },
      });

      await transport.send(env);

      const ctx = { instance: BASE_OPTS.instance, userId: BASE_OPTS.userId };
      const encoded = raccoonCodec.encode(env, ctx);
      const transmittedTopics = fake.transmitted.map(([t]) => t);
      for (const msg of encoded) {
        expect(transmittedTopics).toContain(msg.topic);
      }
    });

    it('throws when transport is not open', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      const env = createEnvelope('msg', {
        from: 'user:u1',
        to: 'agent:bot',
        channel: 'main',
        payload: { text: 'hello' },
      });

      await expect(transport.send(env)).rejects.toThrow('transport not open');
    });

    it('rejects send() when the broker publish/PUBACK fails (#R10)', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });
      await transport.connect();
      fake.setTransmitImpl(() => Promise.reject(new Error('puback failed')));
      const env = createEnvelope('msg', { from: 'user:u1', to: 'agent:bot', channel: 'main', payload: { text: 'hi' } });
      // Awaiting the publish means a PUBACK failure surfaces as a send()
      // rejection (so the outbox keeps the row retryable) instead of a silent
      // loss under a synthesised 'received' ack.
      await expect(transport.send(env)).rejects.toThrow('puback failed');
    });

    it('does not resolve send() until the publish promise settles (#R10)', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });
      await transport.connect();
      let release!: () => void;
      fake.setTransmitImpl(() => new Promise<void>((r) => { release = r; }));
      const env = createEnvelope('msg', { from: 'user:u1', to: 'agent:bot', channel: 'main', payload: { text: 'hi' } });
      let settled = false;
      const p = transport.send(env).then(() => { settled = true; });
      await new Promise((r) => setTimeout(r, 20));
      expect(settled).toBe(false); // still pending — broker hasn't PUBACKed
      release();
      await p;
      expect(settled).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // 3. inbound onMessage → decode → fire handlers
  // -------------------------------------------------------------------------

  describe('inbound message routing', () => {
    it('decodes incoming message and fires envelope handlers', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      await transport.connect();

      const received: unknown[] = [];
      transport.onEnvelope((env) => received.push(env));

      const env = createEnvelope('msg', {
        from: 'agent:bot',
        to: 'user:u1',
        channel: 'main',
        payload: { text: 'hi there' },
      });

      const ctx = { instance: BASE_OPTS.instance, userId: BASE_OPTS.userId };
      const outboxTopic = `raccoon/${BASE_OPTS.instance}/users/${BASE_OPTS.userId}/outbox`;

      // Simulate inbound message from broker
      fake.emit(outboxTopic, JSON.stringify(env));

      expect(received).toHaveLength(1);
      expect((received[0] as { kind: string }).kind).toBe('msg');
    });

    it('unsubscribe function removes envelope handler', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      await transport.connect();

      const received: unknown[] = [];
      const unsub = transport.onEnvelope((env) => received.push(env));

      const env = createEnvelope('msg', {
        from: 'agent:bot',
        to: 'user:u1',
        channel: 'main',
        payload: { text: 'first' },
      });
      const ctx = { instance: BASE_OPTS.instance, userId: BASE_OPTS.userId };
      const outboxTopic = `raccoon/${BASE_OPTS.instance}/users/${BASE_OPTS.userId}/outbox`;

      fake.emit(outboxTopic, JSON.stringify(env));
      expect(received).toHaveLength(1);

      unsub();

      fake.emit(outboxTopic, JSON.stringify(env));
      expect(received).toHaveLength(1); // no second delivery
    });
  });

  // -------------------------------------------------------------------------
  // 4. Auth-error → one token refresh + reconnect, then give up (no loop)
  // -------------------------------------------------------------------------

  describe('auth error handling', () => {
    it('attempts ONE token refresh on auth error, then gives up within an episode', async () => {
      // Within a single failed-connect episode the retry budget allows exactly one
      // refresh+reconnect.  If the retry client also gets an auth error immediately
      // (budget still marked used from this episode), the transport gives up.
      //
      // Note: authRetryUsed is reset ONLY when dial() reaches setStatus('open').
      // If fakes[1] fires auth error before dial() sets 'open', authRetryUsed is still
      // true from the episode, so no third attempt is made.
      const fakes: FakeClient[] = [];

      // Make fakes[1]'s connectWithToken fire an auth error synchronously via a
      // special factory that triggers the error before dial() reaches setStatus('open').
      let rejectConnect: ((err: Error) => void) | null = null;
      const tokens = createFakeTokenProvider('tok-initial');
      const transport = makeTransport(
        {
          ClientImpl: () => {
            const fake = createFakeCloudSignalClient();
            // Override connectWithToken on the second client to fire auth error
            // during dial before the connection is fully established.
            if (fakes.length === 1) {
              const orig = fake.connectWithToken.bind(fake);
              (fake as unknown as Record<string, unknown>).connectWithToken = async (opts: Record<string, unknown>) => {
                await orig(opts);
                // Fire auth error immediately after connect (simulating broker rejection
                // before dial() reaches setStatus('open') in this tick)
                Promise.resolve().then(() => fake.fireAuthError(new Error('401')));
              };
            }
            fakes.push(fake);
            return fake;
          },
        },
        tokens,
      );

      void rejectConnect; // suppress unused warning

      await transport.connect();
      expect(fakes).toHaveLength(1);

      // Episode 1: auth error on fakes[0] → retry → fakes[1]
      fakes[0]!.fireAuthError(new Error('401 not authorized'));
      await flushMicrotasks(10);

      // Two clients: initial + retry
      expect(fakes).toHaveLength(2);
      // Two token fetches: initial + retry
      expect(tokens.callCount).toBe(2);

      // fakes[1] fired auth error during connect (before 'open') — budget was still
      // used, so no third client should be created.
      await flushMicrotasks(10);
      expect(fakes).toHaveLength(2);
      expect(tokens.callCount).toBe(2);
    });

    it('fires onAuthError handlers only after budget is exhausted (retry itself fails immediately)', async () => {
      // First auth error → retry (budget used). Retry client fires auth error
      // BEFORE dial() reaches setStatus('open') (budget still true) → handlers fire.
      // Because the retry client fires synchronously during the same flushMicrotasks
      // run as the initial retry, both the retry and the handler-fire happen together.
      const fakes: FakeClient[] = [];
      const tokens = createFakeTokenProvider('tok-initial');
      const transport = makeTransport(
        {
          ClientImpl: () => {
            const fake = createFakeCloudSignalClient();
            // The retry client (index 1) fires an auth error immediately after connect,
            // before dial() reaches setStatus('open').
            if (fakes.length === 1) {
              const orig = fake.connectWithToken.bind(fake);
              (fake as unknown as Record<string, unknown>).connectWithToken = async (opts: Record<string, unknown>) => {
                await orig(opts);
                Promise.resolve().then(() => fake.fireAuthError(new Error('401')));
              };
            }
            fakes.push(fake);
            return fake;
          },
        },
        tokens,
      );

      await transport.connect();

      const authErrors: number[] = [];
      transport.onAuthError((code) => authErrors.push(code));

      // First auth error — triggers refresh+reconnect. Retry client fires auth
      // error before setStatus('open'), so after all microtasks settle the
      // handler fires AND no third client is created (budget exhausted).
      fakes[0]!.fireAuthError(new Error('401 not authorized'));
      await flushMicrotasks(20);

      expect(fakes).toHaveLength(2);      // only two clients: initial + retry
      expect(authErrors).toHaveLength(1); // handlers fired once after budget exhausted
      expect(authErrors[0]).toBe(401);
    });

    it('onAuthError returns an unsubscribe function', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      await transport.connect();

      const authErrors: number[] = [];
      const unsub = transport.onAuthError((code) => authErrors.push(code));
      unsub();

      fake.fireAuthError(new Error('401'));
      await flushMicrotasks();

      // No errors fired after unsubscribe
      expect(authErrors).toHaveLength(0);
    });

    it('a recoverable auth error (refresh succeeds) does NOT fire onAuthError handlers', async () => {
      // Scenario: first auth error → retry succeeds → handlers must NOT be called
      const fakes: FakeClient[] = [];
      const tokens = createFakeTokenProvider();
      const transport = makeTransport(
        {
          ClientImpl: () => {
            const fake = createFakeCloudSignalClient();
            fakes.push(fake);
            return fake;
          },
        },
        tokens,
      );

      await transport.connect();

      const authErrors: number[] = [];
      transport.onAuthError((code) => authErrors.push(code));

      // Trigger auth error — retry will succeed because the second fake client
      // does not fire another auth error.
      fakes[0]!.fireAuthError(new Error('401'));
      await flushMicrotasks(10);

      // A second client should exist (retry attempt)
      expect(fakes).toHaveLength(2);
      // But no handler should have fired — the error was recoverable
      expect(authErrors).toHaveLength(0);
    });

    it('an unrecoverable auth error (retry connect fails) DOES fire onAuthError handlers', async () => {
      // Scenario: first auth error → retry → retry client fires auth error BEFORE
      // open (budget still marked used) → handlers fire exactly once.
      const fakes: FakeClient[] = [];
      const tokens = createFakeTokenProvider();
      const transport = makeTransport(
        {
          ClientImpl: () => {
            const fake = createFakeCloudSignalClient();
            // Retry client fires auth error during connect (before setStatus('open'))
            if (fakes.length === 1) {
              const orig = fake.connectWithToken.bind(fake);
              (fake as unknown as Record<string, unknown>).connectWithToken = async (opts: Record<string, unknown>) => {
                await orig(opts);
                Promise.resolve().then(() => fake.fireAuthError(new Error('401')));
              };
            }
            fakes.push(fake);
            return fake;
          },
        },
        tokens,
      );

      await transport.connect();

      const authErrors: number[] = [];
      transport.onAuthError((code) => authErrors.push(code));

      fakes[0]!.fireAuthError(new Error('401'));
      await flushMicrotasks(10);

      // Retry client fired auth error before open — budget exhausted, handlers fire
      await flushMicrotasks(10);

      expect(authErrors).toHaveLength(1);
      expect(authErrors[0]).toBe(401);
    });

    it('authRetryUsed resets after a successful reconnect (two independent episodes)', async () => {
      // After a successful reconnect, a later auth episode gets a fresh one-shot retry.
      // This means getExternalToken is called: episode1(initial+retry) + episode2(retry) = 3× total.
      const fakes: FakeClient[] = [];
      const tokens = createFakeTokenProvider();
      const transport = makeTransport(
        {
          ClientImpl: () => {
            const fake = createFakeCloudSignalClient();
            fakes.push(fake);
            return fake;
          },
        },
        tokens,
      );

      // Episode 0: initial connect — token call #1
      await transport.connect();
      expect(tokens.callCount).toBe(1);

      // Episode 1: auth error on fakes[0] → retry → fakes[1] connects successfully
      // token call #2 happens during the retry
      fakes[0]!.fireAuthError(new Error('401'));
      await flushMicrotasks(10);
      expect(fakes).toHaveLength(2);
      expect(tokens.callCount).toBe(2);

      // fakes[1] is now open — no auth error fired → authRetryUsed should be reset
      // Episode 2: auth error on fakes[1] → should get a FRESH retry → token call #3
      fakes[1]!.fireAuthError(new Error('401'));
      await flushMicrotasks(10);

      expect(fakes).toHaveLength(3); // third client = retry for episode 2
      expect(tokens.callCount).toBe(3); // fresh token fetch for episode 2's retry
    });
  });

  // -------------------------------------------------------------------------
  // 5. onConnectionStatusChange — broker disconnect/reconnect handling
  // -------------------------------------------------------------------------

  describe('connection status change handling', () => {
    it('sets status to closed when broker fires onConnectionStatusChange(false)', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      const statuses: string[] = [];
      transport.onStatus((s) => statuses.push(s));

      await transport.connect();
      expect(statuses).toContain('open');

      // Simulate broker disconnect (network drop, idle timeout, etc.)
      fake.fireConnectionStatusChange(false);

      expect(statuses).toContain('closed');
    });

    it('emits closed status exactly once on disconnect', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      const statuses: string[] = [];
      transport.onStatus((s) => statuses.push(s));

      await transport.connect();
      statuses.length = 0; // clear initial 'open' status

      // Fire disconnect twice in succession
      fake.fireConnectionStatusChange(false);
      fake.fireConnectionStatusChange(false);

      // Should only have one 'closed' in statuses
      expect(statuses.filter((s) => s === 'closed')).toHaveLength(1);
    });

    it('does not emit closed when user calls close() first', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      const statuses: string[] = [];
      transport.onStatus((s) => statuses.push(s));

      await transport.connect();
      await transport.close();

      const closedCount = statuses.filter((s) => s === 'closed').length;

      // Fire connection status change after user close
      fake.fireConnectionStatusChange(false);

      // Should still have only one 'closed' (from close(), not from the status change)
      expect(statuses.filter((s) => s === 'closed')).toHaveLength(closedCount);
    });

    it('can reconnect after broker disconnect via reconnect', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      const statuses: string[] = [];
      transport.onStatus((s) => statuses.push(s));

      await transport.connect();
      statuses.length = 0;

      // Broker disconnect
      fake.fireConnectionStatusChange(false);
      expect(statuses).toContain('closed');

      statuses.length = 0;

      // Broker reconnect
      fake.fireConnectionStatusChange(true);
      expect(statuses).toContain('open');
    });
  });

  // -------------------------------------------------------------------------
  // 6. enablePush() — registers via pwa-sdk when push configured
  // -------------------------------------------------------------------------

  describe('enablePush()', () => {
    it('returns null when push not configured', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      await transport.connect();
      const result = await transport.enablePush();

      expect(result).toBeNull();
    });

    it('returns null when push configured but PwaImpl not provided', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({
        ClientImpl: () => fake,
        push: {
          serviceUrl: 'https://pwa.cloudsignal.io',
          serviceId: 'svc-test',
        },
      });

      await transport.connect();
      const result = await transport.enablePush();

      // Without PwaImpl, should gracefully return null (can't load pwa-sdk in test env)
      expect(result).toBeNull();
    });

    it('calls registerForPush on pwa instance and returns the registration id on success', async () => {
      const fake = createFakeCloudSignalClient();
      const fakePwa = createFakePwa('reg-456');

      const transport = makeTransport({
        ClientImpl: () => fake,
        push: {
          serviceUrl: 'https://pwa.cloudsignal.io',
          serviceId: 'svc-test',
          publishableKey: 'pk-test',
        },
        PwaImpl: () => fakePwa,
      });

      await transport.connect();
      const result = await transport.enablePush();

      expect(result).toBe('reg-456');
    });

    it('returns null when pwa registerForPush returns null', async () => {
      const fake = createFakeCloudSignalClient();
      const fakePwa = {
        async initialize() {},
        async registerForPush() { return null; },
        isRegistered() { return false; },
        canInstall() { return false; },
        clearBadge() {},
        async showInstallPrompt() {},
        on(_event: string, _handler: unknown) {},
      };

      const transport = makeTransport({
        ClientImpl: () => fake,
        push: {
          serviceUrl: 'https://pwa.cloudsignal.io',
          serviceId: 'svc-test',
        },
        PwaImpl: () => fakePwa,
      });

      await transport.connect();
      const result = await transport.enablePush();

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // 7. close()
  // -------------------------------------------------------------------------

  describe('close()', () => {
    it('destroys the underlying client and sets status to closed', async () => {
      const fake = createFakeCloudSignalClient();
      const transport = makeTransport({ ClientImpl: () => fake });

      const statuses: string[] = [];
      transport.onStatus((s) => statuses.push(s));

      await transport.connect();
      await transport.close();

      expect(fake.destroyCalled).toBe(true);
      expect(statuses).toContain('closed');
    });
  });
});
