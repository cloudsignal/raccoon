#!/usr/bin/env bash
# v0.1 release acceptance gate. Gates the EXACT immutable tarballs produced by
# release:pack (release-artifacts/) — the same artifacts release:publish ships,
# never repacked in between. The tarballs are published to a DISPOSABLE local
# registry (verdaccio), so the OpenClaw gate exercises the real published
# `npm:` install path against those exact artifacts, not a `--link` surrogate.
# Beyond neutrality it runs four REAL end-to-end gates:
#   GATE 3/6  OpenClaw 2026.6.11 installs the PUBLISHED connector (npm:) + loads it.
#   GATE 4/6  A fresh Vite app builds from the packed @raccoon/app (incl. styles).
#   GATE 5/6  A NEW connector process resumes a session persisted by a first process.
#   GATE 6/6  A hub's staticDir serves the packed PWA (/, version.json, service worker).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
BIN="$ROOT/node_modules/.bin/openclaw"
OUT="$ROOT/release-artifacts"
tgz() { echo "$OUT/raccoon-$1-0.1.0.tgz"; }

echo "== 1/6 neutrality gate =="
npm run gate:neutrality

echo "== 2/6 deterministic release pack (clean + dep-order build + real build id + pack) =="
bash scripts/release-pack.sh   # clean → build → build:app(BUILD_ID) → gate:deps → pack to release-artifacts/

