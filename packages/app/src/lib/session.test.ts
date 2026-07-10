import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDbForTests } from './idb.js';
import { clearSession, loadSession, saveSession, type Session } from './session.js';

afterEach(async () => { await closeDbForTests(); });

const session: Session = {
  url: 'ws://127.0.0.1:8790/',
  sessionToken: 'tok',
  userId: 'u1',
  instance: 'echo',
  channels: ['coordinator'],
  vapidPublicKey: 'BKey',
};

describe('session store', () => {
  it('round-trips a session', async () => {
    expect(await loadSession()).toBeNull();
    await saveSession(session);
    expect(await loadSession()).toEqual(session);
  });

  it('clears', async () => {
    await saveSession(session);
    await clearSession();
    expect(await loadSession()).toBeNull();
  });

  it('rejects corrupt stored values', async () => {
    const { kvSet } = await import('./idb.js');
    await kvSet('session', { nope: true });
    expect(await loadSession()).toBeNull();
  });
});
