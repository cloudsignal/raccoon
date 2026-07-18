// adapters/openclaw/src/approval-values.ts
//
// The real SDK's InteractiveReplyButton/MessagePresentationButton carries an
// optional `value` (or a `command`/`callback` action) distinct from its
// `label` — the machine-meaningful identifier OpenClaw may need back to
// correlate a human's choice with the pending action it was raised for.
// Raccoon's Raccoon protocol only carries the human-facing labels as
// `approval.request.payload.options` (the app renders them verbatim as
// buttons and echoes the clicked one back as `approval.response.payload.choice`),
// so this information has nowhere to travel on the wire without a protocol
// change.
//
// This store bridges that gap WITHOUT touching the wire protocol: the
// outbound adapter remembers each button's label -> ApprovalChoice mapping
// (scoped to the user it was sent to) when it builds an approval.request;
// the inbound runner resolves the choice for the returned label when the
// response comes back.
//
// R4-2/R4-9 hardening (previously: unscoped, non-expiring, replayable,
// accepted unknown choices):
//   - Scoped: remember() records the userId the request was issued to;
//     resolve() only succeeds for that SAME userId. A response referencing
//     another user's refId cannot resolve it.
//   - Expiring: a TTL bounds how long a refId stays resolvable, independent
//     of the bounded-FIFO capacity eviction.
//   - One-shot: a SUCCESSFUL resolve consumes (deletes) the entry, so a
//     replayed/duplicate response for the same refId cannot resolve it
//     again. (An unsuccessful attempt — wrong user, wrong/unknown label, or
//     expired — does NOT consume the entry, so it can't be used to destroy
//     a still-pending, legitimately-owned approval as a denial-of-service.)
//   - Exact-choice validation: resolve() only returns a choice for a label
//     that was ACTUALLY offered for that refId. An attacker/buggy client
//     sending an unlisted label (e.g. "allow-always" when only "Approve" —
//     mapped to "allow-once" — was ever shown) gets `undefined` back, never
//     a fabricated pass-through value.
//
// This matters far more once a resolved choice can become a real OpenClaw
// slash command (see inbound.ts's buildApprovalText / R4-2): an
// unauthenticated-choice, unscoped, replayable value store next to a
// mechanism that can execute `/approve <id> allow-always` would be a real
// privilege-escalation path, not just a UX inconvenience.
//
// Bounded FIFO by refId (mirrors RaccoonBridge's dedup cap) so a long-running
// account does not grow this without bound even before the TTL catches up.

const DEFAULT_CAP = 200;
// Generous vs. the client's ACK_TIMEOUT_MS (10s): a human choosing among
// options takes far longer than a network round trip.
const DEFAULT_TTL_MS = 10 * 60_000;

export interface ApprovalChoice {
  /**
   * The resolved value. For isCommand=true this is the raw OpenClaw
   * slash-command argument string (send back as `/${value}`, per the
   * confirmed contract: "commands sent as standalone messages starting with
   * /"); otherwise it's the button's opaque callback/legacy value (or its
   * label, as a last-resort fallback), which must never be sent back as a
   * command.
   */
  value: string;
  /**
   * True when this choice's action was `{type:'command', command}` — a REAL
   * OpenClaw slash command. False for `callback`/legacy button values,
   * which are opaque application data.
   */
  isCommand: boolean;
}

/** A successful resolve = an ATOMIC RESERVATION (#R6-1): the entry leaves
 *  circulation the instant resolve() returns it, so two competing responses
 *  for the same approval (Allow and Deny — distinct envelopes, same refId,
 *  and the bridge dedups by ENVELOPE id only) can never both hold it and
 *  both dispatch commands. The reservation then settles exactly one way:
 *    - commit(): the choice was dispatched successfully — consumption is
 *      final (replay protection).
 *    - rollback(): the dispatch failed (#R5-8: a transient outage must not
 *      burn the approval), or the turn never actually sent the command
 *      (edited free-text response) — the entry returns to circulation for
 *      a later attempt.
 *  Handles are single-use and keyed to their own reservation: a stale
 *  commit/rollback (its entry since re-resolved or re-remembered) no-ops. */
export interface ResolvedApproval {
  choice: ApprovalChoice;
  /** Finalize the reservation. Call ONLY after the choice was successfully
   *  delivered as a real command. */
  commit(): void;
  /** Release the reservation, returning the entry to circulation — for a
   *  failed dispatch or a turn that never sent the command. Does not
   *  overwrite an entry re-remembered for the same refId since. */
  rollback(): void;
}

