import { randomBytes } from 'node:crypto';
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { WebSocketServer, type WebSocket } from 'ws';
import {
  createEnvelope,
  tryParseEnvelope,
  userAddress,
  type AnyEnvelope,
} from '@raccoon/protocol';
import { MemoryCredentialStore, type CredentialStore } from './credential-store.js';

interface PairingToken { userId: string; expiresAt: number; used: boolean }

/**
 * #R8-6: after createSession() mints a session, decide whether the grant must
 * be ABANDONED (session revoked, one-time token un-burned) because the
 * connection went away during that await. Two independent signals:
 *  - `signalAborted`: the hello deadline fired (or the close-event abort ran).
 *  - `socketOpen === false`: the client started closing and the socket is no
 *    longer OPEN, even though the close-event abort callback has NOT run yet
 *    (createSession resolved in that window). The old code returned here
 *    WITHOUT revoking → orphan session + burned QR token.
 * Exported for direct unit coverage of every combination.
 */
export function grantAbandoned(signalAborted: boolean, socketOpen: boolean): boolean {
  return signalAborted || !socketOpen;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.woff2': 'font/woff2',
};

const NO_STORE = new Set(['/index.html', '/version.json', '/service-worker.js', '/manifest.webmanifest']);

// R3-10: bound the resources an unauthenticated connection can hold before it
// ever sends a valid hello. Without these, an attacker can open unlimited
// sockets and never complete the handshake (exhausting file descriptors /
// memory), or send an oversized frame (unbounded per-message memory — the
// `ws` library's own default maxPayload is 100 MiB).
const DEFAULT_HELLO_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_PENDING_CONNECTIONS = 200;
const DEFAULT_MAX_PAYLOAD_BYTES = 262_144; // 256 KiB — generous for any real hello/envelope frame

export interface WsHubOptions {
  instance: string;
  host?: string;
  port?: number;
  store?: CredentialStore;
  channels?: string[];
  pairingTtlMs?: number;
  pairingAttemptsPerMinute?: number;
  /** Max ms a connection may stay open without sending a valid first message
   *  before it's closed. Default 10_000. */
  helloTimeoutMs?: number;
  /** Max concurrent connections that have not yet completed hello. Once
   *  reached, new connections are closed immediately. Default 200. */
  maxPendingConnections?: number;
  /** Max bytes for a single WebSocket message (the `ws` library's own
   *  default is 100 MiB). Default 262_144 (256 KiB). */
  maxPayloadBytes?: number;
  /** Serve a static SPA build (the Raccoon app dist/) over plain HTTP on the same port. */
  staticDir?: string;
  /** Advertised in pair.grant so clients can register web-push subscriptions. */
  vapidPublicKey?: string;
  /** #P1-C: how long a PROVISIONAL (paired-but-unconfirmed) session survives
   *  before the default MemoryCredentialStore reaps it. Only used when no
   *  custom `store` is supplied. Default 30_000. */
  provisionalSessionTtlMs?: number;
  /** External pairing validation (e.g. enrollment tokens in a host DB).
   *  Checked before the built-in in-memory token map. Return the userId
   *  to grant, or null to reject. `signal` aborts when the hello deadline
   *  (helloTimeoutMs) fires (#R6-11) — a cooperative validator should pass
   *  it to its own I/O so a hung backend cancels rather than dangles; the
   *  hub bounds the slot either way. */
  validatePairingToken?: (token: string, signal?: AbortSignal) => Promise<string | null>;
}

