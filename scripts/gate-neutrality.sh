#!/usr/bin/env bash
# v0.1 vendor-neutrality gate. The Raccoon CORE + the first-party OpenClaw
# connector must contain ZERO CloudSignal/GTM/Supabase identifiers
# (case-insensitive, INCLUDING comments — a published neutral core names no
# downstream vendor), and no published package may import another through a deep
# /src path.
#
# Uses `grep` (POSIX; present on macOS and GitHub's ubuntu runners) — NOT
# ripgrep. `rg` is not installed on CI runners and, in local dev, is a shell
# FUNCTION shim that a child bash script does not inherit; the previous
# `if rg … 2>/dev/null` form therefore hit "command not found", swallowed it,
# and silently reported "zero matches" (a false green that let release:verify
# pass over real vendor words). This version checks grep's exit code
# explicitly: 0 = matches -> FAIL, 1 = clean -> OK, >=2 = grep error -> FAIL LOUD.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

CORE_SRC=(
  packages/protocol/src
  packages/app/src
  packages/bridge/src
  packages/pairing/src
  packages/transport-ws/src
  packages/push/src
  adapters/connector-openclaw/src
)

INCLUDES=(--include='*.ts' --include='*.tsx')
EXCLUDES=(--exclude='*.test.ts' --exclude='*.test.tsx' --exclude='*.spec.ts')

fail=0

echo "== neutrality: no cloudsignal/gtm/supabase identifier in core (incl. comments) =="
set +e
scan_out="$(grep -rniE 'cloudsignal|gtm|supabase' "${CORE_SRC[@]}" "${INCLUDES[@]}" "${EXCLUDES[@]}")"
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  printf '%s\n' "$scan_out" >&2
  echo "ERROR: vendor identifier found in core (above). A published neutral core names no downstream vendor — reword or remove." >&2
  fail=1
elif [ "$rc" -ge 2 ]; then
  echo "ERROR: grep failed (rc=$rc) scanning core — cannot verify neutrality (do NOT treat as clean)." >&2
  fail=1
else
  echo "  OK — zero matches"
fi

echo "== boundary: no published package imports another via /src =="
set +e
scan_out="$(grep -rnE "from ['\"]@raccoon/[a-z-]+/src" "${CORE_SRC[@]}" "${INCLUDES[@]}" "${EXCLUDES[@]}")"
rc=$?
set -e
if [ "$rc" -eq 0 ]; then
  printf '%s\n' "$scan_out" >&2
  echo "ERROR: a deep /src import found (above). Import the package ROOT instead." >&2
  fail=1
elif [ "$rc" -ge 2 ]; then
  echo "ERROR: grep failed (rc=$rc) scanning for /src imports." >&2
  fail=1
else
  echo "  OK — zero /src imports"
fi

echo "== boundary: core packages must not depend on @raccoon/transport-cloudsignal =="
for p in protocol app bridge pairing transport-ws push; do
  if node -e "const d=require('./packages/$p/package.json');const all={...d.dependencies,...d.peerDependencies};process.exit(all['@raccoon/transport-cloudsignal']?1:0)"; then :; else
    echo "ERROR: packages/$p depends on @raccoon/transport-cloudsignal (a downstream/GTM transport)." >&2; fail=1
  fi
done
if node -e "const d=require('./adapters/connector-openclaw/package.json');const all={...d.dependencies,...d.peerDependencies};process.exit(all['@raccoon/transport-cloudsignal']?1:0)"; then :; else
  echo "ERROR: connector-openclaw depends on @raccoon/transport-cloudsignal." >&2; fail=1
fi
[ "$fail" = 0 ] && echo "  OK — no core dependency on transport-cloudsignal"

exit $fail
