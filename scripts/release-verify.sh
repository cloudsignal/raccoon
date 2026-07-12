#!/usr/bin/env bash
# v0.1 release acceptance gate. Three REAL end-to-end gates against the PACKED
# tarballs (not a sibling repo / vendor tree / path aliases):
#   GATE 1  OpenClaw 2026.6.11 installs + loads the packed connector.
#   GATE 2  A fresh Vite app builds from the packed @raccoon/app (incl. styles).
#   GATE 3  A NEW connector process resumes a session persisted by a first process.
# Plus the neutrality gate. These replace the earlier typecheck-only fixture,
# which passed over an un-installable connector and a browser-unbuildable app.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BIN="$ROOT/node_modules/.bin/openclaw"

echo "== 1/6 neutrality gate =="
npm run gate:neutrality

echo "== 2/6 build all published libs (dist + declarations + compiled css) =="
npm run build >/dev/null
echo "  built"
# Unpiped so a failure trips `set -e` (piping to sed would mask the exit code).
npm run gate:deps

echo "== 3/6 pack every published package =="
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
dir_of() { # bash-3.2-safe (macOS) — no associative arrays
  case "$1" in
    connector-openclaw) echo "adapters/connector-openclaw" ;;
    *) echo "packages/$1" ;;
  esac
}
for p in protocol transport-ws pairing push bridge connector-openclaw app; do
  ( cd "$(dir_of "$p")" && npm pack --pack-destination "$WORK" >/dev/null )
