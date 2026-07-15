# @raccoon/app

Installable, push-capable chat PWA for Raccoon instances. Static build:
any Raccoon adapter (or `WsHub({ staticDir })`) serves it next to the
WebSocket on one port.

## Quickstart

    npm run demo          # from the repo root: builds the app, starts the echo hub
    # open http://127.0.0.1:8790/ and scan the printed QR (or paste the payload)
    # send "/draft" to try the approval card

## Outputs — library vs standalone PWA

This package emits **two separate** build outputs (they no longer clobber):

- **`dist/`** — the LIBRARY (`npm run build`): `lib.js` + emitted `.d.ts` + a
  compiled `styles.css`. This is what `import { App } from '@raccoon/app'` and
  `import '@raccoon/app/styles.css'` resolve to.
- **`dist-standalone/`** — the standalone PWA (`npm run build:app`, i.e. `vite
  build`): `index.html`, hashed `assets/`, `version.json`,
  `manifest.webmanifest`, and the BUILD_ID-stamped `service-worker.js`. This is
  what a hub serves via `staticDir`.

Both are published in the npm package (`prepack` builds them), so an OpenClaw
host can serve the PWA from `node_modules/@raccoon/app/dist-standalone` without
cloning this repo.

    npm run build:app                                    # BUILD_ID=dev → dist-standalone/
    BUILD_ID=$(git rev-parse --short HEAD) npm run build:app

## Branding: raccoon.config.json

| Field | Meaning |
| --- | --- |
| `name`, `shortName` | App + manifest names |
| `themeColor` | Manifest/theme color |
| `wallpaper` | Chat wallpaper (default `#EDE6DA`) |
| `outgoing` | Outgoing bubble color (default `#D9FDD3`) |
| `icons` | Paths into `public/` for 192/512/apple-touch |
| `channels` | Per-channel `label`/`blurb`/`tone` display overrides |

Rebuild after editing; branding is baked at build time.

## Update architecture

Aggressive-update PWA: the service worker caches the shell per BUILD_ID
(stale-while-revalidate) and hashed assets (cache-first); the UpdateGate
polls `version.json` (60s while visible, plus focus/online/pageshow) and
purge-reloads on mismatch, deferred while the composer holds a draft.

## Push

If the instance advertises a VAPID key in the pairing grant, the app
offers an enable-notifications banner; subscriptions are registered over
the transport (`push.subscribe`) and the server pushes only when no
socket is open. Subscriptions live server-side in memory in the reference setup; after a server restart, toggle notifications again (re-subscription on connect is a planned refinement).

## Pairing & storage

QR payload → `pair.request` over ws → `pair.grant` persisted in
IndexedDB (`raccoon-app` DB): session credentials, outbox, read markers.
No accounts, no email, no third-party services.
