/**
 * Raccoon ChannelSetupWizard — Task 6 (channel-native plan, T6 of 10)
 *
 * Builds the declarative setup wizard consumed by the OpenClaw generic setup
 * adapter. When T7 wires it into raccoonChannelPlugin.setupWizard, operators
 * can run `openclaw setup` to configure the Raccoon channel interactively.
 *
 * Design constraints:
 *   - No API keys (Raccoon is self-hosted) → credentials = [].
 *   - Status: "configured" when both instanceUrl and port are present.
 *   - textInputs: instance name, port (numeric), instanceUrl (ws(s)://), channels CSV.
 *   - allowFrom: raccoon user ids (consistent with T5 channels.raccoon.allowFrom).
 *   - dmPolicy: 'allowlist' default (consistent with T5).
 *   - completionNote: guides operator to run `openclaw raccoon pair <userId>`.
 *
 * Real SDK shapes sourced from:
 *   setup-wizard-types-Dh8rs7xx.d.ts  — ChannelSetupWizard, member types
 *   setup-wizard-binary-COmrO5xX.d.ts — createStandardChannelSetupStatus,
 *                                         createAllowFromSection,
 *                                         createTopLevelChannelDmPolicy
 *   types.base-DmKdGokm.d.ts          — DmPolicy
 *   types.core-BnNQH4rw.d.ts          — ChannelSetupInput
 */

import type {
  ChannelSetupWizard,
  ChannelSetupWizardTextInput,
  ChannelSetupWizardAllowFromEntry,
  ChannelSetupDmPolicy,
  DmPolicy,
} from 'openclaw/plugin-sdk/setup';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';

// `ChannelSetupWizardStatus` and `ChannelSetupWizardAllowFrom` are NOT
// re-exported by name from any public `openclaw/plugin-sdk/*` subpath in
// openclaw@2026.6.11 (they live only in an internal chunk). Derive them
// structurally from the exported `ChannelSetupWizard` so these annotations stay
// bound to the real SDK shapes.
type ChannelSetupWizardStatus = ChannelSetupWizard['status'];
type ChannelSetupWizardAllowFrom = NonNullable<ChannelSetupWizard['allowFrom']>;

// ---------------------------------------------------------------------------
// Internal helpers — read the raccoon config section
// (same pattern as channel-plugin.ts T3 and pairing-adapter.ts T5)
// ---------------------------------------------------------------------------

function getRaccoonSection(cfg: OpenClawConfig): Record<string, unknown> {
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
  return !isNaN(n) && v !== null && v !== '' && n !== 0 ? n : undefined;
}

// ---------------------------------------------------------------------------
// status — "configured" = instanceUrl + port both present
// ---------------------------------------------------------------------------

const raccoonStatus: ChannelSetupWizardStatus = {
  configuredLabel: 'Raccoon configured',
  unconfiguredLabel: 'Raccoon not configured',
  configuredHint: 'Raccoon hub is running and ready.',
  unconfiguredHint: 'Provide the hub URL and port to enable Raccoon.',

  resolveConfigured({ cfg }: { cfg: OpenClawConfig; accountId?: string }): boolean {
    const s = getRaccoonSection(cfg);
    const hasUrl = strOrUndef(s['instanceUrl']) !== undefined;
    const hasPort = numOrUndef(s['port']) !== undefined;
    return hasUrl && hasPort;
  },
};

// ---------------------------------------------------------------------------
// textInputs
//
// inputKey values are from keyof ChannelSetupInput (types.core-BnNQH4rw.d.ts):
//   name        → instance name (string)
//   httpPort    → port (string in the SDK bag; validated as numeric)
//   url         → public instanceUrl (validated ws(s)://)
//   groupChannels → channels CSV (string[] in SDK; collected as CSV, applied as array)
// ---------------------------------------------------------------------------

/** Validates that a value is a positive integer port number. */
function validatePort(value: string): string | undefined {
  if (!value || !value.trim()) {
    return 'Port is required.';
  }
  const n = Number(value.trim());
  if (!Number.isInteger(n) || n <= 0) {
    return 'Port must be a positive integer (e.g. 8790).';
  }
  return undefined;
}

