// adapters/openclaw/src/pairing-adapter.ts
// Task 5: Raccoon ChannelPairingAdapter + ChannelSecurityAdapter factories.
//
// ChannelPairingAdapter — bridges OpenClaw's ALLOWLIST pairing (who may DM)
// to Raccoon's DEVICE pairing (session credentials via QR).
//
// ChannelSecurityAdapter — enforces the allowlist gate: users not in the
// raccoon.allowFrom config list are denied DM access.
//
// Real SDK shapes sourced from:
//   pairing.types-DOYSvai_.d.ts  — ChannelPairingAdapter
//   types.adapters-DUxexnLv.d.ts — ChannelSecurityAdapter
//   types.core-BnNQH4rw.d.ts    — ChannelSecurityDmPolicy, ChannelSecurityContext

import type {
  ChannelPairingAdapter,
  ChannelSecurityAdapter,
  OpenClawConfig,
} from 'openclaw/plugin-sdk/channel-core';

// ---------------------------------------------------------------------------
// PairingIssuer — dependency interface for device-pair issuance
// ---------------------------------------------------------------------------

/**
 * Dependency contract for issuing a Raccoon device-pairing QR.
 * Implemented at the call site by the channel's `pair(userId)` method
 * (from `createRaccoonChannel(...).pair`), which calls `@raccoon/pairing`'s
 * `issuePairing(hub, { userId, instanceUrl })`.
 */
export interface PairingIssuer {
  issue(userId: string): Promise<{ token: string; payload: string; qr: string }>;
}

// ---------------------------------------------------------------------------
// createRaccoonPairingAdapter — ChannelPairingAdapter factory
// ---------------------------------------------------------------------------

/**
 * Builds the ChannelPairingAdapter for the Raccoon channel.
 *
 * - `idLabel`: 'Raccoon user id' — displayed in the OpenClaw allowlist UI.
 * - `normalizeAllowEntry`: trim + lowercase, matching how Raccoon user IDs
 *   are stored (always lowercase).
 * - `notifyApproval`: when OpenClaw approves a new allowlist entry, issue a
 *   Raccoon device-pairing QR for that user and log it to stdout. This bridges
 *   OpenClaw's allowlist approval to Raccoon's device pairing session.
 *
 * @param issuer - Dep that issues Raccoon device-pairing QRs (injected to
 *   keep the adapter testable without a live WsHub).
 */
export function createRaccoonPairingAdapter(issuer: PairingIssuer): ChannelPairingAdapter {
  return {
    idLabel: 'Raccoon user id',

    normalizeAllowEntry(entry: string): string {
      return entry.trim().toLowerCase();
    },

    async notifyApproval(params: {
      cfg: OpenClawConfig;
      id: string;
      accountId?: string;
      runtime?: unknown;
    }): Promise<void> {
      const { id } = params;
      const result = await issuer.issue(id);

      // Print the QR and payload to stdout so the operator can scan it.
      // In a full gateway context this would also be sent via the outbound
      // adapter, but the adapter is stateless — the gateway sets that up.
      console.log(`\nRaccoon device pairing QR for user "${id}":`);
      console.log(result.qr);
      console.log(`Payload: ${result.payload}`);
    },
  };
}

// ---------------------------------------------------------------------------
// RaccoonSecurityAdapter — internal type (extends real ChannelSecurityAdapter
// with helper accessors used by the inbound gate and setup wizard)
// ---------------------------------------------------------------------------

/**
 * Raccoon-specific extension of the ChannelSecurityAdapter.
 * Adds `defaultDmPolicy`, `resolveAllowFrom`, and `checkDmAllowance` as
 * first-class helpers used by the inbound gate and setup wizard.
 *
 * The standard SDK `resolveDmPolicy` member composes these into the
 * `ChannelSecurityDmPolicy` shape that OpenClaw consumes.
 */
export interface RaccoonSecurityAdapter extends ChannelSecurityAdapter {
  /** Always 'allowlist' — Raccoon requires an explicit allowlist. */
  defaultDmPolicy: 'allowlist';

