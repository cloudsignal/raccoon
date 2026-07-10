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

export interface WsHubOptions {
  instance: string;
  host?: string;
  port?: number;
  store?: CredentialStore;
  channels?: string[];
  pairingTtlMs?: number;
  pairingAttemptsPerMinute?: number;
  /** Serve a static SPA build (the Raccoon app dist/) over plain HTTP on the same port. */
  staticDir?: string;
  /** Advertised in pair.grant so clients can register web-push subscriptions. */
  vapidPublicKey?: string;
  /** External pairing validation (e.g. enrollment tokens in a host DB).
   *  Checked before the built-in in-memory token map. Return the userId
   *  to grant, or null to reject. */
  validatePairingToken?: (token: string) => Promise<string | null>;
}

export class WsHub {
  readonly instance: string;
  readonly channels: string[];
  private readonly host: string;
  private readonly portOpt: number;
  private readonly store: CredentialStore;
  private readonly pairingTtlMs: number;
  private readonly maxAttempts: number;
  private readonly staticDir: string | null;
  private readonly vapidPublicKey: string | null;
  private readonly validatePairingToken: ((token: string) => Promise<string | null>) | null;

  private server: Server | null = null;
  private wss: WebSocketServer | null = null;
  private pairingTokens = new Map<string, PairingToken>();
  private attempts = new Map<string, { count: number; resetAt: number }>();
  private byUser = new Map<string, Set<WebSocket>>();
  // Set by revokeUser() (Date.now() at revoke time). handleHello captures its
  // OWN start time BEFORE any await (including the external validatePairingToken
  // call, whose duration we don't control) and, right before granting, checks
  // whether this user has been revoked at or after that start time. A single
  // check suffices because revokedAt only ever increases: a revoke landing at
  // ANY point during this handleHello call — before grantUserId is even known,
  // during createSession(), or anywhere between — is stamped with a time >= the
  // captured start and is caught by the one comparison. This also closes the
  // external-validator gap an epoch-only check could not: an epoch snapshot
  // taken only after grantUserId resolves cannot see a revoke that completed
  // (and already bumped the epoch) before that snapshot, so a genuinely
  // concurrent revoke during that external await passed through undetected.
  private revokedAt = new Map<string, number>();
  private handlers = new Set<(env: AnyEnvelope, userId: string) => void>();

  constructor(opts: WsHubOptions) {
    this.instance = opts.instance;
    this.channels = opts.channels ?? [];
    this.host = opts.host ?? '127.0.0.1';
    this.portOpt = opts.port ?? 0;
    this.store = opts.store ?? new MemoryCredentialStore();
    this.pairingTtlMs = opts.pairingTtlMs ?? 300_000;
    this.maxAttempts = opts.pairingAttemptsPerMinute ?? 10;
    this.staticDir = opts.staticDir ?? null;
    this.vapidPublicKey = opts.vapidPublicKey ?? null;
    this.validatePairingToken = opts.validatePairingToken ?? null;
  }

  async start(): Promise<{ port: number }> {
    this.server = createServer((req, res) => this.serveHttp(req, res));
    this.wss = new WebSocketServer({ server: this.server });
    this.wss.on('connection', (ws, req) => {
      const ip = req.socket.remoteAddress ?? 'unknown';
      ws.once('message', (data) => {
        // handleHello is async; a bare `void` call discards its promise with
        // no rejection handler. A store failure (verifySession/createSession
        // rejecting, e.g. a DB outage) then becomes an unhandled rejection,
        // which crashes the host process by default in modern Node. Contain
        // it: log server-side, close the socket rather than leaving it half-
        // handled.
        this.handleHello(ws, ip, data.toString()).catch((err) => {
          console.error('[raccoon] handleHello failed:', err);
          try { ws.close(1011, 'internal error'); } catch { /* already closing */ }
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
    this.revokedAt.set(userId, Date.now());
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

  private async handleHello(ws: WebSocket, ip: string, raw: string): Promise<void> {
    // Captured BEFORE anything else, including any await this call makes
    // (verifySession, validatePairingToken, createSession). A revoke stamped
    // at or after this instant — no matter which of those awaits it lands
    // during, or how an external store's own timing interleaves them — will
    // be caught by the single revokedAt check each path does right before
    // granting. See the revokedAt field comment for why one check suffices.
    const helloStartedAt = Date.now();

    let hello: unknown;
    try { hello = JSON.parse(raw); } catch {
      ws.close(this.rateLimited(ip) ? 4429 : 4401, 'bad hello');
      return;
    }

    // Session resume: { session: string } — must not be rate-limited (legit reconnect)
    if (typeof hello === 'object' && hello !== null && 'session' in hello) {
      const userId = await this.store.verifySession(String((hello as { session: unknown }).session));
      if (!userId) { ws.close(4401, 'bad session'); return; }
      // The store round-trip above has no ordering guarantee against a
      // concurrent revokeUser() for a REAL (non-in-memory) store: it could
      // resolve "valid" for a session that is being invalidated right now.
      // Without this check a resumed connection could attach and go live for
      // an already-revoked user.
      const revokedAt = this.revokedAt.get(userId);
      if (revokedAt !== undefined && revokedAt >= helloStartedAt) {
        await this.store.revokeUser(userId).catch(() => {});
        ws.close(4401, 'revoked during resume');
        return;
      }
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
      grantUserId = await this.validatePairingToken(env.payload.token).catch(() => null);
    }
    if (!grantUserId) {
      const record = this.pairingTokens.get(env.payload.token);
      if (!record || record.used || Date.now() > record.expiresAt) { ws.close(4401, 'bad token'); return; }
      record.used = true;
      grantUserId = record.userId;
    }

    const sessionToken = await this.store.createSession(grantUserId);
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
      await this.store.revokeUser(grantUserId).catch(() => {});
      ws.close(4401, 'revoked during redemption');
      return;
    }
    this.attach(ws, grantUserId);
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

  private attach(ws: WebSocket, userId: string): void {
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
    ws.on('message', (data) => {
      let parsed: unknown;
      try { parsed = JSON.parse(data.toString()); } catch { return; }
      const env = tryParseEnvelope(parsed);
      if (!env) return;
      for (const h of this.handlers) h(env, userId);
    });
  }
}
