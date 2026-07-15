// adapters/openclaw/src/gateway-client.ts
// Task 8: the CLI-process -> gateway HTTP client for operator pairing.
//
// A plugin CLI command runs in a SEPARATE process from the OpenClaw gateway
// runtime and has no handle to the live Raccoon WsHub (see gateway.ts + the T8
// note in index.ts). Pairing tokens are only valid against the hub instance
// that minted them, which lives in the gateway process. So the CLI action must
// PROXY to the gateway's `/raccoon/pair` route (registered in registerFull),
// which mints against the live hub.
//
// This module resolves the gateway base URL + token the same way the smoke
// harness wires them (env), then does a plain authenticated HTTP POST. It has
// zero OpenClaw-SDK dependencies (uses global fetch) so it typechecks cleanly
// against the real-types gate and runs in any Node 20+ CLI process.

import type { RaccoonCliDeps } from './cli.js';

/** Options for the gateway HTTP client (env-resolved by default). */
export interface GatewayClientOptions {
  /** Gateway base URL, e.g. http://127.0.0.1:18789. */
  baseUrl?: string;
  /** Gateway bearer token (auth:'gateway' routes require it). */
  token?: string;
  /** Injectable fetch (defaults to global fetch); tests pass a fake. */
  fetchImpl?: typeof fetch;
}

/**
 * Resolve the gateway base URL from the environment.
 *
 * Precedence: RACCOON_GATEWAY_URL, then OPENCLAW_GATEWAY_URL, then a port from
 * OPENCLAW_GATEWAY_PORT on localhost, else the OpenClaw default local port
 * 18789. Trailing slashes are trimmed.
 */
export function resolveGatewayBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['RACCOON_GATEWAY_URL'] ?? env['OPENCLAW_GATEWAY_URL'];
  if (explicit && explicit.trim().length > 0) return explicit.trim().replace(/\/+$/, '');
  const port = env['OPENCLAW_GATEWAY_PORT'];
  const resolvedPort = port && /^\d+$/.test(port.trim()) ? port.trim() : '18789';
  return `http://127.0.0.1:${resolvedPort}`;
}

/** Resolve the gateway bearer token from the environment. */
export function resolveGatewayToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const token = env['OPENCLAW_GATEWAY_TOKEN'] ?? env['RACCOON_GATEWAY_TOKEN'];
  return token && token.trim().length > 0 ? token.trim() : undefined;
}

/** Shape returned by the gateway `/raccoon/pair` route. */
interface PairResponse {
  token: string;
  payload: string;
  qr: string;
}

function isPairResponse(value: unknown): value is PairResponse {
  return (
    value !== null &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>)['token'] === 'string' &&
    typeof (value as Record<string, unknown>)['payload'] === 'string' &&
    typeof (value as Record<string, unknown>)['qr'] === 'string'
  );
}

async function postJson(
  url: string,
  body: unknown,
  opts: GatewayClientOptions,
): Promise<unknown> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.token ?? resolveGatewayToken();
  if (!token) {
    throw new Error(
      'raccoon pairing: no gateway token configured (set OPENCLAW_GATEWAY_TOKEN)',
    );
  }
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  headers['authorization'] = `Bearer ${token}`;
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let parsed: unknown = {};
  if (text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = { error: text };
    }
  }
  if (!res.ok) {
    const message =
      parsed !== null && typeof parsed === 'object' && typeof (parsed as Record<string, unknown>)['error'] === 'string'
        ? (parsed as Record<string, string>)['error']
        : `gateway returned HTTP ${res.status}`;
    throw new Error(`raccoon pairing via gateway failed: ${message} (HTTP ${res.status})`);
  }
  return parsed;
}

/**
 * Build RaccoonCliDeps that proxy pair/revoke to the gateway HTTP routes.
 * Used by the CLI action (which runs in the CLI process) so the token it
 * returns is minted by the LIVE hub in the gateway process.
 */
export function createGatewayCliDeps(opts: GatewayClientOptions = {}): RaccoonCliDeps {
  const baseUrl = opts.baseUrl ?? resolveGatewayBaseUrl();
  return {
    async pair(userId: string) {
      const result = await postJson(`${baseUrl}/raccoon/pair`, { userId }, opts);
      if (!isPairResponse(result)) {
        throw new Error('raccoon pairing via gateway failed: unexpected response shape');
      }
      return result;
    },
    async revoke(userId: string) {
      await postJson(`${baseUrl}/raccoon/revoke`, { userId }, opts);
    },
  };
}
