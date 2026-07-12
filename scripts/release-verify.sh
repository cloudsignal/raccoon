#!/usr/bin/env bash
# v0.1 release acceptance gate. Proves the published packages install as
# TARBALLS into a FRESH consumer project OUTSIDE the monorepo and build there
# with NO sibling repo, NO vendored tree, NO path aliases into source, NO deep
# /src imports, and NO CloudSignal/GTM dependency — importing only package
# ROOTS. Also runs the neutrality gate and a runtime ESM smoke.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "== 1/5 neutrality gate =="
npm run gate:neutrality

echo "== 2/5 build all published libs (dist + declarations) =="
npm run build >/dev/null
echo "  built"

echo "== 3/5 pack every published package =="
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
ls "$WORK"/*.tgz | sed "s#$WORK/#  packed #"

echo "== 4/5 build a FRESH external consumer fixture against the tarballs =="
FIX="$WORK/fixture"
mkdir -p "$FIX/src"
tgz() { echo "file:$WORK/raccoon-$1-0.1.0.tgz"; }
cat > "$FIX/package.json" <<JSON
{
  "name": "raccoon-consumer-fixture",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "dependencies": {
    "@raccoon/protocol": "$(tgz protocol)",
    "@raccoon/transport-ws": "$(tgz transport-ws)",
    "@raccoon/pairing": "$(tgz pairing)",
    "@raccoon/push": "$(tgz push)",
    "@raccoon/bridge": "$(tgz bridge)",
    "@raccoon/connector-openclaw": "$(tgz connector-openclaw)",
    "@raccoon/app": "$(tgz app)",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "openclaw": "2026.6.11"
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@types/node": "^22.0.0"
  }
}
JSON
cat > "$FIX/tsconfig.json" <<JSON
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "jsx": "react-jsx",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src"]
}
JSON
# Consume ONLY package roots — never @raccoon/*/src. Named + namespace imports
# prove both the exports map and the emitted declarations resolve.
cat > "$FIX/src/consume.tsx" <<'TS'
import { createEnvelope, type AnyEnvelope } from '@raccoon/protocol';
import { RaccoonBridge, type AgentRunner, type MessageStore } from '@raccoon/bridge';
import { WsHub, WsClientTransport } from '@raccoon/transport-ws';
import * as pairing from '@raccoon/pairing';
import { vendorOf } from '@raccoon/push';
import { createRaccoonChannel } from '@raccoon/connector-openclaw';
import { TransportProvider, App, type Session } from '@raccoon/app';

const env: AnyEnvelope = createEnvelope('msg', {
  from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'hi' },
});
void env; void RaccoonBridge; void WsHub; void WsClientTransport; void pairing;
void vendorOf; void createRaccoonChannel; void TransportProvider; void App;
type _Runner = AgentRunner; type _Store = MessageStore; type _S = Session;
TS
( cd "$FIX" && npm install --no-audit --no-fund >/dev/null 2>&1 && npx tsc --noEmit )
echo "  fixture typechecks against tarball roots"

echo "== 5/5 fixture boundary assertions + runtime ESM smoke =="
if grep -rn "@raccoon/[a-z-]*/src" "$FIX/src"; then echo "ERROR: fixture used a /src import" >&2; exit 1; fi
if grep -rniE "cloudsignal|gtm|supabase" "$FIX/src"; then echo "ERROR: fixture referenced a vendor identifier" >&2; exit 1; fi
cat > "$FIX/src/smoke.mjs" <<'JS'
import { createEnvelope } from '@raccoon/protocol';
const e = createEnvelope('msg', { from: 'user:u1', to: 'agent:a', channel: 'c', payload: { text: 'ok' } });
if (e.kind !== 'msg') { console.error('smoke FAILED'); process.exit(1); }
console.log('  runtime ESM smoke: @raccoon/protocol resolves + runs from tarball dist');
JS
( cd "$FIX" && node src/smoke.mjs )

echo ""
echo "RELEASE VERIFY: PASS — packed tarballs build in a fresh consumer with package-root imports only."
