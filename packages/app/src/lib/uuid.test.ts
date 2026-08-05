import { afterEach, describe, expect, it, vi } from 'vitest';
import { uuid } from './uuid.js';

const V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuid', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns RFC-4122 v4 shaped strings', () => {
    for (let i = 0; i < 32; i++) {
      expect(uuid()).toMatch(V4_SHAPE);
    }
  });

  it('returns distinct values', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 100; i++) seen.add(uuid());
    expect(seen.size).toBe(100);
  });

  it('works when crypto.randomUUID is absent (non-secure context)', () => {
    // Simulate a plain-http origin: crypto exists with getRandomValues only.
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', {
      getRandomValues: real.getRandomValues.bind(real),
    });
    expect(globalThis.crypto.randomUUID).toBeUndefined();
    for (let i = 0; i < 32; i++) {
      expect(uuid()).toMatch(V4_SHAPE);
    }
  });
});
