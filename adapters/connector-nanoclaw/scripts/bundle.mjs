// Build the fork-droppable deliverables:
//   dist/raccoon.bundle.mjs  - self-contained adapter runtime (no npm deps)
//   dist/raccoon-app/        - built @raccoon/app PWA the hub serves (staticDir)
// Requires `npm run build:app` at the repo root first. A missing app build is
// a HARD ERROR (a bundle without the PWA is not installable) unless --no-app
// is passed (test/CI shortcut for the JS-only smoke check).
import { build } from 'esbuild';
import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const repoRoot = dirname(dirname(pkgRoot));
const skipApp = process.argv.includes('--no-app');

await build({
  entryPoints: [join(pkgRoot, 'src/index.ts')],
  outfile: join(pkgRoot, 'dist/raccoon.bundle.mjs'),
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  packages: 'bundle',
  banner: {
    js: "import { createRequire as __cnRequire } from 'node:module'; const require = __cnRequire(import.meta.url);",
  },
});

// Copy the typed declaration for the bundle (install-time structural check
// against the fork's own adapter types — see templates/raccoon.bundle.d.mts).
cpSync(join(pkgRoot, 'templates/raccoon.bundle.d.mts'), join(pkgRoot, 'dist/raccoon.bundle.d.mts'));

// The standalone PWA build writes to dist-standalone/, NOT dist/ (dist/ is the
// library build) — see packages/app/vite.config.ts. `npm run build:app` at the
// repo root runs build:standalone.
const appDist = join(repoRoot, 'packages/app/dist-standalone');
if (existsSync(join(appDist, 'index.html'))) {
  mkdirSync(join(pkgRoot, 'dist/raccoon-app'), { recursive: true });
  cpSync(appDist, join(pkgRoot, 'dist/raccoon-app'), { recursive: true });
  console.log('bundled: dist/raccoon.bundle.mjs + dist/raccoon.bundle.d.mts + dist/raccoon-app/');
} else if (skipApp) {
  console.warn('--no-app: bundle built WITHOUT the PWA assets (not installable)');
} else {
  console.error('ERROR: packages/app/dist-standalone/index.html not found - run `npm run build:app` first');
  process.exit(1);
}