export class WsHub {
  readonly instance: string;
  readonly channels: string[];
  private readonly host: string;
  private readonly portOpt: number;
  private readonly store: CredentialStore;
  private readonly pairingTtlMs: number;
  private readonly maxAttempts: number;
  private readonly helloTimeoutMs: number;
  private readonly maxPendingConnections: number;
  private readonly maxPayloadBytes: number;
  private readonly staticDir: string | null;
  private readonly vapidPublicKey: string | null;
  private readonly validatePairingToken: ((token: string, signal?: AbortSignal) => Promise<string | null>) | null;

  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private pairingTokens = new Map<string, PairingToken>();
  private attempts = new Map<string, { count: number; resetAt: number }>();
  private byUser = new Map<string, Set<WebSocket>>();
  // Connections that have not yet sent a valid first message (hello). Tracked
  // separately from byUser so the pending-connection cap (R3-10) only bounds
  // pre-auth resource usage, never a legitimately high count of authenticated
  // sockets.
  private pendingConnections = new Set<WebSocket>();
  // Set by revokeUser() (a monotonic sequence number at revoke time — see
  // nextSeq(), #R4-8). handleHello captures its OWN start sequence BEFORE any
  // await (including the external validatePairingToken call, whose duration
  // we don't control) and, right before granting, checks whether this user
  // has been revoked at or after that start. A single check suffices because
  // revokedAt only ever increases: a revoke landing at ANY point during this
  // handleHello call — before grantUserId is even known, during
  // createSession(), or anywhere between — is stamped with a sequence >= the
  // captured start and is caught by the one comparison. This also closes the
  // external-validator gap an epoch-only check could not: an epoch snapshot
  // taken only after grantUserId resolves cannot see a revoke that completed
  // (and already bumped the epoch) before that snapshot, so a genuinely
  // concurrent revoke during that external await passed through undetected.
  //
  // A monotonic counter, not Date.now(): a backward system clock adjustment
  // (NTP correction, VM migration/resume, manual change) between
  // helloStartedAt being captured and revokeUser() running could make
  // Date.now() at revoke time LESS than the already-captured helloStartedAt
  // even though the revoke happened strictly after, in real execution order
  // — silently defeating the >= check and letting a just-revoked grant/resume
  // through. Millisecond-resolution timestamps could also collide (two
  // events in the same ms), which the >= check cannot then order correctly
  // either way. nextSeq() is immune to both: it only ever increases, and
  // every call returns a distinct value.
  private revokedAt = new Map<string, number>();
  private handlers = new Set<(env: AnyEnvelope, userId: string) => void>();
  private seq = 0;
  /** Monotonic, strictly-increasing sequence number — see revokedAt's comment. */
  private nextSeq(): number {
    this.seq += 1;
    return this.seq;
  }
  // R5-7: count of handleHello calls started but not yet settled. The
  // pendingConnections cap alone bounds SOCKETS, not verification work: the
  // hello timeout (and a client disconnect) free a socket's pending slot
  // while its handleHello — possibly parked forever inside an external
  // verifySession/validatePairingToken — remains outstanding. Without this
  // counter, an attacker could accumulate unbounded in-flight verification
  // tasks one timeout-cycle at a time. Gated at connection accept AND at
  // hello start; decremented only when handleHello actually settles.
  private outstandingHellos = 0;

  constructor(opts: WsHubOptions) {
    this.instance = opts.instance;
    this.channels = opts.channels ?? [];
    this.host = opts.host ?? '127.0.0.1';
    this.portOpt = opts.port ?? 0;
    this.store = opts.store ?? new MemoryCredentialStore({ provisionalSessionTtlMs: opts.provisionalSessionTtlMs });
    this.pairingTtlMs = opts.pairingTtlMs ?? 300_000;
    this.maxAttempts = opts.pairingAttemptsPerMinute ?? 10;
    this.helloTimeoutMs = opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS;
    this.maxPendingConnections = opts.maxPendingConnections ?? DEFAULT_MAX_PENDING_CONNECTIONS;
    this.maxPayloadBytes = opts.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
    this.staticDir = opts.staticDir ?? null;
    this.vapidPublicKey = opts.vapidPublicKey ?? null;
    this.validatePairingToken = opts.validatePairingToken ?? null;
  }

