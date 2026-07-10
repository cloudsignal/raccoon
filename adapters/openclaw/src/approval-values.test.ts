// adapters/openclaw/src/approval-values.test.ts
//
// R4-2/R4-9: direct unit coverage for the approval-value store's security
// hardening — ownership scoping, expiry, one-shot consumption, and
// exact-choice validation. Previously exercised only indirectly (via
// outbound.test.ts's remember() calls and inbound.test.ts's resolve() calls),
// with no direct test of the store's own guarantees.

import { describe, expect, it, vi } from 'vitest';
import { createApprovalValueStore, type ApprovalChoice } from './approval-values.js';

const approve: ApprovalChoice = { value: 'approve:task-42', isCommand: false };
const skip: ApprovalChoice = { value: 'Skip', isCommand: false };

describe('createApprovalValueStore', () => {
  it('resolves a remembered choice for the correct (refId, userId, label)', () => {
    const store = createApprovalValueStore();
    store.remember('req-1', 'alice', new Map([['Approve', approve], ['Skip', skip]]));
    expect(store.resolve('req-1', 'alice', 'Approve')?.choice).toEqual(approve);
  });

  it('returns undefined for an unknown refId', () => {
    const store = createApprovalValueStore();
    expect(store.resolve('never-remembered', 'alice', 'Approve')).toBeUndefined();
  });

  // ---- ownership scoping ---------------------------------------------------

  it('returns undefined when userId does not match who the request was issued to (#R4-9)', () => {
    const store = createApprovalValueStore();
    store.remember('req-1', 'alice', new Map([['Approve', approve]]));
    expect(store.resolve('req-1', 'mallory', 'Approve')).toBeUndefined();
  });

  it('a wrong-user resolve attempt does NOT consume the entry — the real owner can still resolve it (#R4-9)', () => {
    const store = createApprovalValueStore();
    store.remember('req-1', 'alice', new Map([['Approve', approve]]));
    expect(store.resolve('req-1', 'mallory', 'Approve')).toBeUndefined(); // probe by a non-owner
    expect(store.resolve('req-1', 'alice', 'Approve')?.choice).toEqual(approve); // owner still resolves it
  });

  // ---- exact-choice validation --------------------------------------------

  it('returns undefined for a label that was never offered for this refId (#R4-9)', () => {
    const store = createApprovalValueStore();
    // Only "Approve" (mapping to allow-once) was ever offered — "allow-always"
    // was never a real choice for this refId.
    store.remember('req-1', 'alice', new Map([['Approve', { value: 'approve req-1 allow-once', isCommand: true }]]));
    expect(store.resolve('req-1', 'alice', 'allow-always')).toBeUndefined();
  });

  it('an unknown-label resolve attempt does NOT consume the entry — a legitimate retry with the correct label still works (#R4-9)', () => {
    const store = createApprovalValueStore();
    store.remember('req-1', 'alice', new Map([['Approve', approve]]));
    expect(store.resolve('req-1', 'alice', 'not-a-real-choice')).toBeUndefined();
    expect(store.resolve('req-1', 'alice', 'Approve')?.choice).toEqual(approve);
  });

  // ---- one-shot consumption (two-phase, #R4-9 + #R5-8) ----------------------

  it('commit() consumes the entry — a replay after commit cannot resolve it again (#R4-9/#R5-8)', () => {
    const store = createApprovalValueStore();
    store.remember('req-1', 'alice', new Map([['Approve', approve]]));
    const resolved = store.resolve('req-1', 'alice', 'Approve');
    expect(resolved?.choice).toEqual(approve);
    resolved!.commit();
    expect(store.resolve('req-1', 'alice', 'Approve')).toBeUndefined(); // replay: already consumed
  });

  it('resolve() alone does NOT consume — a transient dispatch failure can retry the same response (#R5-8)', () => {
    // Consumption must wait for the choice to have actually been dispatched
    // (commit()). Consuming eagerly on resolve meant a transient OpenClaw
    // dispatch failure permanently burned the approval: the retry's resolve
    // came back undefined, degraded to the bracket-tag fallback, and the
    // real pending approval could never be acted on again.
    const store = createApprovalValueStore();
    store.remember('req-1', 'alice', new Map([['Approve', approve]]));
    expect(store.resolve('req-1', 'alice', 'Approve')?.choice).toEqual(approve); // dispatch then fails; no commit
    expect(store.resolve('req-1', 'alice', 'Approve')?.choice).toEqual(approve); // retry still resolves
  });

  it('commit() is a no-op if the entry was already re-consumed or replaced (idempotent, keyed to its own resolve)', () => {
    const store = createApprovalValueStore();
    store.remember('req-1', 'alice', new Map([['Approve', approve]]));
    const first = store.resolve('req-1', 'alice', 'Approve');
    first!.commit();
    // Same refId legitimately re-remembered later (refIds are ulids in
    // practice, but the store must not blow up either way).
    store.remember('req-1', 'alice', new Map([['Approve', skip]]));
    first!.commit(); // stale handle: must NOT delete the new entry
    expect(store.resolve('req-1', 'alice', 'Approve')?.choice).toEqual(skip);
  });

  // ---- expiry ---------------------------------------------------------------

  it('returns undefined once the TTL has elapsed', () => {
    vi.useFakeTimers();
    try {
      const store = createApprovalValueStore(200, 1000); // 1s TTL
      store.remember('req-1', 'alice', new Map([['Approve', approve]]));
      vi.advanceTimersByTime(1001);
      expect(store.resolve('req-1', 'alice', 'Approve')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still resolves just before the TTL elapses', () => {
    vi.useFakeTimers();
    try {
      const store = createApprovalValueStore(200, 1000);
      store.remember('req-1', 'alice', new Map([['Approve', approve]]));
      vi.advanceTimersByTime(999);
      expect(store.resolve('req-1', 'alice', 'Approve')?.choice).toEqual(approve);
    } finally {
      vi.useRealTimers();
    }
  });

  // ---- bounded FIFO capacity ------------------------------------------------

  it('evicts the oldest refId once the cap is exceeded', () => {
    const store = createApprovalValueStore(2, 10 * 60_000);
    store.remember('req-1', 'alice', new Map([['A', approve]]));
    store.remember('req-2', 'alice', new Map([['A', approve]]));
    store.remember('req-3', 'alice', new Map([['A', approve]])); // evicts req-1
    expect(store.resolve('req-1', 'alice', 'A')).toBeUndefined();
    expect(store.resolve('req-2', 'alice', 'A')?.choice).toEqual(approve);
    expect(store.resolve('req-3', 'alice', 'A')?.choice).toEqual(approve);
  });
});
