import { describe, expect, it } from 'vitest';
import { runUpdateCheck, type UpdateDeps } from './update-check.js';

function deps(overrides: Partial<UpdateDeps>): UpdateDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    buildId: 'aaa',
    fetchVersion: async () => ({ buildId: 'aaa' }),
    updateRegistrations: async () => { calls.push('update'); return false; },
    purgeShellCache: async () => { calls.push('purge'); },
    reload: () => { calls.push('reload'); },
    isHeld: () => false,
    ...overrides,
  };
}

describe('runUpdateCheck', () => {
  it('is a no-op in dev builds', async () => {
    const d = deps({ buildId: 'dev', fetchVersion: async () => ({ buildId: 'bbb' }) });
    expect(await runUpdateCheck(d)).toBe('current');
    expect(d.calls).toEqual([]);
  });

  it('returns current when versions match', async () => {
    const d = deps({});
    expect(await runUpdateCheck(d)).toBe('current');
  });

  it('returns offline on fetch failure', async () => {
    const d = deps({ fetchVersion: async () => null });
    expect(await runUpdateCheck(d)).toBe('offline');
  });

  it('defers to the SW pipeline when a new worker is pending', async () => {
    const d = deps({
      fetchVersion: async () => ({ buildId: 'bbb' }),
      updateRegistrations: async () => true,
    });
    expect(await runUpdateCheck(d)).toBe('sw-updating');
    expect(d.calls).not.toContain('reload');
  });

  it('purges and reloads on mismatch without a pending worker', async () => {
    const d = deps({ fetchVersion: async () => ({ buildId: 'bbb' }) });
    expect(await runUpdateCheck(d)).toBe('reloaded');
    expect(d.calls).toEqual(['update', 'purge', 'reload']);
  });

  it('holds the reload while the composer has a draft', async () => {
    const d = deps({ fetchVersion: async () => ({ buildId: 'bbb' }), isHeld: () => true });
    expect(await runUpdateCheck(d)).toBe('held');
    expect(d.calls).toEqual(['update', 'purge']);
  });
});
