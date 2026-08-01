import { ulid } from 'ulid';
import { WsHub, type CredentialStore } from '@raccoon/transport-ws';
import { InMemoryMessageStore, RaccoonBridge, type AgentRunner, type MessageStore } from '@raccoon/bridge';
import type { AnyEnvelope } from '@raccoon/protocol';
import { issuePairing, revokePairing } from '@raccoon/pairing';
import { InMemorySubscriptionStore, VapidPushSender, withPushFallback } from '@raccoon/push';

export interface RaccoonEndpointOptions {
  instance: string;
  /** Public ws URL the PWA dials, encoded into the pairing QR. */
  instanceUrl: string;
  host?: string;
  port?: number;
  channels: string[];
  runner: AgentRunner;
  /** Serve the built @raccoon/app (dist/) on the same port. */
  staticDir?: string;
  /** Directory for uploaded media blobs — forwarded to the WsHub's media store. */
  mediaDir?: string;
  /** Enable self-hosted web-push for offline delivery. */
  vapid?: { publicKey: string; privateKey: string; subject: string };
  /** Session/credential store backing pairing + resume. Defaults to the WsHub's
   *  in-memory store, which does NOT survive a restart. */
  sessionStore?: CredentialStore;
  /** Bridge-side turn deadline. MUST exceed the connector's park timeout so
   *  the bridge never times out first (its timeout acks 'stalled' to the
   *  client, defeating the connector's silent async fallback). The adapter
   *  passes turnTimeoutMs + 30_000. */
  turnDeadlineMs?: number;
}

export interface RaccoonEndpoint {
  hub: WsHub;
  bridge: RaccoonBridge;
  /** The endpoint's own message store (in-memory v1) — exposed so hosts and
   *  tests can read history without reaching into the bridge's internals. */
  store: MessageStore;
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  pair(userId: string): ReturnType<typeof issuePairing>;
  revoke(userId: string): Promise<void>;
  /** Adapter-initiated sends (async fallback, cards, files). Records 'msg'
   *  envelopes in the message store (history) and permanent-references their
   *  attachments, then sends through the push-wrapped hub. Returns whether a
   *  live socket took it (push fallback may still deliver when false). */
  sendAgentEnvelope(userId: string, env: AnyEnvelope): Promise<boolean>;
}

/** Replicates connector-openclaw's createRaccoonChannel composition (each
 *  connector owns its copy — connectors never depend on each other), extended
 *  with turnDeadlineMs passthrough and the sendAgentEnvelope outbound seam.
 *  Keep the push-revocation fence ordering: clearForUser BEFORE revokePairing. */
export function createRaccoonEndpoint(opts: RaccoonEndpointOptions): RaccoonEndpoint {
  const hub = new WsHub({
    instance: opts.instance,
    host: opts.host,
    port: opts.port,
    channels: opts.channels,
    staticDir: opts.staticDir,
    mediaDir: opts.mediaDir,
    vapidPublicKey: opts.vapid?.publicKey,
    // Only override the WsHub's in-memory default when a store is supplied, so
    // an omitted sessionStore keeps the built-in (undefined would not).
    ...(opts.sessionStore ? { store: opts.sessionStore } : {}),
  });

  let stopPush: (() => void) | null = null;
  let bridgeHub: Pick<WsHub, 'sendToUser' | 'onEnvelope'> = hub;
  let clearPushForUser: ((userId: string) => Promise<void>) | null = null;
  if (opts.vapid) {
    const wrapped = withPushFallback(hub, {
      store: new InMemorySubscriptionStore(),
      sender: new VapidPushSender(opts.vapid),
    });
    bridgeHub = wrapped.hub;
    stopPush = wrapped.stop;
    clearPushForUser = wrapped.clearForUser;
  }

  const store = new InMemoryMessageStore();
  const bridge = new RaccoonBridge({
    hub: bridgeHub,
    runner: opts.runner,
    store,
    media: hub.media,
    ...(opts.turnDeadlineMs !== undefined ? { turnDeadlineMs: opts.turnDeadlineMs } : {}),
  });

  let stopBridge: (() => void) | null = null;

  return {
    hub,
    bridge,
    store,
    async start() {
      const { port } = await hub.start();
      stopBridge = bridge.start();
      return { port };
    },
    async stop() {
      stopBridge?.();
      stopBridge = null;
      stopPush?.();
      stopPush = null;
      await hub.stop();
      // Release the session store's exclusive resources (e.g. a FileCredentialStore
      // file lock) so a restart on the same store path can re-acquire it.
      await opts.sessionStore?.close?.();
    },
    pair: (userId) => issuePairing(hub, { userId, instanceUrl: opts.instanceUrl }),
    // Push-revocation fence: clearForUser marks the user revoking SYNCHRONOUSLY
    // before its promise resolves, so any push triggered by revokePairing()
    // closing the user's live sockets is already fenced.
    revoke: async (userId) => {
      const pushCleared = clearPushForUser?.(userId) ?? Promise.resolve();
      await revokePairing(hub, userId);
      await pushCleared;
    },
    /** Adapter-initiated sends: history + media reference + push-wrapped hub.
     *  A false return means no live socket took it — push fallback (when
     *  configured) may still deliver; the message is in history either way. */
    async sendAgentEnvelope(userId, env) {
      if (env.kind === 'msg') {
        const payload = env.payload;
        if (payload.attachments && payload.attachments.length > 0) {
          await hub.media.reference(payload.attachments.map((a) => a.url));
        }
        await store.append({
          id: env.id.length > 0 ? env.id : ulid(),
          channel: env.channel,
          userId,
          role: 'agent',
          text: payload.text,
          ts: env.ts,
          ...(payload.attachments ? { attachments: payload.attachments } : {}),
        });
      }
      return bridgeHub.sendToUser(userId, env);
    },
  };
}
