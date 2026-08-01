// packages/app/src/lib/conv-key.test.ts
import { describe, expect, it } from 'vitest';
import { accentColor, convKeyOf, resolveConvKey } from './conv-key.js';

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
    expect(c).toMatch(/^#[0-9a-f]{6}$/);
    expect(accentColor('x')).toMatch(/^#[0-9a-f]{6}$/);
  });
});
