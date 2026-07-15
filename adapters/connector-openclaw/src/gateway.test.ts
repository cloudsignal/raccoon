// adapters/openclaw/src/gateway.test.ts
// Task 7 TDD: the gateway lifecycle + per-account transport registry.
//
// These tests exercise the SEAM between OpenClaw's ChannelGatewayAdapter
// (startAccount/stopAccount) and Raccoon's WsHub+RaccoonBridge, plus the
// module-scope `running` registry that lets the outbound adapter resolve the
// live hub for an account by accountId.
//
// Mock strategy:
//   - We mock the transport/bridge wiring via an injected `createChannel`
//     factory so the tests never bind a real TCP port. The real gateway uses
//     the default factory (createRaccoonChannel); tests inject a fake.
//   - The inbound runner factory (buildRaccoonInboundRunner) is mocked so we
//     can assert the REAL runner (not an echo placeholder) is what gets wired,
//     and that the allowlist gate is applied.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate each test's session store to a fresh temp dir (via RACCOON_STORE_PATH,
// which gateway.startAccount's FileCredentialStore honors). Without this, every
// startAccount('default') would build a store at ./.raccoon-store/default in the
// REPO — littering the tree AND colliding on the store's single-writer lock
// across tests. Each test gets its own path, so locks never collide.
let prevStorePath: string | undefined;
let storeDir: string | undefined;
beforeEach(() => {
  prevStorePath = process.env['RACCOON_STORE_PATH'];
  storeDir = mkdtempSync(join(tmpdir(), 'raccoon-gw-store-'));
  process.env['RACCOON_STORE_PATH'] = storeDir;
});
afterEach(() => {
  if (prevStorePath === undefined) delete process.env['RACCOON_STORE_PATH'];
  else process.env['RACCOON_STORE_PATH'] = prevStorePath;
  if (storeDir) { rmSync(storeDir, { recursive: true, force: true }); storeDir = undefined; }
});

// Mock the inbound runner factory so we can assert it is the wired runner.
vi.mock('./inbound.js', () => ({
  buildRaccoonInboundRunner: vi.fn(() => ({
    run: () => (async function* () { /* real-runner marker */ })(),
  })),
}));

// gateway.ts imports outbound.ts → formatting.ts → this bundled SDK module,
// whose internal relative imports don't resolve in the workspace. Mock it.
vi.mock('openclaw/plugin-sdk/reply-chunking', () => ({
  chunkMarkdownTextWithMode: vi.fn((text: string) => [text]),
}));

const { buildRaccoonInboundRunner } = await import('./inbound.js');
const mockBuildRunner = vi.mocked(buildRaccoonInboundRunner);

const {
  startAccount,
  stopAccount,
  resolveRunning,
  raccoonPairDeps,
  makeRaccoonPairHandler,
  makeRaccoonRevokeHandler,
  __resetRunningForTests,
} = await import('./gateway.js');

import { EventEmitter } from 'node:events';
import { revokePairing } from '@raccoon/pairing';
import type { RaccoonResolvedAccount } from './channel-plugin.js';
import type { RunningAccount, StartAccountDeps } from './gateway.js';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

type CreateChannel = NonNullable<StartAccountDeps['createChannel']>;

interface FakeChannel {
  hub: { __fake: 'hub'; id: string };
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  startCalls: number;
}

function makeFakeChannelFactory() {
  const created: FakeChannel[] = [];
  let seq = 0;
  const factory = vi.fn(() => {
    const id = `hub-${seq++}`;
    const ch: FakeChannel = {
      hub: { __fake: 'hub', id },
      startCalls: 0,
      start: vi.fn(async () => { ch.startCalls++; return { port: 8790 }; }),
      stop: vi.fn(async () => {}),
    };
    created.push(ch);
    // Fake hub is structurally narrower than WsHub; the gateway only touches
    // { hub, start, stop } so the cast is sound for these tests.
    return ch as unknown as ReturnType<CreateChannel>;
  });
  return { factory: factory as unknown as CreateChannel & typeof factory, created };
}

const fakeCfg = { __brand: 'OpenClawConfig' as const, channels: {} } as any;

function makeAccount(overrides?: Partial<RaccoonResolvedAccount>): RaccoonResolvedAccount {
  return {
    accountId: 'default',
    instance: 'openclaw',
    port: 8790,
    instanceUrl: 'ws://127.0.0.1:8790/',
    channels: ['coordinator'],
    ...overrides,
  };
}

