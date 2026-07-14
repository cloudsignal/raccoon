# @raccoon/push

Web Push for [Raccoon](https://github.com/cloudsignal/raccoon): VAPID key
generation, push delivery, subscription stores, and a hub wrapper that falls
back to push when the user has no live socket (the app is closed).

```bash
# repo-first (not yet on the public npm registry) — install the packed tarball:
#   git clone https://github.com/cloudsignal/raccoon && cd raccoon && npm ci && npm run release:pack
npm i /path/to/raccoon/release-artifacts/raccoon-push-0.1.0.tgz
```

```ts
import {
  generateVapidKeys,
  VapidPushSender,
  InMemorySubscriptionStore,
  withPushFallback,
} from '@raccoon/push';

const vapid = generateVapidKeys(); // persist these once

const { hub: pushingHub } = withPushFallback(hub, {
  store: new InMemorySubscriptionStore(),
  sender: new VapidPushSender({ ...vapid, subject: 'mailto:admin@example.com' }),
});
// pushingHub.sendToUser(...) delivers over the socket when connected,
// or as a Web Push notification when not.
```

Also exported: `sendPushToUser` (direct delivery), `isSafeWebPushEndpoint`
(endpoint guard against SSRF-style endpoints), subscription-store types for
implementing a durable store, and `vendorOf` for vendor-specific handling.
Delivery is standard Web Push — it works wherever the PWA can register a
service worker (HTTPS origin required).

MIT © the Raccoon contributors.
