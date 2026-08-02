import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDbForTests, kvGet, kvSet, wipeKvByPrefix } from './idb.js';
import { loadPairings } from './adopt.js';
import { hostIdentityKey } from './session.js';
import * as outbox from './outbox.js';
import { saveApproval, listApprovals } from './approvals.js';
import { createEnvelope, userAddress, agentAddress } from '@raccoon/protocol';

afterEach(async () => { await closeDbForTests(); });

const legacy = {
  url: 'ws://a.example/', sessionToken: 'tok', userId: 'u1', instance: 'alpha',
  channels: ['coordinator'], vapidPublicKey: 'BKey', epoch: 'e1',
};
const legacyScope = hostIdentityKey({ instance: 'alpha', userId: 'u1', epoch: 'e1' });

function msgEnv(channel: string) {
  return createEnvelope('msg', {
    from: userAddress('u1'), to: agentAddress(channel), channel, payload: { text: 'hi' },
  });
}

describe('adoption migration', () => {
  it('fresh install: no legacy session, returns [] and writes nothing', async () => {
    expect(await loadPairings()).toEqual([]);
    expect(await kvGet('pairings')).toBeUndefined();
  });

  it('already-adopted: returns the stored list untouched', async () => {
    await loadPairings(); // no-op
    const { savePairings } = await import('./session.js');
    const p = { ...legacy, pairingId: '01ARZ3NDEKTSV4RRFFQ69G5FAV', transportKind: 'ws' };
    await savePairings([p]);
    expect(await loadPairings()).toEqual([p]);
  });

  it('adopts a legacy session as pairing #1, rewriting lastread, outbox scope, and approvals keys', async () => {
    await kvSet('session', legacy); // seed the legacy kv singleton directly
    await kvSet('lastread:coordinator', '2026-08-01T00:00:00.000Z');
    const env = msgEnv('coordinator');
    await outbox.enqueue(env, legacyScope);
    const approval = createEnvelope('approval.request', {
      from: agentAddress('coordinator'), to: userAddress('u1'), channel: 'coordinator',
      payload: { refId: 'ref1', title: 'T', description: 'D', options: ['yes', 'no'] },
    });
    await saveApproval(legacyScope, approval);

    const list = await loadPairings();
    expect(list).toHaveLength(1);
    const adopted = list[0]!;
    expect(adopted.userId).toBe('u1');
    expect(adopted.transportKind).toBe('ws');
    expect(adopted.epoch).toBe('e1');
    expect(adopted.pairingId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/); // a ULID
    expect(adopted.color).toBe('oklch(0.55 0.13 255)'); // pairing #1 gets Blue (first unused hue)
    // legacy singleton gone, list present
    expect(await kvGet('session')).toBeUndefined();
    // lastread rewritten under the pairing
    expect(await kvGet('lastread:coordinator')).toBeUndefined();
    expect(await kvGet(`lastread:${adopted.pairingId}/coordinator`)).toBe('2026-08-01T00:00:00.000Z');
    // outbox row rescoped to the pairingId
    const row = await outbox.getEntry(env.id);
    expect(row?.scope).toBe(adopted.pairingId);
    // approval readable under the new scope, gone under the old
    expect(await listApprovals(adopted.pairingId, 'coordinator')).toHaveLength(1);
    expect(await listApprovals(legacyScope, 'coordinator')).toHaveLength(0);
  });

  it('is idempotent: a second load returns the same pairing (same pairingId)', async () => {
    await kvSet('session', legacy); // seed the legacy kv singleton directly
    const first = await loadPairings();
    const second = await loadPairings();
    expect(second).toEqual(first);
  });

  it('legacy session without epoch: adopts with a minted epoch, leaves unclaimable rows alone (#P1-F1 precedent)', async () => {
    const { epoch: _e, ...noEpoch } = legacy;
    await kvSet('session', noEpoch); // a legacy session stored before epochs existed
    const env = msgEnv('coordinator');
    await outbox.enqueue(env, 'SOME-OLD-TOKEN-DERIVED-SCOPE');
    const list = await loadPairings();
    expect(list[0]!.epoch).toBeTruthy();
    expect((await outbox.getEntry(env.id))?.scope).toBe('SOME-OLD-TOKEN-DERIVED-SCOPE'); // untouched
  });
});

describe('wipeKvByPrefix', () => {
  it('deletes only keys under the prefix', async () => {
    await kvSet('lastread:P1/coordinator', 'a');
    await kvSet('lastread:P1/scout', 'b');
    await kvSet('lastread:P2/coordinator', 'c');
    await kvSet('push-enabled', true);
    await wipeKvByPrefix('lastread:P1/');
    expect(await kvGet('lastread:P1/coordinator')).toBeUndefined();
    expect(await kvGet('lastread:P1/scout')).toBeUndefined();
    expect(await kvGet('lastread:P2/coordinator')).toBe('c');
    expect(await kvGet('push-enabled')).toBe(true);
  });
});