function makeCtx(account: RaccoonResolvedAccount) {
  return {
    cfg: fakeCfg,
    accountId: account.accountId,
    account,
    runtime: { log: vi.fn(), error: vi.fn(), exit: vi.fn() },
    abortSignal: new AbortController().signal,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    getStatus: vi.fn(() => ({ accountId: account.accountId })),
    setStatus: vi.fn(),
  } as any;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('gateway.startAccount / stopAccount', () => {
  beforeEach(() => {
    __resetRunningForTests();
    mockBuildRunner.mockClear();
  });

  it('starts the hub+bridge and registers the running account by accountId', async () => {
    const { factory, created } = makeFakeChannelFactory();
    const account = makeAccount();

    await startAccount(makeCtx(account), { createChannel: factory });

    expect(created).toHaveLength(1);
    expect(created[0]!.start).toHaveBeenCalledTimes(1);

    const running = resolveRunning('default');
    expect(running).not.toBeUndefined();
    expect(running!.hub).toBe(created[0]!.hub);
    expect(running!.channel).toBe('coordinator');
  });

  it('a stop during an in-flight start tears down the account, leaving no orphan hub (#11)', async () => {
    // A channel whose start() blocks until released, so we can stop mid-start.
    let releaseStart!: () => void;
    const startGate = new Promise<void>((r) => { releaseStart = r; });
    const ch = {
      hub: { __fake: 'hub' as const, id: 'hub-race' },
      start: vi.fn(async () => { await startGate; return { port: 8790 }; }),
      stop: vi.fn(async () => {}),
    };
    const factory = vi.fn(() => ch as unknown as ReturnType<CreateChannel>) as unknown as CreateChannel;

    const ctx = makeCtx(makeAccount());
    const startPromise = startAccount(ctx, { createChannel: factory }); // in-flight (start blocked)
    const stopPromise = stopAccount(ctx);                               // stop while starting

    releaseStart();
    await Promise.all([startPromise, stopPromise]);

    // Before the fix, stopAccount no-op'd (running was empty) and the pending start
    // registered an orphan. Now the stop awaits the start and tears it down.
    expect(resolveRunning('default')).toBeUndefined();
    expect(ch.stop).toHaveBeenCalledTimes(1);
  });

  it('wires the REAL inbound runner (buildRaccoonInboundRunner), not an echo placeholder', async () => {
    const { factory } = makeFakeChannelFactory();
    const account = makeAccount();

    await startAccount(makeCtx(account), { createChannel: factory });

    // The real runner factory must have been called with cfg + agentId + storePath.
    expect(mockBuildRunner).toHaveBeenCalledTimes(1);
    const [opts] = mockBuildRunner.mock.calls[0]!;
    expect(opts.cfg).toBe(fakeCfg);
    expect(typeof opts.agentId).toBe('string');
    expect(opts.agentId.length).toBeGreaterThan(0);
    expect(typeof opts.storePath).toBe('string');

    // The factory received the runner produced by buildRaccoonInboundRunner.
    const factoryMock = factory as unknown as { mock: { calls: Array<[{ runner: unknown }]> } };
    const runnerArg = factoryMock.mock.calls[0]![0].runner;
    expect(runnerArg).toBe(mockBuildRunner.mock.results[0]!.value);
  });

  it('applies the allowlist gate (checkAllowed) to the inbound runner', async () => {
    const { factory } = makeFakeChannelFactory();
    const account = makeAccount();

    const checkAllowed = vi.fn(() => true);
    await startAccount(makeCtx(account), { createChannel: factory, checkAllowed });

    // The gate object must be passed as the 2nd arg of buildRaccoonInboundRunner.
    const gate = mockBuildRunner.mock.calls[0]![1];
    expect(gate).toBeDefined();
    expect(gate!.checkAllowed).toBe(checkAllowed);
  });

  it('is idempotent: a second startAccount for the same accountId does NOT double-bind', async () => {
    const { factory, created } = makeFakeChannelFactory();
    const account = makeAccount();

    await startAccount(makeCtx(account), { createChannel: factory });
    await startAccount(makeCtx(account), { createChannel: factory });

    // Only ONE channel created, started once — no second hub bound to the port.
    expect(created).toHaveLength(1);
    expect(created[0]!.start).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('is idempotent under CONCURRENT starts (no double-bind while the first is still starting)', async () => {
    const { factory, created } = makeFakeChannelFactory();
    const account = makeAccount();

    // Fire both before awaiting either — the second must join the in-flight
    // start rather than binding a second hub.
    const p1 = startAccount(makeCtx(account), { createChannel: factory });
    const p2 = startAccount(makeCtx(account), { createChannel: factory });
    const [r1, r2] = await Promise.all([p1, p2]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(created).toHaveLength(1);
    expect(created[0]!.start).toHaveBeenCalledTimes(1);
    // Both callers get the same running entry.
    expect(r1).toBe(r2);
  });

  it('stopAccount tears down the hub+bridge and removes it from the registry', async () => {
    const { factory, created } = makeFakeChannelFactory();
    const account = makeAccount();

    await startAccount(makeCtx(account), { createChannel: factory });
    expect(resolveRunning('default')).not.toBeUndefined();

    await stopAccount(makeCtx(account));

    expect(created[0]!.stop).toHaveBeenCalledTimes(1);
    expect(resolveRunning('default')).toBeUndefined();
  });

  it('stopAccount for an unknown account is a no-op (does not throw)', async () => {
    const account = makeAccount();
    await expect(stopAccount(makeCtx(account))).resolves.toBeUndefined();
  });

  it('start → stop → start re-binds a fresh hub (registry cleared on stop)', async () => {
    const { factory, created } = makeFakeChannelFactory();
    const account = makeAccount();

    await startAccount(makeCtx(account), { createChannel: factory });
    await stopAccount(makeCtx(account));
    await startAccount(makeCtx(account), { createChannel: factory });

    expect(created).toHaveLength(2);
    expect(created[1]!.start).toHaveBeenCalledTimes(1);
    expect(resolveRunning('default')!.hub).toBe(created[1]!.hub);
  });

  it('a FAILED channel.start() releases the store lock + approvalValues so a retry succeeds (#P1r3)', async () => {
    const account = makeAccount();
    let starts = 0;
    // First start throws (e.g. port bind fails); the second succeeds.
    const factory = ((): CreateChannel => (() => {
      const willFail = starts === 0;
      starts += 1;
      return {
        hub: { __fake: 'hub', id: `h${starts}` },
        start: vi.fn(async () => { if (willFail) throw new Error('bind failed'); return { port: 8790 }; }),
        stop: vi.fn(async () => {}),
      } as unknown as ReturnType<CreateChannel>;
    }) as unknown as CreateChannel)();

    await expect(startAccount(makeCtx(account), { createChannel: factory })).rejects.toThrow(/bind failed/);
    // The failed start must have released the FileCredentialStore's exclusive
    // lock — otherwise the retry's store construction dies with "already locked".
    const acct = await startAccount(makeCtx(account), { createChannel: factory });
    expect(acct).toBeTruthy();
    expect(resolveRunning('default')).toBeTruthy();
    await stopAccount(makeCtx(account));
  });

  it('uses the account.channels[0] as the Raccoon channel for the registry entry', async () => {
    const { factory } = makeFakeChannelFactory();
    const account = makeAccount({ channels: ['assistant', 'echo'] });

    await startAccount(makeCtx(account), { createChannel: factory });

    expect(resolveRunning('default')!.channel).toBe('assistant');
  });
});

// ---------------------------------------------------------------------------
// raccoonPairDeps — CLI/pairing pair/revoke resolved against the running hub
// ---------------------------------------------------------------------------

describe('raccoonPairDeps', () => {
  beforeEach(() => {
    __resetRunningForTests();
    mockBuildRunner.mockClear();
  });

  // Seed the registry by starting an account whose injected channel exposes a
  // hub with the PairingHub surface (issuePairingToken/revokeUser).
  async function seedRunningWithPairHub(
    hubExtras: { issuePairingToken: (u: string) => string; revokeUser: (u: string) => Promise<void> },
    account = makeAccount(),
  ) {
    const factory = vi.fn(() => {
      const hub = {
        ...hubExtras,
        __fake: 'hub' as const,
        id: 'pair-hub',
      };
      return {
        hub: hub as any,
        start: vi.fn(async () => ({ port: 8790 })),
        stop: vi.fn(async () => {}),
        // Mirrors createRaccoonChannel's real revoke (plugin.ts).
        revoke: (userId: string) => revokePairing(hub as any, userId),
      };
    });
    await startAccount(makeCtx(account), { createChannel: factory });
  }

  it('pair issues a device-pairing QR against the running hub for default', async () => {
    const issued: string[] = [];
    await seedRunningWithPairHub({
      issuePairingToken: (u: string) => { issued.push(u); return `tok-${u}`; },
      revokeUser: async () => {},
    });

    const deps = raccoonPairDeps(fakeCfg);
    const out = await deps.pair('alice');

    expect(issued).toEqual(['alice']);
    expect(out.token).toBe('tok-alice');
    expect(typeof out.payload).toBe('string');
    expect(typeof out.qr).toBe('string');
  });

  it('revoke revokes the user on the running hub', async () => {
    const revoked: string[] = [];
    await seedRunningWithPairHub({
      issuePairingToken: () => 't',
      revokeUser: async (u: string) => { revoked.push(u); },
    });

    const deps = raccoonPairDeps(fakeCfg);
    await deps.revoke('bob');

    expect(revoked).toEqual(['bob']);
  });

  it('pair throws a clear error when no account is running', async () => {
    const deps = raccoonPairDeps(fakeCfg);
    await expect(deps.pair('alice')).rejects.toThrow(/no running raccoon account/i);
  });

  it('revoke calls the CHANNEL\'s own revoke (not a bare hub-level revokePairing) so push cleanup is not skipped (#R4-5)', async () => {
    // A revoke that only touches the hub (revokeUser) — mirroring the OLD,
    // buggy call site (revokePairing(entry.hub, userId) directly) — would
    // never invoke this spy, since createRaccoonChannel's real revoke also
    // clears push subscriptions, a step entirely outside the hub object.
    const channelRevoke = vi.fn(async () => {});
    const factory = vi.fn(() => ({
      hub: { issuePairingToken: () => 't', revokeUser: async () => {} } as any,
      start: vi.fn(async () => ({ port: 8790 })),
      stop: vi.fn(async () => {}),
      revoke: channelRevoke,
    }));
    await startAccount(makeCtx(makeAccount()), { createChannel: factory });

    const deps = raccoonPairDeps(fakeCfg);
    await deps.revoke('bob');

    expect(channelRevoke).toHaveBeenCalledWith('bob');
  });
});

// ---------------------------------------------------------------------------
// Gateway HTTP pairing handlers (T8) — mint against the LIVE hub in the
// gateway process. These are what registerFull registers under
// POST /raccoon/pair and POST /raccoon/revoke.
// ---------------------------------------------------------------------------

// Minimal fake IncomingMessage: an EventEmitter that also carries `method`.
// The handler reads the body via 'data'/'end' events.
function fakeReq(method: string, body?: string): any {
  const req = new EventEmitter() as any;
  req.method = method;
  // Emit the body on next tick so the handler can attach listeners first.
  queueMicrotask(() => {
    if (body !== undefined && body !== '') req.emit('data', Buffer.from(body, 'utf8'));
    req.emit('end');
  });
  req.destroy = () => {};
  return req;
}

// Minimal fake ServerResponse capturing status + body.
function fakeRes(): { res: any; get: () => { status: number; body: unknown } } {
  const state = { status: 0, headers: {} as Record<string, string>, raw: '' };
  const res: any = {
    get statusCode() { return state.status; },
    set statusCode(v: number) { state.status = v; },
    setHeader(k: string, v: string) { state.headers[k.toLowerCase()] = v; },
    end(chunk?: string) { if (chunk) state.raw += chunk; },
  };
  return {
    res,
    get: () => ({ status: state.status, body: state.raw ? JSON.parse(state.raw) : undefined }),
  };
}

function fakePairHub() {
  const issued: string[] = [];
  const revoked: string[] = [];
  const hub = {
    issuePairingToken: (u: string) => { issued.push(u); return `tok-${u}`; },
    revokeUser: async (u: string) => { revoked.push(u); },
  } as unknown as RunningAccount['hub'];
  return { hub, issued, revoked };
}

function runningEntry(hub: RunningAccount['hub']): RunningAccount {
  return {
    hub, channel: 'coordinator', instanceUrl: 'ws://127.0.0.1:8790/', stop: async () => {},
    // Mirrors createRaccoonChannel's real revoke (plugin.ts): revokePairing
    // against the hub. These fakes have no push store, so there's nothing
    // else to clear — the point of these tests is the hub-level revocation.
    revoke: (userId: string) => revokePairing(hub as unknown as Parameters<typeof revokePairing>[0], userId),
  };
}

describe('makeRaccoonPairHandler (POST /raccoon/pair)', () => {
  it('mints a pairing token/payload/qr against the resolved live hub', async () => {
    const { hub, issued } = fakePairHub();
    const handler = makeRaccoonPairHandler(() => runningEntry(hub));
    const { res, get } = fakeRes();

    const handled = await handler(fakeReq('POST', JSON.stringify({ userId: 'demo' })), res);

    expect(handled).toBe(true);
    const { status, body } = get();
    expect(status).toBe(200);
    expect(issued).toEqual(['demo']);
    expect((body as any).token).toBe('tok-demo');
    expect(typeof (body as any).payload).toBe('string');
    expect(typeof (body as any).qr).toBe('string');
    // The payload encodes the live token — proving the token came from the hub.
    expect(JSON.parse((body as any).payload).token).toBe('tok-demo');
  });

  it('returns 405 for non-POST', async () => {
    const { hub } = fakePairHub();
    const handler = makeRaccoonPairHandler(() => runningEntry(hub));
    const { res, get } = fakeRes();
    await handler(fakeReq('GET'), res);
    expect(get().status).toBe(405);
  });

  it('returns 400 when userId is missing', async () => {
    const { hub } = fakePairHub();
    const handler = makeRaccoonPairHandler(() => runningEntry(hub));
    const { res, get } = fakeRes();
    await handler(fakeReq('POST', JSON.stringify({})), res);
    expect(get().status).toBe(400);
  });

  it('returns 400 on invalid JSON body', async () => {
    const { hub } = fakePairHub();
    const handler = makeRaccoonPairHandler(() => runningEntry(hub));
    const { res, get } = fakeRes();
    await handler(fakeReq('POST', '{not json'), res);
    expect(get().status).toBe(400);
  });

  it('returns 503 when no account is running (gateway has not started the hub)', async () => {
    const handler = makeRaccoonPairHandler(() => undefined);
    const { res, get } = fakeRes();
    await handler(fakeReq('POST', JSON.stringify({ userId: 'demo' })), res);
    expect(get().status).toBe(503);
  });

  it('returns a sanitized 500 (no stack/detail leak) when issuance throws', async () => {
    const throwingHub = {
      issuePairingToken: () => { throw new Error('boom-secret-internal-detail'); },
      revokeUser: async () => {},
    } as unknown as RunningAccount['hub'];
    const handler = makeRaccoonPairHandler(() => runningEntry(throwingHub));
    const { res, get } = fakeRes();
    const handled = await handler(fakeReq('POST', JSON.stringify({ userId: 'demo' })), res);
    expect(handled).toBe(true);
    const { status, body } = get();
    expect(status).toBe(500);
    expect((body as any).error).toEqual({ message: 'pairing failed', type: 'internal' });
    // the raw error message must NOT leak to the client
    expect(JSON.stringify(body)).not.toMatch(/boom-secret-internal-detail/);
  });
});

describe('makeRaccoonRevokeHandler (POST /raccoon/revoke)', () => {
  it('revokes the user on the resolved live hub', async () => {
    const { hub, revoked } = fakePairHub();
    const handler = makeRaccoonRevokeHandler(() => runningEntry(hub));
    const { res, get } = fakeRes();

    const handled = await handler(fakeReq('POST', JSON.stringify({ userId: 'bob' })), res);

    expect(handled).toBe(true);
    expect(get().status).toBe(200);
    expect((get().body as any).ok).toBe(true);
    expect(revoked).toEqual(['bob']);
  });

  it('returns 503 when no account is running', async () => {
    const handler = makeRaccoonRevokeHandler(() => undefined);
    const { res, get } = fakeRes();
    await handler(fakeReq('POST', JSON.stringify({ userId: 'bob' })), res);
    expect(get().status).toBe(503);
  });

  it('returns a sanitized 500 (no stack/detail leak) when revoke throws', async () => {
    const throwingHub = {
      issuePairingToken: () => 't',
      revokeUser: async () => { throw new Error('revoke-boom-internal'); },
    } as unknown as RunningAccount['hub'];
    const handler = makeRaccoonRevokeHandler(() => runningEntry(throwingHub));
    const { res, get } = fakeRes();
    await handler(fakeReq('POST', JSON.stringify({ userId: 'bob' })), res);
    const { status, body } = get();
    expect(status).toBe(500);
    expect((body as any).error).toEqual({ message: 'pairing failed', type: 'internal' });
    expect(JSON.stringify(body)).not.toMatch(/revoke-boom-internal/);
  });

  it('calls the CHANNEL\'s own revoke (not a bare hub-level revokePairing) so push cleanup is not skipped (#R4-5)', async () => {
    const channelRevoke = vi.fn(async () => {});
    const entry: RunningAccount = {
      hub: { issuePairingToken: () => 't', revokeUser: async () => {} } as any,
      channel: 'coordinator',
      instanceUrl: 'ws://127.0.0.1:8790/',
      stop: async () => {},
      revoke: channelRevoke,
    };
    const handler = makeRaccoonRevokeHandler(() => entry);
    const { res } = fakeRes();
    await handler(fakeReq('POST', JSON.stringify({ userId: 'bob' })), res);
    expect(channelRevoke).toHaveBeenCalledWith('bob');
  });
});
