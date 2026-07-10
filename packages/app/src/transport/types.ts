import type { Envelope, Transport } from '@raccoon/protocol';

export interface AppTransport extends Transport {
  onGrant(h: (g: Envelope<'pair.grant'>) => void): () => void;
  onAuthError(h: (code: number) => void): () => void;
}

export type MakeTransport = (opts: {
  url: string;
  session?: string;
  pairingToken?: string;
  device?: string;
}) => AppTransport;
