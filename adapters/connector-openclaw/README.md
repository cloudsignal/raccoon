# @raccoon/connector-openclaw

First-party OpenClaw connector for [Raccoon](../../README.md). It stands up a
Raccoon WebSocket hub (serving the installable Raccoon PWA) inside the OpenClaw
gateway process and bridges it to an agent, so a user can chat with your
OpenClaw agent from the Raccoon app, paired by QR, DM-gated by an allowlist.

`openclaw` is a **peer dependency** — install it yourself. See
[../../docs/compatibility.md](../../docs/compatibility.md) for the supported
OpenClaw version matrix, and
[../../docs/connector-authoring.md](../../docs/connector-authoring.md) for the
public ports this connector implements.

## Install

v0.1 installs from a clone as a linked OpenClaw plugin (the packages are not
yet on the public npm registry; no registry account or token is needed):

```bash
git clone https://github.com/cloudsignal/raccoon && cd raccoon
npm ci && npm run build && npm run build:app
openclaw plugins install --link "$PWD/adapters/connector-openclaw"
```

Serve the PWA the connector pairs to by pointing `channels.raccoon.staticDir`
(or `RACCOON_STATIC_DIR`) at the bundle the clone just built. The gateway's
working directory is not your clone, so it must be an **absolute** path (a
relative path will not find the files at runtime):

```bash
export RACCOON_STATIC_DIR="$PWD/packages/app/dist-standalone"
```

If you instead installed `@raccoon/app` from a packed tarball into your own
project (see the repo README's Distribution note), resolve the absolute path
from wherever it landed:

```bash
export RACCOON_STATIC_DIR="$(node -p "require('node:path').join(require('node:path').dirname(require.resolve('@raccoon/app/package.json')), 'dist-standalone')")"
```

## Setup in one command

After the plugin is installed, `openclaw raccoon setup` writes the whole
channel configuration for you:

```bash
openclaw raccoon setup --url wss://chat.example.com/ --user alice
openclaw raccoon setup --tunnel cloudflared --user alice   # no proxy? quick tunnel
```

It merges `channels.raccoon` into `openclaw.json` (backing the file up
first), adds `raccoon` to `plugins.allow`, resolves `staticDir` from the
built PWA, and prints the two remaining steps: restart the gateway, then
`openclaw raccoon pair <user>`. With `--tunnel cloudflared` it starts a
Cloudflare quick tunnel on the hub port and uses the tunnel hostname as the
pairing URL; keep that process running while you test (for something
permanent, see the repo's `examples/hosting/`). Flags: `--url`, `--channel`,
`--user`, `--port`, `--static-dir`, `--tunnel`, `--config`.

## Renaming the channel

The channel name is the chat's identity in the app (`agent:<channel>` on the
wire, the chat title in the UI). The setup wizard prompts for it (default
`assistant`); to rename later, change it and restart the gateway:

```jsonc
{ "channels": { "raccoon": { "channels": ["atlas"] } } }
```

Paired devices pick the new channel up on their next connection; the app
humanizes the id for the title (`ops-oncall` renders as "Ops Oncall"), and a
self-hosted app build can pin a label/blurb per id in `raccoon.config.json`.
Message history in the app is stored per channel id, so the old channel's
transcript stays under the old name; agent-side memory is unaffected (the
agent is the same agent).

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
- **No handwritten type shims.** The connector imports the real published types
  directly from `openclaw/plugin-sdk/*` and compiles against them; its build
  fails loudly if an entry point moves. The one derived helper
  (`src/openclaw-missing-types.ts`) is `Awaited<ReturnType<…>>` of a real public
  SDK function, not a hand-copied shape.

## Configuration

The primary config surface is the `channels.raccoon` section of
`openclaw.json`. Each field falls back to an environment variable, then a
default. The account model is a single account (`"default"`).

| `channels.raccoon.*` | Env fallback | Default | Meaning |
|----------------------|--------------|---------|---------|
| `instanceUrl` | `RACCOON_INSTANCE_URL` | (none) | Public `ws(s)://` URL clients dial. Required to be "configured". |
| `port` | `RACCOON_PORT` | (none) | Hub HTTP/WS port the gateway binds. Required to be "configured". |
| `channels` | `RACCOON_CHANNELS` (CSV) | `["coordinator"]` | Raccoon channels the hub serves. |
| `instance` | `RACCOON_INSTANCE` | (none) | Instance display name. |
| `staticDir` | `RACCOON_STATIC_DIR` | (none) | Filesystem path to the built Raccoon PWA (`@raccoon/app` `dist-standalone`) to serve. |
| `allowFrom` | (none) | `[]` | Raccoon user ids allowed to DM the agent (the allowlist). |
| `dmPolicy` | (none) | `allowlist` | DM gate policy (`allowlist` \| `open` \| `disabled`). |

**Runtime (env only):**

- `RACCOON_HOST`: hub bind host (set `0.0.0.0` in a container).
- `RACCOON_AGENT_ID`: agent id for inbound turns; defaults to the first Raccoon
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
  `ws(s)://`), and **group channels** (CSV → the Raccoon `channels` list);
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

