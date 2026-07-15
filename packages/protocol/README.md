# @raccoon/protocol

Envelope types, schemas, and codec for the [Raccoon](https://github.com/cloudsignal/raccoon)
protocol — the vendor-neutral wire format a Raccoon hub, app, and connectors
speak. Zod-validated envelopes (`msg`, acks/ticks, `approval.request` /
`approval.response`, pairing, presence), address helpers, topic builders, and
the QR pairing-payload format.

```bash
# repo-first (not yet on the public npm registry) — install the packed tarball:
#   git clone https://github.com/cloudsignal/raccoon && cd raccoon && npm ci && npm run release:pack
npm i /path/to/raccoon/release-artifacts/raccoon-protocol-0.1.0.tgz
```

```ts
import { createEnvelope, parseEnvelope, userAddress, PROTOCOL_VERSION } from '@raccoon/protocol';

const env = createEnvelope('msg', {
  from: 'agent:coordinator',
  to: userAddress('alice'),        // 'user:alice'
  channel: 'coordinator',
  payload: { text: 'hello' },
});
// env.raccoon === PROTOCOL_VERSION ('0.1'); env.id is a ULID; env.ts is ISO 8601

const parsed = parseEnvelope(JSON.parse(wireJson)); // throws on invalid
```

- `createEnvelope(kind, fields)` — mint a valid envelope (id, ts, version).
- `parseEnvelope` / `tryParseEnvelope` — validate inbound JSON (throwing / null-returning).
- `userAddress` / `agentAddress` — build `user:<id>` / `agent:<id>` addresses.
- `topicUserInbox` / `topicUserOutbox` / `topicUserPresence` — topic builders
  used by transports.
- `buildPairingPayload` / `parsePairingPayload` — the QR payload a device scans.

The full wire format is specified in
[PROTOCOL.md](https://github.com/cloudsignal/raccoon/blob/main/PROTOCOL.md).

MIT © the Raccoon contributors.
