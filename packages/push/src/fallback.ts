import { parseAddress, type AnyEnvelope } from '@raccoon/protocol';
import type { PushCapableHub, PushPayload, PushSender, PushSubscriptionJson, SubscriptionStore } from './types.js';
import { sendPushToUser } from './delivery.js';
import { vendorOf } from './vendor.js';
import { isSafeWebPushEndpoint, MAX_SUBSCRIPTIONS_PER_USER } from './endpoint-guard.js';

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

  // Subscribe boundary: apply the SSRF guard and a per-user cap before storing a
  // client-supplied subscription. A standard web-push endpoint must be a safe https
  // URL; vendor-scheme endpoints are validated by their vendor. Re-subscribing the
  // same endpoint is always allowed; the cap only blocks growth of distinct ones.
  const addSubscription = async (userId: string, sub: PushSubscriptionJson): Promise<void> => {
    if (vendorOf(sub) === 'webpush' && !isSafeWebPushEndpoint(sub.endpoint)) return;
    try {
      const existing = await opts.store.list(userId);
      const already = existing.some((s) => s.endpoint === sub.endpoint);
      if (!already && existing.length >= MAX_SUBSCRIPTIONS_PER_USER) return;
    } catch {
      /* store list failure: fall through to a best-effort add */
    }
    await opts.store.add(userId, sub);
  };

  // Serialise adds per user so the list -> cap-check -> add sequence is atomic for
  // a given user; concurrent distinct-endpoint subscribes then cannot each pass the
  // cap check before any write and overshoot MAX_SUBSCRIPTIONS_PER_USER.
  const addChains = new Map<string, Promise<void>>();
  const enqueueAdd = (userId: string, sub: PushSubscriptionJson): void => {
    const prev = addChains.get(userId) ?? Promise.resolve();
    const next = prev.then(() => addSubscription(userId, sub)).catch(() => { /* best-effort */ });
    addChains.set(userId, next);
    void next.finally(() => { if (addChains.get(userId) === next) addChains.delete(userId); });
  };

  const stopCapture = hub.onEnvelope((env, userId) => {
    if (env.kind !== 'push.subscribe') return;
    enqueueAdd(userId, env.payload.subscription);
  });

  return {
    hub: wrapped,
    /** Stops capturing new push.subscribe registrations. Handlers already
     *  registered via the wrapped hub remain attached to the inner hub. */
    stop: stopCapture,
  };
}
