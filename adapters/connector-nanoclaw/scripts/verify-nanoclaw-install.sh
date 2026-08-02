#!/usr/bin/env bash
# Opt-in end-to-end rehearsal of the add-raccoon install against a real
# NanoClaw checkout. NOT run by CI or vitest.
#
# What it does:
#   1. Clones github.com/nanocoai/nanoclaw shallow into a temp dir — or, when
#      an existing checkout path is passed as $1, copies it into the temp dir
#      (the original is never modified).
#   2. Applies the skill's file steps mechanically: copies the bundle,
#      declaration, PWA dir, and wrapper into src/channels/; appends the
#      barrel import; appends a .env block with throwaway test values; wires
#      the postbuild copy step into package.json.
#   3. Runs their install (pnpm if available, else npm) and `npm run build`
#      (tsc + the postbuild copy).
#   4. Starts `node dist/index.js` and curls the raccoon port `/` expecting
#      the PWA's index.html, then kills the host and cleans up.
#
# Honest prerequisites: network access (clone + dependency install), Node 20+,
# NanoClaw's own toolchain, and a checkout that can boot far enough to
# register channels. NanoClaw may require additional configuration to fully
# start; if the host exits before the raccoon hub binds, this script fails —
# that is a NanoClaw bootstrap problem, not necessarily a connector one.
#
# Usage:
#   scripts/verify-nanoclaw-install.sh [path-to-existing-nanoclaw-checkout]
set -euo pipefail

PKG_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_ROOT="$(cd "$PKG_ROOT/../.." && pwd)"
NANOCLAW_REPO="https://github.com/nanocoai/nanoclaw.git"

