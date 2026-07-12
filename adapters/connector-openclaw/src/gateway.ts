// adapters/openclaw/src/gateway.ts
// Task 7: the ChannelGatewayAdapter lifecycle + the outbound↔hub seam.
//
// ---------------------------------------------------------------------------
// THE OUTBOUND↔HUB SEAM (design decision)
// ---------------------------------------------------------------------------
// OpenClaw's ChannelOutboundAdapter.sendText/sendPayload receive a context
// carrying { cfg, to, text, accountId? } — NOT a live transport handle. The
// real ChannelGatewayContext (types.adapters-DUxexnLv.d.ts, lines 237-306)
// also offers NO blessed handoff from the gateway to the outbound adapter:
// it provides cfg/account/runtime/abortSignal/getStatus/setStatus/log and an
// optional channelRuntime surface, but nothing that hands the channel's own
// transport object to outbound calls. OpenClaw's own gateway-mode channels
// keep their transport in a module/process-scoped registry and look it up by
// accountId in the outbound path.
//
// We therefore maintain a MODULE-SCOPE per-account registry:
//   running: Map<accountId, RunningAccount>
// - startAccount() stands up the WsHub+RaccoonBridge and stores the entry.
// - stopAccount() tears it down and removes the entry.
// - the plugin's outbound adapter (createRegistryOutbound) resolves the live
//   hub for ctx.accountId (default 'default') from this registry per call and
//   delegates to the T4 createRaccoonOutbound wiring with that hub + channel.
//
// This keeps T4 unchanged (it still takes a concrete { hub, channel }); the
// registry is the mechanism that bridges "one plugin object built at module
// load" to "a hub that only exists once an account is started".

import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AgentRunner } from '@raccoon/bridge';
import { FileCredentialStore, type CredentialStore } from '@raccoon/transport-ws';
import { issuePairing, type PairingHub } from '@raccoon/pairing';
import type {
  ChannelGatewayContext,
  ChannelOutboundAdapter,
} from 'openclaw/plugin-sdk/channel-runtime';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { createRaccoonChannel, type RaccoonAgentChannel } from './plugin.js';
import { buildRaccoonInboundRunner } from './inbound.js';
import { createRaccoonOutbound } from './outbound.js';
import { createApprovalValueStore, type ApprovalValueStore } from './approval-values.js';
import type { RaccoonCliDeps } from './cli.js';
import type { RaccoonResolvedAccount } from './channel-plugin.js';

// ---------------------------------------------------------------------------
// Registry types
// ---------------------------------------------------------------------------

/** A live, started Raccoon transport for one account. */
export interface RunningAccount {
  /** The hub that delivers OAM envelopes to connected users. */
  hub: RaccoonAgentChannel['hub'];
  /** The OAM channel name (from account.channels[0]) used for outbound. */
  channel: string;
  /** Public ws URL encoded into device-pairing QR codes (from the account). */
  instanceUrl: string;
  /** Tears down the hub + bridge. */
  stop: () => Promise<void>;
  /**
   * The channel's own revoke (createRaccoonChannel's — plugin.ts), which
   * also clears the user's push subscriptions through the serialized
   * per-user chain (#R4-5). Both raccoonPairDeps.revoke() and
   * makeRaccoonRevokeHandler call THIS, not revokePairing(entry.hub, ...)
   * directly — a direct call bypasses that cleanup entirely, since the
   * SubscriptionStore/serialization queue live only inside the channel's
   * own closure, unreachable from the registry entry any other way.
   */
  revoke: RaccoonAgentChannel['revoke'];
}

/** Injectable factory + gate for startAccount (tests inject fakes). */
export interface StartAccountDeps {
  /**
   * Channel factory. Defaults to createRaccoonChannel. Injected in tests so
   * they never bind a real TCP port.
   */
  createChannel?: (opts: {
    instance: string;
    instanceUrl: string;
    host?: string;
    port?: number;
    channels: string[];
    runner: AgentRunner;
    buildId?: string;
    staticDir?: string;
    vapid?: { publicKey: string; privateKey: string; subject: string };
    sessionStore?: CredentialStore;
  }) => Pick<RaccoonAgentChannel, 'hub' | 'start' | 'stop' | 'revoke'>;
  /**
   * Optional allowlist gate applied to the inbound runner. When it returns
   * false for a userId, the agent is not invoked and no reply is produced.
   */
  checkAllowed?: (userId: string) => boolean;
}

