import { browserPushEnv } from './push-client.js';
import type { PushRegistrar } from '../transport/context.js';

/** VAPID registration over HTTP — for deployments whose transport does not
 *  carry push.subscribe envelopes (e.g. codecs that only encode messages
 *  and history). Subscribes the browser with the relay's VAPID public key
 *  and persists the subscription via POST subscribeUrl (Bearer auth). */
export function createHttpPushRegistrar(opts: {
  vapidPublicKey: string;
  subscribeUrl: string;
  getBearerToken(): Promise<string>;
}): PushRegistrar {
  return {
    async enable(): Promise<boolean> {
      // The whole flow is guarded, not just the fetch: pushManager.subscribe
      // (inside env.getSubscription) commonly rejects — invalid VAPID key,
      // an existing subscription with different applicationServerKey, no
      // active SW registration. enable() must resolve false, never reject.
      try {
        const env = browserPushEnv();
        if (!env) return false;
        let permission = env.permission();
        if (permission === 'denied') return false;
        if (permission === 'default') permission = await env.requestPermission();
        if (permission !== 'granted') return false;
        const subscription = await env.getSubscription(opts.vapidPublicKey);
        if (!subscription) return false;
        const token = await opts.getBearerToken();
        const res = await fetch(opts.subscribeUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ subscription }),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
    async disable(): Promise<void> {
      // Best-effort local teardown. This registrar has no defined server-side
      // unsubscribe endpoint (the host relay would need to add one and pass
      // its URL here, mirroring subscribeUrl); tearing down the browser-level
      // subscription still stops this device from receiving further pushes.
      const env = browserPushEnv();
      await env?.unsubscribeLocal().catch(() => { /* best-effort */ });
    },
  };
}
