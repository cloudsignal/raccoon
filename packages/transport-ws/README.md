# @raccoon/transport-ws

[Raccoon](https://github.com/cloudsignal/raccoon)'s built-in WebSocket
transport — broker-free: no external message broker or cloud service, just a
Node server. One package carries both sides:

- **`WsHub`** (server): WebSocket hub + plain-HTTP static serving for the
  Raccoon PWA, QR pairing with revocable bearer sessions, per-user routing,
  and hardening (hello timeouts, pending-connection caps, payload limits,
  pairing rate limits, provisional-socket gating).
- **`WsClientTransport`** (client, browser-safe): connect by pairing token or
  resumable session, auto-reconnect with backoff, and the `Transport`
  interface the Raccoon app consumes.

```bash
# repo-first (not yet on the public npm registry) — install the packed tarball:
#   git clone https://github.com/cloudsignal/raccoon && cd raccoon && npm ci && npm run release:pack
npm i /path/to/raccoon/release-artifacts/raccoon-transport-ws-0.1.0.tgz
```

```ts
import { WsHub } from '@raccoon/transport-ws';

const hub = new WsHub({
  instance: 'my-agent',
  channels: ['assistant'],
  staticDir: '/abs/path/to/@raccoon/app/dist-standalone', // optional: serve the PWA
});
const { port } = await hub.start();
```

```ts
import { WsClientTransport } from '@raccoon/transport-ws';

const client = new WsClientTransport({ url: 'wss://raccoon.example.com/', pairingToken });
client.onEnvelope((env) => console.log(env));
await client.connect();
```

Sessions persist across restarts with a pluggable `CredentialStore`:
`MemoryCredentialStore` (default) or `FileCredentialStore` (atomic writes,
single-writer lock). Production requires TLS termination in front of the hub
(`wss://`) — see the repo's
[security notes](https://github.com/cloudsignal/raccoon/blob/main/docs/security.md)
and [hosting examples](https://github.com/cloudsignal/raccoon/tree/main/examples/hosting).

MIT © the Raccoon contributors.
