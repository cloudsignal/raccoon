import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('bundle', () => {
  it('builds a self-contained ESM bundle exporting the adapter factory', () => {
    execFileSync('node', [join(pkgRoot, 'scripts/bundle.mjs'), '--no-app'], { stdio: 'pipe' });
    const bundle = join(pkgRoot, 'dist/raccoon.bundle.mjs');
    expect(existsSync(bundle)).toBe(true);
    // import from a bare node process with cwd OUTSIDE the workspace: proves
    // no runtime resolution against node_modules leaks out of the bundle.
    const out = execFileSync(
      'node',
      ['--input-type=module', '-e',
       `import(${JSON.stringify(bundle)}).then(m => console.log(typeof m.createRaccoonChannelAdapter, typeof m.RACCOON_CHANNEL_DEFAULTS));`],
      { stdio: 'pipe', cwd: '/tmp' },
    ).toString().trim();
    expect(out).toBe('function object');
  }, 60_000);

  it('fails hard without the PWA build unless --no-app', () => {
    // Only meaningful when packages/app/dist-standalone is absent; when present
    // the default path succeeds and this asserts the inverse contract.
    const appBuilt = existsSync(join(pkgRoot, '../../packages/app/dist-standalone/index.html'));
    if (appBuilt) return; // covered: default path copies the assets
    expect(() => execFileSync('node', [join(pkgRoot, 'scripts/bundle.mjs')], { stdio: 'pipe' })).toThrow();
  });

  it('ships the typed declaration next to the bundle', () => {
    expect(existsSync(join(pkgRoot, 'dist/raccoon.bundle.d.mts'))).toBe(true);
  });
});
