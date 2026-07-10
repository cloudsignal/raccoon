import { InMemoryMessageStore, RaccoonBridge, type AgentContext } from '@raccoon/bridge';
import { issuePairing } from '@raccoon/pairing';
import { createEnvelope, userAddress } from '@raccoon/protocol';
import { generateVapidKeys, InMemorySubscriptionStore, VapidPushSender, withPushFallback } from '@raccoon/push';
import { WsHub } from '@raccoon/transport-ws';

export interface DemoOptions {
  port?: number;
  host?: string;
  staticDir?: string;
  push?: boolean;
}

const echoRunner = {
  async *run(ctx: AgentContext): AsyncIterable<string> {
    yield `echo: ${ctx.text}`;
  },
};

export async function startDemo(opts: DemoOptions = {}) {
  const push = opts.push ? generateVapidKeys() : null;
  const hub = new WsHub({
    instance: 'echo-demo',
    channels: ['echo'],
    host: opts.host,
    port: opts.port ?? 8790,
    staticDir: opts.staticDir,
    ...(push ? { vapidPublicKey: push.publicKey } : {}),
  });

  const bridgeHub = push
    ? withPushFallback(hub, {
        store: new InMemorySubscriptionStore(),
        sender: new VapidPushSender({ ...push, subject: 'mailto:demo@raccoon.example' }),
      }).hub
    : hub;

  const bridge = new RaccoonBridge({ hub: bridgeHub, runner: echoRunner, store: new InMemoryMessageStore() });
  const stopBridge = bridge.start();

  // Approval demo: "/draft" produces an approval card; responses get confirmations.
  const stopApprovals = bridgeHub.onEnvelope((env, userId) => {
    const to = userAddress(userId);
    if (env.kind === 'msg' && env.payload.text === '/draft') {
      bridgeHub.sendToUser(userId, createEnvelope('approval.request', {
        from: 'agent:echo', to, channel: env.channel,
        payload: {
          refId: env.id,
          title: 'Assistant · draft reply',
          description: 'We run Raccoon next to Mosquitto in our lab, happy to share our bridge config if useful.',
          options: ['approve', 'edit', 'skip'],
        },
      }));
    }
    if (env.kind === 'approval.response') {
      const text = env.payload.choice === 'edit' && env.payload.editedText
        ? `Edited: ${env.payload.editedText}`
        : env.payload.choice === 'skip'
          ? 'Skipped.'
          : `Approved: ${env.payload.choice}`;
      bridgeHub.sendToUser(userId, createEnvelope('msg', {
        from: 'agent:echo', to, channel: env.channel, payload: { text },
      }));
    }
  });

  const { port } = await hub.start();

  return {
    hub,
    port,
    pair: (userId: string) => issuePairing(hub, { userId, instanceUrl: `ws://127.0.0.1:${port}/` }),
    stop: async () => {
      stopApprovals();
      stopBridge();
      await hub.stop();
    },
  };
}
