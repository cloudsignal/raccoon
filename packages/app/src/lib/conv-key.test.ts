// packages/app/src/lib/conv-key.test.ts
import { describe, expect, it } from 'vitest';
import { accentColor, convKeyOf, nextAccentColor, resolveConvKey } from './conv-key.js';

describe('conv-key', () => {
  it('builds pairingId/channel', () => {
    expect(convKeyOf('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'coordinator'))
      .toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV/coordinator');
  });

  it('resolves against known pairing ids', () => {
    const ids = ['01ARZ3NDEKTSV4RRFFQ69G5FAV', '01BX5ZZKBKACTAV9WEVGEMMVRZ'];
    expect(resolveConvKey('01BX5ZZKBKACTAV9WEVGEMMVRZ/coordinator', ids))
      .toEqual({ pairingId: '01BX5ZZKBKACTAV9WEVGEMMVRZ', channel: 'coordinator' });
    expect(resolveConvKey('unknown/coordinator', ids)).toBeNull();
  });

  it('resolves a host-derived pairing id that itself contains slashes', () => {
    // A host pairing id is the legacy identity-key JSON, whose values may
    // contain '/' — resolution must longest-prefix-match against known ids,
    // never naively split on the first '/'.
    const hostId = JSON.stringify({ i: 'my/instance', u: 'u1', e: 'e1' });
    expect(resolveConvKey(`${hostId}/coordinator`, [hostId]))
      .toEqual({ pairingId: hostId, channel: 'coordinator' });
  });

  it('longest match wins when one id prefixes another', () => {
    const short = 'aa';
    const long = 'aa/bb';
    expect(resolveConvKey('aa/bb/chan', [short, long]))
      .toEqual({ pairingId: long, channel: 'chan' });
  });

  it('accent color is deterministic and from the palette', () => {
    const c = accentColor('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(c).toBe(accentColor('01ARZ3NDEKTSV4RRFFQ69G5FAV'));
    expect(c).toMatch(/^oklch\(/);
    expect(accentColor('x')).toMatch(/^oklch\(/);
  });

  it('nextAccentColor picks the first palette entry not in use', () => {
    const blue = 'oklch(0.55 0.13 255)';
    const rust = 'oklch(0.62 0.14 30)';
    const moss = 'oklch(0.56 0.1 155)';
    expect(nextAccentColor([])).toBe(blue);
    expect(nextAccentColor([blue])).toBe(rust);
    // Gaps are refilled: with Blue and Moss taken, Rust is the first unused.
    expect(nextAccentColor([blue, moss])).toBe(rust);
    // Unknown strings (custom user colors) never block a palette entry.
    expect(nextAccentColor(['#123456'])).toBe(blue);
  });

  it('nextAccentColor returns "" when all 8 palette entries are taken', () => {
    const all = [
      'oklch(0.55 0.13 255)', 'oklch(0.62 0.14 30)', 'oklch(0.56 0.1 155)',
      'oklch(0.58 0.12 300)', 'oklch(0.68 0.12 75)', 'oklch(0.62 0.12 355)',
      'oklch(0.6 0.1 215)', 'oklch(0.6 0.09 120)',
    ];
    expect(nextAccentColor(all)).toBe('');
  });
});
