// adapters/openclaw/src/setup-wizard.test.ts
// Task 6 TDD: ChannelSetupWizard for the Raccoon channel.
//
// Specification:
//   - status: "configured" when instanceUrl + port are both present; otherwise "not configured".
//   - credentials: empty (Raccoon is self-hosted, no API keys).
//   - textInputs: instance name, port (numeric), instanceUrl (ws(s)://), channels (CSV).
//   - allowFrom: via createAllowFromSection for raccoon user ids.
//   - dmPolicy: 'allowlist' default.
//   - completionNote: contains `openclaw raccoon pair <userId>` guidance.
//   - finalize (optional): validate inputs before writing config.

import { describe, it, expect } from 'vitest';

import { raccoonSetupWizard } from './setup-wizard.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeCfg(overrides?: Record<string, unknown>): any {
  return {
    channels: {
      raccoon: {
        ...overrides,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// status — resolveConfigured
// ---------------------------------------------------------------------------

describe('raccoonSetupWizard.status.resolveConfigured', () => {
  it('returns false when both instanceUrl and port are absent', () => {
    const cfg = makeCfg();
    const result = raccoonSetupWizard.status.resolveConfigured({ cfg });
    expect(result).toBe(false);
  });

  it('returns false when instanceUrl is present but port is absent', () => {
    const cfg = makeCfg({ instanceUrl: 'wss://hub.example.com/' });
    const result = raccoonSetupWizard.status.resolveConfigured({ cfg });
    expect(result).toBe(false);
  });

  it('returns false when port is present but instanceUrl is absent', () => {
    const cfg = makeCfg({ port: 8790 });
    const result = raccoonSetupWizard.status.resolveConfigured({ cfg });
    expect(result).toBe(false);
  });

  it('returns true when both instanceUrl and port are present', () => {
    const cfg = makeCfg({ instanceUrl: 'wss://hub.example.com/', port: 8790 });
    const result = raccoonSetupWizard.status.resolveConfigured({ cfg });
    expect(result).toBe(true);
  });

  it('returns true with ws:// scheme and a numeric port', () => {
    const cfg = makeCfg({ instanceUrl: 'ws://localhost:8790/', port: 8790 });
    const result = raccoonSetupWizard.status.resolveConfigured({ cfg });
    expect(result).toBe(true);
  });

  it('returns false when port is 0 (falsy numeric)', () => {
    const cfg = makeCfg({ instanceUrl: 'wss://hub.example.com/', port: 0 });
    const result = raccoonSetupWizard.status.resolveConfigured({ cfg });
    expect(result).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// credentials — must be empty (self-hosted, no API keys)
// ---------------------------------------------------------------------------

describe('raccoonSetupWizard.credentials', () => {
  it('is an empty array (no API keys required)', () => {
    expect(raccoonSetupWizard.credentials).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// textInputs
// ---------------------------------------------------------------------------

describe('raccoonSetupWizard.textInputs', () => {
  it('has at least 4 text inputs (instance, port, instanceUrl, channels)', () => {
    expect(raccoonSetupWizard.textInputs).toBeDefined();
    expect(raccoonSetupWizard.textInputs!.length).toBeGreaterThanOrEqual(4);
  });

  describe('instanceUrl text input', () => {
    it('exists in textInputs', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'url',
      );
      expect(input).toBeDefined();
    });

    it('validate accepts ws:// URLs', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'url',
      )!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = input.validate?.({ value: 'ws://localhost:8790/', cfg: {} as any, accountId: 'default', credentialValues: {} });
      expect(result).toBeUndefined();
    });

    it('validate accepts wss:// URLs', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'url',
      )!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = input.validate?.({ value: 'wss://hub.example.com/', cfg: {} as any, accountId: 'default', credentialValues: {} });
      expect(result).toBeUndefined();
    });

    it('validate rejects http:// URLs', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'url',
      )!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = input.validate?.({ value: 'http://hub.example.com/', cfg: {} as any, accountId: 'default', credentialValues: {} });
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });

    it('validate rejects arbitrary non-ws strings', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'url',
      )!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = input.validate?.({ value: 'not-a-url', cfg: {} as any, accountId: 'default', credentialValues: {} });
      expect(result).toBeDefined();
    });

    it('validate rejects empty string', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'url',
      )!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = input.validate?.({ value: '', cfg: {} as any, accountId: 'default', credentialValues: {} });
      expect(result).toBeDefined();
    });
  });

  describe('port text input', () => {
    it('exists in textInputs', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'httpPort',
      );
      expect(input).toBeDefined();
    });

    it('validate accepts a positive integer string', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'httpPort',
      )!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = input.validate?.({ value: '8790', cfg: {} as any, accountId: 'default', credentialValues: {} });
      expect(result).toBeUndefined();
    });

    it('validate rejects non-numeric strings', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'httpPort',
      )!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = input.validate?.({ value: 'abc', cfg: {} as any, accountId: 'default', credentialValues: {} });
      expect(result).toBeDefined();
    });

    it('validate rejects empty string', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'httpPort',
      )!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = input.validate?.({ value: '', cfg: {} as any, accountId: 'default', credentialValues: {} });
      expect(result).toBeDefined();
    });

    it('validate rejects port 0', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'httpPort',
      )!;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = input.validate?.({ value: '0', cfg: {} as any, accountId: 'default', credentialValues: {} });
      expect(result).toBeDefined();
    });
  });

  describe('channels text input (CSV)', () => {
    it('exists in textInputs', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'groupChannels',
      );
      expect(input).toBeDefined();
    });

    it('normalizeValue splits CSV into a comma-joined string', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'groupChannels',
      )!;
      // normalizeValue receives the raw CSV string and returns it normalized.
      // For the SDK, the applySet method will convert to string[]; normalizeValue
      // strips whitespace around each entry.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = input.normalizeValue?.({ value: ' coordinator , assistant ', cfg: {} as any, accountId: 'default', credentialValues: {} });
      // Should return a trimmed canonical representation
      expect(result).toBeDefined();
      expect(typeof result).toBe('string');
    });
  });

  describe('instance name text input', () => {
    it('exists in textInputs with inputKey "name"', () => {
      const input = raccoonSetupWizard.textInputs!.find(
        (t) => t.inputKey === 'name',
      );
      expect(input).toBeDefined();
    });
  });
});

