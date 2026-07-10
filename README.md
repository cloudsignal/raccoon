# Raccoon 🦝

Self-hosted messenger for AI agents. An installable, push-capable chat
PWA plus channel adapters for agent frameworks (OpenClaw, NanoClaw).
Speaks OAM v0.1 over a pluggable transport: built-in WebSocket (zero
dependencies), any MQTT broker, or CloudSignal (identity, ACL
enforcement, push, NAT relay).

Status: Plan C complete. Protocol, ws transport, push, and installable PWA.

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
| `@raccoon/transport-ws` | Built-in WebSocket hub (`WsHub`) |
| `@raccoon/bridge` | Agent framework adapters (OpenClaw, NanoClaw) |
| `@raccoon/push` | VAPID key generation, Web Push delivery, subscription store |
| `@raccoon/transport-mqtt` | MQTT transport (any broker, pluggable codec) |
| `@raccoon/transport-cloudsignal` | CloudSignal transport (identity-secured, managed push) |
| `@raccoon/app` | Installable push-capable chat PWA (static build) |
| `adapters/openclaw` | OpenClaw channel-native plugin |

Packages are consumed from the workspace (clone and build, as under "Try it");
they are not yet published to npm, so `main` points at TypeScript source. npm
publishing with compiled outputs lands in a later release.
