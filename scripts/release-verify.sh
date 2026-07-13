#!/usr/bin/env bash
# v0.1 release acceptance gate. Gates the EXACT immutable tarballs produced by
# release:pack (release-artifacts/) — the same artifacts release:publish ships,
# never repacked in between. Beyond neutrality it runs three REAL end-to-end
# gates against those tarballs:
#   GATE 1  OpenClaw 2026.6.11 installs + loads the packed connector.
#   GATE 2  A fresh Vite app builds from the packed @raccoon/app (incl. styles).
#   GATE 3  A NEW connector process resumes a session persisted by a first process.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BIN="$ROOT/node_modules/.bin/openclaw"
OUT="$ROOT/release-artifacts"
tgz() { echo "$OUT/raccoon-$1-0.1.0.tgz"; }

echo "== 1/5 neutrality gate =="
npm run gate:neutrality

echo "== 2/5 deterministic release pack (clean + dep-order build + real build id + pack) =="
bash scripts/release-pack.sh   # clean → build → build:app(BUILD_ID) → gate:deps → pack to release-artifacts/

# Ephemeral scratch for the consumer FIXTURES only; the tarballs live in OUT.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
dir_of() { # bash-3.2-safe (macOS) — no associative arrays
  case "$1" in
    connector-openclaw) echo "adapters/connector-openclaw" ;;
    *) echo "packages/$1" ;;
  esac
}

# The published PWA must carry a REAL build id (its package version), not 'dev'
# — a 'dev' id disables the update check and makes every release share the
# raccoon-*-dev cache. Assert against the artifact ACTUALLY IN THE TARBALL.
APPPKG="$WORK/app-unpack"
mkdir -p "$APPPKG"
tar xzf "$(tgz app)" -C "$APPPKG"
APP_BUILD_ID="$(node -e "process.stdout.write(String(require('$APPPKG/package/dist-standalone/version.json').buildId))")"
if [ "$APP_BUILD_ID" = "dev" ] || [ -z "$APP_BUILD_ID" ]; then
  echo "ERROR: packed PWA version.json has buildId='$APP_BUILD_ID' (dev/empty) — updates would be disabled" >&2
  exit 1
fi
grep -q "BUILD_ID = '$APP_BUILD_ID'" "$APPPKG/package/dist-standalone/service-worker.js" \
  || { echo "ERROR: packed service-worker.js BUILD_ID does not match version.json ($APP_BUILD_ID)" >&2; exit 1; }
echo "  packed PWA build id is release-real: $APP_BUILD_ID (not dev)"

# ---------------------------------------------------------------------------
echo "== 3/5 GATE: OpenClaw 2026.6.11 installs + inspects the packed connector =="
# The connector is installed via npm from its packed tarball into a consumer
# where its DECLARED deps resolve from the co-packed tarballs — i.e. real
# npm-install dep resolution (dep COMPLETENESS is verified deterministically by
# `gate:deps` in step 2, which catches an undeclared direct import that a hoisted
# tree would otherwise mask). `plugins install --link` then points OpenClaw at
# that installed package; the published path is `openclaw plugins install
# npm:@raccoon/connector-openclaw`, which npm-resolves the same deps from the
# registry (validated post-publish, since v0.1's deps aren't yet published).
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
# Load the plugin RUNTIME (executes the connector module) and assert via
# structured JSON that OpenClaw actually loaded it as a channel — not a cold
# metadata read.
node "$BIN" plugins inspect raccoon --runtime --json > "$OC/inspect.json" 2>/dev/null \
  || { echo "ERROR: 'openclaw plugins inspect raccoon --runtime --json' failed" >&2; exit 1; }
node -e '
  const p = require(process.argv[1]).plugin;
  const ok = p && p.status === "loaded" && p.activated === true
    && Array.isArray(p.channelIds) && p.channelIds.includes("raccoon");
  if (!ok) { console.error("ERROR: connector runtime did not load as a channel:", JSON.stringify(p)); process.exit(1); }
' "$OC/inspect.json"
echo "  OpenClaw loaded the packed connector RUNTIME (doctor clean; status=loaded, activated, channel 'raccoon')"

