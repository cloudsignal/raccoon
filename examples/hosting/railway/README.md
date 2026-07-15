# Raccoon on Railway

One Railway service runs the full messenger: WebSocket hub + PWA + optional
push. Railway terminates TLS, so the generated domain is already `https://` /
`wss://` — the fastest path from zero to pairing a real phone.

## Steps

1. **Create the service.** Push this repo (or your fork) to GitHub → Railway →
   *New Project → Deploy from GitHub repo*. In the service settings set:
   - **Dockerfile path**: `examples/hosting/Dockerfile`
   - Root directory: leave at the repo root (the Dockerfile builds the whole
     workspace).
2. **Attach a volume** (service → *Volumes*) mounted at `/data` — the session
   store lives there, so pairings survive redeploys. `RACCOON_STORE_PATH`
   already defaults to `/data` in the image.
3. **Generate a domain** (service → *Settings → Networking → Generate Domain*),
   e.g. `raccoon-production-abcd.up.railway.app`. Railway routes WebSockets on
   the same domain, no extra config.
4. **Set variables** (service → *Variables*):

   ```
   RACCOON_INSTANCE_URL = wss://<your-domain>/
   RACCOON_INSTANCE     = raccoon
   PAIR_USER            = <your-user-id>
   # optional Web Push — mint once with the one-liner in ../README.md:
   VAPID_PUBLIC_KEY     = ...
   VAPID_PRIVATE_KEY    = ...
   VAPID_SUBJECT        = mailto:you@example.com
   ```

5. **Deploy, then read the logs** (`railway logs` or the dashboard). The boot
   log prints the pairing QR + payload for `PAIR_USER`.
6. **Pair the phone.** Open `https://<your-domain>/` on the phone, add to home
   screen, scan the QR (or paste the payload). Send `/draft` to see an
   approval card; the echo agent replies until you wire a real one.

## Notes

- Pairing tokens are single-use and expire in ~5 minutes. Redeploy (or change
  `PAIR_USER`) to mint a new one; existing paired sessions are unaffected —
  they live in the volume.
- Railway injects `PORT`; the server binds it automatically.
- To serve a real agent, replace the echo `runner` in
  [`../server.mjs`](../server.mjs) or run the OpenClaw connector instead
  (same hub, embedded in the OpenClaw gateway — see
  [`adapters/connector-openclaw/README.md`](../../../adapters/connector-openclaw/README.md)).
