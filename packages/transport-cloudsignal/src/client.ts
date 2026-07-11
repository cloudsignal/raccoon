import type { AnyEnvelope, Transport, TransportStatus, Codec, CodecContext } from '@raccoon/protocol';

// ---------------------------------------------------------------------------
// CloudSignalClient interface — matches the runtime shape of
// @cloudsignal/mqtt-client without importing it at build time.
// A full ambient declaration lives in src/types/cloudsignal-mqtt-client.d.ts.
// ---------------------------------------------------------------------------

interface CloudSignalClientLike {
  connectWithToken(opts: {
    host: string;
    organizationId: string;
    externalToken: string;
    willTopic?: string;
    willMessage?: string;
    willQos?: 0 | 1 | 2;
    willRetain?: boolean;
  }): Promise<void>;
  subscribe(topic: string, qos?: 0 | 1 | 2): Promise<unknown>;
  unsubscribe(topic: string): Promise<unknown>;
  // #R10: the real @cloudsignal/mqtt-client transmit() returns a Promise that
  // resolves on the publish callback (a PUBACK at QoS>=1) and rejects on a
  // publish error. Typing it as `void` meant send() didn't await broker
  // acceptance, so a PUBACK failure was silently swallowed while the client
  // synthesised a 'received' ack and deleted the durable outbox row — losing
  // the message. Accept both shapes (a QoS-0 fake may return void); send()
  // awaits it either way.
  transmit(topic: string, message: string, options?: { qos?: 0 | 1 | 2; retain?: boolean }): void | Promise<void>;
  destroy(): void;
  onMessage(handler: (topic: string, message: string) => void): void;
  onConnectionStatusChange: ((connected: boolean) => void) | null;
  onAuthError: ((err: Error) => void) | null;
}

type CloudSignalClientFactory = () => CloudSignalClientLike;

// ---------------------------------------------------------------------------
// CloudSignalPWA interface — matches @cloudsignal/pwa-sdk surface used here.
// ---------------------------------------------------------------------------

interface CloudSignalPWALike {
  initialize(): Promise<void>;
  registerForPush(): Promise<{ registrationId: string } | null | undefined>;
}

type CloudSignalPWAFactory = () => CloudSignalPWALike;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface TokenProvider {
  getExternalToken(): Promise<string>;
}

export interface CloudSignalTransportOptions {
  host: string;
  organizationId: string;
  tokenServiceUrl: string;
  instance: string;
  userId: string;
  codec: Codec;
  tokens: TokenProvider;
  /** Inject a factory function for the CloudSignalClient — used in tests. */
  ClientImpl?: unknown;
  /** Inject a factory function for the CloudSignalPWA — used in tests. */
  PwaImpl?: unknown;
  push?: {
    serviceUrl: string;
    serviceId: string;
    publishableKey?: string;
  };
}

// ---------------------------------------------------------------------------
// CloudSignalTransport
// ---------------------------------------------------------------------------

export class CloudSignalTransport implements Transport {
  private opts: CloudSignalTransportOptions;
  private csClient: CloudSignalClientLike | null = null;
  private status: TransportStatus = 'closed';
  /** Prevents infinite auth-error retry loops. Set to true after the first
   *  refresh attempt; cleared on a successful connect. */
  private authRetryUsed = false;
  /** Flag to distinguish user-initiated closes from network disconnects.
   *  Prevents emitting 'closed' twice when the user calls close(). */
  private closedByUser = false;

  private envelopeHandlers = new Set<(env: AnyEnvelope) => void>();
  private statusHandlers = new Set<(s: TransportStatus) => void>();
  private authErrorHandlers = new Set<(code: number) => void>();

  constructor(opts: CloudSignalTransportOptions) {
    this.opts = opts;
  }

  private get ctx(): CodecContext {
    return { instance: this.opts.instance, userId: this.opts.userId };
  }

  // -------------------------------------------------------------------------
  // Transport interface
  // -------------------------------------------------------------------------

  onEnvelope(h: (env: AnyEnvelope) => void): () => void {
    this.envelopeHandlers.add(h);
    return () => this.envelopeHandlers.delete(h);
  }

  onStatus(h: (s: TransportStatus) => void): () => void {
    this.statusHandlers.add(h);
    return () => this.statusHandlers.delete(h);
  }

  /** Register a handler that fires when the broker reports an auth failure.
   *  The numeric code mirrors common HTTP/MQTT reason codes (e.g. 401). */
  onAuthError(h: (code: number) => void): () => void {
    this.authErrorHandlers.add(h);
    return () => this.authErrorHandlers.delete(h);
  }

  async connect(): Promise<void> {
    this.authRetryUsed = false;
    this.closedByUser = false;
    await this.dial();
  }

  async send(env: AnyEnvelope): Promise<void> {
    if (!this.csClient || this.status !== 'open') {
      throw new Error('transport not open');
    }
    const ctx = this.ctx;
    const msgs = this.opts.codec.encode(env, ctx);
    for (const msg of msgs) {
      // #R10: AWAIT the publish so a broker/PUBACK failure becomes a send()
      // rejection. The app's outbox then keeps the durable row as retryable
      // (markSendFailed) and the history decorator skips synthesising
      // 'received' — instead of losing the message while the UI shows sent.
      await this.csClient.transmit(msg.topic, msg.payload, {
        qos: msg.qos ?? 0,
        retain: msg.retain ?? false,
      });
    }
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    this.csClient?.destroy();
    this.csClient = null;
    this.setStatus('closed');
  }

