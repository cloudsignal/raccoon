// adapters/openclaw/src/pairing-adapter.test.ts
// Task 5 TDD: pairing adapter + security adapter tests.
// All tests must FAIL before the implementations are written.

import { describe, it, expect, vi } from 'vitest';

// These imports will fail until the modules exist — that's the RED state.
import {
  createRaccoonPairingAdapter,
  createRaccoonSecurityAdapter,
  type PairingIssuer,
} from './pairing-adapter.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Fake PairingIssuer: returns a deterministic { qr, payload, token }.
 */
function makeFakeIssuer(overrides?: Partial<ReturnType<PairingIssuer['issue']> extends Promise<infer T> ? T : never>): PairingIssuer {
  return {
    issue: vi.fn().mockResolvedValue({
      token: 'tok-abc',
      payload: 'raccoon://pair?token=tok-abc',
      qr: '[QR-BLOCK]',
      ...overrides,
    }),
  };
}

// ---------------------------------------------------------------------------
// ChannelPairingAdapter
// ---------------------------------------------------------------------------

describe('createRaccoonPairingAdapter', () => {
  it('exposes idLabel "Raccoon user id"', () => {
    const adapter = createRaccoonPairingAdapter(makeFakeIssuer());
    expect(adapter.idLabel).toBe('Raccoon user id');
  });

  describe('normalizeAllowEntry', () => {
    it('trims leading and trailing whitespace', () => {
      const adapter = createRaccoonPairingAdapter(makeFakeIssuer());
      expect(adapter.normalizeAllowEntry!('  alice  ')).toBe('alice');
    });

    it('lowercases the entry', () => {
      const adapter = createRaccoonPairingAdapter(makeFakeIssuer());
      expect(adapter.normalizeAllowEntry!('Alice')).toBe('alice');
    });

    it('trims and lowercases combined', () => {
      const adapter = createRaccoonPairingAdapter(makeFakeIssuer());
      expect(adapter.normalizeAllowEntry!('  BOB  ')).toBe('bob');
    });

    it('leaves a already-normalized entry unchanged', () => {
      const adapter = createRaccoonPairingAdapter(makeFakeIssuer());
      expect(adapter.normalizeAllowEntry!('user-123')).toBe('user-123');
    });

    it('returns empty string for blank-only input', () => {
      const adapter = createRaccoonPairingAdapter(makeFakeIssuer());
      expect(adapter.normalizeAllowEntry!('   ')).toBe('');
    });
  });

  describe('notifyApproval', () => {
    it('calls the issuer with the approved userId (id param)', async () => {
      const issuer = makeFakeIssuer();
      const adapter = createRaccoonPairingAdapter(issuer);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- opaque cfg shim, never constructed by Raccoon
      await adapter.notifyApproval!({ cfg: {} as any, id: 'alice' });

      expect(issuer.issue).toHaveBeenCalledWith('alice');
    });

    it('calls the issuer only once per invocation', async () => {
      const issuer = makeFakeIssuer();
      const adapter = createRaccoonPairingAdapter(issuer);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await adapter.notifyApproval!({ cfg: {} as any, id: 'alice' });

      expect(issuer.issue).toHaveBeenCalledTimes(1);
    });

    it('does not throw when the issuer resolves', async () => {
      const issuer = makeFakeIssuer();
      const adapter = createRaccoonPairingAdapter(issuer);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(adapter.notifyApproval!({ cfg: {} as any, id: 'bob' })).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// ChannelSecurityAdapter (raccoon-specific: resolveAllowFrom + checkDmAllowance)
// ---------------------------------------------------------------------------

describe('createRaccoonSecurityAdapter', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const makeConfig = (allowFrom?: string[]): any => ({
    channels: {
      raccoon: {
        ...(allowFrom !== undefined ? { allowFrom } : {}),
      },
    },
  });

  describe('resolveAllowFrom', () => {
    it('returns the allowFrom list from the raccoon config section', () => {
      const adapter = createRaccoonSecurityAdapter();
      const cfg = makeConfig(['alice', 'bob']);
      const result = adapter.resolveAllowFrom(cfg);
      expect(result).toEqual(['alice', 'bob']);
    });

    it('returns an empty array when allowFrom is absent', () => {
      const adapter = createRaccoonSecurityAdapter();
      const cfg = makeConfig();
      const result = adapter.resolveAllowFrom(cfg);
      expect(result).toEqual([]);
    });

    it('returns an empty array when allowFrom is empty', () => {
      const adapter = createRaccoonSecurityAdapter();
      const cfg = makeConfig([]);
      const result = adapter.resolveAllowFrom(cfg);
      expect(result).toEqual([]);
    });

    it('returns an empty array when raccoon section is absent', () => {
      const adapter = createRaccoonSecurityAdapter();
      const cfg = { channels: {} };
      const result = adapter.resolveAllowFrom(cfg as any);
      expect(result).toEqual([]);
    });
  });

  describe('checkDmAllowance', () => {
    it('returns true when the userId is in the allowFrom list', () => {
      const adapter = createRaccoonSecurityAdapter();
      const cfg = makeConfig(['alice', 'bob']);
      expect(adapter.checkDmAllowance(cfg, 'alice')).toBe(true);
    });

    it('returns true when matching is case-insensitive (stored lowercase, queried mixed)', () => {
      const adapter = createRaccoonSecurityAdapter();
      const cfg = makeConfig(['alice']);
      // normalizeAllowEntry lowercases; the allowFrom in config should already
      // be stored lowercased, but checkDmAllowance must normalize both sides.
      expect(adapter.checkDmAllowance(cfg, 'Alice')).toBe(true);
    });

    it('returns false when userId is NOT in the allowFrom list', () => {
      const adapter = createRaccoonSecurityAdapter();
      const cfg = makeConfig(['alice', 'bob']);
      expect(adapter.checkDmAllowance(cfg, 'charlie')).toBe(false);
    });

    it('returns false when allowFrom is empty (deny all)', () => {
      const adapter = createRaccoonSecurityAdapter();
      const cfg = makeConfig([]);
      expect(adapter.checkDmAllowance(cfg, 'alice')).toBe(false);
    });

    it('returns false when allowFrom is absent (deny all)', () => {
      const adapter = createRaccoonSecurityAdapter();
      const cfg = makeConfig();
      expect(adapter.checkDmAllowance(cfg, 'alice')).toBe(false);
    });
  });

  describe('dmPolicy is honored (#2)', () => {
    const cfgWith = (dmPolicy: string, allowFrom: string[] = []): any => ({
      channels: { raccoon: { dmPolicy, allowFrom } },
    });
    it('open admits everyone, including users not in allowFrom', () => {
      const adapter = createRaccoonSecurityAdapter();
      expect(adapter.checkDmAllowance(cfgWith('open', []), 'stranger')).toBe(true);
    });
    it('disabled admits no one, even users in allowFrom', () => {
      const adapter = createRaccoonSecurityAdapter();
      expect(adapter.checkDmAllowance(cfgWith('disabled', ['alice']), 'alice')).toBe(false);
    });
    it('allowlist admits only allowFrom members', () => {
      const adapter = createRaccoonSecurityAdapter();
      expect(adapter.checkDmAllowance(cfgWith('allowlist', ['alice']), 'alice')).toBe(true);
      expect(adapter.checkDmAllowance(cfgWith('allowlist', ['alice']), 'bob')).toBe(false);
    });
    it('resolveDmPolicy reports the configured policy, not a hardcoded allowlist', () => {
      const adapter = createRaccoonSecurityAdapter();
      expect(adapter.resolveDmPolicy?.({ cfg: cfgWith('open'), account: null })?.policy).toBe('open');
      expect(adapter.resolveDmPolicy?.({ cfg: cfgWith('disabled'), account: null })?.policy).toBe('disabled');
    });
  });

  describe('defaultDmPolicy', () => {
    it('is "allowlist"', () => {
      const adapter = createRaccoonSecurityAdapter();
      expect(adapter.defaultDmPolicy).toBe('allowlist');
    });
  });

  describe('resolveDmPolicy (ChannelSecurityAdapter contract)', () => {
    it('returns a ChannelSecurityDmPolicy with policy "allowlist"', () => {
      const adapter = createRaccoonSecurityAdapter();
      const cfg = makeConfig(['alice']);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = { cfg, accountId: 'default', account: {} as any };
      const result = adapter.resolveDmPolicy!(ctx);
      expect(result).not.toBeNull();
      expect(result!.policy).toBe('allowlist');
    });

    it('includes allowFrom in the resolved policy', () => {
      const adapter = createRaccoonSecurityAdapter();
      const cfg = makeConfig(['alice', 'bob']);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const ctx = { cfg, accountId: 'default', account: {} as any };
      const result = adapter.resolveDmPolicy!(ctx);
      expect(result!.allowFrom).toEqual(['alice', 'bob']);
    });
  });
});
