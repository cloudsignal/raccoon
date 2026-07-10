# @raccoon/openclaw

OpenClaw plugin for [Raccoon](../../README.md). It stands up a Raccoon
WebSocket hub (serving the installable Raccoon PWA) inside the OpenClaw
gateway process and bridges it to an agent, so a user can chat with your
OpenClaw agent from the Raccoon app, paired by QR, DM-gated by an
allowlist.

## Status: CHANNEL-NATIVE (2026-07-09)

Reconciled against the real `openclaw@2026.6.11` SDK. The adapter is a full
channel-native plugin:

- Entry is `defineChannelPluginEntry` from `openclaw/plugin-sdk/channel-core`
  with a complete `ChannelPlugin` (`raccoonChannelPlugin`): `config` /
  `configSchema` / `meta` / `capabilities`, plus the `outbound`, `pairing`,
  `security`, `setupWizard`, and `gateway` adapter slots.
- The WsHub + RaccoonBridge lifecycle lives in
  `raccoonChannelPlugin.gateway.startAccount` / `stopAccount`; OpenClaw's
  gateway owns the per-account transport lifecycle. `startAccount` wires the
  real agent runner (`buildRaccoonInboundRunner`, driving
  `dispatchReplyFromConfigWithSettledDispatcher`) and the allowlist gate.
- `registerFull` keeps only the mode gate, an idempotent per-`api` guard, the
  `/raccoon/version` route, and the gateway-mediated `/raccoon/pair` +
  `/raccoon/revoke` routes (`auth: 'gateway'`). It never binds the hub port.
- Outbound↔hub seam: OpenClaw's outbound adapter and gateway context provide
  no blessed transport handoff, so the gateway keeps a module-scope per-account
  registry (keyed by `accountId`); the outbound adapter resolves the live hub
  from it per call. See the `gateway.ts` header for the full rationale.
- `register()` runs in several registration modes and more than once even in
  `'full'` mode (boot + agent-runtime pre-warm); the entry gates on
  `api.registrationMode === 'full'` and the idempotent guard.
- `types/openclaw-sdk.d.ts` mirrors the real declarations 1:1 for the subset
  we call, typechecked against the real `.d.ts` extracted from the npm tarball.

## Configuration

The primary config surface is the `channels.raccoon` section of
`openclaw.json`. Each field falls back to an environment variable, then a
default. The account model is a single account (`"default"`).

| `channels.raccoon.*` | Env fallback | Default | Meaning |
|----------------------|--------------|---------|---------|
| `instanceUrl` | `RACCOON_INSTANCE_URL` | (none) | Public `ws(s)://` URL clients dial. Required to be "configured". |
| `port` | `RACCOON_PORT` | (none) | Hub HTTP/WS port the gateway binds. Required to be "configured". |
| `channels` | `RACCOON_CHANNELS` (CSV) | `["coordinator"]` | OAM channels the hub serves. |
| `instance` | `RACCOON_INSTANCE` | (none) | Instance display name. |
| `staticDir` | `RACCOON_STATIC_DIR` | (none) | Filesystem path to the built Raccoon PWA (`@raccoon/app` `dist`) to serve. |
| `allowFrom` | (none) | `[]` | Raccoon user ids allowed to DM the agent (the allowlist). |
| `dmPolicy` | (none) | `allowlist` | DM gate policy (`allowlist` \| `open` \| `disabled`). |

**Runtime (env only):**

- `RACCOON_HOST`: hub bind host (set `0.0.0.0` in a container).
- `RACCOON_AGENT_ID`: agent id for inbound turns; defaults to the first OAM
  channel name.
- `RACCOON_STORE_PATH`: message-store path; defaults to a per-account path.
- `RACCOON_BUILD_ID`: value reported by `/raccoon/version` (default `dev`).

