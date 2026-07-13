import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { FileCredentialStore } from './file-credential-store.js';

const dirs: string[] = [];
const openStores: FileCredentialStore[] = [];
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'raccoon-fcs-'));
  dirs.push(d);
  return join(d, 'sessions.json');
}
function store(path: string, ttl?: number): FileCredentialStore {
  const s = new FileCredentialStore(ttl === undefined ? { path } : { path, provisionalSessionTtlMs: ttl });
  openStores.push(s);
  return s;
}
afterEach(() => {
  for (const s of openStores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('FileCredentialStore', () => {
  it('a confirmed session survives a new store instance on the same file (restart resume)', async () => {
    const path = tmpFile();
    const first = store(path);
    const token = await first.createSession('u1');
    expect(await first.confirmSession(token)).toBe(true);
    first.close(); // release the lock before the "restarted" instance

    const restarted = store(path);
    expect(await restarted.verifySession(token)).toBe('u1');
  });

  it('an UNCONFIRMED provisional session is not resumable and is not persisted across a restart', async () => {
    const path = tmpFile();
    const first = store(path);
    const token = await first.createSession('u1');
    expect(await first.verifySession(token)).toBeNull();
    first.close();

    const restarted = store(path);
    expect(await restarted.verifySession(token)).toBeNull();
  });

  it('a revoked session does not resume after a restart', async () => {
    const path = tmpFile();
    const first = store(path);
    const token = await first.createSession('u1');
    await first.confirmSession(token);
    await first.revokeUser('u1');
    first.close();

    const restarted = store(path);
    expect(await restarted.verifySession(token)).toBeNull();
  });

  it('confirmSession is idempotent and returns false for an unknown token', async () => {
    const first = store(tmpFile());
    const token = await first.createSession('u1');
    expect(await first.confirmSession(token)).toBe(true);
    expect(await first.confirmSession(token)).toBe(true);
    expect(await first.confirmSession('nope')).toBe(false);
  });

  it('a corrupt store file is treated as empty rather than crashing on boot', async () => {
    const path = tmpFile();
    writeFileSync(path, '{ not valid json');
    const s = store(path);
    expect(await s.verifySession('anything')).toBeNull();
  });

  // ---- persistence-failure correctness (P1-A) ------------------------------

  it('confirmSession THROWS and rolls back when the atomic write fails — no durable confirm', async () => {
    const path = tmpFile();
    const s = store(path);
    const token = await s.createSession('u1');
    // Sabotage the write: a directory where persist wants to write the temp file.
    mkdirSync(`${path}.tmp`, { recursive: true });
    await expect(s.confirmSession(token)).rejects.toThrow();
    // Rolled back: not reported durable (verify still null), and the promotion
    // did not land on disk (a persist that threw wrote nothing atomically).
    expect(await s.verifySession(token)).toBeNull();
  });

  it('confirmSession THROWS when the atomic rename fails (store path is a directory)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'raccoon-fcs-'));
    dirs.push(dir);
    const path = join(dir, 'sessions.json');
    mkdirSync(path, { recursive: true }); // rename(tmp -> path) fails: path is a directory
    const s = store(path);
    const token = await s.createSession('u1');
    await expect(s.confirmSession(token)).rejects.toThrow();
    expect(await s.verifySession(token)).toBeNull();
  });

  it('revokeUser THROWS (never a silent durable revoke) and rolls back when the write fails', async () => {
    const path = tmpFile();
    const s = store(path);
    const token = await s.createSession('u1');
    await s.confirmSession(token); // durable
    // Sabotage the NEXT persist so the revoke cannot commit.
    mkdirSync(`${path}.tmp`, { recursive: true });
    await expect(s.revokeUser('u1')).rejects.toThrow();
    // Rolled back: the token is still valid (consistent with what remains on
    // disk) — the store did NOT report a durable revocation it couldn't commit,
    // so the credential can't silently resurrect on the next restart.
    expect(await s.verifySession(token)).toBe('u1');
  });

  // ---- single-writer exclusivity (P1-A) ------------------------------------

  it('a second store on the same path fails fast while the first holds the lock', async () => {
    const path = tmpFile();
    const first = store(path);
    expect(() => new FileCredentialStore({ path })).toThrow(/locked by another live process|single writer/i);
    first.close();
    const second = store(path); // lock released → acquires cleanly
    expect(second).toBeTruthy();
  });

  // ---- P1(r3): use-after-close, canonicalization, owner-token lock ---------

  it('every operation throws after close()', async () => {
    const s = store(tmpFile());
    const token = await s.createSession('u1');
    await s.confirmSession(token);
    s.close();
    await expect(s.createSession('u2')).rejects.toThrow(/after close/);
    await expect(s.confirmSession(token)).rejects.toThrow(/after close/);
    await expect(s.verifySession(token)).rejects.toThrow(/after close/);
    await expect(s.revokeUser('u1')).rejects.toThrow(/after close/);
    await expect(s.revokeSession(token)).rejects.toThrow(/after close/);
  });

  it('a closed store cannot clobber a successor that took the lock (use-after-close)', async () => {
    const path = tmpFile();
    const a = store(path);
    const tokenA = await a.createSession('a'); await a.confirmSession(tokenA);
    a.close(); // A releases the lock

    const b = store(path); // B legitimately acquires
    const tokenB = await b.createSession('b'); await b.confirmSession(tokenB);

    // A is closed — its stale revoke must be REFUSED, not clobber B's file.
    await expect(a.revokeUser('a')).rejects.toThrow(/after close/);
    b.close();

    const fresh = store(path);
    expect(await fresh.verifySession(tokenB)).toBe('b'); // B's session survived
  });

  it('path aliases canonicalize to ONE lock identity (dir/x vs dir/./x)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'raccoon-fcs-'));
    dirs.push(dir);
    const a = store(join(dir, 'sessions.json'));
    // A different TEXTUAL path for the SAME file must not acquire a second lock.
    expect(() => new FileCredentialStore({ path: join(dir, '.', 'sessions.json') }))
      .toThrow(/locked|single writer/i);
    a.close();
  });

  it('close() only unlinks a lock it still owns (a reclaimed lock survives)', () => {
    const path = tmpFile();
    const canonicalLock = join(realpathSync(dirname(resolve(path))), basename(path)) + '.lock';
    const a = store(path);
    // Simulate a successor having reclaimed the lock (foreign owner token).
    writeFileSync(canonicalLock, JSON.stringify({ pid: process.pid, owner: 'someone-else' }));
    a.close(); // must NOT remove a lock it no longer owns
    expect(existsSync(canonicalLock)).toBe(true);
    rmSync(canonicalLock, { force: true });
  });
});
