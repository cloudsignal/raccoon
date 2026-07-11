import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope, type Envelope } from '@raccoon/protocol';
import { closeDbForTests } from './idb.js';
import * as approvals from './approvals.js';

afterEach(async () => { await closeDbForTests(); });

const req = (refId: string, channel = 'coordinator', ts?: string): Envelope<'approval.request'> => {
  const env = createEnvelope('approval.request', {
    from: 'agent:coordinator', to: 'user:u1', channel,
    payload: { refId, title: `T-${refId}`, description: 'do it?', options: ['approve', 'skip'] },
  });
  return ts ? { ...env, ts } : env;
};

const A = 'ws://a/::{"i":"a","u":"u1","e":"e1"}';
const B = 'ws://b/::{"i":"b","u":"u1","e":"e1"}';

describe('approvals store', () => {
  it('saves and lists an approval request scoped by identity + channel', async () => {
    await approvals.saveApproval(A, req('r1'));
    const list = await approvals.listApprovals(A, 'coordinator');
    expect(list).toHaveLength(1);
    expect(list[0]!.refId).toBe('r1');
    expect(list[0]!.env.payload.title).toBe('T-r1');
  });

  it('never surfaces another identity scope\'s requests (key carries the scope)', async () => {
    await approvals.saveApproval(A, req('r1'));
    await approvals.saveApproval(B, req('r1')); // SAME refId, different identity
    expect(await approvals.listApprovals(A, 'coordinator')).toHaveLength(1);
    expect((await approvals.listApprovals(A, 'coordinator'))[0]!.scope).toBe(A);
    // B's row is independent — same refId did not overwrite A's.
    expect(await approvals.listApprovals(B, 'coordinator')).toHaveLength(1);
  });

  it('filters by channel', async () => {
    await approvals.saveApproval(A, req('r1', 'coordinator'));
    await approvals.saveApproval(A, req('r2', 'scout'));
    expect((await approvals.listApprovals(A, 'coordinator')).map((x) => x.refId)).toEqual(['r1']);
    expect((await approvals.listApprovals(A, 'scout')).map((x) => x.refId)).toEqual(['r2']);
  });

  it('lists oldest-first by ts', async () => {
    await approvals.saveApproval(A, req('r2', 'coordinator', '2020-01-02T00:00:00.000Z'));
    await approvals.saveApproval(A, req('r1', 'coordinator', '2020-01-01T00:00:00.000Z'));
    expect((await approvals.listApprovals(A, 'coordinator')).map((x) => x.refId)).toEqual(['r1', 'r2']);
  });

  it('deleteApproval prunes only the matching scope+refId', async () => {
    await approvals.saveApproval(A, req('r1'));
    await approvals.saveApproval(B, req('r1'));
    await approvals.deleteApproval(A, 'r1');
    expect(await approvals.listApprovals(A, 'coordinator')).toHaveLength(0);
    expect(await approvals.listApprovals(B, 'coordinator')).toHaveLength(1); // other identity untouched
  });

  it('clearApprovalsForScope drops one identity, leaves the other', async () => {
    await approvals.saveApproval(A, req('r1'));
    await approvals.saveApproval(A, req('r2'));
    await approvals.saveApproval(B, req('r3'));
    await approvals.clearApprovalsForScope(A);
    expect(await approvals.listApprovals(A, 'coordinator')).toHaveLength(0);
    expect((await approvals.listApprovals(B, 'coordinator')).map((x) => x.refId)).toEqual(['r3']);
  });
});
