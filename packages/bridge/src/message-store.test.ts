import { describe, expect, it } from 'vitest';
import { InMemoryMessageStore } from './message-store.js';

function msg(id: string, channel: string, ts: string) {
  return { id, channel, userId: 'u1', role: 'user' as const, text: id, ts };
}

describe('InMemoryMessageStore', () => {
  it('returns messages for a channel oldest-first, scoped by user', async () => {
    const store = new InMemoryMessageStore();
    await store.append(msg('a', 'coordinator', '2026-07-04T10:00:00.000Z'));
    await store.append(msg('b', 'coordinator', '2026-07-04T10:01:00.000Z'));
    await store.append({ ...msg('x', 'coordinator', '2026-07-04T10:02:00.000Z'), userId: 'other' });

    const page = await store.page('coordinator', { userId: 'u1', limit: 10 });
    expect(page.messages.map((m) => m.id)).toEqual(['a', 'b']);
    expect(page.messages[0]).toEqual({ id: 'a', role: 'user', text: 'a', ts: '2026-07-04T10:00:00.000Z' });
    expect(page.nextBefore).toBeUndefined();
  });

  it('paginates with before + limit, setting nextBefore when more remain', async () => {
    const store = new InMemoryMessageStore();
    for (let i = 0; i < 5; i++) {
      await store.append(msg(String(i), 'c', `2026-07-04T10:0${i}:00.000Z`));
    }
    const first = await store.page('c', { userId: 'u1', limit: 2 });
    expect(first.messages.map((m) => m.id)).toEqual(['3', '4']);
    expect(first.nextBefore).toBe('3');

    const second = await store.page('c', { userId: 'u1', before: '3', limit: 2 });
    expect(second.messages.map((m) => m.id)).toEqual(['1', '2']);
    expect(second.nextBefore).toBe('1');
  });

  it('returns empty for an unknown channel', async () => {
    const store = new InMemoryMessageStore();
    const page = await store.page('nope', { userId: 'u1', limit: 10 });
    expect(page).toEqual({ messages: [] });
  });
});