// ---------------------------------------------------------------------------
// Module-scope registry
// ---------------------------------------------------------------------------

const running = new Map<string, RunningAccount>();

// In-flight starts, keyed by accountId. Registered synchronously at the top of
// startAccount BEFORE the first await, so a concurrent second call for the same
// account joins the same promise instead of binding a second hub.
const starting = new Map<string, Promise<RunningAccount>>();

// Per-account approval label→value correlation store (see approval-values.ts).
// Shared between the inbound runner and outbound adapter for the SAME running
// account, so a button's real value recorded on the way out can be resolved
// when the human's choice (a label) comes back on the way in.
const approvalValues = new Map<string, ApprovalValueStore>();

/** Resolve the running transport for an account (default 'default'). */
export function resolveRunning(accountId?: string): RunningAccount | undefined {
  return running.get(accountId ?? 'default');
}

/** TEST-ONLY: clear the registry between tests. */
export function __resetRunningForTests(): void {
  running.clear();
  starting.clear();
  approvalValues.clear();
}

// ---------------------------------------------------------------------------
// agentId / storePath resolution
//
// The real ChannelGatewayContext provides neither an agentId nor a storePath.
// Raccoon derives them:
//   - agentId: RACCOON_AGENT_ID env override, else the first OAM channel name
//     (the channel maps to the agent role, e.g. 'coordinator').
//   - storePath: RACCOON_STORE_PATH env override, else a per-account default
//     under the OS-independent './.raccoon-store/<accountId>' path. The T1
//     inbound runner currently treats storePath as reserved (not yet consumed
//     by dispatchReplyFromConfigWithSettledDispatcher), so any stable string
//     is acceptable; we still derive a real one for forward-compat.
// ---------------------------------------------------------------------------

function resolveAgentId(account: RaccoonResolvedAccount): string {
  const override = process.env['RACCOON_AGENT_ID'];
  if (override && override.length > 0) return override;
  const first = account.channels[0];
  return first && first.length > 0 ? first : 'coordinator';
}

function resolveStorePath(accountId: string): string {
  const override = process.env['RACCOON_STORE_PATH'];
  if (override && override.length > 0) return override;
  return `./.raccoon-store/${accountId}`;
}

// ---------------------------------------------------------------------------
// startAccount / stopAccount — the ChannelGatewayAdapter lifecycle
// ---------------------------------------------------------------------------

/**
 * Start (or no-op if already running) the Raccoon transport for an account.
 *
 * Idempotent: a second call for the same accountId does NOT create a second
 * hub or re-bind the port — it returns the existing entry. This satisfies the
 * "register fires >once in full" / re-entrancy safety at the gateway seam.
 */
export function startAccount(
  ctx: ChannelGatewayContext<RaccoonResolvedAccount>,
  deps: StartAccountDeps = {},
): Promise<RunningAccount> {
  const accountId = ctx.accountId ?? 'default';

  // Idempotent guards (evaluated synchronously — before any await):
  //   1. already running  → return the live entry.
  //   2. currently starting → join the in-flight start (no second bind).
  const existing = running.get(accountId);
  if (existing) return Promise.resolve(existing);
  const inflight = starting.get(accountId);
  if (inflight) return inflight;

  const promise = doStart(ctx, deps, accountId).finally(() => {
    starting.delete(accountId);
  });
  starting.set(accountId, promise);
  return promise;
}

