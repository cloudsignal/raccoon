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
            // #R7-4: a 410/404 prune must remove ONLY the exact subscription
            // that just failed. Between the snapshot and this catch the user
            // may have re-subscribed the SAME endpoint with fresh keys (the
            // push service can reissue an endpoint); a blanket
            // remove(endpoint) would delete that NEW, valid registration on
            // the strength of the OLD one's 410. Re-read and remove only if
            // the currently-stored sub for this endpoint is byte-identical to
            // the one we sent.
            if (code === 404 || code === 410) {
              try {
                const current = (await store.list(userId)).find((s) => s.endpoint === sub.endpoint);
                if (current && JSON.stringify(current) === JSON.stringify(sub)) {
                  await store.remove(userId, sub.endpoint);
                }
              } catch { /* store failure: skip the prune (best-effort) */ }
            }
          }
        }),
    );
  } catch (err) {
    /* store failures must never crash the caller */
    console.warn('push delivery: subscription store failure', err);
  }
  return delivered;
}
