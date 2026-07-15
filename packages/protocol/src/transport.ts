import type { AnyEnvelope } from './envelope.js';

export type TransportStatus = 'connecting' | 'open' | 'closed';

export interface Transport {
  connect(): Promise<void>;
  close(): Promise<void>;
  send(env: AnyEnvelope): Promise<void>;
  /** Returns an unsubscribe function. */
  onEnvelope(handler: (env: AnyEnvelope) => void): () => void;
  /** Returns an unsubscribe function. */
  onStatus(handler: (status: TransportStatus) => void): () => void;
}