async function doStart(
  ctx: ChannelGatewayContext<RaccoonResolvedAccount>,
  deps: StartAccountDeps,
  accountId: string,
): Promise<RunningAccount> {
  const account = ctx.account;
  const channelName = account.channels[0] ?? 'coordinator';

  // Fresh per-start correlation store, shared with the outbound adapter via
  // the approvalValues registry below (R2-5).
  const approvalStore = createApprovalValueStore();
  approvalValues.set(accountId, approvalStore);

  // Build the REAL inbound runner (T1) + apply the T5 allowlist gate.
  const runner: AgentRunner = buildRaccoonInboundRunner(
    {
      cfg: ctx.cfg,
      storePath: resolveStorePath(accountId),
      agentId: resolveAgentId(account),
      accountId,
      approvalValues: approvalStore,
    },
    deps.checkAllowed ? { checkAllowed: deps.checkAllowed } : undefined,
  );

  // RACCOON_HOST lets the container bind 0.0.0.0 (see adapter README Docker
  // harness). It is a deployment concern, not per-account config, so it is
  // read from the env rather than the resolved account.
  const host = process.env['RACCOON_HOST'];

  // #F4: back sessions with a FILE store keyed to the account's storePath, so a
  // real connector-process restart RESUMES confirmed sessions instead of forcing
  // every paired device to re-pair (the in-memory default loses them on bounce).
  const sessionStore = new FileCredentialStore({ path: join(resolveStorePath(accountId), 'sessions.json') });

  const factory = deps.createChannel ?? createRaccoonChannel;
  const channel = factory({
    instance: account.instance,
    instanceUrl: account.instanceUrl,
    ...(host !== undefined && host.length > 0 ? { host } : {}),
    ...(account.staticDir !== undefined ? { staticDir: account.staticDir } : {}),
    port: account.port,
    channels: account.channels,
    runner,
    sessionStore,
    ...(account.vapid !== undefined ? { vapid: account.vapid } : {}),
  });

  await channel.start();

  const entry: RunningAccount = {
    hub: channel.hub,
    channel: channelName,
    instanceUrl: account.instanceUrl,
    stop: () => channel.stop(),
    revoke: (userId: string) => channel.revoke(userId),
  };
  running.set(accountId, entry);
  ctx.log?.info(`raccoon: account "${accountId}" started (channel ${channelName})`);
  return entry;
}

/**
 * Stop the Raccoon transport for an account and remove it from the registry.
 * No-op (does not throw) if the account is not running.
 */
export async function stopAccount(
  ctx: ChannelGatewayContext<RaccoonResolvedAccount>,
): Promise<void> {
  const accountId = ctx.accountId ?? 'default';
  // If a start is in flight, wait for it to finish before tearing down. Otherwise
  // this stop returns as a no-op (nothing in `running` yet) and the pending start
  // then registers an orphan hub that never gets stopped.
  const inflight = starting.get(accountId);
  if (inflight) {
    try { await inflight; } catch { /* the start failed; there is nothing to stop */ }
  }
  const entry = running.get(accountId);
  if (!entry) return;
  // Remove first so a concurrent outbound call cannot resolve a stopping hub.
  running.delete(accountId);
  approvalValues.delete(accountId);
  await entry.stop();
  ctx.log?.info(`raccoon: account "${accountId}" stopped`);
}

// ---------------------------------------------------------------------------
// createRegistryOutbound — the outbound adapter used by raccoonChannelPlugin
//
// Resolves the live hub for ctx.accountId from the registry per call, then
// delegates to the T4 createRaccoonOutbound wiring. Building the T4 adapter
// per call is cheap (it only closes over { hub, channel }); it keeps all the
// chunking / interactive→approval mapping logic in one place (outbound.ts).
// ---------------------------------------------------------------------------

