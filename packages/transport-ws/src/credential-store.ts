import { randomBytes } from 'node:crypto';

export interface CredentialStore {
  createSession(userId: string): Promise<string>;
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

export class MemoryCredentialStore implements CredentialStore {
  private sessions = new Map<string, string>(); // token -> userId

  async createSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    this.sessions.set(token, userId);
    return token;
  }

  async verifySession(token: string): Promise<string | null> {
    return this.sessions.get(token) ?? null;
  }

  async revokeUser(userId: string): Promise<void> {
    for (const [token, uid] of this.sessions) {
      if (uid === userId) this.sessions.delete(token);
    }
  }

  async revokeSession(token: string): Promise<void> {
    this.sessions.delete(token);
  }
}