done
tgz() { echo "$WORK/raccoon-$1-0.1.0.tgz"; }
ls "$WORK"/*.tgz | sed "s#$WORK/#  packed #"

# ---------------------------------------------------------------------------
echo "== 4/6 GATE: OpenClaw 2026.6.11 installs + inspects the packed connector =="
# A consumer with ALL raccoon tarballs installed (connector deps resolve offline
# from the co-installed tarballs) + openclaw. `plugins install --link` loads the
# installed package (deps already present) — the published `openclaw plugins
# install @raccoon/connector-openclaw` npm-resolves the same deps from the registry.
OC="$WORK/oc-consumer"
mkdir -p "$OC"
cat > "$OC/package.json" <<JSON
{ "name": "oc-consumer", "private": true, "version": "0.0.0", "type": "module",
  "dependencies": { "openclaw": "2026.6.11" } }
JSON
( cd "$OC" && npm i --no-audit --no-fund \
    "$(tgz protocol)" "$(tgz transport-ws)" "$(tgz pairing)" "$(tgz push)" "$(tgz bridge)" "$(tgz connector-openclaw)" \
    >/dev/null 2>&1 )
export OPENCLAW_STATE_DIR="$OC/state"
export OPENCLAW_CONFIG="$OC/config.json"
mkdir -p "$OPENCLAW_STATE_DIR"
node "$BIN" plugins install --link "$OC/node_modules/@raccoon/connector-openclaw" >/dev/null
if ! node "$BIN" plugins doctor 2>&1 | grep -q "No plugin issues detected"; then
  echo "ERROR: openclaw plugins doctor reported issues for the packed connector" >&2
  node "$BIN" plugins doctor >&2 || true
  exit 1
fi
if ! node "$BIN" plugins inspect raccoon 2>&1 | grep -q "Status: loaded"; then
  echo "ERROR: OpenClaw did not load the packed connector as a channel" >&2
  node "$BIN" plugins inspect raccoon >&2 || true
  exit 1
fi
echo "  OpenClaw loaded the packed connector (doctor clean; channel 'raccoon' loaded)"

# ---------------------------------------------------------------------------
echo "== 5/6 GATE: a fresh Vite app builds from the packed @raccoon/app (incl. styles) =="
APP="$WORK/vite-consumer"
mkdir -p "$APP/src"
cat > "$APP/package.json" <<JSON
{ "name": "vite-consumer", "private": true, "version": "0.0.0", "type": "module",
  "scripts": { "build": "vite build" },
  "dependencies": {
    "@raccoon/app": "$(tgz app)",
    "@raccoon/protocol": "$(tgz protocol)",
    "@raccoon/transport-ws": "$(tgz transport-ws)",
    "react": "^19.0.0", "react-dom": "^19.0.0"
  },
  "devDependencies": { "vite": "^6.0.0", "@vitejs/plugin-react": "^4.3.0" } }
JSON
cat > "$APP/vite.config.ts" <<'TS'
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()] });
TS
cat > "$APP/index.html" <<'HTML'
<!doctype html><html><head><meta charset="utf-8"></head>
<body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>
HTML
# Imports the package ROOT + the compiled stylesheet — the exact host-embed
# surface. A browser build here would fail on node:crypto if @raccoon/app pulled
# the transport's server barrel, or on an unresolved raw @import 'tailwindcss'.
cat > "$APP/src/main.tsx" <<'TSX'
import { createRoot } from 'react-dom/client';
import { App, TransportProvider } from '@raccoon/app';
import '@raccoon/app/styles.css';
const el = document.getElementById('root');
if (el) createRoot(el).render(
  <TransportProvider makeTransport={() => { throw new Error('demo-only'); }}>
    <App />
  </TransportProvider>
);
TSX
( cd "$APP" && npm i --no-audit --no-fund >/dev/null 2>&1 )
if ! ( cd "$APP" && npm run build >/dev/null 2>&1 ); then
  echo "ERROR: a fresh Vite app failed to build against the packed packages" >&2
  ( cd "$APP" && npm run build ) >&2 || true
  exit 1
fi
test -d "$APP/dist" || { echo "ERROR: vite build produced no dist" >&2; exit 1; }
# The build SUCCEEDING is the proof the app's transport import no longer pulls the
# node:crypto-using hub barrel (the reviewer's failure was a hard build error) —
# a browser bundler resolves @raccoon/transport-ws's 'browser' condition to the
# client-only entry. Confirm the compiled stylesheet resolved + emitted too.
ls "$APP"/dist/assets/*.css >/dev/null 2>&1 || { echo "ERROR: no CSS emitted — @raccoon/app/styles.css did not resolve/compile" >&2; exit 1; }
echo "  fresh Vite app built from tarballs (browser-safe JS + resolvable compiled styles.css)"

# ---------------------------------------------------------------------------
echo "== 6/6 GATE: a NEW connector process resumes a session persisted by a first =="
# Both scripts run inside the OpenClaw consumer (has @raccoon/connector-openclaw +
# @raccoon/transport-ws + openclaw). proc1 pairs a user against a FileCredentialStore
# on disk and exits; proc2 — a FRESH process on the same port + same store file —
# resumes with the stored session, proving durability survives a real restart.
cat > "$OC/proc1.mjs" <<'JS'
import { createRaccoonChannel } from '@raccoon/connector-openclaw';
import { FileCredentialStore, WsClientTransport } from '@raccoon/transport-ws';
const storePath = process.argv[2];
const channel = createRaccoonChannel({
  instance: 'g3', instanceUrl: 'ws://127.0.0.1/', port: 0, channels: ['coordinator'],
  runner: { async *run() { yield 'ok'; } },
  sessionStore: new FileCredentialStore({ path: storePath }),
});
const { port } = await channel.start();
const pairing = await channel.pair('u1');
const client = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, pairingToken: pairing.token, device: 'g3' });
let session = '';
client.onGrant((g) => { session = g.payload.sessionToken; });
await client.connect();
await client.close();
await channel.stop();
if (!session) { console.error('proc1: no session granted'); process.exit(1); }
process.stdout.write(`${port} ${session}\n`);
process.exit(0);
JS
cat > "$OC/proc2.mjs" <<'JS'
import { createRaccoonChannel } from '@raccoon/connector-openclaw';
import { FileCredentialStore, WsClientTransport } from '@raccoon/transport-ws';
const [, , port, storePath, session] = process.argv;
const channel = createRaccoonChannel({
  instance: 'g3', instanceUrl: 'ws://127.0.0.1/', port: Number(port), channels: ['coordinator'],
  runner: { async *run() { yield 'ok'; } },
  sessionStore: new FileCredentialStore({ path: storePath }),
});
await channel.start();
const client = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, session });
let opened = false;
client.onStatus((s) => { if (s === 'open') opened = true; });
await client.connect();
await new Promise((r) => setTimeout(r, 200));
await client.close();
await channel.stop();
if (!opened) { console.error('proc2: session did NOT resume across the restart'); process.exit(1); }
process.stdout.write('RESUMED\n');
process.exit(0);
JS
G3OUT="$( cd "$OC" && node proc1.mjs "$OC/g3-sessions.json" )"
G3PORT="${G3OUT%% *}"
G3SESSION="${G3OUT##* }"
if ! ( cd "$OC" && node proc2.mjs "$G3PORT" "$OC/g3-sessions.json" "$G3SESSION" ) | grep -q RESUMED; then
  echo "ERROR: a fresh connector process did NOT resume the persisted session" >&2
  exit 1
fi
echo "  a fresh connector process resumed the session the first process persisted"

echo ""
echo "RELEASE VERIFY: PASS — OpenClaw-installable connector, browser-buildable app from packed packages, and cross-process session resume."
