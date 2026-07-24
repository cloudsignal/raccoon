import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Envelope } from '@raccoon/protocol';
import { createMediaStore } from './media-store.js';
import { createMediaHttpHandler } from './media-http.js';
import { WsHub } from './hub.js';
import { WsClientTransport } from './client.js';

let server: Server; let base: string; let dir: string;
beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'raccoon-mediahttp-'));
  const store = createMediaStore({ dir, freeBytes: async () => 10 * 1024 ** 3 });
  const handler = createMediaHttpHandler(store, {
    verifyBearer: async (t) => (t === 'good' ? 'u1' : t === 'other' ? 'u2' : null),
    referenceSecret: 'shh',
  });
  server = createServer((req, res) => { void handler(req, res).then((hit) => { if (!hit) { res.statusCode = 404; res.end(); } }); });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterEach(async () => { await new Promise((r) => server.close(r)); rmSync(dir, { recursive: true, force: true }); });

async function upload(token = 'good', bytes = 'hello', mime = 'image/png', name = 'a.png') {
  return fetch(`${base}/media`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': mime, 'x-raccoon-filename': encodeURIComponent(name) },
    body: bytes,
  });
}

describe('POST /media', () => {
  it('401 without a valid bearer; 201 with attachment JSON on success', async () => {
    expect((await upload('bad')).status).toBe(401);
    const res = await upload();
    expect(res.status).toBe(201);
    const a = await res.json();
    expect(a.url).toMatch(/^\/media\/[0-9A-HJKMNP-TV-Z]{26}\/a.png$/);
    expect(a).toMatchObject({ mime: 'image/png', name: 'a.png', size: 5 });
  });
  it('413 on oversized declared Content-Length (no body read)', async () => {
    // Raw socket request — fetch/undici refuses a mismatched Content-Length,
    // which previously made this test vacuous.
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(`${base}/media`, {
        method: 'POST',
        headers: { authorization: 'Bearer good', 'content-type': 'text/plain', 'content-length': String(26 * 1024 * 1024) },
      }, (res) => resolve(res.statusCode ?? 0));
      r.on('error', reject);
      r.write('x'); // server must answer 413 without waiting for the full body
      // do NOT end() with matching length — the 413 must arrive first
      setTimeout(() => r.destroy(), 2000);
    });
    expect(status).toBe(413);
  });

  it('413 when a CHUNKED body exceeds the cap mid-stream (server responds before the client finishes)', async () => {
    // Second server with a tiny cap, same wiring as beforeEach:
    const capDir = mkdtempSync(join(tmpdir(), 'raccoon-mediahttp-cap-'));
    const capStore = createMediaStore({ dir: capDir, maxFileBytes: 8, freeBytes: async () => 10 * 1024 ** 3 });
    const capHandler = createMediaHttpHandler(capStore, { verifyBearer: async (t) => (t === 'good' ? 'u1' : null) });
    const capServer = createServer((req2, res2) => { void capHandler(req2, res2).then((hit) => { if (!hit) { res2.statusCode = 404; res2.end(); } }).catch(() => res2.destroy()); });
    await new Promise<void>((r) => capServer.listen(0, '127.0.0.1', r));
    const smallCapBase = `http://127.0.0.1:${(capServer.address() as { port: number }).port}`;
    const { request } = await import('node:http');
    const status = await new Promise<number>((resolve, reject) => {
      const r = request(`${smallCapBase}/media`, {
        method: 'POST',
        headers: { authorization: 'Bearer good', 'content-type': 'text/plain', 'transfer-encoding': 'chunked' },
      }, (res) => resolve(res.statusCode ?? 0));
      r.on('error', reject);
      const timer = setInterval(() => r.write('xxxxxxxx'), 5); // keep exceeding the cap
      r.on('response', () => clearInterval(timer));
      setTimeout(() => { clearInterval(timer); r.destroy(); }, 3000);
    });
    expect(status).toBe(413);
    await new Promise((r) => capServer.close(r));
    rmSync(capDir, { recursive: true, force: true });
  });
  // Implementation note this test enforces: when the capped Transform errors,
  // save() must resolve { ok:false, error:'too-large' } and the handler must
  // WRITE the 413 while the request stream may still be flowing — do not let
  // pipeline() destroy `req` in a way that tears down the response socket
  // before the 413 is written (write the response first, then let the
  // connection close).
  it('429 past the per-identity rate cap', async () => {
    let last = 0;
    for (let i = 0; i < 21; i++) last = (await upload()).status;
    expect(last).toBe(429);
  });
});

