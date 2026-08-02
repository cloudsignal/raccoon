// Post-tsc production layout simulation. NanoClaw's build is bare `tsc`
// (outDir dist/), which does NOT copy the bundle or the PWA directory — the
// add-raccoon skill wires a `postbuild` copy step into the fork's
// package.json. This test proves that layout works: the bundle imported FROM
// dist/channels/ (a bare node subprocess, no workspace node_modules) with a
// raccoon-app/ directory adjacent serves the PWA's index.html at `/`.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const pkgRoot = dirname(dirname(fileURLToPath(import.meta.url)));

describe('dist layout (postbuild copy simulation)', () => {
  const tmp = mkdtempSync(join(tmpdir(), 'rc-dist-layout-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('serves the PWA from raccoon-app/ adjacent to the bundle copied into dist/channels/', () => {
    // Build the bundle if a previous build has not left one (same shortcut as
    // bundle.test.ts: --no-app builds the JS without requiring the PWA build).
    const bundleSrc = join(pkgRoot, 'dist/raccoon.bundle.mjs');
    if (!existsSync(bundleSrc)) {
      execFileSync('node', [join(pkgRoot, 'scripts/bundle.mjs'), '--no-app'], { stdio: 'pipe' });
    }

    // Simulate the post-tsc fork layout: dist/channels/ holds the copied
    // bundle with a raccoon-app/ directory (fake PWA: one index.html) beside it.
    const channelsDir = join(tmp, 'dist/channels');
    mkdirSync(channelsDir, { recursive: true });
    const bundleCopy = join(channelsDir, 'raccoon.bundle.mjs');
    cpSync(bundleSrc, bundleCopy);
    const appDir = join(channelsDir, 'raccoon-app');
    mkdirSync(appDir);
    const marker = '<!doctype html><title>raccoon-dist-layout-ok</title>';
    writeFileSync(join(appDir, 'index.html'), marker);
    const dataDir = join(tmp, 'data');

    // Import the COPIED bundle from a bare node subprocess with cwd outside
    // the workspace (as bundle.test.ts does): construct the adapter exactly
    // as the installed wrapper would (env + staticDir beside the bundle),
    // setup(), fetch `/`, teardown.
    const script = `
      import { createServer } from 'node:net';
      const freePort = () => new Promise((resolve, reject) => {
        const srv = createServer();
        srv.once('error', reject);
        srv.listen(0, '127.0.0.1', () => {
          const port = srv.address().port;
          srv.close((err) => (err ? reject(err) : resolve(port)));
        });
      });
      const port = await freePort();
      const adminPort = await freePort();
      const { createRaccoonChannelAdapter } = await import(${JSON.stringify(bundleCopy)});
      const adapter = createRaccoonChannelAdapter({
        env: {
          RACCOON_PORT: String(port),
          RACCOON_ADMIN_PORT: String(adminPort),
          RACCOON_INSTANCE_URL: 'ws://127.0.0.1:' + port,
          RACCOON_PUBLIC_ORIGIN: 'http://127.0.0.1:' + port,
          RACCOON_CHANNELS: 'assistant=main-group',
          RACCOON_ADMIN_SECRET: 'dist-layout-secret',
          RACCOON_DATA_DIR: ${JSON.stringify(dataDir)},
        },
        staticDir: ${JSON.stringify(appDir)},
      });
      if (!adapter) throw new Error('factory returned null');
      await adapter.setup({
        onInbound() {}, onInboundEvent() {}, onMetadata() {}, onAction() {},
      });
      const res = await fetch('http://127.0.0.1:' + port + '/');
      const body = await res.text();
      await adapter.teardown();
      console.log(JSON.stringify({ status: res.status, body }));
    `;
    const out = execFileSync('node', ['--input-type=module', '-e', script], {
      stdio: 'pipe',
      cwd: tmp, // outside the workspace: no node_modules resolution can leak in
    }).toString().trim();
    const result = JSON.parse(out.split('\n').at(-1)!) as { status: number; body: string };
    expect(result.status).toBe(200);
    expect(result.body).toBe(marker);
  }, 60_000);
});
