import { dayKey, formatDateLabel } from './time.js';

export interface GroupableMessage {
  id: string;
  sender: string;
  role: 'user' | 'agent';
  ts: string;
}

export type ThreadItem<M extends GroupableMessage> =
  | { type: 'date'; key: string; label: string }
  | { type: 'msg'; key: string; msg: M; groupStart: boolean; groupEnd: boolean };

export function buildThreadItems<M extends GroupableMessage>(messages: M[], now?: Date): ThreadItem<M>[] {
  const items: ThreadItem<M>[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    const prev = messages[i - 1];
    const next = messages[i + 1];
    const day = dayKey(msg.ts);
    const newDay = !prev || dayKey(prev.ts) !== day;
    if (newDay) items.push({ type: 'date', key: `date-${day}`, label: formatDateLabel(msg.ts, now) });
    const groupStart = newDay || !prev || prev.sender !== msg.sender;
    const groupEnd = !next || next.sender !== msg.sender || dayKey(next.ts) !== day;
    items.push({ type: 'msg', key: msg.id, msg, groupStart, groupEnd });
  }
  return items;
}
