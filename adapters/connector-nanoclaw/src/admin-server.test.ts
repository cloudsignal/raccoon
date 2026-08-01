import { describe, expect, it, vi } from 'vitest';
import { startAdminServer } from './admin-server.js';

const PAIRING = { token: 't1', payload: 'p1', qr: 'q1' };

async function withServer(
  deps: Parameters<typeof startAdminServer>[0]['deps'],
  fn: (base: string) => Promise<void>,
) {
  const server = await startAdminServer({ port: 0, secret: 's3cret', deps });
  try { await fn(`http://127.0.0.1:${server.port}`); } finally { await server.close(); }
}

const okDeps = () => ({ pair: vi.fn(async () => PAIRING), revoke: vi.fn(async () => {}) });

describe('admin server', () => {
  it('pairs with valid auth', async () => {
    const deps = okDeps();
    await withServer(() => deps, async (base) => {
      const res = await fetch(`${base}/pair`, {
        method: 'POST',
        headers: { authorization: 'Bearer s3cret', 'content-type': 'application/json' },
        body: JSON.stringify({ userId: 'u1' }),
      });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual(PAIRING);
      expect(deps.pair).toHaveBeenCalledWith('u1');
    });
  });

  it('rejects bad or missing auth with 401', async () => {
    await withServer(okDeps, async (base) => {
      const headerSets: Record<string, string>[] = [{}, { authorization: 'Bearer wrong' }, { authorization: 'Basic s3cret' }];
      for (const headers of headerSets) {
        const res = await fetch(`${base}/pair`, { method: 'POST', headers, body: JSON.stringify({ userId: 'u1' }) });
        expect(res.status).toBe(401);
      }
    });
  });

  it('405 on GET, 400 on bad body, 404 on unknown path', async () => {
    await withServer(okDeps, async (base) => {
      expect((await fetch(`${base}/pair`, { headers: { authorization: 'Bearer s3cret' } })).status).toBe(405);
      expect((await fetch(`${base}/pair`, { method: 'POST', headers: { authorization: 'Bearer s3cret' }, body: '{}' })).status).toBe(400);
      expect((await fetch(`${base}/nope`, { method: 'POST', headers: { authorization: 'Bearer s3cret' } })).status).toBe(404);
    });
  });

  it('503 when endpoint not started; revoke returns ok:true', async () => {
    await withServer(() => null, async (base) => {
      const res = await fetch(`${base}/pair`, { method: 'POST', headers: { authorization: 'Bearer s3cret' }, body: JSON.stringify({ userId: 'u1' }) });
      expect(res.status).toBe(503);
    });
    const deps = okDeps();
    await withServer(() => deps, async (base) => {
      const res = await fetch(`${base}/revoke`, { method: 'POST', headers: { authorization: 'Bearer s3cret' }, body: JSON.stringify({ userId: 'u1' }) });
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ ok: true });
    });
  });
});
