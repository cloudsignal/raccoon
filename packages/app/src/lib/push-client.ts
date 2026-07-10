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
}

export function browserPushEnv(): PushEnv | null {
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
  };
}

export async function enablePushFlow(opts: {
  env: PushEnv;
  vapidPublicKey: string;
  userId: string;
  send: (env: AnyEnvelope) => Promise<void>;
}): Promise<boolean> {
  let permission = opts.env.permission();
  if (permission === 'denied') return false;
  if (permission === 'default') permission = await opts.env.requestPermission();
  if (permission !== 'granted') return false;
  const subscription = await opts.env.getSubscription(opts.vapidPublicKey);
  if (!subscription) return false;
  try {
    await opts.send(createEnvelope('push.subscribe', {
      from: userAddress(opts.userId),
      to: 'system',
      channel: 'system',
      payload: { subscription },
    }));
  } catch {
    return false;
  }
  return true;
}
