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

  // ---- atomic reservation (commit/rollback, #R4-9 + #R5-8 + #R6-1) -----------

  it('commit() finalizes the reservation — a replay after commit cannot resolve it again (#R4-9/#R5-8)', () => {
    const store = createApprovalValueStore();
    store.remember('req-1', 'alice', new Map([['Approve', approve]]));
    const resolved = store.resolve('req-1', 'alice', 'Approve');
    expect(resolved?.choice).toEqual(approve);
    resolved!.commit();
    expect(store.resolve('req-1', 'alice', 'Approve')).toBeUndefined(); // replay: already consumed
  });

  it('resolve() RESERVES atomically — a second resolve before commit/rollback gets undefined (#R6-1)', () => {
    // Two distinct responses for the same approval (Allow clicked, then Deny
    // clicked — different envelopes, same refId) previously BOTH resolved,
    // because resolve() left the entry available until commit(). Both then
    // dispatched competing commands. Resolution must be an atomic
    // reservation: the first resolve takes the entry out of circulation
    // immediately; the loser degrades to the bracket-tag fallback.
    const store = createApprovalValueStore();
    store.remember('req-1', 'alice', new Map([['Allow', approve], ['Deny', skip]]));
    const first = store.resolve('req-1', 'alice', 'Allow');
    expect(first?.choice).toEqual(approve);
    expect(store.resolve('req-1', 'alice', 'Deny')).toBeUndefined(); // reserved — NOT both dispatchable
    expect(store.resolve('req-1', 'alice', 'Allow')).toBeUndefined(); // same for a replay of the winner
  });

  it('rollback() releases the reservation — a transient dispatch failure can retry (#R5-8/#R6-1)', () => {
    // The R5-8 retry property, now via explicit rollback: a dispatch failure
    // rolls the reservation back so the approval is not burned; nothing is
    // available in between (no double-dispatch window).
    const store = createApprovalValueStore();
    store.remember('req-1', 'alice', new Map([['Approve', approve]]));
    const first = store.resolve('req-1', 'alice', 'Approve');
    expect(first?.choice).toEqual(approve); // dispatch then fails…
    first!.rollback();
    expect(store.resolve('req-1', 'alice', 'Approve')?.choice).toEqual(approve); // …retry still resolves
  });

  it('rollback() does not clobber an entry re-remembered for the same refId since', () => {
    const store = createApprovalValueStore();
    store.remember('req-1', 'alice', new Map([['Approve', approve]]));
    const first = store.resolve('req-1', 'alice', 'Approve');
    store.remember('req-1', 'alice', new Map([['Approve', skip]])); // replaced meanwhile
    first!.rollback(); // stale handle: must NOT overwrite the new entry
    expect(store.resolve('req-1', 'alice', 'Approve')?.choice).toEqual(skip);
  });

  it('commit() after rollback()+re-resolve is a stale no-op (handles are single-use)', () => {
    const store = createApprovalValueStore();
    store.remember('req-1', 'alice', new Map([['Approve', approve]]));
    const first = store.resolve('req-1', 'alice', 'Approve');
    first!.rollback();
    const second = store.resolve('req-1', 'alice', 'Approve');
    first!.commit(); // stale: the entry now belongs to `second`'s reservation
    second!.rollback();
    expect(store.resolve('req-1', 'alice', 'Approve')?.choice).toEqual(approve); // still available
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

  // An explicit expiresAtMs (the approval's OWN absolute expiry) replaces the
  // default TTL for that entry. This is the OpenClaw exec-approval case: their
  // default timeout is 30 minutes while the store default is 10 — a card
  // tapped between those marks looked valid but its mapping was already gone.
  it('a tap after the default TTL but before the request expiresAtMs still resolves', () => {
    vi.useFakeTimers();
    try {
      const store = createApprovalValueStore(); // default 10m TTL
      const expiresAtMs = Date.now() + 30 * 60_000; // OpenClaw default: 30m
      store.remember('req-exec', 'alice', new Map([['Allow Once', approve]]), expiresAtMs);
      vi.advanceTimersByTime(20 * 60_000); // minute 20: past default TTL, before expiry
      expect(store.resolve('req-exec', 'alice', 'Allow Once')?.choice).toEqual(approve);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an explicit expiresAtMs is honored: resolve and validate fail after it, even under the default TTL', () => {
    vi.useFakeTimers();
    try {
      const store = createApprovalValueStore(); // default 10m TTL
      const expiresAtMs = Date.now() + 60_000; // this approval expires in 1m
      store.remember('req-short', 'alice', new Map([['Allow Once', approve]]), expiresAtMs);
      vi.advanceTimersByTime(60_001);
      expect(store.validate('req-short', 'alice', 'Allow Once')).toBe(false);
      expect(store.resolve('req-short', 'alice', 'Allow Once')).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rollback() preserves the entry absolute expiry (a retry after rollback respects the original deadline)', () => {
    vi.useFakeTimers();
    try {
      const store = createApprovalValueStore();
      const expiresAtMs = Date.now() + 30 * 60_000;
      store.remember('req-rb', 'alice', new Map([['Allow Once', approve]]), expiresAtMs);
      vi.advanceTimersByTime(15 * 60_000);
      const first = store.resolve('req-rb', 'alice', 'Allow Once');
      first!.rollback();
      // Still inside the approval's own window: resolvable again.
      vi.advanceTimersByTime(10 * 60_000); // minute 25
      expect(store.resolve('req-rb', 'alice', 'Allow Once')?.choice).toEqual(approve);
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
