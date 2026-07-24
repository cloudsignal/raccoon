import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { InMemorySubscriptionStore } from '@raccoon/push';
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

  it('revoke() clears the user\'s push subscriptions, not just their pairing (#R3-7)', async () => {
    // A revoked user's push registrations previously survived revoke() entirely
    // (InMemorySubscriptionStore lived only inside withPushFallback, unreachable
    // from revoke()), so a revoked device kept receiving push notifications.
    const clearSpy = vi.spyOn(InMemorySubscriptionStore.prototype, 'clear');
    const channel = createRaccoonChannel({
      instance: 't', instanceUrl: 'ws://127.0.0.1:0/', port: 0, channels: ['echo'],
      runner: { run: async function* () { yield 'ok'; } },
      vapid: { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:a@b.com' },
    });
    await channel.start();
    await channel.revoke('u1');
    expect(clearSpy).toHaveBeenCalledWith('u1');
    await channel.stop();
    clearSpy.mockRestore();
  });

  it('revoke() does not throw when push is not configured (no vapid option)', async () => {
    const channel = createRaccoonChannel({
      instance: 't', instanceUrl: 'ws://127.0.0.1:0/', port: 0, channels: ['echo'],
      runner: { run: async function* () { yield 'ok'; } },
    });
    await channel.start();
    await expect(channel.revoke('u1')).resolves.toBeUndefined();
    await channel.stop();
  });

  it('wires the hub media store into the bridge and honors the mediaDir option (#media)', async () => {
    const mediaDir = join(dir, 'media-t8');
    const channel = createRaccoonChannel({
      instance: 't', instanceUrl: 'ws://127.0.0.1:0/', port: 0, channels: ['echo'],
      runner: { run: async function* () { yield 'ok'; } },
      mediaDir,
    });

    // The bridge's MediaReferencer dep must be the hub's OWN store instance —
    // a second store (or none) would leave recorded message attachments
    // permanently unreferenced, so the sweep would delete their blobs.
    expect((channel.bridge as unknown as { media?: unknown }).media).toBe(channel.hub.media);

    // And the store must actually live under the caller-supplied mediaDir
    // (not the WsHub's cwd-relative default): a saved blob lands there
    // (on-disk layout: <mediaDir>/<id>/blob + meta.json).
    const saved = await channel.hub.media.save(Readable.from(Buffer.from('png-bytes')), {
      mime: 'image/png', name: 'pic.png', uploadedBy: 'u1',
    });
    if (!saved.ok) throw new Error(`save failed: ${saved.error}`);
    const id = saved.attachment.url.split('/')[2]!;
    expect(existsSync(join(mediaDir, id, 'blob'))).toBe(true);
  });
});
