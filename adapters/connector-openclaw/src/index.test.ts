// adapters/openclaw/src/index.test.ts
// Task 7 TDD: the channel-native entry (defineChannelPluginEntry).
//
// Asserts:
//   - default export is a DefinedChannelPluginEntry (has register + channelPlugin).
//   - the channelPlugin advertises ALL adapter slots (outbound, pairing,
//     security, setupWizard, gateway) on top of id/meta/capabilities/config.
//   - registerFull does ONLY: mode gate, idempotent guard, version HTTP route,
//     CLI registration — it does NOT start the hub (that moved into gateway).

import { describe, it, expect, vi, beforeEach } from 'vitest';

// index.js → channel-plugin.js → gateway.js → inbound.js / outbound.js pull in
// these bundled SDK modules whose internal relative imports don't resolve in
// the workspace. Mock them so the import graph loads.
vi.mock('openclaw/plugin-sdk/channel-inbound', () => ({
  dispatchReplyFromConfigWithSettledDispatcher: vi.fn(),
}));
vi.mock('openclaw/plugin-sdk/reply-chunking', () => ({
  chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
}));

// defineChannelPluginEntry is real openclaw (not in the workspace). Mock it
// with a faithful shape: register() delegates to registerFull(), and the
// returned entry exposes channelPlugin + register + id/name/description. This
// mirrors DefinedChannelPluginEntry (core-Ch6CsyM-.d.ts, verified 2026-07-07).
vi.mock('openclaw/plugin-sdk/channel-core', () => ({
  defineChannelPluginEntry: (opts: {
    id: string;
    name: string;
    description: string;
    plugin: unknown;
    configSchema?: unknown;
    registerFull?: (api: unknown) => void;
    registerCliMetadata?: (api: unknown) => void;
  }) => ({
    id: opts.id,
    name: opts.name,
    description: opts.description,
    configSchema: opts.configSchema,
    channelPlugin: opts.plugin,
    // Expose both hooks so tests invoke them individually. The real entry
    // dispatches registerCliMetadata (cli-metadata/discovery/full) and
    // registerFull (full only) by mode; register() here delegates to
    // registerFull for the mode-gate/hub tests below.
    registerFull: opts.registerFull,
    registerCliMetadata: opts.registerCliMetadata,
    register: (api: unknown) => { opts.registerFull?.(api); },
  }),
}));

// Guard against any accidental hub bind from the entry: if startAccount were
// (wrongly) called from registerFull, this mock would record it. The entry
// must NOT touch the gateway during register.
vi.mock('./gateway.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./gateway.js')>();
  return { ...actual, startAccount: vi.fn(actual.startAccount) };
});

const gateway = await import('./gateway.js');
const entryModule = await import('./index.js');
// The runtime mock of defineChannelPluginEntry exposes registerFull +
// registerCliMetadata (the entry's registration hooks); the real
// DefinedChannelPluginEntry type only declares `register`, so widen the static
// type here to match what the mock provides and what these tests invoke.
const entry = entryModule.default as typeof entryModule.default & {
  registerFull(api: unknown): void;
  registerCliMetadata(api: unknown): void;
};

function makeApi(mode: string) {
  const routes: Array<{ path: string; auth: string }> = [];
  const cliRegistrations: unknown[] = [];
  return {
    routes,
    cliRegistrations,
    id: 'raccoon',
    registrationMode: mode as any,
    config: { channels: {} } as any,
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    registerHttpRoute(params: { path: string; auth: string; handler: unknown }) {
      routes.push({ path: params.path, auth: params.auth });
    },
    registerCli(registrar: unknown) {
      cliRegistrations.push(registrar);
    },
  };
}

describe('channel-native entry (defineChannelPluginEntry)', () => {
  beforeEach(() => {
    vi.mocked(gateway.startAccount).mockClear();
  });

  it('default export is a DefinedChannelPluginEntry (register + channelPlugin)', () => {
    expect(typeof entry.register).toBe('function');
    expect(entry.channelPlugin).toBeDefined();
    expect(entry.id).toBe('raccoon');
    expect(entry.name).toBe('Raccoon');
  });

  it('channelPlugin advertises all adapter slots', () => {
    const p = entry.channelPlugin as Record<string, unknown>;
    // T3 base
    expect(p.id).toBe('raccoon');
    expect(p.meta).toBeDefined();
    expect(p.capabilities).toBeDefined();
    expect(p.config).toBeDefined();
    expect(p.configSchema).toBeDefined();
    // T4-T7 slots
    expect(p.outbound).toBeDefined();
    expect(p.pairing).toBeDefined();
    expect(p.security).toBeDefined();
    expect(p.setupWizard).toBeDefined();
    expect(p.gateway).toBeDefined();
  });

  it('gateway slot exposes startAccount + stopAccount', () => {
    const gw = (entry.channelPlugin as any).gateway;
    expect(typeof gw.startAccount).toBe('function');
    expect(typeof gw.stopAccount).toBe('function');
  });

  it('registerFull in non-full mode does nothing (no route, no CLI, no hub)', () => {
    const api = makeApi('discovery');
    entry.register(api as any);
    expect(api.routes).toHaveLength(0);
    expect(api.cliRegistrations).toHaveLength(0);
    expect(gateway.startAccount).not.toHaveBeenCalled();
  });

  it('registerFull in full mode registers the version + gateway pairing routes (CLI moved to registerCliMetadata)', () => {
    const api = makeApi('full');
    entry.registerFull(api as any);
    const paths = api.routes.map((r) => r.path);
    // T7 liveness probe (unauthenticated) + T8 gateway-mediated pairing routes.
    expect(paths).toContain('/raccoon/version');
    expect(paths).toContain('/raccoon/pair');
    expect(paths).toContain('/raccoon/revoke');
    // The pairing routes require gateway auth; the version probe does not.
    const byPath = Object.fromEntries(api.routes.map((r) => [r.path, r.auth]));
    expect(byPath['/raccoon/version']).toBe('plugin');
    expect(byPath['/raccoon/pair']).toBe('gateway');
    expect(byPath['/raccoon/revoke']).toBe('gateway');
    // registerFull no longer registers the CLI. The real entry invokes BOTH
    // registerCliMetadata and registerFull in full mode, so registering the CLI
    // here too would trip OpenClaw's duplicate-command guard. It moved to
    // registerCliMetadata.
    expect(api.cliRegistrations).toHaveLength(0);
  });

  it('registerCliMetadata registers the raccoon CLI exactly once (idempotent per api)', () => {
    const api = makeApi('full');
    entry.registerCliMetadata(api as any);
    entry.registerCliMetadata(api as any);
    expect(api.cliRegistrations).toHaveLength(1);
  });

  it('registerFull NEVER starts the hub (that moved to gateway.startAccount)', () => {
    const api = makeApi('full');
    entry.register(api as any);
    expect(gateway.startAccount).not.toHaveBeenCalled();
  });

  it('registerFull fired more than once in full mode is idempotent (route registered once)', () => {
    // OpenClaw fires the registration hooks > once even in 'full' (boot + agent
    // pre-warm share this module instance).
    const api = makeApi('full');
    entry.registerFull(api as any);
    entry.registerFull(api as any);
    const versionRoutes = api.routes.filter((r) => r.path === '/raccoon/version');
    expect(versionRoutes).toHaveLength(1);
  });
});
