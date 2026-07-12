import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FileCredentialStore } from './file-credential-store.js';

const dirs: string[] = [];
function tmpFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'raccoon-fcs-'));
  dirs.push(d);
  return join(d, 'sessions.json');
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('FileCredentialStore', () => {
  it('a confirmed session survives a new store instance on the same file (restart resume)', async () => {
    const path = tmpFile();
    const first = new FileCredentialStore({ path });
    const token = await first.createSession('u1');
    expect(await first.confirmSession(token)).toBe(true);

    // A NEW instance on the same file models a fresh process after a restart.
    const restarted = new FileCredentialStore({ path });
    expect(await restarted.verifySession(token)).toBe('u1');
  });

  it('an UNCONFIRMED provisional session is not resumable and is not persisted across a restart', async () => {
    const path = tmpFile();
    const first = new FileCredentialStore({ path });
    const token = await first.createSession('u1'); // never confirmed
    expect(await first.verifySession(token)).toBeNull(); // provisional: not resumable

    const restarted = new FileCredentialStore({ path });
    expect(await restarted.verifySession(token)).toBeNull(); // not carried across restart
  });

  it('a revoked session does not resume after a restart', async () => {
    const path = tmpFile();
    const first = new FileCredentialStore({ path });
    const token = await first.createSession('u1');
    await first.confirmSession(token);
    await first.revokeUser('u1');

    const restarted = new FileCredentialStore({ path });
    expect(await restarted.verifySession(token)).toBeNull();
  });

  it('confirmSession is idempotent and returns false for an unknown token', async () => {
    const first = new FileCredentialStore({ path: tmpFile() });
    const token = await first.createSession('u1');
    expect(await first.confirmSession(token)).toBe(true);
    expect(await first.confirmSession(token)).toBe(true); // idempotent
    expect(await first.confirmSession('nope')).toBe(false);
  });

  it('a corrupt store file is treated as empty rather than crashing on boot', async () => {
    const path = tmpFile();
    writeFileSync(path, '{ not valid json');
    const store = new FileCredentialStore({ path }); // must not throw
    expect(await store.verifySession('anything')).toBeNull();
  });
});
