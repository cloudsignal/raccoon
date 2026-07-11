import { z } from 'zod';
import { kvDeleteIf, kvGet, kvSet, kvUpdate } from './idb.js';

const sessionSchema = z.object({
  // #A3 (vendor-neutral): url + sessionToken are WS-transport auth fields. A
  // host-managed session (CloudSignal/MQTT authed out-of-band) has no use for
  // them — the provider in override mode reads neither (identityKey uses the
  // epoch, never the token; the transport is supplied, not dialed from url).
  // Optional so a host no longer has to pass placeholder ''/'gtm' values.
  url: z.string().min(1).optional(),
  sessionToken: z.string().min(1).optional(),
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
  // #R8-4: the lazy epoch migration is an ATOMIC get-or-set in one
  // transaction. Two tabs loading a pre-epoch session concurrently would, with
  // a plain read-then-write, each mint a DIFFERENT random epoch and race their
  // writes — leaving the two tabs with divergent identity keys and existing
  // outbox rows permanently unclaimable. kvUpdate serializes them so both
  // converge on the first-written epoch.
  const stored = await kvUpdate<unknown>(KEY, (current) => {
    const parsed = sessionSchema.safeParse(current);
    if (!parsed.success) return undefined;           // nothing/corrupt: don't write
    if (parsed.data.epoch !== undefined) return undefined; // already has one: leave unchanged
    return { ...parsed.data, epoch: crypto.randomUUID() };  // mint once
  });
  const parsed = sessionSchema.safeParse(stored);
  return parsed.success ? parsed.data : null;
}

export async function saveSession(s: Session): Promise<void> {
  // Ensure every persisted session carries a non-secret epoch.
  const withEpoch = s.epoch === undefined ? { ...s, epoch: crypto.randomUUID() } : s;
  await kvSet(KEY, sessionSchema.parse(withEpoch));
}

export async function clearSession(): Promise<void> {
  await kvDeleteIf(KEY, () => true);
}

/**
 * Clear the stored session ONLY if it still matches `expectedKey` (#R7-3),
 * as a SINGLE atomic compare-and-delete transaction (#R8-4). A tombstoned-load
 * path must not blindly clearSession(): if the user re-paired (saving a NEWER
 * session) between the wipe and this stale IDB read resolving, an
 * unconditional clear — or a read-then-delete across two transactions — would
 * delete that new session. `keyOf` derives the identity key to compare;
 * because the read and delete share one transaction, a concurrent
 * saveSession() cannot land between them. Returns whether it cleared.
 */
export async function clearSessionIfMatches(
  expectedKey: string,
  keyOf: (s: Session) => string,
): Promise<boolean> {
  return kvDeleteIf<unknown>(KEY, (raw) => {
    const parsed = sessionSchema.safeParse(raw);
    return parsed.success && keyOf(parsed.data) === expectedKey;
  });
}
