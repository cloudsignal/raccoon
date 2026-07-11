import {
  createEnvelope,
  tryParseEnvelope,
  type AnyEnvelope,
  type Envelope,
  type Transport,
  type TransportStatus,
} from '@raccoon/protocol';

type WsLike = {
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open', listener: (event: Record<string, never>) => void): void;
  addEventListener(type: 'close', listener: (event: { code: number }) => void): void;
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void;
  addEventListener(type: 'error', listener: (event: Record<string, never>) => void): void;
  readyState: number;
};
type WsCtor = new (url: string) => WsLike;

const AUTH_CLOSE_CODES = new Set([4401, 4403, 4429]);
// #R10: max wait for the hub's pair.confirmed after sending pair.confirm; on
// expiry the client closes the socket so connect() rejects and reconnects
// (resuming the now-adopted session) rather than hanging on a lost ACK.
const CONFIRM_ACK_TIMEOUT_MS = 10_000;

export interface WsClientOptions {
  url: string;
  session?: string;
  pairingToken?: string;
  device?: string;
  WebSocketImpl?: WsCtor;
  maxBackoffMs?: number;
}

export class WsClientTransport implements Transport {
  private opts: WsClientOptions;
  private ws: WsLike | null = null;
  private status: TransportStatus = 'closed';
  private closedByUser = false;
  private everOpened = false;
  private backoffMs = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  private envelopeHandlers = new Set<(env: AnyEnvelope) => void>();
  private statusHandlers = new Set<(s: TransportStatus) => void>();
  private grantHandlers = new Set<(g: Envelope<'pair.grant'>) => void>();
  private wsCtor: WsCtor | null = null;
  private authHandlers = new Set<(code: number) => void>();

  constructor(opts: WsClientOptions) {
    if (!opts.session && !opts.pairingToken) {
      throw new Error('WsClientTransport requires session or pairingToken');
    }
    this.opts = opts;
  }

  onEnvelope(h: (env: AnyEnvelope) => void): () => void {
    this.envelopeHandlers.add(h);
    return () => this.envelopeHandlers.delete(h);
  }

  onStatus(h: (s: TransportStatus) => void): () => void {
    this.statusHandlers.add(h);
    return () => this.statusHandlers.delete(h);
  }

  onGrant(h: (g: Envelope<'pair.grant'>) => void): () => void {
    this.grantHandlers.add(h);
    return () => this.grantHandlers.delete(h);
  }

  onAuthError(h: (code: number) => void): () => void {
    this.authHandlers.add(h);
    return () => this.authHandlers.delete(h);
  }

  private async resolveCtor(): Promise<WsCtor> {
    if (this.opts.WebSocketImpl) return this.opts.WebSocketImpl;
    const g = (globalThis as { WebSocket?: unknown }).WebSocket;
    if (g) return g as WsCtor;
    const mod = await import('ws');
    return mod.default as unknown as WsCtor;
  }

  private setStatus(s: TransportStatus): void {
    this.status = s;
    for (const h of this.statusHandlers) h(s);
  }

  async connect(): Promise<void> {
    this.closedByUser = false;
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    await this.dial();
  }

