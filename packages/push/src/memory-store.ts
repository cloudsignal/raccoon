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

  // #R8-CQ: atomic compare-and-delete. Single synchronous body (no await
  // between the read and the delete), so no other op can interleave — a
  // subscription re-added on the same endpoint with different keys is NOT
  // removed by a stale delivery's 410.
  async removeIfMatches(userId: string, sub: PushSubscriptionJson): Promise<void> {
    const subs = this.byUser.get(userId);
    const current = subs?.get(sub.endpoint);
    if (!subs || !current || JSON.stringify(current) !== JSON.stringify(sub)) return;
    subs.delete(sub.endpoint);
    if (subs.size === 0) this.byUser.delete(userId);
  }
}
