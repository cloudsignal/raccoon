# Raccoon behind Cloudflare

Two variants. The primary one keeps the hub wherever you already run it (a
home server, a VPS, a container) and uses a **Cloudflare Tunnel** to give it
HTTPS/WSS on your domain with **no open ports** — Cloudflare proxies
WebSockets natively.

> Why not Workers? The Raccoon hub is a long-lived Node WebSocket server
> (`node:http` + `ws`); it doesn't run on the Workers runtime. The tunnel (or
> a container platform) is the supported Cloudflare path for the hub itself.

## Variant A — Cloudflare Tunnel in front of a self-hosted hub

1. **Run the hub** on the box (from a repo clone, or the
   [`../Dockerfile`](../Dockerfile)):

   ```bash
   RACCOON_INSTANCE_URL=wss://raccoon.example.com/ PAIR_USER=me \
     node examples/hosting/server.mjs
   ```

2. **Create the tunnel** (once, with [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) installed):

   ```bash
   cloudflared tunnel login
   cloudflared tunnel create raccoon
   cloudflared tunnel route dns raccoon raccoon.example.com
   ```

3. **Point it at the hub** — copy [`tunnel.example.yml`](tunnel.example.yml)
   to `~/.cloudflared/config.yml` (fill in your tunnel id), then:

   ```bash
   cloudflared tunnel run raccoon
   ```

4. **Pair the phone** at `https://raccoon.example.com/` — QR/payload comes
   from the hub's boot log. Add to home screen; push works once VAPID keys
   are set (see [`../README.md`](../README.md)).

Run `cloudflared` as a service (`cloudflared service install`) to keep the
tunnel up across reboots.

## Variant B — static PWA on Cloudflare Pages

The PWA is a static bundle, so Pages can serve it from the CDN while the hub
runs elsewhere (Variant A, Railway, any WSS host):

- **Build command**: `npm ci && BUILD_ID=$CF_PAGES_COMMIT_SHA npm run build:app`
- **Build output directory**: `packages/app/dist-standalone`

The app pairs to whatever hub URL the QR payload carries — the PWA origin and
the hub origin don't need to match. Serving the PWA from the hub itself
(Variant A) keeps everything on one origin and is the simpler default.
