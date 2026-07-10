import type { PushSubscriptionJson, SubscriptionStore } from './types.js';

export class InMemorySubscriptionStore implements SubscriptionStore {
  private byUser = new Map<string, Map<string, PushSubscriptionJson>>();

  async add(userId: string, sub: PushSubscriptionJson): Promise<void> {
    let subs = this.byUser.get(userId);
    if (!subs) { subs = new Map(); this.byUser.set(userId, subs); }
    subs.set(sub.endpoint, sub);
  }

  async list(userId: string): Promise<PushSubscriptionJson[]> {
    return [...(this.byUser.get(userId)?.values() ?? [])];
  }

  async remove(userId: string, endpoint: string): Promise<void> {
    const subs = this.byUser.get(userId);
    subs?.delete(endpoint);
    if (subs && subs.size === 0) this.byUser.delete(userId);
  }

  async clear(userId: string): Promise<void> {
    this.byUser.delete(userId);
  }
}
