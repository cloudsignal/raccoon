import { WsHub } from '@raccoon/transport-ws';
import { InMemoryMessageStore, RaccoonBridge, type AgentRunner } from '@raccoon/bridge';
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
  /** Enable self-hosted web-push for offline delivery. */
  vapid?: { publicKey: string; privateKey: string; subject: string };
}

/** The object returned by createRaccoonChannel — a started/stoppable WsHub +
 *  RaccoonBridge with pairing helpers. */
export interface RaccoonAgentChannel {
  hub: WsHub;
  bridge: RaccoonBridge;
  start(): Promise<{ port: number }>;
  stop(): Promise<void>;
  pair(userId: string): ReturnType<typeof issuePairing>;
  revoke(userId: string): ReturnType<typeof revokePairing>;
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
    vapidPublicKey: opts.vapid?.publicKey,
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

  const bridge = new RaccoonBridge({ hub: bridgeHub, runner: opts.runner, store: new InMemoryMessageStore() });

  let stopBridge: (() => void) | null = null;

  return {
    hub,
    bridge,
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
    },
    /** Issue a pairing QR for a user — used by the CLI. */
    pair: (userId: string) => issuePairing(hub, { userId, instanceUrl: opts.instanceUrl }),
    // Revoking a user must also drop their push subscriptions: otherwise a
    // revoked user's device still gets push-delivered notifications (via
    // withPushFallback's offline fallback) even though their pairing and
    // live sockets are gone.
    revoke: async (userId: string) => {
      await revokePairing(hub, userId);
      await clearPushForUser?.(userId);
    },
    buildId: opts.buildId ?? 'dev',
  };
}
