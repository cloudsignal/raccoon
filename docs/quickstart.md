# Raccoon quickstart (5 minutes)

Stand up a self-hosted chat backend for an AI agent: an installable PWA, QR
pairing, and a WebSocket transport — with **zero external services**. This
walks the two paths: bring your own agent (framework-neutral), or plug in an
existing OpenClaw agent.

Everything here uses only the published, vendor-neutral packages. No vendor
service or message broker is required (or referenced) anywhere in this guide.

## Install

v0.1 is distributed repo-first — the packages are not yet on the public npm
registry, and nothing here needs a registry account or token. Pack the gated
tarballs once, then install them in your own project (installed together they
resolve each other):

```bash
git clone https://github.com/cloudsignal/raccoon && cd raccoon
npm ci && npm run release:pack
# in your project:
npm i /path/to/raccoon/release-artifacts/raccoon-{protocol,transport-ws,bridge,pairing}-0.1.0.tgz
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
  userId: 'alice',
  instanceUrl: `ws://127.0.0.1:${port}/`,
});
console.log(qr);            // scan from the Raccoon PWA
console.log(token, payload); // or paste the payload manually
```

That is a complete, working backend. Point the PWA (below) at the URL, pair,
and chat. A `ws://127.0.0.1` instance URL only pairs a browser **on the same
machine** — to pair a real phone you need HTTPS/WSS on a reachable host; set
`instanceUrl` to your public `wss://` URL and see
[`examples/hosting/`](../examples/hosting/) for Railway / Cloudflare / Vercel
walkthroughs.

### Add the installable PWA

```bash
# same tarball flow as above:
npm i /path/to/raccoon/release-artifacts/raccoon-app-0.1.0.tgz
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

For the standalone, self-serving build (the hub serves the PWA on its own port),
either install `@raccoon/app` and serve its prebuilt `dist-standalone/`
(published in the package — no clone needed), or, from a monorepo clone, run
`npm run build:app` and serve the generated `packages/app/dist-standalone/`. Pass
that path as `staticDir` to the hub. See [`packages/app/README.md`](../packages/app/README.md).

## Path B — an existing OpenClaw agent

If your agent runs on [OpenClaw](https://openclaw.ai), install the first-party
connector as an OpenClaw plugin — no `AgentRunner` to write. v0.1 installs from
a clone:

```bash
git clone https://github.com/cloudsignal/raccoon && cd raccoon
npm ci && npm run build && npm run build:app
openclaw plugins install --link "$PWD/adapters/connector-openclaw"
```

Point `staticDir` at the PWA the clone just built. An OpenClaw gateway's
working directory is not your clone, so it must be an **absolute** path (a
relative path will not find the files at runtime):

```bash
export RACCOON_STATIC_DIR="$PWD/packages/app/dist-standalone"
```

The connector is a full OpenClaw channel plugin: it stands up the hub inside
the OpenClaw gateway, bridges Raccoon ↔ your agent, renders exec-approval
prompts as native approval cards, and ships a `raccoon pair` / `raccoon revoke`
CLI. See [`adapters/connector-openclaw/README.md`](../adapters/connector-openclaw/README.md)
for configuration and the setup wizard, and
[compatibility.md](compatibility.md) for the supported OpenClaw versions.

### Approve agent commands from your phone

Two switches make exec-approval cards live. `openclaw raccoon setup` flips the
first one for you (`approvals.exec` in `openclaw.json` — it forwards pending
approvals to the conversation that started the turn); if you configured the
channel by hand, add:

```json
{ "approvals": { "exec": { "enabled": true, "mode": "session" } } }
```

The second is OpenClaw's own exec-approval policy. With `ask: off` (the
default) OpenClaw never requests approval; whether a command runs or is
denied is decided entirely by the configured `security` policy. Set `ask` to
`on-miss` (or `always`) to be prompted:

```bash
echo '{"version":1,"defaults":{"security":"allowlist","ask":"on-miss"}}' \
  | openclaw approvals set --stdin
```

Now when the agent wants to run a command the policy does not pre-approve,
the chat shows a card with the full command and Allow Once / Allow Always /
Deny buttons; the tap resolves the approval and the agent's turn continues.

Authorization model: any Raccoon sender the channel admits (paired device +
`allowFrom`) is command-authorized, and OpenClaw lets a command-authorized
sender resolve any approval ID they know via a typed `/approve` command. Card
buttons are stricter: the tap-to-command mapping is scoped to the user the
card was sent to, so another user cannot resolve it by tapping. If a
multi-user deployment needs typed commands restricted too, gate approvals to
specific senders with OpenClaw's own `commands.allowFrom.raccoon` allowlist.

## Try the bundled demo

From a clone of the monorepo:

```bash
npm install
npm run build:app      # build the PWA once
npm run demo           # echo hub on http://127.0.0.1:8790/
# open the URL ON THE SAME MACHINE, paste the printed pairing payload into the
# setup screen, send "/draft" to see an approval card
```

The demo advertises a `ws://127.0.0.1` URL, so a phone can't reach it — it's a
same-machine demo. To pair a real phone, deploy behind HTTPS/WSS:
[`examples/hosting/`](../examples/hosting/) has Railway, Cloudflare, and
Vercel walkthroughs.

## Next

- [`examples/hosting/`](../examples/hosting/) — deploy with HTTPS/WSS on
  Railway, Cloudflare (Tunnel/Pages), or Vercel, and pair a real phone.
- [connector-authoring.md](connector-authoring.md) — the public ports a
  connector implements, the package-boundary diagram, and how a second
  connector (or a managed transport) plugs in without touching core.
- [security.md](security.md) — what Raccoon does and does **not** protect
  (TLS/WSS, transit encryption, and why this is not end-to-end encryption).
