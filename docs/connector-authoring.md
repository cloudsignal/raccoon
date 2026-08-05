# Authoring a connector

A **connector** joins an agent framework to Raccoon. It implements a small set
of public ports and never reaches into another package's `src/`. This is how
both first-party connectors are built - `@raccoon/connector-openclaw` (an
OpenClaw runtime plugin) and `@raccoon/connector-nanoclaw` (an embedded
endpoint inside NanoClaw's host process) - and how a third connector, or a
managed transport like a hosted identity/push service, plugs in **without any
change to the core packages**.

## Package boundaries

```
                       ┌───────────────────────────────────────────────┐
                       │                    CORE                        │
                       │        (vendor-neutral, published v0.1)        │
                       │                                                │
   ┌───────────┐       │  @raccoon/protocol   envelopes + codec         │
   │  PWA /     │◀──────▶  @raccoon/transport-ws   WsHub + WsClient      │
   │  client    │  WS   │  @raccoon/bridge     RaccoonBridge + ports     │
   └───────────┘       │  @raccoon/pairing    QR issue / verify         │
                       │  @raccoon/push       VAPID / Web Push (opt)     │
                       │  @raccoon/app        installable chat PWA       │
                       └───────────────────────────────────────────────┘
                             ▲                         ▲
              implements     │ AgentRunner             │ AgentRunner
              public ports   │                         │
                       ┌─────┴─────────────┐    ┌──────┴──────────────┐
                       │ CONNECTORS        │    │ CONNECTOR / TRANSPORT│
                       │ (first-party)     │    │ (out of core)        │
                       │                   │    │                      │
                       │ @raccoon/         │    │ e.g. a hosted        │
                       │ connector-openclaw│    │ identity+push build  │
                       │  → openclaw       │    │ (own repo, own deps) │
                       │ @raccoon/         │    │  → a managed service │
                       │ connector-nanoclaw│    │                      │
                       │  → a nanoclaw fork│    │                      │
                       └───────────────────┘    └──────────────────────┘
```

Rules the boundary enforces (checked in CI by `scripts/gate-neutrality.sh`):

- **Core never names a vendor.** No downstream-vendor identifier appears
  anywhere in core runtime source, comments included - CI enforces a denylist
  (`scripts/gate-neutrality.sh`). Core builds, tests, and releases with no
  vendor package installed.
- **No package imports another via `/src`.** Consumers import package roots
  (`@raccoon/bridge`), never `@raccoon/bridge/src/...`. Every published package
  ships `dist/` + emitted `.d.ts` and an `exports` map.
- **A connector's framework is its own dependency.** `openclaw` is a peer
  dep of `@raccoon/connector-openclaw`; NanoClaw is not published as a
  library, so `@raccoon/connector-nanoclaw` vendors transcribed NanoClaw
  types (`src/nanoclaw-types.ts`) instead of importing a package. Either way,
  no framework type leaks into core.
- **Managed transports live outside the v0.1 gate.** The repo's private
  transport experiments (an MQTT broker transport and a managed-service
  transport) are not part of the released core. A vendor build consumes the
  public ports below from its own repo.

## The public ports

Everything a connector needs is exported from a package root.

### `AgentRunner` - the framework seam (`@raccoon/bridge`)

The one interface every connector implements:

```ts
interface AgentContext {
  userId: string;
  channel: string;
  text: string;
  messageId: string;
  // Present when this turn answers an approval.request. `text` is the edited
  // text or chosen option; `approval` carries the original request id + choice.
  approval?: { refId: string; choice: string; editedText?: string };
}

interface AgentRunner {
  run(ctx: AgentContext): AsyncIterable<string>; // yield reply text deltas
}
```

The bridge shows a typing indicator while iterating, concatenates the deltas,
and delivers one `msg` envelope. Runners that don't model approvals ignore
`ctx.approval` and treat every turn as plain text. To signal a **safe-to-retry**
failure (nothing durable happened), throw `RetryableTurnError`; any other throw
is treated as unknown-outcome and is not offered for one-tap retry.

### `RaccoonBridge` + `MessageStore` (`@raccoon/bridge`)

`RaccoonBridge` wires a runner to any hub that satisfies `OutboundHub`
(`sendToUser` + `onEnvelope`). It owns acks, typing, history replay, per-message
dedup, and the approval turn lifecycle. Persistence is a port:

```ts
interface MessageStore {
  append(m: StoredMessage): Promise<void>;
  page(channel: string, opts: { userId: string; before?: string; limit: number })
    : Promise<{ messages: HistoryMessage[]; nextBefore?: string }>;
}
```

`InMemoryMessageStore` ships for dev; supply your own for durable history.

> **Honest limitation:** the bridge's dedup is **process-local**. It guarantees
> at-most-once turn execution within one running process. It does **not** claim
> cross-restart exactly-once - a redelivery after a restart with a fresh
> in-memory store can re-run a turn. Supply a durable `MessageStore` (and, if
> you need it, a durable dedup layer) to harden this. v0.1 does not ship one.

### `Transport` / `WsHub` / `WsClientTransport` (`@raccoon/protocol`, `@raccoon/transport-ws`)

`Transport` (protocol) is the client-side contract the PWA speaks. `WsHub` is
the zero-dependency server; `WsClientTransport` is its client. A connector that
uses a different wire (a broker, a managed service) implements `Transport` and
a compatible hub - the bridge and app don't care which.

### `CredentialStore` (`@raccoon/transport-ws`)

Backs pairing + session resume. `MemoryCredentialStore` is the default;
**it does not survive a process restart**. Supply a persistent `CredentialStore`
so confirmed sessions outlive a restart and reconnecting clients resume rather
than re-pair. Session durability is the deployment's responsibility.

### Pairing (`@raccoon/pairing`)

`issuePairing(hub, { userId, instanceUrl }) → { token, payload, qr }` and
`revokePairing(hub, userId)`. `buildPairingPayload` / `parsePairingPayload`
handle the QR payload format.

### App embedding (`@raccoon/app`)

`App`, `TransportProvider`, `UpdateGate`, `useChat`, `createHttpPushRegistrar`,
and the `Session` type are the host-embedding surface. A host supplies its own
authenticated transport via `transportOverride` (+ `sessionOverride`) or the
pairing flow via `makeTransport`. The reusable provider/UI surface is separate
from the standalone WebSocket composition, so an embedded host does not inherit
server-only or unconditional-WS exports.

## Worked examples - the first-party connectors

The two first-party connectors prove the seam from opposite directions:

- **Plugin-hosted (OpenClaw).** The framework loads the connector: OpenClaw's
  gateway owns the process and lifecycle, and the connector drives the
  framework's own pipeline (inbound dispatch, outbound adapter, approval
  capability) from inside its plugin surface. Distribution is a plugin
  install (`openclaw plugins install`).
