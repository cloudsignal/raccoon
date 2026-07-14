// A deployable Raccoon hub: WebSocket hub + the prebuilt PWA + optional Web
// Push, configured entirely through environment variables. This is the server
// the Railway / Cloudflare / Vercel hosting examples deploy.
//
// It answers with a trivial echo agent so a fresh deployment is immediately
// testable end-to-end. To serve a real agent, replace `runner` with your own
// AgentRunner — or skip this server entirely and use the OpenClaw connector
// (@raccoon/connector-openclaw), which embeds the same hub in the OpenClaw
// gateway.
//
// Environment:
//   PORT                  bind port                       (default 8790; Railway injects this)
//   HOST                  bind host                       (default 0.0.0.0)
//   RACCOON_INSTANCE_URL  PUBLIC ws(s):// URL clients dial — REQUIRED to pair a
//                         real phone (e.g. wss://raccoon.example.com/).
//                         Defaults to ws://127.0.0.1:$PORT/ (same-machine only).
//   RACCOON_INSTANCE      instance display name           (default 'raccoon')
//   RACCOON_CHANNELS      CSV of channel names            (default 'coordinator')
//   RACCOON_STORE_PATH    directory for the session store (default ./data;
//                         point it at a persistent volume in production)
//   PAIR_USER             if set, prints a pairing QR + payload for this user
//                         id on boot (grab it from the deploy logs)
//   VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT
//                         enable Web Push. Mint keys once with:
//                         node -e "console.log(JSON.stringify(require('@raccoon/push').generateVapidKeys()))"
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';

import { InMemoryMessageStore, RaccoonBridge } from '@raccoon/bridge';
import { issuePairing } from '@raccoon/pairing';
import { InMemorySubscriptionStore, VapidPushSender, withPushFallback } from '@raccoon/push';
import { FileCredentialStore, WsHub } from '@raccoon/transport-ws';

const require = createRequire(import.meta.url);

const port = Number(process.env.PORT ?? 8790);
const host = process.env.HOST ?? '0.0.0.0';
const instance = process.env.RACCOON_INSTANCE ?? 'raccoon';
const channels = (process.env.RACCOON_CHANNELS ?? 'coordinator').split(',').map((c) => c.trim()).filter(Boolean);
const storeDir = resolve(process.env.RACCOON_STORE_PATH ?? './data');

// The prebuilt PWA ships inside @raccoon/app — resolve an ABSOLUTE path (the
// process cwd is not necessarily the install dir).
const staticDir = join(dirname(require.resolve('@raccoon/app/package.json')), 'dist-standalone');

// Durable sessions: survive restarts/redeploys as long as storeDir persists.
mkdirSync(storeDir, { recursive: true });
const store = new FileCredentialStore({ path: join(storeDir, 'sessions.json') });

const vapid = process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY
  ? {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY,
      subject: process.env.VAPID_SUBJECT ?? 'mailto:admin@example.com',
    }
  : null;

const hub = new WsHub({
  instance,
  channels,
  host,
  port,
  store,
  staticDir,
  ...(vapid ? { vapidPublicKey: vapid.publicKey } : {}),
});

// With VAPID configured, agent messages fall back to Web Push when the user
// has no live socket (i.e. the app is closed).
const bridgeHub = vapid
  ? withPushFallback(hub, {
      store: new InMemorySubscriptionStore(),
      sender: new VapidPushSender(vapid),
    }).hub
  : hub;

// Placeholder agent so the deployment is testable — swap in your own runner.
// (The bridge addresses replies as `agent:<channel>` automatically.)
const runner = {
  async *run(ctx) {
    yield `echo from ${instance}: ${ctx.text}`;
  },
};
const bridge = new RaccoonBridge({ hub: bridgeHub, runner, store: new InMemoryMessageStore() });
const stopBridge = bridge.start();

const { port: boundPort } = await hub.start();
const instanceUrl = process.env.RACCOON_INSTANCE_URL ?? `ws://127.0.0.1:${boundPort}/`;

console.log(`raccoon hub up`);
console.log(`  listening : http://${host}:${boundPort}/  (PWA + WebSocket)`);
console.log(`  instance  : ${instance}  channels: ${channels.join(', ')}`);
console.log(`  public URL: ${instanceUrl}${instanceUrl.startsWith('ws://127.') ? '  (same-machine only — set RACCOON_INSTANCE_URL to your wss:// URL to pair a phone)' : ''}`);
console.log(`  sessions  : ${join(storeDir, 'sessions.json')}`);
console.log(`  web push  : ${vapid ? 'enabled (VAPID)' : 'disabled (set VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY to enable)'}`);

if (process.env.PAIR_USER) {
  const { qr, payload } = await issuePairing(hub, { userId: process.env.PAIR_USER, instanceUrl });
  console.log(`\npairing for user '${process.env.PAIR_USER}' (single-use, expires in ~5 minutes):\n`);
  console.log(qr);
  console.log(`\nor paste the payload into the app's setup screen:\n${payload}\n`);
}

async function shutdown() {
  stopBridge();
  await hub.stop();
  await store.close?.();
  process.exit(0);
}
process.on('SIGINT', () => { void shutdown(); });
process.on('SIGTERM', () => { void shutdown(); });