  async start(): Promise<{ port: number }> {
    this.server = createServer((req, res) => this.serveHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server, maxPayload: this.maxPayloadBytes });
    this.wss.on('connection', (ws, req) => {
      // R3-10: cap concurrent pre-auth connections BEFORE tracking this one,
      // so an attacker opening unlimited sockets and never sending hello
      // cannot exhaust server resources — legitimate authenticated sockets
      // (already moved out of pendingConnections by attach()) are unaffected.
      // R5-7: outstandingHellos is part of the same gate — a timed-out
      // socket frees its pending slot, but its verification may still be
      // outstanding; accepting new connections against only the socket
      // count let verification work grow without bound.
      if (
        this.pendingConnections.size >= this.maxPendingConnections
        || this.outstandingHellos >= this.maxPendingConnections
      ) {
        ws.close(4503, 'server busy');
        return;
      }
      this.pendingConnections.add(ws);
      // `ws` emits frame-level errors (e.g. a frame exceeding maxPayload) as
      // an 'error' event on the socket itself; Node's default EventEmitter
      // behavior for an 'error' event with no listener is to throw, which
      // crashes the whole process. Attached for the socket's whole lifetime
      // (not just pre-auth) — the same object is reused by attach().
      ws.on('error', () => { /* 'close' (e.g. 1009 for oversized frames) already informs the client */ });
      const ip = req.socket.remoteAddress ?? 'unknown';
      // #R6-11b: the deadline fires ONE timer that both closes the socket AND
      // aborts this controller. handleHello passes the signal into every
      // external await and bails on abort (before minting a session or
      // consuming a token), and a cooperative validatePairingToken cancels
      // its own I/O — so a timed-out hello's underlying work actually stops
      // rather than running on detached.
      const helloController = new AbortController();
      // R3-10: a connection that never sends a first message would otherwise
      // sit open indefinitely, holding the pending-connection slot forever.
      const helloTimer = setTimeout(() => {
        this.pendingConnections.delete(ws);
        if (!helloController.signal.aborted) helloController.abort();
        try { ws.close(4408, 'hello timeout'); } catch { /* already closing */ }
      }, this.helloTimeoutMs);
      ws.once('close', () => {
        clearTimeout(helloTimer);
        this.pendingConnections.delete(ws);
        // #R7-5: a client DISCONNECT during hello must also abort the
        // controller — otherwise a cooperative validatePairingToken stays
        // outstanding after the socket is gone, and an in-flight
        // createSession completes and mints an orphan session (the abort
        // checks in handleHello never fire). The timeout path aborts too;
        // this covers close-before-timeout.
        if (!helloController.signal.aborted) helloController.abort();
      });
      ws.once('message', (data) => {
        // R4-6: do NOT clear the timer or drop pre-auth accounting here —
        // handleHello is itself async (verifySession / validatePairingToken
        // / createSession can all await an external store), so a connection
        // that has merely sent ONE frame is not yet authenticated. Clearing
        // the timer and pendingConnections membership at this point let a
        // connection escape BOTH protections for the entire duration of that
        // async work: with cap 1, a 50ms timeout, and a blocked verifySession,
        // two sockets stayed open past 120ms while pendingConnections counted
        // zero. The socket now stays pending AND on the clock until
        // handleHello actually settles (granted, rejected, or errored) —
        // matching "keep the socket pending and timed until authentication
        // succeeds or it closes". A still-blocked verification past the
        // deadline is now correctly caught by the SAME helloTimer, which is
        // only cleared in the .finally() below.
        //
        // handleHello is async; a bare `void` call discards its promise with
        // no rejection handler. A store failure (verifySession/createSession
        // rejecting, e.g. a DB outage) then becomes an unhandled rejection,
        // which crashes the host process by default in modern Node. Contain
        // it: log server-side, close the socket rather than leaving it half-
        // handled.
        // R5-7: hard bound on hellos in flight, re-checked at hello start
        // too (a socket accepted while under the cap can reach here after
        // other hellos have since filled it).
        if (this.outstandingHellos >= this.maxPendingConnections) {
          clearTimeout(helloTimer);
          this.pendingConnections.delete(ws);
          try { ws.close(4503, 'server busy'); } catch { /* already closing */ }
          return;
        }
        this.outstandingHellos += 1;
        this.handleHello(ws, ip, data.toString(), helloController.signal)
          .catch((err) => {
            console.error('[raccoon] handleHello failed:', err);
            try { ws.close(1011, 'internal error'); } catch { /* already closing */ }
          })
          .finally(() => {
            this.outstandingHellos -= 1;
            clearTimeout(helloTimer);
            this.pendingConnections.delete(ws);
          });
      });
    });
    // Reject on listen failures (EADDRINUSE, EACCES) — without this the
    // 'error' event is unhandled and crashes the host process (found by the
    // live OpenClaw smoke test, where a double plugin registration
    // double-started the hub).
    await new Promise<void>((resolve, reject) => {
      const fail = (err: Error): void => reject(err);
      this.server!.once('error', fail);
      this.wss!.once('error', fail);
      this.server!.listen(this.portOpt, this.host, () => {
        this.server!.off('error', fail);
        this.wss!.off('error', fail);
        resolve();
      });
    });
    const addr = this.server.address();
    return { port: typeof addr === 'object' && addr ? addr.port : this.portOpt };
  }

  async stop(): Promise<void> {
    if (this.wss) for (const ws of this.wss.clients) ws.terminate();
    for (const set of this.byUser.values()) for (const ws of set) ws.terminate();
    this.byUser.clear();
    this.pendingConnections.clear();
    await new Promise<void>((resolve) => (this.wss ? this.wss.close(() => resolve()) : resolve()));
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.wss = null;
    this.server = null;
  }

  issuePairingToken(userId: string): string {
    const token = randomBytes(24).toString('base64url');
    this.pairingTokens.set(token, { userId, expiresAt: Date.now() + this.pairingTtlMs, used: false });
    return token;
  }

  async revokeUser(userId: string): Promise<void> {
    // Every synchronous state change happens FIRST, before the only await in
    // this method — so a redemption whose OWN synchronous token lookup runs at
    // any point after this line observes the fully-revoked state, not a
    // partially-applied one:
    this.revokedAt.set(userId, this.nextSeq());
    // Invalidate any unredeemed pairing tokens for this user (moved before the
    // await, not after): a redemption via the internal token map can only ever
    // observe "gone" or "not yet revoked", never "still present, revoke in
    // progress".
    for (const [token, record] of this.pairingTokens) {
      if (record.userId === userId) this.pairingTokens.delete(token);
    }
    for (const ws of this.byUser.get(userId) ?? []) ws.close(4403, 'revoked');
    this.byUser.delete(userId);
    await this.store.revokeUser(userId);
  }

  onEnvelope(handler: (env: AnyEnvelope, userId: string) => void): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  sendToUser(userId: string, env: AnyEnvelope): boolean {
    const sockets = this.byUser.get(userId);
    if (!sockets || sockets.size === 0) return false;
    const data = JSON.stringify(env);
    for (const ws of sockets) ws.send(data);
    return true;
  }

  private serveHttp(req: IncomingMessage, res: ServerResponse): void {
    if (!this.staticDir) { res.statusCode = 404; res.end('not found'); return; }
    let pathname: string;
    try { pathname = decodeURIComponent(new URL(req.url ?? '/', 'http://local').pathname); }
    catch { res.statusCode = 400; res.end('bad path'); return; }
    if (pathname.includes('..')) { res.statusCode = 400; res.end('bad path'); return; }
    let rel = pathname === '/' ? '/index.html' : pathname;
    let file = normalize(join(this.staticDir, rel));
    if (!existsSync(file)) {
      if (extname(rel) === '') { rel = '/index.html'; file = join(this.staticDir, rel); }
      if (!existsSync(file)) { res.statusCode = 404; res.end('not found'); return; }
    }
    let body: Buffer;
    try {
      body = readFileSync(file);
    } catch {
      res.statusCode = 404;
      res.end('not found');
      return;
    }
    res.setHeader('content-type', MIME[extname(file)] ?? 'application/octet-stream');
    const cache = NO_STORE.has(rel)
      ? 'no-store'
      : rel.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600';
    res.setHeader('cache-control', cache);
    res.end(body);
  }

  private rateLimited(ip: string): boolean {
    const now = Date.now();
    const entry = this.attempts.get(ip);
    if (!entry || now > entry.resetAt) {
      this.attempts.set(ip, { count: 1, resetAt: now + 60_000 });
      return false;
    }
    entry.count += 1;
    return entry.count > this.maxAttempts;
  }

  private async handleHello(ws: WebSocket, ip: string, raw: string, signal: AbortSignal): Promise<void> {
    // #R6-11b: `signal` aborts when the hello deadline fires (helloTimer in
    // start(), which also closes the socket). Rather than RACING the deadline
    // and returning while this work runs on — which released the
    // outstandingHellos slot while a hung validator kept running, so new
    // hellos spun up unbounded concurrent validations, and delayed work still
    // minted an orphan session / burned a one-time token after the 4408 — we
    // await the real work and CHECK signal.aborted after every external await.
    // On abort the hello bails BEFORE creating a session or consuming a token.
    // The slot is released by the caller's .finally() only when THIS actually
    // settles, so a cooperative validator (which rejects on abort) frees its
    // slot, and a non-cooperative one that ignores the signal keeps it — a
    // true cap on underlying work, not a slot that frees while work continues.
    // Captured BEFORE anything else, including any await this call makes
    // (verifySession, validatePairingToken, createSession). A revoke stamped
    // at or after this instant — no matter which of those awaits it lands
    // during, or how an external store's own timing interleaves them — will
    // be caught by the single revokedAt check each path does right before
    // granting. See the revokedAt field comment for why one check suffices,
    // and for why this is a monotonic sequence number (#R4-8), not Date.now().
    const helloStartedAt = this.nextSeq();

    let hello: unknown;
    try { hello = JSON.parse(raw); } catch {
      ws.close(this.rateLimited(ip) ? 4429 : 4401, 'bad hello');
      return;
    }

    // Session resume: { session: string } — must not be rate-limited (legit reconnect)
    if (typeof hello === 'object' && hello !== null && 'session' in hello) {
      const presentedToken = String((hello as { session: unknown }).session);
      let userId = await this.store.verifySession(presentedToken);
      if (signal.aborted) return; // #R6-11b: deadline fired mid-verify — abandon, don't attach
      if (!userId) {
        // #P1-B: idempotent reconnect that COMPLETES a pending confirmation. The
        // token may be a PROVISIONAL session whose pair.confirm was lost in
        // transit (the client durably adopted it, then the confirm/ACK dropped).
        // A resume presenting the token is itself proof of durable client
        // adoption, so complete the confirmation (promote) and re-verify. This
        // does NOT resurrect a lost-grant orphan: a client that never received
        // the grant holds no token to present, so its provisional session is
        // never resumed and still TTL-reaps. confirmSession returns false for an
        // unknown/revoked/expired token (it reaps an expired one), so those
        // still fail closed.
        const promoted = await this.store.confirmSession(presentedToken).catch(() => false);
        if (signal.aborted) return;
        if (promoted) userId = await this.store.verifySession(presentedToken);
        if (signal.aborted) return;
        if (!userId) { ws.close(4401, 'bad session'); return; }
      }
      // The store round-trip above has no ordering guarantee against a
      // concurrent revokeUser() for a REAL (non-in-memory) store: it could
      // resolve "valid" for a session that is being invalidated right now.
      // Without this check a resumed connection could attach and go live for
      // an already-revoked user.
      const revokedAt = this.revokedAt.get(userId);
      if (revokedAt !== undefined && revokedAt >= helloStartedAt) {
        // #R5-10: scope the cleanup to THE SESSION THIS HELLO PRESENTED. A
        // user-wide revokeUser() here also deleted any legitimate session
        // created for the same user AFTER the revoke (an immediate re-pair)
        // — this stale hello has no business touching those. Fallback to
        // user-wide only for stores without revokeSession (over-revoking is
        // the safe direction for a revoked user's stale cleanup).
        await (this.store.revokeSession?.(presentedToken) ?? this.store.revokeUser(userId)).catch(() => {});
        ws.close(4401, 'revoked during resume');
        return;
      }
      // R4-6: the socket may have closed WHILE this awaited (e.g. the
      // client disconnected, or the pre-auth helloTimer fired because this
      // took longer than helloTimeoutMs — that timer is no longer cleared
      // early, see the 'message' handler in start()). attach() on a dead
      // socket would register close/message listeners AFTER 'close' already
      // fired, leaving a stale entry in byUser that nothing ever cleans up
      // — and the unguarded ws.send() right after would throw synchronously.
      if (ws.readyState !== ws.OPEN) return;
      this.attach(ws, userId);
      ws.send(JSON.stringify({ ok: true, userId }));
      return;
    }

    // All other pairing-path frames count toward the rate limit.
    if (this.rateLimited(ip)) { ws.close(4429, 'rate limited'); return; }

    // Pairing: a pair.request envelope.
    const env = tryParseEnvelope(hello);
    if (!env || env.kind !== 'pair.request') { ws.close(4401, 'expected pair.request'); return; }

    let grantUserId: string | null = null;
    if (this.validatePairingToken) {
      // #R6-11: pass the abort signal so a cooperative validator cancels its
      // own I/O when the hello deadline fires.
      grantUserId = await this.validatePairingToken(env.payload.token, signal).catch(() => null);
    }
    // #R6-11b: if the deadline fired during validation, bail BEFORE consuming
    // the built-in one-time token or minting a session — otherwise an
    // abandoned (already 4408-closed) hello burned a token and created an
    // orphan session, because the readyState check came only at the very end.
    if (signal.aborted) return;
    let builtinToken: PairingToken | null = null;
    if (!grantUserId) {
      const record = this.pairingTokens.get(env.payload.token);
      if (!record || record.used || Date.now() > record.expiresAt) { ws.close(4401, 'bad token'); return; }
      record.used = true; // consume synchronously to keep single-use against a concurrent replay
      builtinToken = record;
      grantUserId = record.userId;
    }

    const sessionToken = await this.store.createSession(grantUserId);
    // #R6-11b/#R8-6: the connection may have gone away during createSession —
    // EITHER the deadline fired (signal.aborted) OR the client started closing
    // before the close-event abort callback ran (signal NOT yet aborted, but
    // the socket is no longer OPEN). Both mean we now hold a session for an
    // abandoned connection. Treat them identically: revoke ONLY this
    // just-minted session (never user-wide revokeUser — this user was NOT
    // revoked, so over-revoking would kill a concurrent legitimate session;
    // a store without revokeSession leaves this orphan to TTL-expire), and
    // un-consume the one-time token so the client can retry with the SAME QR.
    if (grantAbandoned(signal.aborted, ws.readyState === ws.OPEN)) {
      await this.store.revokeSession?.(sessionToken).catch(() => {});
      if (builtinToken) builtinToken.used = false;
      return;
    }
    // One check, using the ORIGINAL helloStartedAt baseline (not a snapshot
    // re-captured after grantUserId resolved): revokedAt only ever increases,
    // so this catches a revoke landing ANYWHERE in this call — during
    // validatePairingToken's external await, during createSession, or
    // between them — not just the narrower createSession-only window a
    // post-resolution snapshot would have covered.
    const revokedAt = this.revokedAt.get(grantUserId);
    if (revokedAt !== undefined && revokedAt >= helloStartedAt) {
      // revokeUser() ran at some point during this call. The store now holds
      // a session for a revoked user — kill it immediately and refuse to
      // grant rather than complete the race with a live session.
      // #R5-10: kill THE SESSION THIS CALL JUST MINTED, not every session
      // the user has — see the matching comment in the resume path above.
      await (this.store.revokeSession?.(sessionToken) ?? this.store.revokeUser(grantUserId)).catch(() => {});
      ws.close(4401, 'revoked during redemption');
      return;
    }
    // (The not-OPEN case is handled together with signal.aborted above, #R8-6,
    // where it also revokes the just-minted session and un-burns the token.)
    // #P1-C: pass the PROVISIONAL sessionToken so attach() can promote it to
    // durable when this same socket sends pair.confirm. Until then the session
    // is non-resumable (verifySession returns null) and TTL-reaped — so a
    // client that closed in the lost-grant window (grantAbandoned missed it)
    // still can't resume an orphan.
    this.attach(ws, grantUserId, sessionToken);
    ws.send(JSON.stringify(createEnvelope('pair.grant', {
      from: 'system',
      to: userAddress(grantUserId),
      channel: 'pairing',
      payload: {
        sessionToken,
        userId: grantUserId,
        instance: this.instance,
        channels: this.channels,
        ...(this.vapidPublicKey ? { vapidPublicKey: this.vapidPublicKey } : {}),
      },
    })));
  }

  private attach(ws: WebSocket, userId: string, provisionalToken?: string): void {
    let set = this.byUser.get(userId);
    if (!set) { set = new Set(); this.byUser.set(userId, set); }
    set.add(ws);
    ws.on('close', () => {
      set!.delete(ws);
      // Only delete the map entry if it STILL points at THIS closure's Set. A
      // revoke (or any path that removes the map entry synchronously, e.g.
      // revokeUser) can be followed by a fresh attach() for the same userId
      // before this socket's delayed close event fires; that attach() creates
      // a NEW Set. Without this check, this stale close handler emptying its
      // OWN (now-orphaned) Set would still `byUser.delete(userId)` and wipe
      // out the replacement Set, disconnecting the just-reconnected user.
      if (set!.size === 0 && this.byUser.get(userId) === set) this.byUser.delete(userId);
    });
    ws.on('message', (data) => { void this.onSocketMessage(ws, userId, data, provisionalToken); });
  }

  private async onSocketMessage(ws: WebSocket, userId: string, data: unknown, provisionalToken?: string): Promise<void> {
    // R5-6: current byUser membership IS the authorization, checked per
    // frame — not the fact that this listener was once attached.
    // revokeUser() removes the socket from byUser synchronously but only
    // STARTS a graceful close; until the close handshake completes, frames
    // (including ones already buffered in flight) still reach this
    // listener. Without this gate they were dispatched as the revoked
    // user: a buffered push.subscribe could recreate a subscription
    // clearForUser had just removed, and ordinary frames could run whole
    // agent turns post-revoke.
    if (!this.byUser.get(userId)?.has(ws)) return;
    let parsed: unknown;
    try { parsed = JSON.parse(String(data)); } catch { return; }
    const env = tryParseEnvelope(parsed);
    if (!env) return;
    // #P1-C/#R10: the client's confirmation that it adopted the grant. Promote
    // the PROVISIONAL session to durable, but ONLY if the token matches THIS
    // socket's own provisional token (no cross-session promotion). ACK with
    // pair.confirmed ONLY on a REAL promotion (an unexpired session) so the
    // client reports "paired" only when the session will actually resume.
    // Never forwarded to app handlers.
    if (env.kind === 'pair.confirm') {
      if (provisionalToken && env.payload.sessionToken === provisionalToken) {
        const promoted = await this.store.confirmSession(provisionalToken).catch(() => false);
        if (promoted && this.byUser.get(userId)?.has(ws) && ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(createEnvelope('pair.confirmed', {
            from: 'system', to: userAddress(userId), channel: 'pairing',
            payload: { sessionToken: provisionalToken },
          })));
        }
      }
      return;
    }
    for (const h of this.handlers) h(env, userId);
  }
}
