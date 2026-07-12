# Raccoon quickstart (5 minutes)

Stand up a self-hosted chat backend for an AI agent: an installable PWA, QR
pairing, and a WebSocket transport — with **zero external services**. This
walks the two paths: bring your own agent (framework-neutral), or plug in an
existing OpenClaw agent.

Everything here uses only the published, vendor-neutral packages. No
CloudSignal, GTM, Supabase, or broker is required (or referenced) anywhere in
this guide.

## Install

```bash
npm install @raccoon/protocol @raccoon/transport-ws @raccoon/bridge @raccoon/pairing
```

Node ≥ 20.19 (or ≥ 22.12). All packages are ESM with emitted types.

## Path A — bring your own agent (framework-neutral)

The only thing you implement is an **`AgentRunner`**: run one user turn, yield
the reply as text deltas. Everything else (typing indicators, history, dedup,
acks) is handled by `RaccoonBridge`.

```ts
import { WsHub } from '@raccoon/transport-ws';
import { RaccoonBridge, InMemoryMessageStore, type AgentRunner } from '@raccoon/bridge';
import { issuePairing } from '@raccoon/pairing';

// 1. Your agent. Yield text; the bridge concatenates + delivers one message.
const runner: AgentRunner = {
  async *run(ctx) {
    yield `You said: ${ctx.text}`;
  },
};

// 2. Stand up a hub + bridge on a WebSocket port.
const hub = new WsHub({ instance: 'my-agent', channels: ['assistant'] });
const { port } = await hub.start();
const bridge = new RaccoonBridge({ hub, runner, store: new InMemoryMessageStore() });
bridge.start();

// 3. Pair a device: prints a QR + token the PWA scans.
const { qr, token, payload } = await issuePairing(hub, {
  userId: 'user:alice',
  instanceUrl: `ws://127.0.0.1:${port}/`,
});
console.log(qr);            // scan from the Raccoon PWA
console.log(token, payload); // or paste the payload manually
```

That is a complete, working backend. Point the PWA (below) at the URL, scan
the QR, and chat.

### Add the installable PWA

```bash
npm install @raccoon/app
```

The app is a React component tree you mount in your own shell. Host-embedding
(the transport is one you own and authenticate) looks like:

```tsx
import { App, TransportProvider, UpdateGate } from '@raccoon/app';
import '@raccoon/app/styles.css';

function Shell() {
  return (
    <TransportProvider makeTransport={(opts) => /* your Transport */}>
      <UpdateGate />
      <App />
    </TransportProvider>
  );
}
```

For the standalone, self-serving build (the hub serves the PWA on its own
port), run `npm run build:app` in the monorepo and pass the `dist-standalone/` path as
`staticDir` to the hub. See [`packages/app/README.md`](../packages/app/README.md).

## Path B — an existing OpenClaw agent

If your agent runs on [OpenClaw](https://openclaw.ai), install the first-party
connector instead of writing an `AgentRunner`:

```bash
npm install @raccoon/connector-openclaw
# openclaw is a peer dependency you already have
```

The connector is a full OpenClaw channel plugin: it stands up the hub inside
the OpenClaw gateway, bridges Raccoon ↔ your agent, renders exec-approval
prompts as native approval cards, and ships a `raccoon pair` / `raccoon revoke`
CLI. See [`adapters/connector-openclaw/README.md`](../adapters/connector-openclaw/README.md)
for configuration and the setup wizard, and
[compatibility.md](compatibility.md) for the supported OpenClaw versions.

## Try the bundled demo

From a clone of the monorepo:

```bash
npm install
npm run build:app      # build the PWA once
npm run demo           # echo hub on http://127.0.0.1:8790/
# open the URL, scan the printed QR, send "/draft" to see an approval card
```

## Next

- [connector-authoring.md](connector-authoring.md) — the public ports a
  connector implements, the package-boundary diagram, and how a second
  connector (or a managed transport) plugs in without touching core.
- [security.md](security.md) — what Raccoon does and does **not** protect
  (TLS/WSS, transit encryption, and why this is not end-to-end encryption).
