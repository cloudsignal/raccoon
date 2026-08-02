import { z } from 'zod';
import { kvGet, kvSet, kvUpdate } from './idb.js';

export const sessionSchema = z.object({
  // #A3 (vendor-neutral): url + sessionToken are WS-transport auth fields. A
  // host-managed session (authed out-of-band) has no use for them — the
  // provider in override mode reads neither (identityKey uses the epoch, never
  // the token; the transport is supplied, not dialed from url). Optional so a
  // host no longer has to pass placeholder ''/dummy values.
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
  // session share it. Optional in the schema for backward-compat with legacy
  // sessions saved before this field; the adoption migration mints one.
  epoch: z.string().optional(),
});

export type Session = z.infer<typeof sessionSchema>;

// The legacy `session` kv singleton is read only by the one-time adoption
// migration (lib/adopt.ts). The old loadSession/saveSession/clearSession
// helpers are gone — the pairings list below is the durable store now.

// SCHEMA-EVOLUTION RULE: the stored pairings list is parsed all-or-nothing at
// boot (loadPairingsRaw — one entry failing the parse makes the WHOLE list
// read as absent, []). Any FUTURE field added to this schema MUST therefore
// be optional (or ship with a versioned migration): a new required field
// would fail the parse for every list persisted before the change and
// silently unpair every existing install.
export const pairedSessionSchema = sessionSchema.extend({
  /** Local, stable scope key for ALL of this pairing's app-side state
   *  (chat-state ConvKeys, `lastread:` kv keys, outbox row scope, approvals
   *  keys, cross-tab wipe broadcasts). A ULID minted at scan/adoption time —
   *  deliberately NOT the instance url (two pairings may share a url as
   *  different users) and NOT the userId (one user may exist on two
   *  instances). Never sent on the wire. */
  pairingId: z.string().min(1),
  /** Which transport factory dials this pairing — the QR payload's `transport`
   *  field, recorded at scan time ('ws' built-in; other kinds are supplied by
   *  the embedding host via the provider's `transports` registry prop). */
  transportKind: z.string().min(1),
  // epoch is REQUIRED for stored pairings (minted at scan/adoption): the
  // stale-wipe guard (#R6-8b) compares it, and removePairingIfMatches gates
  // on it so a delayed unpair cannot remove a since-refreshed pairing.
  epoch: z.string().min(1),
  /** Local display overrides — defaulted in the UI to `instance` and
   *  accentColor(pairingId); never sent anywhere. */
  displayName: z.string().min(1).optional(),
  color: z.string().min(1).optional(),
  /** Local icon override — a marker id ('bot' | 'server' | 'home' |
   *  'sparkle'); kept as an open string so the marker set can grow without a
   *  schema change. Same never-sent-anywhere local override as displayName. */
  icon: z.string().min(1).optional(),
});
export type PairedSession = z.infer<typeof pairedSessionSchema>;

export const PAIRINGS_KEY = 'pairings';
const pairingsListSchema = z.array(pairedSessionSchema);

/**
 * The legacy full-identity key (#R6-3b/#R7-3), moved here from context.tsx so
 * the adoption migration and the provider share ONE implementation. For a
 * host-embedded session this string IS the pairingId (see context.tsx), which
 * keeps a host install's existing outbox/approvals rows claimable with no
 * migration: the scope bytes in IDB do not change.
 */
export function hostIdentityKey(s: { instance: string; userId: string; epoch: string }): string {
  return JSON.stringify({ i: s.instance, u: s.userId, e: s.epoch });
}

/** Read the stored pairings list. Returns [] when absent/corrupt. Does NOT
 *  run the legacy-session adoption — use loadPairings() (adopt.ts) at boot. */
export async function loadPairingsRaw(): Promise<PairedSession[]> {
  const parsed = pairingsListSchema.safeParse(await kvGet(PAIRINGS_KEY));
  return parsed.success ? parsed.data : [];
}

export async function savePairings(list: PairedSession[]): Promise<void> {
  await kvSet(PAIRINGS_KEY, pairingsListSchema.parse(list));
}

/**
 * Append a pairing, or — duplicate guard — refresh in place when an entry for
 * the same (url, userId) already exists: same instance re-scanned as the same
 * user. The refresh keeps the existing pairingId (all scoped state stays
 * attached), displayName and color (local user choices), and takes the fresh
 * sessionToken/channels/vapidPublicKey/epoch. Atomic via kvUpdate so two tabs
 * pairing concurrently cannot drop each other's entry.
 */
