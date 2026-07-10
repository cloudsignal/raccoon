// adapters/openclaw/src/approval-values.ts
//
// The real SDK's InteractiveReplyButton carries an optional `value` distinct
// from its `label` (e.g. { label: "Approve", value: "approve:task-42" }) — the
// machine-meaningful identifier OpenClaw may need back to correlate a human's
// choice with the pending action it was raised for. Raccoon's OAM protocol
// only carries the human-facing labels as `approval.request.payload.options`
// (the app renders them verbatim as buttons and echoes the clicked one back
// as `approval.response.payload.choice`), so `value` has nowhere to travel on
// the wire without a protocol change.
//
// This store bridges that gap WITHOUT touching the wire protocol: the outbound
// adapter remembers each button's label -> value mapping per refId when it
// builds an approval.request; the inbound runner resolves the value for the
// returned label when the response comes back, so OpenClaw receives the real
// value (falling back to the label itself when none was supplied, or the
// refId was never seen here — e.g. a response to a request built by something
// other than this outbound adapter).
//
// Bounded FIFO by refId (mirrors RaccoonBridge's dedup cap) so a long-running
// account does not grow this without bound.

const DEFAULT_CAP = 200;

export interface ApprovalValueStore {
  /** Record the label -> value mapping for every button in one approval.request. */
  remember(refId: string, labelToValue: ReadonlyMap<string, string>): void;
  /** Resolve the real value for a (refId, label) pair. Falls back to `label`
   *  when the refId was never remembered, or the label is not one of its
   *  buttons (e.g. an edited free-text response). */
  resolve(refId: string, label: string): string;
}

export function createApprovalValueStore(cap = DEFAULT_CAP): ApprovalValueStore {
  const byRefId = new Map<string, ReadonlyMap<string, string>>();
  return {
    remember(refId, labelToValue) {
      byRefId.set(refId, labelToValue);
      if (byRefId.size > cap) {
        const oldest = byRefId.keys().next().value;
        if (oldest !== undefined) byRefId.delete(oldest);
      }
    },
    resolve(refId, label) {
      return byRefId.get(refId)?.get(label) ?? label;
    },
  };
}
