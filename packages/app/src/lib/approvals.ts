import type { Envelope } from '@raccoon/protocol';
import { withStore } from './idb.js';

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
  env: Envelope<'approval.request'>;
  ts: string;
}

/** The 'approvals' store primary key. Exported so a cross-store cleanup
 *  transaction (outbox.settleResponseAndPruneApproval, #P1-E2) can delete the
 *  matching approval record by scope + refId. */
export function keyOf(scope: string, refId: string): string {
  return `${scope}::${refId}`;
}

export async function saveApproval(scope: string, env: Envelope<'approval.request'>): Promise<void> {
  const refId = env.payload.refId;
  const record: StoredApproval = {
    key: keyOf(scope, refId),
    scope,
    channel: env.channel,
    refId,
    env,
    ts: env.ts,
  };
  await withStore('approvals', 'readwrite', (s) => { s.put(record); });
}

/** All stored approval requests for this identity scope + channel, oldest first. */
export async function listApprovals(scope: string, channel: string): Promise<StoredApproval[]> {
  const all = await withStore<StoredApproval[]>('approvals', 'readonly', (s) => s.getAll() as IDBRequest<StoredApproval[]>);
  return all
    .filter((a) => a.scope === scope && a.channel === channel)
    .sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
}

/** Prune a settled approval (its response reached a terminal 'delivered'). */
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
