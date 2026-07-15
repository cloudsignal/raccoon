#!/usr/bin/env bash
# Deterministic release packing. The tarballs this produces are the SAME
# artifacts that release:verify gates and release:publish ships — the workspaces
# are never repacked afterward, so what's verified is exactly what's published.
#
#   1. CLEAN every output dir (so a since-removed file can't survive in dist and
#      get republished).
#   2. BUILD in dependency order with a REAL build id (never 'dev').
#   3. Verify dependency-completeness on the freshly-built dist.
#   4. PACK each published package to the persistent release-artifacts/ dir, with
#      --ignore-scripts so pack ships exactly what was built (no rebuild).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
VERSION="$(node -p "require('./packages/protocol/package.json').version")"
OUT="$ROOT/release-artifacts"

echo "== 1/4 clean every output dir =="
for d in packages/*/dist packages/*/dist-standalone adapters/*/dist; do rm -rf "$d"; done
rm -rf "$OUT"
mkdir -p "$OUT"
echo "  cleaned dist / dist-standalone; fresh $OUT"

echo "== 2/4 build libs (dependency order) + PWA with BUILD_ID=$VERSION =="
npm run build >/dev/null                          # protocol → transport-ws → pairing → push → bridge → connector → app lib
BUILD_ID="$VERSION" npm run build:app >/dev/null  # dist-standalone with a real (non-dev) build id
echo "  built"

echo "== 3/4 dependency-completeness (every bare import in dist is declared) =="
npm run gate:deps

echo "== 4/4 pack each published package to $OUT (--ignore-scripts: ship exactly what was built) =="
dir_of() { case "$1" in connector-openclaw) echo "adapters/connector-openclaw" ;; *) echo "packages/$1" ;; esac; }
for p in protocol transport-ws pairing push bridge connector-openclaw app; do
  ( cd "$(dir_of "$p")" && npm pack --ignore-scripts --pack-destination "$OUT" >/dev/null )
done
ls "$OUT"/*.tgz | sed "s#$OUT/#  #"
echo "release-pack: done — $OUT holds the immutable release tarballs"
