// adapters/openclaw/src/approval-values.ts
//
// The real SDK's InteractiveReplyButton/MessagePresentationButton carries an
// optional `value` (or a `command`/`callback` action) distinct from its
// `label` — the machine-meaningful identifier OpenClaw may need back to
// correlate a human's choice with the pending action it was raised for.
// Raccoon's OAM protocol only carries the human-facing labels as
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

/** A successful resolve: the choice plus a commit() performing the one-shot
 *  consumption. #R5-8: consumption is SPLIT from resolution — the caller
 *  commits only after the resolved choice has actually been dispatched to
 *  OpenClaw successfully (and only when the command path was really used).
 *  Consuming eagerly on resolve meant a transient dispatch failure — or an
 *  edited free-text response, which never sends the command at all —
 *  permanently burned the approval: every later attempt resolved undefined
 *  and degraded to the bracket-tag fallback, so the real pending OpenClaw
 *  approval could never be acted on again. */
export interface ResolvedApproval {
  choice: ApprovalChoice;
  /** Consume the entry (one-shot). Call ONLY after the choice was
   *  successfully delivered. Keyed to the resolve that produced it: a stale
   *  handle whose entry was since replaced no-ops instead of deleting the
   *  replacement. */
  commit(): void;
}

export interface ApprovalValueStore {
  /** Record the label -> choice mapping for one approval.request, scoped to
   *  the userId it was sent to. */
  remember(refId: string, userId: string, labelToChoice: ReadonlyMap<string, ApprovalChoice>): void;
  /**
   * Resolve the choice for a (refId, userId, label) triple. Returns
   * undefined — the caller must treat the response as unresolved/untrusted,
   * never as a command — when the refId is unknown/expired/already
   * consumed, `userId` does not match who the request was issued to, or
   * `label` was not one of the choices actually offered for that refId.
   * Does NOT consume the entry — call the returned commit() after a
   * successful dispatch (#R5-8). Replay between resolve and commit is
   * suppressed one layer up (RaccoonBridge dedups approval responses by
   * refId); commit() closes the long-term replay window.
   */
  resolve(refId: string, userId: string, label: string): ResolvedApproval | undefined;
}

interface StoredApproval {
  userId: string;
  issuedAt: number;
  choices: ReadonlyMap<string, ApprovalChoice>;
}

export function createApprovalValueStore(cap = DEFAULT_CAP, ttlMs = DEFAULT_TTL_MS): ApprovalValueStore {
  const byRefId = new Map<string, StoredApproval>();
  return {
    remember(refId, userId, choices) {
      byRefId.set(refId, { userId, issuedAt: Date.now(), choices });
      if (byRefId.size > cap) {
        const oldest = byRefId.keys().next().value;
        if (oldest !== undefined) byRefId.delete(oldest);
      }
    },
    resolve(refId, userId, label) {
      const stored = byRefId.get(refId);
      if (!stored) return undefined;
      // Wrong user: do NOT delete — an unrelated/malicious probe against
      // someone else's refId must not be able to destroy their still-pending
      // approval as a side effect.
      if (stored.userId !== userId) return undefined;
      if (Date.now() - stored.issuedAt > ttlMs) {
        byRefId.delete(refId); // stale: safe to evict on the way out
        return undefined;
      }
      const choice = stored.choices.get(label);
      // Unknown/unlisted label: do NOT delete — a legitimate retry with the
      // correct label (e.g. after a client-side bug) must still work.
      if (!choice) return undefined;
      return {
        choice,
        // #R5-8: one-shot consumption happens HERE, on the caller's signal
        // that the choice was actually delivered — not eagerly on resolve.
        // Identity-keyed so a stale handle (its entry since replaced by a
        // fresh remember() for the same refId) cannot delete the new entry.
        commit: () => { if (byRefId.get(refId) === stored) byRefId.delete(refId); },
      };
    },
  };
}
