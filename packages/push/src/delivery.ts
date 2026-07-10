import type { PushPayload, PushSender, SubscriptionStore } from './types.js';
import { vendorOf } from './vendor.js';

/** Fan a payload out to every stored subscription matching the sender's
 *  vendor. Prunes dead endpoints (404/410). Push is best-effort: this
 *  never throws. Returns the number of successful sends.
 *
 *  #R6-6: `isStale` is the revocation fence. Delivery is fire-and-forget and
 *  outlives the synchronous hub call that starts it, so a clearForUser()
 *  (revoke) can complete WHILE this is mid-flight — between the store
 *  snapshot and a send, or between two sends. Checked before the snapshot
 *  and before EACH send, it aborts the rest the instant the user is revoked,
 *  so a just-revoked subscription never receives a message the fence should
 *  have stopped. The caller (withPushFallback) captures a per-user
 *  revocation generation at delivery start and reports here whether it has
 *  since advanced. */
export async function sendPushToUser(
  store: SubscriptionStore,
  sender: PushSender,
  userId: string,
  payload: PushPayload,
  isStale?: () => boolean,
): Promise<number> {
  let delivered = 0;
  try {
    if (isStale?.()) return 0;
    const subs = await store.list(userId);
    if (isStale?.()) return 0;
    await Promise.all(
      subs
        .filter((sub) => vendorOf(sub) === sender.vendor)
        .map(async (sub) => {
          if (isStale?.()) return;
          try {
            await sender.send(sub, payload);
            delivered += 1;
          } catch (err) {
            const code = (err as { statusCode?: number }).statusCode;
            if (code === 404 || code === 410) await store.remove(userId, sub.endpoint);
          }
        }),
    );
  } catch (err) {
    /* store failures must never crash the caller */
    console.warn('push delivery: subscription store failure', err);
  }
  return delivered;
}
