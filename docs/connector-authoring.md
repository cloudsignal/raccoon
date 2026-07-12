# Authoring a connector

A **connector** joins an agent framework to Raccoon. It implements a small set
of public ports and never reaches into another package's `src/`. This is how
the first-party OpenClaw connector is built, and how a second connector — or a
managed transport like a hosted identity/push service — plugs in **without any
change to the core packages**.

## Package boundaries

```
                       ┌───────────────────────────────────────────────┐
                       │                    CORE                        │
                       │        (vendor-neutral, published v0.1)        │
                       │                                                │
   ┌───────────┐       │  @raccoon/protocol   OAM envelopes + codec     │
   │  PWA /     │◀──────▶  @raccoon/transport-ws   WsHub + WsClient      │
   │  client    │  WS   │  @raccoon/bridge     RaccoonBridge + ports     │
   └───────────┘       │  @raccoon/pairing    QR issue / verify         │
                       │  @raccoon/push       VAPID / Web Push (opt)     │
                       │  @raccoon/app        installable chat PWA       │
                       └───────────────────────────────────────────────┘
                             ▲                         ▲
              implements     │ AgentRunner             │ AgentRunner
              public ports   │                         │
                       ┌─────┴─────────┐        ┌──────┴──────────────┐
                       │ CONNECTOR     │        │ CONNECTOR / TRANSPORT│
                       │ (first-party) │        │ (out of core)        │
                       │               │        │                      │
                       │ @raccoon/     │        │ e.g. a GTM / hosted  │
                       │ connector-    │        │ identity+push build  │
                       │ openclaw      │        │ (own repo, own deps) │
                       │  → openclaw   │        │  → CloudSignal, etc. │
                       └───────────────┘        └──────────────────────┘
```

Rules the boundary enforces (checked in CI by `scripts/gate-neutrality.sh`):

- **Core never names a vendor.** No `@cloudsignal`, `cloudsignal`, `gtm`, or
  `supabase` identifier appears anywhere in core runtime source. Core builds,
  tests, and releases with none of them installed.
- **No package imports another via `/src`.** Consumers import package roots
  (`@raccoon/bridge`), never `@raccoon/bridge/src/...`. Every published package
  ships `dist/` + emitted `.d.ts` and an `exports` map.
- **A connector's framework is its own peer dependency.** `openclaw` is a peer
  dep of `@raccoon/connector-openclaw`; no OpenClaw type leaks into core.
- **Managed transports live outside the v0.1 gate.** `@raccoon/transport-mqtt`
  and `@raccoon/transport-cloudsignal` are `private` and are not part of the
  released core. A CloudSignal/GTM build consumes the public ports below from
  its own repo.

## The public ports

Everything a connector needs is exported from a package root.

### `AgentRunner` — the framework seam (`@raccoon/bridge`)

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
> cross-restart exactly-once — a redelivery after a restart with a fresh
> in-memory store can re-run a turn. Supply a durable `MessageStore` (and, if
> you need it, a durable dedup layer) to harden this. v0.1 does not ship one.

### `Transport` / `WsHub` / `WsClientTransport` (`@raccoon/protocol`, `@raccoon/transport-ws`)

`Transport` (protocol) is the client-side contract the PWA speaks. `WsHub` is
the zero-dependency server; `WsClientTransport` is its client. A connector that
uses a different wire (a broker, a managed service) implements `Transport` and
a compatible hub — the bridge and app don't care which.

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

## Worked example — the OpenClaw connector

`@raccoon/connector-openclaw` implements exactly the ports above:

- **`buildRaccoonInboundRunner(opts)`** returns an `AgentRunner` that drives
  OpenClaw's real inbound pipeline (`dispatchReplyFromConfigWithSettledDispatcher`)
  and yields the agent's reply.
- **`createRaccoonChannel(opts)`** composes `WsHub` + `RaccoonBridge` +
  pairing + optional push into a start/stoppable channel. `opts.sessionStore`
  takes any `CredentialStore` for restart durability.
- **`createRaccoonOutbound(deps)`** maps OpenClaw's `MessagePresentation`
  approval prompts to OAM `approval.request` envelopes and correlates the
  Allow/Deny/Edit response back to the real command via an approval-value store.

No OpenClaw type crosses into core; `openclaw` is a peer dependency of the
connector only. The end-to-end workflow (pair → message → streamed reply →
approval Allow/Deny/Edit → reconnect → connector restart → unpair) is covered by
`adapters/connector-openclaw/src/openclaw-e2e.test.ts`, driven against the real
published OpenClaw types.

## A second connector, outside core

Because the ports are all root exports, a connector in a **separate repo** with
its **own dependencies** needs nothing from core beyond an install:

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
NAT-relay service such as CloudSignal, or the GTM build that uses it) plugs in:
it implements the same public ports — `Transport`, `OutboundHub`, a durable
`MessageStore` and `CredentialStore`, and (optionally) a push registrar — from
its own repository. Core exports the ports; the managed build implements them.
Nothing about that build lives in, or is referenced by, the released core.
