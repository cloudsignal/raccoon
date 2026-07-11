import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState,
  type ReactNode,
} from 'react';
import {
  agentAddress, createEnvelope, parsePairingPayload, userAddress,
  type AnyEnvelope, type TransportStatus,
} from '@raccoon/protocol';
import { WsClientTransport } from '@raccoon/transport-ws';
import { kvGet, kvSet, wipeKvExceptSession } from '../lib/idb.js';
import { browserPushEnv, enablePushFlow, unsubscribeCurrentPush } from '../lib/push-client.js';
import * as outbox from '../lib/outbox.js';
import * as approvals from '../lib/approvals.js';
import { clearSessionIfMatches, loadSession, saveSession, type Session } from '../lib/session.js';
import { chatReducer, emptyChatState, type ChatState } from '../state/messages.js';
import type { AppTransport, MakeTransport } from './types.js';

export const ACK_TIMEOUT_MS = 10_000;
// #R7-1b: how long an approval may sit in 'processing' (server acked receipt
// but sent no terminal outcome) before the client surfaces it as a retryable
// failure. Generous — a real agent turn (LLM + tools) can legitimately take a
// while — but bounded, so a hung server turn can't spin forever.
export const PROCESSING_TIMEOUT_MS = 120_000;
const HISTORY_LIMIT = 50;

export interface ChatApi {
  phase: 'loading' | 'setup' | 'ready';
  status: TransportStatus;
  session: Session | null;
  state: ChatState;
  activeChannel: string | null;
  authError: string | null;
  pairWithPayload(json: string): Promise<void>;
  openChannel(channel: string | null): void;
  sendMessage(channel: string, text: string): void;
  respondApproval(channel: string, refId: string, choice: string, editedText?: string): void;
  retryMessage(channel: string, id: string): void;
  loadOlder(channel: string): void;
  enablePush(): Promise<boolean>;
  /** True when some push path is available: a VAPID key on the session or a
   *  host-supplied registrar override. Drives PushBanner eligibility. */
  canEnablePush: boolean;
  unpair(): Promise<void>;
}

/** Host-supplied push registration flow. enable() performs the vendor
 *  registration AND persists the subscription server-side; the provider
 *  only tracks the enabled flag. */
export interface PushRegistrar {
  enable(): Promise<boolean>;
  /** Optional: tear down this device's push registration (local + ideally
   *  server-side). Called on unpair, best-effort, so a re-pair as a different
   *  user doesn't leave the device receiving the prior user's notifications. */
  disable?(): Promise<void>;
}

const ChatContext = createContext<ChatApi | null>(null);

/**
 * A COMPLETE session identity (#R6-3b/#R6-8b/#R7-3): instance + user + a
 * NON-SECRET session epoch, JSON-encoded (structured — no NUL bytes that
 * would make git treat this source as binary, and unambiguous vs a delimiter
 * join). url is excluded (host overrides allow a placeholder url; `instance`
 * is the meaningful discriminator). `epoch` (session.ts) is the session
 * generation, NOT the secret sessionToken — which for host-managed sessions
 * may be a STABLE token that can't tell a re-pair apart, and which must not be
 * broadcast in wipe messages. A fresh pairing mints a new epoch, so a stale
 * wipe no longer matches a re-paired session and a stale tab's outbox rows are
 * not claimable by the new one. Falls back to the token only for a
 * pre-migration session with no epoch.
 */
function identityKey(s: { instance: string; userId: string; epoch: string }): string {
  return JSON.stringify({ i: s.instance, u: s.userId, e: s.epoch });
}

/**
 * Ensure a session carries an epoch (#R8-5). The standard pairing/boot paths
 * always set one (minted at pairing, persisted + lazily migrated on load).
 * A HOST override may omit it — the documented host API permits a stable
 * placeholder sessionToken, so we must NEVER derive the key from the token
 * (that would make re-pairs share an identity AND broadcast a secret). Mint a
 * per-mount random epoch instead. A host that wants cross-tab wipe
 * coordination for its sessions supplies its own persisted `epoch`.
 */
type ActiveSession = Session & { epoch: string };
function withEpoch(s: Session): ActiveSession {
  return { ...s, epoch: s.epoch ?? crypto.randomUUID() };
}

const defaultMakeTransport: MakeTransport = (opts) => new WsClientTransport(opts) as AppTransport;

/**
 * Props for TransportProvider.
 *
 * For the standalone OSS app: omit both props — the default WS transport is used and
 * the session is loaded from IDB.
 *
 * For a host embedding (e.g. a host app): supply `transportOverride` with an
 * already-constructed, already-authenticated transport AND `sessionOverride` with the
 * authenticated session.  The provider wires the transport immediately (phase →
 * 'ready'), skips IDB, and sets the session synchronously so that `sendMessage`,
 * `respondApproval`, and `requestHistory` all see a valid `userId` from the very first
 * call.  The channel list (`session.channels`) is also driven by this prop.
 *
 * `sessionOverride` SHOULD accompany every `transportOverride`.  Omitting it leaves
 * `session` null: the channel list will be empty and outbound messages will silently
 * no-op because `userId` is unavailable.
 *
 * `sessionToken` and `url` in the override session may be placeholder strings — they
 * are not used when the transport bypasses the built-in auth flow.  The host owns
 * authentication; the provider never reads or writes IDB when `transportOverride` is
 * set.
 *
 * Alternatively, supply `makeTransport` to customise transport construction while
 * keeping the IDB session / pairing flow intact.  The factory may ignore the opts it
 * receives and return a fully custom transport.
 */
export interface TransportProviderProps {
  /** Drop-in replacement for the WS transport factory.  The factory may ignore opts. */
  makeTransport?: MakeTransport;
  /**
   * Pre-constructed, already-authenticated transport.  When supplied the provider
   * skips IDB session loading and goes directly to phase='ready'.
   * Cannot be combined with `makeTransport`.
   */
  transportOverride?: AppTransport;
  /**
   * Companion to `transportOverride`.  The authenticated session the host supplies
   * (userId, channels, instance are the meaningful fields; url/sessionToken may be
   * placeholders).  When present the provider sets this as the active session
   * synchronously — before the transport is wired and connected — so that all
   * outbound calls have a valid userId from the very first tick.
   * Not persisted to IDB (the host owns identity).
   */
  sessionOverride?: Session;
  /**
   * Host-supplied push registration flow (e.g. a vendor SDK). When present it
   * takes precedence over the built-in VAPID/envelope flow and makes push
   * available even without session.vapidPublicKey.
   */
  pushRegistrarOverride?: PushRegistrar;
  children: ReactNode;
}

