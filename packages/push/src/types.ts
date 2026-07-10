import type { AnyEnvelope } from '@raccoon/protocol';

// 'webpush' is the built-in standard (VAPID web-push). Any other string is a
// custom vendor scheme a consumer registers a PushSender for (see vendorOf) —
// the core privileges no specific vendor.
export type PushVendor = 'webpush' | (string & {});

export interface PushSubscriptionJson {
  endpoint: string;
  /** Present for standard web-push subscriptions; absent for vendor-scheme
   *  endpoints (e.g. a custom vendor scheme like 'myvendor:<registration_id>'). */
  keys?: { p256dh: string; auth: string };
}

export interface PushPayload {
  title: string;
  body: string;
  /** Notification collapse key — same tag replaces instead of stacking. */
  tag?: string;
  /** Click routing hints, passed through to the notification. */
  data?: { url?: string; channel?: string };
}

export interface SubscriptionStore {
  add(userId: string, sub: PushSubscriptionJson): Promise<void>;
  list(userId: string): Promise<PushSubscriptionJson[]>;
  remove(userId: string, endpoint: string): Promise<void>;
  /** Remove every subscription for a user. Called on revoke so a revoked
   *  user cannot still receive push notifications after their pairing and
   *  live sockets are gone. */
  clear(userId: string): Promise<void>;
}

export interface PushSender {
  /** Which subscription rows this sender can deliver (see vendorOf). */
  readonly vendor: PushVendor;
  send(sub: PushSubscriptionJson, payload: PushPayload): Promise<void>;
}

/** Structural subset of WsHub the fallback decorates (matches bridge's OutboundHub). */
export interface PushCapableHub {
  sendToUser(userId: string, env: AnyEnvelope): boolean;
  onEnvelope(handler: (env: AnyEnvelope, userId: string) => void): () => void;
}
