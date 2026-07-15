#!/usr/bin/env bash
# Publish the EXACT tarballs release:pack produced and release:verify gated —
# never a fresh pack of the workspaces. Run `npm run release:verify` first (it
# regenerates release-artifacts/ deterministically and gates it), then this.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
OUT="$ROOT/release-artifacts"
[ -d "$OUT" ] || { echo "no release-artifacts/ — run 'npm run release:verify' first" >&2; exit 1; }
shopt -s nullglob
tarballs=("$OUT"/*.tgz)
[ ${#tarballs[@]} -gt 0 ] || { echo "no tarballs in $OUT — run 'npm run release:verify' first" >&2; exit 1; }
echo "Publishing ${#tarballs[@]} gated tarballs from $OUT (npm publish --access public):"
for t in "${tarballs[@]}"; do echo "  $(basename "$t")"; done
for t in "${tarballs[@]}"; do
  npm publish "$t" --access public "$@"   # pass-through flags e.g. --dry-run / --tag
done
echo "release-publish: done"
