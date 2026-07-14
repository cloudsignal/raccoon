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
  /**
   * #R10: max wait (ms) for the hub's pair.confirmed after sending pair.confirm
   * before the client closes the socket to force a resume of the now-adopted
   * session. Defaults to {@link CONFIRM_ACK_TIMEOUT_MS} (10s). Injectable so
   * deployments can tune the lost-ACK recovery latency (and tests can drive it
   * without a real 10s wait) — same role as {@link WsClientOptions.maxBackoffMs}.
   */
  confirmAckTimeoutMs?: number;
  /**
   * #P1-B: invoked with the pair.grant BEFORE the client sends pair.confirm.
   * Use it to DURABLY persist the adopted session. The client AWAITS it and
   * only confirms if it resolves; if it rejects (or throws), the client does
   * NOT confirm — the hub never promotes the provisional session (its TTL reaps
   * it), so the server can never hold a session the host hasn't committed
   * ("ready" is therefore never reachable without a durable local copy). WS
   * pairing only; a session-resume connection never calls it.
   */
  onAdoptGrant?: (grant: Envelope<'pair.grant'>) => Promise<void>;
}

export class WsClientTransport implements Transport {
  private opts: WsClientOptions;
  private ws: WsLike | null = null;
  private status: TransportStatus = 'closed';
  private closedByUser = false;
  private everOpened = false;
  private backoffMs = 500;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  // #R10: a pair.grant this instance ADOPTED but has not yet surfaced to
  // grantHandlers. Instance-scoped (not per-dial) so that if pair.confirmed is
  // lost and the client recovers on a later reconnect via session resume, the
  // resume can still surface the grant — otherwise the host that paired never
  // learns the session token, never persists it, and never reports paired (a
  // ghost pairing: durable server session, nothing on the client). Cleared the
  // instant it is emitted (confirmed path OR recovery-resume), so it fires once.
  private adoptedGrant: Envelope<'pair.grant'> | null = null;

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
      // #P1(r3): set when onAdoptGrant REJECTED — the pairing is dead, so the
      // close below must NOT schedule a reconnect (a reconnect would resume the
      // provisional token and the hub would promote it, defeating the point of
      // failing the adoption). Dial-scoped: a fresh connect() starts clean.
      let pairingAborted = false;
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
            const grant = env;
            pendingGrant = env; // matched against pair.confirmed; cleared on adoption failure
            const adopt = this.opts.onAdoptGrant;
            const confirmTimeoutMs = this.opts.confirmAckTimeoutMs ?? CONFIRM_ACK_TIMEOUT_MS;
            // #P1-B/#P1(r3): DURABLY adopt (host persists) BEFORE the token becomes
            // RESUMABLE. opts.session is set (and the grant stashed for re-emission)
            // ONLY after onAdoptGrant succeeds — never before — so a failed
            // adoption can't leave a resumable token that a reconnect would
            // resume+promote. On rejection: clear the provisional state and
            // TERMINATE without reconnecting (the hub's provisional session
            // TTL-reaps, never promoted). Confirm is likewise sent only post-adopt.
            void (async () => {
              try {
                if (adopt) await adopt(grant);
              } catch {
                pendingGrant = null;
                pairingAborted = true; // suppress the reconnect in the close handler
                try { ws.close(); } catch { /* already closing */ }
                return;
              }
              // Adoption succeeded → the session is durable. NOW make it resumable.
              this.opts = { ...this.opts, session: grant.payload.sessionToken, pairingToken: undefined };
              this.adoptedGrant = grant; // surfaced by established() on confirm OR recovery-resume
              if (settled) {
                // The socket closed WHILE adoption was in flight (the close handler
                // saw no session yet, so it did NOT reconnect). Now that adoption
                // succeeded, recovery is safe: resume the now-durable session,
                // which the hub promotes idempotently (#P1-B).
                this.scheduleReconnect();
                return;
              }
              try {
                ws.send(JSON.stringify(createEnvelope('pair.confirm', {
                  from: 'system', to: 'system', channel: 'pairing',
                  payload: { sessionToken: grant.payload.sessionToken },
                })));
              } catch { /* a lost confirm surfaces as connect() rejecting on close */ }
              clearConfirmTimer();
              confirmTimer = setTimeout(() => { try { ws.close(); } catch { /* already closing */ } }, confirmTimeoutMs);
            })();
            return;
          }
          if (env?.kind === 'pair.confirmed' && pendingGrant && env.payload.sessionToken === pendingGrant.payload.sessionToken) {
            // #R10: the hub promoted the session — NOW report success. established()
            // surfaces the adopted grant (exactly once) and flips to open.
            clearConfirmTimer();
            pendingGrant = null;
            this.established();
            if (!settled) { settled = true; resolve(); }
            return;
          }
          return;
        }

        const env = tryParseEnvelope(parsed);
        if (env) for (const h of this.envelopeHandlers) h(env);
      });

      // Both 'close' and 'error' funnel here, exactly once per socket. Node 22's
      // WebSocket (undici) fires ONLY 'error' — no 'close' ever — when a dial
      // fails before the upgrade (ECONNREFUSED, non-101 response), which left
      // connect() unsettled forever and never armed the reconnect loop (caught
      // by the offline-start test, which hangs on node 22 without this).
      // Browsers, node 26, and the `ws` package fire error-then-close; the guard
      // makes the second delivery a no-op (and 1006 matches the abnormal-close
      // code those runtimes report — clean auth closes fire 'close' only, so
      // real codes still arrive through the real event).
      let closeHandled = false;
      const onSocketClose = (event: { code: number }) => {
        if (closeHandled) return;
        closeHandled = true;
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
        // Terminal closes never reconnect: a user-initiated close, an auth-coded
        // close (revoked / expired / bad token), or an ABORTED pairing (adoption
        // rejected — the provisional token must never become resumable, #P1(r3)).
        if (this.closedByUser || pairingAborted || AUTH_CLOSE_CODES.has(event.code)) return;
        // Reconnect any resumable connection: one backed by a session token, or one
        // that opened at least once (includes the initial offline-start attempt). A
        // never-opened pairing-only attempt does not loop (the pairing UI surfaces it).
        if (this.opts.session || this.everOpened || wasOpen) this.scheduleReconnect();
      };
      ws.addEventListener('close', onSocketClose);
      ws.addEventListener('error', () => { onSocketClose({ code: 1006 }); });
    });
  }

  private established(): void {
    this.everOpened = true;
    this.backoffMs = 500;
    // #R10: surface an adopted-but-unsurfaced pairing grant. On the normal
    // confirmed path this fires immediately; on a recovery resume after a lost
    // pair.confirmed it fires when the resume succeeds (the resume itself proves
    // the session is durable server-side). A plain app-supplied session never
    // adopts a grant, so this is a no-op there. Emitted before 'open' so a host
    // has the session in hand when it observes the transport go live.
    const grant = this.adoptedGrant;
    if (grant) {
      this.adoptedGrant = null;
      for (const h of this.grantHandlers) h(grant);
    }
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
