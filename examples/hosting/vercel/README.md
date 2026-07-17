# Raccoon PWA on Vercel

Vercel's serverless platform can't host the hub — a Raccoon hub is a
**long-lived WebSocket server**, and serverless functions don't hold
persistent socket connections. What Vercel hosts well is the **static PWA**:
`@raccoon/app`'s `dist-standalone` is a plain static bundle, ideal for the
CDN.

So this example splits the deployment:

- **PWA on Vercel** (this page) — served from the edge on your domain.
- **Hub elsewhere** — the [Railway](../railway/) service or the
  [Cloudflare Tunnel](../cloudflare/) setup. The app pairs to whatever
  `wss://` URL the QR payload carries; the PWA origin and hub origin don't
  need to match.

If you'd rather run everything on one origin, skip Vercel and let the hub
serve the PWA itself (its `staticDir` does exactly that).

## One-click deploy

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https%3A%2F%2Fgithub.com%2Fcloudsignal%2Fraccoon&project-name=raccoon-app&repository-name=raccoon)

The repo ships a root [`vercel.json`](../../../vercel.json), so the clone
builds and deploys the PWA with no configuration.

## Manual steps (existing fork)

1. Import the repo (or your fork) into Vercel.
2. The root `vercel.json` already sets everything; or configure the dashboard
   (*Settings → Build & Development*):
   - **Build command**: `npm ci && BUILD_ID=$VERCEL_GIT_COMMIT_SHA npm run build:app`
   - **Output directory**: `packages/app/dist-standalone`
   - **Framework preset**: Other
3. Deploy. The PWA is now at `https://<project>.vercel.app/` (or your custom
   domain).
4. Stand up the hub on a WSS-capable host with
   `RACCOON_INSTANCE_URL=wss://<hub-domain>/` and `PAIR_USER=<id>`
   ([Railway](../railway/) / [Cloudflare Tunnel](../cloudflare/)).
5. On the phone: open the Vercel URL, add to home screen, scan the QR from the
   hub's boot log.

The included `vercel.json` also marks `index.html`, `service-worker.js`, and
`version.json` as `no-store` — the same cache policy the hub's own static
server applies — so the PWA's update check keeps working through Vercel's CDN.