WORKDIR="$(mktemp -d)"
HOST_PID=""
cleanup() {
  if [ -n "$HOST_PID" ] && kill -0 "$HOST_PID" 2>/dev/null; then
    kill "$HOST_PID" 2>/dev/null || true
    wait "$HOST_PID" 2>/dev/null || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

log() { printf '\n== %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

# --- 0. Connector deliverables (build them if absent) ------------------------
if [ ! -f "$PKG_ROOT/dist/raccoon.bundle.mjs" ] || [ ! -f "$PKG_ROOT/dist/raccoon-app/index.html" ]; then
  log "building connector deliverables at the repo root"
  (cd "$REPO_ROOT" && npm run build:app && npm run bundle -w @raccoon/connector-nanoclaw)
fi
[ -f "$PKG_ROOT/dist/raccoon.bundle.mjs" ] || fail "dist/raccoon.bundle.mjs missing after build"
[ -f "$PKG_ROOT/dist/raccoon.bundle.d.mts" ] || fail "dist/raccoon.bundle.d.mts missing after build"
[ -f "$PKG_ROOT/dist/raccoon-app/index.html" ] || fail "dist/raccoon-app/index.html missing after build"

# --- 1. Obtain a NanoClaw checkout ------------------------------------------
NC="$WORKDIR/nanoclaw"
if [ "${1:-}" != "" ]; then
  [ -d "$1" ] || fail "checkout path '$1' is not a directory"
  log "copying existing checkout $1 (original untouched)"
  cp -R "$1" "$NC"
else
  log "cloning $NANOCLAW_REPO (shallow)"
  git clone --depth 1 "$NANOCLAW_REPO" "$NC"
fi
[ -f "$NC/package.json" ] || fail "no package.json in the NanoClaw checkout"
[ -d "$NC/src/channels" ] || fail "no src/channels/ in the NanoClaw checkout (adapter surface moved?)"

# --- 2. Apply the skill's file steps mechanically ---------------------------
log "copying adapter artifacts into src/channels/"
cp "$PKG_ROOT/dist/raccoon.bundle.mjs" "$NC/src/channels/raccoon.bundle.mjs"
cp "$PKG_ROOT/dist/raccoon.bundle.d.mts" "$NC/src/channels/raccoon.bundle.d.mts"
rm -rf "$NC/src/channels/raccoon-app"
cp -R "$PKG_ROOT/dist/raccoon-app" "$NC/src/channels/raccoon-app"
cp "$PKG_ROOT/templates/raccoon.channel.ts" "$NC/src/channels/raccoon.ts"

log "registering the channel in the barrel"
if ! grep -q "import './raccoon.js';" "$NC/src/channels/index.ts"; then
  printf "\n// Raccoon messenger channel (verify-nanoclaw-install)\nimport './raccoon.js';\n" >> "$NC/src/channels/index.ts"
fi

log "picking free ports"
RACCOON_PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"
RACCOON_ADMIN_PORT="$(node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close();});')"
RACCOON_ADMIN_SECRET="verify-$(date +%s)-$RANDOM"

log "appending the .env block"
cat >> "$NC/.env" <<EOF

# --- Raccoon channel (verify-nanoclaw-install test values) ---
RACCOON_PORT=$RACCOON_PORT
RACCOON_INSTANCE_URL=ws://127.0.0.1:$RACCOON_PORT/
RACCOON_PUBLIC_ORIGIN=http://127.0.0.1:$RACCOON_PORT
RACCOON_CHANNELS=main=default
RACCOON_ADMIN_SECRET=$RACCOON_ADMIN_SECRET
RACCOON_ADMIN_PORT=$RACCOON_ADMIN_PORT
EOF

log "wiring the postbuild copy step into package.json"
node - "$NC/package.json" <<'EOF'
const { readFileSync, writeFileSync } = require('node:fs');
const path = process.argv[2];
const pkg = JSON.parse(readFileSync(path, 'utf8'));
const copies = 'cp src/channels/raccoon.bundle.mjs dist/channels/ && cp -R src/channels/raccoon-app dist/channels/raccoon-app';
pkg.scripts = pkg.scripts ?? {};
if (pkg.scripts.postbuild && !pkg.scripts.postbuild.includes('raccoon.bundle.mjs')) {
  pkg.scripts.postbuild = `${pkg.scripts.postbuild} && ${copies}`;
} else if (!pkg.scripts.postbuild) {
  pkg.scripts.postbuild = copies;
}
writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
console.log('postbuild =', pkg.scripts.postbuild);
EOF

# --- 3. Install and build with THEIR toolchain ------------------------------
cd "$NC"
if command -v pnpm >/dev/null 2>&1; then
  log "installing dependencies (pnpm)"
  pnpm install
else
  log "installing dependencies (npm; NanoClaw prefers pnpm — fallback only)"
  npm install
fi

log "running their build (tsc + postbuild copy)"
npm run build

[ -f dist/channels/raccoon.bundle.mjs ] || fail "postbuild did not copy raccoon.bundle.mjs into dist/channels/"
[ -f dist/channels/raccoon-app/index.html ] || fail "postbuild did not copy raccoon-app/ into dist/channels/"
[ -f dist/channels/raccoon.js ] || fail "tsc did not compile src/channels/raccoon.ts"

# --- 4. Boot the compiled host and probe the raccoon port -------------------
log "starting node dist/index.js"
node dist/index.js > "$WORKDIR/host.log" 2>&1 &
HOST_PID=$!

DEADLINE=$((SECONDS + 45))
BODY=""
while [ $SECONDS -lt $DEADLINE ]; do
  if ! kill -0 "$HOST_PID" 2>/dev/null; then
    sed -n '1,40p' "$WORKDIR/host.log" >&2 || true
    fail "host exited before the raccoon hub bound (see log above; NanoClaw may need more configuration to boot)"
  fi
  BODY="$(curl -fsS "http://127.0.0.1:$RACCOON_PORT/" 2>/dev/null || true)"
  if [ -n "$BODY" ]; then break; fi
  sleep 1
done

case "$BODY" in
  *"<!doctype html"*|*"<!DOCTYPE html"*)
    log "OK: raccoon port $RACCOON_PORT served the PWA index.html from the compiled layout"
    ;;
  *)
    sed -n '1,40p' "$WORKDIR/host.log" >&2 || true
    fail "raccoon port $RACCOON_PORT did not serve index.html within 45s"
    ;;
esac

log "verify-nanoclaw-install: PASS"
