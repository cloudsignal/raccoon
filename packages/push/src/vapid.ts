import webpush from 'web-push';
import type { PushPayload, PushSender, PushSubscriptionJson } from './types.js';
import { isSafeWebPushEndpoint, PUSH_SEND_TIMEOUT_MS } from './endpoint-guard.js';

export function generateVapidKeys(): { publicKey: string; privateKey: string } {
  const keys = webpush.generateVAPIDKeys();
  return { publicKey: keys.publicKey, privateKey: keys.privateKey };
}

/** Race a promise against a timeout so a slow or hanging endpoint cannot pin the
 *  sender indefinitely. */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`push send timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export class VapidPushSender implements PushSender {
  readonly vendor = 'webpush' as const;

  constructor(private readonly opts: { publicKey: string; privateKey: string; subject: string }) {}

  async send(sub: PushSubscriptionJson, payload: PushPayload): Promise<void> {
    if (!sub.keys) {
      throw new Error(
        `VapidPushSender: subscription ${sub.endpoint} has no keys: not a web-push subscription`,
      );
    }
    // Defense in depth: refuse an internal / non-https destination even if an
    // unsafe endpoint slipped past the subscribe-time guard.
    if (!isSafeWebPushEndpoint(sub.endpoint)) {
      throw new Error(`VapidPushSender: refusing unsafe push endpoint ${sub.endpoint}`);
    }
    await withTimeout(
      webpush.sendNotification(
        { endpoint: sub.endpoint, keys: sub.keys },
        JSON.stringify(payload),
        { vapidDetails: { subject: this.opts.subject, publicKey: this.opts.publicKey, privateKey: this.opts.privateKey } },
      ),
      PUSH_SEND_TIMEOUT_MS,
    );
  }
}