  // -------------------------------------------------------------------------
  // Push — optional; requires @cloudsignal/pwa-sdk + push config
  // -------------------------------------------------------------------------

  /** Register for push via @cloudsignal/pwa-sdk. Returns the registration id
   *  on success, null in all other cases (push not configured, sdk
   *  unavailable, user denied permission, etc.). The caller persists the id
   *  server-side — this method does not. */
  async enablePush(): Promise<string | null> {
    const pushCfg = this.opts.push;
    if (!pushCfg) return null;

    try {
      const pwa = await this.resolvePwaInstance(pushCfg);
      if (!pwa) return null;

      await pwa.initialize();
      const reg = await pwa.registerForPush();
      return reg?.registrationId ?? null;
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Internal
  // -------------------------------------------------------------------------

  private setStatus(s: TransportStatus): void {
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }

  private async resolveClientFactory(): Promise<CloudSignalClientFactory> {
    if (this.opts.ClientImpl) return this.opts.ClientImpl as CloudSignalClientFactory;
    // Dynamic import so the package stays optional in test environments that
    // don't have @cloudsignal/mqtt-client installed.
    const mod = await import('@cloudsignal/mqtt-client');
    const Ctor = (mod.CloudSignalClient ?? mod.default) as new (
      opts: Record<string, unknown>,
    ) => CloudSignalClientLike;
    return () =>
      new Ctor({
        tokenServiceUrl: this.opts.tokenServiceUrl,
        preset: 'desktop',
        enableOfflineQueue: false,
      });
  }

  private async resolvePwaInstance(
    pushCfg: NonNullable<CloudSignalTransportOptions['push']>,
  ): Promise<CloudSignalPWALike | null> {
    try {
      if (this.opts.PwaImpl) {
        const factory = this.opts.PwaImpl as CloudSignalPWAFactory;
        return factory();
      }
      const mod = await import('@cloudsignal/pwa-sdk');
      // Cast through unknown to avoid the shim's strict constructor signature
      // conflicting with our internal CloudSignalPWALike interface.
      const Ctor = mod.CloudSignalPWA as unknown as new (opts: Record<string, unknown>) => CloudSignalPWALike;
      return new Ctor({
        organizationId: this.opts.organizationId,
        organizationPublishableKey: pushCfg.publishableKey,
        serviceId: pushCfg.serviceId,
        serviceUrl: pushCfg.serviceUrl,
      });
    } catch {
      return null;
    }
  }

  private async dial(): Promise<void> {
    const makeClient = await this.resolveClientFactory();
    const client = makeClient();
    const ctx = this.ctx;

    // Wire auth-error callback BEFORE connectWithToken so we never miss it.
    client.onAuthError = (err: Error) => {
      void this.handleAuthError(err);
    };

    // Wire connection status callback to surface disconnects from the broker
    // (network drop, idle timeout, server kick, etc.). Skip if user initiated close.
    client.onConnectionStatusChange = (connected: boolean) => {
      if (!connected && !this.closedByUser && this.status !== 'closed') {
        this.setStatus('closed');
      } else if (connected && this.status === 'closed') {
        this.setStatus('open');
      }
    };

    // Obtain token
    const token = await this.opts.tokens.getExternalToken();

    // Build will params from codec
    const willMsg = this.opts.codec.will?.(ctx) ?? null;

    await client.connectWithToken({
      host: this.opts.host,
      organizationId: this.opts.organizationId,
      externalToken: token,
      ...(willMsg
        ? {
            willTopic: willMsg.topic,
            willMessage: willMsg.payload,
            willQos: (willMsg.qos ?? 1) as 0 | 1 | 2,
            willRetain: willMsg.retain ?? false,
          }
        : {}),
    });

    this.csClient = client;

    // Subscribe to codec topics
    const subs = this.opts.codec.subscriptions(ctx);
    for (const sub of subs) {
      await client.subscribe(sub.topic, sub.qos);
    }

    // Publish onConnect messages
    const onConnectMsgs = this.opts.codec.onConnect?.(ctx) ?? [];
    for (const msg of onConnectMsgs) {
      client.transmit(msg.topic, msg.payload, {
        qos: msg.qos ?? 0,
        retain: msg.retain ?? false,
      });
    }

    // Wire message handler
    client.onMessage((topic: string, message: string) => {
      const envelopes = this.opts.codec.decode(topic, message, ctx);
      for (const env of envelopes) {
        for (const h of this.envelopeHandlers) h(env);
      }
    });

    // A successful (re)connection resets the one-shot retry budget so that a
    // later, unrelated auth event gets a fresh attempt.
    this.authRetryUsed = false;
    this.setStatus('open');
  }

  private async handleAuthError(_err: Error): Promise<void> {
    if (this.authRetryUsed) {
      // Already retried once — give up to avoid infinite loops.
      // Surface the error to callers only now that the budget is exhausted.
      for (const h of this.authErrorHandlers) h(401);
      this.setStatus('closed');
      return;
    }

    this.authRetryUsed = true;

    // Tear down the current client
    this.csClient?.destroy();
    this.csClient = null;
    this.setStatus('closed');

    // Attempt ONE refresh + reconnect. If it succeeds, authRetryUsed is reset
    // inside dial() via the established path so a later auth event gets a
    // fresh retry budget.
    try {
      await this.dial();
      // Reconnect succeeded — the error was recoverable; do NOT fire handlers.
    } catch {
      // Retry also failed — surface the error to callers now.
      for (const h of this.authErrorHandlers) h(401);
      this.setStatus('closed');
    }
  }
}
