import type { PushPayload, PushSender, SubscriptionStore } from './types.js';
import { vendorOf } from './vendor.js';

/** Fan a payload out to every stored subscription matching the sender's
 *  vendor. Prunes dead endpoints (404/410). Push is best-effort: this
 *  never throws. Returns the number of successful sends. */
export async function sendPushToUser(
  store: SubscriptionStore,
  sender: PushSender,
  userId: string,
  payload: PushPayload,
): Promise<number> {
  let delivered = 0;
  try {
    const subs = await store.list(userId);
    await Promise.all(
      subs
        .filter((sub) => vendorOf(sub) === sender.vendor)
        .map(async (sub) => {
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