export async function upsertPairing(p: PairedSession): Promise<PairedSession> {
  let stored: PairedSession = p;
  await kvUpdate<unknown>(PAIRINGS_KEY, (current) => {
    const list = pairingsListSchema.safeParse(current).success
      ? pairingsListSchema.parse(current)
      : [];
    const i = list.findIndex((e) => e.url === p.url && e.userId === p.userId);
    if (i === -1) return [...list, p];
    const prior = list[i]!;
    stored = {
      ...p,
      pairingId: prior.pairingId,
      ...(prior.displayName !== undefined ? { displayName: prior.displayName } : {}),
      ...(prior.color !== undefined ? { color: prior.color } : {}),
    };
    const next = [...list];
    next[i] = stored;
    return next;
  });
  return stored;
}

/** Atomic compare-and-remove (#R7-3/#R8-4): a
 *  delayed unpair/wipe must not remove a pairing that was since refreshed
 *  (new epoch). Returns whether it removed. */
export async function removePairingIfMatches(pairingId: string, expectedEpoch: string): Promise<boolean> {
  let removed = false;
  await kvUpdate<unknown>(PAIRINGS_KEY, (current) => {
    const parsed = pairingsListSchema.safeParse(current);
    if (!parsed.success) return undefined;
    const next = parsed.data.filter((e) => !(e.pairingId === pairingId && e.epoch === expectedEpoch));
    removed = next.length !== parsed.data.length;
    return removed ? next : undefined;
  });
  return removed;
}

/**
 * Atomic compare-and-update of a pairing's grant (channels + vapidPublicKey),
 * epoch-gated like removePairingIfMatches: a delayed grant update from a
 * previous session generation must not clobber a since-refreshed pairing.
 * Returns the updated entry, or null (NO write) when no entry matches
 * (pairingId, expectedEpoch) — the caller is stale. Omitting vapidPublicKey
 * leaves the stored value untouched.
 */
export async function updatePairingGrant(
  pairingId: string,
  expectedEpoch: string,
  grant: { channels: string[]; vapidPublicKey?: string },
): Promise<PairedSession | null> {
  let updated: PairedSession | null = null;
  await kvUpdate<unknown>(PAIRINGS_KEY, (current) => {
    const parsed = pairingsListSchema.safeParse(current);
    if (!parsed.success) return undefined;
    const next = parsed.data.map((e) => {
      if (e.pairingId !== pairingId || e.epoch !== expectedEpoch) return e;
      updated = {
        ...e,
        channels: [...grant.channels],
        ...(grant.vapidPublicKey !== undefined ? { vapidPublicKey: grant.vapidPublicKey } : {}),
      };
      return updated;
    });
    if (updated === null) return undefined;
    // Belt-and-braces: never persist a list the schema rejects. A bad grant
    // must fail this one call, not brick every stored pairing.
    const validated = pairingsListSchema.safeParse(next);
    if (!validated.success) {
      updated = null;
      return undefined;
    }
    return next;
  });
  return updated;
}

export async function updatePairingMeta(
  pairingId: string,
  patch: { displayName?: string; color?: string; icon?: string },
): Promise<PairedSession[]> {
  let result: PairedSession[] = [];
  await kvUpdate<unknown>(PAIRINGS_KEY, (current) => {
    const parsed = pairingsListSchema.safeParse(current);
    if (!parsed.success) return undefined;
    result = parsed.data.map((e) => {
      if (e.pairingId !== pairingId) return e;
      const next = { ...e };
      // An empty/whitespace-only value means "clear the local override" (fall
      // back to the UI default), NOT "store an empty string" — '' type-checks
      // but fails the schema's min(1), and an invalid entry would make the
      // all-or-nothing list parse in loadPairingsRaw() drop the WHOLE store.
      for (const field of ['displayName', 'color', 'icon'] as const) {
        if (!(field in patch)) continue;
        const value = patch[field];
        if (value === undefined || value.trim() === '') delete next[field];
        else next[field] = value;
      }
      return next;
    });
    // Belt-and-braces: never persist a list the schema rejects. A bad patch
    // must fail this one call, not brick every stored pairing.
    const validated = pairingsListSchema.safeParse(result);
    if (!validated.success) {
      result = parsed.data;
      return undefined;
    }
    return result;
  });
  return result;
}
