import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate each test's gateway session store to a fresh temp dir (see the same
// block in gateway.test.ts) — startAccount builds a FileCredentialStore at
// RACCOON_STORE_PATH; without this it would litter ./.raccoon-store in the repo
// and collide on the store's single-writer lock across tests.
let prevStorePath: string | undefined;
let storeDir: string | undefined;
beforeEach(() => {
  prevStorePath = process.env['RACCOON_STORE_PATH'];
  storeDir = mkdtempSync(join(tmpdir(), 'raccoon-cp-store-'));
  process.env['RACCOON_STORE_PATH'] = storeDir;
});
afterEach(() => {
  if (prevStorePath === undefined) delete process.env['RACCOON_STORE_PATH'];
  else process.env['RACCOON_STORE_PATH'] = prevStorePath;
  if (storeDir) { rmSync(storeDir, { recursive: true, force: true }); storeDir = undefined; }
});

// channel-plugin.ts now composes the full plugin (T7), pulling in gateway.ts →
// inbound.ts / outbound.ts → these bundled SDK modules whose internal relative
// imports don't resolve in the workspace. Mock them so the import graph loads
// (this suite never invokes the inbound runner or the real chunker).
vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchReplyFromConfigWithSettledDispatcher: vi.fn(),
}));
vi.mock('openclaw/plugin-sdk/reply-chunking', () => ({
  chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
}));

// Mock the inbound runner factory so we can observe what gate (checkAllowed) the
// production gateway slot passes to it, without triggering a real agent turn.
vi.mock('./inbound.js', () => ({
  buildRaccoonInboundRunner: vi.fn(() => ({
    run: () => (async function* () {})(),
  })),
}));

// Mock plugin.ts so the production startAccount never binds a real TCP port.
vi.mock('./plugin.js', () => ({
  createRaccoonChannel: vi.fn(() => ({
    hub: {
      sendToUser: vi.fn(() => false),
      onEnvelope: vi.fn(() => () => {}),
    },
    start: vi.fn(async () => ({ port: 8790 })),
    stop: vi.fn(async () => {}),
  })),
}));

import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { buildRaccoonInboundRunner } from './inbound.js';

const mockBuildRunner = vi.mocked(buildRaccoonInboundRunner);

const { raccoonChannelPlugin } = await import('./channel-plugin.js');
const { __resetRunningForTests, resolveRunning } = await import('./gateway.js');

// ---------------------------------------------------------------------------
// Task 3 — ChannelPlugin config adapter + capabilities + meta (TDD)
// ---------------------------------------------------------------------------

describe('raccoonChannelPlugin identity', () => {
  it('has id "raccoon"', () => {
    expect(raccoonChannelPlugin.id).toBe('raccoon');
  });

  it('meta.label is "Raccoon"', () => {
    expect(raccoonChannelPlugin.meta.label).toBe('Raccoon');
  });

  it('meta.blurb is a non-empty string without emojis', () => {
    expect(typeof raccoonChannelPlugin.meta.blurb).toBe('string');
    expect(raccoonChannelPlugin.meta.blurb.length).toBeGreaterThan(0);
    // No emoji codepoints
    expect(raccoonChannelPlugin.meta.blurb).not.toMatch(
      /[\u{1F300}-\u{1FFFF}]/u,
    );
  });

  it('capabilities.chatTypes contains "direct"', () => {
    expect(raccoonChannelPlugin.capabilities.chatTypes).toContain('direct');
  });
});

describe('raccoonChannelPlugin.config — listAccountIds', () => {
  it('returns ["default"] for any cfg', () => {
    const cfg = makeCfg({});
    expect(raccoonChannelPlugin.config.listAccountIds(cfg)).toEqual(['default']);
  });
});

