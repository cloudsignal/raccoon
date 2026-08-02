import { afterEach, describe, expect, it, vi } from 'vitest';
import baseline from '../raccoon.config.json' with { type: 'json' };
import { appConfig, channelMeta, hostManagedCopy, listLayout, mergedSuffix, platformGlyph } from './config.js';

describe('brand config', () => {
  it('parses the default Raccoon brand', () => {
    expect(appConfig.name).toBe('Raccoon');
    expect(appConfig.wallpaper).toBe('#EDE6DA');
    expect(appConfig.outgoing).toBe('#D9FDD3');
  });

  it('resolves channel meta with config overrides', () => {
    const meta = channelMeta('coordinator');
    expect(meta.label).toBe('Coordinator');
    expect(meta.blurb).toBe('Your single point of contact');
    expect(meta.tone).toBe('navy');
  });

  it('derives deterministic defaults for unknown channels', () => {
    const a = channelMeta('assistant');
    const b = channelMeta('assistant');
    expect(a.label).toBe('Assistant');
    expect(a.tone).toBe(b.tone);
  });

  it('humanizes multi-word channel ids (#2)', () => {
    expect(channelMeta('my-agent').label).toBe('My Agent');
    expect(channelMeta('code_review').label).toBe('Code Review');
    expect(channelMeta('ops.oncall').label).toBe('Ops Oncall');
  });
});

describe('platform-UX config surface', () => {
  afterEach(() => {
    vi.doUnmock('../raccoon.config.json');
    vi.resetModules();
  });

  /** Re-imports config.ts against a config extended with the given fields. */
  async function loadWith(extra: Record<string, unknown>): Promise<typeof import('./config.js')> {
    vi.resetModules();
    vi.doMock('../raccoon.config.json', () => ({ default: { ...baseline, ...extra } }));
    return await import('./config.js');
  }

  it('returns neutral defaults when the config omits the fields', () => {
    expect(listLayout()).toBe('grouped');
    expect(mergedSuffix()).toBe('collision');
    expect(platformGlyph('alpha')).toBeNull();
    expect(hostManagedCopy()).toEqual({
      banner: 'Managed by the host application',
      renameNote: 'Set by the host application',
      logoutLabel: 'Log out',
    });
  });

  it('returns configured values when the fields are present', async () => {
    const cfg = await loadWith({
      listLayout: 'merged',
      mergedSuffix: 'always',
      platformBranding: {
        alpha: { glyph: 'marker-1', label: 'Alpha' },
        atlas: { glyph: 'M0 0L8 8' },
      },
      hostManaged: {
        banner: 'Accounts are provisioned externally',
        renameNote: 'Display name is fixed',
        logoutLabel: 'Sign out',
      },
    });
    expect(cfg.listLayout()).toBe('merged');
    expect(cfg.mergedSuffix()).toBe('always');
    expect(cfg.platformGlyph('alpha')).toEqual({ glyph: 'marker-1', label: 'Alpha' });
    expect(cfg.platformGlyph('atlas')).toEqual({ glyph: 'M0 0L8 8' });
    expect(cfg.platformGlyph('unknown')).toBeNull();
    expect(cfg.hostManagedCopy()).toEqual({
      banner: 'Accounts are provisioned externally',
      renameNote: 'Display name is fixed',
      logoutLabel: 'Sign out',
    });
  });

  it('fills unset host-managed copy fields with neutral defaults', async () => {
    const cfg = await loadWith({ hostManaged: { logoutLabel: 'Sign out' } });
    expect(cfg.hostManagedCopy()).toEqual({
      banner: 'Managed by the host application',
      renameNote: 'Set by the host application',
      logoutLabel: 'Sign out',
    });
  });
});
