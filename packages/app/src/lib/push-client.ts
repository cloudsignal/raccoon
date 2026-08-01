import { createEnvelope, userAddress, type AnyEnvelope } from '@raccoon/protocol';

export function urlBase64ToUint8Array(base64: string): Uint8Array {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4);
  const normalized = (base64 + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(normalized);
  return Uint8Array.from(raw, (ch) => ch.charCodeAt(0));
}

export interface PushEnv {
  permission(): NotificationPermission;
  requestPermission(): Promise<NotificationPermission>;
  getSubscription(vapidPublicKey: string): Promise<{ endpoint: string; keys: { p256dh: string; auth: string } } | null>;
  /** Read-only: the endpoint of the CURRENT browser-level subscription, if
   *  any. Unlike getSubscription() above, this never creates one. */
  currentEndpoint(): Promise<string | null>;
  /** Tear down the browser-level push subscription, if one exists. */
  unsubscribeLocal(): Promise<void>;
}

// Test seam: browserPushEnv() feature-detects real browser APIs, which test
// environments (jsdom) cannot supply. Mirrors idb's __setBlockedTimeoutMsForTests.
let envOverride: PushEnv | null = null;
export function __setPushEnvForTests(env: PushEnv | null): void { envOverride = env; }

export function browserPushEnv(): PushEnv | null {
  if (envOverride) return envOverride;
  if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  return {
    permission: () => Notification.permission,
    requestPermission: () => Notification.requestPermission(),
    async getSubscription(vapidPublicKey: string) {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(vapidPublicKey).buffer as ArrayBuffer,
      });
      const json = subscription.toJSON();
      if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) return null;
      return { endpoint: json.endpoint, keys: { p256dh: json.keys.p256dh, auth: json.keys.auth } };
    },
    async currentEndpoint() {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      return subscription?.endpoint ?? null;
    },
    async unsubscribeLocal() {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) await subscription.unsubscribe();
    },
  };
}

/** Genuinely never-throwing — fails closed (false) on ANY error. In
 *  particular, pushManager.subscribe() rejects with InvalidStateError when
 *  the existing browser subscription holds a DIFFERENT applicationServerKey;
 *  a throw here would abort enablePush's multi-pairing fan-out loop, leaving
 *  the remaining pairings unregistered (and every fire-and-forget caller with
 *  an unhandled rejection). */
export async function enablePushFlow(opts: {
  env: PushEnv;
  vapidPublicKey: string;
  userId: string;
  send: (env: AnyEnvelope) => Promise<void>;
}): Promise<boolean> {
  try {
    let permission = opts.env.permission();
    if (permission === 'denied') return false;
    if (permission === 'default') permission = await opts.env.requestPermission();
    if (permission !== 'granted') return false;
    const subscription = await opts.env.getSubscription(opts.vapidPublicKey);
    if (!subscription) return false;
    await opts.send(createEnvelope('push.subscribe', {
      from: userAddress(opts.userId),
      to: 'system',
      channel: 'system',
      payload: { subscription },
    }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Unsubscribe THIS device's push registration: tell the server to drop the
 * subscription (best-effort — proceeds to the local teardown regardless of
 * whether the send succeeds, since the device is going through unpair either
 * way) and unregister the browser-level subscription so the OS also stops
 * delivering pushes for it.
 *
 * Without this, unpair only wiped LOCAL app state (session/outbox/messages).
 * The server-side subscription row and the browser's own PushManager
 * registration both survived, so the device kept receiving the PRIOR user's
 * push notifications (message bodies included) until the next 404/410-based
 * prune, and could keep receiving them indefinitely if that never happens.
 */
export async function unsubscribeCurrentPush(opts: {
  env: PushEnv;
  userId: string;
  send: (env: AnyEnvelope) => Promise<void>;
}): Promise<void> {
  await unsubscribeInstanceOnly(opts);
  await opts.env.unsubscribeLocal().catch(() => { /* best-effort */ });
}

/**
 * Server-side half of the teardown above, on its own: tell ONE instance (over
 * its own transport, as its own userId) to drop this device's subscription
 * row. The browser-level subscription is left intact — it is shared by every
 * pairing on this device, and other instances may still deliver through it.
 * Best-effort: a failed send must not block the caller's unpair teardown.
 */
export async function unsubscribeInstanceOnly(opts: {
  env: PushEnv;
  userId: string;
  send: (env: AnyEnvelope) => Promise<void>;
}): Promise<void> {
  const endpoint = await opts.env.currentEndpoint().catch(() => null);
  if (!endpoint) return;
  await opts.send(createEnvelope('push.unsubscribe', {
    from: userAddress(opts.userId),
    to: 'system',
    channel: 'system',
    payload: { endpoint },
  })).catch(() => { /* best-effort: caller proceeds with its teardown regardless */ });
}
