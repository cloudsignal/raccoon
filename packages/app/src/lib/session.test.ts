import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDbForTests } from './idb.js';
import { clearSession, clearSessionIfMatches, loadSession, saveSession, type Session } from './session.js';
import {
  hostIdentityKey, loadPairingsRaw, removePairingIfMatches, savePairings,
  updatePairingMeta, upsertPairing, type PairedSession,
} from './session.js';

afterEach(async () => { await closeDbForTests(); });

const session: Session = {
  url: 'ws://127.0.0.1:8790/',
  sessionToken: 'tok',
  userId: 'u1',
  instance: 'echo',
  channels: ['coordinator'],
  vapidPublicKey: 'BKey',
  epoch: 'epoch-1', // #R7-3
};

describe('session store', () => {
  it('round-trips a session', async () => {
    expect(await loadSession()).toBeNull();
    await saveSession(session);
    expect(await loadSession()).toEqual(session);
  });

  it('mints a non-secret epoch when saving a session without one, and preserves it (#R7-3)', async () => {
    const { epoch: _drop, ...noEpoch } = session;
    await saveSession(noEpoch);
    const loaded = await loadSession();
    expect(loaded?.epoch).toBeTruthy();
    // Stable across reloads.
    expect((await loadSession())?.epoch).toBe(loaded?.epoch);
  });

  it('lazily migrates a pre-epoch stored session by minting + persisting an epoch (#R7-3)', async () => {
    const { kvSet } = await import('./idb.js');
    const { epoch: _drop, ...legacy } = session;
    await kvSet('session', legacy); // simulate a session saved before epoch existed
    const first = await loadSession();
    expect(first?.epoch).toBeTruthy();
    expect((await loadSession())?.epoch).toBe(first?.epoch); // persisted, not re-minted
  });

  it('clears', async () => {
    await saveSession(session);
    await clearSession();
    expect(await loadSession()).toBeNull();
  });

  it('concurrent legacy loads converge on ONE epoch (atomic get-or-set, #R8-4)', async () => {
    const { kvSet } = await import('./idb.js');
    const { epoch: _drop, ...legacy } = session;
    await kvSet('session', legacy); // pre-epoch stored session

    // Two tabs load concurrently. With a read-then-write migration each would
    // mint a different random epoch and race their writes; the atomic
    // get-or-set must make both observe the SAME epoch.
    const [a, b] = await Promise.all([loadSession(), loadSession()]);
    expect(a?.epoch).toBeTruthy();
    expect(a?.epoch).toBe(b?.epoch);
    // And the persisted value matches (no divergent write won).
    expect((await loadSession())?.epoch).toBe(a?.epoch);
  });

  it('clearSessionIfMatches clears a matching session but leaves a since-re-paired newer one (#R7-3)', async () => {
    const keyOf = (s: Session) => `${s.instance}:${s.userId}:${s.epoch}`;
    await saveSession(session); // epoch-1
    // A stale tombstoned-load for a DIFFERENT (older) identity must NOT clear.
    expect(await clearSessionIfMatches('echo:u1:old-epoch', keyOf)).toBe(false);
    expect(await loadSession()).not.toBeNull(); // newer session preserved

    // The matching identity IS cleared.
    expect(await clearSessionIfMatches(keyOf(session), keyOf)).toBe(true);
    expect(await loadSession()).toBeNull();
  });

  it('round-trips a host session with url/sessionToken omitted, and identityKey stays epoch-based (#A3)', async () => {
    const hostSession: Session = { userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: 'epoch-1' };
    await saveSession(hostSession);
    const loaded = await loadSession();
    expect(loaded).toEqual(hostSession);
    expect(loaded?.url).toBeUndefined();
    expect(loaded?.sessionToken).toBeUndefined();
    // The identity key a host uses is derived from the epoch, never url/token.
    const keyOf = (s: Session) => `${s.instance}:${s.userId}:${s.epoch}`;
    expect(keyOf(loaded!)).toBe('i:u1:epoch-1');
  });

  it('rejects corrupt stored values', async () => {
    const { kvSet } = await import('./idb.js');
    await kvSet('session', { nope: true });
    expect(await loadSession()).toBeNull();
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

  it('hostIdentityKey matches the legacy identity-key format', () => {
    expect(hostIdentityKey({ instance: 'i', userId: 'u1', epoch: 'e1' }))
      .toBe(JSON.stringify({ i: 'i', u: 'u1', e: 'e1' }));
  });
});
