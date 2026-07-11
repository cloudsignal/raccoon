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

  // Per-user revocation fence, in TWO parts (#R6-6b + #R7-4):
  //  - `revoking` membership: a user is fenced from clearForUser() until a
  //    fresh push.subscribe (re-enrollment) lifts it. Fences deliveries that
  //    START after a revoke and before a re-subscribe (#R6-6b).
  //  - `revokeGen` monotonic per-user counter, bumped by clearForUser() and
  //    NEVER reset by a re-subscribe. Each delivery captures it at start and
  //    aborts if it changed. This closes the #R7-4 gap the membership test
  //    alone had: a re-subscribe lifting `revoking` would otherwise un-fence
  //    an OLD delivery that had snapshotted a now-cleared subscription before
  //    the revoke — it would then send to the stale endpoint. The generation
  //    stays bumped across the re-subscribe, so that old delivery stays
  //    fenced, while a NEW delivery (started after re-subscribe, capturing the
  //    new generation) proceeds.
  const revoking = new Set<string>();
  const revokeGen = new Map<string, number>();
  const genOf = (userId: string): number => revokeGen.get(userId) ?? 0;

  const pushOut = (userId: string, payload: PushPayload): void => {
    if (revoking.has(userId)) return; // fence deliveries that START after a revoke
    const genAtStart = genOf(userId);
    // isStale re-checks before the snapshot and before EACH send: a delivery
    // in flight when a revoke lands (revoking set, or the generation moved
    // even if since re-subscribed) aborts. The only send that can't be
    // recalled is one already handed to the network.
    void sendPushToUser(opts.store, opts.sender, userId, payload, () => revoking.has(userId) || genOf(userId) !== genAtStart);
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
    // #R6-6b: a fresh subscription is a (re-)enrollment — lift any prior
    // revocation fence for this user so delivery resumes for the new pairing.
    revoking.delete(userId);
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
      // #R6-6b: mark the user revoking SYNCHRONOUSLY, before the (chained,
      // async) store.clear. From this instant pushOut refuses to START a
      // delivery for this user, and any delivery already in flight aborts at
      // its next isStale check — so no send can begin against a subscription
      // this revoke is about to remove, whether it started before or after
      // the revoke. Reactivated only by a fresh push.subscribe (re-pair).
      revoking.add(userId);
      revokeGen.set(userId, genOf(userId) + 1); // #R7-4: bump so in-flight deliveries stay fenced across a later re-subscribe
      return enqueue(userId, () => opts.store.clear(userId));
    },
  };
}
