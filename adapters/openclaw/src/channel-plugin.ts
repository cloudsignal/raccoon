/**
 * Raccoon ChannelPlugin — Task 3 (channel-native plan, T3 of 10)
 *
 * Implements the MINIMUM REQUIRED ChannelPlugin surface:
 *   id, meta, capabilities, config, configSchema
 *
 * Adapters that require the gateway lifecycle (outbound, pairing, security,
 * setupWizard, gateway) are added by later tasks (T4-T7).
 *
 * Real SDK shapes mirrored 1:1 from:
 *   types.plugin-ByOu7kLN.d.ts  — ChannelPlugin
 *   types.core-BnNQH4rw.d.ts   — ChannelMeta, ChannelCapabilities
 *   types.adapters-DUxexnLv.d.ts — ChannelConfigAdapter
 *   types.config-D1pSqbn8.d.ts  — ChannelConfigSchema
 */

import type {
  ChannelPlugin,
  ChannelMeta,
  ChannelCapabilities,
  ChannelConfigAdapter,
} from 'openclaw/plugin-sdk/channel-runtime';
import type { ChannelConfigSchema } from 'openclaw/plugin-sdk';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';
import { createRegistryOutbound, raccoonPairDeps, resolveRunning, startAccount, stopAccount } from './gateway.js';
import { createRaccoonPairingAdapter, createRaccoonSecurityAdapter, type PairingIssuer } from './pairing-adapter.js';
import { raccoonSetupWizard } from './setup-wizard.js';

// ---------------------------------------------------------------------------
// Resolved account shape for a single-account Raccoon deployment
// ---------------------------------------------------------------------------

export interface RaccoonResolvedAccount {
  accountId: 'default';
  instance: string;
  port: number;
  instanceUrl: string;
  channels: string[];
  staticDir?: string;
  vapid?: { publicKey: string; privateKey: string; subject: string };
}

// ---------------------------------------------------------------------------
// meta
// Mirrors ChannelMeta required members: id, label, selectionLabel, docsPath, blurb.
// ---------------------------------------------------------------------------

const meta: ChannelMeta = {
  id: 'raccoon',
  label: 'Raccoon',
  selectionLabel: 'Raccoon (self-hosted)',
  docsPath: 'channels/raccoon',
  blurb:
    'Self-hosted Raccoon messenger: installable PWA with offline web-push, ' +
    'device-pair QR auth, and OAM-native message routing.',
};

// ---------------------------------------------------------------------------
// capabilities
// chatTypes: ["direct"] — Raccoon is a 1:1 DM messenger today.
// ---------------------------------------------------------------------------

const capabilities: ChannelCapabilities = {
  chatTypes: ['direct'],
};

// ---------------------------------------------------------------------------
// config — single-account resolution
//
// Env-var fallback names are aligned with the existing adapter/gateway:
//   RACCOON_INSTANCE       (adapter index.ts line 33)
//   RACCOON_INSTANCE_URL   (adapter index.ts line 34)
//   RACCOON_PORT           (adapter index.ts line 36)
//   RACCOON_CHANNELS       (adapter index.ts line 37)
// ---------------------------------------------------------------------------

function getRaccoonSection(cfg: OpenClawConfig): Record<string, unknown> {
  // cfg.channels is Record<string, unknown>; cfg.channels.raccoon is open-world.
  const ch = (cfg as { channels?: Record<string, unknown> }).channels;
  const section = ch?.['raccoon'];
  if (section !== null && typeof section === 'object') {
    return section as Record<string, unknown>;
  }
  return {};
}

function strOrUndef(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function numOrUndef(v: unknown): number | undefined {
  const n = Number(v);
  return !isNaN(n) && v !== null && v !== '' ? n : undefined;
}

function strArrayOrUndef(v: unknown): string[] | undefined {
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
    return v as string[];
  }
  return undefined;
}

