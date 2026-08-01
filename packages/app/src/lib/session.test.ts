import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDbForTests } from './idb.js';
import {
  hostIdentityKey, loadPairingsRaw, removePairingIfMatches, savePairings,
  sessionSchema, updatePairingMeta, upsertPairing, type PairedSession, type Session,
} from './session.js';

afterEach(async () => { await closeDbForTests(); });

// The legacy `session` kv singleton is exercised via lib/adopt.ts (its only
// remaining reader) — see adopt.test.ts. This file covers the schema shape
// hosts still build on (#A3) and the pairings store.

describe('session schema', () => {
  it('accepts a host session with url/sessionToken omitted (#A3)', () => {
    const hostSession: Session = { userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: 'epoch-1' };
    const parsed = sessionSchema.safeParse(hostSession);
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.url).toBeUndefined();
    expect(parsed.success && parsed.data.sessionToken).toBeUndefined();
  });

  it('rejects corrupt values', () => {
    expect(sessionSchema.safeParse({ nope: true }).success).toBe(false);
  });
});

const pairingA: PairedSession = {
  url: 'ws://a.example/', sessionToken: 'tokA', userId: 'u1', instance: 'alpha',
  channels: ['coordinator'], epoch: 'eA', pairingId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  transportKind: 'ws',
};
const pairingB: PairedSession = {
  url: 'ws://b.example/', sessionToken: 'tokB', userId: 'u2', instance: 'beta',
  channels: ['coordinator', 'scout'], epoch: 'eB', pairingId: '01BX5ZZKBKACTAV9WEVGEMMVRZ',
  transportKind: 'ws', displayName: 'Beta box',
};

describe('pairings store', () => {
  it('round-trips an ordered list', async () => {
    expect(await loadPairingsRaw()).toEqual([]);
    await savePairings([pairingA, pairingB]);
    expect(await loadPairingsRaw()).toEqual([pairingA, pairingB]);
  });

  it('upsertPairing appends a new pairing', async () => {
    await savePairings([pairingA]);
    const stored = await upsertPairing(pairingB);
    expect(stored.pairingId).toBe(pairingB.pairingId);
    expect(await loadPairingsRaw()).toEqual([pairingA, pairingB]);
  });

  it('upsertPairing refreshes in place on (url, userId) match, preserving pairingId/displayName/color', async () => {
    await savePairings([{ ...pairingA, displayName: 'Home', color: '#10b981' }]);
    const rescanned: PairedSession = {
      ...pairingA, pairingId: '01SHOULDNOTREPLACETHEOLDID', sessionToken: 'tokA2',
      channels: ['coordinator', 'newchan'], epoch: 'eA2',
    };
    const stored = await upsertPairing(rescanned);
    expect(stored.pairingId).toBe(pairingA.pairingId);   // preserved
    expect(stored.displayName).toBe('Home');              // preserved
    expect(stored.color).toBe('#10b981');                 // preserved
    expect(stored.sessionToken).toBe('tokA2');            // refreshed
    expect(stored.epoch).toBe('eA2');                     // refreshed
    expect((await loadPairingsRaw()).length).toBe(1);
  });

  it('same url as a different user is a separate pairing', async () => {
    await savePairings([pairingA]);
    await upsertPairing({ ...pairingA, pairingId: '01OTHERUSERSAMEURLPAIRING0', userId: 'u9', epoch: 'e9' });
    expect((await loadPairingsRaw()).length).toBe(2);
  });

  it('removePairingIfMatches is epoch-gated', async () => {
    await savePairings([pairingA, pairingB]);
    expect(await removePairingIfMatches(pairingA.pairingId, 'WRONG')).toBe(false);
    expect((await loadPairingsRaw()).length).toBe(2);
    expect(await removePairingIfMatches(pairingA.pairingId, 'eA')).toBe(true);
    expect(await loadPairingsRaw()).toEqual([pairingB]);
  });

  it('updatePairingMeta patches displayName without touching auth fields', async () => {
    await savePairings([pairingA]);
    const list = await updatePairingMeta(pairingA.pairingId, { displayName: 'Renamed' });
    expect(list[0]!.displayName).toBe('Renamed');
    expect(list[0]!.sessionToken).toBe('tokA');
  });

  it('updatePairingMeta with an empty rename clears the override instead of storing an invalid value', async () => {
    await savePairings([{ ...pairingA, displayName: 'Home', color: '#10b981' }]);
    const list = await updatePairingMeta(pairingA.pairingId, { displayName: '' });
    expect(list[0]!.displayName).toBeUndefined(); // override cleared, not stored as ''
    expect(list[0]!.color).toBe('#10b981');       // untouched field preserved
    // The store must remain loadable: an invalid write would fail the
    // all-or-nothing list parse and make EVERY pairing disappear.
    expect(await loadPairingsRaw()).toEqual(list);
    expect((await loadPairingsRaw()).length).toBe(1);
  });

  it('updatePairingMeta with a no-match pairingId leaves the list loadable and unchanged', async () => {
    await savePairings([pairingA, pairingB]);
    const list = await updatePairingMeta('01NOSUCHPAIRINGIDANYWHERE0', { displayName: 'X' });
    expect(list).toEqual([pairingA, pairingB]);
    expect(await loadPairingsRaw()).toEqual([pairingA, pairingB]);
  });

  it('hostIdentityKey matches the legacy identity-key format', () => {
    expect(hostIdentityKey({ instance: 'i', userId: 'u1', epoch: 'e1' }))
      .toBe(JSON.stringify({ i: 'i', u: 'u1', e: 'e1' }));
  });
});
