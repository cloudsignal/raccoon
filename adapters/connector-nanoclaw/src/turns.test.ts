import { describe, expect, it } from 'vitest';
import { createTurnStore } from './turns.js';

describe('TurnStore', () => {
  it('settle resolves an open turn', async () => {
    const turns = createTurnStore();
    const p = turns.open('assistant:u1', 1000);
    expect(turns.settle('assistant:u1', 'hello')).toBe(true);
    await expect(p).resolves.toBe('hello');
  });

  it('settle with no open turn returns false', () => {
    const turns = createTurnStore();
    expect(turns.settle('assistant:u1', 'late')).toBe(false);
  });

  it('resolves null on timeout', async () => {
    const turns = createTurnStore();
    await expect(turns.open('assistant:u1', 20)).resolves.toBeNull();
    // and the slot is freed: a later settle finds nothing
    expect(turns.settle('assistant:u1', 'x')).toBe(false);
  });

  it('a second open for the same platformId cancels the first (defensive guard)', async () => {
    const turns = createTurnStore();
    const first = turns.open('assistant:u1', 1000);
    const second = turns.open('assistant:u1', 1000);
    await expect(first).resolves.toBeNull();
    expect(turns.settle('assistant:u1', 'reply')).toBe(true);
    await expect(second).resolves.toBe('reply');
  });

  it('cancelAll resolves every open turn null', async () => {
    const turns = createTurnStore();
    const a = turns.open('assistant:u1', 1000);
    const b = turns.open('researcher:u2', 1000);
    turns.cancelAll();
    await expect(a).resolves.toBeNull();
    await expect(b).resolves.toBeNull();
  });
});
