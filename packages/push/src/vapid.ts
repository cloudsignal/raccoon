import webpush from 'web-push';
import type { PushPayload, PushSender, PushSubscriptionJson } from './types.js';

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const keys = webpush.generateVAPIDKeys();
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

export class VapidPushSender implements PushSender {
  readonly vendor = 'webpush' as const;

  constructor(private readonly opts: { publicKey: string; privateKey: string; subject: string }) {}

  async send(sub: PushSubscriptionJson, payload: PushPayload): Promise<void> {
    if (!sub.keys) {
      throw new Error(
        `VapidPushSender: subscription ${sub.endpoint} has no keys — not a web-push subscription`,
      );
    }
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: sub.keys },
      JSON.stringify(payload),
      { vapidDetails: { subject: this.opts.subject, publicKey: this.opts.publicKey, privateKey: this.opts.privateKey } },
    );
  }
}