describe('GET /media', () => {
  it('serves inline-safe mimes as stored, others as octet-stream attachment; always nosniff; filename segment is decorative', async () => {
    const img = await (await upload('good', 'img', 'image/png', 'pic.png')).json();
    const res = await fetch(`${base}${img.url.replace('pic.png', 'meta.json')}`); // decorative segment swapped
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe('img');

    const html = await (await upload('good', '<script>1</script>', 'text/html', 'x.html')).json();
    const res2 = await fetch(`${base}${html.url}`);
    expect(res2.headers.get('content-type')).toBe('application/octet-stream');
    expect(res2.headers.get('content-disposition')).toContain('attachment');
  });
  it('404 for unknown ids', async () => {
    expect((await fetch(`${base}/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/x.png`)).status).toBe(404);
  });
});

describe('DELETE /media/<id>', () => {
  it('owner-only (403), 409 once referenced, 204 when deletable', async () => {
    const a = await (await upload()).json();
    const id = a.url.split('/')[2];
    expect((await fetch(`${base}/media/${id}`, { method: 'DELETE', headers: { authorization: 'Bearer other' } })).status).toBe(403);
    await fetch(`${base}/media/reference`, { method: 'POST', headers: { 'x-media-secret': 'shh', 'content-type': 'application/json' }, body: JSON.stringify({ paths: [a.url] }) });
    expect((await fetch(`${base}/media/${id}`, { method: 'DELETE', headers: { authorization: 'Bearer good' } })).status).toBe(409);
    const b = await (await upload()).json();
    expect((await fetch(`${base}/media/${b.url.split('/')[2]}`, { method: 'DELETE', headers: { authorization: 'Bearer good' } })).status).toBe(204);
  });
});

describe('POST /media/reference', () => {
  it('bearer callers get a LEASE (owner can still delete); secret callers get the PERMANENT reference (delete 409)', async () => {
    const a = await (await upload()).json();
    const viaBearer = await fetch(`${base}/media/reference`, { method: 'POST', headers: { authorization: 'Bearer good', 'content-type': 'application/json' }, body: JSON.stringify({ paths: [a.url, '/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/no'], messageId: 'env-1' }) });
    expect(viaBearer.status).toBe(200);
    const body = await viaBearer.json();
    expect(body.known[0].url).toBe(a.url);
    expect(body.unknown).toHaveLength(1);
    // lease does not lock the owner out:
    expect((await fetch(`${base}/media/${a.url.split('/')[2]}`, { method: 'DELETE', headers: { authorization: 'Bearer good' } })).status).toBe(204);

    const b = await (await upload()).json();
    const viaSecret = await fetch(`${base}/media/reference`, { method: 'POST', headers: { 'x-media-secret': 'shh', 'content-type': 'application/json' }, body: JSON.stringify({ paths: [b.url] }) });
    expect(viaSecret.status).toBe(200);
    expect((await fetch(`${base}/media/${b.url.split('/')[2]}`, { method: 'DELETE', headers: { authorization: 'Bearer good' } })).status).toBe(409);

    expect((await fetch(`${base}/media/reference`, { method: 'POST', body: '{}' })).status).toBe(401);
  });

  it('an empty/whitespace referenceSecret behaves as NOT CONFIGURED (secret header cannot authenticate)', async () => {
    // A compose file exporting MEDIA_REFERENCE_SECRET='' must not turn the
    // empty string into a valid server-to-server credential.
    const emptyDir = mkdtempSync(join(tmpdir(), 'raccoon-mediahttp-empty-'));
    const emptyStore = createMediaStore({ dir: emptyDir, freeBytes: async () => 10 * 1024 ** 3 });
    const emptyHandler = createMediaHttpHandler(emptyStore, { verifyBearer: async () => null, referenceSecret: '  ' });
    const emptyServer = createServer((req2, res2) => { void emptyHandler(req2, res2).then((hit) => { if (!hit) { res2.statusCode = 404; res2.end(); } }); });
    await new Promise<void>((r) => emptyServer.listen(0, '127.0.0.1', r));
    const emptyBase = `http://127.0.0.1:${(emptyServer.address() as { port: number }).port}`;
    const res = await fetch(`${emptyBase}/media/reference`, {
      method: 'POST',
      headers: { 'x-media-secret': '  ', 'content-type': 'application/json' },
      body: JSON.stringify({ paths: [] }),
    });
    expect(res.status).toBe(401);
    await new Promise((r) => emptyServer.close(r));
    rmSync(emptyDir, { recursive: true, force: true });
  });
});