The outbound adapter turns one agent reply into an ordered list of Raccoon `msg`
envelopes, one per chunk, order preserved:

- Chunking uses the SDK's `chunkMarkdownTextWithMode` with limit
  `RACCOON_TEXT_LIMIT = 8000` and mode `RACCOON_CHUNK_MODE = 'newline'`
  (`'newline'` prefers paragraph boundaries / blank lines, falling back to
  length splitting only when a single paragraph exceeds the limit; there is
  no `'paragraph'` literal in the real SDK).
- Media URLs are appended as a plain markdown-links block before chunking
  (v1); the Raccoon app renders them clickable. Native media envelopes are
  a future protocol extension.
- Interactive replies (approval-style buttons) map to a protocol
  `approval.request` envelope; anything unmappable falls back to text.

## Exec approvals → native cards

The plugin registers an `approvalCapability` whose `render.exec` hooks turn
OpenClaw exec-approval requests into compact card payloads: title, the FULL
pending command (never truncated — an approval surface that hides part of what
it approves is a security bug), an agent/host/expiry context line, and
Allow Once / Allow Always / Deny buttons carrying the real `/approve <id>
<decision>` command. Tapping a button resolves the approval and the blocked
exec continues.

Requirements, both handled by `openclaw raccoon setup`:

- `approvals.exec.enabled` in `openclaw.json` (mode `session` routes the
  request back to the conversation that started the turn). Without it,
  OpenClaw never forwards exec approvals to ANY chat channel.
- An exec-approval policy that actually prompts — `openclaw approvals set`
  with `ask: on-miss` (or `always`). The default `ask: off` auto-runs.

Approval authorization is the channel gate itself: Raccoon is a 1:1
paired-device DM channel, so the user in the conversation is the approver —
the same trust model as answering the prompt in the terminal that started the
run. The plugin registers no extra `authorizeActorAction`.

## Running the smoke test (Docker)

1. Build the plugin bundle (single-file ESM; `openclaw/*` stays external, as
   the gateway provides it):

   ```bash
   npx esbuild adapters/connector-openclaw/src/index.ts --bundle --platform=node \
     --format=esm --target=node20 --external:openclaw --external:"openclaw/*" \
     --external:bufferutil --external:utf-8-validate \
     --outfile="$SMOKE/state/extensions/raccoon/index.js"
   ```

2. Stage the plugin dir under the state mount (`$SMOKE/state` maps to the
   container's `~/.openclaw`). It needs THREE files:
   - `index.js` (the bundle)
   - `package.json` (`"openclaw": { "extensions": ["./index.js"] }`)
   - `openclaw.plugin.json`: REQUIRED by current OpenClaw. Copy the one shipped
     at `adapters/connector-openclaw/openclaw.plugin.json`. The top-level `channels`
     array is what marks this manifest as owning the `raccoon` channel id (not
     a `kind` field); `channelConfigs.raccoon.schema` is the cold-path config
     schema (setup and Control UI read it before the plugin runtime loads) and
     mirrors `raccoonChannelPlugin.configSchema.schema` (port / instanceUrl /
     channels / instance / staticDir; `additionalProperties: true` so the
     allowFrom / dmPolicy fields the security + setup adapters read pass
     through):

     ```json
     { "id": "raccoon", "activation": { "onStartup": true },
       "enabledByDefault": true, "name": "Raccoon",
       "description": "Self-hosted Raccoon messenger (installable PWA + push).",
       "channels": ["raccoon"],
       "channelConfigs": { "raccoon": { "schema": {
         "type": "object", "additionalProperties": true,
         "properties": {
           "instance": { "type": "string" },
           "port": { "type": "number" },
           "instanceUrl": { "type": "string" },
           "channels": { "type": "array", "items": { "type": "string" } },
           "staticDir": { "type": "string" } } } } } }
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
   - A model set via `openclaw models set <provider>/<model>` must ALSO be
     registered under `models.providers.<provider>.models[]` in
     `openclaw.json` (`{ "id": "<model>", "name": "<model>" }`), or every
     turn fails fast with `FailoverError: Unknown model`. The provider API
     key can come from env (e.g. `ANTHROPIC_API_KEY`); check both with
     `openclaw models status`.

4. Run:

   ```bash
   docker run -d --name raccoon-smoke \
     -v "$SMOKE/state":/home/node/.openclaw \
     -v "$(pwd)/packages/app/dist-standalone":/raccoon-app:ro \
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