**Pairing CLI → gateway (env only):** the `raccoon pair`/`revoke` commands run
in a separate process from the gateway and proxy over HTTP (see
[Pairing](#pairing--revocation)):

- `OPENCLAW_GATEWAY_TOKEN` (or `RACCOON_GATEWAY_TOKEN`): bearer token for the
  `auth: 'gateway'` routes. **Required** for the CLI to authenticate.
- `RACCOON_GATEWAY_URL` → `OPENCLAW_GATEWAY_URL` → `http://127.0.0.1:$OPENCLAW_GATEWAY_PORT`
  → `http://127.0.0.1:18789` (gateway base-URL resolution order).

**Model provider:** the channel is model-agnostic; it transports messages and
delegates the agent turn to OpenClaw's runtime. Agent *replies* therefore
require a configured OpenClaw model provider (`openclaw models auth login
--provider <p>`, or a provider API-key env var); check with `openclaw models
status`. Pairing, onboarding, and message transport work without one.

## Setup wizard

`openclaw` setup surfaces Raccoon as a channel. It takes no credentials
(self-hosted) and collects:

- **instance name**, **port** (numeric), **instance URL** (validated
  `ws(s)://`), and **group channels** (CSV → the OAM `channels` list);
- **allowFrom**: the Raccoon user-id allowlist (written to
  `channels.raccoon.allowFrom`);
- **DM policy**: defaults to `allowlist`.

The channel reports "configured" once both `instanceUrl` and `port` are set.
On completion the wizard points you at `openclaw raccoon pair <userId>` to
enroll each allowlisted user.

## Pairing & revocation

```bash
openclaw raccoon pair <userId>     # prints a device-pairing QR for that user
openclaw raccoon revoke <userId>   # revokes the user's sessions (idempotent)
```

Pairing tokens are only valid against the WsHub instance that minted them,
which lives in the gateway process. A plugin CLI command runs in a **separate**
process and has no handle to that live hub, so the CLI proxies to the
gateway's `POST /raccoon/pair` route (registered under `auth: 'gateway'`). The
gateway handler resolves the running account's live hub from the module-scope
registry and mints the token there, returning `{ token, payload, qr }`. Set
`OPENCLAW_GATEWAY_TOKEN` (or `RACCOON_GATEWAY_TOKEN`) so the CLI can
authenticate; unauthenticated requests get `401` and mint nothing. On a
resolution/issuance failure the routes return a sanitized `500`
(`{ error: { message: 'pairing failed', type: 'internal' } }`) with no
internal detail; the real error is logged server-side.

## Message formatting & chunking

The outbound adapter turns one agent reply into an ordered list of OAM `msg`
envelopes, one per chunk, order preserved:

- Chunking uses the SDK's `chunkMarkdownTextWithMode` with limit
  `RACCOON_TEXT_LIMIT = 8000` and mode `RACCOON_CHUNK_MODE = 'newline'`
  (`'newline'` prefers paragraph boundaries / blank lines, falling back to
  length splitting only when a single paragraph exceeds the limit; there is
  no `'paragraph'` literal in the real SDK).
- Media URLs are appended as a plain markdown-links block before chunking
  (v1); the Raccoon app renders them clickable. Native OAM media envelopes are
  a future protocol extension.
- Interactive replies (approval-style buttons) map to an OAM
  `approval.request` envelope; anything unmappable falls back to text.

## Running the smoke test (Docker)

1. Build the plugin bundle (single-file ESM; `openclaw/*` stays external, as
   the gateway provides it):

   ```bash
   npx esbuild adapters/openclaw/src/index.ts --bundle --platform=node \
     --format=esm --target=node20 --external:openclaw --external:"openclaw/*" \
     --external:bufferutil --external:utf-8-validate \
     --outfile="$SMOKE/state/extensions/raccoon/index.js"
   ```

2. Stage the plugin dir under the state mount (`$SMOKE/state` maps to the
   container's `~/.openclaw`). It needs THREE files:
   - `index.js` (the bundle)
   - `package.json` (`"openclaw": { "extensions": ["./index.js"] }`)
   - `openclaw.plugin.json`: REQUIRED by current OpenClaw. Copy the one shipped
     at `adapters/openclaw/openclaw.plugin.json`; its `configSchema` mirrors
     `raccoonChannelPlugin.configSchema.schema` (port / instanceUrl / channels /
     instance / staticDir; `additionalProperties: true` so the allowFrom /
     dmPolicy fields the security + setup adapters read pass through):

     ```json
     { "id": "raccoon", "activation": { "onStartup": true },
       "enabledByDefault": true, "name": "Raccoon",
       "description": "Self-hosted Raccoon messenger (installable PWA + push).",
       "configSchema": { "type": "object", "additionalProperties": true,
         "properties": {
           "instance": { "type": "string" },
           "port": { "type": "number" },
           "instanceUrl": { "type": "string" },
           "channels": { "type": "array", "items": { "type": "string" } },
           "staticDir": { "type": "string" } } } }
     ```

3. Gotchas found live:
   - Plugin dir/file permissions must NOT be world-writable (mode 777 is
     blocked by OpenClaw's supply-chain guard). Use 755/644. The state root
     itself must be writable by container uid 1000.
   - Local plugins have no install provenance and are not activated until
     trusted: `openclaw.json` needs `"plugins": { "allow": ["raccoon"] }`
     (note: `allow` is an allowlist; it disables unlisted plugins).
   - The gateway needs `"gateway": { "mode": "local" }` in `openclaw.json`
     and `OPENCLAW_GATEWAY_TOKEN` set (container binds 0.0.0.0).
   - On macOS, mount the state dir from `$HOME` (Docker Desktop presented a
     `/tmp` bind mount as an empty root-owned dir).

4. Run:

   ```bash
   docker run -d --name raccoon-smoke \
     -v "$SMOKE/state":/home/node/.openclaw \
     -v "$(pwd)/packages/app/dist":/raccoon-app:ro \
     -e OPENCLAW_GATEWAY_TOKEN=... \
     -e RACCOON_HOST=0.0.0.0 -e RACCOON_STATIC_DIR=/raccoon-app \
     -e RACCOON_INSTANCE_URL=ws://127.0.0.1:8790/ \
     -p 18789:18789 -p 8790:8790 openclaw/openclaw:latest
   ```

   Issue a pairing QR with `openclaw raccoon pair <userId>`, open
   `http://127.0.0.1:8790/`, paste the payload, and chat. (A live agent reply
   additionally needs a model provider; see [Configuration](#configuration).)

## Live-gate evidence (2026-07-09)

Verified against `openclaw/openclaw:latest` with the bundle staged as above:

- **Loads as a channel**: `[raccoon] account "default" started (channel
  coordinator)`, gateway HTTP up with 1 plugin, no supervisor restart loop
  (the persistent-until-abort `startAccount` holds).
- **Configured**: `openclaw channels status` → `Raccoon default: running`.
- **Serves the PWA**: `curl http://127.0.0.1:8790/` → `200 text/html`.
- **Cross-process pairing**: `openclaw raccoon pair demo` mints a real
  device-pairing QR via CLI → `auth: 'gateway'` `POST /raccoon/pair` →
  live-hub `issuePairing`. An unauthenticated `POST /raccoon/pair` (loopback
  and external) returns `401` and mints nothing.

Deferred to a post-publish gate: a full live message → real-LLM-reply
round-trip, which requires a model provider in the OpenClaw runtime (the
adapter's inbound→dispatch→outbound path is covered by the type contract and
unit tests; see below).

## Architecture & tests

The gateway lifecycle (start/stop idempotency, the outbound↔hub registry seam,
the real-runner wiring, allowlist enforcement) is covered by `gateway.test.ts`,
`gateway-client.test.ts`, `outbound-registry.test.ts`, and `index.test.ts`;
`createRaccoonChannel` composes the same pieces the `@raccoon/bridge` e2e test
exercises end-to-end, and `WsHub.start()` failure paths are regression-tested
in `packages/transport-ws` (`hub-static.test.ts`) after the live run exposed an
unhandled listen error.