- **Embedded-endpoint (NanoClaw).** The connector brings the endpoint to the
  framework: it composes `WsHub` + `RaccoonBridge` inside NanoClaw's own host
  process as one of its channel adapters. NanoClaw has no plugin loader, so
  distribution is a self-contained bundle plus the `add-raccoon` install
  skill applied to a NanoClaw fork.

Either direction uses only the public ports above; core does not know which
side hosts whom.

### Plugin-hosted: the OpenClaw connector

`@raccoon/connector-openclaw` implements exactly the ports above:

- **`buildRaccoonInboundRunner(opts)`** returns an `AgentRunner` that drives
  OpenClaw's real inbound pipeline (`dispatchReplyFromConfigWithSettledDispatcher`)
  and yields the agent's reply.
- **`createRaccoonChannel(opts)`** composes `WsHub` + `RaccoonBridge` +
  pairing + optional push into a start/stoppable channel. `opts.sessionStore`
  takes any `CredentialStore` for restart durability.
- **`createRaccoonOutbound(deps)`** maps OpenClaw's `MessagePresentation`
  approval prompts to `approval.request` envelopes and correlates the
  Allow/Deny/Edit response back to the real command via an approval-value store.

No OpenClaw type crosses into core; `openclaw` is a peer dependency of the
connector only. The end-to-end workflow (pair → message → reply →
approval Allow/Deny/Edit → reconnect → connector restart → unpair) is covered by
`adapters/connector-openclaw/src/openclaw-e2e.test.ts`, driven against the real
published OpenClaw types.

### Embedded-endpoint: the NanoClaw connector

`@raccoon/connector-nanoclaw` composes the same ports from the other side:

- **`createRaccoonChannelAdapter(deps)`** builds the NanoClaw
  `ChannelAdapter`. The factory returns null when required configuration is
  missing (NanoClaw's graceful-skip convention) and throws on a present but
  malformed value.
- **`createRaccoonEndpoint(opts)`** composes `WsHub` + `RaccoonBridge` +
  pairing + optional push inside the host process (each connector owns its
  composition copy - connectors never depend on each other) and adds
  `sendAgentEnvelope`, the history-recording, media-referencing outbound seam
  for adapter-initiated sends.
- **`buildNanoClawRunner(deps)`** returns the `AgentRunner`: it forwards each
  user turn into NanoClaw's host callbacks and parks awaiting the matching
  `deliver()`, serialized per conversation. A park that times out yields
  nothing; the late reply flows out asynchronously through
  `sendAgentEnvelope`, so nothing is dropped.
- **Distribution** is a self-contained bundle plus an install skill
  (`npm run bundle:nanoclaw`, then `skill/add-raccoon/SKILL.md` applied
  inside a NanoClaw fork), because the host has no plugin loader to hand the
  connector to.

No NanoClaw type crosses into core. NanoClaw is not published as a library,
so the connector vendors transcribed types (`src/nanoclaw-types.ts`) rather
than declaring a dependency; the install skill's compile check validates the
thin wrapper against the fork's current trunk at install time. The adapter
contract is covered by `adapters/connector-nanoclaw/src/nanoclaw-e2e.test.ts`
and a post-`tsc` layout simulation (`src/dist-layout.test.ts`).

## A second connector, outside core

`@raccoon/connector-nanoclaw` is the in-repo proof of the second-connector
story: it shipped without any change to the core packages. The same shape
works for a third party. Because the ports are all root exports, a connector
in a **separate repo** with its **own dependencies** needs nothing from core
beyond an install:

```ts
// @acme/connector-myframework  (hypothetical, its own package)
import { RaccoonBridge, InMemoryMessageStore, type AgentRunner } from '@raccoon/bridge';
import { WsHub } from '@raccoon/transport-ws';
import { myFramework } from 'myframework'; // this connector's peer dep

export function createMyChannel(opts: { port: number }) {
  const runner: AgentRunner = {
    async *run(ctx) {
      for await (const delta of myFramework.stream(ctx.text)) yield delta;
    },
  };
  const hub = new WsHub({ instance: 'acme', channels: ['assistant'], port: opts.port });
  const bridge = new RaccoonBridge({ hub, runner, store: new InMemoryMessageStore() });
  return { hub, start: async () => { await hub.start(); bridge.start(); } };
}
```

The same shape is how a **managed transport** (a hosted identity + ACL + push +
NAT-relay service) plugs in:
it implements the same public ports - `Transport`, `OutboundHub`, a durable
`MessageStore` and `CredentialStore`, and (optionally) a push registrar - from
its own repository. Core exports the ports; the managed build implements them.
Nothing about that build lives in, or is referenced by, the released core.

## Adapter conformance

What a conforming connector must do, distilled from what the two first-party
connectors actually implement:

- **Implement `AgentRunner`.** `run(ctx)` returns an async iterable that
  yields the reply text; honor `ctx.approval` when the framework models
  approvals. Throw `RetryableTurnError` only for failures where nothing
  durable happened; any other throw is treated as unknown-outcome and is not
  offered for one-tap retry.
- **User-visible failure over silent success.** A turn that cannot be applied
  must say so in the chat, never complete empty as if accepted. Both
  connectors follow this: the OpenClaw connector yields a plain error line
  when an approval cannot be submitted over the gateway; the NanoClaw
  connector replies with a notice when an approval mapping is lost and
  appends an "[N of M attachments could not be transferred]" line when
  outbound media saves fail.
- **Durable `CredentialStore`.** Confirmed sessions must survive a process
  bounce so paired devices resume instead of re-pairing. Both connectors back
  sessions with `FileCredentialStore` (`sessions.json`) and release its lock
  on stop; a failed start releases it too.
- **Record agent-initiated sends.** Outbound messages belong in the
  `MessageStore` with their attachments permanently referenced - otherwise
  history replay lies and the media sweep can delete blobs a delivered
  message points at. The bridge does both for turn replies; adapter-initiated
  sends need their own seam. The NanoClaw connector's `sendAgentEnvelope`
  (history append + media reference + the push-wrapped hub, never a bare
  `hub.sendToUser`) is the reference.
- **Approval mapping.** Show human-readable labels, remember the
  label-to-value correlation scoped to the user the card was sent to, and
  return the framework's expected value on a tap. On lost correlation
  (restart, eviction, expiry) fail closed - never guess a value - and tell
  the user (see the user-visible-failure rule).
- **Lifecycle.** Startup is fail-clean: a partial start (port bound, store
  lock taken) tears down everything it created and publishes nothing.
  Teardown releases every resource (listeners, hub, store locks) in reverse
  order, and a restart on the same data directory re-acquires them.
- **Neutrality.** No framework type crosses into core; the framework is the
  connector's own dependency (`openclaw` as a peer dependency; NanoClaw as
  vendored transcribed types, since it is not published as a library). CI
  enforces the vendor denylist (`scripts/gate-neutrality.sh`).