# Ephemeral scratch for the consumer FIXTURES only; the tarballs live in OUT.
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

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
# Disposable local registry (verdaccio) serving the EXACT release tarballs, so
# the OpenClaw gate below exercises the PUBLISHED install path
# (`openclaw plugins install npm:@raccoon/connector-openclaw@0.1.0`) against the
# same immutable artifacts release:publish ships — not a `--link` surrogate.
# `$all` access + an npmjs uplink so @raccoon/* resolve locally and everything
# else (the `ulid` runtime dep) proxies through. The openclaw peer links to the
# host's copy, so no multi-hundred-MB re-download.
echo "== starting disposable local registry (verdaccio) serving the release tarballs =="
VDIR="$WORK/verdaccio"; mkdir -p "$VDIR/storage"
cat > "$VDIR/config.yaml" <<YAML
storage: $VDIR/storage
auth:
  htpasswd:
    file: $VDIR/htpasswd
    max_users: -1
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@raccoon/*':
    access: \$all
    publish: \$all
    unpublish: \$all
  '**':
    access: \$all
    proxy: npmjs
log: { type: stdout, format: pretty, level: warn }
YAML
VREG_PORT="$(node -e 'const s=require("net").createServer().listen(0,()=>{process.stdout.write(String(s.address().port));s.close();})')"
VREG_URL="http://localhost:$VREG_PORT"
node "$ROOT/node_modules/.bin/verdaccio" --config "$VDIR/config.yaml" --listen "$VREG_PORT" >"$VDIR/verdaccio.log" 2>&1 &
VREG_PID=$!
# Replace the WORK-only trap so verdaccio is always reaped, even on failure.
trap 'kill ${VREG_PID:-} 2>/dev/null || true; rm -rf "$WORK"' EXIT
vready=0
for _ in $(seq 1 100); do curl -sf "$VREG_URL/-/ping" >/dev/null 2>&1 && { vready=1; break; }; sleep 0.2; done
[ "$vready" = 1 ] || { echo "ERROR: verdaccio did not become ready" >&2; cat "$VDIR/verdaccio.log" >&2; exit 1; }
# Fake token so `npm publish` is accepted (verdaccio $all treats it as anonymous).
VNPMRC="$VDIR/.npmrc"
printf '//localhost:%s/:_authToken=fake\nregistry=%s\n' "$VREG_PORT" "$VREG_URL" > "$VNPMRC"
for t in "$OUT"/*.tgz; do
  npm publish "$t" --registry "$VREG_URL" --userconfig "$VNPMRC" >/dev/null 2>&1 \
    || { echo "ERROR: failed to publish $(basename "$t") to the local registry" >&2; exit 1; }
done
echo "  published the release tarballs to $VREG_URL"

# ---------------------------------------------------------------------------
echo "== 3/6 GATE: OpenClaw 2026.6.11 installs the PUBLISHED connector (npm:) + loads it =="
# THE PUBLISHED INSTALL PATH: `openclaw plugins install npm:@raccoon/connector-openclaw@0.1.0`
# npm-resolves the connector + its DECLARED deps from the local registry (the
# exact release tarballs) — the same command a real adopter runs, not a `--link`
# to a local checkout. Dep COMPLETENESS is also checked deterministically by
# `gate:deps` in step 2 (an undeclared direct import a hoisted tree would mask).
OC="$WORK/oc-consumer"
mkdir -p "$OC/state"
cat > "$OC/package.json" <<JSON
{ "name": "oc-consumer", "private": true, "version": "0.0.0", "type": "module" }
JSON
export OPENCLAW_STATE_DIR="$OC/state"
export OPENCLAW_CONFIG="$OC/config.json"
if ! npm_config_registry="$VREG_URL" npm_config_userconfig="$VNPMRC" \
     node "$BIN" plugins install "npm:@raccoon/connector-openclaw@0.1.0" >/dev/null 2>&1; then
  echo "ERROR: 'openclaw plugins install npm:@raccoon/connector-openclaw@0.1.0' failed (local registry)" >&2
  npm_config_registry="$VREG_URL" npm_config_userconfig="$VNPMRC" \
    node "$BIN" plugins install "npm:@raccoon/connector-openclaw@0.1.0" >&2 || true
  exit 1
fi
if ! node "$BIN" plugins doctor 2>&1 | grep -q "No plugin issues detected"; then
  echo "ERROR: openclaw plugins doctor reported issues for the published connector" >&2
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
echo "  OpenClaw installed the PUBLISHED connector via npm: and loaded its RUNTIME (doctor clean; status=loaded, activated, channel 'raccoon')"

# ---------------------------------------------------------------------------
echo "== 4/6 GATE: a fresh Vite app builds from the packed @raccoon/app (incl. styles) =="
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
# A library-consumer fixture: the connector + its runtime deps installed from
# the EXACT release tarballs into a plain node_modules (the co-installed tarballs
# satisfy the inter-@raccoon deps; `ulid` proxies from npmjs). Gates 5 and 6 both
# import from here — the published library surface, resolved by node, not vite.
LIB="$WORK/lib-consumer"
mkdir -p "$LIB"
cat > "$LIB/package.json" <<JSON
{ "name": "lib-consumer", "private": true, "version": "0.0.0", "type": "module" }
JSON
( cd "$LIB" && npm i --no-audit --no-fund \
    "$(tgz protocol)" "$(tgz transport-ws)" "$(tgz pairing)" "$(tgz push)" "$(tgz bridge)" "$(tgz connector-openclaw)" \
    >/dev/null 2>&1 )

# ---------------------------------------------------------------------------
echo "== 5/6 GATE: a NEW connector process resumes a session via the PRODUCTION store wiring =="
# Both scripts drive the PRODUCTION gateway.startAccount (exported), which
# auto-creates a FileCredentialStore at RACCOON_STORE_PATH/sessions.json — the
# real default wiring, NOT a hand-constructed store. proc1 starts the account,
# pairs a user (persisting a confirmed session), stops the account, and exits;
# proc2 is a FRESH node process that starts the account on the same store path
# and resumes with the stored session — proving durability survives a real
# restart through the production path.
G3STORE="$LIB/g3-store"
mkdir -p "$G3STORE"
export RACCOON_STORE_PATH="$G3STORE"
cat > "$LIB/proc1.mjs" <<'JS'
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
cat > "$LIB/proc2.mjs" <<'JS'
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
G3SESSION="$( cd "$LIB" && node proc1.mjs "$G3PORT" | tail -1 )"
if [ -z "$G3SESSION" ]; then echo "ERROR: proc1 did not pair a session" >&2; exit 1; fi
if ! ( cd "$LIB" && node proc2.mjs "$G3PORT" "$G3SESSION" ) | grep -q RESUMED; then
  echo "ERROR: a fresh connector process did NOT resume the persisted session" >&2
  exit 1
fi
unset RACCOON_STORE_PATH
echo "  a fresh connector process resumed the session the first persisted (production startAccount store wiring)"

# ---------------------------------------------------------------------------
echo "== 6/6 GATE: a hub's staticDir serves the packed PWA (/, version.json, service worker) =="
# The published dist-standalone must be servable AS-IS by a hub's staticDir. A
# WsHub (the same server the connector stands up) serves the packed PWA on an
# ephemeral port; GET / (index.html), /version.json, and /service-worker.js must
# all 200, and version.json must carry the real build id — a relative-path or
# missing-file regression would 404, and a 'dev' id would silently disable PWA
# updates. Served straight from the unpacked TARBALL, not the workspace build.
cat > "$LIB/serve.mjs" <<'JS'
import { WsHub } from '@raccoon/transport-ws';
const staticDir = process.argv[2];
const hub = new WsHub({ instance: 'serve', channels: ['coordinator'], staticDir });
const { port } = await hub.start();
const base = `http://127.0.0.1:${port}`;
let ok = true;
for (const p of ['/', '/version.json', '/service-worker.js']) {
  const res = await fetch(base + p).catch(() => null);
  if (!res || res.status !== 200) { console.error(`serve: GET ${p} -> ${res ? res.status : 'no response'}`); ok = false; }
}
const vj = await fetch(`${base}/version.json`).then((r) => r.json()).catch(() => ({}));
if (!vj.buildId || vj.buildId === 'dev') { console.error(`serve: version.json buildId '${vj.buildId}' (dev/empty)`); ok = false; }
await hub.stop();
if (!ok) process.exit(1);
process.stdout.write('SERVED\n');
JS
if ! ( cd "$LIB" && node serve.mjs "$APPPKG/package/dist-standalone" ) | grep -q SERVED; then
  echo "ERROR: the packed PWA was not served correctly (/, version.json, service worker must 200 with a real build id)" >&2
  ( cd "$LIB" && node serve.mjs "$APPPKG/package/dist-standalone" ) >&2 || true
  exit 1
fi
echo "  a hub's staticDir served the packed PWA (/, version.json, service-worker.js → 200; build id $APP_BUILD_ID)"

echo ""
echo "RELEASE VERIFY: PASS — published connector installs + loads in OpenClaw, browser-buildable app from packed packages, cross-process session resume, and the packed PWA serves over a hub's staticDir."
