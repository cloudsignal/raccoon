<div align="center">
<img src="brand/raccoon-icon-squircle.svg" width="120" alt="Raccoon">

# Raccoon 🦝

**Your messenger for AI agents.**

A real chat app for the agents you run. Self-hosted, installable on your
phone, push-capable, portable across agent frameworks.

[![CI](https://github.com/cloudsignal/raccoon/actions/workflows/ci.yml/badge.svg)](https://github.com/cloudsignal/raccoon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D20.19-brightgreen.svg)](docs/compatibility.md)

[raccoonchat.im](https://raccoonchat.im)

</div>

---

Raccoon is a self-hosted messenger for humans and AI agents. Most agents today
live behind a terminal, a Telegram bot, or a web UI that belongs to one
framework. Raccoon gives them a single chat app instead. Pair your phone with
a QR code, install the app to your home screen, and message your agents. The
app stays the same when the framework underneath changes.

v0.1 ships a vendor-neutral core and a first-party OpenClaw connector. Other
agent frameworks connect through the same documented public ports, no fork
required. The deeper plumbing is pluggable too: the wire that carries messages
and the delivery behind push notifications are documented seams. Vendor
integrations arrive as plugins you choose to install, never as core
dependencies.

## Why Raccoon

- **Familiar chat.** Per-agent channels, message history, markdown, delivery
  ticks. Messaging an agent works like messaging a person.
- **Approvals from your phone.** When an agent needs a go-ahead, it renders as
  a native card: approve, edit, or skip. With Web Push (VAPID) configured,
  notifications reach you while the app is closed. Outgoing messages are
  persisted locally and retried after reconnect.
- **Secured pairing.** No separate cloud account. Pairing issues a revocable
  bearer credential over a QR code, and unpaired or unconfirmed devices are
  gated at the hub. Production requires HTTPS/WSS. Raccoon encrypts in
  transit; it is not Signal-style end-to-end encryption, and the hub,
  connector, agent runtime, and model provider all handle plaintext.
  [docs/security.md](docs/security.md) spells out what is and is not
  encrypted.
- **A portable front end.** The app pairs to a Raccoon instance and gives
  every agent on it its own channel. Moving to another framework means pairing
  the same app to a different instance, not adopting a new UI. (v0.1 stores
  one active pairing at a time. It is not yet a multi-instance aggregator.)
- **Broker-free by default.** The built-in WebSocket hub needs no external
  broker or cloud service, and the self-hosted path involves no
  Raccoon-operated relay. The protocol is transport-agnostic; WebSocket is the
  one published transport in v0.1.
- **Self-hosted.** Runs on your own domain, brandable as your own app.

## Who it's for

- People running agents on an agent framework (OpenClaw today) who want a
  real chat app instead of a per-framework UI or a bot.
- Teams that approve agent actions from a phone, with push to bring the right
  person in.
- Builders who want one front end that survives changes of framework,
  transport, and hosting.

## How it works

```
Phone PWA ──(Raccoon protocol over WSS)── Hub ── Bridge ── Connector ── Agent framework / model
                                           │
                                    Web Push (VAPID), optional
```

A Raccoon **hub** exchanges protocol envelopes with the app over a pluggable
**transport** (WebSocket in v0.1). Your agent framework connects through a
**connector**. Your phone pairs to the hub with a QR code and installs the
**PWA**. Envelopes carry messages, approval prompts, and push-subscription
control. Background notifications travel over Web Push (VAPID) or a host
framework's own push adapter.

Everything below the app is a documented extension seam
([docs/connector-authoring.md](docs/connector-authoring.md)):

- **Connectors** join an agent framework as a consumer of the messaging
  ports. This is everything the OpenClaw connector uses.
- **Transports** replace the built-in WebSocket with your own wire (a broker,
  a managed service) carrying the same envelopes.
- **Push** hands notifications to your own delivery instead of raw Web Push.

Vendor integrations ship as plugins built on these seams, from their own
repos. The core never names or depends on them. See
[PROTOCOL.md](PROTOCOL.md) for the wire format.

## Try it (same-machine demo)

[docs/quickstart.md](docs/quickstart.md) is the 5-minute version. The
shortest:

    npm install
    npm run demo   # builds the PWA, starts the echo hub on http://127.0.0.1:8790/

Open the printed URL on the same machine and paste the printed pairing
payload into the app's setup screen. The demo advertises a `ws://127.0.0.1`
URL, so a phone can't reach it. Send `/draft` to try an agent approval card.

Pairing a real phone needs HTTPS/WSS on a reachable host; see
[Deploy](#deploy).

## Use it with OpenClaw

The connector is an OpenClaw channel plugin. v0.1 installs from a clone (the
packages are not yet on the public npm registry):

    git clone https://github.com/cloudsignal/raccoon && cd raccoon
    npm ci && npm run build && npm run build:app
    openclaw plugins install --link "$PWD/adapters/connector-openclaw"

    # staticDir must be an ABSOLUTE path (the gateway's cwd differs):
    export RACCOON_STATIC_DIR="$PWD/packages/app/dist-standalone"

Then let the connector write its own configuration (instance URL, channel
name, allowlist, PWA path), restart the gateway, and enroll a user:

    openclaw raccoon setup --url wss://chat.example.com/ --user <userId>
    # (no proxy? --tunnel cloudflared gives you a temporary public URL)
    openclaw raccoon pair <userId>    # prints the pairing QR

Configuration, the setup wizard, allowlist/DM policy, and the pairing CLI are
documented in
[adapters/connector-openclaw/README.md](adapters/connector-openclaw/README.md).

## Deploy

Production needs HTTPS/WSS: PWA install, service workers, and push all
require a secure origin, and phones can't reach `ws://127.0.0.1`.
[examples/hosting/](examples/hosting/) contains worked examples:

- [Railway](examples/hosting/railway/): run the full hub (WebSocket + PWA +
  push) as one service. Railway terminates TLS on your domain.
- [Cloudflare](examples/hosting/cloudflare/): front a self-hosted hub with a
  Cloudflare Tunnel for HTTPS/WSS without opening ports, or serve the PWA
  from Cloudflare Pages.
- [Vercel](examples/hosting/vercel/): host the static PWA on Vercel's CDN
  (one-click deploy button included) while the hub (a long-lived WebSocket
  server) runs elsewhere, such as the Railway or Tunnel setup.

## Packages

| Package | What it is |
| --- | --- |
| `@raccoon/app` | The installable, push-capable chat PWA (static build + host-embed surface) |
| `@raccoon/connector-openclaw` | First-party OpenClaw channel connector (`openclaw` peer dep) |
| `@raccoon/protocol` | Raccoon protocol envelope types, schemas, and codec |
| `@raccoon/transport-ws` | Built-in broker-free WebSocket hub (`WsHub`) + client |
| `@raccoon/bridge` | `RaccoonBridge` + the framework ports a connector implements |
| `@raccoon/pairing` | QR pairing token generation and verification |
| `@raccoon/push` | VAPID key generation, Web Push delivery, subscription store |

Every package ships compiled `dist/` and emitted `.d.ts` with an `exports`
map, and installs as a plain npm package: no workspace, sibling repo,
vendored tree, or `/src` import required. `npm run release:verify` proves it
by packing each package and building a fresh external consumer against the
tarballs.

**Distribution (v0.1) is repo-first.** No registry account or token is needed
anywhere. The packages are not yet on the public npm registry. Consume them
from a clone, or pack the gated tarballs and install those in your own
project (installed together, they resolve each other; `release:verify` gates
this):

    git clone https://github.com/cloudsignal/raccoon && cd raccoon
    npm ci && npm run release:pack
    # in your project:
    npm i /path/to/raccoon/release-artifacts/raccoon-*.tgz

The repo also carries two `private`, unpublished transport implementations
(an MQTT broker transport and a managed-service transport) that prove the
transport seam from outside the neutral release. Nothing in core depends on
them. A NanoClaw connector is planned, not yet shipped.

## Docs

- [docs/quickstart.md](docs/quickstart.md): backend + PWA in 5 minutes
- [PROTOCOL.md](PROTOCOL.md): the Raccoon wire protocol (versioned, connector-neutral)
- [docs/connector-authoring.md](docs/connector-authoring.md): public ports, package-boundary diagram, second-connector example
- [docs/compatibility.md](docs/compatibility.md): package versions and the OpenClaw version matrix
- [docs/security.md](docs/security.md): HTTPS/WSS requirements, what's encrypted where, why this is not E2EE
- [examples/hosting/](examples/hosting/): deploy on Railway, Cloudflare, or Vercel

## License

MIT. See [LICENSE](LICENSE).
