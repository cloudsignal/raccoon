# @raccoon/pairing

QR device pairing for [Raccoon](https://github.com/cloudsignal/raccoon):
mint a single-use pairing token on a hub and render the payload + terminal QR
a device scans (or pastes) in the Raccoon app's setup screen.

```bash
npm install @raccoon/pairing
```

```ts
import { issuePairing } from '@raccoon/pairing';

const { token, payload, qr } = await issuePairing(hub, {
  userId: 'alice',
  instanceUrl: 'wss://raccoon.example.com/',
});
console.log(qr);      // ANSI QR for the terminal
console.log(payload); // raccoon pairing payload (paste-able alternative)
```

Tokens are single-use and short-lived; redeeming one over the transport issues
a revocable session credential. The payload format is defined in
[`@raccoon/protocol`](https://www.npmjs.com/package/@raccoon/protocol) and the
handshake in
[PROTOCOL.md](https://github.com/cloudsignal/raccoon/blob/main/PROTOCOL.md).

MIT © the Raccoon contributors.
