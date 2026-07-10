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
): { hub: PushCapableHub; stop(): void; clearForUser(userId: string): Promise<void> } {
  const notify = opts.notify ?? defaultNotify;

  // #R6-6: per-user revocation generation. clearForUser() bumps it
  // synchronously the instant a revoke is requested; each in-flight delivery
  // captured the value at its start and aborts if it has since advanced.
  // This fences fire-and-forget push delivery against a concurrent revoke
  // without serializing all deliveries behind the op chain.
  const revokedGen = new Map<string, number>();

  const pushOut = (userId: string, payload: PushPayload): void => {
    const genAtStart = revokedGen.get(userId) ?? 0;
    void sendPushToUser(opts.store, opts.sender, userId, payload, () => (revokedGen.get(userId) ?? 0) !== genAtStart);
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
        if (env.kind === 'push.subscribe' || env.kind === 'push.unsubscribe') return; // consumed below
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

  // Serialise BOTH subscribe and unsubscribe per user, in arrival order, on
  // the SAME chain. Without this, a subscribe's list -> cap-check -> add
  // sequence could interleave with a concurrent unsubscribe for the same
  // user: e.g. subscribe's list() snapshot taken before an in-flight
  // unsubscribe's remove() commits, followed by unsubscribe committing, then
  // subscribe's add() lands — resurrecting the very endpoint the client had
  // just asked to remove. One FIFO chain per user closes every such
  // interleaving, matching the atomicity the cap-check already relied on for
  // concurrent subscribes.
  const opChains = new Map<string, Promise<void>>();
  // #R5-9: two promises per op, deliberately distinct. `result` carries the
  // op's REAL outcome to the caller (clearForUser must reject when
  // store.clear() fails — a revoke that swallowed it reported success while
  // the user's subscriptions were all still deliverable). `next` — the link
  // the chain itself continues from — swallows that failure so one failed op
  // never wedges every later op for the user.
  const enqueue = (userId: string, op: () => Promise<void>): Promise<void> => {
    const prev = opChains.get(userId) ?? Promise.resolve();
    const result = prev.then(op);
    const next = result.catch(() => { /* chain continues past a failed op */ });
    opChains.set(userId, next);
    void next.finally(() => { if (opChains.get(userId) === next) opChains.delete(userId); });
    return result;
  };

  const stopCapture = hub.onEnvelope((env, userId) => {
    // Both captures stay best-effort: enqueue()'s returned promise now
    // reflects the op's real outcome (#R5-9), and nothing here awaits it —
    // so attach a catch to keep a failed add/remove from becoming an
    // unhandled rejection. (The chain itself is failure-proof internally.)
    if (env.kind === 'push.subscribe') {
      void enqueue(userId, () => addSubscription(userId, env.payload.subscription)).catch(() => {});
      return;
    }
    if (env.kind === 'push.unsubscribe') {
      // remove(userId, endpoint) is scoped to that userId's own subscriptions
      // (per the SubscriptionStore contract), so a client can only ever
      // unsubscribe an endpoint registered under its own authenticated
      // identity, never another user's.
      void enqueue(userId, () => opts.store.remove(userId, env.payload.endpoint)).catch(() => {});
    }
  });

  return {
    hub: wrapped,
    /** Stops capturing new push.subscribe registrations. Handlers already
     *  registered via the wrapped hub remain attached to the inner hub. */
    stop: stopCapture,
    /**
     * Clear all of a user's subscriptions through the SAME per-user FIFO
     * chain subscribe/unsubscribe use (#R4-5) — not an unserialized side
     * call. Without this, an in-flight subscribe already past its
     * list()/cap-check snapshot (about to call store.add()) could land
     * AFTER an unserialized clear() and resurrect a subscription for a
     * user whose revocation was meant to remove it — reproduced by
     * blocking add(), completing revoke, then releasing add(), which left
     * one subscription behind.
     */
    clearForUser: (userId: string) => {
      // #R6-6: bump the revocation generation SYNCHRONOUSLY, before the
      // (chained, async) store.clear — so any push delivery already in
      // flight for this user sees the change at its next fence check and
      // aborts, rather than delivering to a subscription this revoke is
      // about to remove.
      revokedGen.set(userId, (revokedGen.get(userId) ?? 0) + 1);
      return enqueue(userId, () => opts.store.clear(userId));
    },
  };
}
