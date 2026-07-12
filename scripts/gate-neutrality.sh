#!/usr/bin/env bash
# v0.1 vendor-neutrality gate. The Raccoon CORE + the first-party OpenClaw
# connector must contain zero CloudSignal/GTM/Supabase runtime identifiers, and
# no published package may import another through a deep /src path. Fails CI on
# violation. (Test fixtures / doc comments referencing a vendor are allowed —
# hence the *.test.* exclusion; runtime source must be clean.)
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

fail=0

echo "== neutrality: no @cloudsignal/cloudsignal/gtm/supabase in core runtime =="
if rg -n --glob '!**/*.test.*' "@cloudsignal|cloudsignal|gtm|supabase" "${CORE_SRC[@]}" 2>/dev/null; then
  echo "ERROR: vendor identifier found in core runtime source (above). Remove it — core must be vendor-neutral." >&2
  fail=1
else
  echo "  OK — zero matches"
fi

echo "== boundary: no published package imports another via /src =="
if rg -n "from ['\"]@raccoon/[a-z-]+/src" "${CORE_SRC[@]}" 2>/dev/null; then
  echo "ERROR: a deep /src import found (above). Import the package ROOT instead." >&2
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
