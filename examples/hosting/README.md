# Hosting Raccoon

Production Raccoon needs **HTTPS/WSS**: phones can't reach `ws://127.0.0.1`,
and PWA install, service workers, and Web Push all require a secure origin.
This directory ships one deployable server and three worked platform guides:

- [railway/](railway/) — run the full hub (WebSocket + PWA + push) as one
  Railway service; Railway terminates TLS on your domain.
- [cloudflare/](cloudflare/) — keep the hub self-hosted and front it with a
  Cloudflare Tunnel for HTTPS/WSS without opening ports; optional Cloudflare
  Pages variant for the static PWA.
- [vercel/](vercel/) — host the static PWA on Vercel's CDN; the hub (a
  long-lived WebSocket server) runs elsewhere, e.g. the Railway or Tunnel
  setup.

## The server (`server.mjs`)

A single env-configured process: the broker-free WebSocket hub, the prebuilt
PWA from `@raccoon/app` (resolved to an absolute path), durable file-backed
sessions, optional VAPID Web Push, and a placeholder echo agent so a fresh
deployment is testable end-to-end. Replace the `runner` with your own
`AgentRunner` to serve a real agent — or use the OpenClaw connector
(`@raccoon/connector-openclaw`), which embeds this same hub inside the
OpenClaw gateway.

Run it locally from a repo clone:

```bash
npm ci && npm run build && npm run build:app
PAIR_USER=me node examples/hosting/server.mjs
```

| Env | Default | Meaning |
| --- | --- | --- |
| `PORT` / `HOST` | `8790` / `0.0.0.0` | Bind address (Railway injects `PORT`). |
| `RACCOON_INSTANCE_URL` | `ws://127.0.0.1:$PORT/` | **Public `wss://` URL clients dial — required to pair a real phone.** |
| `RACCOON_INSTANCE` | `raccoon` | Instance display name. |
| `RACCOON_CHANNELS` | `coordinator` | CSV of channel names. |
| `RACCOON_STORE_PATH` | `./data` | Session-store directory — point at a persistent volume. |
| `PAIR_USER` | (unset) | Print a pairing QR + payload for this user id at boot. |
| `VAPID_PUBLIC_KEY` `VAPID_PRIVATE_KEY` `VAPID_SUBJECT` | (unset) | Enable Web Push when the app is closed. |

Mint VAPID keys once:

```bash
node -e "console.log(JSON.stringify(require('@raccoon/push').generateVapidKeys()))"
```

## Pairing a phone

1. Deploy with `RACCOON_INSTANCE_URL=wss://<your-domain>/` and `PAIR_USER=<id>`.
2. Read the pairing QR / payload from the deploy logs (it's single-use and
   expires in ~5 minutes; restart or re-set `PAIR_USER` to mint another).
3. On the phone, open `https://<your-domain>/`, add it to the home screen, and
   scan the QR (or paste the payload) in the setup screen.

## Container

[`Dockerfile`](Dockerfile) builds the whole thing from a repo clone (build
context = repo root):

```bash
docker build -f examples/hosting/Dockerfile -t raccoon-hub .
docker run -p 8790:8790 -v raccoon-data:/data \
  -e RACCOON_INSTANCE_URL=wss://raccoon.example.com/ -e PAIR_USER=me raccoon-hub
```

TLS is out of scope for the container itself — terminate it in front (Railway
domain, Cloudflare Tunnel, or any reverse proxy with WebSocket support).