/** Validates that a value is a ws:// or wss:// URL. */
function validateInstanceUrl(value: string): string | undefined {
  if (!value || !value.trim()) {
    return 'Instance URL is required.';
  }
  const trimmed = value.trim();
  if (!trimmed.startsWith('ws://') && !trimmed.startsWith('wss://')) {
    return 'Instance URL must start with ws:// or wss:// (e.g. wss://hub.example.com/).';
  }
  return undefined;
}

/** Applies the raccoon config patch for an account-scoped field. */
function patchRaccoonSection(
  cfg: OpenClawConfig,
  patch: Record<string, unknown>,
): OpenClawConfig {
  const existing = getRaccoonSection(cfg);
  return {
    ...cfg,
    channels: {
      ...((cfg as { channels?: Record<string, unknown> }).channels ?? {}),
      raccoon: {
        ...existing,
        ...patch,
      },
    },
  } as OpenClawConfig;
}

const instanceNameInput: ChannelSetupWizardTextInput = {
  inputKey: 'name',
  message: 'Raccoon instance name (used in MQTT topics and pairing QR)',
  placeholder: 'openclaw',
  required: false,

  currentValue({ cfg }: { cfg: OpenClawConfig; accountId: string; credentialValues: Record<string, string | undefined> }): string | undefined {
    return strOrUndef(getRaccoonSection(cfg)['instance']);
  },

  applySet({ cfg, value }: { cfg: OpenClawConfig; accountId: string; value: string }): OpenClawConfig {
    return patchRaccoonSection(cfg, { instance: value });
  },
};

const portInput: ChannelSetupWizardTextInput = {
  inputKey: 'httpPort',
  message: 'Hub WebSocket port',
  placeholder: '8790',
  required: true,

  currentValue({ cfg }: { cfg: OpenClawConfig; accountId: string; credentialValues: Record<string, string | undefined> }): string | undefined {
    const s = getRaccoonSection(cfg);
    const p = s['port'];
    return p !== undefined && p !== null ? String(p) : undefined;
  },

  validate({ value }: { value: string; cfg: OpenClawConfig; accountId: string; credentialValues: Record<string, string | undefined> }): string | undefined {
    return validatePort(value);
  },

  applySet({ cfg, value }: { cfg: OpenClawConfig; accountId: string; value: string }): OpenClawConfig {
    return patchRaccoonSection(cfg, { port: Number(value.trim()) });
  },
};

const instanceUrlInput: ChannelSetupWizardTextInput = {
  inputKey: 'url',
  message: 'Public WebSocket URL (encoded into device-pairing QR codes)',
  placeholder: 'wss://hub.example.com/',
  required: true,

  currentValue({ cfg }: { cfg: OpenClawConfig; accountId: string; credentialValues: Record<string, string | undefined> }): string | undefined {
    return strOrUndef(getRaccoonSection(cfg)['instanceUrl']);
  },

  validate({ value }: { value: string; cfg: OpenClawConfig; accountId: string; credentialValues: Record<string, string | undefined> }): string | undefined {
    return validateInstanceUrl(value);
  },

  applySet({ cfg, value }: { cfg: OpenClawConfig; accountId: string; value: string }): OpenClawConfig {
    return patchRaccoonSection(cfg, { instanceUrl: value.trim() });
  },
};

const channelsInput: ChannelSetupWizardTextInput = {
  inputKey: 'groupChannels',
  message: 'OAM channel names the hub subscribes to (comma-separated)',
  placeholder: 'coordinator',
  required: false,

  currentValue({ cfg }: { cfg: OpenClawConfig; accountId: string; credentialValues: Record<string, string | undefined> }): string | undefined {
    const s = getRaccoonSection(cfg);
    const raw = s['channels'];
    if (Array.isArray(raw) && raw.every((x) => typeof x === 'string') && (raw as string[]).length > 0) {
      return (raw as string[]).join(', ');
    }
    return undefined;
  },

  normalizeValue({ value }: { value: string; cfg: OpenClawConfig; accountId: string; credentialValues: Record<string, string | undefined> }): string {
    // Normalize CSV: trim each entry, remove empties, rejoin.
    return value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
      .join(', ');
  },

  applySet({ cfg, value }: { cfg: OpenClawConfig; accountId: string; value: string }): OpenClawConfig {
    const channels = value
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    return patchRaccoonSection(cfg, { channels: channels.length > 0 ? channels : ['coordinator'] });
  },
};

