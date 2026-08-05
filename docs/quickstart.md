# Raccoon quickstart (5 minutes)

Stand up a self-hosted chat backend for an AI agent: an installable PWA, QR
pairing, and a WebSocket transport - with **zero external services**. This
walks the two paths: bring your own agent (framework-neutral), or plug in an
existing OpenClaw agent.

Everything here uses only the published, vendor-neutral packages. No vendor
service or message broker is required (or referenced) anywhere in this guide.

## Install

v0.1 is distributed repo-first - the packages are not yet on the public npm
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

## Path A - bring your own agent (framework-neutral)

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
machine** - to pair a real phone you need HTTPS/WSS on a reachable host; set
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

`makeTransport` replaces the built-in WebSocket transport factory (the
registry's `ws` slot); the QR-pairing flow still runs, but connections go
through your transport. To support **additional** transport kinds, register
per-kind factories with the `transports` prop:

```tsx
<TransportProvider transports={{ mykind: (opts) => new MyTransport(opts) }}>
```

The pairing QR's `transport` field selects the factory at scan time; `ws` is
built in. A stored pairing whose kind has no registered factory stays listed
but offline - its history remains readable and its sends queue until a build
that registers the kind loads.

For the standalone, self-serving build (the hub serves the PWA on its own port),
either install `@raccoon/app` and serve its prebuilt `dist-standalone/`
(published in the package - no clone needed), or, from a monorepo clone, run
`npm run build:app` and serve the generated `packages/app/dist-standalone/`. Pass
that path as `staticDir` to the hub. See [`packages/app/README.md`](../packages/app/README.md).

### Pair a second platform

The app holds any number of pairings at once - two instances of your own
agent, or your agent plus a second platform entirely. Conversations from
every pairing appear in one list, grouped into per-platform sections by
default (a flat merged layout is available - see the config section below),
and each pairing keeps its own connection status (the chat header shows
which instance a conversation belongs to).

Manage pairings in **Settings → Platforms**: each one is listed with its
live status and can be renamed, given its own accent color and marker,
rescanned, or unpaired, and **Add platform** starts the same QR/paste flow
used for the first pairing. A successful scan lands on a confirmation
screen that says what actually happened - a **new** pairing, or an existing
one **reconnected** (re-scanning a platform you already have refreshes its
credentials in place instead of duplicating it); failures get a typed
explanation with a retry. Installs that embed the app with a host-managed
transport hide "Add platform" - the host application owns identity there.

### Tune the multi-platform surface (raccoon.config.json)

The app's build-time config (`raccoon.config.json` in `@raccoon/app`) has
four optional fields for multi-platform installs. All of them are optional -
the defaults are what most installs want:

```json
{
  "listLayout": "grouped",
  "mergedSuffix": "collision",
  "platformBranding": {
    "alpha": { "glyph": "sparkle", "label": "Alpha" }
  },
  "hostManaged": {
    "banner": "Managed by the host application",
    "renameNote": "Set by the host application",
    "logoutLabel": "Log out"
  }
}
```

- `listLayout` - `"grouped"` (default) renders per-platform sections in the
  conversation list; `"merged"` renders one flat, recency-sorted list with a
  per-platform accent dot on each avatar.
- `mergedSuffix` - when a merged-list row also carries the platform name
  after the agent label: `"collision"` (default) only when two platforms
  expose a same-named channel, `"always"` on every row, `"badge"` never (the
  accent dot alone distinguishes platforms). Ignored in grouped layout.
- `platformBranding` - per-instance glyph overrides, keyed by the instance
  name from the pairing grant. `glyph` is a built-in marker id (`bot`,
  `server`, `home`, `sparkle`) or an inline SVG path d-string; `label` is an
  optional display name. A branded instance hides the user-facing marker
  picker on its detail screen.
- `hostManaged` - copy overrides for installs embedding the app with a
  host-managed transport, where the host owns identity: the banner shown on
  the Platforms screen, the note explaining why rename is disabled, and the
  label on the logout action. Unset fields fall back to the neutral defaults
  shown above.

Like the rest of the config, these are baked at build time - rebuild the app
after editing.

### Grant changes reach paired devices automatically

When your hub's channel grant changes - you add an agent, retire one, or
start advertising a web-push key - paired devices pick the change up without
re-pairing. The transport's session-resume acknowledgment re-delivers the
same grant fields a pairing delivers (instance name, channels, optional
`vapidPublicKey`), and the app applies them to the stored pairing on every
successful reconnect.

For hub implementers: hubs upgrading `@raccoon/transport-ws` automatically
advertise channel changes on reconnect - the extended resume acknowledgment
is built into the hub, with no code changes on your side. A device talking
to an older hub (bare `{ ok, userId }` resume reply) simply keeps its stored
grant until it pairs again.

On the device this produces the **new-agent moment**: a channel granted
since the last connection surfaces at the top of the conversation list with
a NEW badge (and a one-line notice) until it is first opened; channels
removed from the grant leave the list. Users can also force a refresh
without waiting for a reconnect - **Rescan** on a platform's detail screen
bounces that platform's connection and re-applies the current grant on the
spot. Rescan is refused while the platform is offline, and is not offered on
host-managed installs (the host owns the connection lifecycle).

Known v1 limitation: attachments are single-instance. The app has one upload
origin - the instance that serves it - and uploads authenticate with the
active conversation's pairing token, so sending files only works in
conversations belonging to that pairing. In a secondary pairing's
conversations uploads fail, and inbound attachments that use relative
`/media/...` URLs resolve against the serving origin and will not load. Text
messaging across pairings is unaffected.

### Identify your instance in push payloads

The app registers its one browser push subscription with every paired
instance, so any of them can notify the device. If you send push from your
hub (for example via a custom `notify` on `withPushFallback` from
`@raccoon/push`), set the optional `instance` field on the payload so
notifications from different platforms stay distinguishable:

```ts
const payload: PushPayload = {
  title: 'Atlas',
  body: 'Draft is ready for review.',
  data: { channel: 'assistant' },
  instance: { name: 'alpha', instanceUrl: 'wss://example.com/', userId: 'alice' },
};
```

The app titles the notification "Atlas · alpha", keeps a per-pairing
collapse key (so two instances exposing same-named channels do not replace
each other's notifications), and routes the tap to the matching
conversation. `userId` is required inside `instance` for unambiguous
routing - two pairings may point at the same instance URL as different
users. Payloads that omit `instance` degrade gracefully: un-suffixed title,
and a tap opens the app's conversation list.

Echo the pairing QR's `instanceUrl` **verbatim** in `instance.instanceUrl`:
the client matches it byte-for-byte against the stored pairing when routing
a tap, and any difference (even an added trailing slash) silently falls
back to opening the merged conversation list instead of the conversation.

Note that `instance` is self-declared by the pushing instance: it is a
labeling and routing hint, not an authenticated identity, so an instance can
mislabel its notifications - do not treat notification titles as trust
signals.

## Hosted platforms - the universal pairing contract

Everything above assumes the runtime connection is a plain WebSocket to the
hub that issued the QR. A hosted platform is different: its runtime transport
is a managed messaging service that needs per-session credentials the QR
cannot carry. Universal pairing keeps the user experience identical - scan a
QR, chat - by splitting pairing from the runtime dial. This section is the
contract a platform implements.

### Pairing is always the WebSocket handshake

Whatever the pairing payload's `transport` field says, the app pairs by
dialing the payload's `instanceUrl` over WebSocket and running the standard
Raccoon handshake (`pair.request` → `pair.grant` → `pair.confirm` →
`pair.confirmed`). The `transport` kind selects only the **runtime**
transport, dialed after the handshake completes. Consequences:

- A platform whose runtime transport is not a raw WebSocket still exposes a
  **WS pairing endpoint** - a small HTTPS/WSS endpoint that speaks the
  handshake, validates the one-time token, and issues the grant. The
  `@raccoon/transport-ws` hub already implements the handshake; a platform
  can also speak the four envelopes directly - the pairing payload schemas
  live in `@raccoon/protocol`'s `envelope.ts`. For where a pairing endpoint
  sits in the package architecture, see
  [connector-authoring.md](connector-authoring.md).
- For the built-in `ws` kind nothing changes: the pairing socket **is** the
  runtime connection.
- For any other kind, the app closes the handshake socket after
  `pair.confirmed` and dials the runtime transport from the stored pairing.
- A pairing whose kind has no registered runtime factory still pairs
  successfully - it is listed offline until a build that registers the kind
  loads. A missing runtime is not a pairing error.

### The grant's `transportConfig` blob

`pair.grant` carries an optional `transportConfig` field: an opaque,
JSON-safe blob the protocol does not interpret. Its shape is defined
entirely by the transport kind. The app persists it with the pairing and
hands it - untouched - to the kind's registry factory on every dial (both
the post-pairing dial and every later boot). Rules:

- The blob is **per-kind**: the factory registered for the pairing's
  `transport` kind is the only consumer, and it validates the shape itself.
- Re-pairing (or a refresh grant) replaces the stored blob; a refresh grant
  **without** a `transportConfig` clears a stale one.
- A malformed blob must never break pairing or boot: the factory throws, the
  app catches, and the platform is listed offline. Degrade, don't fail.

### The built-in `cloudsignal` kind

The app registers one hosted kind out of the box: `cloudsignal`
(`@raccoon/transport-cloudsignal`, an MQTT-over-WSS transport backed by a
token service). Its `transportConfig` shape:

```jsonc
{
  "host": "broker.platform.example",        // MQTT-over-WSS broker host
  "organizationId": "org_abc123",           // tenant scope on the platform
  "tokenServiceUrl": "https://tokens.platform.example",
  "tokenUrl": "https://api.platform.example/raccoon/token",
  "push": {                                  // optional - enables platform push
    "serviceUrl": "https://push.platform.example",
    "serviceId": "svc_xyz",
    "publishableKey": "pk_..."               // optional
  }
}
```

A pairing endpoint for this kind issues a normal grant plus this blob; the
runtime messages use the protocol-standard codec and topic shape - the blob
carries no codec choice.

### The `tokenUrl` credential exchange

The pairing's long-lived credential is the grant's `sessionToken`. The
runtime transport never puts it on the wire to the broker; instead it mints
short-lived connection tokens through the platform's exchange endpoint:

```
POST <tokenUrl>
Authorization: Bearer <sessionToken>

200 → { "token": "<connection token>", "expiresAt": "<ISO timestamp>" }
```

Contract for the platform implementing `tokenUrl`:

- Authenticate the request by the bearer session token alone. Only `token`
  is required in the 200 body (`expiresAt` and other fields are tolerated
  and currently ignored by the client - the transport re-exchanges when the
  broker rejects an expired token).
- Return **401 (or 403) only when the session grant itself is revoked or
  expired.** The app treats it as terminal: the platform is removed from the
  device and the user is told to scan a new QR code.
- Any other failure (5xx, timeouts) is treated as transient - the transport
  retries and the platform is listed as "Connecting" (or "Offline"), not
  unpaired.

Revoking a pairing server-side therefore requires no push channel: the next
exchange returns 401 and the device cleans itself up.

### Registering additional kinds

`ws` and `cloudsignal` are built in. A platform with its own transport ships
a factory and registers it under its kind via the provider's `transports`
prop (see the embedding section above):

```tsx
<TransportProvider transports={{ mykind: (opts) => myTransportFrom(opts) }}>
```

The factory receives the stored pairing's `transportConfig`, `userId`,
`instance`, and session token - everything a credentialed transport needs at
construction. Kinds are additive: registering one never changes the behavior
of `ws` pairings, and unknown kinds keep the list-offline degradation above.

## Path B - an existing OpenClaw agent

If your agent runs on [OpenClaw](https://openclaw.ai), install the first-party
connector as an OpenClaw plugin - no `AgentRunner` to write. (Running
[NanoClaw](https://github.com/nanocoai/nanoclaw) instead? Its first-party
connector embeds the raccoon endpoint inside NanoClaw's host process and
installs via the `add-raccoon` skill - see
[`adapters/connector-nanoclaw/README.md`](../adapters/connector-nanoclaw/README.md).)
v0.1 installs from a clone:

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
first one for you (`approvals.exec` in `openclaw.json` - it forwards pending
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

### Send images and files

The composer's paperclip (plus paste and desktop drag-drop) attaches up to 4
files of 25MB each per message. Files upload to your hub and are served back
as unguessable capability URLs - see the media section of
[security.md](security.md) for exactly what that model does and does not
protect. On OpenClaw, images you send are fetched by the gateway's media
pipeline, so the agent genuinely sees them.

## Try the bundled demo

From a clone of the monorepo:

```bash
npm install
npm run build:app      # build the PWA once
npm run demo           # echo hub on http://127.0.0.1:8790/
# open the URL ON THE SAME MACHINE, paste the printed pairing payload into the
# setup screen, send "/draft" to see an approval card
```

The demo advertises a `ws://127.0.0.1` URL, so a phone can't reach it - it's a
same-machine demo. To pair a real phone, deploy behind HTTPS/WSS:
[`examples/hosting/`](../examples/hosting/) has Railway, Cloudflare, and
Vercel walkthroughs.

## Next

- [`examples/hosting/`](../examples/hosting/) - deploy with HTTPS/WSS on
  Railway, Cloudflare (Tunnel/Pages), or Vercel, and pair a real phone.
- [connector-authoring.md](connector-authoring.md) - the public ports a
  connector implements, the package-boundary diagram, both first-party
  connectors as worked examples, and the adapter conformance checklist.
- [security.md](security.md) - what Raccoon does and does **not** protect
  (TLS/WSS, transit encryption, and why this is not end-to-end encryption).
