import type { HistoryMessage } from '@raccoon/protocol';
import type { MessageStore, StoredMessage } from './types.js';

/** Reference in-memory store. Ordered by insertion (callers append in
 *  chronological order). Pagination walks backward from `before` (an
 *  exclusive message id) and returns up to `limit` messages oldest-first,
 *  with nextBefore pointing at the oldest returned id when older
 *  messages remain. */
export class InMemoryMessageStore implements MessageStore {
  private byChannel = new Map<string, StoredMessage[]>();

  async append(m: StoredMessage): Promise<void> {
    const list = this.byChannel.get(m.channel) ?? [];
    list.push(m);
    this.byChannel.set(m.channel, list);
  }

  async page(
    channel: string,
    opts: { userId: string; before?: string; limit: number },
  ): Promise<{ messages: HistoryMessage[]; nextBefore?: string }> {
    const all = (this.byChannel.get(channel) ?? []).filter((m) => m.userId === opts.userId);
    let end = all.length;
    if (opts.before) {
      const idx = all.findIndex((m) => m.id === opts.before);
      if (idx >= 0) end = idx;
    }
    const start = Math.max(0, end - opts.limit);
    const slice = all.slice(start, end);
    const messages: HistoryMessage[] = slice.map((m) => ({
      id: m.id,
      role: m.role,
      text: m.text,
      ts: m.ts,
    }));
    const result: { messages: HistoryMessage[]; nextBefore?: string } = { messages };
    if (start > 0 && slice.length > 0) result.nextBefore = slice[0].id;
    return result;
  }
}
