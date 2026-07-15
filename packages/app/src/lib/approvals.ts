import type { Envelope } from '@raccoon/protocol';
import { promisifyRequest, withStore, withTransaction } from './idb.js';

/**
 * Durable, identity-SCOPED store of approval REQUESTS (#R8-1).
 *
 * Server history carries an approval.request only as a text row — there is no
 * way to reconstruct the interactive approval card from it. So a reload would
 * lose the card entirely: `reconcile-responses` (which reattaches this
 * device's responded/failed state) then has nothing to attach onto, and a
 * failed response's retry affordance never reappears.
 *
 * This store persists the raw approval.request envelope, keyed by
 * `${scope}::${refId}` so a record can NEVER be read under a different
 * identity scope (the key itself carries the scope — cross-identity attach is
 * impossible by construction, not merely by a filter). A settled response
 * prunes its request.
 */
export interface StoredApproval {
  /** `${scope}::${refId}` — the primary key. */
  key: string;
  scope: string;
  channel: string;
  refId: string;
  /** The request envelope — present for a LIVE (renderable) record; omitted on
   *  an answered tombstone (#R10). */
  env?: Envelope<'approval.request'>;
  ts: string;
  /** #R10: an ANSWERED tombstone. A settled ('delivered') response leaves this
   *  marker at the key instead of deleting the record, so a late/redelivered
   *  approval.request for the same refId cannot re-create it as an UNANSWERED
   *  card on reload. Tombstones are excluded from listApprovals (a settled
   *  approval needs no card — its outcome is the agent's reply in history) and
   *  cleared on wipe. */
  answered?: boolean;
}

/** A live (renderable) stored approval — env is guaranteed present. */
export type LiveApproval = StoredApproval & { env: Envelope<'approval.request'> };

/** The 'approvals' store primary key. Exported so a cross-store cleanup
 *  transaction (outbox.settleResponseAndPruneApproval, #P1-E2) can delete the
 *  matching approval record by scope + refId. */
export function keyOf(scope: string, refId: string): string {
  return `${scope}::${refId}`;
}

export async function saveApproval(scope: string, env: Envelope<'approval.request'>): Promise<void> {
  const refId = env.payload.refId;
  const key = keyOf(scope, refId);
  // #R10: single-transaction get-then-put so a LATE/redelivered approval.request
  // cannot overwrite an answered tombstone (which would resurrect a settled
  // approval as an unanswered card on reload). If the key is already an
  // answered tombstone, leave it.
  await withTransaction('approvals', 'readwrite', async (s) => {
    const existing = await promisifyRequest(s.get(key) as IDBRequest<StoredApproval | undefined>);
    if (existing?.answered) return;
    const record: StoredApproval = { key, scope, channel: env.channel, refId, env, ts: env.ts };
    await promisifyRequest(s.put(record));
  });
}

/** Live (renderable) stored approval requests for this identity scope +
 *  channel, oldest first. Excludes answered tombstones (#R10). */
export async function listApprovals(scope: string, channel: string): Promise<LiveApproval[]> {
  const all = await withStore<StoredApproval[]>('approvals', 'readonly', (s) => s.getAll() as IDBRequest<StoredApproval[]>);
  return all
    .filter((a): a is LiveApproval => a.scope === scope && a.channel === channel && !a.answered && a.env !== undefined)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Prune a settled approval (its response reached a terminal 'delivered').
 *  Deletes the record entirely — use this only where a tombstone is not needed;
 *  the settle path uses a tombstone (outbox.settleResponseAndPruneApproval). */
export async function deleteApproval(scope: string, refId: string): Promise<void> {
  await withStore('approvals', 'readwrite', (s) => { s.delete(keyOf(scope, refId)); });
}

/** Drop every stored approval for an identity scope (unpair / auth wipe). */
export async function clearApprovalsForScope(scope: string): Promise<void> {
  const all = await withStore<StoredApproval[]>('approvals', 'readonly', (s) => s.getAll() as IDBRequest<StoredApproval[]>);
  await withStore('approvals', 'readwrite', (s) => {
    for (const a of all) if (a.scope === scope) s.delete(a.key);
  });
}
