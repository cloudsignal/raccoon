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
 *  (avatar badge, Platforms rows). Deterministic from the pairingId so the
 *  color is stable across sessions without any stored state; locally
 *  overridable via PairedSession.color. */
const ACCENTS = [
  '#6366f1', '#0ea5e9', '#10b981', '#f59e0b',
  '#ef4444', '#8b5cf6', '#14b8a6', '#f43f5e',
] as const;

export function accentColor(pairingId: string): string {
  let h = 0;
  for (let i = 0; i < pairingId.length; i++) h = (h * 31 + pairingId.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}
