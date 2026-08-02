import { z } from 'zod';
import { ulid } from 'ulid';
import { accentColor, nextAccentColor } from './conv-key.js';
import { promisifyRequest, withStores } from './idb.js';
import {
  PAIRINGS_KEY, hostIdentityKey, pairedSessionSchema, sessionSchema,
  type PairedSession,
} from './session.js';
import type { OutboxEntry } from './outbox.js';
import type { StoredApproval } from './approvals.js';

const pairingsListSchema = z.array(pairedSessionSchema);
const LEGACY_SESSION_KEY = 'session';

/**
 * Boot entry point: the stored pairings list, running the ONE-TIME adoption of
 * a pre-multi-pairing single session first when needed.
 *
 * Adoption turns the legacy `session` kv singleton into pairing #1: a
 * pairingId is minted and every piece of that identity's scoped state is
 * rewritten under it once — `lastread:${channel}` kv keys become
 * `lastread:${pairingId}/${channel}`, outbox rows' scope and approvals keys
 * move from the legacy identity-key JSON to the pairingId. Nothing
 * user-visible resets: read markers, queued sends, and approval cards all
 * survive.
 *
 * Runs as ONE atomic transaction across kv+outbox+approvals (withStores), so:
 *  - two tabs booting concurrently serialize — the second sees the pairings
 *    list already present and adopts nothing (idempotent);
 *  - a crash mid-migration rolls back wholesale — never a half-rewritten
 *    store.
 *
 * A legacy session WITHOUT a persisted epoch mints one; its outbox/approvals
 * rows (scoped under an older token-derived key) are left in place,
 * unclaimable — the #P1-F1 precedent: same identity so no leak, and no
 * released version wrote that format.
 */
export async function loadPairings(): Promise<PairedSession[]> {
  return withStores(['kv', 'outbox', 'approvals'], 'readwrite', async (tx) => {
    const kv = tx.objectStore('kv');
    const existing = pairingsListSchema.safeParse(await promisifyRequest(kv.get(PAIRINGS_KEY)));
    if (existing.success) return existing.data;

    const legacy = sessionSchema.safeParse(await promisifyRequest(kv.get(LEGACY_SESSION_KEY)));
    if (!legacy.success) return []; // fresh install — nothing stored at all

    const pairingId = ulid();
    const epoch = legacy.data.epoch ?? crypto.randomUUID();
    const adopted: PairedSession = {
      ...legacy.data, epoch, pairingId, transportKind: 'ws',
      // First-unused-hue policy: the adopted session is pairing #1, so it gets
      // Blue. The hash fallback is unreachable here (empty list) but keeps the
      // assignment shape identical to the pairWithPayload site.
      color: nextAccentColor([]) || accentColor(pairingId),
    };

    // 1. lastread:<channel>  ->  lastread:<pairingId>/<channel>
    const keys = await promisifyRequest(kv.getAllKeys());
    for (const key of keys) {
      if (typeof key !== 'string' || !key.startsWith('lastread:')) continue;
      const channel = key.slice('lastread:'.length);
      const value = await promisifyRequest(kv.get(key));
      await promisifyRequest(kv.put(value, `lastread:${pairingId}/${channel}`));
      await promisifyRequest(kv.delete(key));
    }

    // 2+3. Rescope outbox rows and approvals recorded under the legacy
    // identity key. Only possible when the legacy session HAD a persisted
    // epoch — that epoch is part of the scope bytes we must match.
    if (legacy.data.epoch !== undefined) {
      const legacyScope = hostIdentityKey({
        instance: legacy.data.instance, userId: legacy.data.userId, epoch: legacy.data.epoch,
      });
      const ob = tx.objectStore('outbox');
      const rows = await promisifyRequest(ob.getAll() as IDBRequest<OutboxEntry[]>);
      for (const row of rows) {
        if (row.scope === legacyScope) await promisifyRequest(ob.put({ ...row, scope: pairingId }));
      }
      const ap = tx.objectStore('approvals');
      const approvals = await promisifyRequest(ap.getAll() as IDBRequest<StoredApproval[]>);
      for (const a of approvals) {
        if (a.scope !== legacyScope) continue;
        await promisifyRequest(ap.delete(a.key));
        await promisifyRequest(ap.put({ ...a, scope: pairingId, key: `${pairingId}::${a.refId}` }));
      }
    }

    await promisifyRequest(kv.put([adopted], PAIRINGS_KEY));
    await promisifyRequest(kv.delete(LEGACY_SESSION_KEY));
    return [adopted];
  });
}
