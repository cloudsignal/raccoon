import type { PushSubscriptionJson, PushVendor } from './types.js';

/** The single place vendor derivation lives. Callers never pass a vendor:
 *  it is derived from the endpoint's URI scheme, so legacy rows and the
 *  vendor-free subscribe inputs (HTTP body, push.subscribe envelope) all
 *  resolve consistently. Standard web-push endpoints are http(s) URLs and
 *  resolve to 'webpush'; any other scheme IS the vendor (e.g. an endpoint
 *  'myvendor:<id>' resolves to vendor 'myvendor'). The core privileges no
 *  specific vendor — a consumer registers a PushSender per scheme it supports. */
export function vendorOf(sub: Pick<PushSubscriptionJson, 'endpoint'>): PushVendor {
  const { endpoint } = sub;
  const colon = endpoint.indexOf(':');
  if (colon <= 0) return 'webpush';
  const scheme = endpoint.slice(0, colon);
  return scheme === 'http' || scheme === 'https' ? 'webpush' : scheme;
}
