---
name: add-raccoon
description: Add the Raccoon messenger channel to a NanoClaw install - copies the bundled adapter, registers the channel, configures .env, wires the owner's conversations, and pairs the first device
---

# add-raccoon

## What this does

This skill adds a `raccoon` channel to your NanoClaw checkout. It copies the
self-contained Raccoon adapter bundle (WebSocket hub, device pairing, and the
Raccoon PWA) into `src/channels/`, registers it through NanoClaw's channel
registry, appends the required environment variables to `.env`, wires the
owner's conversations to an agent group, and pairs the first phone. Once
installed, paired phones chat with NanoClaw agents through the Raccoon PWA —
a browser-installable messenger served by the channel itself — with typing
indicators, approval cards for agent questions, and media in both directions.

## Prerequisites

- A raccoon repo checkout (or unpacked release artifacts) with the connector
  deliverables built: `dist/raccoon.bundle.mjs`, `dist/raccoon.bundle.d.mts`,
  and `dist/raccoon-app/` must all exist under `adapters/connector-nanoclaw/`.
  From a fresh raccoon checkout, build them with:

  ```bash
  npm install && npm run build:app && npm run bundle -w @raccoon/connector-nanoclaw
  ```

- A running NanoClaw checkout (cloned, dependencies installed, at least one
  agent configured, and an owner approval channel working — for example their
  CLI channel — so registration approvals have somewhere to land).

An opt-in end-to-end rehearsal of these file steps against a throwaway
NanoClaw checkout exists at
`adapters/connector-nanoclaw/scripts/verify-nanoclaw-install.sh` (needs
network and NanoClaw's toolchain; see the connector README's Verifying
section).

## Installing this skill

NanoClaw has no plugin mechanism; skills live in the checkout's own
`.claude/skills/` directory. Copy the skill folder into the fork, then invoke
it there:

```bash
cp -r <raccoon-checkout>/adapters/connector-nanoclaw/skill/add-raccoon <nanoclaw-checkout>/.claude/skills/add-raccoon
```

After the copy, `/add-raccoon` is invocable in a Claude Code session inside
the NanoClaw checkout, matching their `/add-<channel>` convention.
Alternatively, a session can execute this SKILL.md directly from the raccoon
checkout path without copying — the copy just makes it discoverable like
their other channel skills.

For the steps below, set:

```bash
RACCOON_SRC=<raccoon-checkout>/adapters/connector-nanoclaw
```

## Steps

Execute these from the root of the NanoClaw checkout.

### 1. Copy the adapter artifacts into src/channels/

```bash
cp "$RACCOON_SRC/dist/raccoon.bundle.mjs"   src/channels/raccoon.bundle.mjs
cp "$RACCOON_SRC/dist/raccoon.bundle.d.mts" src/channels/raccoon.bundle.d.mts
cp -r "$RACCOON_SRC/dist/raccoon-app"       src/channels/raccoon-app
cp "$RACCOON_SRC/templates/raccoon.channel.ts" src/channels/raccoon.ts
```

The `.d.mts` declaration must sit adjacent to the bundle — the wrapper's
install-time type check resolves the bundle's types from it. `raccoon-app/`
is the built PWA the channel serves; without it there is nothing for a phone
to open.

### 2. Wire the asset copy into the fork's build

NanoClaw's production flow is `npm run build` (bare `tsc`, outDir `dist/`)
then `node dist/index.js`. `tsc` compiles `.ts` files only — it does NOT copy
`raccoon.bundle.mjs`, `raccoon.bundle.d.mts`, or the `raccoon-app/` static
directory into `dist/`. Without this step the compiled
`dist/channels/raccoon.js` fails at startup with `ERR_MODULE_NOT_FOUND` on
`./raccoon.bundle.mjs` (dev mode via `tsx src/index.ts` is unaffected, which
makes the breakage easy to miss).

Add a `postbuild` script to the fork's `package.json` — npm runs `postbuild`
automatically after every `npm run build`:

```json
"postbuild": "cp src/channels/raccoon.bundle.mjs dist/channels/ && cp -R src/channels/raccoon-app dist/channels/raccoon-app"
```

VERIFY first whether the fork's `package.json` already defines `postbuild`
(current NanoClaw main does not). If it does, append the two copies to the
existing command with `&&` instead of replacing it.

### 3. Register the channel in the barrel

Append to `src/channels/index.ts` (follow the barrel's existing comment
convention — the other channels each have a one-line import with a comment):

```ts
import './raccoon.js';
```

### 4. VERIFY the wrapper compiles against the current trunk

Run the fork's type check (typically `npx tsc --noEmit`). The explicit
`ChannelRegistration` annotation in `src/channels/raccoon.ts` is the
install-time structural check: the bundle's declared shapes must remain
assignable to THIS fork's adapter contract — `registerChannelAdapter` option
names and the `ChannelDefaults` shape (`dm` / `group` / `mentions`). If
NanoClaw's interface has moved, this file fails to compile; adjust the thin
wrapper in `src/channels/raccoon.ts` to match their current names (do not
loosen the types, and do not edit the bundle).

### 5. Append the .env block

Append the following to the checkout's `.env` and fill in the values:

```bash
# --- Raccoon channel ---
# Port for the Raccoon WebSocket hub + PWA (required)
RACCOON_PORT=4820
# Public ws:// or wss:// URL phones dial; encoded into the pairing QR (required)
RACCOON_INSTANCE_URL=ws://<host-or-lan-ip>:4820/
# HTTP origin at which AGENT CONTAINERS fetch uploaded media (required; see note below)
RACCOON_PUBLIC_ORIGIN=http://host.docker.internal:4820
# Comma-separated channel=agent-group pairs, e.g. main=default (required)
RACCOON_CHANNELS=main=default
# Bearer secret for the admin pair/revoke API (required; generate a long random string)
RACCOON_ADMIN_SECRET=<random-secret>
# Bind host for the hub (optional; unset = the hub's default bind)
# RACCOON_HOST=0.0.0.0
# Admin API port (optional; default RACCOON_PORT + 1)
# RACCOON_ADMIN_PORT=4821
# Admin API bind host (optional; default 127.0.0.1 — loopback only; never inherits RACCOON_HOST)
# RACCOON_ADMIN_HOST=127.0.0.1
# Instance name shown to paired devices (optional; default nanoclaw)
# RACCOON_INSTANCE=nanoclaw
# Directory for sessions + media blobs (optional; default ./data/raccoon)
# RACCOON_DATA_DIR=./data/raccoon
# Park timeout for a chat turn in ms; slower replies arrive via async fallback (optional; default 90000)
# RACCOON_TURN_TIMEOUT_MS=90000
# Web-push for offline notification (optional; all three or none)
# VAPID_PUBLIC_KEY=
# VAPID_PRIVATE_KEY=
# VAPID_SUBJECT=mailto:you@example.com
```

`RACCOON_PUBLIC_ORIGIN` must be reachable FROM INSIDE the agent containers,
not just from the host: on Docker Desktop or Apple Container use
`http://host.docker.internal:<port>`; on Linux use the host's LAN IP.
Getting this wrong does not break chat — it breaks agents fetching
phone-uploaded media.

If any of the five required vars is missing, the factory returns null and
NanoClaw skips the channel (their graceful-skip convention). A present but
malformed value throws at startup instead — misconfiguration is loud.

### 6. Rebuild, verify the layout, and restart the host

Run the fork's build and confirm the assets landed next to the compiled
wrapper:

```bash
npm run build
ls dist/channels/raccoon.bundle.mjs dist/channels/raccoon-app/index.html
```

Both paths must exist — if either is missing, revisit step 2 (the
`postbuild` wiring did not run or did not copy).

Restart the NanoClaw host process. Confirm from the logs that the `raccoon`
channel registered and its hub is listening on `RACCOON_PORT` — or, if it
was skipped, which required variable was missing.

### 7. Pair the first device

```bash
curl -X POST \
  -H "Authorization: Bearer $RACCOON_ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"userId":"<owner-id>"}' \
  http://127.0.0.1:<admin-port>/pair
```

The response contains `token`, `payload`, and `qr`. The QR encodes a raw
JSON pairing payload (the instance URL plus the one-time token), NOT an http
link — a phone camera cannot "open" it. The flow is app-first:

1. On the phone, open the served PWA in the browser:
   `http(s)://<host>:<RACCOON_PORT>/`. (Phones other than localhost need
   HTTPS — see the deployment note in the connector README.)
2. In the app's pairing screen, either scan the QR (`qr` is a
   terminal-renderable string — print it, or render `payload` with any QR
   tool) or tap "Enter code manually" and paste the `payload` string.

The app then connects to `RACCOON_INSTANCE_URL` with the token and stores
the granted session.

### 8. Wire the owner's conversations

Adapters never write NanoClaw's database — use NanoClaw's own surfaces.

**Deterministic primary path** — for each `channel=agent-group` pair in
`RACCOON_CHANNELS`, run NanoClaw's wiring surface to create the
`messaging_group` bound to that agent group, with:

- `channel_type` = `raccoon`
- `platform_id` = `<channel>:<owner-id>` (for example `main:owner`)
- `instance` = the raccoon instance name (`RACCOON_INSTANCE`, default
  `nanoclaw`)

Locate the current wiring command by reading the fork's `src/cli/` (`ncl`)
and `scripts/init-first-agent.ts` — their trunk moves, so this skill
instructs finding it rather than hardcoding a stale invocation. Once found,
record the exact invocation you used in your install notes so future
channel additions can pin it.

**Fallback path** — when no wiring CLI fits the fork you are on: send a
first message from the paired phone and approve the owner registration card
NanoClaw raises. The adapter flags DMs as mentions (`mentions: 'dm-only'`),
so the router escalates unwired conversations to the owner instead of
dropping them. This requires a working owner approval channel (such as their
CLI channel) to receive and approve the registration.

Finally, grant the owner role (`user_roles`) per NanoClaw's docs so the
paired identity has owner privileges.

## Uninstall

1. Remove the four copied paths:
   `src/channels/raccoon.bundle.mjs`, `src/channels/raccoon.bundle.d.mts`,
   `src/channels/raccoon-app/`, `src/channels/raccoon.ts`.
2. Remove the `import './raccoon.js';` line from `src/channels/index.ts`.
3. Remove the raccoon copies from the `postbuild` script in `package.json`
   (or the whole script if it only contained them), and delete the copied
   outputs `dist/channels/raccoon.bundle.mjs` and `dist/channels/raccoon-app/`.
4. Remove the Raccoon block from `.env`.
5. If you copied the skill: remove `.claude/skills/add-raccoon/`.

Pairing sessions and media live under `RACCOON_DATA_DIR` (default
`./data/raccoon`) — delete that directory too if you want a clean slate.