const config: ChannelConfigAdapter<RaccoonResolvedAccount> = {
  listAccountIds(_cfg: OpenClawConfig): string[] {
    return ['default'];
  },

  resolveAccount(
    cfg: OpenClawConfig,
    _accountId?: string | null,
  ): RaccoonResolvedAccount {
    const s = getRaccoonSection(cfg);

    // Prefer config section values; fall back to env vars.
    const instance =
      strOrUndef(s['instance']) ??
      strOrUndef(process.env['RACCOON_INSTANCE']) ??
      'openclaw';

    const port =
      numOrUndef(s['port']) ??
      numOrUndef(process.env['RACCOON_PORT']) ??
      8790;

    const instanceUrl =
      strOrUndef(s['instanceUrl']) ??
      strOrUndef(process.env['RACCOON_INSTANCE_URL']) ??
      'ws://127.0.0.1:8790/';

    // channels: cfg value (string[]) or comma-split env var
    const channels: string[] =
      strArrayOrUndef(s['channels']) ??
      (strOrUndef(process.env['RACCOON_CHANNELS'])?.split(',') ?? ['coordinator']);

    // Optional — prefer config section; fall back to env var (consistent with
    // the other RACCOON_* env fallbacks above, and documented in README Docker
    // harness: -e RACCOON_STATIC_DIR=...).
    const staticDir =
      strOrUndef(s['staticDir']) ??
      strOrUndef(process.env['RACCOON_STATIC_DIR']);
    const vapidRaw = s['vapid'];
    let vapid: RaccoonResolvedAccount['vapid'];
    if (
      vapidRaw !== null &&
      typeof vapidRaw === 'object' &&
      !Array.isArray(vapidRaw)
    ) {
      const v = vapidRaw as Record<string, unknown>;
      const pk = strOrUndef(v['publicKey']);
      const sk = strOrUndef(v['privateKey']);
      const sub = strOrUndef(v['subject']);
      if (pk && sk && sub) {
        vapid = { publicKey: pk, privateKey: sk, subject: sub };
      }
    }

    return {
      accountId: 'default',
      instance,
      port,
      instanceUrl,
      channels,
      ...(staticDir !== undefined ? { staticDir } : {}),
      ...(vapid !== undefined ? { vapid } : {}),
    };
  },

  defaultAccountId(_cfg: OpenClawConfig): string {
    return 'default';
  },
};

// ---------------------------------------------------------------------------
// configSchema
//
// Mirrors ChannelConfigSchema:
//   schema: Record<string, unknown> (JSON Schema object)
//   uiHints: Record<string, ChannelConfigUiHint>
//   runtime: ChannelConfigRuntimeSchema (safeParse)
//
// The JSON Schema is a plain object (no typebox dependency).
// safeParse is a hand-rolled validator that matches the
// ChannelConfigRuntimeSchema contract without pulling in zod or typebox.
// ---------------------------------------------------------------------------

interface RaccoonRawConfig {
  instance?: unknown;
  port?: unknown;
  instanceUrl?: unknown;
  channels?: unknown;
  staticDir?: unknown;
  vapid?: unknown;
}

type ParseResult =
  | { success: true; data: RaccoonRawConfig }
  | {
      success: false;
      issues: Array<{ path: string[]; message: string; code: string }>;
    };

function parseRaccoonConfig(input: unknown): ParseResult {
  const issues: Array<{ path: string[]; message: string; code: string }> = [];

  if (typeof input !== 'object' || input === null || Array.isArray(input)) {
    return {
      success: false,
      issues: [{ path: [], message: 'Expected an object', code: 'invalid_type' }],
    };
  }

  const raw = input as Record<string, unknown>;

  if (raw['instance'] !== undefined && typeof raw['instance'] !== 'string') {
    issues.push({ path: ['instance'], message: 'Expected string', code: 'invalid_type' });
  }

  if (raw['port'] !== undefined) {
    const p = Number(raw['port']);
    if (typeof raw['port'] !== 'number' || isNaN(p)) {
      issues.push({ path: ['port'], message: 'Expected number', code: 'invalid_type' });
    }
  }

  if (raw['instanceUrl'] !== undefined && typeof raw['instanceUrl'] !== 'string') {
    issues.push({ path: ['instanceUrl'], message: 'Expected string', code: 'invalid_type' });
  }

  if (raw['channels'] !== undefined) {
    if (
      !Array.isArray(raw['channels']) ||
      !(raw['channels'] as unknown[]).every((x) => typeof x === 'string')
    ) {
      issues.push({ path: ['channels'], message: 'Expected string[]', code: 'invalid_type' });
    }
  }

  if (raw['staticDir'] !== undefined && typeof raw['staticDir'] !== 'string') {
    issues.push({ path: ['staticDir'], message: 'Expected string', code: 'invalid_type' });
  }

  if (issues.length > 0) {
    return { success: false, issues };
  }

  return {
    success: true,
    data: {
      instance: raw['instance'] as string | undefined,
      port: raw['port'] as number | undefined,
      instanceUrl: raw['instanceUrl'] as string | undefined,
      channels: raw['channels'] as string[] | undefined,
      staticDir: raw['staticDir'] as string | undefined,
      vapid: raw['vapid'],
    },
  };
}

