import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type { CredentialStore } from './credential-store.js';

const DEFAULT_PROVISIONAL_SESSION_TTL_MS = 30_000;

interface LockRecord { pid: number; owner: string }

// Locks this process holds (canonical lockPath -> our owner token), cleaned up
// on exit. Owner-aware: only unlink a lock the file still says is OURS, so a
// stale instance never removes a successor's lock.
const heldLocks = new Map<string, string>();
let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  process.on('exit', () => {
    for (const [lockPath, owner] of heldLocks) unlinkOwnLock(lockPath, owner);
  });
}

function readLock(lockPath: string): LockRecord | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockRecord>;
    if (typeof parsed.owner === 'string' && typeof parsed.pid === 'number') return { pid: parsed.pid, owner: parsed.owner };
  } catch { /* missing / unreadable / legacy */ }
  return null;
}

/** Unlink a lock ONLY if it still belongs to `owner` — never clobber a lock a
 *  successor legitimately reclaimed after this instance went stale. */
function unlinkOwnLock(lockPath: string, owner: string): void {
  const rec = readLock(lockPath);
  if (rec && rec.owner !== owner) return; // reclaimed by someone else — leave it
  try { unlinkSync(lockPath); } catch { /* already gone */ }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (err) { return (err as NodeJS.ErrnoException).code === 'EPERM'; } // EPERM = exists, not ours
}

