# Raccoon 🦝

Self-hosted messenger for AI agents. An installable, push-capable chat
PWA plus channel adapters for agent frameworks (OpenClaw, NanoClaw).
Speaks OAM v0.1 over a pluggable transport: built-in WebSocket (zero
dependencies), any MQTT broker, or CloudSignal (identity, ACL
enforcement, push, NAT relay).

Status: **v0.1** — a vendor-neutral core (protocol, WebSocket transport, bridge,
pairing, push, installable PWA) plus a first-party OpenClaw connector. Core
carries no CloudSignal / GTM / broker dependency; a second connector or a
managed transport plugs in through the public ports (see
[docs/connector-authoring.md](docs/connector-authoring.md)).

**New here? Start with [docs/quickstart.md](docs/quickstart.md) (5 minutes).**

## Try it

    npm install
    npm test
    npm run build:app      # required once: example:echo serves the built PWA
    npm run example:echo   # prints a ws:// URL and a pairing token

## App

The installable PWA lives in `packages/app/`. To run the full end-to-end demo:

    npm run demo   # builds the app, starts the echo hub on port 8790
    # open http://127.0.0.1:8790/ and scan the printed QR (or paste the payload)
    # send "/draft" to try the approval card

See [`packages/app/README.md`](packages/app/README.md) for build options,
branding config, update architecture, and push setup.

## Packages

| Package | Description |
| --- | --- |
| `@raccoon/protocol` | OAM v0.1 envelope types and codec |
| `@raccoon/pairing` | QR pairing token generation and verification |
| `@raccoon/transport-ws` | Built-in WebSocket hub (`WsHub`) + client |
| `@raccoon/bridge` | `RaccoonBridge` + the framework ports a connector implements |
| `@raccoon/push` | VAPID key generation, Web Push delivery, subscription store |
| `@raccoon/app` | Installable push-capable chat PWA (static build + host-embed surface) |
| `@raccoon/connector-openclaw` | First-party OpenClaw channel connector (`openclaw` peer dep) |

Every package above ships compiled `dist/` + emitted `.d.ts` with an `exports`
map, and installs as a plain npm package (no workspace, sibling repo, vendored
tree, or `/src` import required). `npm run release:verify` proves this by
packing every package and building a fresh external consumer against the
tarballs.

**Not part of the v0.1 core** (marked `private`, not published):
`@raccoon/transport-mqtt` and `@raccoon/transport-cloudsignal` — managed-transport
experiments that consume the public core ports from outside the neutral release.

## Docs

- [docs/quickstart.md](docs/quickstart.md) — stand up a backend + PWA in 5 minutes
- [docs/connector-authoring.md](docs/connector-authoring.md) — public ports, package-boundary diagram, second-connector example
- [docs/compatibility.md](docs/compatibility.md) — package versions + the OpenClaw version matrix
- [docs/security.md](docs/security.md) — TLS/WSS, transit encryption, and why this is not E2EE
- [PROTOCOL.md](PROTOCOL.md) — the OAM v0.1 wire protocol