// ---------------------------------------------------------------------------
// allowFrom — raccoon user ids
// (consistent with T5: channels.raccoon.allowFrom)
// ---------------------------------------------------------------------------

const raccoonAllowFrom: ChannelSetupWizardAllowFrom = {
  message: 'Raccoon user ids allowed to DM this agent (comma-separated)',
  placeholder: 'alice, bob',
  invalidWithoutCredentialNote: 'No credential required — Raccoon is self-hosted.',

  /** Accept plain CSV entries (trimmed, lowercased). */
  parseInputs(raw: string): string[] {
    return raw
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0);
  },

  /** A valid Raccoon user id is any non-empty trimmed string. */
  parseId(raw: string): string | null {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  },

  /**
   * Resolve entries without any external API lookup — Raccoon user ids are
   * opaque strings managed by the operator; all entries resolve immediately.
   */
  async resolveEntries({
    entries,
  }: {
    cfg: OpenClawConfig;
    accountId: string;
    credentialValues: Record<string, string | undefined>;
    entries: string[];
  }): Promise<ChannelSetupWizardAllowFromEntry[]> {
    return entries.map((id) => ({
      input: id,
      resolved: true,
      id,
    }));
  },

  /** Write the allowFrom list to channels.raccoon.allowFrom. */
  apply({ cfg, allowFrom }: { cfg: OpenClawConfig; accountId: string; allowFrom: string[] }): OpenClawConfig {
    return patchRaccoonSection(cfg, { allowFrom });
  },
};

// ---------------------------------------------------------------------------
// dmPolicy — 'allowlist' default
// (consistent with T5: createRaccoonSecurityAdapter defaultDmPolicy)
// ---------------------------------------------------------------------------

const raccoonDmPolicy: ChannelSetupDmPolicy = {
  label: 'Raccoon DM policy',
  channel: 'raccoon',
  policyKey: 'channels.raccoon.dmPolicy',
  allowFromKey: 'channels.raccoon.allowFrom',

  getCurrent(cfg: OpenClawConfig): DmPolicy {
    const s = getRaccoonSection(cfg);
    const policy = s['dmPolicy'];
    if (
      policy === 'allowlist' ||
      policy === 'open' ||
      policy === 'disabled' ||
      policy === 'pairing'
    ) {
      return policy;
    }
    // Default: allowlist (matches T5 defaultDmPolicy)
    return 'allowlist';
  },

  setPolicy(cfg: OpenClawConfig, policy: DmPolicy): OpenClawConfig {
    return patchRaccoonSection(cfg, { dmPolicy: policy });
  },
};

// ---------------------------------------------------------------------------
// completionNote — guidance to run the T5 pair CLI
// ---------------------------------------------------------------------------

const raccoonCompletionNote = {
  title: 'Next step: pair a user',
  lines: [
    'To allow a user to connect, pair their Raccoon account:',
    '',
    '  openclaw raccoon pair <userId>',
    '',
    'The user will receive a device-pairing QR code. Once scanned, their',
    'Raccoon PWA will connect to this OpenClaw instance.',
    'Repeat for each user you want to add to the allowFrom list.',
  ],
};

// ---------------------------------------------------------------------------
// raccoonSetupWizard — exported ChannelSetupWizard object
// ---------------------------------------------------------------------------

export const raccoonSetupWizard: ChannelSetupWizard = {
  channel: 'raccoon',
  status: raccoonStatus,

  // No API keys — Raccoon is self-hosted.
  credentials: [],

  textInputs: [instanceNameInput, portInput, instanceUrlInput, channelsInput],

  allowFrom: raccoonAllowFrom,

  dmPolicy: raccoonDmPolicy,

  completionNote: raccoonCompletionNote,
};
