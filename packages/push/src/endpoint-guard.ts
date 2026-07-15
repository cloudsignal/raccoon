// SSRF guard and limits for push subscriptions.
//
// A paired client supplies its own push endpoint. Without validation the server
// would POST to whatever URL it is handed, including internal or cloud-metadata
// hosts (server-side request forgery), and could be made to hold unbounded
// subscriptions for fan-out amplification.
//
// isSafeWebPushEndpoint rejects literal private / loopback / link-local /
// metadata / ULA addresses and localhost, AND requires the host to match a
// known standard web-push vendor (below). The vendor allowlist is what
// actually closes DNS-hostname-based SSRF: an IP-literal check alone still
// accepts an attacker-controlled hostname that resolves to an internal
// address (including via DNS rebinding, after this check runs) — real
// standard web-push endpoints only ever come from this small, fixed set of
// registrable domains, so restricting to them is not overly narrow.

/**
 * Registrable domains of known standard web-push vendors (Chrome/Edge/FCM,
 * Firefox, Safari, legacy WNS). An endpoint's host must equal one of these or
 * be a subdomain of one to be accepted. If you operate a push vendor not
 * listed here, extend this list for your deployment.
 */
export const KNOWN_PUSH_VENDOR_SUFFIXES = [
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'wns.windows.com',
  'web.push.apple.com',
] as const;

function matchesKnownPushVendor(host: string): boolean {
  return KNOWN_PUSH_VENDOR_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/** Max stored push subscriptions per user (bounds fan-out amplification). */
export const MAX_SUBSCRIPTIONS_PER_USER = 20;

/** Max wall-clock time for a single web-push send before it is abandoned. */
export const PUSH_SEND_TIMEOUT_MS = 10_000;

function isPrivateIp(rawHost: string): boolean {
  const host = rawHost.replace(/^\[|\]$/g, '').toLowerCase();

  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if ([a, b, Number(v4[3]), Number(v4[4])].some((o) => o > 255)) return true; // malformed -> unsafe
    if (a === 0 || a === 10 || a === 127) return true;      // this-network, private, loopback
    if (a === 169 && b === 254) return true;                // link-local + cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true;       // private
    if (a === 192 && b === 168) return true;                // private
    if (a === 100 && b >= 64 && b <= 127) return true;      // CGNAT
    return false;
  }

  if (host.includes(':')) {
    if (host === '::1' || host === '::') return true;        // loopback / unspecified
    if (host.startsWith('fe8') || host.startsWith('fe9') || host.startsWith('fea') || host.startsWith('feb')) return true; // fe80::/10 link-local
    if (host.startsWith('fc') || host.startsWith('fd')) return true; // fc00::/7 ULA
    // IPv4-mapped IPv6, dotted form (::ffff:127.0.0.1).
    const mappedDotted = host.match(/::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (mappedDotted) return isPrivateIp(mappedDotted[1]!);
    // IPv4-mapped IPv6, hex form (::ffff:7f00:1) — how Node's URL normalizes it.
    const mappedHex = host.match(/::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (mappedHex) {
      const hi = parseInt(mappedHex[1]!, 16);
      const lo = parseInt(mappedHex[2]!, 16);
      return isPrivateIp(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
    }
    return false;
  }

  return false; // a DNS hostname (not a literal IP) — allowed by this syntactic guard
}

/**
 * True if `endpoint` is a plausible, non-internal standard web-push endpoint:
 * a well-formed https URL whose host matches a known push vendor and is not
 * localhost or a literal private / loopback / link-local / metadata / ULA IP.
 * Non-URL vendor-scheme endpoints (e.g. a custom `scheme:<id>`) are NOT
 * web-push URLs and must be validated by their vendor, not here.
 */
export function isSafeWebPushEndpoint(endpoint: string): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (host === '' || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return false;
  if (isPrivateIp(host)) return false;
  if (!matchesKnownPushVendor(host)) return false;
  return true;
}
