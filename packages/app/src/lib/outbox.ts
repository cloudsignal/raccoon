import type { AnyEnvelope } from '@raccoon/protocol';
import { promisifyRequest, withStore, withStores, withTransaction } from './idb.js';
import { keyOf as approvalKeyOf } from './approvals.js';

// 'processing' (#R6-2b): the server acked RECEIPT of this envelope but its
// turn's terminal outcome (success/failure) has not arrived yet. Durable and
// kept out of listPending() — it is neither retryable-yet nor safe to
// delete: deleting on mere receipt lost the retry path when the terminal ack
// was dropped (socket drop / reload / hung turn). recoverProcessing() re-drives
// these on boot/reconnect (dedup-safe: the bridge re-acks the real outcome).
// 'stalled' (#P1-A): the server started this envelope's turn but it exceeded
// the server deadline and is still running with an UNKNOWN outcome. TERMINAL
// and NON-retryable — unlike 'failed', retry() refuses to promote it (a retry
// could double side effects for a turn that may yet complete). Kept out of
// listPending() and recoverProcessing() so nothing auto-re-drives it.
export type OutboxStatus = 'pending' | 'sending' | 'processing' | 'failed' | 'stalled';

export interface OutboxEntry {
  id: string;
  channel: string;
  env: AnyEnvelope;
  /** Full identity scope this row was enqueued under (#R5-3/#R6-3):
   *  `<instanceUrl>::<user address>`. env.from alone is NOT enough — user
   *  ids are instance-local, so instance A's user:u1 and instance B's
   *  user:u1 are different people with identical from addresses. The claim
   *  CAS compares this persisted scope against the caller's current one.
   *  Rows from before this field existed have scope undefined and are never
   *  claimable; drain() purges them. */
  scope?: string;
  createdAt: string;
  attempts: number;
  status: OutboxStatus;
  lastError?: string;
  /** Set while status is 'sending' (#R4-4): which tab (see context.tsx's
   *  tabIdRef) currently owns this in-flight send, and until when its claim
   *  is valid. Lets demoteSending() distinguish "stranded by a crashed tab"
   *  (safe to requeue) from "actively being sent by a still-alive tab"
   *  (must not be touched) without any cross-tab coordination beyond the
   *  IndexedDB rows themselves. */
  ownerId?: string;
  leaseExpiresAt?: number;
  /** Set while status is 'sending' (#R5-5): a fresh unique token minted by
   *  the markSending() that claimed this row. markSendFailed/markFailed only
   *  apply when the caller presents the CURRENT token — so a stale owner's
   *  long-delayed ack-timeout or send rejection (e.g. a background-throttled
   *  tab waking up after its lease expired and the row was re-claimed)
   *  cannot flip a row that now belongs to a newer owner. Cleared on demote. */
  claimToken?: string;
}

export const MAX_ATTEMPTS = 5;
// Generous margin over the client's own ACK_TIMEOUT_MS (10s, context.tsx):
// a legitimately in-flight send resolves (settles or fails) well within
// this window on its OWNING tab. Only once a claim outlives it does another
// tab treat the row as abandoned. Exported so tests can advance exactly past
// it rather than hardcoding a duplicate magic number.
export const SEND_LEASE_MS = 20_000;

// #R6-5: every successful claim is broadcast (with its lease expiry) so
// every OTHER tab can schedule a recovery sweep for the moment the lease
// lapses. Boot-time and close-time sweeps can't cover a claim made AFTER
// they ran by a tab that then crashes — without this, such a row stayed
// 'sending' forever on any tab with a stable connection. Safe even for the
// poster's own rows: a legitimately in-flight send always settles (ack) or
// fails (ack timeout, 10s) well inside SEND_LEASE_MS, so a sweep at expiry
// only ever touches genuinely abandoned claims.
const claimChannel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('raccoon-outbox') : null;
// Node's BroadcastChannel would otherwise hold the process open; browser
// and jsdom implementations don't have unref.
(claimChannel as { unref?: () => void } | null)?.unref?.();

const listeners = new Set<(channel: string) => void>();