export function createRegistryOutbound(
  resolve: (accountId?: string) => RunningAccount | undefined,
): ChannelOutboundAdapter {
  function forAccount(accountId?: string): ChannelOutboundAdapter {
    const entry = resolve(accountId);
    if (!entry) {
      throw new Error(
        `raccoon outbound: no running raccoon account for "${accountId ?? 'default'}" ` +
          '(gateway.startAccount has not run or the account was stopped)',
      );
    }
    return createRaccoonOutbound({
      hub: entry.hub,
      channel: entry.channel,
      approvalValues: approvalValues.get(accountId ?? 'default'),
    });
  }

  // presentationCapabilities, renderPresentation, and chunker are all
  // stateless (none touch the hub — renderPresentation is a pure transform,
  // see outbound.ts's R4-1 correction; chunker only chunks text): built once
  // from a placeholder hub that real calls never reach.
  const stateless = createRaccoonOutbound({
    hub: { sendToUser: () => false, onEnvelope: () => () => {} },
    channel: 'raccoon',
  });

  return {
    deliveryMode: 'gateway',
    async sendText(ctx) {
      return forAccount(ctx.accountId ?? undefined).sendText!(ctx);
    },
    async sendPayload(ctx) {
      return forAccount(ctx.accountId ?? undefined).sendPayload!(ctx);
    },
    chunker: stateless.chunker,
    // R4-1: this wrapper previously dropped these two fields entirely, so
    // OpenClaw never saw Raccoon declare presentation support and always
    // degraded exec approvals to plain text in production — the T4 adapter's
    // renderPresentation/presentationCapabilities (createRaccoonOutbound)
    // were correct but unreachable, since raccoonChannelPlugin.outbound is
    // THIS registry wrapper, not the inner per-account adapter the tests
    // exercised.
    presentationCapabilities: stateless.presentationCapabilities,
    renderPresentation: stateless.renderPresentation,
  };
}

// ---------------------------------------------------------------------------
// raccoonPairDeps — CLI pair/revoke deps bound to the running hub
//
// Retained for raccoonChannelPlugin's pairing adapter (channel-plugin.ts →
// registryPairingIssuer), which runs IN THE GATEWAY PROCESS and can safely
// resolve the live hub from the module-scope registry. The T8 CLI path uses
// createGatewayCliDeps (gateway-client.ts) instead, which proxies to the
// gateway HTTP route from the separate CLI process.
//
// Pairing issuance requires a live WsHub (issuePairingToken) + the account's
// instanceUrl. We resolve both from the module-scope registry populated by
// startAccount. When no account is running we throw a clear, actionable error
// rather than silently no-op'ing.
//
// The cfg parameter is accepted for signature symmetry / future multi-account
// routing; today the single 'default' account is resolved from the registry.
// ---------------------------------------------------------------------------

export function raccoonPairDeps(_cfg: OpenClawConfig, accountId = 'default'): RaccoonCliDeps {
  function requireRunning(): RunningAccount {
    const entry = running.get(accountId);
    if (!entry) {
      throw new Error(
        `raccoon pair: no running raccoon account for "${accountId}" ` +
          '(start the gateway so the hub is bound before pairing/revoking)',
      );
    }
    return entry;
  }
  return {
    async pair(userId: string) {
      const entry = requireRunning();
      return issuePairing(entry.hub as unknown as PairingHub, {
        userId,
        instanceUrl: entry.instanceUrl,
      });
    },
    async revoke(userId: string) {
      const entry = requireRunning();
      // R4-5: entry.revoke (the channel's own), not revokePairing(entry.hub,
      // ...) directly — the latter skips push-subscription cleanup entirely.
      await entry.revoke(userId);
    },
  };
}

// ---------------------------------------------------------------------------
// GATEWAY-MEDIATED PAIRING (the T8 live-gate fix)
// ---------------------------------------------------------------------------
// A Raccoon pairing token is only valid against the ONE live WsHub instance
// that minted it: `WsHub.issuePairingToken` stores the token in a per-instance
// in-memory map, and `WsHub.handleHello` validates the incoming `pair.request`
// against that same map (transport-ws/src/hub.ts). The hub instance lives only
// in the GATEWAY process (started by gateway.startAccount, tracked in the
// module-scope `running` registry above).
//
// OpenClaw runs the CLI in a SEPARATE process from the gateway runtime, and a
// plugin CLI command's action executes IN THAT CLI PROCESS — its
// OpenClawPluginCliContext is `{ program, config, workspaceDir, logger }` with
// no gateway/hub handle (verified against openclaw@2026.6.11
// types-CR1WAXpo.d.ts + the running gateway). So a token "issued" by the CLI
// would land in a throwaway registry the live hub never sees.
//
// The fix mints pairing tokens where the live hub actually is: a gateway HTTP
// route (auth: 'gateway'), registered in the entry's registerFull (which runs
// only in the gateway process). `/raccoon/version` already proves gateway HTTP
// routes work. The operator hits `POST /raccoon/pair` with the gateway token;
// the handler resolves the live account from `running` and mints via the T5
// issuance logic against the real hub.
// ---------------------------------------------------------------------------

