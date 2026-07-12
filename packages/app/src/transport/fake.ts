import type { AnyEnvelope, Envelope, TransportStatus } from '@raccoon/protocol';
import type { AppTransport } from './types.js';

export class FakeTransport implements AppTransport {
  sent: AnyEnvelope[] = [];
  connected = false;
  failNextSend = false;
  // When true, the NEXT connect() rejects (and self-clears) — models a
  // WsClientTransport whose first dial rejects on a lost pair.confirmed but which
  // recovers in the background and later re-emits the grant (drive with grant()).
  failConnect = false;
  private envelopeHandlers = new Set<(env: AnyEnvelope) => void>();
  private statusHandlers = new Set<(s: TransportStatus) => void>();
  private grantHandlers = new Set<(g: Envelope<'pair.grant'>) => void>();
  private authHandlers = new Set<(code: number) => void>();

  async connect(): Promise<void> {
    if (this.failConnect) { this.failConnect = false; this.setStatus('closed'); throw new Error('connect failed'); }
    this.connected = true;
    this.setStatus('open');
  }
  async close(): Promise<void> { this.connected = false; this.setStatus('closed'); }
  async send(env: AnyEnvelope): Promise<void> {
    if (this.failNextSend) { this.failNextSend = false; throw new Error('send failed'); }
    if (!this.connected) throw new Error('transport not open');
    this.sent.push(env);
  }
  onEnvelope(h: (env: AnyEnvelope) => void): () => void { this.envelopeHandlers.add(h); return () => this.envelopeHandlers.delete(h); }
  onStatus(h: (s: TransportStatus) => void): () => void { this.statusHandlers.add(h); return () => this.statusHandlers.delete(h); }
  onGrant(h: (g: Envelope<'pair.grant'>) => void): () => void { this.grantHandlers.add(h); return () => this.grantHandlers.delete(h); }
  onAuthError(h: (code: number) => void): () => void { this.authHandlers.add(h); return () => this.authHandlers.delete(h); }

  emit(env: AnyEnvelope): void { for (const h of this.envelopeHandlers) h(env); }
  setStatus(s: TransportStatus): void { for (const h of this.statusHandlers) h(s); }
  grant(g: Envelope<'pair.grant'>): void { this.connected = true; for (const h of this.grantHandlers) h(g); this.setStatus('open'); }
  authFail(code: number): void { for (const h of this.authHandlers) h(code); }
}