/**
 * A {@link CredentialStore} that PERSISTS confirmed sessions to a JSON file so
 * they survive a process restart. Correctness under persistence failure is the
 * whole point here (a swallowed write error must never masquerade as a durable
 * confirm or a durable revoke):
 *
 * - Writes are atomic (temp file + rename) and mode 0600 (bearer tokens).
 * - A persistence failure PROPAGATES. confirmSession() only reports success
 *   after the disk commit succeeds (on failure it rolls the promotion back and
 *   throws — WsHub treats that as "not promoted", so no pair.confirmed ACK).
 * - revokeUser()/revokeSession() NEVER report a durable revocation while the
 *   token remains on disk: if the commit fails they roll the in-memory removal
 *   back (so a retry re-attempts it) and throw, instead of silently succeeding
 *   and letting the revoked token resurrect on the next restart.
 * - Single-writer: the constructor acquires an exclusive lock (`<path>.lock`,
 *   O_EXCL). A second live process on the same path fails fast rather than
 *   silently clobbering the file (which could lose sessions or resurrect a
 *   revocation). A stale lock from a dead process is reclaimed. Call close()
 *   (or exit the process) to release.
 *
 * Only CONFIRMED sessions are persisted; provisional (unconfirmed) sessions are
 * in-memory only (short-lived, re-pair on restart). A corrupt file loads as
 * empty rather than crashing the connector on boot.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly confirmed = new Map<string, string>(); // token -> userId (durable, persisted)
  private readonly provisional = new Map<string, { userId: string; expiresAt: number }>(); // in-memory only
  private readonly path: string;
  private readonly lockPath: string;
  private readonly ownerToken: string;
  private readonly provisionalTtlMs: number;
  private closed = false;

  constructor(opts: { path: string; provisionalSessionTtlMs?: number }) {
    // Canonicalize so path aliases (dir/x, dir/./x, symlinks, relative) resolve
    // to ONE identity — otherwise two "different" paths could both acquire the
    // lock. realpath the (created) DIR, then join the basename (the store file
    // itself may not exist yet).
    const abs = resolve(opts.path);
    mkdirSync(dirname(abs), { recursive: true });
    this.path = join(realpathSync(dirname(abs)), basename(abs));
    this.lockPath = `${this.path}.lock`;
    this.ownerToken = randomBytes(16).toString('hex'); // unguessable per-instance lock owner
    this.provisionalTtlMs = opts.provisionalSessionTtlMs ?? DEFAULT_PROVISIONAL_SESSION_TTL_MS;
    this.acquireLock();
    this.load();
    installExitHook();
  }

  private acquireLock(): void {
    // In-process: another live store instance in THIS process already holds the
    // (canonical) lock — same pid, so the file-based stale check can't tell it
    // apart from our own leftover.
    if (heldLocks.has(this.lockPath)) {
      throw new Error(
        `FileCredentialStore: ${this.path} is already locked by another store instance in this process; ` +
        'a session store must have a single writer.',
      );
    }
    const record = JSON.stringify({ pid: process.pid, owner: this.ownerToken });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writeFileSync(this.lockPath, record, { flag: 'wx', mode: 0o600 }); // O_EXCL
        heldLocks.set(this.lockPath, this.ownerToken);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
        const held = readLock(this.lockPath);
        if (held && held.owner !== this.ownerToken && held.pid !== process.pid && isProcessAlive(held.pid)) {
          throw new Error(
            `FileCredentialStore: ${this.path} is locked by another live process (pid ${held.pid}); ` +
            'a session store must have a single writer. Point each connector account at its own store path.',
          );
        }
        try { unlinkSync(this.lockPath); } catch { /* raced away */ } // stale (dead owner / our leftover) — reclaim
      }
    }
    throw new Error(`FileCredentialStore: could not acquire the lock at ${this.lockPath}`);
  }

  /** Release the exclusive lock (only if it is still OURS). Idempotent. After
   *  close() every operation throws — a closed store must never write again. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    heldLocks.delete(this.lockPath);
    unlinkOwnLock(this.lockPath, this.ownerToken);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error(`FileCredentialStore: operation after close() — this instance no longer owns ${this.path}`);
    }
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
      // Corrupt/unreadable store → start empty (a re-pair restores sessions);
      // crashing the connector on boot would be worse.
    }
  }

  /** Atomically write the confirmed set. THROWS on any fs failure — callers must
   *  treat a throw as "not durable" and roll their in-memory change back. */
  private persist(): void {
    const obj: Record<string, string> = {};
    for (const [token, userId] of this.confirmed) obj[token] = userId;
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(obj), { mode: 0o600 });
    renameSync(tmp, this.path); // atomic replace — a crash mid-write cannot corrupt the live file
  }

  async createSession(userId: string): Promise<string> {
    this.assertOpen();
    this.sweepExpiredProvisional();
    const token = randomBytes(32).toString('base64url');
    this.provisional.set(token, { userId, expiresAt: Date.now() + this.provisionalTtlMs });
    return token; // provisional: not persisted until confirmed
  }

  async confirmSession(token: string): Promise<boolean> {
    this.assertOpen();
    if (this.confirmed.has(token)) return true; // idempotent
    const rec = this.provisional.get(token);
    if (!rec) return false;
    if (Date.now() > rec.expiresAt) { this.provisional.delete(token); return false; }
    // Promote in memory, then COMMIT to disk. Report success only after the
    // commit lands; on failure roll back and throw so the promotion is not
    // reported durable (WsHub's confirmSession().catch(()=>false) => no ACK).
    this.confirmed.set(token, rec.userId);
    this.provisional.delete(token);
    try {
      this.persist();
    } catch (err) {
      this.confirmed.delete(token);
      this.provisional.set(token, rec); // still TTL-bounded; a retry can re-confirm
      throw err;
    }
    return true;
  }

  async verifySession(token: string): Promise<string | null> {
    this.assertOpen();
    const userId = this.confirmed.get(token);
    if (userId !== undefined) return userId;
    const rec = this.provisional.get(token);
    if (rec && Date.now() > rec.expiresAt) this.provisional.delete(token);
    return null; // provisional sessions are never resumable
  }

  async revokeUser(userId: string): Promise<void> {
    this.assertOpen();
    const removed: Array<[string, string]> = [];
    for (const [token, uid] of this.confirmed) if (uid === userId) { removed.push([token, uid]); this.confirmed.delete(token); }
    for (const [token, rec] of this.provisional) if (rec.userId === userId) this.provisional.delete(token);
    if (removed.length === 0) return; // nothing durable to remove
    try {
      this.persist();
    } catch (err) {
      for (const [token, uid] of removed) this.confirmed.set(token, uid); // roll back — never claim a durable revoke while the token is still on disk
      throw err;
    }
  }

  async revokeSession(token: string): Promise<void> {
    this.assertOpen();
    const userId = this.confirmed.get(token);
    this.provisional.delete(token);
    if (userId === undefined) return; // nothing durable to remove
    this.confirmed.delete(token);
    try {
      this.persist();
    } catch (err) {
      this.confirmed.set(token, userId); // roll back — see revokeUser
      throw err;
    }
  }

  private sweepExpiredProvisional(): void {
    const now = Date.now();
    for (const [token, rec] of this.provisional) if (now > rec.expiresAt) this.provisional.delete(token);
  }
}