// ---------------------------------------------------------------------------
// completionNote — must reference the pair command
// ---------------------------------------------------------------------------

describe('raccoonSetupWizard.completionNote', () => {
  it('is defined', () => {
    expect(raccoonSetupWizard.completionNote).toBeDefined();
  });

  it('completionNote.lines contain guidance to run "openclaw raccoon pair <userId>"', () => {
    const note = raccoonSetupWizard.completionNote!;
    const combined = note.lines.join(' ');
    expect(combined).toMatch(/openclaw raccoon pair/);
  });

  it('completionNote.lines contain userId placeholder', () => {
    const note = raccoonSetupWizard.completionNote!;
    const combined = note.lines.join(' ');
    // Should mention userId or user or <userId> to guide operator
    expect(combined).toMatch(/user/i);
  });
});

// ---------------------------------------------------------------------------
// allowFrom — must be defined (createAllowFromSection result)
// ---------------------------------------------------------------------------

describe('raccoonSetupWizard.allowFrom', () => {
  it('is defined', () => {
    expect(raccoonSetupWizard.allowFrom).toBeDefined();
  });

  it('has a message field (string)', () => {
    expect(typeof raccoonSetupWizard.allowFrom!.message).toBe('string');
  });

  it('has a placeholder field (string)', () => {
    expect(typeof raccoonSetupWizard.allowFrom!.placeholder).toBe('string');
  });

  it('parseId returns the trimmed userId when given a plain string', () => {
    const result = raccoonSetupWizard.allowFrom!.parseId('alice');
    expect(result).toBe('alice');
  });

  it('parseId returns null for empty string', () => {
    const result = raccoonSetupWizard.allowFrom!.parseId('');
    expect(result).toBeNull();
  });

  it('parseId trims whitespace', () => {
    const result = raccoonSetupWizard.allowFrom!.parseId('  bob  ');
    expect(result).toBe('bob');
  });
});

// ---------------------------------------------------------------------------
// dmPolicy — must be present with 'allowlist' default
// ---------------------------------------------------------------------------

describe('raccoonSetupWizard.dmPolicy', () => {
  it('is defined', () => {
    expect(raccoonSetupWizard.dmPolicy).toBeDefined();
  });

  it('has label field', () => {
    expect(typeof raccoonSetupWizard.dmPolicy!.label).toBe('string');
  });

  it('getCurrent returns "allowlist" when no policy is configured', () => {
    const cfg = makeCfg();
    const current = raccoonSetupWizard.dmPolicy!.getCurrent(cfg);
    expect(current).toBe('allowlist');
  });

  it('getCurrent reads the configured dmPolicy from config', () => {
    const cfg = makeCfg({ dmPolicy: 'open' });
    const current = raccoonSetupWizard.dmPolicy!.getCurrent(cfg);
    expect(current).toBe('open');
  });
});

// ---------------------------------------------------------------------------
// channel identifier
// ---------------------------------------------------------------------------

describe('raccoonSetupWizard.channel', () => {
  it('is "raccoon"', () => {
    expect(raccoonSetupWizard.channel).toBe('raccoon');
  });
});
