import { describe, expect, it } from 'vitest';
import { buildThreadItems } from './grouping.js';

const m = (id: string, sender: string, role: 'user' | 'agent', ts: string) => ({ id, sender, role, ts });

describe('buildThreadItems', () => {
  it('inserts date pills and marks group boundaries', () => {
    const items = buildThreadItems([
      m('1', 'coordinator', 'agent', new Date(2026, 6, 4, 8, 47).toISOString()),
      m('2', 'coordinator', 'agent', new Date(2026, 6, 4, 8, 47, 30).toISOString()),
      m('3', 'you', 'user', new Date(2026, 6, 4, 9, 12).toISOString()),
      m('4', 'coordinator', 'agent', new Date(2026, 6, 4, 9, 14).toISOString()),
    ], new Date(2026, 6, 4, 12, 0));

    expect(items[0]).toMatchObject({ type: 'date' });
    const msgs = items.filter((i) => i.type === 'msg');
    expect(msgs.map((i) => i.type === 'msg' && [i.groupStart, i.groupEnd])).toEqual([
      [true, false], [false, true], [true, true], [true, true],
    ]);
  });

  it('splits groups across days with a second date pill', () => {
    const items = buildThreadItems([
      m('1', 'coordinator', 'agent', new Date(2026, 6, 3, 22, 0).toISOString()),
      m('2', 'coordinator', 'agent', new Date(2026, 6, 4, 8, 0).toISOString()),
    ]);
    expect(items.filter((i) => i.type === 'date')).toHaveLength(2);
    const msgs = items.filter((i) => i.type === 'msg');
    expect(msgs.map((i) => i.type === 'msg' && [i.groupStart, i.groupEnd])).toEqual([
      [true, true], [true, true],
    ]);
  });
});