const configSchema: ChannelConfigSchema = {
  schema: {
    type: 'object',
    properties: {
      instance: {
        type: 'string',
        description: 'Raccoon instance name (used in pairing QR and MQTT topics).',
      },
      port: {
        type: 'number',
        description: 'WebSocket hub port (default: 8790).',
      },
      instanceUrl: {
        type: 'string',
        description:
          'Public WebSocket URL the PWA dials (e.g. wss://hub.example.com/).',
      },
      channels: {
        type: 'array',
        items: { type: 'string' },
        description: 'OAM channel names the hub joins (e.g. ["coordinator"]).',
      },
      staticDir: {
        type: 'string',
        description: 'Path to the built @raccoon/app dist/ directory to serve.',
      },
    },
    additionalProperties: true,
  },
  uiHints: {
    port: {
      label: 'Hub port',
      help: 'TCP port for the Raccoon WebSocket hub. Default: 8790.',
      placeholder: '8790',
    },
    instanceUrl: {
      label: 'Public instance URL',
      help: 'WebSocket URL encoded into device pairing QR codes.',
      placeholder: 'wss://hub.example.com/',
    },
    channels: {
      label: 'OAM channels',
      help: 'Comma-separated OAM channel names the hub subscribes to.',
      placeholder: 'coordinator',
    },
  },
  runtime: {
    safeParse: parseRaccoonConfig,
  },
};

// ---------------------------------------------------------------------------
// pairing issuer — resolves the running hub from the registry (T7 seam).
//
// notifyApproval fires when OpenClaw approves a new allowlist entry; it issues
// a Raccoon device-pairing QR against the account's live hub. Delegates to the
// shared raccoonPairDeps (gateway.ts) so the resolve-and-issue logic lives in
// exactly one place; raccoonPairDeps throws a clear error when no account is
// running (surfaced by the pairing adapter). cfg is unused by raccoonPairDeps
// (it resolves the single 'default' account from the registry).
// ---------------------------------------------------------------------------

const registryPairingIssuer: PairingIssuer = {
  issue(userId: string) {
    return raccoonPairDeps(undefined as never).pair(userId);
  },
};

// ---------------------------------------------------------------------------
// waitForAbort — resolve when an AbortSignal fires (the gateway stop path).
//
// OpenClaw's channel supervisor does `await plugin.gateway.startAccount(ctx)`
// and treats the promise RESOLVING as "channel exited without an error",
// then auto-restarts the account (found live: a restart loop while the hub was
// happily serving on :8790). A persistent-connection channel must therefore
// keep the startAccount promise pending for the account lifetime and resolve
// only when ctx.abortSignal fires — at which point the gateway also calls
// gateway.stopAccount, which performs the actual hub teardown.
// ---------------------------------------------------------------------------

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    signal.addEventListener('abort', () => resolve(), { once: true });
  });
}

// ---------------------------------------------------------------------------
// raccoonChannelPlugin — the COMPLETE ChannelPlugin (T3 base + T4-T7 slots)
//
//   config / configSchema / meta / capabilities   (T3)
//   outbound  — registry-backed, resolves the running hub by accountId (T4/T7)
//   pairing   — allowlist pairing → Raccoon device-pair QR              (T5)
//   security  — allowlist DM policy                                     (T5)
//   setupWizard — declarative `openclaw setup` surface                  (T6)
//   gateway   — startAccount/stopAccount transport lifecycle            (T7)
// ---------------------------------------------------------------------------

export const raccoonChannelPlugin: ChannelPlugin<RaccoonResolvedAccount> = {
  id: 'raccoon',
  meta,
  capabilities,
  config,
  configSchema,
  outbound: createRegistryOutbound(resolveRunning),
  pairing: createRaccoonPairingAdapter(registryPairingIssuer),
  security: createRaccoonSecurityAdapter(),
  setupWizard: raccoonSetupWizard,
  gateway: {
    startAccount: async (ctx) => {
      // Build the T5 allowlist gate from the live config and pass it into
      // startAccount so the inbound runner enforces channels.raccoon.allowFrom.
      // Without this dep, deps.checkAllowed is undefined and the allowlist is
      // silently dead in production (only tests that hand-inject checkAllowed
      // would have had a gate). Pairing already restricts who can connect via
      // QR; this restores the config-driven allowFrom control on top of that.
      const secAdapter = createRaccoonSecurityAdapter();
      const checkAllowed = (userId: string): boolean =>
        secAdapter.checkDmAllowance(ctx.cfg, userId);

      // Stand up the hub + populate the module-scope registry (idempotent).
      // resolve/outbound/pairing can find the live hub as soon as this awaits.
      await startAccount(ctx, { checkAllowed });

      // Then STAY PENDING for the account lifetime. OpenClaw's channel
      // supervisor awaits this promise and treats resolution as "channel
      // exited" → auto-restart. Resolve only when the gateway aborts the
      // account (its stop path), which also triggers gateway.stopAccount to
      // tear the hub down. Without this the gateway restart-loops a live hub.
      await waitForAbort(ctx.abortSignal);
    },
    stopAccount: (ctx) => stopAccount(ctx),
  },
};
