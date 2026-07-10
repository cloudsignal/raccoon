import { describe, expect, it } from 'vitest';
import { dayKey, formatDateLabel, formatTime } from './time.js';

describe('time utils', () => {
  it('formats HH:MM', () => {
    const d = new Date();
    d.setHours(9, 14, 0, 0);
    expect(formatTime(d.toISOString())).toMatch(/09:14|9:14/);
  });

  it('keys days locally', () => {
    const d = new Date(2026, 6, 4, 12, 0, 0);
    expect(dayKey(d.toISOString())).toBe('2026-07-04');
  });

  it('labels Today/Yesterday/date', () => {
    const now = new Date(2026, 6, 4, 12, 0, 0);
    expect(formatDateLabel(new Date(2026, 6, 4, 8, 0).toISOString(), now)).toBe('Today');
    expect(formatDateLabel(new Date(2026, 6, 3, 8, 0).toISOString(), now)).toBe('Yesterday');
    expect(formatDateLabel(new Date(2026, 5, 20, 8, 0).toISOString(), now)).not.toBe('Today');
  });
});
