// Dependency-completeness gate. For every PUBLISHED package, scan its built
// dist for bare (non-relative) import/require specifiers and assert each is a
// DECLARED dependency (deps / peerDeps / optionalDeps) — or a Node builtin, or
// the package's own name. A directly-imported-but-undeclared module (e.g. the
// connector importing `ulid` or `@raccoon/protocol` transitively) resolves in a
// hoisted npm tree but ERR_MODULE_NOT_FOUND's under strict pnpm — this catches
// it deterministically, without an install. Run after `npm run build`.
import { builtinModules } from 'node:module';
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKGS = [
  'packages/protocol', 'packages/transport-ws', 'packages/pairing', 'packages/push',
  'packages/bridge', 'adapters/connector-openclaw', 'packages/app',
];
const BUILTINS = new Set([...builtinModules, ...builtinModules.map((m) => `node:${m}`)]);

/** Package name of a bare specifier: '@scope/n/sub' -> '@scope/n'; 'n/sub' -> 'n'. */
function pkgName(spec) {
  const parts = spec.split('/');
  return spec.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

function jsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    const s = statSync(p);
    if (s.isDirectory()) jsFiles(p, out);
    else if (e.endsWith('.js')) out.push(p);
  }
  return out;
}

const IMPORT_RE = /(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

let failed = false;
for (const rel of PKGS) {
  const pkg = JSON.parse(readFileSync(join(ROOT, rel, 'package.json'), 'utf8'));
  const declared = new Set([
    pkg.name,
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ]);
  const dist = join(ROOT, rel, 'dist');
  if (!existsSync(dist)) { console.error(`ERROR: ${rel}/dist missing — run \`npm run build\` first.`); failed = true; continue; }
  const missing = new Set();
  for (const file of jsFiles(dist)) {
    const src = readFileSync(file, 'utf8');
    let m;
    while ((m = IMPORT_RE.exec(src)) !== null) {
      const spec = m[1] ?? m[2];
      if (!spec || spec.startsWith('.') || spec.startsWith('/')) continue; // relative
      if (BUILTINS.has(spec) || BUILTINS.has(pkgName(spec))) continue;      // node builtin
      const name = pkgName(spec);
      if (!declared.has(name)) missing.add(name);
    }
  }
  if (missing.size > 0) {
    console.error(`ERROR: ${pkg.name} imports undeclared package(s): ${[...missing].sort().join(', ')}`);
    console.error(`       Add them to "dependencies" (or "peerDependencies") in ${rel}/package.json.`);
    failed = true;
  } else {
    console.log(`  OK — ${pkg.name}: every bare import is declared`);
  }
}

if (failed) { console.error('dependency-completeness gate FAILED'); process.exit(1); }
console.log('dependency-completeness gate: PASS');
