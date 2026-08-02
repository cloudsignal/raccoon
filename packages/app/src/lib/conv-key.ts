// packages/app/src/lib/conv-key.ts
/**
 * A conversation key: `${pairingId}/${channel}`. Every piece of per-
 * conversation app state (chat state records, `lastread:` kv keys, the `?c=`
 * URL param, ack/typing timer maps) is keyed by ConvKey, so two pairings that
 * both expose a channel named `coordinator` never share state.
 *
 * pairingId is an OPAQUE string: a ULID for pairings created by the QR scan
 * flow, or (for a host-embedded session) a stable identity-derived string that
 * may itself contain '/'. That is why resolveConvKey matches known ids by
 * longest prefix instead of splitting on the first '/'.
 */
export type ConvKey = string;

export function convKeyOf(pairingId: string, channel: string): ConvKey {
  return `${pairingId}/${channel}`;
}

/** Resolve a ConvKey against the known pairing ids (longest match wins).
 *  Returns null when no known pairing prefixes the key — callers treat that
 *  as "conversation does not exist" (e.g. a stale URL param). */
export function resolveConvKey(
  key: ConvKey,
  pairingIds: Iterable<string>,
): { pairingId: string; channel: string } | null {
  let best: { pairingId: string; channel: string } | null = null;
  for (const id of pairingIds) {
    const prefix = `${id}/`;
    if (key.startsWith(prefix) && (!best || id.length > best.pairingId.length)) {
      best = { pairingId: id, channel: key.slice(prefix.length) };
    }
  }
  return best;
}

/** Muted, professional accent palette — used as the per-pairing identity cue
 *  (avatar badge, Platforms rows). oklch keeps perceived lightness even across
 *  the 8 hues: Blue, Rust, Moss, Violet, Amber, Rose, Cyan, Olive.
 *  New pairings persist the first unused hue at creation (nextAccentColor);
 *  accentColor is the deterministic hash fallback for entries without a
 *  stored color. Locally overridable via PairedSession.color. */
export const ACCENTS = [
  'oklch(0.55 0.13 255)', // Blue
  'oklch(0.62 0.14 30)',  // Rust
  'oklch(0.56 0.1 155)',  // Moss
  'oklch(0.58 0.12 300)', // Violet
  'oklch(0.68 0.12 75)',  // Amber
  'oklch(0.62 0.12 355)', // Rose
  'oklch(0.6 0.1 215)',   // Cyan
  'oklch(0.6 0.09 120)',  // Olive
] as const;

export function accentColor(pairingId: string): string {
  let h = 0;
  for (let i = 0; i < pairingId.length; i++) h = (h * 31 + pairingId.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}

/** First palette entry not present in `used` (pass the current pairings'
 *  EFFECTIVE colors: stored color ?? accentColor(pairingId)). Returns '' when
 *  all 8 are taken — callers fall back to accentColor(pairingId). */
export function nextAccentColor(used: Iterable<string>): string {
  const taken = new Set(used);
  for (const c of ACCENTS) if (!taken.has(c)) return c;
  return '';
}