export function subscribe(listener: (channel: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(channel: string): void {
  for (const l of listeners) l(channel);
}

function getAll(): Promise<OutboxEntry[]> {
  return withStore<OutboxEntry[]>('outbox', 'readonly', (s) => s.getAll() as IDBRequest<OutboxEntry[]>);
}

// Every mutator below does its get-then-put (or get-then-delete, or
// scan-then-mutate-many) as ONE atomic IndexedDB transaction via
// withTransaction, instead of two or more separate transactions. That is what
// actually closes the resurrection race: IndexedDB serializes 'readwrite'
// transactions with overlapping store scopes, INCLUDING across different
// browser tabs sharing the same origin's database (it's a single shared
// storage engine, not a per-tab one) — so a clearAll() transaction and a
// markSending() transaction can each only run to completion in full, one
// after the other, with nothing able to land in between. A prior version of
// this file used a module-local Promise queue (`opChain`) for the same
// purpose; that only serialized calls WITHIN one tab's JS realm (module state
// is not shared across tabs even though the underlying IndexedDB is), so a
// second tab's writes could still interleave with the first's and resurrect a
// row after a wipe — reproduced 25/25 runs. Collapsing each operation into
// one transaction removes the "in between" for anything to land in, in any
// tab, with no in-memory coordination needed at all.

export async function enqueue(env: AnyEnvelope, scope: string): Promise<OutboxEntry> {
  const entry: OutboxEntry = {
    id: env.id,
    channel: env.channel,
    env,
    scope,
    createdAt: env.ts,
    attempts: 0,
    status: 'pending',
  };
  await withTransaction('outbox', 'readwrite', async (s) => {
    await promisifyRequest(s.put(entry));
  });
  notify(entry.channel);
  return entry;
}

/** Oldest-first by createdAt, with id (a ulid — lexicographically
 *  time-sortable) as an explicit tiebreaker for same-millisecond entries
 *  (createEnvelope's ts has millisecond resolution, so two envelopes built
 *  back-to-back can share one). `a.createdAt < b.createdAt ? -1 : 1` alone
 *  is not a valid comparator for equal timestamps — it returns 1, never 0,
 *  for a tie, violating Array.prototype.sort's comparator contract. Fixed
 *  defensively: no observable misordering was pinned down from this
 *  specifically (small-array V8 sort tolerated it in the cases tried), but
 *  the invalid contract is worth not relying on. */
function byCreatedAt(a: OutboxEntry, b: OutboxEntry): number {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export async function listPending(): Promise<OutboxEntry[]> {
  const all = await getAll();
  return all.filter((e) => e.status === 'pending').sort(byCreatedAt);
}

/** One entry by id, or undefined. Read-only. */
export async function getEntry(id: string): Promise<OutboxEntry | undefined> {
  return withStore<OutboxEntry | undefined>('outbox', 'readonly', (s) => s.get(id) as IDBRequest<OutboxEntry | undefined>);
}

/**
 * Rows for `channel`. When `scope` is given, only rows enqueued under THAT
 * identity (#R8-1): the outbox is a shared per-origin store, so an unscoped
 * read would surface another paired identity's rows and let a reconcile
 * attach a foreign response onto this identity's approval cards. Rows with no
 * scope (pre-#R5-3) match nothing when a scope filter is supplied.
 */
export async function listForChannel(channel: string, scope?: string): Promise<OutboxEntry[]> {
  const all = await getAll();
  return all
    .filter((e) => e.channel === channel && (scope === undefined || e.scope === scope))
    .sort(byCreatedAt);
}

/** Shared get-then-put: reads the entry, computes the next version via
 *  `update`, and writes it back — all within one transaction. `update` may
 *  return undefined to abort the write (a precondition wasn't met, e.g.
 *  markSending's pending-only compare-and-set) without touching the row.
 *  Returns the updated entry (so callers can inspect its resulting status,
 *  e.g. markSendFailed's terminal-vs-retry distinction, as well as notify()
 *  on its channel), or undefined if there was no entry to update (already
 *  cleared, e.g. by a concurrent wipe) or the precondition failed. */
async function mutate(
  id: string,
  update: (entry: OutboxEntry) => OutboxEntry | undefined,
): Promise<OutboxEntry | undefined> {
  return withTransaction('outbox', 'readwrite', async (s) => {
    const entry = await promisifyRequest(s.get(id) as IDBRequest<OutboxEntry | undefined>);
    if (!entry) return undefined;
    const next = update(entry);
    if (!next) return undefined;
    await promisifyRequest(s.put(next));
    return next;
  });
}

/**
 * Pending-only compare-and-set: claims the row for `ownerId` (this tab) ONLY
 * if its status is currently 'pending' AND its envelope was written under
 * the identity the caller is currently sending as (`expectedFrom`, an OAM
 * address like 'user:u1' — #R5-3: rows are shared per-origin across tabs,
 * and a stale tab still running a since-wiped identity can write rows a
 * newer tab's drain would otherwise pick up and transmit through the WRONG
 * user's session; the identity check inside the same atomic transaction as
 * the claim makes that impossible regardless of how the row got here).
 *
 * Returns a fresh unique claim token when the row was claimed, or null when
 * there was no row (already cleared, e.g. by a concurrent wipe — #R4-3), it
 * was already claimed ('sending' — #R4-4), or its identity didn't match
 * (#R5-3). Callers MUST hold a token before sending, and MUST present it to
 * markSendFailed/markFailed so a stale claim's delayed failure paths can't
 * touch a newer claim (#R5-5).
 */
export async function markSending(id: string, ownerId: string, expectedScope: string): Promise<string | null> {
  const claimToken = crypto.randomUUID();
  const entry = await mutate(id, (entry) => (
    entry.status === 'pending' && entry.scope === expectedScope
      ? { ...entry, attempts: entry.attempts + 1, status: 'sending', ownerId, claimToken, leaseExpiresAt: Date.now() + SEND_LEASE_MS }
      : undefined
  ));
  if (!entry) return null;
  notify(entry.channel);
  // #R6-5: let every other tab schedule a recovery sweep at this claim's
  // lease expiry, in case this tab crashes mid-send.
  claimChannel?.postMessage({ type: 'claimed', leaseExpiresAt: entry.leaseExpiresAt });
  return claimToken;
}

/** Returns the entry's resulting status ('failed' once MAX_ATTEMPTS is
 *  reached, 'pending' if it will still be retried), or undefined if there
 *  was no entry to update — or the caller's claim is stale (#R5-5: the row
 *  was demoted and possibly re-claimed since this caller's markSending();
 *  its delayed rejection must not demote the newer owner's in-flight send
 *  to 'pending', which would queue yet another transmission). Callers use
 *  the status to distinguish a terminal failure (UI should stop showing
 *  "pending" and offer retry) from a transient one retried automatically. */
export async function markSendFailed(id: string, error: string, claimToken: string): Promise<OutboxStatus | undefined> {
  const entry = await mutate(id, (entry) => (
    entry.claimToken === claimToken
      ? {
          ...entry,
          status: entry.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
          lastError: error,
          ownerId: undefined,
          claimToken: undefined,
          leaseExpiresAt: undefined,
        }
      : undefined
  ));
  if (entry) notify(entry.channel);
  return entry?.status;
}

/** Claim-scoped like markSendFailed (#R5-5): a stale owner's long-delayed
 *  ack-timeout must not flip a row a newer owner is actively sending to
 *  'failed'. No-ops unless the presented token is the row's current claim. */
/** Returns whether the write actually applied (#R6-7): a stale claim's
 *  timeout must not drive UI state (or anything else) off a no-op. */
export async function markFailed(id: string, error: string, claimToken: string): Promise<boolean> {
  const entry = await mutate(id, (entry) => (
    entry.claimToken === claimToken
      ? { ...entry, status: 'failed', lastError: error, ownerId: undefined, claimToken: undefined, leaseExpiresAt: undefined }
      : undefined
  ));
  if (entry) notify(entry.channel);
  return entry !== undefined;
}

/** Revive a TERMINALLY FAILED row for another attempt. Failed-only CAS
 *  (#R6-7): an unconditional reset could yank a row another tab is actively
 *  sending ('sending', live claim) back to 'pending', queueing a duplicate
 *  transmission. Returns whether it applied. */
export async function retry(id: string): Promise<boolean> {
  const entry = await mutate(id, (entry) => (
    entry.status === 'failed'
      ? { ...entry, status: 'pending', attempts: 0, lastError: undefined }
      : undefined
  ));
  if (entry) notify(entry.channel);
  return entry !== undefined;
}

export async function settle(id: string): Promise<void> {
  const channel = await withTransaction('outbox', 'readwrite', async (s) => {
    const entry = await promisifyRequest(s.get(id) as IDBRequest<OutboxEntry | undefined>);
    if (!entry) return undefined;
    await promisifyRequest(s.delete(id));
    return entry.channel;
  });
  if (channel) notify(channel);
}

/**
 * Settle an approval RESPONSE row AND prune its durable approval REQUEST in ONE
 * atomic transaction across the outbox + approvals stores (#P1-E2). The prior
 * code did getEntry (tx1) → deleteApproval (tx2) → settle (tx3); a crash
 * between the approval delete and the response settle could leave an
 * unanswered approval REQUEST with no response record, so a reload re-rendered
 * the card as un-answered and accepted a competing response. Both deletes now
 * commit together or not at all. For a plain msg row (or a legacy scope-less
 * row) it just deletes the outbox row. Returns the channel to notify.
 */
export async function settleResponseAndPruneApproval(id: string): Promise<void> {
  const channel = await withStores(['outbox', 'approvals'], 'readwrite', async (tx) => {
    const outboxStore = tx.objectStore('outbox');
    const entry = await promisifyRequest(outboxStore.get(id) as IDBRequest<OutboxEntry | undefined>);
    if (!entry) return undefined;
    if (entry.env.kind === 'approval.response' && entry.scope) {
      const approvalRefId = (entry.env as AnyEnvelope & { kind: 'approval.response' }).payload.refId;
      await promisifyRequest(tx.objectStore('approvals').delete(approvalKeyOf(entry.scope, approvalRefId)));
    }
    await promisifyRequest(outboxStore.delete(id));
    return entry.channel;
  });
  if (channel) notify(channel);
}

/**
 * Handle a server 'received' ack (#R6-2b). 'received' means the SERVER got
 * the envelope — terminal for a plain msg (its reply arrives as a separate
 * envelope; there is no post-receipt failure), so that settles. For an
 * approval.response the turn can still succeed OR fail after receipt, and
 * that terminal ack can be lost (socket drop / reload / hung turn) — so keep
 * the row in a durable 'processing' state until a terminal ack ('delivered'
 * or 'failed') arrives, rather than deleting it and losing the retry path.
 * Authoritative (server-driven), so not claim-token gated; clears the
 * send-claim bookkeeping either way.
 */
export async function acknowledgeReceipt(id: string): Promise<{ channel: string; processing: boolean } | undefined> {
  const result = await withTransaction('outbox', 'readwrite', async (s) => {
    const entry = await promisifyRequest(s.get(id) as IDBRequest<OutboxEntry | undefined>);
    if (!entry) return undefined;
    // #R7-2/#P1-A: a 'failed' OR 'stalled' row is TERMINAL. A delayed/duplicate
    // 'received' ack must NOT regress it back to 'processing' — that would
    // silently un-fail a row showing a retry affordance (failed), or re-open a
    // stalled/unknown-outcome turn to the auto-retry timer (stalled). Leave it.
    if (entry.status === 'failed' || entry.status === 'stalled') return undefined;
    if (entry.env.kind === 'approval.response') {
      await promisifyRequest(s.put({ ...entry, status: 'processing', ownerId: undefined, claimToken: undefined, leaseExpiresAt: undefined }));
      return { channel: entry.channel, processing: true };
    }
    await promisifyRequest(s.delete(id)); // msg: receipt is terminal
    return { channel: entry.channel, processing: false };
  });
  if (result) notify(result.channel);
  return result;
}

/** Transition a row that is stuck in 'processing' to terminal 'failed'
 *  (#R7-1b). Processing-only CAS: the client arms a timeout when a row enters
 *  'processing' (server acked receipt) and calls this if no terminal ack
 *  arrives — a never-settling server turn otherwise leaves the client spinning
 *  in 'processing' forever on a stable connection (recovery else only runs on
 *  reconnect). Leaves a retryable 'failed' row. No-ops if the row already
 *  settled (delivered→deleted, or already failed). Returns whether it applied. */
export async function failProcessing(id: string): Promise<boolean> {
  const entry = await mutate(id, (entry) => (
    entry.status === 'processing'
      ? { ...entry, status: 'failed', ownerId: undefined, claimToken: undefined, leaseExpiresAt: undefined }
      : undefined
  ));
  if (entry) notify(entry.channel);
  return entry !== undefined;
}

/** Mark a row terminally failed on a server 'failed' ack (#R6-2/#R6-2b).
 *  Authoritative (the server says the turn failed for this envelope), so —
 *  unlike markFailed's local ack-timeout path (#R6-7) — it is NOT claim-token
 *  gated: it applies regardless of which tab currently owns the row. Leaves a
 *  retryable 'failed' row (see retry()). */
export async function failByServer(id: string): Promise<void> {
  const entry = await mutate(id, (entry) => (
    { ...entry, status: 'failed', ownerId: undefined, claimToken: undefined, leaseExpiresAt: undefined }
  ));
  if (entry) notify(entry.channel);
}

/** Mark a row terminal 'stalled' on a server 'stalled' ack (#P1-A). The turn
 *  exceeded the server deadline and is still running with an UNKNOWN outcome.
 *  Authoritative (server-driven), so not claim-token gated. Unlike failByServer
 *  the resulting row is NON-retryable (retry() only promotes 'failed'), so the
 *  UI shows "still working" and never a one-tap retry that could double side
 *  effects. */
export async function markStalled(id: string): Promise<void> {
  const entry = await mutate(id, (entry) => (
    // Don't clobber an already-terminal-success row (a 'delivered' settle
    // deletes it, so this only ever sees processing/sending here).
    { ...entry, status: 'stalled', ownerId: undefined, claimToken: undefined, leaseExpiresAt: undefined }
  ));
  if (entry) notify(entry.channel);
}

/**
 * Re-drive rows stuck in 'processing' by moving them back to 'pending'
 * (#R6-2b). Called on boot and on reconnect: a terminal ack lost to a socket
 * drop or reload otherwise leaves the row in 'processing' forever. Re-sending
 * the SAME envelope is dedup-safe — the bridge re-acks the real outcome
 * ('delivered' if it already succeeded, or re-runs if it had failed and was
 * forgotten).
 *
 * #R7-3: SCOPED to `scope` — only this identity's rows. The outbox is shared
 * per-origin across tabs/identities; a global re-drive would resurrect a
 * DIFFERENT identity's processing row into this session's drain. A caller
 * with no identity (scope null) recovers nothing.
 */
export async function recoverProcessing(scope: string | null): Promise<void> {
  if (!scope) return;
  const touched = await withTransaction('outbox', 'readwrite', async (s) => {
    const all = await promisifyRequest(s.getAll() as IDBRequest<OutboxEntry[]>);
    const channels: string[] = [];
    for (const entry of all) {
      if (entry.status !== 'processing' || entry.scope !== scope) continue;
      await promisifyRequest(s.put({ ...entry, status: 'pending' }));
      channels.push(entry.channel);
    }
    return channels;
  });
  for (const c of touched) notify(c);
}

/**
 * CLOSE-TIME reclaim (#R6-5b): requeue every 'sending' row THIS tab
 * (`myTabId`) owns, unconditionally — its transport just closed, so this tab
 * knows it cannot finish those sends and they must go back to 'pending' for
 * a reconnect drain. Owner-scoped and lease-INDEPENDENT: it only ever
 * touches rows this tab currently owns, never another tab's, and never a row
 * this tab does not own even if that row's lease looks expired (that is the
 * expiry sweep's job, below).
 *
 * This is deliberately SEPARATE from recoverExpiredSending(): conflating the
 * two (the old demoteSending) let a stale expiry-sweep timer, calling with
 * this tab's id, unconditionally reclaim a NEWER live claim this tab had made
 * since — requeuing and thus duplicating an active send.
 */
export async function releaseOwnedSending(myTabId: string): Promise<void> {
  const touched = await withTransaction('outbox', 'readwrite', async (s) => {
    const all = await promisifyRequest(s.getAll() as IDBRequest<OutboxEntry[]>);
    const channels: string[] = [];
    for (const entry of all) {
      if (entry.status !== 'sending' || entry.ownerId !== myTabId) continue;
      await promisifyRequest(s.put({ ...entry, status: 'pending', ownerId: undefined, claimToken: undefined, leaseExpiresAt: undefined }));
      channels.push(entry.channel);
    }
    return channels;
  });
  for (const c of touched) notify(c);
}

/**
 * EXPIRY-ONLY recovery (#R6-5b): requeue 'sending' rows whose lease has
 * actually EXPIRED (a crashed tab's abandoned claim, or a legacy row with no
 * lease). Honors EVERY row's lease regardless of owner — including this
 * tab's own live claims (fresh lease → skipped), so a stale scheduled timer
 * firing late can never reclaim an active send. Used by boot, the scheduled
 * lease-expiry sweep, and the coarse periodic safety sweep.
 *
 * Returns the EARLIEST still-valid (unexpired) leaseExpiresAt it skipped, or
 * null if it skipped nothing (#R5-4) — the caller schedules a re-check just
 * past that instant, since a row stranded by a crash may still have an
 * unexpired lease at the moment of this sweep and nothing else would revisit
 * it on a stable connection.
 */
export async function recoverExpiredSending(): Promise<number | null> {
  const { touched, nextExpiry } = await withTransaction('outbox', 'readwrite', async (s) => {
    const all = await promisifyRequest(s.getAll() as IDBRequest<OutboxEntry[]>);
    const result = { touched: [] as string[], nextExpiry: null as number | null };
    const now = Date.now();
    for (const entry of all) {
      if (entry.status !== 'sending') continue;
      const leaseExpired = entry.leaseExpiresAt === undefined || entry.leaseExpiresAt <= now;
      if (!leaseExpired) {
        // Still validly in flight (this tab's live claim, or another tab's) —
        // honor the lease and record when it lapses so the caller can look again.
        if (result.nextExpiry === null || entry.leaseExpiresAt! < result.nextExpiry) {
          result.nextExpiry = entry.leaseExpiresAt!;
        }
        continue;
      }
      await promisifyRequest(s.put({ ...entry, status: 'pending', ownerId: undefined, claimToken: undefined, leaseExpiresAt: undefined }));
      result.touched.push(entry.channel);
    }
    return result;
  });
  for (const channel of touched) notify(channel);
  return nextExpiry;
}

/** Clear the entire outbox, in one transaction — see the module comment. */
export async function clearAll(): Promise<void> {
  await withTransaction('outbox', 'readwrite', async (s) => {
    await promisifyRequest(s.clear());
  });
}

/**
 * Clear ONLY the rows for one identity `scope`, in one transaction (#R7-3).
 * A wipe/unpair must not use the global clearAll(): the outbox is shared
 * per-origin, so clearing everything destroys a DIFFERENT identity's queued
 * rows (e.g. another tab logged in as someone else). Legacy rows with no
 * scope are treated as belonging to no current identity and left alone.
 * Same single-transaction serialization guarantee as clearAll (see the
 * module comment) so it can't interleave with a concurrent mutator.
 */
export async function clearScope(scope: string): Promise<void> {
  const touched = await withTransaction('outbox', 'readwrite', async (s) => {
    const all = await promisifyRequest(s.getAll() as IDBRequest<OutboxEntry[]>);
    const channels: string[] = [];
    for (const entry of all) {
      if (entry.scope !== scope) continue;
      await promisifyRequest(s.delete(entry.id));
      channels.push(entry.channel);
    }
    return channels;
  });
  for (const c of touched) notify(c);
}
