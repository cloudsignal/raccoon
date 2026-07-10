// adapters/openclaw/src/gateway-client.test.ts
// Task 8: the CLI-process -> gateway HTTP client that proxies operator pairing
// to the gateway `/raccoon/pair` route (so the token is minted by the live hub
// in the gateway process, not the CLI process).

import { describe, it, expect, vi } from 'vitest';
import {
  createGatewayCliDeps,
  resolveGatewayBaseUrl,
  resolveGatewayToken,
} from './gateway-client.js';

describe('resolveGatewayBaseUrl', () => {
  it('prefers RACCOON_GATEWAY_URL, trimming trailing slashes', () => {
    expect(resolveGatewayBaseUrl({ RACCOON_GATEWAY_URL: 'http://gw:9/' } as any)).toBe('http://gw:9');
  });
  it('falls back to OPENCLAW_GATEWAY_URL', () => {
    expect(resolveGatewayBaseUrl({ OPENCLAW_GATEWAY_URL: 'http://gw:1234' } as any)).toBe('http://gw:1234');
  });
  it('builds a localhost URL from OPENCLAW_GATEWAY_PORT', () => {
    expect(resolveGatewayBaseUrl({ OPENCLAW_GATEWAY_PORT: '18790' } as any)).toBe('http://127.0.0.1:18790');
  });
  it('defaults to the OpenClaw local port 18789', () => {
    expect(resolveGatewayBaseUrl({} as any)).toBe('http://127.0.0.1:18789');
  });
});

describe('resolveGatewayToken', () => {
  it('reads OPENCLAW_GATEWAY_TOKEN', () => {
    expect(resolveGatewayToken({ OPENCLAW_GATEWAY_TOKEN: 'secret' } as any)).toBe('secret');
  });
  it('returns undefined when unset', () => {
    expect(resolveGatewayToken({} as any)).toBeUndefined();
  });
});

describe('createGatewayCliDeps — no token configured', () => {
  // The guard lives in postJson: it checks opts.token ?? resolveGatewayToken()
  // before calling fetch. To test hermetically without relying on the ambient
  // process.env we pass token: resolveGatewayToken({} as any) — which is always
  // undefined for an empty env object — giving us a stable "no token" value that
  // does NOT read from the real process.env.
  function depsWithNoToken(fetchImpl: typeof fetch) {
    return createGatewayCliDeps({
      baseUrl: 'http://gw:18789',
      // Explicitly resolve from an empty env: always undefined.
      token: resolveGatewayToken({} as any),
      fetchImpl,
    });
  }

  it('pair rejects with a clear error and does NOT call fetch when no token is configured', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const deps = depsWithNoToken(fetchImpl);
    await expect(deps.pair('demo')).rejects.toThrow(
      /raccoon pairing: no gateway token configured/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('revoke rejects with a clear error and does NOT call fetch when no token is configured', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const deps = depsWithNoToken(fetchImpl);
    await expect(deps.revoke('bob')).rejects.toThrow(
      /raccoon pairing: no gateway token configured/,
    );
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('createGatewayCliDeps.pair', () => {
  it('POSTs userId to /raccoon/pair with the bearer token and returns the token/payload/qr', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ token: 't1', payload: 'p1', qr: 'q1' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const deps = createGatewayCliDeps({ baseUrl: 'http://gw:18789', token: 'tok', fetchImpl });
    const out = await deps.pair('demo');

    expect(out).toEqual({ token: 't1', payload: 'p1', qr: 'q1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('http://gw:18789/raccoon/pair');
    expect(calls[0]!.init.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ userId: 'demo' });
    expect((calls[0]!.init.headers as Record<string, string>)['authorization']).toBe('Bearer tok');
  });

  it('throws a clear error when the gateway returns a non-2xx status', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ error: 'no running raccoon account' }), { status: 503 }),
    ) as unknown as typeof fetch;

    const deps = createGatewayCliDeps({ baseUrl: 'http://gw:18789', token: 'tok', fetchImpl });
    await expect(deps.pair('demo')).rejects.toThrow(/no running raccoon account.*HTTP 503/i);
  });

  it('throws when the gateway returns an unexpected response shape', async () => {
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ notAToken: true }), { status: 200 }),
    ) as unknown as typeof fetch;

    const deps = createGatewayCliDeps({ baseUrl: 'http://gw:18789', token: 'tok', fetchImpl });
    await expect(deps.pair('demo')).rejects.toThrow(/unexpected response shape/i);
  });
});

describe('createGatewayCliDeps.revoke', () => {
  it('POSTs userId to /raccoon/revoke', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as unknown as typeof fetch;

    const deps = createGatewayCliDeps({ baseUrl: 'http://gw:18789', token: 'tok', fetchImpl });
    await deps.revoke('bob');

    expect(calls[0]!.url).toBe('http://gw:18789/raccoon/revoke');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ userId: 'bob' });
  });
});