describe('HEAD /media', () => {
  it('answers HEAD with the same headers and no body (live checks use it)', async () => {
    const a = await (await upload()).json();
    const res = await fetch(`${base}${a.url}`, { method: 'HEAD' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(await res.text()).toBe('');
  });
});

describe('WsHub media wiring', () => {
  it('uploads with a real paired session token via the real port, serves it back before static, and exposes the store', async () => {
    const mediaDir = mkdtempSync(join(tmpdir(), 'raccoon-hubmedia-'));
    const staticDir = mkdtempSync(join(tmpdir(), 'raccoon-hubmedia-static-'));
    writeFileSync(join(staticDir, 'index.html'), '<!doctype html><title>app</title>');
    const hub = new WsHub({ instance: 'm', channels: ['c'], mediaDir, staticDir });
    const { port } = await hub.start();
    const client = new WsClientTransport({ url: `ws://127.0.0.1:${port}/`, pairingToken: hub.issuePairingToken('u1'), device: 't' });
    try {
      const grants: Envelope<'pair.grant'>[] = [];
      client.onGrant((g) => grants.push(g));
      await client.connect(); // resolves only after pair.confirmed — the session is durable
      const sessionToken = grants[0]!.payload.sessionToken;

      const up = await fetch(`http://127.0.0.1:${port}/media`, {
        method: 'POST',
        headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'image/png', 'x-raccoon-filename': 'hub.png' },
        body: 'hubbytes',
      });
      expect(up.status).toBe(201);
      const a = await up.json();
      expect(a).toMatchObject({ mime: 'image/png', name: 'hub.png', size: 8 });

      // /media/* is answered by the media handler, NOT the SPA fallback:
      const got = await fetch(`http://127.0.0.1:${port}${a.url}`);
      expect(got.status).toBe(200);
      expect(got.headers.get('content-type')).toBe('image/png');
      expect(await got.text()).toBe('hubbytes');
      // static serving still works around it:
      expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toContain('app');
      // a non-session token is refused by the hub's own session auth:
      expect((await fetch(`http://127.0.0.1:${port}/media`, {
        method: 'POST', headers: { authorization: 'Bearer nope' }, body: 'x',
      })).status).toBe(401);

      // the hub EXPOSES the store for host wiring (Task 4's bridge references
      // after its durable append — the hub itself never flips references):
      const opened = await hub.media.open(a.url.split('/')[2]);
      expect(opened?.meta.uploadedBy).toBe('u1');
      expect(opened?.meta.referenced).toBe(false);
      opened?.stream.destroy();
    } finally {
      await client.close();
      await hub.stop();
      rmSync(mediaDir, { recursive: true, force: true });
      rmSync(staticDir, { recursive: true, force: true });
    }
  });
});

describe('error boundary', () => {
  it('answers 500 (never rejects) when the auth backend throws', async () => {
    const boomDir = mkdtempSync(join(tmpdir(), 'raccoon-mediahttp-boom-'));
    const boomStore = createMediaStore({ dir: boomDir, freeBytes: async () => 10 * 1024 ** 3 });
    const boomHandler = createMediaHttpHandler(boomStore, { verifyBearer: async () => { throw new Error('auth store down'); } });
    let rejected = false;
    const boomServer = createServer((req2, res2) => {
      boomHandler(req2, res2).then(
        (hit) => { if (!hit) { res2.statusCode = 404; res2.end(); } },
        () => { rejected = true; res2.destroy(); },
      );
    });
    await new Promise<void>((r) => boomServer.listen(0, '127.0.0.1', r));
    const boomBase = `http://127.0.0.1:${(boomServer.address() as { port: number }).port}`;
    const res = await fetch(`${boomBase}/media`, { method: 'POST', headers: { authorization: 'Bearer good' }, body: 'x' });
    expect(res.status).toBe(500);
    expect(rejected).toBe(false);
    await new Promise((r) => boomServer.close(r));
    rmSync(boomDir, { recursive: true, force: true });
  });
});