export function TransportProvider(props: TransportProviderProps) {
  const makeTransport = props.makeTransport ?? defaultMakeTransport;
  const [phase, setPhase] = useState<'loading' | 'setup' | 'ready'>('loading');
  const [status, setStatus] = useState<TransportStatus>('closed');
  const [session, setSession] = useState<ActiveSession | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(chatReducer, emptyChatState);

  const transportRef = useRef<AppTransport | null>(null);
  const sessionRef = useRef<ActiveSession | null>(null);
  const activeRef = useRef<string | null>(null);
  const stateRef = useRef<ChatState>(state);
  // statusNowRef is updated synchronously inside the onStatus handler (before any
  // setState), so it always reflects the actual current transport status even
  // before React has committed the corresponding state update.  All gating
  // decisions in sendEnvelope / openChannel read from this ref.
  const statusNowRef = useRef<TransportStatus>('closed');
  // drainLockRef prevents concurrent drain() executions from double-sending the
  // same outbox entry.  When a second drain() call arrives while a drain is in
  // flight, we set drainPendingRef so the in-flight drain re-runs once more
  // after it finishes — this guarantees entries enqueued during the first drain
  // are not missed.
  const drainLockRef = useRef(false);
  const drainPendingRef = useRef(false);
  // R4-4: a stable, unique id for THIS tab/window instance, lazily generated
  // once. Stamped onto every row this tab claims via markSending() so
  // demoteSending() can tell "a row I myself abandoned" (always safe to
  // requeue immediately) apart from "a row a DIFFERENT, possibly still-alive
  // tab is actively sending" (only safe to requeue once its lease expires) —
  // see outbox.ts's demoteSending() for the full reasoning.
  const tabIdRef = useRef<string | undefined>(undefined);
  if (!tabIdRef.current) tabIdRef.current = crypto.randomUUID();
  // R5-3: cross-tab identity coordination. IndexedDB rows are shared
  // per-origin but every tab's in-memory identity (validUserIdRef,
  // sessionRef) is its own — so a wipe/unpair in one tab left other
  // still-open tabs running the wiped identity, free to keep enqueueing
  // rows as it. Wipe paths post 'identity-wiped' here; every other tab
  // tears itself down to setup on receipt (see the boot effect's listener).
  // Feature-detected: absent BroadcastChannel (very old engines), the
  // claim-time identity scoping in attempt()/markSending() still prevents
  // any cross-identity transmission — this coordination just stops the
  // stale tab from acting at all.
  const bcRef = useRef<BroadcastChannel | null>(null);
  // R4-3: bumped SYNCHRONOUSLY (before any await) on every identity
  // transition — wipe/unpair AND successful (re-)pairing — see unpair(),
  // the auth-error handler, loadSession's success path, and
  // pairWithPayload below. sendEnvelope captures this at call time and
  // re-checks it once its enqueue() write commits: if it changed in
  // between, the identity that queued the message is being (or has been)
  // torn down, so the row is dropped instead of surviving into whatever
  // session/transport is active by the time a drain() would otherwise pick
  // it up. wipeLocal/clearAll alone were not enough — they race the SAME
  // wipe's own async completion, not a synchronous signal available to code
  // that runs mid-wipe. Deferred React-state updates that finalize a wipe
  // (setSession(null) etc.) also compare against a generation captured at
  // their start, so a since-superseded wipe (a newer wipe, or a newer
  // successful pairing) skips applying its now-stale transition — the
  // TOCTOU the original (pre-R4-3) deferral existed to avoid.
  const sessionGenRef = useRef(0);
  // #R6-4b: identity keys wiped by ANOTHER tab, recorded even while THIS tab
  // is still loading its session from IDB (before it has any current
  // identity to match against). The boot continuation checks the loaded
  // identity against this set before installing it — so a stale IDB read
  // that resolves AFTER a concurrent wipe cannot connect a just-wiped
  // session. In-memory per tab; it only needs to guard this boot.
  const wipeTombstonesRef = useRef<Set<string>>(new Set());
  // R4-3: the userId sendMessage/respondApproval are currently allowed to
  // send as. A DEDICATED ref, deliberately NOT sessionRef (which is
  // resynced from `session` STATE on every render — synchronously nulling
  // sessionRef.current mid-wipe would just get overwritten back to the
  // stale value by that resync on the next incidental re-render, since
  // `session` state itself hasn't caught up yet). Nulled synchronously at
  // wipe-start, set synchronously at session-establish — this is what
  // actually closes "identity usable until asynchronous cleanup completes":
  // sendMessage/respondApproval check THIS, not sessionRef.current, so a
  // call made from the instant the wipe decision is made onward is rejected
  // outright, before it ever reaches outbox.enqueue().
  const validUserIdRef = useRef<string | null>(null);
  // #R6-3: the FULL identity scope (`<instanceUrl>::<user address>`) this
  // tab is currently allowed to send as — stamped onto every outbox row at
  // enqueue and required verbatim by the claim CAS. userId alone is not an
  // identity: user ids are instance-local, so a stale row queued against
  // instance A's u1 must never transmit through instance B's u1 session.
  // Managed in lockstep with validUserIdRef at every identity transition.
  const identityScopeRef = useRef<string | null>(null);
  const ackTimers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const [activeChannel, setActiveChannel] = useState<string | null>(null);
  // Finding 1: track unsubscribe functions so we can clean them up before re-wiring
  const unsubsRef = useRef<Array<() => void>>([]);

  sessionRef.current = session;
  stateRef.current = state;
  activeRef.current = activeChannel;

  const isActive = useCallback((channel: string) => activeRef.current === channel && document.visibilityState === 'visible', []);

  const handleEnvelope = useCallback((env: AnyEnvelope) => {
    if (env.kind === 'msg') {
      dispatch({ type: 'message', env, active: isActive(env.channel) });
      if (isActive(env.channel)) void kvSet(`lastread:${env.channel}`, env.ts);
    } else if (env.kind === 'typing') dispatch({ type: 'typing', channel: env.channel, on: env.payload.state === 'start' });
    else if (env.kind === 'approval.request') {
      dispatch({ type: 'approval', env, active: isActive(env.channel) });
      if (isActive(env.channel)) void kvSet(`lastread:${env.channel}`, env.ts);
      // #R8-1: persist the request under this identity scope so a reload can
      // re-render the interactive card (server history keeps it only as text).
      const scope = identityScopeRef.current;
      if (scope) void approvals.saveApproval(scope, env).catch(() => { /* durability best-effort */ });
    }
    else if (env.kind === 'ack') {
      // The server responded for this envelope — stop the local no-ack
      // timeout regardless of which status it carries.
      const refId = env.payload.refId;
      const timer = ackTimers.current.get(refId);
      if (timer) { clearTimeout(timer); ackTimers.current.delete(refId); }
      // #R6-2b: 'received' is terminal only for a msg; for an approval.response
      // it moves the row to a DURABLE 'processing' state (acknowledgeReceipt
      // decides by envelope kind) so a lost terminal ack no longer deletes the
      // decision with nothing to retry. 'delivered'/'read' settle (terminal
      // success); 'failed' leaves a retryable row (authoritative, not
      // claim-token gated — the server said this turn failed).
      const st = env.payload.status;
      if (st === 'received') {
        // #R8-CQ: only arm the processing timeout when the row actually became
        // 'processing' (an approval.response). A plain msg is deleted on
        // receipt, so arming a 2-minute timer for it just accumulates dead
        // timers under multi-tab chat load. acknowledgeReceipt reports which.
        void outbox.acknowledgeReceipt(refId).then((res) => {
          if (!res?.processing) return;
          // #R7-1b: a server turn that never sends a terminal ack would leave
          // this row in 'processing' forever on a stable connection. Arm a
          // bounded timeout that surfaces it as a retryable failure. A later
          // terminal ack clears this timer (above).
          const processingTimer = setTimeout(() => {
            ackTimers.current.delete(refId);
            void outbox.failProcessing(refId).then((applied) => {
              // #P1-E4: route through the MONOTONIC 'ack' path, not the ungated
              // 'delivery' action. This timer can fire and its failProcessing
              // CAS can still win the IDB race against a 'delivered' ack that
              // already advanced the UI — an ungated delivery:'failed' would
              // then regress a delivered row and show a false retry. Via 'ack'
              // status 'failed', advanceDelivery keeps a real 'delivered'
              // (higher rank) while still advancing pending/sent → failed.
              if (applied) dispatch({ type: 'ack', channel: env.channel, refId, status: 'failed' });
            });
          }, PROCESSING_TIMEOUT_MS);
          ackTimers.current.set(refId, processingTimer);
        });
      }
      else if (st === 'failed') void outbox.failByServer(refId);
      else if (st === 'stalled') {
        // #P1-A: the turn exceeded the server deadline and is STILL RUNNING
        // (outcome unknown). The no-ack/processing timer is already cleared
        // above; do NOT arm a new one (that would auto-surface a retry, which
        // could double side effects). Mark the row terminal-but-non-retryable;
        // the UI shows "still working", never "tap to retry".
        void outbox.markStalled(refId);
      }
      else {
        // Terminal success. #R8-1/#P1-E2: settle the response row AND prune the
        // durable approval REQUEST it answers in ONE atomic transaction, so a
        // reload can't re-render an already-answered card as un-answered (a
        // crash between two separate deletes could leave a request with no
        // response record → double-response). For a plain msg it just settles.
        void outbox.settleResponseAndPruneApproval(refId);
      }
      dispatch({ type: 'ack', channel: env.channel, refId, status: env.payload.status });
    } else if (env.kind === 'history.page') {
      const channel = env.payload.channel;
      // #P1-E3: capture the identity BEFORE any await. This handler performs
      // several awaits (kvGet, listApprovals, listForChannel); a wipe/re-pair
      // landing across any of them flips identityScopeRef SYNCHRONOUSLY. Every
      // continuation re-checks and bails if the identity changed, so identity
      // A's history/approvals/responses can never be dispatched into identity
      // B's (or a reset) UI.
      const fenceScope = identityScopeRef.current;
      void kvGet<string>(`lastread:${channel}`).then((lastRead) => {
        if (identityScopeRef.current !== fenceScope) return; // identity changed across the await
        dispatch({
          type: 'history',
          channel,
          agentId: channel,
          messages: env.payload.messages,
          nextBefore: env.payload.nextBefore,
          lastRead,
          active: isActive(channel),
        });
        // #R8-1 / #R7-2 / #P1-E1: a reload loses the interactive approval CARD
        // (history reconstructs the request only as text) and this device's
        // local response state. Rebuild both from durable, IDENTITY-SCOPED
        // stores:
        //  1. Re-render the approval cards from the approvals store (scoped by
        //     key), REPLACING the history text rows — so there is a card for
        //     the response reconcile to attach onto.
        //  2. Rehydrate responded state from the SCOPED outbox rows. #P1-E1:
        //     reconcile EVERY surviving (non-settled) response row — pending,
        //     sending, processing, failed, stalled — not just failed/processing.
        //     A still-'pending'/'sending' response omitted here would leave the
        //     card looking UNANSWERED, letting the user submit a second,
        //     competing response for the same refId.
        if (!fenceScope) return; // no identity: nothing scoped to reconcile
        void approvals.listApprovals(fenceScope, channel).then((stored) => {
          if (identityScopeRef.current !== fenceScope) return;
          if (stored.length > 0) dispatch({ type: 'reconcile-approvals', channel, approvals: stored.map((a) => a.env) });
          void outbox.listForChannel(channel, fenceScope).then((rows) => {
            if (identityScopeRef.current !== fenceScope) return;
            const responses = rows
              .filter((r) => r.env.kind === 'approval.response')
              .map((r) => {
                const p = (r.env as AnyEnvelope & { kind: 'approval.response' }).payload;
                // Map the durable send-state to a UI delivery. All of these
                // mark the card ANSWERED (respondedChoice set), so it can't be
                // re-answered; failed shows retry, stalled shows still-working.
                const delivery = (
                  r.status === 'failed' ? 'failed'
                    : r.status === 'stalled' ? 'stalled'
                      : r.status === 'processing' ? 'sent'
                        : 'pending'
                ) as 'failed' | 'stalled' | 'sent' | 'pending';
                return { refId: p.refId, choice: p.choice, responseId: r.id, editedText: p.editedText, delivery };
              });
            if (responses.length > 0) dispatch({ type: 'reconcile-responses', channel, responses });
          });
        });
      });
    }
  }, [isActive]);

  const attempt = useCallback(async (entry: outbox.OutboxEntry) => {
    const transport = transportRef.current;
    if (!transport) return;
    // R5-3/R6-3: the identity scope this tab is CURRENTLY allowed to send
    // as. Rows are shared per-origin across tabs, so a row written by a
    // stale tab (a since-wiped identity, or the same userId against a
    // DIFFERENT instance) can appear in this tab's listPending() snapshot.
    // The claim below requires this exact scope inside the same atomic
    // transaction — such a row is never claimed, and therefore never
    // transmitted, by this tab.
    const scope = identityScopeRef.current;
    if (!scope) return;
    // R4-3: drain() iterates a SNAPSHOT of listPending() taken at its start.
    // If a wipe (unpair/auth-error) clears the outbox WHILE that snapshot is
    // still being processed, a later entry in it no longer has a row —
    // markSending() returns null. transportRef.current, meanwhile, may
    // already point at a DIFFERENT identity's freshly-wired transport (a
    // re-pair can complete in the same window). Without this check, a stale
    // entry was sent through whatever transport happened to be active,
    // reaching the wrong user's session with the wrong user's content.
    //
    // R4-4: markSending() is a pending-only compare-and-set. Two tabs can
    // both see the same row as 'pending' in their own listPending()
    // snapshot; only the FIRST to actually commit its markSending()
    // transaction wins the claim (IndexedDB serializes the two 'readwrite'
    // transactions, and the second sees status already 'sending', not
    // 'pending' — so it fails the CAS and gets null back). Without this,
    // both tabs unconditionally flipped the row to 'sending' and both
    // transmitted it.
    //
    // R5-5: the returned token names THIS claim specifically. The failure
    // paths below (ack timer, send rejection) present it, so if this tab is
    // background-throttled past its lease and the row is re-claimed
    // elsewhere, their delayed writes no-op instead of clobbering the newer
    // owner's in-flight send.
    const claimToken = await outbox.markSending(entry.id, tabIdRef.current!, scope);
    if (!claimToken) return;
    try {
      await transport.send(entry.env);
      // msg and approval.response both get a server ack (bridge.ts) and so both
      // wait for round-trip confirmation before settling. Without this (R2-5),
      // approval.response settled the instant the browser accepted the send
      // buffer — a connection drop between that and the server actually
      // receiving it silently lost the decision while the UI showed "Responded".
      if (entry.env.kind === 'msg' || entry.env.kind === 'approval.response') {
        // Clear any prior stale timer before arming a new one for the same entry.
        const prior = ackTimers.current.get(entry.id);
        if (prior) clearTimeout(prior);
        const timer = setTimeout(() => {
          ackTimers.current.delete(entry.id);
          // #R6-7: only drive UI state when the token-gated write actually
          // applied — a stale claim's timeout (row since re-claimed by
          // another tab) must not mark a live in-flight send failed.
          void outbox.markFailed(entry.id, 'no ack', claimToken).then((applied) => {
            if (applied) dispatch({ type: 'delivery', channel: entry.channel, id: entry.id, delivery: 'failed' });
          });
        }, ACK_TIMEOUT_MS);
        ackTimers.current.set(entry.id, timer);
      } else {
        // Other non-msg envelopes (e.g. push.subscribe) are genuinely
        // fire-and-forget; settle them immediately without waiting for an ack.
        await outbox.settle(entry.id);
      }
    } catch (err) {
      // R3-11: markSendFailed's resulting status distinguishes a terminal
      // failure (MAX_ATTEMPTS reached — the outbox will not retry this entry
      // again on its own) from one that will still be retried. Only a
      // terminal failure should flip the UI out of "pending": without this,
      // the message/response stayed shown as pending forever once outbox
      // retries were exhausted, with no "tap to retry" affordance (gated on
      // delivery === 'failed' — see message-bubble.tsx / approval-card.tsx).
      const status = await outbox.markSendFailed(entry.id, err instanceof Error ? err.message : 'send failed', claimToken);
      if (status === 'failed') {
        dispatch({ type: 'delivery', channel: entry.channel, id: entry.id, delivery: 'failed' });
      }
    }
  }, []);

  const drain = useCallback(async () => {
    // Serialise concurrent drain() calls.  If a drain is already in flight,
    // set the pending flag and return — the in-flight drain will re-run once
    // after finishing, picking up any entries that were enqueued after its
    // initial listPending() snapshot.
    if (drainLockRef.current) { drainPendingRef.current = true; return; }
    drainLockRef.current = true;
    try {
      do {
        drainPendingRef.current = false;
        const pending = await outbox.listPending();
        // R5-3/R6-3: attempt()'s scope-gated claim is the authoritative
        // guard — it can never transmit a foreign-identity row. #R7-3: SKIP
        // such rows, do NOT delete them. The outbox is shared per-origin, so
        // a foreign-scope row may belong to a DIFFERENT identity that is live
        // in another tab; deleting it here destroyed that tab's queued data.
        // Leaving it is harmless (it can never be claimed under this scope);
        // its own identity's tab drains it, and its own wipe clears it.
        const scope = identityScopeRef.current;
        for (const entry of pending) {
          if (scope && entry.scope !== scope) continue; // not ours — leave it for its owner
          await attempt(entry);
        }
      } while (drainPendingRef.current);
    } finally {
      drainLockRef.current = false;
    }
  }, [attempt]);

  // R5-4/#R6-5b: coalescing timer for re-running the EXPIRY sweep once a
  // still-valid lease it had to skip lapses. A one-shot boot sweep alone
  // strands a row forever when the owning tab crashed moments before this
  // one loaded (lease still valid at boot → correctly skipped, and on a
  // stable connection nothing revisits it). The scheduled sweep — and the
  // coarse periodic safety sweep — call recoverExpiredSending, which honors
  // every row's lease, so an old timer firing late can NOT reclaim a newer
  // live claim (the R6-5b bug in the old owner-unconditional demoteSending).
  const leaseSweepTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const leaseSweepDueRef = useRef<number>(Infinity);
  const sweepLeasesRef = useRef<() => void>(() => {});
  // #R6-5: single coalescing scheduler — keep whichever pending sweep is
  // due EARLIEST. Fed from a sweep's own scan (an unexpired lease it skipped)
  // and other tabs' claim broadcasts (the raccoon-outbox listener), which
  // cover claims made AFTER this tab's boot sweep already ran.
  const scheduleSweepAt = useCallback((at: number) => {
    if (leaseSweepTimerRef.current !== null && leaseSweepDueRef.current <= at) return;
    if (leaseSweepTimerRef.current !== null) clearTimeout(leaseSweepTimerRef.current);
    leaseSweepDueRef.current = at;
    leaseSweepTimerRef.current = setTimeout(() => {
      leaseSweepTimerRef.current = null;
      leaseSweepDueRef.current = Infinity;
      void sweepLeasesRef.current();
    }, Math.max(at - Date.now(), 0));
  }, []);
  const sweepLeases = useCallback((): Promise<void> => {
    return outbox.recoverExpiredSending().then((nextExpiry) => {
      // Anything requeued only actually retransmits via drain — but never
      // drain over a closed transport (it would burn retry attempts).
      if (statusNowRef.current === 'open') void drain();
      if (nextExpiry !== null) scheduleSweepAt(nextExpiry + 100);
    });
  }, [drain, scheduleSweepAt]);
  sweepLeasesRef.current = sweepLeases;

  // Full local-identity wipe, used on unpair and on a terminal auth-error: cancel
  // pending ack timers, clear the kv store (session, read markers, push flag) AND the
  // outbox, and reset in-memory chat state. Without the outbox + state wipe, a
  // subsequent pairing as a different user would drain the prior user's queued
  // messages through the new session and briefly render their history.
  //
  // outbox.clearScope() (not a raw store clear) is required here: it is
  // serialized against the outbox sweeps (single transaction — see the outbox
  // module comment), so a concurrent demoteSending/sweep write can't land
  // after the clear and resurrect a row.
  //
  // #R7-3: clears ONLY the wiped identity's rows (`wipedScope`), not the whole
  // shared per-origin outbox — another tab logged in as a different identity
  // keeps its queued rows. `wipedScope` is captured by the caller BEFORE it
  // nulls identityScopeRef.
  const wipeAndReset = useCallback(async (wiped: ActiveSession | null) => {
    for (const timer of ackTimers.current.values()) clearTimeout(timer);
    ackTimers.current.clear();
    // #R6-5b: cancel any scheduled lease sweep — it must not survive a
    // wipe/re-pair and fire against a fresh identity.
    if (leaseSweepTimerRef.current) { clearTimeout(leaseSweepTimerRef.current); leaseSweepTimerRef.current = null; }
    leaseSweepDueRef.current = Infinity;
    // #R8-4: the SESSION is cleared by an atomic compare-and-clear (only if it
    // still matches the wiped identity), NOT a blanket wipeLocal() after async
    // work — an older unpair racing a newer tab's re-pair would otherwise
    // erase the newer session. Read markers / push flag are then cleared
    // WITHOUT touching the session key (wipeKvExceptSession), so a session a
    // concurrent re-pair wrote in the meantime is never collateral. The
    // outbox clear is already identity-scoped (#R7-3).
    const wipedScope = wiped ? identityKey(wiped) : null;
    await Promise.all([
      wipedScope ? clearSessionIfMatches(wipedScope, (s) => identityKey(withEpoch(s))) : Promise.resolve(false),
      wipeKvExceptSession(),
      wipedScope ? outbox.clearScope(wipedScope) : Promise.resolve(),
      // #R8-1: drop this identity's durable approval requests too, so a
      // re-pair as a different user cannot re-render the prior user's cards.
      wipedScope ? approvals.clearApprovalsForScope(wipedScope) : Promise.resolve(),
    ]);
    dispatch({ type: 'reset' });
  }, []);

  // Finding 2: requestHistory must be declared before wireTransport so the onStatus
  // handler inside wireTransport can reference it without use-before-declare issues.
  const requestHistory = useCallback((channel: string, before?: string) => {
    const userId = sessionRef.current?.userId;
    const transport = transportRef.current;
    if (!userId || !transport) return;
    void transport.send(createEnvelope('history.request', {
      from: userAddress(userId), to: agentAddress(channel), channel,
      payload: { channel, limit: HISTORY_LIMIT, ...(before ? { before } : {}) },
    })).catch(() => { /* retried on next open */ });
  }, []);

  const wireTransport = useCallback((transport: AppTransport) => {
    // Finding 1: tear down any existing subscriptions before re-wiring
    for (const unsub of unsubsRef.current) unsub();
    unsubsRef.current = [];

    transportRef.current = transport;
    const u1 = transport.onEnvelope(handleEnvelope);
    const u2 = transport.onStatus((s) => {
      // Update statusNowRef synchronously FIRST so that any async callbacks
      // that resolve immediately after this point (e.g. outbox.enqueue().then)
      // see the current status without waiting for a React render commit.
      statusNowRef.current = s;
      setStatus(s);
      if (s === 'open') {
        // #R6-2b: re-drive any 'processing' approval rows first — a terminal
        // ack lost to the disconnect otherwise leaves them stuck. Moving them
        // to 'pending' then draining re-sends the same envelope, which the
        // bridge answers with the real outcome (dedup-safe). drain() runs
        // after, covering both the recovered rows and normal pending ones.
        void outbox.recoverProcessing(identityScopeRef.current).then(() => drain());
        void drain();
        // Catch up history on every (re)connect: re-request the active channel AND
        // every already-loaded channel, so agent replies produced server-side while
        // we were disconnected appear instead of staying absent until a full reload.
        // The history reducer merges by id, so re-fetching the latest page is
        // idempotent (already-shown messages are deduped).
        const active = activeRef.current;
        const channels = new Set<string>(
          Object.keys(stateRef.current.historyLoaded).filter((c) => stateRef.current.historyLoaded[c]),
        );
        if (active) channels.add(active);
        for (const c of channels) requestHistory(c);
      }
      // #R6-5b: on close, reclaim THIS tab's own in-flight rows immediately
      // (owner-scoped, lease-independent) — its transport is gone, so it
      // cannot finish them; they must be pending for the reconnect drain.
      // NOT the expiry sweep (which is lease-based and owner-agnostic).
      if (s === 'closed') void outbox.releaseOwnedSending(tabIdRef.current!);
    });
    const isOverride = !!props.transportOverride;
    const u3 = transport.onAuthError(() => {
      if (isOverride) {
        // In override mode the host owns auth recovery — the transport's own
        // retry budget handles the first attempt.  Never terminal-unpair here;
        // just surface the error string and leave phase as 'ready'.
        setAuthError('Authentication error. The host is attempting to reconnect.');
      } else {
        // R4-3: bump AND null validUserIdRef synchronously, FIRST, before
        // anything else — see their declaration comments. This handler fires
        // from a transport event, entirely async-independent from any
        // in-flight sendEnvelope()/sendMessage() call, so both must happen
        // before the push-unsubscribe await below to close the window as
        // early as possible: sendMessage/respondApproval check
        // validUserIdRef and no-op when it's null, so this alone rejects any
        // send attempt from this instant onward — "leaves A's identity
        // usable until asynchronous cleanup completes" is exactly the gap
        // this closes. myGen is captured for the deferred state updates below.
        sessionGenRef.current += 1;
        const myGen = sessionGenRef.current;
        const wiped = sessionRef.current;
        validUserIdRef.current = null;
        identityScopeRef.current = null;
        // R5-3: tell every OTHER open tab this identity is gone, so none of
        // them keeps enqueueing/acting as it (their in-memory refs are their
        // own — the IDB wipe below alone would never reach them). Scoped to
        // the exact identity (#R6-8) so a delayed event can't log out an
        // unrelated newer session.
        if (wiped) bcRef.current?.postMessage({ type: 'identity-wiped', key: identityKey(wiped) });
        // Default (standalone) path: terminal unpair. Fully wipe local identity
        // state (session, read markers, push flag, queued outbox) and reset chat
        // state so a re-pair as a different user cannot inherit it, then drop back
        // to setup so the user can scan a new QR code.
        //
        // The transport is already closed here, so there is no live connection
        // to ask the server to drop the subscription (unlike unpair(), which
        // runs before closing). Still invalidate the browser-level subscription:
        // that tells the push service to stop routing to this endpoint AT ALL,
        // so even a stale server-side row for the now-revoked user can no
        // longer deliver here (a later send to it just 404/410s, which the
        // store already prunes on).
        void browserPushEnv()?.unsubscribeLocal().catch(() => { /* best-effort */ });

        // The REACT-STATE side of the transition (setSession/setPhase/etc.)
        // still defers until the wipe settles — but now guarded by the
        // generation captured above, not by "is this the only in-flight
        // wipe": if a newer wipe OR a newer successful pairing has already
        // bumped sessionGenRef past myGen by the time this resolves, skip —
        // applying it now would clobber a state transition that has already
        // superseded this one (the original TOCTOU this deferral pattern was
        // written to avoid: "a re-pair racing the async wipe could have its
        // freshly-saved session cleared").
        void wipeAndReset(wiped).finally(() => {
          if (sessionGenRef.current !== myGen) return;
          setSession(null);
          // R2-10: unpair() already clears this; the auth-error path did not,
          // so a stale activeChannel (and the URL's ?c= param, via ChatScreen)
          // could reopen a channel from the PRIOR user's session after a fresh
          // pairing, since openChannel() does not validate channel membership.
          setActiveChannel(null);
          setAuthError('This device was unpaired. Scan a new QR code to reconnect.');
          setPhase('setup');
        });
      }
    });
    // Finding 1: store all three unsubscribe functions
    unsubsRef.current = [u1, u2, u3];
  }, [drain, handleEnvelope, requestHistory, wipeAndReset, sweepLeases]);

  useEffect(() => {
    // #R6-5: recovery-sweep coordination. Boot-time and close-time sweeps
    // cannot cover a claim made AFTER they ran by a tab that then crashes —
    // on a stable connection nothing would ever sweep again, leaving that
    // row 'sending' forever. Every markSending() broadcasts its lease expiry
    // on 'raccoon-outbox'; schedule a precise sweep for that moment.
    let outboxBc: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      outboxBc = new BroadcastChannel('raccoon-outbox');
      outboxBc.addEventListener('message', (ev) => {
        const data = (ev as MessageEvent).data as { type?: string; leaseExpiresAt?: number } | undefined;
        if (data?.type !== 'claimed' || typeof data.leaseExpiresAt !== 'number') return;
        scheduleSweepAt(data.leaseExpiresAt + 100);
      });
    }
    // #R6-5b: coarse periodic safety sweep, ALWAYS on (not just as a
    // BroadcastChannel fallback). There is an unavoidable crash gap between a
    // claim's IndexedDB commit and its subsequent BroadcastChannel post: a
    // tab that crashes in that window leaves a claimed row no other tab was
    // ever told about. This lease-honoring periodic sweep is the backstop
    // that still recovers it. Coarse (one SEND_LEASE_MS) so it is cheap; the
    // precise per-claim scheduling above handles the common case promptly.
    const sweepInterval: ReturnType<typeof setInterval> = setInterval(
      () => { void sweepLeasesRef.current(); },
      outbox.SEND_LEASE_MS,
    );
    const stopSweepCoordination = (): void => {
      outboxBc?.close();
      clearInterval(sweepInterval);
      if (leaseSweepTimerRef.current) { clearTimeout(leaseSweepTimerRef.current); leaseSweepTimerRef.current = null; }
      leaseSweepDueRef.current = Infinity;
    };

    // Host-embedding fast path: a pre-constructed, already-authenticated transport
    // was injected — skip IDB session loading and go straight to ready.
    if (props.transportOverride) {
      // Set the session synchronously on the ref FIRST so that the very first
      // wireTransport → onStatus('open') → drain/requestHistory path sees a valid
      // userId.  The corresponding setSession call queues a React state update
      // (delivered asynchronously) but sessionRef.current is authoritative for all
      // imperative code paths (sendMessage, respondApproval, requestHistory).
      if (props.sessionOverride) {
        // #R8-5: guarantee a non-secret epoch (host may omit it) so the
        // identity key never derives from the secret sessionToken.
        // #P1-F2: a host override intentionally never persists (see the
        // provider-never-writes-IDB guarantee), so a MISSING epoch is minted
        // fresh EVERY mount → the identity key changes each mount → durable
        // outbox rows from a prior mount are stranded (unclaimable). A host
        // with durable local state MUST supply a stable, non-secret epoch.
        // Warn in dev rather than reject (rejecting would break the documented
        // token-less override path); GTM already supplies one.
        if (props.sessionOverride.epoch === undefined && process.env.NODE_ENV !== 'production') {
          console.warn('[raccoon] sessionOverride has no epoch: a fresh one is minted per mount, stranding durable outbox rows across remounts. Supply a stable non-secret epoch.');
        }
        const overrideSession = withEpoch(props.sessionOverride);
        sessionGenRef.current += 1;
        sessionRef.current = overrideSession;
        validUserIdRef.current = overrideSession.userId;
        identityScopeRef.current = identityKey(overrideSession);
        setSession(overrideSession);
      }
      const override = props.transportOverride;
      let overrideCancelled = false;
      // R3-8: requeue any 'sending' rows stranded by a crash/reload mid-send in a
      // prior session — demoteSending() otherwise only runs off the transport's
      // 'closed' event, which a killed tab never gets to fire. Must complete
      // BEFORE wireTransport so the first drain() this boot (triggered by the
      // 'open' status event) is guaranteed to see the requeued rows as 'pending',
      // not race against them still being 'sending'. Via sweepLeases (#R5-4)
      // so a skipped still-leased foreign row gets re-checked when it lapses.
      void sweepLeases().finally(() => {
        // R4-10: if the provider unmounted while demoteSending() was in
        // flight, the cleanup below already ran and will never run again —
        // wiring now would leave zombie subscriptions bound to this dead
        // component instance, and connect() a host-owned transport nobody
        // asked for.
        if (overrideCancelled) return;
        wireTransport(override);
        setPhase('ready');
        void override.connect().catch(() => { /* reconnect loop handles it */ });
      });
      return () => {
        overrideCancelled = true;
        stopSweepCoordination();
        for (const unsub of unsubsRef.current) unsub();
        unsubsRef.current = [];
        for (const timer of ackTimers.current.values()) clearTimeout(timer);
        ackTimers.current.clear();
        // Do NOT close the override transport — the host owns its lifecycle.
        transportRef.current = null;
      };
    }

    let cancelled = false;
    // R5-3: listen for another tab's wipe/unpair and tear this tab down too.
    // Without this, a tab left open across another tab's unpair kept its
    // in-memory identity live indefinitely — still able to enqueue outbox
    // rows (and show chat UI) as a user whose local state was already wiped.
    if (typeof BroadcastChannel !== 'undefined') {
      const bc = new BroadcastChannel('raccoon-identity');
      bcRef.current = bc;
      bc.addEventListener('message', (ev) => {
        const data = (ev as MessageEvent).data as { type?: string; key?: string } | undefined;
        if (cancelled || data?.type !== 'identity-wiped' || typeof data.key !== 'string') return;
        // #R6-4b: record the tombstone ALWAYS — even while this tab is still
        // loading and has no current identity to match — so the boot
        // continuation can refuse to install this exact identity if its IDB
        // read resolves after the wipe.
        wipeTombstonesRef.current.add(data.key);
        // #R6-8b: only tear down when the wiped identity IS this tab's CURRENT
        // one (complete key: instance+user+session epoch). A delayed or
        // unrelated event — another instance, another user, or a since
        // re-paired session (new epoch) for the same user@instance — must not
        // log the newer session out.
        const current = sessionRef.current;
        if (!current || identityKey(current) !== data.key) return;
        // Same synchronous-first discipline as the auth-error handler: kill
        // the identity before any async work, so in-flight sendMessage /
        // sendEnvelope calls are rejected from this instant on.
        sessionGenRef.current += 1;
        validUserIdRef.current = null;
        identityScopeRef.current = null;
        for (const timer of ackTimers.current.values()) clearTimeout(timer);
        ackTimers.current.clear();
        for (const unsub of unsubsRef.current) unsub();
        unsubsRef.current = [];
        void transportRef.current?.close();
        transportRef.current = null;
        dispatch({ type: 'reset' });
        setSession(null);
        setActiveChannel(null);
        setAuthError('This device was unpaired in another tab. Scan a new QR code to reconnect.');
        setPhase('setup');
      });
    }
    void loadSession().then(async (loaded) => {
      if (cancelled) return;
      if (!loaded) { setPhase('setup'); return; }
      // loadSession guarantees an epoch (persisted at pairing, lazily migrated
      // on load); withEpoch is a passthrough here that also satisfies the
      // epoch-required identityKey type.
      const session = withEpoch(loaded);
      // #R6-4b: a wipe for this exact identity may have arrived from another
      // tab WHILE this IDB read was in flight (the load snapshotted before
      // the other tab's clear committed, or raced it). Installing it now
      // would connect a just-unpaired session. Treat it as wiped: drop the
      // stale stored session and go to setup instead.
      // #R7-3: compare-and-clear — only delete the stored session if it STILL
      // matches the tombstoned identity. If the user re-paired in the interim
      // (a newer session was saved), an unconditional clearSession() would
      // delete that valid new session; clearSessionIfMatches leaves it.
      if (wipeTombstonesRef.current.has(identityKey(session))) {
        await clearSessionIfMatches(identityKey(session), (s) => identityKey(withEpoch(s))).catch(() => { /* best-effort */ });
        setPhase('setup');
        return;
      }
      // Update the ref immediately so callbacks (sendMessage etc.) can use the
      // session before the setSession re-render fires through the scheduler.
      // Bumps sessionGenRef too (a real identity transition — see its
      // declaration comment), so a since-superseded wipe's deferred state
      // update correctly detects it should no longer apply.
      sessionGenRef.current += 1;
      const bootGen = sessionGenRef.current;
      sessionRef.current = session;
      validUserIdRef.current = session.userId;
      identityScopeRef.current = identityKey(session);
      setSession(session);
      // R3-8: see the matching comment in the transportOverride branch above —
      // must complete before wireTransport so the boot drain() can't miss rows
      // stranded in 'sending' by a crash/reload in the previous session.
      // Via sweepLeases (#R5-4) so a skipped still-leased foreign row gets
      // re-checked when its lease lapses instead of stranding forever.
      await sweepLeases();
      // R4-10: re-check after the await above — if the provider unmounted
      // while demoteSending() was in flight, the cleanup below already ran
      // (transportRef was still null/stale at that point, so it had nothing
      // to close) and will never run again. Without this check, wiring and
      // connecting a transport here would leak it forever: nothing would
      // ever call close() on it.
      // #R6-4: the generation check catches what `cancelled` cannot — a
      // cross-tab identity-wiped (or any other identity transition) landing
      // during that await on a still-mounted provider. Wiring + connecting
      // the captured `loaded` session here would resurrect an identity that
      // was just torn down.
      if (cancelled || sessionGenRef.current !== bootGen) return;
      // #A3: this default boot path DIALS the WS transport from session.url, so
      // it needs one. A WS-paired session always has it; a host-managed session
      // (url now optional) never reaches here — it boots via sessionOverride +
      // transportOverride. Guard the widened type: no url ⇒ nothing to dial.
      if (!session.url) { setPhase('setup'); return; }
      const transport = makeTransport({ url: session.url, session: session.sessionToken, device: 'raccoon-app' });
      wireTransport(transport);
      setPhase('ready');
      try { await transport.connect(); } catch { /* reconnect loop handles it */ }
    });
    return () => {
      cancelled = true;
      bcRef.current?.close();
      bcRef.current = null;
      stopSweepCoordination();
      // Finding 1: clean up all subscriptions on unmount
      for (const unsub of unsubsRef.current) unsub();
      unsubsRef.current = [];
      // Finding 1: clear all pending ack timers on unmount
      for (const timer of ackTimers.current.values()) clearTimeout(timer);
      ackTimers.current.clear();
      void transportRef.current?.close();
      transportRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pairWithPayload = useCallback(async (json: string) => {
    const payload = parsePairingPayload(json);
    setAuthError(null);
    const transport = makeTransport({ url: payload.instanceUrl, pairingToken: payload.token, device: 'raccoon-app' });
    // #A2: interactive pairing requires the transport to support pair.grant. A
    // non-pairing transport (host-managed session) never reaches this path —
    // it's driven by sessionOverride, not pairWithPayload.
    if (!transport.onGrant) {
      setAuthError('This transport does not support interactive pairing.');
      return;
    }
    // Register the grant handler before connect; defer full wiring until after the grant
    // so that the connect-phase status change doesn't trigger React state updates outside act.
    const granted = new Promise<Session>((resolve) => {
      transport.onGrant!((g) => resolve({
        url: payload.instanceUrl,
        sessionToken: g.payload.sessionToken,
        userId: g.payload.userId,
        instance: g.payload.instance,
        channels: g.payload.channels,
        vapidPublicKey: g.payload.vapidPublicKey,
        // #R7-3: mint a fresh NON-SECRET epoch for this pairing so a re-pair
        // is distinguishable from the prior session (identityKey uses it, not
        // the secret token). Persisted below so all tabs share it.
        epoch: crypto.randomUUID(),
      }));
    });
    // Finding 3: wire the transport BEFORE connect so the initial 'open' status
    // emission during connect() is captured rather than missed.
    wireTransport(transport);
    await transport.connect();
    const next = await granted;
    // Set the ref synchronously (see loadSession's matching comment) and
    // bump sessionGenRef — a real identity transition, needed so a
    // since-superseded wipe's deferred state update (see the auth-error
    // handler / unpair()) correctly detects it should no longer apply.
    sessionGenRef.current += 1;
    const nextSession = withEpoch(next); // #R8-5: ensure a non-secret epoch
    sessionRef.current = nextSession;
    validUserIdRef.current = nextSession.userId;
    identityScopeRef.current = identityKey(nextSession);
    setSession(nextSession);
    setPhase('ready');
    void saveSession(next); // persist async; state is already updated
  }, [makeTransport, wireTransport]);

  const sendEnvelope = useCallback((env: AnyEnvelope) => {
    // Enqueue to IDB first.  Once the write commits, if the transport is already
    // open we call drain() rather than attempting this specific entry directly.
    // Drain serialises attempts (one at a time, in order) so there is no risk of
    // a concurrent drain + direct-attempt double-send.  The extra drain() call
    // is cheap when the outbox is empty or the entry was already picked up by a
    // concurrent drain triggered by the 'open' status event.
    //
    // We read statusNowRef — updated synchronously as the FIRST line of the
    // onStatus handler — instead of statusRef (React state), which may not have
    // been committed to the ref yet when this .then() runs.  This closes the
    // race where: the 'open' event fires → drain() runs before the enqueue IDB
    // tx has committed (entry not listed) → enqueue tx commits → .then fires
    // but sees stale 'closed' in statusRef → entry is orphaned until the next
    // reconnect.
    //
    // R4-3: capture the session generation now; if a wipe/unpair bumps it
    // before this enqueue's IDB write commits, the row was written under an
    // identity that is being (or has been) torn down — settle it away
    // instead of ever letting drain() see it as pending, so it can never be
    // sent through a different session's transport.
    const gen = sessionGenRef.current;
    const scope = identityScopeRef.current;
    if (!scope) return; // no identity: sendMessage/respondApproval already gate, this is belt-and-braces
    void outbox.enqueue(env, scope).then(() => {
      if (sessionGenRef.current !== gen) { void outbox.settle(env.id); return; }
      if (statusNowRef.current === 'open') void drain();
    });
  }, [drain]);

  const sendMessage = useCallback((channel: string, text: string) => {
    // R4-3: validUserIdRef, not sessionRef — see its declaration comment.
    // Nulled synchronously the instant a wipe/unpair decision is made, so a
    // send attempt from that point onward is rejected outright.
    const userId = validUserIdRef.current;
    if (!userId) return;
    const env = createEnvelope('msg', {
      from: userAddress(userId), to: agentAddress(channel), channel, payload: { text },
    });
    dispatch({
      type: 'optimistic',
      msg: { id: env.id, channel, role: 'user', sender: 'you', kind: 'text', text, ts: env.ts, delivery: 'pending' },
    });
    sendEnvelope(env);
  }, [sendEnvelope]);

  const respondApproval = useCallback((channel: string, refId: string, choice: string, editedText?: string) => {
    // R4-3: see sendMessage's matching comment.
    const userId = validUserIdRef.current;
    if (!userId) return;
    const env = createEnvelope('approval.response', {
      from: userAddress(userId), to: agentAddress(channel), channel,
      payload: { refId, choice, ...(editedText !== undefined ? { editedText } : {}) },
    });
    dispatch({ type: 'responded', channel, refId, choice, responseId: env.id, ...(editedText !== undefined ? { editedText } : {}) });
    sendEnvelope(env);
  }, [sendEnvelope]);

  const openChannel = useCallback((channel: string | null) => {
    // R2-10: validate membership against the CURRENT session's channel list.
    // Without this, a stale `?c=<channel>` URL param (ChatScreen reads it on
    // mount/popstate) could reopen a channel left over from a PRIOR user's
    // session after a fresh pairing on the same device/browser tab.
    // NOTE for host embeddings (transportOverride/sessionOverride): this makes
    // openChannel a silent no-op for any channel not in sessionOverride.channels.
    // Populate that list before the user can call openChannel, or every open
    // call will be silently dropped.
    if (channel && sessionRef.current && !sessionRef.current.channels.includes(channel)) return;
    setActiveChannel(channel);
    if (!channel) return;
    dispatch({ type: 'read-channel', channel });
    void kvSet(`lastread:${channel}`, new Date().toISOString());
    // Finding 2: only request history when the transport is open; if closed, the
    // onStatus handler will catch up when the transport reconnects.
    if (!stateRef.current.historyLoaded[channel] && statusNowRef.current === 'open') requestHistory(channel);
  }, [requestHistory]);

  const loadOlder = useCallback((channel: string) => {
    const before = stateRef.current.nextBefore[channel];
    if (before) requestHistory(channel, before);
  }, [requestHistory]);

  const retryMessage = useCallback((channel: string, id: string) => {
    void outbox.retry(id).then(async (applied) => {
      // #R6-7: retry() is a failed-only CAS — if the row is gone or another
      // tab holds a live claim on it, do nothing (no phantom 'pending' UI,
      // no drain that could double-send).
      if (!applied) return;
      dispatch({ type: 'delivery', channel, id, delivery: 'pending' });
      await drain();
    });
  }, [drain]);

  const enablePush = useCallback(async () => {
    const override = props.pushRegistrarOverride;
    if (override) {
      // Provider boundary guard: registrars are host-supplied — a rejecting
      // enable() must surface as false to the UI, not as an unhandled
      // rejection in the banner's click handler.
      let ok = false;
      try {
        ok = await override.enable();
      } catch {
        ok = false;
      }
      if (ok) await kvSet('push-enabled', true);
      return ok;
    }
    const current = sessionRef.current;
    const transport = transportRef.current;
    if (!current?.vapidPublicKey || !transport) return false;
    const env = browserPushEnv();
    if (!env) return false;
    const ok = await enablePushFlow({
      env,
      vapidPublicKey: current.vapidPublicKey,
      userId: current.userId,
      send: (e) => transport.send(e),
    });
    if (ok) await kvSet('push-enabled', true);
    return ok;
  }, [props.pushRegistrarOverride]);

  const unpair = useCallback(async () => {
    // R4-3: bump FIRST, synchronously, before any await — see sessionGenRef's
    // declaration comment. Any sendEnvelope() call whose enqueue() commits
    // after this point (no matter how the wipe's own async work interleaves)
    // observes the new generation and drops its row instead of leaving it to
    // be picked up by a later drain() under a different identity.
    sessionGenRef.current += 1;
    const myGen = sessionGenRef.current;
    // R5-3/#R6-8: tell every OTHER open tab this exact identity is gone —
    // see the auth-error handler's matching comment.
    const wiped = sessionRef.current;
    if (wiped) bcRef.current?.postMessage({ type: 'identity-wiped', key: identityKey(wiped) });
    // Tear down THIS device's push registration before closing the transport
    // (still need the connection + userId for the server-side unsubscribe).
    // Without this, only local app state was ever wiped: the server-side
    // subscription row and the browser's own PushManager registration both
    // survived, so the device kept receiving the PRIOR user's push
    // notifications (message bodies included) after pairing as someone else,
    // until the next 404/410-based prune (or indefinitely, if that never
    // happened). Best-effort: unpair proceeds regardless of outcome.
    //
    // Captured into locals BEFORE nulling validUserIdRef below — every
    // further use in this function reads these locals, never the ref, so
    // nulling it immediately (rather than only at the very end) closes the
    // window where a concurrent sendMessage()/respondApproval() call would
    // still see this (now-terminating) identity as valid.
    const userId = sessionRef.current?.userId;
    const transport = transportRef.current;
    validUserIdRef.current = null;
    identityScopeRef.current = null;
    // #P1-F3: invalidate the DURABLE session FIRST — before the un-timeout-
    // bounded push-disable / transport-close awaits below. Previously the only
    // durable clear was clearSessionIfMatches inside wipeAndReset() at the very
    // end, so a hung host push disable() (or the user closing the tab) during
    // those awaits left the session row in IDB and the "unpaired" device
    // silently reconnected on next boot. Compare-and-clear (only if it still
    // matches the wiped identity) so a concurrent re-pair's newer session is
    // not erased; wipeAndReset's own clearSessionIfMatches then no-ops.
    const wipedScope = wiped ? identityKey(wiped) : null;
    if (wipedScope) await clearSessionIfMatches(wipedScope, (s) => identityKey(withEpoch(s))).catch(() => { /* best-effort; wipeAndReset retries */ });
    if (props.pushRegistrarOverride) {
      await props.pushRegistrarOverride.disable?.().catch(() => { /* best-effort */ });
    } else if (userId && transport) {
      const env = browserPushEnv();
      if (env) {
        await unsubscribeCurrentPush({ env, userId, send: (e) => transport.send(e) }).catch(() => { /* best-effort */ });
      }
    }

    // Detach status/envelope listeners BEFORE closing, so this deliberate close
    // never fires our onStatus('closed') handler and never schedules a
    // demoteSending() call in the first place (defense in depth on top of the
    // clearAll()/demoteSending() serialization in wipeAndReset()).
    for (const unsub of unsubsRef.current) unsub();
    unsubsRef.current = [];
    await transportRef.current?.close();
    transportRef.current = null;
    await wipeAndReset(wiped);
    // Guarded the same way as the auth-error path: skip if a newer wipe or a
    // newer successful pairing has already superseded this one.
    if (sessionGenRef.current !== myGen) return;
    setSession(null);
    setActiveChannel(null);
    setPhase('setup');
  }, [wipeAndReset, props.pushRegistrarOverride]);

  const canEnablePush = !!session?.vapidPublicKey || !!props.pushRegistrarOverride;

  const api = useMemo<ChatApi>(() => ({
    phase, status, session, state, activeChannel, authError,
    pairWithPayload, openChannel, loadOlder, enablePush, canEnablePush, unpair,
    // sendMessage, respondApproval, retryMessage are only wired once the
    // session is loaded and the transport is connected (phase === 'ready').
    // Before ready they are undefined at runtime (the `as` cast is intentional —
    // callers that need to guard can check phase === 'ready' or use ?.() syntax,
    // and tests can rely on waitFor(() => expect(chat.sendMessage).toBeDefined())
    // to block until the session is available).
    sendMessage: (phase === 'ready' ? sendMessage : undefined) as ChatApi['sendMessage'],
    respondApproval: (phase === 'ready' ? respondApproval : undefined) as ChatApi['respondApproval'],
    retryMessage: (phase === 'ready' ? retryMessage : undefined) as ChatApi['retryMessage'],
  }), [phase, status, session, state, activeChannel, authError, pairWithPayload, openChannel, sendMessage, respondApproval, retryMessage, loadOlder, enablePush, canEnablePush, unpair]);

  return <ChatContext.Provider value={api}>{props.children}</ChatContext.Provider>;
}

export function useChat(): ChatApi {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within TransportProvider');
  return ctx;
}
