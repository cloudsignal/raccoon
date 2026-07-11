import { z } from 'zod';
import { kvDel, kvGet, kvSet } from './idb.js';

const sessionSchema = z.object({
  url: z.string().min(1),
  sessionToken: z.string().min(1),
  userId: z.string().min(1),
  instance: z.string().min(1),
  channels: z.array(z.string()),
  vapidPublicKey: z.string().optional(),
  // #R7-3: a NON-SECRET, client-minted session epoch. It is what the identity
  // key and the cross-tab wipe broadcasts are built from — NOT sessionToken,
  // which is a secret credential and (for host-managed sessions) may be a
  // STABLE token that can't distinguish a re-pair. A fresh pairing mints a new
  // epoch; reload/resume reuse the persisted one, so all tabs on the same
  // session share it. Optional in the schema for backward-compat with sessions
  // saved before this field; loadSession lazily mints + persists one.
  epoch: z.string().optional(),
});

export type Session = z.infer<typeof sessionSchema>;

const KEY = 'session';

export async function loadSession(): Promise<Session | null> {
  const raw = await kvGet<unknown>(KEY);
  const parsed = sessionSchema.safeParse(raw);
  if (!parsed.success) return null;
  // Lazy migration: a session persisted before `epoch` existed gets one minted
  // and written back, so it has a stable non-secret epoch from here on.
  if (parsed.data.epoch === undefined) {
    const migrated = { ...parsed.data, epoch: crypto.randomUUID() };
    await kvSet(KEY, migrated);
    return migrated;
  }
  return parsed.data;
}

export async function saveSession(s: Session): Promise<void> {
  // Ensure every persisted session carries a non-secret epoch.
  const withEpoch = s.epoch === undefined ? { ...s, epoch: crypto.randomUUID() } : s;
  await kvSet(KEY, sessionSchema.parse(withEpoch));
}

export async function clearSession(): Promise<void> {
  await kvDel(KEY);
}

/**
 * Clear the stored session ONLY if it still matches `expectedKey` (#R7-3).
 * A tombstoned-load path must not blindly clearSession(): if the user
 * re-paired (saving a NEWER session) between the wipe and this stale IDB
 * read resolving, an unconditional clear would delete that new session.
 * `keyOf` derives the identity key to compare. Returns whether it cleared.
 */
export async function clearSessionIfMatches(
  expectedKey: string,
  keyOf: (s: Session) => string,
): Promise<boolean> {
  return withKvSessionLock(async () => {
    const raw = await kvGet<unknown>(KEY);
    const parsed = sessionSchema.safeParse(raw);
    if (!parsed.success) return false;
    if (keyOf(parsed.data) !== expectedKey) return false; // a newer session was saved — keep it
    await kvDel(KEY);
    return true;
  });
}

// The kv store has no transactions across get+del here; this module-local
// promise chain serializes clearSessionIfMatches against itself so a
// concurrent re-pair's save (also going through saveSession) is at least not
// racing two compare-and-clears. saveSession/loadSession are single kv ops.
let kvSessionChain: Promise<unknown> = Promise.resolve();
function withKvSessionLock<T>(op: () => Promise<T>): Promise<T> {
  const next = kvSessionChain.then(op, op);
  kvSessionChain = next.catch(() => {});
  return next;
}
