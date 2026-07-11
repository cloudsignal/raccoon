import { randomBytes } from 'node:crypto';

// #P1-C: the default TTL for a PROVISIONAL (unconfirmed) session. A client that
// received a grant but never confirmed it (its socket closed in the lost-grant
// window) is reaped after this, so an abandoned pairing can't linger.
const DEFAULT_PROVISIONAL_SESSION_TTL_MS = 30_000;

export interface CredentialStore {
  /**
   * Mint a session for a freshly-paired user. #P1-C: the returned session is
   * PROVISIONAL — verifySession() will NOT resume it until confirmSession()
   * has been called for its token. This closes the lost-grant window: a client
   * whose socket closed while the pair.grant was in flight (its close frame not
   * yet seen by the server) never confirms, so its session is never resumable
   * and is reaped by the store's mandatory provisional TTL — instead of
   * becoming a live orphan that also burned a one-time pairing token.
   */
  createSession(userId: string): Promise<string>;
  /**
   * Promote a provisional session to durable/resumable (#P1-C). Called when the
   * hub receives the client's pair.confirm for this token. Returns whether an
   * UNEXPIRED session was actually promoted (#R10): false for an unknown token
   * OR one whose provisional TTL already lapsed (which it also reaps) — the hub
   * ACKs (pair.confirmed) only on a true promotion, so the client never reports
   * "paired" on a session that will never resume. Idempotent: an
   * already-confirmed token returns true.
   */
  confirmSession(token: string): Promise<boolean>;
  /** Resolve a token to its userId — ONLY for a CONFIRMED, non-expired session
   *  (#P1-C). Returns null for an unknown, unconfirmed, or expired-provisional
   *  token. */
  verifySession(token: string): Promise<string | null>;
  revokeUser(userId: string): Promise<void>;
  /**
   * Revoke ONE session by its token (#R5-10). Optional: implement it so the
   * hub's stale-authentication cleanup — a hello that raced a revokeUser()
   * and must undo the session it just minted/validated — can target exactly
   * that session. Without it the hub falls back to user-wide revokeUser(),
   * which also deletes any LEGITIMATE session created for the same user
   * after the original revoke (e.g. an immediate re-pair).
   */
  revokeSession?(token: string): Promise<void>;
}

interface SessionRecord { userId: string; confirmed: boolean; expiresAt: number }

export class MemoryCredentialStore implements CredentialStore {
  private sessions = new Map<string, SessionRecord>(); // token -> record
  private readonly provisionalTtlMs: number;

  constructor(opts: { provisionalSessionTtlMs?: number } = {}) {
    this.provisionalTtlMs = opts.provisionalSessionTtlMs ?? DEFAULT_PROVISIONAL_SESSION_TTL_MS;
  }

  async createSession(userId: string): Promise<string> {
    this.sweepExpiredProvisional();
    const token = randomBytes(32).toString('base64url');
    // #P1-C: provisional until confirmed; expires if never confirmed.
    this.sessions.set(token, { userId, confirmed: false, expiresAt: Date.now() + this.provisionalTtlMs });
    return token;
  }

  async confirmSession(token: string): Promise<boolean> {
    const rec = this.sessions.get(token);
    if (!rec) return false;
    if (rec.confirmed) return true; // idempotent
    // #R10: do NOT promote an already-EXPIRED provisional session — verifySession
    // stops consulting expiry once confirmed, so promoting an expired record
    // would resurrect it as durable. Reap it and report no promotion.
    if (Date.now() > rec.expiresAt) { this.sessions.delete(token); return false; }
    rec.confirmed = true; // durable; expiry no longer consulted (see verifySession)
    return true;
  }

  async verifySession(token: string): Promise<string | null> {
    const rec = this.sessions.get(token);
    if (!rec) return null;
    if (!rec.confirmed) {
      // #P1-C: a provisional session is NOT resumable. Reap it on access if it
      // has also expired, so an abandoned pairing can't accumulate.
      if (Date.now() > rec.expiresAt) this.sessions.delete(token);
      return null;
    }
    return rec.userId;
  }

  async revokeUser(userId: string): Promise<void> {
    for (const [token, rec] of this.sessions) {
      if (rec.userId === userId) this.sessions.delete(token);
    }
  }

  async revokeSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }

  /** Drop provisional sessions whose TTL has elapsed. Opportunistic (called on
   *  createSession) — no timer lifecycle to manage. */
  private sweepExpiredProvisional(): void {
    const now = Date.now();
    for (const [token, rec] of this.sessions) {
      if (!rec.confirmed && now > rec.expiresAt) this.sessions.delete(token);
    }
  }
}
