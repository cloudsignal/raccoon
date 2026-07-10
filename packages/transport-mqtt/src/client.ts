import type { AnyEnvelope, Transport, TransportStatus, Codec, CodecContext } from '@raccoon/protocol';

type MqttClientLike = {
  on(event: 'connect', cb: () => void): MqttClientLike;
  on(event: 'message', cb: (topic: string, payload: Buffer) => void): MqttClientLike;
  on(event: 'error', cb: (err: Error) => void): MqttClientLike;
  on(event: 'close', cb: () => void): MqttClientLike;
  subscribe(topic: string, opts: { qos: number }, cb?: (err: Error | null) => void): MqttClientLike;
  publish(
    topic: string,
    payload: string,
    opts: { qos: number; retain: boolean },
    cb?: (err?: Error | null) => void,
  ): MqttClientLike;
  end(): void;
};

type MqttConnectFn = (url: string, opts: object) => MqttClientLike;

export interface MqttTransportOptions {
  url: string;
  username?: string;
  password?: string;
  instance: string;
  userId: string;
  codec: Codec;
  MqttImpl?: unknown;
  maxBackoffMs?: number;
}

export class MqttTransport implements Transport {
  private opts: MqttTransportOptions;
  private mqttClient: MqttClientLike | null = null;
  private status: TransportStatus = 'closed';
  private closedByUser = false;
  private everOpened = false;
  private backoffMs = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private suppressReconnect = false;

  private envelopeHandlers = new Set<(env: AnyEnvelope) => void>();
  private statusHandlers = new Set<(s: TransportStatus) => void>();

  constructor(opts: MqttTransportOptions) {
    this.opts = opts;
  }

  private get ctx(): CodecContext {
    return { instance: this.opts.instance, userId: this.opts.userId };
  }

  onEnvelope(h: (env: AnyEnvelope) => void): () => void {
    this.envelopeHandlers.add(h);
    return () => this.envelopeHandlers.delete(h);
  }

  onStatus(h: (s: TransportStatus) => void): () => void {
    this.statusHandlers.add(h);
    return () => this.statusHandlers.delete(h);
  }

  private setStatus(s: TransportStatus): void {
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    this.suppressReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    await this.dial();
  }

  private async resolveMqttConnect(): Promise<MqttConnectFn> {
    if (this.opts.MqttImpl) return this.opts.MqttImpl as MqttConnectFn;
    const mod = await import('mqtt');
    return (mod.default?.connect ?? (mod as unknown as { connect: MqttConnectFn }).connect) as MqttConnectFn;
  }

  private async dial(): Promise<void> {
    const mqttConnect = await this.resolveMqttConnect();
    const ctx = this.ctx;
    const willMsg = this.opts.codec.will?.(ctx) ?? null;

    const connectOpts: Record<string, unknown> = {
      username: this.opts.username,
      password: this.opts.password,
    };

    if (willMsg) {
      connectOpts['will'] = {
        topic: willMsg.topic,
        payload: willMsg.payload,
        qos: willMsg.qos ?? 1,
        retain: willMsg.retain ?? false,
      };
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const client = mqttConnect(this.opts.url, connectOpts);
      this.mqttClient = client;
      this.setStatus('connecting');

      client.on('connect', () => {
        // Subscribe to codec topics
        const subs = this.opts.codec.subscriptions(ctx);
        for (const sub of subs) {
          client.subscribe(sub.topic, { qos: sub.qos });
        }

        // Publish onConnect messages if any
        const onConnectMsgs = this.opts.codec.onConnect?.(ctx) ?? [];
        for (const msg of onConnectMsgs) {
          client.publish(msg.topic, msg.payload, { qos: msg.qos ?? 0, retain: msg.retain ?? false });
        }

        this.everOpened = true;
        this.backoffMs = 500;
        this.setStatus('open');

        if (!settled) {
          settled = true;
          resolve();
        }
      });

      client.on('message', (topic: string, payload: Buffer) => {
        const envelopes = this.opts.codec.decode(topic, payload.toString(), ctx);
        for (const env of envelopes) {
          for (const h of this.envelopeHandlers) h(env);
        }
      });

      client.on('error', (err: Error) => {
        if (err.message.toLowerCase().includes('not authorized')) {
          this.suppressReconnect = true;
        }
        if (!settled) {
          settled = true;
          reject(err);
        }
      });

      client.on('close', () => {
        this.mqttClient = null;

        if (!settled) {
          settled = true;
          reject(new Error('connection closed during handshake'));
          return;
        }

        if (this.closedByUser || this.suppressReconnect || this.status === 'closed') return;
        this.setStatus('closed');
        if (this.everOpened) this.scheduleReconnect();
      });
    });
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser || this.suppressReconnect) return;
      void this.dial().catch(() => {});
    }, delay);
  }

  async send(env: AnyEnvelope): Promise<void> {
    if (!this.mqttClient || this.status !== 'open') {
      throw new Error('transport not open');
    }
    const ctx = this.ctx;
    const msgs = this.opts.codec.encode(env, ctx);
    for (const msg of msgs) {
      this.mqttClient.publish(msg.topic, msg.payload, { qos: msg.qos ?? 0, retain: msg.retain ?? false });
    }
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.mqttClient?.end();
    this.mqttClient = null;
    this.setStatus('closed');
  }
}
