# Compatibility & versions

## Raccoon v0.1 — published packages

| Package | Version | Notes |
| --- | --- | --- |
| `@raccoon/protocol` | 0.1.0 | Raccoon protocol envelopes + codec |
| `@raccoon/transport-ws` | 0.1.0 | `WsHub` + `WsClientTransport` |
| `@raccoon/bridge` | 0.1.0 | `RaccoonBridge` + framework ports |
| `@raccoon/pairing` | 0.1.0 | QR pairing issue / verify |
| `@raccoon/push` | 0.1.0 | VAPID / Web Push (optional) |
| `@raccoon/app` | 0.1.0 | installable chat PWA |
| `@raccoon/connector-openclaw` | 0.1.0 | first-party OpenClaw connector |

Not part of the v0.1 gate (marked `private`, not published): `@raccoon/transport-mqtt`,
`@raccoon/transport-cloudsignal`. These are managed-transport experiments that
consume the public core ports; they are excluded from the neutral core release.

## Runtime

| Requirement | Version |
| --- | --- |
| Node.js | `^20.19.0 \|\| >=22.12.0` |
| Module system | ESM only (all packages `"type": "module"`) |
| Types | emitted `.d.ts`; `NodeNext` / `Bundler` resolution both supported |

## OpenClaw connector ↔ OpenClaw

`@raccoon/connector-openclaw` compiles and runs against the **real published
OpenClaw package** — real entry points, real types, no handwritten type shims.

| `@raccoon/connector-openclaw` | OpenClaw | Status |
| --- | --- | --- |
| 0.1.0 | **2026.6.11** | Supported — the version the connector is built and e2e-tested against. |
| 0.1.0 | `>=2026.6.11` | Declared as the `openclaw` peer-dependency range. Newer patch/minor releases are expected to work; verify against the plugin-SDK entry points below. |
| 0.1.0 | `<2026.6.11` | Unsupported — the connector uses plugin-SDK APIs introduced in 2026.6.11. |

`openclaw` is a **peer dependency** of the connector — install it yourself; the
connector does not bundle or re-export it.

### Plugin-SDK entry points the connector depends on

The connector imports these real subpaths (all present in `openclaw@2026.6.11`):

- `openclaw/plugin-sdk/channel-core` — `defineChannelPluginEntry`, `OpenClawConfig`
- `openclaw/plugin-sdk/channel-runtime` — `ChannelGatewayContext`, `ChannelOutboundAdapter`, outbound contexts
- `openclaw/plugin-sdk/channel-inbound` — `dispatchReplyFromConfigWithSettledDispatcher`
- `openclaw/plugin-sdk/reply-runtime` — `ReplyDispatcher`, `ReplyPayload`, `FinalizedMsgContext`
- `openclaw/plugin-sdk/interactive-runtime` — `MessagePresentation`, buttons/options
- `openclaw/plugin-sdk/channel-send-result` — `OutboundDeliveryResult`
- `openclaw/plugin-sdk/reply-chunking` — `chunkMarkdownTextWithMode`

If a future OpenClaw release moves or renames any of these, the connector's
build (`tsc -p adapters/connector-openclaw/tsconfig.build.json`) fails loudly
rather than resolving against a shim — bump the connector and the matrix row
together.

## Model provider

The connector is model-agnostic: it transports messages and delegates the agent
turn to OpenClaw's runtime. A live agent **reply** requires a configured
OpenClaw model provider. Pairing, onboarding, and message transport work without
one. See the connector README's Configuration section.
