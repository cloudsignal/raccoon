import { parseAddress, type AnyEnvelope } from '@raccoon/protocol';
import type { PushCapableHub, PushPayload, PushSender, SubscriptionStore } from './types.js';
import { sendPushToUser } from './delivery.js';

function defaultNotify(env: AnyEnvelope): PushPayload | null {
  if (env.kind === 'msg') {
    const from = parseAddress(env.from);
    return { title: from.id ?? 'Agent', body: env.payload.text.slice(0, 140) };
  }
  if (env.kind === 'approval.request') {
    return { title: env.payload.title, body: env.payload.description.slice(0, 140) };
  }
  return null;
}

/** Wrap a hub: store push.subscribe registrations (swallowed — consumers never
 *  see them) and web-push any notifiable envelope that finds no open socket. */
export function withPushFallback(
  hub: PushCapableHub,
  opts: { store: SubscriptionStore; sender: PushSender; notify?: (env: AnyEnvelope) => PushPayload | null },
): { hub: PushCapableHub; stop(): void } {
  const notify = opts.notify ?? defaultNotify;

  const pushOut = (userId: string, payload: PushPayload): void => {
    void sendPushToUser(opts.store, opts.sender, userId, payload);
  };

  const wrapped: PushCapableHub = {
    sendToUser(userId, env) {
      const delivered = hub.sendToUser(userId, env);
      if (!delivered) {
        const payload = notify(env);
        if (payload) pushOut(userId, payload);
      }
      return delivered;
    },
    onEnvelope(handler) {
      return hub.onEnvelope((env, userId) => {
        if (env.kind === 'push.subscribe') return; // consumed below
        handler(env, userId);
      });
    },
  };

  const stopCapture = hub.onEnvelope((env, userId) => {
    if (env.kind !== 'push.subscribe') return;
    void opts.store.add(userId, env.payload.subscription);
  });

  return {
    hub: wrapped,
    /** Stops capturing new push.subscribe registrations. Handlers already
     *  registered via the wrapped hub remain attached to the inner hub. */
    stop: stopCapture,
  };
}
