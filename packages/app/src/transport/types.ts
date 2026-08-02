import type { Envelope, Transport } from '@raccoon/protocol';

/** Session grant fields a transport re-delivers on session resume — the same
 *  values a pair.grant carries (instance branding, channel grants, optional
 *  web-push key). Emitted AFTER the 'open' status for the connection that
 *  produced it, so consumers can diff against state they update on open. */
export interface SessionMeta {
  instance: string;
  channels: string[];
  vapidPublicKey?: string;
}

export interface AppTransport extends Transport {
  // #A1/#A2 (vendor-neutral): onGrant is OPTIONAL — it is the WS interactive-
  // pairing capability. A transport that authenticates out-of-band (e.g. via a
  // token/identity service) never issues a pair.grant and does not implement
  // it. Interactive pairing (pairWithPayload) requires it to be present; a
  // host-supplied session bypasses pairing entirely. Making it optional lets a
  // non-pairing transport satisfy AppTransport WITHOUT the
  // `as unknown as AppTransport` cast a managed-host wiring previously needed.
  onGrant?(h: (g: Envelope<'pair.grant'>) => void): () => void;
  // onSessionMeta is OPTIONAL for the same vendor-neutral reason as onGrant —
  // it is the capability of a transport whose resume acknowledgment re-delivers
  // the session grant fields (the WS transport does). A transport that never
  // resumes, or authenticates out-of-band, simply omits it; consumers feature-
  // detect. Handlers are called AFTER the 'open' status emission for that
  // connection; the returned function unsubscribes.
  onSessionMeta?(h: (meta: SessionMeta) => void): () => void;
  // onAuthError is NOT WS-specific — every transport surfaces auth failures
  // (revoked/expired). It stays required.
  onAuthError(h: (code: number) => void): () => void;
}

/** Per-kind transport factories, keyed by the pairing payload's `transport`
 *  field ('ws' is built in; an embedding host registers additional kinds via
 *  the provider's `transports` prop). A stored pairing whose kind has no
 *  factory stays listed but offline. */
export type TransportRegistry = Record<string, MakeTransport>;

export type MakeTransport = (opts: {
  url: string;
  session?: string;
  pairingToken?: string;
  device?: string;
  // #P1-B: called with the pair.grant BEFORE the transport confirms pairing —
  // the host persists the session here and the transport only confirms once it
  // resolves. A non-WS/host-managed transport may ignore it. See
  // WsClientOptions.onAdoptGrant.
  onAdoptGrant?: (grant: Envelope<'pair.grant'>) => Promise<void>;
  // Universal pairing (all optional, additive): the RUNTIME dial inputs.
  // Pairing itself is always the ws handshake against the QR's instanceUrl;
  // the registry factory for the pairing's kind is then dialed with the
  // stored pairing's fields — the opaque per-kind `transportConfig` blob the
  // pair.grant carried, plus the session identity for transports that need
  // it at construction. The built-in WS factory ignores all three.
  transportConfig?: unknown;
  userId?: string;
  instance?: string;
}) => AppTransport;
