import type { AnyEnvelope } from '@raccoon/protocol';
import { promisifyRequest, withStore, withTransaction } from './idb.js';

export type OutboxStatus = 'pending' | 'sending' | 'failed';

export interface OutboxEntry {
  id: string;
  channel: string;
  env: AnyEnvelope;
  createdAt: string;
  attempts: number;
  status: OutboxStatus;
  lastError?: string;
}

export const MAX_ATTEMPTS = 5;

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

export async function enqueue(env: AnyEnvelope): Promise<OutboxEntry> {
  const entry: OutboxEntry = {
    id: env.id,
    channel: env.channel,
    env,
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

export async function listForChannel(channel: string): Promise<OutboxEntry[]> {
  const all = await getAll();
  return all.filter((e) => e.channel === channel).sort(byCreatedAt);
}

/** Shared get-then-put: reads the entry, computes the next version via
 *  `update`, and writes it back — all within one transaction. Returns the
 *  updated entry (so callers can inspect its resulting status, e.g.
 *  markSendFailed's terminal-vs-retry distinction, as well as notify() on its
 *  channel), or undefined if there was no entry to update (already cleared,
 *  e.g. by a concurrent wipe). */
async function mutate(id: string, update: (entry: OutboxEntry) => OutboxEntry): Promise<OutboxEntry | undefined> {
  return withTransaction('outbox', 'readwrite', async (s) => {
    const entry = await promisifyRequest(s.get(id) as IDBRequest<OutboxEntry | undefined>);
    if (!entry) return undefined;
    const next = update(entry);
    await promisifyRequest(s.put(next));
    return next;
  });
}

/** Returns true if a row was actually claimed (existed and was updated to
 *  'sending'), false if there was no row to claim (already cleared, e.g. by
 *  a concurrent wipe). Callers MUST check this before sending: a stale
 *  drain() snapshot entry whose row has since been cleared must never be
 *  sent through whatever transport/session happens to be active by the time
 *  the send is attempted (#R4-3) — the row being gone is the signal that it
 *  no longer belongs to the current identity. */
export async function markSending(id: string): Promise<boolean> {
  const entry = await mutate(id, (entry) => ({ ...entry, attempts: entry.attempts + 1, status: 'sending' }));
  if (entry) notify(entry.channel);
  return entry !== undefined;
}

/** Returns the entry's resulting status ('failed' once MAX_ATTEMPTS is
 *  reached, 'pending' if it will still be retried), or undefined if there
 *  was no entry to update. Callers use this to distinguish a terminal
 *  failure (UI should stop showing "pending" and offer retry) from a
 *  transient one that will be retried automatically. */
export async function markSendFailed(id: string, error: string): Promise<OutboxStatus | undefined> {
  const entry = await mutate(id, (entry) => ({
    ...entry,
    status: entry.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
    lastError: error,
  }));
  if (entry) notify(entry.channel);
  return entry?.status;
}

export async function markFailed(id: string, error: string): Promise<void> {
  const entry = await mutate(id, (entry) => ({ ...entry, status: 'failed', lastError: error }));
  if (entry) notify(entry.channel);
}

export async function retry(id: string): Promise<void> {
  const entry = await mutate(id, (entry) => ({ ...entry, status: 'pending', attempts: 0, lastError: undefined }));
  if (entry) notify(entry.channel);
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

/** Fires one subscriber notification per demoted entry — subscribers that
 *  trigger drains must tolerate bursts (the provider drains on status
 *  transitions, not per notification). All demotions happen within ONE
 *  transaction (see the module comment above). */
export async function demoteSending(): Promise<void> {
  const demoted = await withTransaction('outbox', 'readwrite', async (s) => {
    const all = await promisifyRequest(s.getAll() as IDBRequest<OutboxEntry[]>);
    const touched: string[] = [];
    for (const entry of all) {
      if (entry.status === 'sending') {
        await promisifyRequest(s.put({ ...entry, status: 'pending' }));
        touched.push(entry.channel);
      }
    }
    return touched;
  });
  for (const channel of demoted) notify(channel);
}

/** Clear the entire outbox, in one transaction — see the module comment. */
export async function clearAll(): Promise<void> {
  await withTransaction('outbox', 'readwrite', async (s) => {
    await promisifyRequest(s.clear());
  });
}