# ---------------------------------------------------------------------------
echo "== 4/5 GATE: a fresh Vite app builds from the packed @raccoon/app (incl. styles) =="
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
echo "== 5/5 GATE: a NEW connector process resumes a session via the PRODUCTION store wiring =="
# Both scripts drive the PRODUCTION gateway.startAccount (exported), which
# auto-creates a FileCredentialStore at RACCOON_STORE_PATH/sessions.json — the
# real default wiring, NOT a hand-constructed store. proc1 starts the account,
# pairs a user (persisting a confirmed session), stops the account, and exits;
# proc2 is a FRESH node process that starts the account on the same store path
# and resumes with the stored session — proving durability survives a real
# restart through the production path.
G3STORE="$OC/g3-store"
mkdir -p "$G3STORE"
export RACCOON_STORE_PATH="$G3STORE"
cat > "$OC/proc1.mjs" <<'JS'
import { startAccount, stopAccount } from '@raccoon/connector-openclaw';
import { issuePairing } from '@raccoon/pairing';
import { WsClientTransport } from '@raccoon/transport-ws';
const port = Number(process.argv[2]);
const instanceUrl = `ws://127.0.0.1:${port}/`;
const log = { info() {}, warn() {}, error() {}, debug() {} };
const ctx = { accountId: 'default', cfg: {}, account: { instance: 'g3', instanceUrl, port, channels: ['coordinator'] }, log };
const acct = await startAccount(ctx); // production wiring auto-creates the FileCredentialStore
const pairing = await issuePairing(acct.hub, { userId: 'u1', instanceUrl });
const client = new WsClientTransport({ url: instanceUrl, pairingToken: pairing.token, device: 'g3' });
let session = '';
client.onGrant((g) => { session = g.payload.sessionToken; });
await client.connect(); // pair -> confirm -> the store durably persists the confirmed session
await client.close();
await stopAccount(ctx);
if (!session) { console.error('proc1: no session granted'); process.exit(1); }
process.stdout.write(`${session}\n`); // stdout carries ONLY the session
process.exit(0);
JS
cat > "$OC/proc2.mjs" <<'JS'
import { startAccount, stopAccount } from '@raccoon/connector-openclaw';
import { WsClientTransport } from '@raccoon/transport-ws';
const [, , port, session] = process.argv;
const instanceUrl = `ws://127.0.0.1:${port}/`;
const log = { info() {}, warn() {}, error() {}, debug() {} };
const ctx = { accountId: 'default', cfg: {}, account: { instance: 'g3', instanceUrl, port: Number(port), channels: ['coordinator'] }, log };
await startAccount(ctx); // same RACCOON_STORE_PATH -> same FileCredentialStore file -> loads the persisted session
const client = new WsClientTransport({ url: instanceUrl, session });
let opened = false;
client.onStatus((s) => { if (s === 'open') opened = true; });
await client.connect();
await new Promise((r) => setTimeout(r, 200));
await client.close();
await stopAccount(ctx);
if (!opened) { console.error('proc2: session did NOT resume across the restart'); process.exit(1); }
process.stdout.write('RESUMED\n');
process.exit(0);
JS
# A free ephemeral port both processes reuse (proc1 frees it on exit before proc2 binds).
G3PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{process.stdout.write(String(s.address().port));s.close();})')"
G3SESSION="$( cd "$OC" && node proc1.mjs "$G3PORT" | tail -1 )"
if [ -z "$G3SESSION" ]; then echo "ERROR: proc1 did not pair a session" >&2; exit 1; fi
if ! ( cd "$OC" && node proc2.mjs "$G3PORT" "$G3SESSION" ) | grep -q RESUMED; then
  echo "ERROR: a fresh connector process did NOT resume the persisted session" >&2
  exit 1
fi
unset RACCOON_STORE_PATH
echo "  a fresh connector process resumed the session the first persisted (production startAccount store wiring)"

echo ""
echo "RELEASE VERIFY: PASS — OpenClaw-installable connector, browser-buildable app from packed packages, and cross-process session resume."