/** Max request body size for pair/revoke routes (defensive; bodies are tiny JSON objects). */
const RACCOON_REQUEST_BODY_LIMIT = 4096;

/** Read a small JSON request body, rejecting oversized payloads. */
async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > RACCOON_REQUEST_BODY_LIMIT) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json body'));
      }
    });
    req.on('error', (err) => reject(err));
  });
}

/** Extract and validate a non-empty `userId` string from a parsed body. */
function resolveUserId(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>)['userId'];
  if (typeof raw !== 'string') return null;
  const userId = raw.trim();
  return userId.length > 0 ? userId : null;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): true {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
  return true;
}

/**
 * Handle `POST /raccoon/pair` — mint a Raccoon device-pairing token/QR against
 * the LIVE hub for the running account. Runs in the gateway process (where the
 * `running` registry is populated). Body: `{ "userId": "<id>" }`. Returns
 * `{ token, payload, qr }` (the same shape as the T5 `pair` issuer).
 *
 * `resolve` defaults to the module-scope registry; tests inject a fake.
 */
export function makeRaccoonPairHandler(
  resolve: (accountId?: string) => RunningAccount | undefined = resolveRunning,
) {
  return async function handleRaccoonPair(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      return sendJson(res, 405, { error: 'method not allowed (use POST)' });
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
    const userId = resolveUserId(body);
    if (!userId) {
      return sendJson(res, 400, { error: 'missing or empty "userId" in request body' });
    }
    const entry = resolve('default');
    if (!entry) {
      return sendJson(res, 503, {
        error: 'no running raccoon account (gateway has not started the hub)',
      });
    }
    let result: unknown;
    try {
      result = await issuePairing(entry.hub as unknown as PairingHub, {
        userId,
        instanceUrl: entry.instanceUrl,
      });
    } catch (err) {
      console.error('[raccoon] issuePairing failed:', err);
      return sendJson(res, 500, { error: { message: 'pairing failed', type: 'internal' } });
    }
    return sendJson(res, 200, result);
  };
}

/**
 * Handle `POST /raccoon/revoke` — revoke a user's Raccoon session against the
 * live hub. Body: `{ "userId": "<id>" }`. Returns `{ ok: true }`.
 *
 * Idempotent: returns 200 / {ok:true} even for a user who was never paired.
 */
export function makeRaccoonRevokeHandler(
  resolve: (accountId?: string) => RunningAccount | undefined = resolveRunning,
) {
  return async function handleRaccoonRevoke(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<boolean> {
    if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
      return sendJson(res, 405, { error: 'method not allowed (use POST)' });
    }
    let body: unknown;
    try {
      body = await readJsonBody(req);
    } catch (err) {
      return sendJson(res, 400, { error: (err as Error).message });
    }
    const userId = resolveUserId(body);
    if (!userId) {
      return sendJson(res, 400, { error: 'missing or empty "userId" in request body' });
    }
    const entry = resolve('default');
    if (!entry) {
      return sendJson(res, 503, {
        error: 'no running raccoon account (gateway has not started the hub)',
      });
    }
    try {
      // R4-5: entry.revoke (the channel's own), not revokePairing(entry.hub,
      // ...) directly — the latter skips push-subscription cleanup entirely.
      await entry.revoke(userId);
    } catch (err) {
      console.error('[raccoon] revokePairing failed:', err);
      return sendJson(res, 500, { error: { message: 'pairing failed', type: 'internal' } });
    }
    return sendJson(res, 200, { ok: true });
  };
}
