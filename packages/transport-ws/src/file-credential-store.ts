import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { CredentialStore } from './credential-store.js';

const DEFAULT_PROVISIONAL_SESSION_TTL_MS = 30_000;

/**
 * A {@link CredentialStore} that PERSISTS confirmed sessions to a JSON file, so
 * they survive a process restart — the missing piece for production durability
 * (the in-memory MemoryCredentialStore loses every session when the connector
 * process bounces, forcing all paired devices to re-pair).
 *
 * Design:
 * - Only CONFIRMED (durable) sessions are written to disk. Provisional
 *   (unconfirmed) sessions are in-memory only: they are short-lived (a 30s TTL)
 *   and a restart mid-pairing legitimately means "scan the QR again", so there
 *   is nothing worth persisting there.
 * - Writes are atomic (temp file + rename) and the file is mode 0600 — it holds
 *   bearer session tokens.
 * - A corrupt/unreadable file is treated as empty (start fresh; a re-pair
 *   recovers) rather than crashing the connector on boot.
 *
 * Semantics match MemoryCredentialStore exactly (provisional-until-confirmed,
 * verify only confirmed + non-expired, idempotent confirm), so it is a drop-in
 * for WsHub's `store`.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly confirmed = new Map<string, string>(); // token -> userId (durable, persisted)
  private readonly provisional = new Map<string, { userId: string; expiresAt: number }>(); // in-memory only
  private readonly path: string;
  private readonly provisionalTtlMs: number;

  constructor(opts: { path: string; provisionalSessionTtlMs?: number }) {
    this.path = opts.path;
    this.provisionalTtlMs = opts.provisionalSessionTtlMs ?? DEFAULT_PROVISIONAL_SESSION_TTL_MS;
    this.load();
  }

  private load(): void {
    try {
      if (!existsSync(this.path)) return;
      const parsed: unknown = JSON.parse(readFileSync(this.path, 'utf8'));
      if (parsed && typeof parsed === 'object') {
        for (const [token, userId] of Object.entries(parsed as Record<string, unknown>)) {
          if (typeof userId === 'string' && userId.length > 0) this.confirmed.set(token, userId);
        }
      }
    } catch {
      // Corrupt/unreadable store → start empty. Losing durability is bad, but
      // crashing the connector on boot is worse; a re-pair restores sessions.
    }
  }

  private persist(): void {
    const obj: Record<string, string> = {};
    for (const [token, userId] of this.confirmed) obj[token] = userId;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
      renameSync(tmp, this.path); // atomic replace — a crash mid-write can't corrupt the live file
    } catch {
      // Best-effort: a failed write means the current process keeps its
      // in-memory sessions; only cross-restart durability is at risk.
    }
  }

  async createSession(userId: string): Promise<string> {
    this.sweepExpiredProvisional();
    const token = randomBytes(32).toString('base64url');
    this.provisional.set(token, { userId, expiresAt: Date.now() + this.provisionalTtlMs });
    return token; // provisional: NOT persisted until confirmed
  }

  async confirmSession(token: string): Promise<boolean> {
    if (this.confirmed.has(token)) return true; // idempotent
    const rec = this.provisional.get(token);
    if (!rec) return false;
    if (Date.now() > rec.expiresAt) { this.provisional.delete(token); return false; }
    this.provisional.delete(token);
    this.confirmed.set(token, rec.userId);
    this.persist(); // durable from here — survives restart
    return true;
  }

  async verifySession(token: string): Promise<string | null> {
    const userId = this.confirmed.get(token);
    if (userId !== undefined) return userId;
    const rec = this.provisional.get(token);
    if (rec && Date.now() > rec.expiresAt) this.provisional.delete(token);
    return null; // provisional sessions are never resumable
  }

  async revokeUser(userId: string): Promise<void> {
    let changed = false;
    for (const [token, uid] of this.confirmed) if (uid === userId) { this.confirmed.delete(token); changed = true; }
    for (const [token, rec] of this.provisional) if (rec.userId === userId) this.provisional.delete(token);
    if (changed) this.persist();
  }

  async revokeSession(token: string): Promise<void> {
    const had = this.confirmed.delete(token);
    this.provisional.delete(token);
    if (had) this.persist();
  }

  private sweepExpiredProvisional(): void {
    const now = Date.now();
    for (const [token, rec] of this.provisional) if (now > rec.expiresAt) this.provisional.delete(token);
  }
}