export interface ApprovalValueStore {
  /** Record the label -> choice mapping for one approval.request, scoped to
   *  the userId it was sent to.
   *
   *  `expiresAtMs` (absolute epoch ms), when given, replaces the store's
   *  default TTL for THIS entry. This matters for OpenClaw exec approvals:
   *  their default timeout is 30 minutes while the store's default TTL is 10
   *  — with the fixed TTL, a card tapped between minutes 10 and 30 looked
   *  valid (OpenClaw still pending) but the label→command mapping was gone,
   *  so the tap degraded to bracket text and the approval never resolved.
   *  The renderer knows the request's real expiresAtMs; passing it through
   *  keeps the buttons resolvable exactly as long as the approval itself. */
  remember(refId: string, userId: string, labelToChoice: ReadonlyMap<string, ApprovalChoice>, expiresAtMs?: number): void;
  /**
   * Atomically RESERVE the choice for a (refId, userId, label) triple
   * (#R6-1). Returns undefined — the caller must treat the response as
   * unresolved/untrusted, never as a command — when the refId is
   * unknown/expired/consumed/CURRENTLY RESERVED by another in-flight turn,
   * `userId` does not match who the request was issued to, or `label` was
   * not one of the choices actually offered for that refId. The caller MUST
   * settle the returned handle: commit() after a successful command
   * dispatch, rollback() on failure or when the command was never sent.
   * (NOTE: the bridge dedups approval responses by ENVELOPE id, not refId —
   * this reservation is the ONLY thing preventing two distinct responses
   * from both dispatching for one approval.)
   */
  resolve(refId: string, userId: string, label: string): ResolvedApproval | undefined;
  /**
   * Validate a (refId, userId, label) triple WITHOUT reserving or consuming
   * (#R7-CQ). Same ownership + TTL + exact-choice checks as resolve(), but
   * read-only: used for an EDITED response, which never executes the command
   * (so it must not reserve, #R6-1b) yet still must be an authorized answer to
   * THIS user's own, still-valid, real approval before it is correlated to
   * that refId. Returns true only if all checks pass.
   */
  validate(refId: string, userId: string, label: string): boolean;
}

interface StoredApproval {
  userId: string;
  /** Absolute expiry (epoch ms): the request's own expiresAtMs when the
   *  caller supplied one, otherwise issue time + the store's default TTL. */
  expiresAt: number;
  choices: ReadonlyMap<string, ApprovalChoice>;
}

export function createApprovalValueStore(cap = DEFAULT_CAP, ttlMs = DEFAULT_TTL_MS): ApprovalValueStore {
  const byRefId = new Map<string, StoredApproval>();
  return {
    remember(refId, userId, choices, expiresAtMs) {
      byRefId.set(refId, { userId, expiresAt: expiresAtMs ?? Date.now() + ttlMs, choices });
      if (byRefId.size > cap) {
        const oldest = byRefId.keys().next().value;
        if (oldest !== undefined) byRefId.delete(oldest);
      }
    },
    validate(refId, userId, label) {
      const stored = byRefId.get(refId);
      if (!stored) return false;
      if (stored.userId !== userId) return false;                 // ownership
      if (Date.now() > stored.expiresAt) return false;            // expiry (read-only: don't evict here)
      return stored.choices.has(label);                           // exact-choice
    },
    resolve(refId, userId, label) {
      const stored = byRefId.get(refId);
      if (!stored) return undefined;
      // Wrong user: do NOT delete — an unrelated/malicious probe against
      // someone else's refId must not be able to destroy their still-pending
      // approval as a side effect.
      if (stored.userId !== userId) return undefined;
      if (Date.now() > stored.expiresAt) {
        byRefId.delete(refId); // stale: safe to evict on the way out
        return undefined;
      }
      const choice = stored.choices.get(label);
      // Unknown/unlisted label: do NOT delete — a legitimate retry with the
      // correct label (e.g. after a client-side bug) must still work.
      if (!choice) return undefined;
      // #R6-1: reservation = removal, atomically with the successful lookup
      // (single-threaded JS: nothing can interleave between the get and this
      // delete). A concurrent competing response now finds nothing to
      // resolve and degrades safely, instead of both dispatching commands.
      byRefId.delete(refId);
      let settled = false;
      return {
        choice,
        commit: () => { settled = true; },
        rollback: () => {
          if (settled) return; // single-use
          settled = true;
          // Do not clobber an entry re-remembered for this refId meanwhile.
          if (!byRefId.has(refId)) byRefId.set(refId, stored);
        },
      };
    },
  };
}
