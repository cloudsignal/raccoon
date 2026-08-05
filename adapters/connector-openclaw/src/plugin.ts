import { ulid } from 'ulid';
import { WsHub, type CredentialStore } from '@raccoon/transport-ws';
import { InMemoryMessageStore, RaccoonBridge, type AgentRunner, type MessageStore } from '@raccoon/bridge';
import type { AnyEnvelope } from '@raccoon/protocol';
import { issuePairing, revokePairing } from '@raccoon/pairing';
import { InMemorySubscriptionStore, VapidPushSender, withPushFallback } from '@raccoon/push';

export interface RaccoonChannelOptions {
  instance: string;
  /** Public ws URL the PWA dials, encoded into the pairing QR. */
  instanceUrl: string;
  host?: string;
  port?: number;
  channels: string[];
  /**
   * The agent runner that handles one user turn. Task 7 wires the REAL
   * runner (buildRaccoonInboundRunner) here — the previous `invokeAgent`
   * placeholder-echo indirection (OpenClawAgentRunner) has been removed.
   */
  runner: AgentRunner;
  buildId?: string;
  /** Serve the built @raccoon/app (dist/) on the same port. */
  staticDir?: string;
  /**
   * Directory for uploaded media blobs — forwarded to the WsHub's media
   * store. Hosts with a per-account store path (the gateway) pass
   * `<storePath>/media`; when absent the hub falls back to its cwd-relative
   * default (`<cwd>/.raccoon-store/media`).
   */
  mediaDir?: string;
  /** Enable self-hosted web-push for offline delivery. */
  vapid?: { publicKey: string; privateKey: string; subject: string };
  /**
   * Session/credential store backing pairing + resume. Defaults to the WsHub's
   * in-memory store, which does NOT survive a connector restart — every paired
   * PWA must re-pair after the process bounces. Supply a persistent
   * CredentialStore (any impl of the interface) so confirmed sessions survive a
   * restart and reconnecting clients resume rather than re-pair. Session
   * durability is the deployment's responsibility (v0.1 ships no file-backed
   * default); see docs/connector-authoring.md.
   */
  sessionStore?: CredentialStore;
}

/** The object returned by createRaccoonChannel — a started/stoppable WsHub +
 *  RaccoonBridge with pairing helpers. */
export interface RaccoonAgentChannel {
  hub: WsHub;
  bridge: RaccoonBridge;
  /** The channel's own message store (in-memory v1) — exposed so hosts and
   *  tests can read history without reaching into the bridge's internals. */
  store: MessageStore;
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  pair(userId: string): ReturnType<typeof issuePairing>;
  revoke(userId: string): ReturnType<typeof revokePairing>;
  /** Agent-initiated sends (outbound replies, approval cards). Records 'msg'
   *  envelopes in the message store (history) and permanent-references their
   *  attachments, then sends through the push-wrapped hub. Returns whether a
   *  live socket took it (push fallback may still deliver when false). */
  sendAgentEnvelope(userId: string, env: AnyEnvelope): Promise<boolean>;
  buildId: string;
}

/** Reusable wiring: stand up a WsHub + RaccoonBridge backed by the given
 *  AgentRunner. Framework-neutral apart from the runner. */
export function createRaccoonChannel(opts: RaccoonChannelOptions): RaccoonAgentChannel {
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
    // R4-5: clearForUser (not a direct store.clear() call) — see its
    // doc comment in fallback.ts for why the serialization matters.
    clearPushForUser = wrapped.clearForUser;
  }

  // media: the hub's OWN store (Task 4 seam) — the bridge permanently
  // references a message's attachments after its durable append, so the
  // store's sweep never deletes blobs a recorded message points at.
  const store = new InMemoryMessageStore();
  const bridge = new RaccoonBridge({ hub: bridgeHub, runner: opts.runner, store, media: hub.media });

  let stopBridge: (() => void) | null = null;

  return {
    hub,
    bridge,
    store,
    async start(): Promise<{ port: number }> {
      const { port } = await hub.start();
      stopBridge = bridge.start();
      return { port };
    },
    async stop(): Promise<void> {
      stopBridge?.();
      stopBridge = null;
      stopPush?.();
      stopPush = null;
      await hub.stop();
      // Release the session store's exclusive resources (e.g. a FileCredentialStore
      // file lock) so a restart on the same store path can re-acquire it.
      await opts.sessionStore?.close?.();
    },
    /** Issue a pairing QR for a user — used by the CLI. */
    pair: (userId: string) => issuePairing(hub, { userId, instanceUrl: opts.instanceUrl }),
    // Revoking a user must also drop their push subscriptions: otherwise a
    // revoked user's device still gets push-delivered notifications (via
    // withPushFallback's offline fallback) even though their pairing and
    // live sockets are gone.
    revoke: async (userId: string) => {
      // #R6-6b: raise the push revocation fence BEFORE tearing down the
      // pairing. clearForUser marks the user revoking SYNCHRONOUSLY (before
      // the returned promise), so calling it first means any push delivery
      // triggered by revokePairing() closing the user's live sockets (a final
      // buffered message finding no socket → offline push path) is already
      // fenced. Awaiting hub revocation before starting push cleanup — the
      // old order — left exactly that window open.
      const pushCleared = clearPushForUser?.(userId) ?? Promise.resolve();
      await revokePairing(hub, userId);
      await pushCleared;
    },
    // Agent-initiated sends: history + media reference + push-wrapped hub —
    // the same seam shape as connector-nanoclaw's sendAgentEnvelope (each
    // connector owns its copy; see docs/connector-authoring.md "Record
    // agent-initiated sends"). A false return means no live socket took it —
    // push fallback (when configured) may still deliver; the message is in
    // history either way.
    async sendAgentEnvelope(userId: string, env: AnyEnvelope): Promise<boolean> {
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
    buildId: opts.buildId ?? 'dev',
  };
}
