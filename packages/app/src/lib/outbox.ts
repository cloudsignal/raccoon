import type { AnyEnvelope } from '@raccoon/protocol';
import { withStore } from './idb.js';

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

/** Mutations are get-then-put across two transactions — callers must not
 *  overlap mutations of the same entry (the provider drains sequentially).
 *  Overlapping writers would be last-writer-wins. */
function getOne(id: string): Promise<OutboxEntry | undefined> {
  return withStore<OutboxEntry | undefined>('outbox', 'readonly', (s) => s.get(id) as IDBRequest<OutboxEntry | undefined>);
}

async function put(entry: OutboxEntry): Promise<void> {
  await withStore('outbox', 'readwrite', (s) => { s.put(entry); });
  notify(entry.channel);
}

export async function enqueue(env: AnyEnvelope): Promise<OutboxEntry> {
  const entry: OutboxEntry = {
    id: env.id,
    channel: env.channel,
    env,
    createdAt: env.ts,
    attempts: 0,
    status: 'pending',
  };
  await put(entry);
  return entry;
}

export async function listPending(): Promise<OutboxEntry[]> {
  const all = await getAll();
  return all.filter((e) => e.status === 'pending').sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export async function listForChannel(channel: string): Promise<OutboxEntry[]> {
  const all = await getAll();
  return all.filter((e) => e.channel === channel).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
}

export async function markSending(id: string): Promise<void> {
  const entry = await getOne(id);
  if (!entry) return;
  await put({ ...entry, attempts: entry.attempts + 1, status: 'sending' });
}

export async function markSendFailed(id: string, error: string): Promise<void> {
  const entry = await getOne(id);
  if (!entry) return;
  const status: OutboxStatus = entry.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
  await put({ ...entry, status, lastError: error });
}

export async function markFailed(id: string, error: string): Promise<void> {
  const entry = await getOne(id);
  if (!entry) return;
  await put({ ...entry, status: 'failed', lastError: error });
}

export async function retry(id: string): Promise<void> {
  const entry = await getOne(id);
  if (!entry) return;
  await put({ ...entry, status: 'pending', attempts: 0, lastError: undefined });
}

export async function settle(id: string): Promise<void> {
  const entry = await getOne(id);
  if (!entry) return;
  await withStore('outbox', 'readwrite', (s) => { s.delete(id); });
  notify(entry.channel);
}

/** Fires one subscriber notification per demoted entry — subscribers that
 *  trigger drains must tolerate bursts (the provider drains on status
 *  transitions, not per notification). */
export async function demoteSending(): Promise<void> {
  const all = await getAll();
  for (const entry of all) {
    if (entry.status === 'sending') await put({ ...entry, status: 'pending' });
  }
}
