import { randomBytes } from 'node:crypto';

export interface CredentialStore {
  createSession(userId: string): Promise<string>;
  verifySession(token: string): Promise<string | null>;
  revokeUser(userId: string): Promise<void>;
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
}
