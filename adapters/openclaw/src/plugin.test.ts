import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRaccoonChannel } from './plugin.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'raccoon-oc-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html><title>oc</title>');
});

afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

describe('createRaccoonChannel (Plan C options)', () => {
  it('serves the static app when staticDir is provided', async () => {
    const channel = createRaccoonChannel({
      instance: 't', instanceUrl: 'ws://127.0.0.1:0/', port: 0, channels: ['echo'],
      runner: { run: async function* () { yield 'ok'; } },
      staticDir: dir,
    });
    const { port } = await channel.start();
    const res = await fetch(`http://127.0.0.1:${port}/`);
    expect(await res.text()).toContain('oc');
    await channel.stop();
  });
});