  private async dial(): Promise<void> {
    const Ctor = this.wsCtor ?? (this.wsCtor = await this.resolveCtor());
    return new Promise((resolve, reject) => {
      const ws = new Ctor(this.opts.url);
      this.ws = ws;
      this.setStatus('connecting');
      let settled = false;
      // #R10: the adopted grant, stashed until the hub ACKs pair.confirmed.
      // Success (established/grantHandlers/resolve) is DEFERRED until then, so a
      // lost/failed confirm never reports a false "paired".
      let pendingGrant: Envelope<'pair.grant'> | null = null;
      // #R10 (adv): if pair.confirmed is LOST while the socket stays open, the
      // client would hang forever waiting. Bound the wait: close the socket so
      // connect() rejects and the reconnect resumes with the now-adopted
      // (server-side durable) session token.
      let confirmTimer: ReturnType<typeof setTimeout> | undefined;
      const clearConfirmTimer = () => { if (confirmTimer) { clearTimeout(confirmTimer); confirmTimer = undefined; } };

      ws.addEventListener('open', () => {
        if (this.opts.session) {
          ws.send(JSON.stringify({ session: this.opts.session }));
        } else {
          ws.send(JSON.stringify(createEnvelope('pair.request', {
            from: 'system', to: 'system', channel: 'pairing',
            payload: { token: this.opts.pairingToken!, device: this.opts.device ?? 'unknown' },
          })));
        }
      });

      ws.addEventListener('message', (event: { data: unknown }) => {
        let parsed: unknown;
        try { parsed = JSON.parse(String(event.data)); } catch { return; }

        if (this.status !== 'open') {
          // Hello phase: resume-ok or pair.grant establishes the session.
          if (typeof parsed === 'object' && parsed !== null && 'ok' in parsed) {
            this.established();
            if (!settled) { settled = true; resolve(); }
            return;
          }
          const env = tryParseEnvelope(parsed);
          if (env?.kind === 'pair.grant') {
            // Adopt the session token and CONFIRM, but DEFER success: the hub
            // ACKs pair.confirmed only after it actually promotes the session.
            // A client whose socket closed in the lost-grant window never
            // reaches here (its provisional session is TTL-reaped); one whose
            // confirm/promotion fails never gets the ACK, so connect() rejects
            // on close instead of falsely reporting paired (#R10).
            this.opts = { ...this.opts, session: env.payload.sessionToken, pairingToken: undefined };
            pendingGrant = env;
            try {
              ws.send(JSON.stringify(createEnvelope('pair.confirm', {
                from: 'system', to: 'system', channel: 'pairing',
                payload: { sessionToken: env.payload.sessionToken },
              })));
            } catch { /* best-effort; a lost confirm surfaces as connect() rejecting on close */ }
            clearConfirmTimer();
            confirmTimer = setTimeout(() => { try { ws.close(); } catch { /* already closing */ } }, CONFIRM_ACK_TIMEOUT_MS);
            return;
          }
          if (env?.kind === 'pair.confirmed' && pendingGrant && env.payload.sessionToken === pendingGrant.payload.sessionToken) {
            // #R10: the hub promoted the session — NOW report success.
            clearConfirmTimer();
            const granted = pendingGrant;
            pendingGrant = null;
            for (const h of this.grantHandlers) h(granted);
            this.established();
            if (!settled) { settled = true; resolve(); }
            return;
          }
          return;
        }

        const env = tryParseEnvelope(parsed);
        if (env) for (const h of this.envelopeHandlers) h(env);
      });

      ws.addEventListener('close', (event: { code: number }) => {
        clearConfirmTimer();
        const wasOpen = this.status === 'open';
        this.setStatus('closed');
        this.ws = null;
        if (AUTH_CLOSE_CODES.has(event.code)) {
          for (const h of this.authHandlers) h(event.code);
        }
        // Settle the connect() promise on a handshake-phase close, but do NOT
        // return early: a transient handshake failure must still schedule a
        // background reconnect. The old early return killed retries, so an
        // offline-start never reconnected and an established drop got a single try.
        if (!settled) {
          settled = true;
          reject(new Error(`connection closed during handshake (code ${event.code})`));
        }
        // Terminal closes never reconnect: a user-initiated close, or an auth-coded
        // close (revoked / expired / bad token).
        if (this.closedByUser || AUTH_CLOSE_CODES.has(event.code)) return;
        // Reconnect any resumable connection: one backed by a session token, or one
        // that opened at least once (includes the initial offline-start attempt). A
        // never-opened pairing-only attempt does not loop (the pairing UI surfaces it).
        if (this.opts.session || this.everOpened || wasOpen) this.scheduleReconnect();
      });

      ws.addEventListener('error', () => { /* close event follows */ });
    });
  }

  private established(): void {
    this.everOpened = true;
    this.backoffMs = 500;
    this.setStatus('open');
  }

  private scheduleReconnect(): void {
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.opts.maxBackoffMs ?? 15_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.closedByUser) return;
      void this.dial().catch(() => { /* next close schedules again unless auth-coded */ });
    }, delay);
  }

  async send(env: AnyEnvelope): Promise<void> {
    if (!this.ws || this.status !== 'open') throw new Error('transport not open');
    this.ws.send(JSON.stringify(env));
  }

  async close(): Promise<void> {
    this.closedByUser = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close(1000, 'client close');
    this.ws = null;
    this.setStatus('closed');
  }
}
