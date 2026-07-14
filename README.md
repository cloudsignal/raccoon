<div align="center">
<img src="brand/raccoon-icon-squircle.svg" width="120" alt="Raccoon">

# Raccoon 🦝

**Your messenger for AI agents.**

Talk to your agents the way you talk to people — a real chat app with a rich UI,
secured device pairing, and a front end that's portable across agent frameworks.

</div>

---

Raccoon is a self-hosted messenger for humans and AI agents. Today, every agent
lives behind a different interface — a terminal here, a Telegram bot there, a
different web UI per framework. Raccoon replaces that with one proper chat app:
pair your phone with a QR code, install it to your home screen, and message your
agents from a messenger that stays the same while the frameworks underneath it
change.

v0.1 ships a **vendor-neutral core** and a **first-party OpenClaw connector**.
Other agent frameworks connect through the same documented public ports — no
fork required. MQTT and CloudSignal transport integrations exist as private,
unpublished implementations; they are not dependencies of the core.

## Why Raccoon

- **Chat like you're used to.** Per-agent channels, message history, markdown,
  delivery ticks — messaging an agent feels like messaging a person, not
  driving a CLI or poking a bot.
- **Rich agent interactions.** When an agent needs a go-ahead, the approval
  renders as a native card you act on from your phone. With Web Push (VAPID)
  configured, notifications reach you while the app is closed. Outgoing
  messages are persisted locally and retried after reconnect.
- **Secured communication.** No separate Raccoon cloud account: pairing issues
  a revocable bearer credential over a QR code, and unpaired or unconfirmed
  devices are gated at the hub. Production deployments require HTTPS/WSS —
  Raccoon uses transport encryption, not WhatsApp/Signal-style end-to-end
  encryption; the hub, connector, agent runtime, and model provider handle
  plaintext. [docs/security.md](docs/security.md) spells out exactly what is
  and isn't encrypted.
- **A portable front end.** The app pairs to a Raccoon instance and gives every
  agent on it its own channel. Move between frameworks — OpenClaw today, yours
  tomorrow — by pairing the same app to a different instance, not by adopting a
  new UI. (v0.1 stores one active pairing at a time; it is not yet a
  multi-instance aggregator.)
- **Broker-free to start.** The built-in WebSocket hub requires no external
  broker or cloud service — the self-hosted WebSocket path involves no
  Raccoon-operated relay. The protocol is transport-agnostic by design;
  WebSocket is the one published transport in v0.1.
- **Yours.** Self-hosted on your own domain, brandable as your own app.

## Who it's for

- **Anyone running agents on an agent framework** (OpenClaw today) who wants a
  real chat app for their agents instead of a per-framework UI or a bot.
- **Teams that approve from the phone** — an agent asks, you see a card, you
  approve, with push to bring you in when it matters.
- **Builders who want a portable front end** — keep the same messenger while
  the frameworks, transports, and hosting evolve underneath it.

## How it works

```
Phone PWA ──(Raccoon protocol over WSS)── Hub ── Bridge ── Connector ── Agent framework / model
                                           │
                                    Web Push (VAPID), optional
```

A Raccoon **hub** exchanges protocol envelopes with the app over a pluggable
**transport** (WebSocket in v0.1). Your agent framework connects through a
**connector**; your phone pairs to the hub with a QR code and installs the
**PWA**. Envelopes carry messages, approval prompts, and push-subscription
control; background notifications are delivered through Web Push (VAPID) or a
host framework's own push adapter.

Swap the transport or the connector without rewriting the app or your agents.
See [PROTOCOL.md](PROTOCOL.md) for the wire format and
[docs/connector-authoring.md](docs/connector-authoring.md) for the ports a
connector implements.

## Try it (same-machine demo)

[docs/quickstart.md](docs/quickstart.md) is the 5-minute version. The shortest:

    npm install
    npm run demo   # builds the PWA, starts the echo hub on http://127.0.0.1:8790/

Open the printed URL **on the same machine** and paste the printed pairing
payload into the app's setup screen (the demo advertises a `ws://127.0.0.1`
URL, so a phone can't reach it). Send `/draft` to try an agent approval card.

To pair a real phone you need HTTPS/WSS on a reachable host — see
[Deploy](#deploy) below.

## Use it with OpenClaw

The connector is an OpenClaw channel plugin; the PWA ships prebuilt inside
`@raccoon/app`:

    openclaw plugins install npm:@raccoon/connector-openclaw
    npm install @raccoon/app

    # staticDir must be an ABSOLUTE path (the gateway's cwd differs):
    export RACCOON_STATIC_DIR="$(node -p "require('node:path').join(require('node:path').dirname(require.resolve('@raccoon/app/package.json')), 'dist-standalone')")"

Configure `channels.raccoon` (instance URL, port, allowlist), restart the
gateway, then enroll a user:

    openclaw raccoon pair <userId>    # prints the pairing QR

The full configuration surface, setup wizard, allowlist/DM policy, and the
pairing/revocation CLI are documented in
[adapters/connector-openclaw/README.md](adapters/connector-openclaw/README.md).

## Deploy

Production needs HTTPS/WSS (required for PWA install, service workers, and
push — and for phones to reach the hub at all).
[examples/hosting/](examples/hosting/) contains worked examples:

- [Railway](examples/hosting/railway/) — run the full hub (WebSocket + PWA +
  push) as one service; Railway terminates TLS on your domain.
- [Cloudflare](examples/hosting/cloudflare/) — front a self-hosted hub with a
  Cloudflare Tunnel for HTTPS/WSS without opening ports; optionally serve the
  PWA from Cloudflare Pages.
- [Vercel](examples/hosting/vercel/) — host the static PWA on Vercel's CDN;
  the hub (a long-lived WebSocket server) runs elsewhere, e.g. the Railway or
  Tunnel setup.

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

Every published package ships compiled `dist/` + emitted `.d.ts` with an `exports`
map and installs as a plain npm package — no workspace, sibling repo, vendored
tree, or `/src` import required. `npm run release:verify` proves it by packing
each package and building a fresh external consumer against the tarballs.

Not part of the v0.1 core (marked `private`, unpublished): `@raccoon/transport-mqtt`
and `@raccoon/transport-cloudsignal` — managed-transport implementations that
consume the public core ports from outside the neutral release. A NanoClaw
connector is planned, not yet shipped.

## Docs

- [docs/quickstart.md](docs/quickstart.md) — backend + PWA in 5 minutes
- [PROTOCOL.md](PROTOCOL.md) — the Raccoon wire protocol (versioned, connector-neutral)
- [docs/connector-authoring.md](docs/connector-authoring.md) — public ports, package-boundary diagram, second-connector example
- [docs/compatibility.md](docs/compatibility.md) — package versions + the OpenClaw version matrix
- [docs/security.md](docs/security.md) — HTTPS/WSS requirements, what's encrypted where, and why this is not E2EE
- [examples/hosting/](examples/hosting/) — deploy on Railway, Cloudflare, or Vercel

## License

MIT — see [LICENSE](LICENSE).