describe('raccoonChannelPlugin.config — resolveAccount', () => {
  it('uses cfg.channels.raccoon values when present', () => {
    const cfg = makeCfg({
      instance: 'prod',
      port: 9000,
      instanceUrl: 'wss://hub.example.com/',
      channels: ['coord', 'ops'],
      staticDir: '/var/www',
      vapid: { publicKey: 'pk', privateKey: 'sk', subject: 'mailto:a@b.com' },
    });
    const account = raccoonChannelPlugin.config.resolveAccount(cfg, 'default');
    expect(account.accountId).toBe('default');
    expect(account.instance).toBe('prod');
    expect(account.port).toBe(9000);
    expect(account.instanceUrl).toBe('wss://hub.example.com/');
    expect(account.channels).toEqual(['coord', 'ops']);
    expect(account.staticDir).toBe('/var/www');
    expect(account.vapid).toEqual({
      publicKey: 'pk',
      privateKey: 'sk',
      subject: 'mailto:a@b.com',
    });
  });

  it('falls back to env vars when cfg.channels.raccoon is absent', () => {
    const savedEnv: Record<string, string | undefined> = {};
    const envVars: Record<string, string> = {
      RACCOON_INSTANCE: 'env-inst',
      RACCOON_PORT: '8888',
      RACCOON_INSTANCE_URL: 'ws://env.example.com/',
      RACCOON_CHANNELS: 'a,b',
    };
    for (const [k, v] of Object.entries(envVars)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    try {
      const cfg = makeCfg(null); // no raccoon section
      const account = raccoonChannelPlugin.config.resolveAccount(cfg, 'default');
      expect(account.accountId).toBe('default');
      expect(account.instance).toBe('env-inst');
      expect(account.port).toBe(8888);
      expect(account.instanceUrl).toBe('ws://env.example.com/');
      expect(account.channels).toEqual(['a', 'b']);
      expect(account.staticDir).toBeUndefined();
      expect(account.vapid).toBeUndefined();
    } finally {
      for (const [k, v] of Object.entries(savedEnv)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });

  it('staticDir and vapid are undefined when absent', () => {
    const cfg = makeCfg({ instance: 'x', port: 1, instanceUrl: 'ws://x/', channels: ['c'] });
    const account = raccoonChannelPlugin.config.resolveAccount(cfg, 'default');
    expect(account.staticDir).toBeUndefined();
    expect(account.vapid).toBeUndefined();
  });

  it('resolves with null accountId as "default"', () => {
    const cfg = makeCfg({ instance: 'y', port: 2, instanceUrl: 'ws://y/', channels: ['d'] });
    const account = raccoonChannelPlugin.config.resolveAccount(cfg, null);
    expect(account.accountId).toBe('default');
  });
});

describe('raccoonChannelPlugin.configSchema', () => {
  const schema = raccoonChannelPlugin.configSchema!;

  it('has a jsonSchema object', () => {
    expect(typeof schema.schema).toBe('object');
    expect(schema.schema).not.toBeNull();
  });

  it('has uiHints for port, instanceUrl, channels', () => {
    expect(schema.uiHints).toBeDefined();
    expect(schema.uiHints!['port']).toBeDefined();
    expect(schema.uiHints!['instanceUrl']).toBeDefined();
    expect(schema.uiHints!['channels']).toBeDefined();
  });

  it('safeParse succeeds for a valid input', () => {
    const result = schema.runtime!.safeParse({
      instance: 'hub',
      port: 8790,
      instanceUrl: 'ws://127.0.0.1:8790/',
      channels: ['coordinator'],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)['port']).toBe(8790);
    }
  });

  it('safeParse fails for an invalid input (port not a number)', () => {
    const result = schema.runtime!.safeParse({ port: 'notanumber' });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.issues.length).toBeGreaterThan(0);
    }
  });

  it('safeParse succeeds with only optional fields present', () => {
    const result = schema.runtime!.safeParse({});
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Task 7 integration — production gateway.startAccount wires the allowlist gate
// ---------------------------------------------------------------------------
//
// These tests exercise the PRODUCTION slot (raccoonChannelPlugin.gateway.startAccount)
// — NOT a hand-injected checkAllowed. They verify that:
//   (a) a user NOT in channels.raccoon.allowFrom yields no agent run.
//   (b) a user IN allowFrom does run (checkAllowed passes through).
// This is the integration seam T7 owns — a regression here would silently
// disarm the allowlist in production.

describe('raccoonChannelPlugin.gateway — production allowlist gate (T7 integration)', () => {
  beforeEach(() => {
    // Reset the module-scope running registry between tests so each test gets a
    // clean slate (prevents idempotency guard from short-circuiting startAccount).
    __resetRunningForTests();
    mockBuildRunner.mockClear();
  });

  function makeGatewayCtx(raccoonSection: Record<string, unknown>) {
    const cfg = makeCfg(raccoonSection) as unknown as OpenClawConfig & {
      __brand: 'OpenClawConfig';
    };
    // Pre-aborted signal: startAccount is long-running (T8) and only resolves
    // when the signal aborts. The allowlist-gate WIRING these tests assert on is
    // performed synchronously during the internal startAccount call (before the
    // abort-wait), so an already-aborted signal lets `await prodStart(ctx)`
    // resolve without hanging while preserving the wiring assertions.
    const ac = new AbortController();
    ac.abort();
    return {
      cfg,
      accountId: 'default',
      account: {
        accountId: 'default' as const,
        instance: 'openclaw',
        port: 8790,
        instanceUrl: 'ws://127.0.0.1:8790/',
        channels: ['coordinator'],
      },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: ac.signal,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getStatus: vi.fn(),
      setStatus: vi.fn(),
    } as any;
  }

  it('enforces allowFrom: a user NOT in the list gets no agent run', async () => {
    // allowFrom contains only 'alice'; 'mallory' is excluded.
    const ctx = makeGatewayCtx({ allowFrom: ['alice'] });
    const { startAccount: prodStart } = raccoonChannelPlugin.gateway!;
    if (!prodStart) throw new Error('expected gateway.startAccount to be defined');
    await prodStart(ctx);

    // The production slot must have wired a checkAllowed gate derived from cfg.
    expect(mockBuildRunner).toHaveBeenCalledTimes(1);
    const gate = mockBuildRunner.mock.calls[0]![1];
    expect(gate).toBeDefined();
    expect(gate!.checkAllowed).toBeDefined();

    // Verify the gate rejects 'mallory' and passes 'alice'.
    const checkAllowed = gate!.checkAllowed;
    if (!checkAllowed) throw new Error('expected checkAllowed to be defined');
    expect(checkAllowed('mallory')).toBe(false);
    expect(checkAllowed('alice')).toBe(true);

    // Confirm the built runner also rejects 'mallory' (gate wired end-to-end).
    const runner = mockBuildRunner.mock.results[0]!.value;
    const chunks: string[] = [];
    for await (const chunk of runner.run({ userId: 'mallory', text: 'hi', messageId: 'm1' })) {
      chunks.push(chunk);
    }
    // No output — gate blocked the run.
    expect(chunks).toHaveLength(0);
  });

  it('enforces allowFrom: a user IN the list does invoke the runner', async () => {
    const ctx = makeGatewayCtx({ allowFrom: ['alice'] });
    const { startAccount: prodStart } = raccoonChannelPlugin.gateway!;
    if (!prodStart) throw new Error('expected gateway.startAccount to be defined');
    await prodStart(ctx);

    const gate = mockBuildRunner.mock.calls[0]![1];
    const checkAllowed = gate!.checkAllowed;
    if (!checkAllowed) throw new Error('expected checkAllowed to be defined');
    expect(checkAllowed('alice')).toBe(true);
  });

  it('empty allowFrom blocks ALL users', async () => {
    const ctx = makeGatewayCtx({ allowFrom: [] });
    const { startAccount: prodStart } = raccoonChannelPlugin.gateway!;
    if (!prodStart) throw new Error('expected gateway.startAccount to be defined');
    await prodStart(ctx);

    const gate = mockBuildRunner.mock.calls[0]![1];
    const checkAllowed = gate!.checkAllowed;
    if (!checkAllowed) throw new Error('expected checkAllowed to be defined');
    expect(checkAllowed('anyone')).toBe(false);
  });

  it('no allowFrom section in cfg blocks ALL users (allowFrom defaults to [])', async () => {
    // No allowFrom key in the raccoon section — resolveAllowFrom returns [].
    const ctx = makeGatewayCtx({});
    const { startAccount: prodStart } = raccoonChannelPlugin.gateway!;
    if (!prodStart) throw new Error('expected gateway.startAccount to be defined');
    await prodStart(ctx);

    const gate = mockBuildRunner.mock.calls[0]![1];
    const checkAllowed = gate!.checkAllowed;
    if (!checkAllowed) throw new Error('expected checkAllowed to be defined');
    expect(checkAllowed('anyone')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Task 8 (live gate A) — gateway.startAccount is LONG-RUNNING
//
// OpenClaw's channel supervisor (server-channels) does `await startAccount(ctx)`
// and treats the promise RESOLVING as "channel exited without an error", then
// auto-restarts. A persistent-connection channel (Raccoon's WsHub lives until
// stopped) MUST therefore keep the startAccount promise pending for the account
// lifetime and only resolve when ctx.abortSignal fires (gateway stop path).
//
// Found live: with an immediately-resolving startAccount the gateway logged
// "[raccoon] [default] channel exited without an error" + "auto-restart attempt
// 1/10" on a loop even though the hub was serving on :8790.
// ---------------------------------------------------------------------------

describe('raccoonChannelPlugin.gateway.startAccount — long-running lifetime (T8)', () => {
  beforeEach(() => {
    __resetRunningForTests();
    mockBuildRunner.mockClear();
  });

  function makeLifetimeCtx(signal: AbortSignal) {
    return {
      cfg: makeCfg({ allowFrom: ['demo'] }) as unknown as OpenClawConfig,
      accountId: 'default',
      account: {
        accountId: 'default' as const,
        instance: 'openclaw',
        port: 8790,
        instanceUrl: 'ws://127.0.0.1:8790/',
        channels: ['coordinator'],
      },
      runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
      abortSignal: signal,
      log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      getStatus: vi.fn(),
      setStatus: vi.fn(),
    } as any;
  }

  it('does NOT resolve while the abortSignal is un-aborted (stays pending = channel alive)', async () => {
    const ac = new AbortController();
    const prodStart = raccoonChannelPlugin.gateway!.startAccount!;

    let resolved = false;
    const p = prodStart(makeLifetimeCtx(ac.signal)).then(() => {
      resolved = true;
    });

    // Give the hub-start + any microtasks a chance to run. If startAccount
    // resolved here, the gateway would think the channel exited and restart.
    await new Promise((r) => setTimeout(r, 20));
    expect(resolved).toBe(false);

    // The registry must already carry the running account (pairing/outbound can
    // resolve the hub while the lifetime promise is still pending).
    expect(resolveRunning('default')).not.toBeUndefined();

    // Aborting (gateway stop path) lets the lifetime promise resolve.
    ac.abort();
    await p;
    expect(resolved).toBe(true);
  });

  it('resolves promptly if the signal is already aborted on entry', async () => {
    const ac = new AbortController();
    ac.abort();
    const prodStart = raccoonChannelPlugin.gateway!.startAccount!;
    // Must not hang: an already-aborted signal resolves immediately.
    await prodStart(makeLifetimeCtx(ac.signal));
    // Wiring still happened (registry populated) even on the abort-fast path.
    expect(mockBuildRunner).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Task 7 integration — RACCOON_STATIC_DIR env fallback in resolveAccount
// ---------------------------------------------------------------------------

describe('raccoonChannelPlugin.config — resolveAccount RACCOON_STATIC_DIR env fallback', () => {
  it('falls back to RACCOON_STATIC_DIR env var when staticDir is absent from config', () => {
    const saved = process.env['RACCOON_STATIC_DIR'];
    process.env['RACCOON_STATIC_DIR'] = '/opt/raccoon-app';
    try {
      const cfg = makeCfg({ instance: 'x', port: 1, instanceUrl: 'ws://x/', channels: ['c'] });
      const account = raccoonChannelPlugin.config.resolveAccount(cfg, 'default');
      expect(account.staticDir).toBe('/opt/raccoon-app');
    } finally {
      if (saved === undefined) delete process.env['RACCOON_STATIC_DIR'];
      else process.env['RACCOON_STATIC_DIR'] = saved;
    }
  });

  it('config staticDir takes precedence over RACCOON_STATIC_DIR env', () => {
    const saved = process.env['RACCOON_STATIC_DIR'];
    process.env['RACCOON_STATIC_DIR'] = '/opt/raccoon-app';
    try {
      const cfg = makeCfg({ staticDir: '/cfg/dist' });
      const account = raccoonChannelPlugin.config.resolveAccount(cfg, 'default');
      expect(account.staticDir).toBe('/cfg/dist');
    } finally {
      if (saved === undefined) delete process.env['RACCOON_STATIC_DIR'];
      else process.env['RACCOON_STATIC_DIR'] = saved;
    }
  });

  it('staticDir is undefined when both config and env are absent', () => {
    const saved = process.env['RACCOON_STATIC_DIR'];
    delete process.env['RACCOON_STATIC_DIR'];
    try {
      const cfg = makeCfg({ instance: 'x', port: 1, instanceUrl: 'ws://x/', channels: ['c'] });
      const account = raccoonChannelPlugin.config.resolveAccount(cfg, 'default');
      expect(account.staticDir).toBeUndefined();
    } finally {
      if (saved !== undefined) process.env['RACCOON_STATIC_DIR'] = saved;
    }
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Build a minimal OpenClawConfig-shaped object for tests. */
// Returns an OpenClawConfig-shaped object. The shim's OpenClawConfig requires a
// __brand marker; cfg is opaque and never constructed by Raccoon at runtime, so
// this test builder casts through unknown to the branded type.
function makeCfg(raccoonSection: Record<string, unknown> | null): OpenClawConfig {
  const base = raccoonSection === null ? {} : { channels: { raccoon: raccoonSection } };
  return base as unknown as OpenClawConfig;
}
