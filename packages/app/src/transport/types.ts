import type { Envelope, Transport } from '@raccoon/protocol';

export interface AppTransport extends Transport {
  // #A1/#A2 (vendor-neutral): onGrant is OPTIONAL — it is the WS interactive-
  // pairing capability. A transport that authenticates out-of-band (e.g.
  // CloudSignal/MQTT via a token service) never issues a pair.grant and does
  // not implement it. Interactive pairing (pairWithPayload) requires it to be
  // present; a host-supplied session bypasses pairing entirely. Making it
  // optional lets a non-pairing transport satisfy AppTransport WITHOUT the
  // `as unknown as AppTransport` cast the GTM wiring previously needed.
  onGrant?(h: (g: Envelope<'pair.grant'>) => void): () => void;
  // onAuthError is NOT WS-specific — every transport surfaces auth failures
  // (revoked/expired). It stays required.
  onAuthError(h: (code: number) => void): () => void;
}

export type MakeTransport = (opts: {
  url: string;
  session?: string;
  pairingToken?: string;
  device?: string;
}) => AppTransport;