  /**
   * Reads the allowFrom list from the raccoon config section.
   * Returns [] when absent.
   */
  resolveAllowFrom(cfg: OpenClawConfig): string[];

  /**
   * Returns true iff userId (normalized to lowercase) is in the allowFrom list.
   * Used directly by the inbound gate.
   */
  checkDmAllowance(cfg: OpenClawConfig, userId: string): boolean;
}

// ---------------------------------------------------------------------------
// createRaccoonSecurityAdapter — RaccoonSecurityAdapter factory
// ---------------------------------------------------------------------------

/**
 * Builds the Raccoon ChannelSecurityAdapter.
 *
 * Policy: always 'allowlist'. Users not in `channels.raccoon.allowFrom` are
 * denied DM access. The gate is enforced at the inbound runner level:
 * `raccoonChannelPlugin.gateway.startAccount` (channel-plugin.ts) derives
 * `checkAllowed` from `checkDmAllowance(cfg, userId)` and passes it to
 * `startAccount(ctx, { checkAllowed })`, which forwards it to
 * `buildRaccoonInboundRunner` as the gate. OpenClaw is also informed via
 * `resolveDmPolicy` so it can display the policy status.
 */
export function createRaccoonSecurityAdapter(): RaccoonSecurityAdapter {
  /**
   * Pull the allowFrom list out of the raccoon config section.
   * Reuses the same pattern as getRaccoonSection in channel-plugin.ts (T3).
   */
  function resolveAllowFrom(cfg: OpenClawConfig): string[] {
    const ch = (cfg as { channels?: Record<string, unknown> }).channels;
    const section = ch?.['raccoon'];
    if (section === null || typeof section !== 'object' || Array.isArray(section)) {
      return [];
    }
    const raw = (section as Record<string, unknown>)['allowFrom'];
    if (Array.isArray(raw) && raw.every((x) => typeof x === 'string')) {
      return raw as string[];
    }
    return [];
  }

  /** Read the configured DM policy (channels.raccoon.dmPolicy), defaulting to
   *  'allowlist' when unset or invalid. */
  function resolveDmPolicyValue(cfg: OpenClawConfig): 'allowlist' | 'open' | 'disabled' {
    const ch = (cfg as { channels?: Record<string, unknown> }).channels;
    const section = ch?.['raccoon'];
    if (section && typeof section === 'object' && !Array.isArray(section)) {
      const raw = (section as Record<string, unknown>)['dmPolicy'];
      if (raw === 'open' || raw === 'disabled' || raw === 'allowlist') return raw;
    }
    return 'allowlist';
  }

  return {
    defaultDmPolicy: 'allowlist',

    resolveAllowFrom,

    checkDmAllowance(cfg: OpenClawConfig, userId: string): boolean {
      // Honor the configured DM policy. 'open' admits everyone, 'disabled' admits
      // no one, 'allowlist' (the default) admits only channels.raccoon.allowFrom.
      const policy = resolveDmPolicyValue(cfg);
      if (policy === 'open') return true;
      if (policy === 'disabled') return false;
      const normalized = userId.trim().toLowerCase();
      const list = resolveAllowFrom(cfg);
      return list.some((entry) => entry.trim().toLowerCase() === normalized);
    },

    // ChannelSecurityAdapter.resolveDmPolicy — the standard SDK contract.
    // Returns a ChannelSecurityDmPolicy describing the allowlist policy to
    // OpenClaw. OpenClaw uses this to display policy status and route DMs.
    resolveDmPolicy(ctx: { cfg: OpenClawConfig; accountId?: string | null; account: unknown }) {
      const allowFrom = resolveAllowFrom(ctx.cfg);
      return {
        policy: resolveDmPolicyValue(ctx.cfg),
        allowFrom,
        allowFromPath: 'channels.raccoon.allowFrom',
        approveHint: 'openclaw raccoon pair <userId>',
        normalizeEntry: (raw: string) => raw.trim().toLowerCase(),
      };
    },
  };
}
