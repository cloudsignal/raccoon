# @raccoon/connector-nanoclaw

NanoClaw channel connector for Raccoon: it embeds the raccoon endpoint —
WebSocket hub, device pairing, and the Raccoon PWA — inside the NanoClaw host
process as a `ChannelAdapter`, shipped as a single self-contained bundle plus
an `add-raccoon` install skill. Paired phones get a browser-installable
messenger that talks to NanoClaw agents: chat turns, typing indicators,
approval cards for agent questions, and media in both directions. NanoClaw is
the open-source agent host at [github.com/nanocoai/nanoclaw](https://github.com/nanocoai/nanoclaw);
this connector targets its channel-adapter surface and never writes its
database.

## Distribution status

The fork-droppable artifacts (`dist/raccoon.bundle.mjs`,
`dist/raccoon.bundle.d.mts`, `dist/raccoon-app/`) are built from a source
checkout of this repo: `npm run bundle:nanoclaw` at the repo root (shorthand
for `npm run build:app && npm run bundle -w @raccoon/connector-nanoclaw`).
They are NOT part of the release-pack tarballs — the release pipeline packs
the published npm set only and never runs the bundle script.

## Architecture

- **Per-conversation serialized turns.** Each inbound phone message opens a
  turn that parks awaiting the matching `deliver()` from the host; a
  per-conversation mutex serializes turns so two rapid messages can never
  receive each other's replies.
- **Park with timeout.** A reply arriving within `RACCOON_TURN_TIMEOUT_MS`
  settles the parked turn and returns as the bridge's synchronous reply to
  the phone.
- **Async fallback.** A park that times out yields nothing — and the late
  `deliver()` then flows out through `sendAgentEnvelope`, the
  history-recording, push-aware outbound seam. Nothing is dropped; slow
  agents just answer asynchronously.
- **Bridge deadline margin.** The bridge's own turn deadline is set to the
  park timeout plus 30 seconds, so the bridge never acks `stalled` to the
  phone before the connector's silent fallback can take over.
- **Approval cards with label-to-value correlation.** An agent question
  becomes an approval-card envelope; the option labels shown on the phone are
  remembered against their underlying values, and a tap resolves the label
  back to the VALUE before it reaches the agent. If the mapping is lost
  (restart, eviction), the connector fails closed — it never guesses a value
  — and replies with a visible notice asking the user to have the agent
  re-send the question.
- **Offline buffering.** Approval cards for a disconnected phone are buffered
  (capped per user) and replayed when the next inbound envelope proves the
  socket is live again — push fallback would degrade a card to notification
  text, so the raw envelope is replayed instead. Plain text sent while
  offline lands in history and may still notify via web push.

## Configuration

All configuration is environment variables. If any **required** variable is
missing, the factory returns null and NanoClaw skips the channel; a present
but malformed value throws at startup.

| Variable | Required | Default | Meaning |
| --- | --- | --- | --- |
| `RACCOON_PORT` | yes | — | Port for the WebSocket hub + PWA. `0` binds an ephemeral port (tests, containers behind port maps). |
| `RACCOON_INSTANCE_URL` | yes | — | Public `ws://` / `wss://` URL phones dial; encoded into the pairing QR. |
| `RACCOON_PUBLIC_ORIGIN` | yes | — | HTTP origin at which agent containers fetch uploaded media (trailing slashes stripped). Must be reachable from inside the containers, not just the host. |
| `RACCOON_CHANNELS` | yes | — | Comma-separated `channel=agent-group` pairs. The agent-group side is install-time wiring input only; the runtime adapter uses just the channel names. |
| `RACCOON_ADMIN_SECRET` | yes | — | Bearer secret for the admin pair/revoke API. |
| `RACCOON_HOST` | no | hub default bind | Bind host for the hub port. |
| `RACCOON_ADMIN_PORT` | no | `RACCOON_PORT + 1` | Port for the admin pair/revoke listener. |
| `RACCOON_ADMIN_HOST` | no | `127.0.0.1` | Bind host for the admin listener. Loopback by default, and it **never inherits `RACCOON_HOST`** — exposing the hub to `0.0.0.0` must not silently expose pair/revoke. |
| `RACCOON_INSTANCE` | no | `nanoclaw` | Instance name shown to paired devices and used as the `instance` field on the adapter's `messaging_groups` wiring. |
| `RACCOON_DATA_DIR` | no | `./data/raccoon` | Directory for the pairing session store (`sessions.json`) and uploaded media blobs (`media/`). |
| `RACCOON_TURN_TIMEOUT_MS` | no | `90000` | Park timeout for a chat turn, in milliseconds. Slower replies still arrive via the async fallback. |
| `VAPID_PUBLIC_KEY` | no | — | Web-push key for offline notification. All three VAPID vars must be set together or push stays off. |
| `VAPID_PRIVATE_KEY` | no | — | Web-push private key. |
| `VAPID_SUBJECT` | no | — | Web-push subject (`mailto:` or URL). |

## Admin API: pair and revoke

The admin listener is a separate loopback-bound HTTP server (the hub exposes
no custom-route hook). Both routes are `POST`, authenticated with
`Authorization: Bearer $RACCOON_ADMIN_SECRET` (compared constant-time).

Pair a device — returns `{ token, payload, qr }`. The QR encodes a raw JSON
pairing payload (instance URL + one-time token), not an http link, so a
phone camera cannot open it directly. Pairing is app-first: open the served
PWA in the phone's browser (`http(s)://<host>:<RACCOON_PORT>/`), then use
the app's own pairing screen — scan the QR from within the app, or paste the
`payload` string via "Enter code manually":

```bash
curl -X POST \
  -H "Authorization: Bearer $RACCOON_ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"userId":"owner"}' \
  http://127.0.0.1:4821/pair
```

Revoke a user — clears push subscriptions, then revokes the pairing:

```bash
curl -X POST \
  -H "Authorization: Bearer $RACCOON_ADMIN_SECRET" \
  -H "content-type: application/json" \
  -d '{"userId":"owner"}' \
  http://127.0.0.1:4821/revoke
```

### Deployment note: phones need HTTPS/WSS

Away from localhost (which browsers exempt as a secure context), the PWA's
service-worker install and web push both require HTTPS, and the socket then
must be WSS. The expected production shape is a reverse proxy terminating
TLS in front of `RACCOON_PORT`, with `RACCOON_INSTANCE_URL` set to the
public `wss://` URL. Plain `http://<lan-ip>:<port>` still loads the chat UI
for quick LAN tests, but installability and push stay off.

## How new users get wired

The adapter never writes NanoClaw's database. It declares
`mentions: 'dm-only'` in its channel defaults and stamps every inbound DM
with `isMention: true` — raccoon chats are DMs, and NanoClaw's router only
runs its auto-create/registration flow for unwired conversations on
mentions. The effect: a message from a paired-but-unwired user is escalated
to the owner as a registration-approval request through NanoClaw's own flow,
instead of being silently dropped. The owner approves (via any working
owner channel), NanoClaw creates the conversation wiring itself, and
subsequent messages route normally. Deterministic wiring for the owner's own
conversations is done at install time through NanoClaw's CLI surfaces — see
the `add-raccoon` skill (`skill/add-raccoon/SKILL.md`), which also covers
role grants.

## Verifying against a real NanoClaw install

Manual end-to-end checklist. Automated tests cover the adapter against a
simulated host (including a post-`tsc` layout simulation,
`src/dist-layout.test.ts`, that proves the copied bundle serves the PWA from
`dist/channels/`); this list is what to confirm against the real thing.

An opt-in scripted rehearsal of the install's file steps exists at
`scripts/verify-nanoclaw-install.sh`: it clones NanoClaw shallow into a temp
dir (or copies an existing checkout passed as `$1`), applies the skill's
copy/barrel/.env/postbuild steps mechanically, runs their install and build,
boots `node dist/index.js`, and curls the raccoon port for the PWA's
`index.html`. It is NOT run by CI or vitest — it needs network access,
NanoClaw's toolchain, and a checkout that can boot far enough to register
channels.

1. Clone `github.com/nanocoai/nanoclaw` and get it running per its README
   (at least one agent, owner approval channel working).
2. Build the connector deliverables in a raccoon checkout
   (`npm install && npm run bundle:nanoclaw`),
   then run the `add-raccoon` skill in the NanoClaw checkout. The skill also
   wires a `postbuild` copy step into the fork's `package.json` — NanoClaw's
   bare-`tsc` build does not copy the bundle or the PWA into `dist/`, so
   after `npm run build` confirm `dist/channels/raccoon.bundle.mjs` and
   `dist/channels/raccoon-app/index.html` both exist before
   `node dist/index.js`.
3. Pair a phone via the admin API (see the pairing flow above: open the
   served PWA on the phone first, then scan or paste from inside the app).
4. Verify **(a) chat turn round-trip**: send a message from the phone; the
   agent's reply arrives in the same turn, with a typing indicator while it
   thinks.
5. Verify **(b) async fallback**: ask something that takes longer than
   `RACCOON_TURN_TIMEOUT_MS` (or set the timeout low). The turn ends
   silently, and the reply still arrives moments later as a fresh message.
6. Verify **(c) approval cards**: have the agent call `ask_user_question`.
   The question renders as an approval card on the phone, and tapping an
   option delivers that option's underlying VALUE (not its label) to the
   agent.
7. Verify **(d) inbound media**: send a photo from the phone; the agent can
   fetch it from inside its container (this exercises
   `RACCOON_PUBLIC_ORIGIN` — the common failure is an origin only the host
   can reach).
8. Verify **(e) outbound files**: have the agent write a file to its outbox;
   it arrives on the phone as an attachment.
9. Verify **(f) restart resilience**: restart the NanoClaw host. The phone
   reconnects and resumes without re-pairing (sessions persist in
   `RACCOON_DATA_DIR/sessions.json`).

## Limitations (v1)

- **The fork's build needs the postbuild copy step.** NanoClaw's production
  build is bare `tsc`, which compiles `.ts` only — the install must wire a
  `postbuild` script that copies `raccoon.bundle.mjs` and `raccoon-app/`
  into `dist/channels/` (the add-raccoon skill does this). Without it,
  `node dist/index.js` fails with `ERR_MODULE_NOT_FOUND` on the bundle while
  dev mode (`tsx src/index.ts`) works, masking the breakage.
- **In-memory message history.** The endpoint's message store does not
  survive a restart — pairing sessions persist (`sessions.json`), chat
  history does not. Buffered offline approval cards are also lost on
  restart, in which case a later tap fails closed with a user-visible
  notice.
- **Single NanoClaw instance per adapter.** One adapter instance embeds one
  endpoint bound to one host process; there is no multi-instance fan-out.
- **Outbound kinds.** Approval cards, text, and file attachments are
  delivered; any other non-card, non-text outbound kind is logged and
  skipped.

## VERIFY notes

Remaining unknowns against NanoClaw's moving trunk, and where each is
isolated so a mismatch stays cheap to fix:

- **Skill fixture engine.** The install-time compile check assumes the
  fork's `registerChannelAdapter` option names and `ChannelDefaults` shape.
  Isolated to the thin wrapper `templates/raccoon.channel.ts` (installed as
  `src/channels/raccoon.ts`) and the declared types in
  `templates/raccoon.bundle.d.mts` / `src/nanoclaw-types.ts` — a drift shows
  up as a compile failure in the wrapper, and the fix lives there, not in
  the bundle.
- **Port-binding adapter under their host supervision.** The adapter owns
  two listening sockets (hub + admin) inside NanoClaw's process; how their
  supervisor treats a channel that binds ports (restart ordering, crash
  handling) is unverified. Isolated to the single fail-clean boundary in
  `src/adapter.ts` `setup()` / `teardown()` — everything starts there and is
  closed in reverse order on any failure, so the adapter is never observable
  half-started.
- **Container-reachable media mechanism.** Agents fetch phone-uploaded media
  over HTTP at `RACCOON_PUBLIC_ORIGIN`; whether that origin resolves from
  inside a given container runtime is deployment-dependent. Isolated to
  `src/media.ts` (path absolutization and attachment mapping) plus the one
  env value — checklist item (d) is the probe.
