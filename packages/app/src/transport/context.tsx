import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState,
  type ReactNode,
} from 'react';
import {
  agentAddress, createEnvelope, parsePairingPayload, userAddress,
  type AnyEnvelope, type Attachment, type TransportStatus,
} from '@raccoon/protocol';
import { WsClientTransport } from '@raccoon/transport-ws';
import { ulid } from 'ulid';
import { kvDel, kvGet, kvSet, probeStorageWritable, wipeKvByPrefix } from '../lib/idb.js';
import { browserPushEnv, enablePushFlow, unsubscribeInstanceOnly } from '../lib/push-client.js';
import * as outbox from '../lib/outbox.js';
import * as approvals from '../lib/approvals.js';
import * as adopt from '../lib/adopt.js';
import {
  hostIdentityKey, loadPairingsRaw, removePairingIfMatches, updatePairingMeta, upsertPairing,
  type PairedSession, type Session,
} from '../lib/session.js';
import { accentColor, convKeyOf, nextAccentColor, resolveConvKey, type ConvKey } from '../lib/conv-key.js';
import { leaseUploads, type UploadProvider } from '../lib/uploads.js';
import { chatReducer, emptyChatState, type ChatState } from '../state/messages.js';
import type { AppTransport, MakeTransport, TransportRegistry } from './types.js';

export const ACK_TIMEOUT_MS = 10_000;
// #R7-1b: how long an approval may sit in 'processing' (server acked receipt
// but sent no terminal outcome) before the client surfaces it as a retryable
// failure. Generous — a real agent turn (LLM + tools) can legitimately take a
// while — but bounded, so a hung server turn can't spin forever.
export const PROCESSING_TIMEOUT_MS = 120_000;
// Self-healing typing dots: a 'typing stop' can be lost or reordered (QoS1
// redelivery across a reconnect can even replay a stale 'start' AFTER the
// reply landed), and nothing else would ever clear the indicator. Every
// 'start' arms this deadline; a fresh 'start' extends it, a 'stop' or the
// reply itself disarms it. Generous so a legitimately long agent turn keeps
// its dots for a while — but bounded, so the UI can't show a phantom
// "thinking" forever.
export const TYPING_AUTO_CLEAR_MS = 75_000;
const HISTORY_LIMIT = 50;
// #ER-2: how long ONE delivery attempt may await its transport.send() before
// the pairing's drain worker stops waiting and moves on. Must comfortably
// exceed any legitimate send round-trip, yet free the worker BEFORE the
// outbox lease-sweep horizon (outbox.SEND_LEASE_MS = 20s): a worker stuck on
// a half-dead transport un-parks while its row's claim is still leased, so
// the timeout itself never races the sweep's recovery of that same row.
export const SEND_ATTEMPT_TIMEOUT_MS = 15_000;
// Test seam (mirrors idb's __setBlockedTimeoutMsForTests): null restores the
// default. Never used outside tests.
let sendAttemptTimeoutMs = SEND_ATTEMPT_TIMEOUT_MS;
export function __setSendAttemptTimeoutForTests(ms: number | null): void {
  sendAttemptTimeoutMs = ms ?? SEND_ATTEMPT_TIMEOUT_MS;
}
// #R10: during interactive pairing, connect() can REJECT on a lost pair.confirmed
// even though the transport recovers in the background and re-emits the grant.
// If connect() rejected, wait this long for that recovery grant (or a terminal
// auth error) before declaring the pairing dead. Comfortably covers a reconnect
// cycle (backoff + resume round-trip); a terminal auth error fails fast and does
// not wait this out.
const PAIR_RECOVERY_GRACE_MS = 8_000;

/** One paired instance as the UI sees it. `pairingId` is the stable local
 *  scope key for ALL of this pairing's state (ConvKeys, outbox rows, approval
 *  keys, `lastread:` markers) — see lib/conv-key.ts and lib/session.ts. */
export interface PairingView {
  pairingId: string;
  instance: string;
  userId: string;
  channels: string[];
  displayName: string;          // pairing.displayName ?? pairing.instance
  color: string;                // pairing.color ?? accentColor(pairingId)
  status: TransportStatus;
  transportKind: string;        // 'ws' | 'host' | a registered kind
  url?: string;
}

export interface ChatApi {
  phase: 'loading' | 'setup' | 'ready' | 'storage-error';
  /** One entry per paired instance (replaces the old single `status` +
   *  `session`). A host override session appears as the single synthetic
   *  pairing. */
  pairings: PairingView[];
  state: ChatState;
  activeChannel: ConvKey | null;
  authError: string | null;
  /** Appends a pairing (or refreshes a re-scanned one in place); never wipes
   *  other pairings. Resolves false when pairing failed — the reason is
   *  surfaced via authError. Throws only on a malformed payload. */
  pairWithPayload(json: string): Promise<boolean>;
  /** #F6: re-probe durable storage from the 'storage-error' phase. On success,
   *  moves to 'setup' (pairing enabled); otherwise stays in 'storage-error'. */
  retryStorage(): Promise<void>;
  openChannel(key: ConvKey | null): void;
  /** Empty text is legal WITH attachments (image-only sends); blank
   *  no-attachment sends are rejected by the composer before this. */
  sendMessage(key: ConvKey, text: string, attachments?: Attachment[]): void;
  respondApproval(key: ConvKey, refId: string, choice: string, editedText?: string): void;
  retryMessage(key: ConvKey, id: string): void;
  loadOlder(key: ConvKey): void;
  enablePush(): Promise<boolean>;
  /** True when some push path is available: a VAPID key on some pairing or a
   *  host-supplied registrar override. Drives PushBanner eligibility. */
  canEnablePush: boolean;
  /** Auth seam for media uploads — uploadFile/deleteUpload/leaseUploads
   *  (lib/uploads.ts) take it as an argument. The default presents the LIVE
   *  token of the pairing that owns the ACTIVE conversation (falling back to
   *  the first pairing), read at call time; an embedding host injects its own
   *  via the `uploadProvider` prop. */
  uploadProvider: UploadProvider;
  /** Unpairs ONE pairing; the others keep running. */
  unpair(pairingId: string): Promise<void>;
  /** Local display-name override; empty string clears it back to the default. */
  renamePairing(pairingId: string, displayName: string): Promise<void>;
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
 * Ensure a session carries an epoch (#R8-5). The standard pairing/boot paths
 * always set one (minted at pairing, persisted on the stored pairing). A HOST
 * override may omit it — the documented host API permits a stable placeholder
 * sessionToken, so we must NEVER derive the identity from the token (that
 * would make re-pairs share an identity AND broadcast a secret). Mint a
 * per-mount random epoch instead. A host that wants cross-tab wipe
 * coordination for its sessions supplies its own persisted `epoch`.
 */
type ActiveSession = Session & { epoch: string };
function withEpoch(s: Session): ActiveSession {
  return { ...s, epoch: s.epoch ?? crypto.randomUUID() };
}

// #P1-F3 (adv-hardened): how long unpair() waits on a best-effort cleanup step
// (host push disable / server unsubscribe / transport close) before moving on.
// None of those are timeout-bounded on their own, and the durable per-pairing
// wipe — which retries the pairing removal — sits AFTER them; without this
// bound a hung disable() could keep that wipe from ever running, leaving a
// reconnectable pairing if the hoisted removal itself failed.
const UNPAIR_CLEANUP_TIMEOUT_MS = 3_000;

/** Run `fn` and resolve when it settles OR after `ms`, whichever is first —
 *  never rejects. #R10: takes a THUNK, not a value, so a SYNCHRONOUS throw from
 *  `fn` (e.g. a host disable() that throws before returning a promise) is
 *  caught here instead of escaping unpair(). The work keeps running detached;
 *  the caller just stops waiting. */
function settleWithinCall(fn: () => unknown, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    const t = setTimeout(finish, ms);
    void Promise.resolve().then(fn).catch(() => {}).finally(() => { clearTimeout(t); finish(); });
  });
}

const defaultMakeTransport: MakeTransport = (opts) => new WsClientTransport(opts) as AppTransport;

/** Default upload auth for the standalone app: present the LIVE token of the
 *  relevant pairing, read from the ref at CALL time (not captured at build
 *  time), so a re-pair mid-composer never uploads with a stale token and a
 *  token that arrives after mount is picked up without rebuilding the
 *  provider. The provider passes a ref-like whose `current` resolves the
 *  pairing that owns the ACTIVE conversation — uploads authenticate against
 *  the pairing being composed in — falling back to the first pairing when no
 *  conversation is open. Exported so the factory is unit-testable without
 *  mounting the provider.
 *
 *  v1 LIMITATION — media is NOT multi-pairing aware. There is one upload
 *  origin for the whole app: uploadFile/deleteUpload/leaseUploads resolve
 *  against `provider.baseUrl ?? ''`, i.e. the origin serving the app, while
 *  this provider presents the ACTIVE conversation's pairing token. So
 *  attachments only work for the pairing whose instance serves the app: a
 *  secondary pairing's uploads go to (and authenticate against) the wrong
 *  instance and fail, and its inbound relative `/media/...` attachment URLs
 *  resolve against the serving origin. Per-pairing media (baseUrl + token
 *  selected per conversation) is future work. */
export function buildDefaultUploadProvider(
  sessionRef: { readonly current: { sessionToken?: string } | null },
): UploadProvider {
  return {
    async getBearerToken() {
      const token = sessionRef.current?.sessionToken;
      // A host-managed session may legitimately carry no token (auth happens
      // out-of-band) — such hosts must inject their own uploadProvider.
      if (!token) throw new Error('No session token available for uploads. Pair this device first, or supply an uploadProvider when embedding.');
      return token;
    },
  };
}

/**
 * Props for TransportProvider.
 *
 * For the standalone OSS app: omit both override props — pairings load from
 * IDB and each is dialed by the factory registered for its transport kind
 * (the built-in WS factory covers 'ws').
 *
 * For a host embedding (e.g. a host application): supply `transportOverride`
 * with an already-constructed, already-authenticated transport AND
 * `sessionOverride` with the authenticated session.  The provider wires the
 * transport immediately (phase → 'ready'), skips IDB pairing storage, and
 * installs the session synchronously as the app's SINGLE synthetic pairing
 * (`ChatApi.pairings[0]`) so that `sendMessage`, `respondApproval`, and
 * history requests all see a valid `userId` from the very first call.  The
 * conversation list (`pairings[0].channels`) is also driven by this prop.
 *
 * `sessionOverride` SHOULD accompany every `transportOverride`.  Omitting it
 * leaves `pairings` empty: the conversation list will be empty and outbound
 * messages will silently no-op because no pairing identity is available.
 *
 * `sessionToken` and `url` in the override session may be placeholder strings —
 * they are not used when the transport bypasses the built-in auth flow.  The
 * host owns authentication; the provider never writes IDB pairings when
 * `transportOverride` is set.
 *
 * Alternatively, supply `makeTransport` to customise WS transport construction
 * while keeping the IDB pairing flow intact (it fills the registry's 'ws'
 * slot), and/or `transports` to register factories for additional transport
 * kinds selected by the pairing payload's `transport` field.
 */
export interface TransportProviderProps {
  /** Drop-in replacement for the built-in WS transport factory — the
   *  registry's 'ws' slot.  The factory may ignore opts. */
  makeTransport?: MakeTransport;
  /**
   * Per-kind transport factories, merged over the built-in registry
   * ({ ws: makeTransport ?? default }).  A stored pairing whose kind has no
   * factory stays LISTED but offline (no transport, status 'closed') — its
   * history remains readable and its sends queue in the outbox.
   */
  transports?: TransportRegistry;
  /**
   * Pre-constructed, already-authenticated transport.  When supplied the provider
   * skips IDB pairing loading and goes directly to phase='ready'.
   * Cannot be combined with `makeTransport`.
   */
  transportOverride?: AppTransport;
  /**
   * Companion to `transportOverride`.  The authenticated session the host supplies
   * (userId, channels, instance are the meaningful fields; url/sessionToken may be
   * placeholders).  When present the provider installs it synchronously as the
   * single synthetic pairing — before the transport is wired and connected — so
   * that all outbound calls have a valid userId from the very first tick.
   * Not persisted to IDB (the host owns identity).
   */
  sessionOverride?: Session;
  /**
   * Host-supplied push registration flow (e.g. a vendor SDK). When present it
   * takes precedence over the built-in VAPID/envelope flow and makes push
   * available even without a vapidPublicKey on any pairing.
   */
  pushRegistrarOverride?: PushRegistrar;
  /**
   * Host-supplied auth for media uploads. Mirrors `makeTransport`: optional,
   * with the default built in-provider from the live pairing token. A host
   * whose transport authenticates out-of-band (no real sessionToken on the
   * override session) MUST supply one for uploads to work — the default
   * rejects when no token is present.
   */
  uploadProvider?: UploadProvider;
  children: ReactNode;
}

/** Per-pairing runtime — one per stored pairing (plus the synthetic host
 *  pairing in override mode). Keyed in runtimesRef by pairingId, which is
 *  ALSO the outbox/approvals scope: `pairingId === scope`, always. */
interface PairingRuntime {
  pairing: PairedSession;               // latest stored snapshot
  transport: AppTransport | null;       // null = no factory for this kind (offline pairing)
  /** Synchronous status mirror (was the global statusNowRef): updated as the
   *  FIRST line of the onStatus handler, before any setState, so async
   *  continuations (e.g. outbox.enqueue().then) always see the actual current
   *  transport status without waiting for a React render commit. */
  statusNow: TransportStatus;
  unsubs: Array<() => void>;
  /** R4-3, per pairing: bumped synchronously on every identity transition of
   *  THIS pairing (unpair, auth-error, cross-tab wipe, refresh re-pair).
   *  Replaces the global sessionGenRef for send/enqueue fencing — per
   *  pairing, so wiping pairing B can never drop pairing A's in-flight
   *  enqueue. sendEnvelope captures it at call time and re-checks it once its
   *  enqueue() write commits; deferred wipe state-updates compare against the
   *  generation captured at their start, so a since-superseded wipe skips
   *  applying its now-stale transition (the TOCTOU the deferral exists to
   *  avoid). */
  gen: number;
  /** R4-3: the userId sendMessage/respondApproval are currently allowed to
   *  send as through this pairing. Nulled SYNCHRONOUSLY at wipe-start (before
   *  any await), set synchronously at establish — this is what actually
   *  closes "identity usable until asynchronous cleanup completes":
   *  sendMessage/respondApproval check THIS, so a call made from the instant
   *  the wipe decision is made onward is rejected outright, before it ever
   *  reaches outbox.enqueue(). */
  validUserId: string | null;
}

export function TransportProvider(props: TransportProviderProps) {
  const [phase, setPhase] = useState<'loading' | 'setup' | 'ready' | 'storage-error'>('loading');
  const [views, setViews] = useState<PairingView[]>([]);
  const [authError, setAuthError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(chatReducer, emptyChatState);
  const [activeChannel, setActiveChannel] = useState<ConvKey | null>(null);

  /** All live pairing runtimes, keyed by pairingId (=== outbox scope). */
  const runtimesRef = useRef(new Map<string, PairingRuntime>());
  const activeRef = useRef<ConvKey | null>(null);
  const stateRef = useRef<ChatState>(state);
  // #ER-2: PER-PAIRING drain serialization. Each pairing's outbox rows drain
  // through its own serialized worker (lock + pending, keyed by pairingId), so
  // a slow or never-resolving send on pairing A's transport can never
  // head-of-line block pairing B's queue — the old single global lock walked
  // every pairing's rows sequentially and one hung await starved them all.
  // Within one pairing the lock still prevents concurrent workers from
  // double-sending the same entry, and the pending flag coalesces re-triggers
  // that arrive while the worker runs (entries enqueued after its snapshot are
  // picked up by one re-run) — the same guarantees the global lock gave, now
  // per pairing. Entries are pruned when the runtime goes away (unpair /
  // auth-error / cross-tab wipe / unmount); a worker mid-flight keeps its own
  // state object, and attempt()'s claim CAS remains the authoritative
  // double-send guard either way.
  const drainStatesRef = useRef(new Map<string, { lock: boolean; pending: boolean }>());
  // R4-4: a stable, unique id for THIS tab/window instance, lazily generated
  // once. Stamped onto every row this tab claims via markSending() so
  // release/recovery can tell "a row I myself abandoned" (always safe to
  // requeue immediately) apart from "a row a DIFFERENT, possibly still-alive
  // tab is actively sending" (only safe to requeue once its lease expires) —
  // see outbox.ts's releaseOwnedSending()/recoverExpiredSending().
  const tabIdRef = useRef<string | undefined>(undefined);
  if (!tabIdRef.current) tabIdRef.current = crypto.randomUUID();
  // R5-3: cross-tab identity coordination. IndexedDB rows are shared
  // per-origin but every tab's in-memory pairing identities (validUserId,
  // runtimes) are its own — so a wipe/unpair in one tab left other
  // still-open tabs running the wiped pairing identity, free to keep
  // enqueueing rows as it. Wipe paths post 'identity-wiped' here; every other
  // tab tears down ONLY the matching pairing runtime on receipt (see the boot
  // effect's listener). Feature-detected: absent BroadcastChannel (very old
  // engines), the claim-time scope check in attempt()/markSending() still
  // prevents any cross-pairing transmission — this coordination just stops
  // the stale tab from acting at all.
  const bcRef = useRef<BroadcastChannel | null>(null);
  // #R6-4b: pairing identities (`${pairingId}::${epoch}`) wiped by ANOTHER tab,
  // recorded even while THIS tab is still loading its pairings from IDB
  // (before it has any runtimes to match against). The boot continuation
  // checks every loaded pairing against this set before installing it — so a
  // stale IDB read that resolves AFTER a concurrent wipe cannot connect a
  // just-wiped pairing. In-memory per tab; it only needs to guard this boot.
  const wipeTombstonesRef = useRef<Set<string>>(new Set());
  // Bumped on boot and on full teardown (storage-error, unmount) — the boot
  // continuation's cancel checks compare against it, alongside the per-pairing
  // runtime-existence checks that replace the old global sessionGenRef here.
  const bootGenRef = useRef(0);
  // refId → the armed no-ack/processing timer PLUS the ConvKey its deferred
  // dispatch would target. The convKey is stored so the per-pairing wipes can
  // prune EXACTLY this pairing's timers by key prefix: a timer left armed
  // across a wipe has row/claim-gated durable writes (those no-op), but its
  // dispatch into a since-dropped ConvKey would resurrect an invisible empty
  // state slice for the wiped pairing.
  const ackTimers = useRef(new Map<string, { timer: ReturnType<typeof setTimeout>; convKey: ConvKey }>());
  // ConvKey → auto-clear deadline for the typing indicator (TYPING_AUTO_CLEAR_MS).
  const typingTimers = useRef(new Map<ConvKey, ReturnType<typeof setTimeout>>());
  // #ER-1: dial-a-stored-pairing helper, reached through a ref because the
  // useCallback chain is circular otherwise (wipePairing needs it for the
  // stale-unpair self-heal, wirePairing needs wipePairing, dialPairing needs
  // wirePairing). Assigned right after dialPairing's definition — same
  // pattern as sweepLeasesRef.
  const dialPairingRef = useRef<(rt: PairingRuntime) => void>(() => {});

  stateRef.current = state;
  activeRef.current = activeChannel;

  /** Rebuild the PairingView list from the live runtimes. Called after every
   *  runtime mutation (install, status change, meta update, teardown). */
  const refreshViews = useCallback(() => {
    setViews([...runtimesRef.current.values()].map((r) => ({
      pairingId: r.pairing.pairingId,
      instance: r.pairing.instance,
      userId: r.pairing.userId,
      channels: r.pairing.channels,
      displayName: r.pairing.displayName ?? r.pairing.instance,
      color: r.pairing.color ?? accentColor(r.pairing.pairingId),
      status: r.statusNow,
      transportKind: r.pairing.transportKind,
      ...(r.pairing.url ? { url: r.pairing.url } : {}),
    })));
  }, []);

  // Effective registry: built-in ws (overridable via the legacy makeTransport
  // prop) + host-registered kinds. A stored pairing whose kind has no factory
  // stays LISTED but offline (transport null, status 'closed') — its history
  // remains readable and sends queue in its outbox.
  const registry = useMemo<TransportRegistry>(() => ({
    ws: props.makeTransport ?? defaultMakeTransport,
    ...props.transports,
  }), [props.makeTransport, props.transports]);

  // Ref-like session source for the default upload provider: resolves the
  // pairing that owns the ACTIVE conversation at CALL time (uploads
  // authenticate against the pairing being composed in), falling back to the
  // first runtime when no conversation is open. Stable for the component's
  // lifetime — the getter reads live refs.
  const activePairingSessionRef = useMemo(() => ({
    get current(): { sessionToken?: string } | null {
      const key = activeRef.current;
      const r = key ? resolveConvKey(key, runtimesRef.current.keys()) : null;
      const rt = r
        ? runtimesRef.current.get(r.pairingId)
        : runtimesRef.current.values().next().value as PairingRuntime | undefined;
      return rt ? rt.pairing : null;
    },
  }), []);

  // makeTransport pattern: the injected prop wins, else the built-in default.
  const uploadProvider = useMemo<UploadProvider>(
    () => props.uploadProvider ?? buildDefaultUploadProvider(activePairingSessionRef),
    [props.uploadProvider, activePairingSessionRef],
  );
  // Read at CALL time by the outbox lease paths (the enqueue-commit .then and
  // the drain-time renewal in attempt()) — mirrors the statusNow discipline so
  // an async continuation never captures a stale provider across a re-render.
  const uploadProviderRef = useRef<UploadProvider>(uploadProvider);
  uploadProviderRef.current = uploadProvider;

  const isActive = useCallback((key: ConvKey) => activeRef.current === key && document.visibilityState === 'visible', []);

  const clearTypingTimer = useCallback((key: ConvKey) => {
    const timer = typingTimers.current.get(key);
    if (timer) { clearTimeout(timer); typingTimers.current.delete(key); }
  }, []);

  /** Cancel every typing timer belonging to one pairing (its ConvKeys are
   *  prefixed by the pairingId). Used by the per-pairing wipes so pairing B's
   *  live indicator deadlines survive pairing A's teardown. */
  const clearPairingTypingTimers = useCallback((pairingId: string) => {
    const prefix = `${pairingId}/`;
    for (const [key, timer] of typingTimers.current) {
      if (key.startsWith(prefix)) { clearTimeout(timer); typingTimers.current.delete(key); }
    }
  }, []);

  /** Cancel every ack/processing timer belonging to one pairing. Timers are
   *  refId-keyed ACROSS pairings, so the captured convKey (prefixed by the
   *  pairingId) is what scopes the prune — other pairings' live timers stay
   *  armed. Used by every per-pairing teardown (unpair, auth-error, cross-tab
   *  wipe): a surviving timer's durable writes are claim-gated no-ops, but its
   *  dispatch would land in a dropped ConvKey and mint an empty state slice. */
  const clearPairingAckTimers = useCallback((pairingId: string) => {
    const prefix = `${pairingId}/`;
    for (const [refId, entry] of ackTimers.current) {
      if (entry.convKey.startsWith(prefix)) { clearTimeout(entry.timer); ackTimers.current.delete(refId); }
    }
  }, []);

  /**
   * Boundary stamping: envelope handling is a FACTORY closed over the source
   * pairingId — the wire never carries a pairingId, so the transport a message
   * arrived on is what names its pairing. Every dispatch keys state by the
   * ConvKey built here; envelope channels stay bare.
   */
  const makeEnvelopeHandler = useCallback((pairingId: string) => (env: AnyEnvelope) => {
    if (env.kind === 'msg') {
      const ck = convKeyOf(pairingId, env.channel);
      clearTypingTimer(ck); // the reply is the definitive 'stop'
      dispatch({ type: 'message', env, convKey: ck, active: isActive(ck) });
      if (isActive(ck)) void kvSet(`lastread:${ck}`, env.ts);
    } else if (env.kind === 'typing') {
      const ck = convKeyOf(pairingId, env.channel);
      const on = env.payload.state === 'start';
      clearTypingTimer(ck);
      if (on) {
        // Arm the self-heal deadline (see TYPING_AUTO_CLEAR_MS).
        typingTimers.current.set(ck, setTimeout(() => {
          typingTimers.current.delete(ck);
          dispatch({ type: 'typing', convKey: ck, on: false });
        }, TYPING_AUTO_CLEAR_MS));
      }
      dispatch({ type: 'typing', convKey: ck, on });
    }
    else if (env.kind === 'approval.request') {
      const ck = convKeyOf(pairingId, env.channel);
      clearTypingTimer(ck);
      dispatch({ type: 'approval', env, convKey: ck, active: isActive(ck) });
      if (isActive(ck)) void kvSet(`lastread:${ck}`, env.ts);
      // #R8-1: persist the request under this pairing's scope (the pairingId)
      // so a reload can re-render the interactive card (server history keeps
      // it only as text). Guarded by the runtime still existing — a request
      // racing this pairing's teardown is dropped, not persisted post-wipe.
      if (runtimesRef.current.has(pairingId)) {
        void approvals.saveApproval(pairingId, env).catch(() => { /* durability best-effort */ });
      }
    }
    else if (env.kind === 'ack') {
      const ck = convKeyOf(pairingId, env.channel);
      // The server responded for this envelope — stop the local no-ack
      // timeout regardless of which status it carries.
      const refId = env.payload.refId;
      const armed = ackTimers.current.get(refId);
      if (armed) { clearTimeout(armed.timer); ackTimers.current.delete(refId); }
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
              if (applied) dispatch({ type: 'ack', convKey: ck, refId, status: 'failed' });
            });
          }, PROCESSING_TIMEOUT_MS);
          ackTimers.current.set(refId, { timer: processingTimer, convKey: ck });
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
      dispatch({ type: 'ack', convKey: ck, refId, status: env.payload.status });
    } else if (env.kind === 'history.page') {
      const channel = env.payload.channel;
      const ck = convKeyOf(pairingId, channel);
      // #P1-E3: capture the pairing-identity fence BEFORE any await. This
      // handler performs several awaits (kvGet, listApprovals, listForChannel);
      // a wipe/re-pair of THIS pairing landing across any of them bumps its
      // runtime gen SYNCHRONOUSLY (or deletes the runtime). Every continuation
      // re-checks and bails if the pairing identity changed, so pairing A's
      // history/approvals/responses can never be dispatched into a
      // re-paired/reset UI.
      const rt = runtimesRef.current.get(pairingId);
      // #R10: bail immediately if there is NO live pairing identity. A
      // history.page arriving after a wipe must not dispatch history into a
      // reset state — there is no legitimate case for rendering history with
      // no identity.
      if (!rt || rt.validUserId === null) return;
      const fenceGen = rt.gen;
      const fenced = () => {
        const now = runtimesRef.current.get(pairingId);
        return now !== undefined && now === rt && now.gen === fenceGen;
      };
      void kvGet<string>(`lastread:${ck}`).then((lastRead) => {
        if (!fenced()) return; // pairing identity changed across the await
        dispatch({
          type: 'history',
          convKey: ck,
          agentId: channel,
          messages: env.payload.messages,
          nextBefore: env.payload.nextBefore,
          lastRead,
          active: isActive(ck),
        });
        // #R8-1 / #R7-2 / #P1-E1: a reload loses the interactive approval CARD
        // (history reconstructs the request only as text) and this device's
        // local response state. Rebuild both from durable, PAIRING-SCOPED
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
        // (Both stores keep BARE channel fields; the scope is the pairingId.)
        // #P1-E1 (adv-hardened): read BOTH stores first, then dispatch the card
        // and its response state in the SAME tick with no await between them.
        // Dispatching reconcile-approvals and then awaiting the outbox read
        // before reconcile-responses left a sub-frame window where the card
        // rendered interactive-and-UNANSWERED — a tap landing there minted a
        // competing second response for the refId (the exact bug E1 targets).
        // React batches two synchronous dispatches, so the card is never
        // painted answerable while a non-settled response exists.
        void Promise.all([
          approvals.listApprovals(pairingId, channel),
          outbox.listForChannel(channel, pairingId),
        ]).then(([stored, rows]) => {
          if (!fenced()) return; // fence after the awaits
          const responses = rows
            .filter((r) => r.env.kind === 'approval.response')
            .map((r) => {
              const p = (r.env as AnyEnvelope & { kind: 'approval.response' }).payload;
              // Map the durable send-state to a UI delivery. All of these mark
              // the card ANSWERED (respondedChoice set), so it can't be
              // re-answered; failed shows retry, stalled shows still-working.
              const delivery = (
                r.status === 'failed' ? 'failed'
                  : r.status === 'stalled' ? 'stalled'
                    : r.status === 'processing' ? 'sent'
                      : 'pending'
              ) as 'failed' | 'stalled' | 'sent' | 'pending';
              return { refId: p.refId, choice: p.choice, responseId: r.id, editedText: p.editedText, delivery };
            });
          // Same-tick, no await between: the card exists AND is marked answered
          // in one React commit.
          if (stored.length > 0) dispatch({ type: 'reconcile-approvals', convKey: ck, approvals: stored.map((a) => a.env) });
          if (responses.length > 0) dispatch({ type: 'reconcile-responses', convKey: ck, responses });
        });
      });
    }
  }, [isActive, clearTypingTimer]);

  const attempt = useCallback(async (entry: outbox.OutboxEntry) => {
    // Per-pairing routing: the row's scope IS its pairingId. A row for a
    // pairing we don't hold, or whose transport is closed, is skipped — its
    // own pairing drains it on reconnect. The explicit status gate replaces
    // the old caller-side "never drain over a closed transport" check, which
    // was global and cannot be per-pairing.
    const rt = runtimesRef.current.get(entry.scope ?? '');
    if (!rt || !rt.transport || rt.statusNow !== 'open') return;
    // R4-3: drain() iterates a SNAPSHOT of listPending() taken at its start.
    // If a wipe (unpair/auth-error) clears this pairing's rows WHILE that
    // snapshot is still being processed, a later entry in it no longer has a
    // row — markSending() returns null. A re-pair, meanwhile, may already
    // have installed a DIFFERENT identity's freshly-wired transport for the
    // same pairingId. Without this claim, a stale entry was sent through
    // whatever transport happened to be active, reaching the wrong user's
    // session with the wrong user's content.
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
    // R5-3/R6-3: the claim requires the row's persisted scope (the pairingId
    // it was enqueued under) verbatim, inside the same atomic transaction —
    // a row written by a stale tab under a since-wiped pairing identity is
    // never claimed, and therefore never transmitted, by this tab.
    //
    // R5-5: the returned token names THIS claim specifically. The failure
    // paths below (ack timer, send rejection) present it, so if this tab is
    // background-throttled past its lease and the row is re-claimed
    // elsewhere, their delayed writes no-op instead of clobbering the newer
    // owner's in-flight send.
    const claimToken = await outbox.markSending(entry.id, tabIdRef.current!, entry.scope!);
    if (!claimToken) return;
    const ck = convKeyOf(entry.scope!, entry.channel);
    if (entry.env.kind === 'msg') {
      const attachments = entry.env.payload.attachments;
      if (attachments && attachments.length > 0) {
        // Attachment lease RE-FIRED from durable outbox state before EVERY
        // delivery attempt: the enqueue-time call alone is not durable (a
        // crash/suspension right after enqueue, or a token hiccup, loses the
        // one shot; a row can also outlive its lease across long retry
        // windows). leaseUploads never rejects.
        const lease = await leaseUploads(attachments.map((a) => a.url), entry.id, uploadProviderRef.current);
        if (lease.ok && lease.unknown.length > 0) {
          // The lease EXPIRED and the sweep reclaimed those bytes — sending
          // would deliver dead URLs. Terminal and NOT retryable: the bubble
          // shows "Attachments expired — remove and re-attach" with no retry
          // affordance (re-attaching creates a fresh message). This caps a
          // failed message's attachment lifetime at the lease TTL, explicitly.
          const applied = await outbox.markFailed(entry.id, 'attachments-expired', claimToken);
          // Monotonic 'ack' route (see the ACK_TIMEOUT note below): a genuine
          // 'delivered' from an earlier attempt still outranks this.
          if (applied) dispatch({ type: 'ack', convKey: ck, refId: entry.id, status: 'failed', reason: 'attachments-expired' });
          return;
        }
        // { ok: false } = network/token trouble reaching the lease endpoint —
        // proceed with the send; the lease self-heals on the next drain.
      }
    }
    try {
      // #ER-2: never await a send unbounded — a transport whose send() hangs
      // (half-dead socket, a host transport that never settles) would
      // otherwise pin this pairing's drain worker forever. Race it against
      // SEND_ATTEMPT_TIMEOUT_MS; on timeout STOP WAITING and move on WITHOUT
      // marking the row failed: the send may still land. The row stays
      // 'sending' under its lease — the claim token makes a late
      // settle/failure write a no-op if the row was since re-claimed, and the
      // existing lease-expiry sweep recovers a genuinely dead claim. This
      // deliberately reuses the crash-recovery path: past the timeout, a hung
      // send is indistinguishable from a crashed owner, and that path is
      // already safe against both outcomes (late success settles via the
      // server ack; a dead claim requeues at lease expiry).
      let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        // Map settle/reject into values so a late settlement AFTER the
        // timeout won the race is consumed here (no unhandled rejection).
        rt.transport.send(entry.env).then(() => 'sent' as const, (err: unknown) => ({ err })),
        new Promise<'timeout'>((resolve) => { timeoutTimer = setTimeout(() => resolve('timeout'), sendAttemptTimeoutMs); }),
      ]).finally(() => clearTimeout(timeoutTimer));
      if (outcome === 'timeout') return;
      if (outcome !== 'sent') throw outcome.err; // rejected in time: the normal failure path below
      // msg and approval.response both get a server ack (bridge.ts) and so both
      // wait for round-trip confirmation before settling. Without this (R2-5),
      // approval.response settled the instant the browser accepted the send
      // buffer — a connection drop between that and the server actually
      // receiving it silently lost the decision while the UI showed "Responded".
      if (entry.env.kind === 'msg' || entry.env.kind === 'approval.response') {
        // Clear any prior stale timer before arming a new one for the same entry.
        const prior = ackTimers.current.get(entry.id);
        if (prior) clearTimeout(prior.timer);
        const timer = setTimeout(() => {
          ackTimers.current.delete(entry.id);
          // #R6-7: only drive UI state when the token-gated write actually
          // applied — a stale claim's timeout (row since re-claimed by
          // another tab) must not mark a live in-flight send failed.
          void outbox.markFailed(entry.id, 'no ack', claimToken).then((applied) => {
            // #R10: route through the MONOTONIC 'ack' path (like #P1-E4), not
            // the ungated 'delivery' action — a terminal 'delivered' ack that
            // arrived while this timer's markFailed CAS was pending must not be
            // regressed to 'failed'. advanceDelivery keeps the higher-rank
            // delivered/read; matches m.id (msg) or m.responseEnvId (approval).
            if (applied) dispatch({ type: 'ack', convKey: ck, refId: entry.id, status: 'failed' });
          });
        }, ACK_TIMEOUT_MS);
        ackTimers.current.set(entry.id, { timer, convKey: ck });
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
        // #R10: monotonic 'ack' route (see the ACK_TIMEOUT note above).
        dispatch({ type: 'ack', convKey: ck, refId: entry.id, status: 'failed' });
      }
    }
  }, []);

  /** ONE pairing's serialized drain worker (#ER-2): walks that pairing's
   *  pending rows oldest-first (listPending() is createdAt-sorted, so
   *  per-pairing ordering is preserved), re-running once for triggers
   *  coalesced while it ran. */
  const drainPairing = useCallback(async (pairingId: string) => {
    let st = drainStatesRef.current.get(pairingId);
    if (!st) { st = { lock: false, pending: false }; drainStatesRef.current.set(pairingId, st); }
    // Serialise concurrent calls for THIS pairing. If its worker is already
    // in flight, set the pending flag and return — the worker re-runs once
    // after finishing, picking up entries enqueued after its initial
    // listPending() snapshot.
    if (st.lock) { st.pending = true; return; }
    st.lock = true;
    try {
      do {
        st.pending = false;
        const pending = await outbox.listPending();
        // R5-3/R6-3: attempt()'s scope-gated claim is the authoritative
        // guard — it can never transmit a foreign-pairing row. #R7-3: SKIP
        // rows outside this worker's scope, do NOT delete them. The outbox
        // is shared per-origin, so a foreign row may belong to a DIFFERENT
        // identity live in another tab; deleting it here destroyed that
        // tab's queued data. Leaving it is harmless (it can never be claimed
        // under a scope we don't hold): another held pairing's rows are its
        // own worker's, and a row whose scope has no runtime here is simply
        // never picked up (drain() only kicks workers for held runtimes) —
        // its own identity's tab drains it, and its own wipe clears it.
        for (const entry of pending) {
          if (entry.scope !== pairingId) continue; // not this worker's row
          await attempt(entry);
        }
      } while (st.pending);
    } finally {
      st.lock = false;
    }
  }, [attempt]);

  /** drain(pairingId) drives that ONE pairing's worker — a reconnect on
   *  pairing A drains only A's rows; B's stay queued for B's own worker.
   *  drain() with no argument kicks every pairing that has a runtime
   *  (attempt()'s per-row status gate makes a kick over a closed transport a
   *  claim-free no-op). */
  const drain = useCallback(async (onlyPairingId?: string) => {
    if (onlyPairingId !== undefined) { await drainPairing(onlyPairingId); return; }
    await Promise.all([...runtimesRef.current.keys()].map((pid) => drainPairing(pid)));
  }, [drainPairing]);

  // R5-4/#R6-5b: coalescing timer for re-running the EXPIRY sweep once a
  // still-valid lease it had to skip lapses. A one-shot boot sweep alone
  // strands a row forever when the owning tab crashed moments before this
  // one loaded (lease still valid at boot → correctly skipped, and on a
  // stable connection nothing revisits it). The scheduled sweep — and the
  // coarse periodic safety sweep — call recoverExpiredSending, which honors
  // every row's lease, so an old timer firing late can NOT reclaim a newer
  // live claim (the R6-5b bug in the old owner-unconditional demoteSending).
  // The sweep machinery stays GLOBAL: it is lease-gated and scope-agnostic,
  // and attempt()'s per-pairing claim keeps it safe across pairing wipes.
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
      // Anything requeued only actually retransmits via drain — unfiltered,
      // since a recovered row can belong to any pairing; attempt()'s per-row
      // status gate keeps this safe over pairings whose transports are closed
      // (it returns before claiming, so no retry attempts are burned).
      void drain();
      if (nextExpiry !== null) scheduleSweepAt(nextExpiry + 100);
    });
  }, [drain, scheduleSweepAt]);
  sweepLeasesRef.current = sweepLeases;

  const requestHistory = useCallback((pairingId: string, channel: string, before?: string) => {
    const rt = runtimesRef.current.get(pairingId);
    const userId = rt?.validUserId;
    const transport = rt?.transport;
    if (!userId || !transport) return;
    void transport.send(createEnvelope('history.request', {
      from: userAddress(userId), to: agentAddress(channel), channel,
      payload: { channel, limit: HISTORY_LIMIT, ...(before ? { before } : {}) },
    })).catch(() => { /* retried on next open */ });
  }, []);

  /**
   * Per-pairing durable wipe, called only from wipePairing — the shared
   * teardown tail for unpair() and the terminal auth-error path: clears
   * exactly ONE pairing's slice of every store. (The tombstoned-boot path
   * does NOT come through here — it runs only removePairingIfMatches.)
   *
   * outbox.clearScope() (not a raw store clear) is required here: it is
   * serialized against the outbox sweeps (single transaction — see the outbox
   * module comment), so a concurrent release/sweep write can't land after the
   * clear and resurrect a row. #R7-3: it clears ONLY the wiped pairing's rows
   * (scope === pairingId) — other pairings (and other tabs' identities) keep
   * their queued rows. Without the outbox + chat-state wipe, a re-pair as a
   * different user could drain the prior user's queued messages through the
   * new session and briefly render their history.
   *
   * #R8-4: the pairing-list removal is an atomic epoch-gated compare-and-remove
   * (removePairingIfMatches) — an older unpair racing a newer re-pair (fresh
   * epoch, same pairingId) must not erase the newer stored pairing.
   *
   * #ER-1: that epoch-gated removal is not just cleanup — its result is the
   * AUTHORIZATION for every destructive clear below. A refresh-in-place
   * (re-scanning an already-paired instance) keeps the pairingId but mints a
   * NEW epoch, and there is no cross-tab refresh broadcast — so a caller
   * holding a STALE epoch (e.g. a tab whose runtime never saw another tab's
   * refresh) loses the compare-and-remove, and running the unconditional
   * clears anyway would erase the REFRESHED pairing's outbox rows, approval
   * cards, and read markers. `hoistedRemoved` carries the result of unpair()'s
   * hoisted #P1-F3 removal (on that path the retry here legitimately returns
   * false — the pairing is already removed); the auth-error path has no
   * hoisted removal, so the retry here is its authorization. When NEITHER
   * matched, perform NO durable writes and NO drop-pairing dispatch — return
   * false so wipePairing can self-heal onto the refreshed credentials.
   *
   * Ack timers are pruned by convKey prefix (clearPairingAckTimers): their
   * durable writes are row/claim-gated no-ops once this scope's rows are
   * cleared, but a timer firing after the wipe would still dispatch into a
   * dropped ConvKey and mint an invisible empty state slice. Other pairings'
   * refId-keyed timers stay armed — clearing ALL of them (the old global
   * wipe) would cancel their live deadlines.
   *
   * Returns whether the wipe was authorized (and therefore performed).
   */
  const wipePairingDurable = useCallback(async (
    pairingId: string, epoch: string, hoistedRemoved: boolean,
  ): Promise<boolean> => {
    const retryRemoved = await removePairingIfMatches(pairingId, epoch).catch(() => false);
    if (!hoistedRemoved && !retryRemoved) return false; // #ER-1: stale epoch — wipe nothing
    clearPairingTypingTimers(pairingId);
    clearPairingAckTimers(pairingId);
    await Promise.all([
      outbox.clearScope(pairingId),
      // #R8-1: drop this pairing's durable approval requests too, so a
      // re-pair as a different user cannot re-render the prior user's cards.
      approvals.clearApprovalsForScope(pairingId),
      wipeKvByPrefix(`lastread:${pairingId}/`),
    ]);
    // One pairing's slice only — a global 'reset' would wipe other pairings'
    // live conversations.
    dispatch({ type: 'drop-pairing', pairingId });
    return true;
  }, [clearPairingTypingTimers, clearPairingAckTimers]);

  /**
   * Shared teardown TAIL for unpair() and the terminal auth-error path — one
   * implementation of "listeners off, transport released, durable slice
   * wiped, runtime dropped, React state adjusted". The caller has already run
   * the synchronous-kill preamble (gen bump + validUserId null BEFORE any
   * await, identity-wiped broadcast) and captured myGen/wipedEpoch from it.
   *
   * closeTransport: true (unpair) bounds the close with settleWithinCall —
   * the transport is live and close() is not timeout-bounded on its own.
   * false (auth-error) — the transport already closed itself; just release it
   * fire-and-forget.
   *
   * hoistedRemoved: unpair()'s hoisted #P1-F3 removal result, threaded into
   * wipePairingDurable's #ER-1 authorization (absent on the auth-error path,
   * whose authorization is the durable wipe's own retry removal).
   *
   * Returns whether the final React-state transition APPLIED: false when a
   * newer wipe or a newer successful re-pair superseded this one mid-flight
   * (the R4-3 guard), OR when the wipe was refused as stale (#ER-1) — in
   * either case the caller must not surface UI for it.
   */
  const wipePairing = useCallback(async (
    rt: PairingRuntime, myGen: number, wipedEpoch: string,
    opts: { closeTransport: boolean; hoistedRemoved?: boolean },
  ): Promise<boolean> => {
    const pid = rt.pairing.pairingId;
    // Detach status/envelope listeners BEFORE closing, so a deliberate close
    // never fires our onStatus('closed') handler and never schedules a
    // releaseOwnedSending() call in the first place (defense in depth on top
    // of the clearScope()/release serialization in the outbox module).
    for (const u of rt.unsubs) u();
    rt.unsubs = [];
    // Never close an override transport — the host owns its lifecycle.
    if (rt.transport && rt.transport !== props.transportOverride) {
      if (opts.closeTransport) await settleWithinCall(() => rt.transport?.close(), UNPAIR_CLEANUP_TIMEOUT_MS);
      else void rt.transport?.close(); // auth-error: already closed; release fire-and-forget
    }
    rt.transport = null;
    // #ER-1 host exception: a host-override synthetic pairing intentionally
    // NEVER persists (#P1-F2), so BOTH the hoisted removal and the durable
    // wipe's retry always miss — but the epoch gate only exists to protect a
    // STORED pairing that may have been refreshed behind this caller's back,
    // and a host pairing has neither a store entry to protect nor a refresh
    // path (the host owns identity; pairWithPayload is rejected in override
    // mode). Its outbox/approvals/lastread rows DO live durably under the
    // hostIdentityKey scope, so without this the host unpair took the
    // self-heal branch and left them (plus the chat slice) to be resumed —
    // and transmitted — by a later remount with the same session. Treat it
    // as authorized so the full terminal wipe path runs.
    const isHostPairing = props.transportOverride !== undefined && rt.pairing.transportKind === 'host';
    const authorized = await wipePairingDurable(pid, wipedEpoch, (opts.hoistedRemoved ?? false) || isHostPairing);
    if (!authorized) {
      // #ER-1 self-heal: this caller's epoch is STALE — the stored pairing
      // was refreshed in place (same pairingId, new epoch/token) and NOTHING
      // durable was wiped above. The local runtime, though, holds the
      // superseded credentials, and its listeners/transport are already torn
      // down — finish the local teardown (timers) and RE-INSTALL the pairing
      // from the durable store, wiring + connecting through the same path
      // boot uses. Net effect: the stale unpair is a no-op that self-heals
      // this tab onto the refreshed credentials. (The 'identity-wiped'
      // broadcast the caller already posted carries the OLD epoch and is
      // correctly ignored by other tabs — #R6-8b.)
      clearPairingTypingTimers(pid);
      clearPairingAckTimers(pid);
      // Same supersession guard as the authorized path: only swap the runtime
      // while this one is still the installed one.
      if (runtimesRef.current.get(pid) !== rt || rt.gen !== myGen) return false;
      runtimesRef.current.delete(pid);
      drainStatesRef.current.delete(pid); // #ER-2: the re-install lazily creates fresh drain state
      const myBootGen = bootGenRef.current;
      const list = await loadPairingsRaw().catch((): PairedSession[] => []);
      // Unmount/storage-error teardown, or a concurrent install for the same
      // pairingId, landed across the await — do not resurrect over it.
      if (bootGenRef.current !== myBootGen || runtimesRef.current.has(pid)) return false;
      const stored = list.find((p) => p.pairingId === pid);
      if (stored) {
        const fresh: PairingRuntime = {
          pairing: stored, transport: null, statusNow: 'closed', unsubs: [],
          // Monotonic across the swap (R4-3): a stale sendEnvelope
          // continuation fenced on the old runtime's pre-bump gen must not
          // match the fresh runtime.
          gen: myGen + 1, validUserId: stored.userId,
        };
        runtimesRef.current.set(pid, fresh);
        dialPairingRef.current(fresh);
      } else {
        // The pairing is gone from the store ENTIRELY (removed wholesale by
        // another actor — not the refresh case): there is nothing to
        // re-install onto. Drop the in-memory chat slice — a memory-only
        // dispatch, safe without wipe authorization (the durable clears stay
        // withheld) — so a truly-removed pairing doesn't leave a stale slice
        // behind a runtime that no longer exists.
        dispatch({ type: 'drop-pairing', pairingId: pid });
      }
      refreshViews();
      // Phase stays 'ready' when the pairing was re-installed; if the store
      // no longer holds it at all, fall back to the same size-based phase the
      // authorized path uses.
      setPhase(runtimesRef.current.size === 0 ? 'setup' : 'ready');
      return false;
    }
    // R4-3 guard: skip the final state transition if a newer wipe OR a newer
    // successful re-pair has already bumped this runtime's gen (or replaced
    // the runtime) — applying it now would clobber the transition that
    // superseded this one (the TOCTOU the deferral pattern exists to avoid).
    if (runtimesRef.current.get(pid) !== rt || rt.gen !== myGen) return false;
    runtimesRef.current.delete(pid);
    drainStatesRef.current.delete(pid); // #ER-2: no runtime, no drain worker state
    // Browser-level push teardown belongs to the LAST pairing only, and the
    // "last" determination is made HERE — at the point this runtime is
    // actually removed — so two concurrent terminal wipes (unpair or
    // auth-error) of the final two pairings cannot both observe a
    // pre-deletion size of 2 and both skip it: only the wipe that deletes the
    // final runtime sees size 0. The subscription endpoint is shared
    // device-wide across pairings; the per-instance server-side unsubscribe
    // happens in unpair() while the transport is still live (impossible on
    // the auth-error path — the transport is already dead; a later push to
    // the stale server row 404/410s, which the store prunes on). A host push
    // registrar has no browser-level half here — its device-level disable()
    // runs in unpair() itself. Bounded + fire-and-forget: best-effort
    // teardown must not delay the React-state transition below.
    if (runtimesRef.current.size === 0) {
      if (!props.pushRegistrarOverride) {
        void settleWithinCall(() => browserPushEnv()?.unsubscribeLocal(), UNPAIR_CLEANUP_TIMEOUT_MS);
      }
      void kvDel('push-enabled').catch(() => { /* best-effort */ });
    }
    refreshViews();
    // R2-10: clear a stale active conversation belonging to this pairing (and
    // the URL's ?c= param, via ChatScreen) so it cannot reopen under a fresh
    // pairing.
    if (activeRef.current && resolveConvKey(activeRef.current, [pid])) setActiveChannel(null);
    setPhase(runtimesRef.current.size === 0 ? 'setup' : 'ready');
    return true;
  }, [wipePairingDurable, refreshViews, props.transportOverride, props.pushRegistrarOverride]);

  /** Open-time catch-up for ONE pairing: re-drive its processing rows, drain
   *  its queued sends, and re-request history for its channels + its already-
   *  loaded conversations (+ the active one if it belongs to this pairing). */
  const catchUpOnOpen = useCallback((rt: PairingRuntime) => {
    const pid = rt.pairing.pairingId;
    // #R6-2b: re-drive any 'processing' approval rows first — a terminal
    // ack lost to the disconnect otherwise leaves them stuck. Moving them
    // to 'pending' then draining re-sends the same envelope, which the
    // bridge answers with the real outcome (dedup-safe). drain() runs
    // after, covering both the recovered rows and normal pending ones.
    void outbox.recoverProcessing(pid).then(() => drain(pid));
    void drain(pid);
    // Catch up history on every (re)connect — per pairing: request EVERY
    // channel THIS pairing exposes, plus its already-loaded conversations and
    // the active one when it belongs to this pairing. Seeding from the
    // pairing's channels is what hydrates the conversation-list preview
    // (last message + unread) on a fresh launch — without it the list stays
    // blank until the user opens each chat, because state.messages is only
    // populated by a history fetch. The reducer merges by id, so re-fetching
    // the latest page is idempotent (already-shown messages are deduped).
    const channels = new Set<string>(rt.pairing.channels);
    for (const ck of Object.keys(stateRef.current.historyLoaded)) {
      if (!stateRef.current.historyLoaded[ck]) continue;
      const r = resolveConvKey(ck, [pid]);
      if (r) channels.add(r.channel);
    }
    const active = activeRef.current ? resolveConvKey(activeRef.current, [pid]) : null;
    if (active) channels.add(active.channel);
    for (const c of channels) requestHistory(pid, c);
  }, [drain, requestHistory]);

  const wirePairing = useCallback((rt: PairingRuntime, transport: AppTransport) => {
    // Tear down any existing subscriptions before re-wiring.
    for (const u of rt.unsubs) u();
    rt.unsubs = [];
    rt.transport = transport;
    const pid = rt.pairing.pairingId;
    const u1 = transport.onEnvelope(makeEnvelopeHandler(pid));
    const u2 = transport.onStatus((s) => {
      // Update statusNow synchronously FIRST so that any async callbacks
      // that resolve immediately after this point (e.g. outbox.enqueue().then)
      // see the current status without waiting for a React render commit.
      rt.statusNow = s;
      refreshViews();
      if (s === 'open') catchUpOnOpen(rt);
      // #R6-5b: on close, reclaim THIS tab's own in-flight rows immediately
      // (owner-scoped, lease-independent) — this pairing's transport is gone,
      // so it cannot finish them; they must be pending for the reconnect
      // drain. NOT the expiry sweep (which is lease-based and owner-agnostic).
      // Scope-filtered (multi-pairing): only THIS pairing's in-flight rows
      // lost their transport — another pairing's actively-in-flight row must
      // not be requeued (that would double-send it when its own drain retries).
      if (s === 'closed') void outbox.releaseOwnedSending(tabIdRef.current!, pid);
    });
    const isOverride = transport === props.transportOverride;
    const u3 = transport.onAuthError(() => {
      if (isOverride) {
        // In override mode the host owns auth recovery — the transport's own
        // retry budget handles the first attempt.  Never terminal-unpair here;
        // just surface the error string and leave phase as 'ready'.
        setAuthError('Authentication error. The host is attempting to reconnect.');
        return;
      }
      // Default (standalone) path: terminal unpair of THIS pairing only.
      // Guard: only act while this runtime is still the installed one.
      if (runtimesRef.current.get(pid) !== rt) return;
      // R4-3: bump AND null validUserId synchronously, FIRST, before
      // anything else — see PairingRuntime's field comments. This handler
      // fires from a transport event, entirely async-independent from any
      // in-flight sendEnvelope()/sendMessage() call, so both must happen
      // before the push-unsubscribe below to close the window as early as
      // possible: sendMessage/respondApproval check validUserId and no-op
      // when it's null, so this alone rejects any send attempt through this
      // pairing from this instant onward — "leaves A's identity usable until
      // asynchronous cleanup completes" is exactly the gap this closes.
      // myGen is captured for the deferred state updates in wipePairing.
      rt.gen += 1;
      const myGen = rt.gen;
      const wiped = rt.pairing;
      rt.validUserId = null;
      // R5-3: tell every OTHER open tab this pairing identity is gone, so
      // none of them keeps enqueueing/acting as it (their in-memory runtimes
      // are their own — the IDB wipe below alone would never reach them).
      // Scoped to the exact pairing identity (#R6-8: pairingId + epoch) so a
      // delayed event can't log out an unrelated newer pairing.
      bcRef.current?.postMessage({ type: 'identity-wiped', pairingId: pid, epoch: wiped.epoch });
      // Push: the transport is already closed here, so the per-instance
      // server-side unsubscribe (unpair()'s unsubscribeInstanceOnly) is
      // impossible — a later push to the stale server row 404/410s, which the
      // store prunes on. The browser-level subscription is shared by every
      // pairing, so it is torn down only when the LAST runtime is actually
      // removed — inside wipePairing, at the deletion point, where the
      // last-pairing check cannot race a concurrent wipe of another pairing.
      // The REACT-STATE side of the transition defers until the wipe settles,
      // guarded inside wipePairing by the generation captured above: only if
      // the transition actually APPLIED does the instance-named error surface
      // — a superseding re-pair must not flash "unpaired" for a pairing that
      // just came back.
      void wipePairing(rt, myGen, wiped.epoch, { closeTransport: false }).then((applied) => {
        if (!applied) return;
        setAuthError(`${wiped.displayName ?? wiped.instance} was unpaired by its server. Scan a new QR code to reconnect it.`);
      });
    });
    rt.unsubs = [u1, u2, u3];
  }, [makeEnvelopeHandler, catchUpOnOpen, refreshViews, wipePairing, props.transportOverride]);

  /** Dial + wire + connect ONE stored pairing's transport onto an installed
   *  runtime — the shared install path for the boot effect and the
   *  stale-unpair self-heal (#ER-1). #A3: no registered factory for the
   *  pairing's kind, or no stored url ⇒ the pairing stays LISTED but offline
   *  (transport null, status 'closed') — its history remains readable and its
   *  sends queue in the outbox. */
  const dialPairing = useCallback((rt: PairingRuntime) => {
    const p = rt.pairing;
    const make = registry[p.transportKind];
    if (!make || !p.url) return;
    const transport = make({ url: p.url, session: p.sessionToken, device: 'raccoon-app' });
    wirePairing(rt, transport);
    void transport.connect().catch(() => { /* per-pairing reconnect loop handles it */ });
  }, [registry, wirePairing]);
  dialPairingRef.current = dialPairing;

  useEffect(() => {
    bootGenRef.current += 1;
    const bootGen = bootGenRef.current;
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
    const teardownRuntimes = (): void => {
      for (const rt of runtimesRef.current.values()) {
        for (const u of rt.unsubs) u();
        rt.unsubs = [];
        // Do NOT close an override transport — the host owns its lifecycle.
        if (rt.transport && rt.transport !== props.transportOverride) void rt.transport.close();
        rt.transport = null;
      }
      runtimesRef.current.clear();
      drainStatesRef.current.clear(); // #ER-2: per-pairing drain state goes with the runtimes
    };
    const clearTimers = (): void => {
      for (const { timer } of ackTimers.current.values()) clearTimeout(timer);
      ackTimers.current.clear();
      for (const timer of typingTimers.current.values()) clearTimeout(timer);
      typingTimers.current.clear();
    };

    // Host-embedding fast path: a pre-constructed, already-authenticated transport
    // was injected — skip IDB pairing loading and go straight to ready.
    if (props.transportOverride) {
      // Install the synthetic host pairing synchronously FIRST so that the very
      // first wirePairing → onStatus('open') → drain/requestHistory path sees a
      // valid userId. The runtime map is authoritative for all imperative code
      // paths (sendMessage, respondApproval, requestHistory).
      let hostRt: PairingRuntime | null = null;
      if (props.sessionOverride) {
        // #R8-5: guarantee a non-secret epoch (host may omit it) so the
        // pairing identity never derives from the secret sessionToken.
        // #P1-F2: a host override intentionally never persists (see the
        // provider-never-writes-IDB guarantee), so a MISSING epoch is minted
        // fresh EVERY mount → the identity key changes each mount → durable
        // outbox rows from a prior mount are stranded (unclaimable). A host
        // with durable local state MUST supply a stable, non-secret epoch.
        // Warn in dev rather than reject (rejecting would break the documented
        // token-less override path); a managed host with durable state supplies one.
        if (props.sessionOverride.epoch === undefined && process.env.NODE_ENV !== 'production') {
          console.warn('[raccoon] sessionOverride has no epoch: a fresh one is minted per mount, stranding durable outbox rows across remounts. Supply a stable non-secret epoch.');
        }
        const overrideSession = withEpoch(props.sessionOverride);
        // pairingId === the legacy identity key, so a host install's existing
        // outbox/approvals scope bytes in IDB are unchanged and its rows stay
        // claimable with no migration.
        const pid = hostIdentityKey(overrideSession);
        const pairing: PairedSession = { ...overrideSession, pairingId: pid, transportKind: 'host' };
        hostRt = { pairing, transport: null, statusNow: 'closed', unsubs: [], gen: 1, validUserId: pairing.userId };
        runtimesRef.current.set(pid, hostRt);
        refreshViews();
      }
      // (If sessionOverride is absent — documented as a broken-but-legal host
      // config — there is no runtime; sends no-op exactly as before.)
      const override = props.transportOverride;
      let overrideCancelled = false;
      // R3-8: requeue any 'sending' rows stranded by a crash/reload mid-send in a
      // prior session — releaseOwnedSending otherwise only runs off the transport's
      // 'closed' event, which a killed tab never gets to fire. Must complete
      // BEFORE wirePairing so the first drain() this boot (triggered by the
      // 'open' status event) is guaranteed to see the requeued rows as 'pending',
      // not race against them still being 'sending'. Via sweepLeases (#R5-4)
      // so a skipped still-leased foreign row gets re-checked when it lapses.
      void sweepLeases().finally(() => {
        // R4-10: if the provider unmounted while the sweep was in flight, the
        // cleanup below already ran and will never run again — wiring now
        // would leave zombie subscriptions bound to this dead component
        // instance, and connect() a host-owned transport nobody asked for.
        if (overrideCancelled) return;
        if (hostRt) wirePairing(hostRt, override);
        setPhase('ready');
        void override.connect().catch(() => { /* reconnect loop handles it */ });
      });
      return () => {
        overrideCancelled = true;
        bootGenRef.current += 1;
        stopSweepCoordination();
        teardownRuntimes();
        clearTimers();
      };
    }

    let cancelled = false;
    // R5-3: listen for another tab's wipe/unpair and tear down the matching
    // pairing runtime in this tab too. Without this, a tab left open across
    // another tab's unpair kept that pairing's in-memory identity live
    // indefinitely — still able to enqueue outbox rows (and show chat UI) as
    // a user whose local state was already wiped.
    if (typeof BroadcastChannel !== 'undefined') {
      const bc = new BroadcastChannel('raccoon-identity');
      bcRef.current = bc;
      bc.addEventListener('message', (ev) => {
        const data = (ev as MessageEvent).data as { type?: string; pairingId?: string; epoch?: string } | undefined;
        if (cancelled || data?.type !== 'identity-wiped' || typeof data.pairingId !== 'string' || typeof data.epoch !== 'string') return;
        // #R6-4b: record the tombstone ALWAYS — even while this tab is still
        // loading its pairings and has no runtimes to match against — so the
        // boot continuation can refuse to install this exact pairing if its
        // IDB read resolves after the wipe.
        wipeTombstonesRef.current.add(`${data.pairingId}::${data.epoch}`);
        // #R6-8b: only tear down when the wiped pairing IS one this tab
        // currently holds at the SAME epoch. A delayed or unrelated event —
        // another pairing, or a since-refreshed pairing (new epoch) for the
        // same pairingId — must not log the newer pairing out.
        const rt = runtimesRef.current.get(data.pairingId);
        if (!rt || rt.pairing.epoch !== data.epoch) return;
        // Same synchronous-first discipline as the auth-error handler: kill
        // the pairing identity before any async work, so in-flight
        // sendMessage / sendEnvelope calls are rejected from this instant on.
        rt.gen += 1;
        rt.validUserId = null;
        for (const u of rt.unsubs) u();
        rt.unsubs = [];
        // Never close an override transport — the host owns its lifecycle
        // (same guard as wipePairing; unreachable today since this listener
        // only registers in non-override mode, but kept consistent).
        if (rt.transport && rt.transport !== props.transportOverride) void rt.transport.close();
        rt.transport = null;
        clearPairingTypingTimers(data.pairingId);
        // Prune THIS pairing's ack timers too: their row/claim-gated durable
        // writes no-op once the wiping tab's clearScope commits, but a timer
        // firing in the sub-window would still dispatch into the ConvKey
        // dropped below, minting an invisible empty state slice. Scoped by
        // convKey prefix — other pairings' live timers stay armed.
        clearPairingAckTimers(data.pairingId);
        // The wiping tab owns the durable clears; this tab only drops its
        // in-memory slice.
        dispatch({ type: 'drop-pairing', pairingId: data.pairingId });
        runtimesRef.current.delete(data.pairingId);
        drainStatesRef.current.delete(data.pairingId); // #ER-2: no runtime, no drain worker state
        refreshViews();
        if (activeRef.current && resolveConvKey(activeRef.current, [data.pairingId])) setActiveChannel(null);
        if (runtimesRef.current.size === 0) {
          setAuthError('This device was unpaired in another tab. Scan a new QR code to reconnect.');
          setPhase('setup');
        }
      });
    }
    // #F6: gate boot on a durable-storage write-probe. If storage is unusable
    // (private browsing / quota / blocked open) enter the distinct
    // 'storage-error' state, NOT 'setup' — pairing must stay disabled until a
    // write actually works, since a pair here could never be durably saved.
    void probeStorageWritable().then((writable) => {
      if (cancelled) return;
      if (!writable) {
        setAuthError('This device can’t save data locally (private browsing or full storage). Fix that, then retry.');
        setPhase('storage-error');
        return;
      }
      // loadPairings runs the one-time legacy-session adoption when needed;
      // every returned pairing carries a pairingId + epoch.
      return adopt.loadPairings().then(async (list) => {
        if (cancelled) return;
        // #R6-4b per pairing: drop any pairing tombstoned by another tab's
        // wipe while our IDB read was in flight. #R7-3: the removal is an
        // epoch-gated compare-and-remove — if the user re-paired in the
        // interim (fresh epoch), the newer stored pairing is left alone.
        const live: PairedSession[] = [];
        for (const p of list) {
          if (wipeTombstonesRef.current.has(`${p.pairingId}::${p.epoch}`)) {
            await removePairingIfMatches(p.pairingId, p.epoch).catch(() => { /* best-effort */ });
          } else {
            live.push(p);
          }
        }
        if (live.length === 0) { setPhase('setup'); return; }
        // Install every runtime synchronously so callbacks (sendMessage etc.)
        // can use the pairings before React commits the views update.
        for (const p of live) {
          runtimesRef.current.set(p.pairingId, {
            pairing: p, transport: null, statusNow: 'closed', unsubs: [], gen: 1, validUserId: p.userId,
          });
        }
        refreshViews();
        // R3-8: must complete before wiring so the boot drain() (triggered by
        // the first 'open' status event) can't miss rows stranded in
        // 'sending' by a crash/reload in a previous session. Via sweepLeases
        // (#R5-4) so a skipped still-leased foreign row gets re-checked when
        // its lease lapses instead of stranding forever.
        await sweepLeases();
        // R4-10: re-check after the await above — if the provider unmounted
        // while the sweep was in flight, the cleanup below already ran and
        // will never run again; wiring and connecting transports here would
        // leak them forever. #R6-4: the per-runtime existence check below
        // catches what `cancelled` cannot — a cross-tab identity-wiped for a
        // pairing landing during that await on a still-mounted provider.
        if (cancelled || bootGenRef.current !== bootGen) return;
        for (const p of live) {
          const rt = runtimesRef.current.get(p.pairingId);
          // #A3: dialPairing dials from the stored url via the registered
          // factory; no url or unknown kind ⇒ listed but offline.
          if (rt !== undefined && rt.pairing === p) dialPairingRef.current(rt);
          // else: torn down during the sweep await (#R6-4) — do not resurrect.
        }
        if (runtimesRef.current.size === 0) { setPhase('setup'); return; }
        setPhase('ready');
      });
    }).catch((err) => {
      // #F6: the storage probe or the pairings load rejected (blocked/failed
      // IDB open). Enter the retryable 'storage-error' state — never a
      // permanent 'loading' spinner, and never 'setup' (whose pairing could
      // not be saved).
      if (cancelled) return;
      console.error('[raccoon] storage unavailable at boot:', err);
      // #F6(r3): the failure may have landed AFTER runtimes were installed
      // (e.g. a throw in sweepLeases/wirePairing). Clear the in-memory
      // identities so the storage-error screen — and a later retry → setup —
      // never carries a stale, unusable pairing.
      bootGenRef.current += 1;
      for (const rt of runtimesRef.current.values()) {
        rt.gen += 1;
        rt.validUserId = null;
      }
      teardownRuntimes();
      refreshViews();
      setActiveChannel(null);
      dispatch({ type: 'reset' });
      setAuthError('Local storage is unavailable on this device. Retry once it’s available.');
      setPhase('storage-error');
    });
    return () => {
      cancelled = true;
      bootGenRef.current += 1;
      bcRef.current?.close();
      bcRef.current = null;
      stopSweepCoordination();
      teardownRuntimes();
      clearTimers();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Register the ONE browser push subscription with a single pairing's
   *  instance, over that pairing's own transport, as that pairing's own
   *  userId. Loop body of enablePush's fan-out, extracted so a pairing added
   *  while push is already enabled can be registered on its own (see the
   *  pairWithPayload tail). Returns whether the registration succeeded. */
  const enablePushFlowForRuntime = useCallback(async (rt: PairingRuntime): Promise<boolean> => {
    const { vapidPublicKey, userId } = rt.pairing;
    const transport = rt.transport;
    if (!vapidPublicKey || !transport) return false;
    const env = browserPushEnv();
    if (!env) return false;
    return enablePushFlow({ env, vapidPublicKey, userId, send: (e) => transport.send(e) });
  }, []);

  const pairWithPayload = useCallback(async (json: string) => {
    // In override mode the HOST owns identity — the provider must not start
    // writing IDB pairings under it.
    if (props.transportOverride) {
      setAuthError('Pairing is managed by the host application.');
      return false;
    }
    const payload = parsePairingPayload(json);
    setAuthError(null);
    // The payload's transport kind selects the factory. 'ws' is built in;
    // other kinds come from the host's `transports` registry prop.
    const kind = payload.transport ?? 'ws';
    const make = registry[kind];
    if (!make) {
      setAuthError('No transport is available for this platform type.');
      return false;
    }
    // #P1-B: DURABLE client adoption BEFORE the server confirms. onAdoptGrant is
    // called by the transport on the pair.grant and AWAITED before it sends
    // pair.confirm — the save (durable IDB commit) therefore happens BEFORE the
    // server promotes the session. If the save throws, the transport aborts the
    // confirm (the provisional server session TTL-reaps), so we never end up
    // with a valid server session and no durable client copy, and 'ready' is
    // unreachable without that commit. The stored pairing is stashed for the
    // ready path.
    let adopted: PairedSession | null = null;
    const transport = make({
      url: payload.instanceUrl,
      pairingToken: payload.token,
      device: 'raccoon-app',
      onAdoptGrant: async (g) => {
        // First-unused-hue assignment: the new pairing takes the first palette
        // entry no stored pairing is showing (stored color ?? hash fallback);
        // all 8 taken -> deterministic hash fallback. Persisted at creation so
        // the accent never shifts when other pairings come and go.
        const existing = await loadPairingsRaw().catch((): PairedSession[] => []);
        const usedColors = existing.map((e) => e.color ?? accentColor(e.pairingId));
        const pairingId = ulid();
        const candidate: PairedSession = {
          url: payload.instanceUrl,
          sessionToken: g.payload.sessionToken,
          userId: g.payload.userId,
          instance: g.payload.instance,
          channels: g.payload.channels,
          vapidPublicKey: g.payload.vapidPublicKey,
          // #R7-3: fresh NON-SECRET epoch so a re-pair is distinguishable from
          // a prior pairing (the wipe broadcasts use it, never the token).
          epoch: crypto.randomUUID(),
          pairingId,
          transportKind: kind,
          color: nextAccentColor(usedColors) || accentColor(pairingId),
        };
        // upsertPairing dup-guards on (url, userId): a re-scan of the same
        // instance as the same user REFRESHES the stored entry in place and
        // returns it with the PRIOR pairingId — all scoped state (history
        // keys, outbox rows, approvals) stays attached to it.
        adopted = await upsertPairing(candidate); // throws => transport does NOT confirm; pairing fails safely
      },
    });
    // #A2: interactive pairing requires the transport to support pair.grant. A
    // non-pairing transport (host-managed session) never reaches this path —
    // it's driven by sessionOverride, not pairWithPayload.
    if (!transport.onGrant) {
      setAuthError('This transport does not support interactive pairing.');
      return false;
    }
    // Resolves once the server ACKs (onGrant fires on pair.confirmed OR on a
    // recovery-resume). By then the pairing was already durably saved in
    // onAdoptGrant, so we hand back THAT persisted entry. The runtime is
    // installed SYNCHRONOUSLY inside the grant callback — before the
    // transport emits its post-grant 'open' status — so the freshly wired
    // onStatus handler catches that emission and runs the open catch-up.
    // Set the instant ANY status event lands on a wired runtime for this
    // transport — consulted by the post-race sync below to tell "the 'open'
    // fired before we wired (missed)" apart from "a status event (possibly
    // 'closed') already updated statusNow after wiring".
    let statusSeenSinceWire = false;
    const paired = new Promise<PairedSession>((resolve) => {
      transport.onGrant!(() => {
        const stored = adopted;
        if (!stored) return;
        const prior = runtimesRef.current.get(stored.pairingId);
        if (prior?.transport === transport) { resolve(stored); return; } // recovery re-grant: already installed
        if (prior) {
          // A refreshed pairing (same url+userId re-scanned): tear down its
          // old transport first, with the synchronous-kill discipline (R4-3),
          // so nothing keeps sending through the superseded connection.
          prior.gen += 1;
          prior.validUserId = null;
          for (const u of prior.unsubs) u();
          prior.unsubs = [];
          void prior.transport?.close();
          prior.transport = null;
        }
        const rt: PairingRuntime = {
          pairing: stored, transport: null, statusNow: 'closed', unsubs: [],
          gen: (prior?.gen ?? 0) + 1, validUserId: stored.userId,
        };
        runtimesRef.current.set(stored.pairingId, rt);
        wirePairing(rt, transport);
        // Registered AFTER wirePairing's own onStatus (which keeps statusNow
        // current), torn down with the rest of the runtime's subscriptions.
        rt.unsubs.push(transport.onStatus(() => { statusSeenSinceWire = true; }));
        refreshViews();
        resolve(stored);
      });
    });
    // Fail fast on a terminal auth rejection (bad/expired token) instead of
    // waiting out the recovery grace below. The .catch keeps a post-pairing
    // rejection (a later revocation, handled by the wired onAuthError) from
    // surfacing as an unhandled rejection once `paired` has already won.
    let sawAuthError = false;
    const authFailed = new Promise<never>((_, reject) => {
      transport.onAuthError((code) => { sawAuthError = true; reject(new Error(`pairing rejected (code ${code})`)); });
    });
    authFailed.catch(() => { /* handled via the race / swallowed post-pair */ });
    // #R10: connect() can REJECT on a lost pair.confirmed even though the
    // transport recovers in the background and RE-EMITS the grant. So do NOT let
    // a connect() rejection abort pairing — wait for `paired` (initial OR
    // recovered) or a terminal auth error. Only if connect() failed AND no
    // grant/auth-error arrives within the recovery window is the pairing dead.
    const connected = await transport.connect().then(() => true, () => false);
    let stored: PairedSession;
    try {
      stored = connected
        ? await Promise.race([paired, authFailed])
        : await Promise.race([
            paired,
            authFailed,
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('pairing recovery timed out')), PAIR_RECOVERY_GRACE_MS)),
          ]);
    } catch {
      setAuthError(sawAuthError
        ? 'Pairing was rejected. Ask for a fresh QR code and try again.'
        : 'Could not finish pairing — the server was unreachable or the session could not be saved. Try a fresh QR code.');
      void transport.close();
      return false;
    }
    // `stored` is ALREADY durably persisted (onAdoptGrant) and its runtime
    // installed by the grant callback. If the transport's 'open' status fired
    // BEFORE the grant installed the runtime (wire-after-grant), sync the
    // mirror and run the open catch-up now — but ONLY when no status event
    // has been observed since wiring: a 'closed' landing in the microtask gap
    // between the grant callback and this continuation already updated
    // statusNow, and forcing 'open' over it would burn a drain retry attempt
    // over a dead connection (and misreport the pairing as live).
    const rt = runtimesRef.current.get(stored.pairingId);
    if (rt && rt.transport === transport && rt.statusNow !== 'open' && !statusSeenSinceWire) {
      rt.statusNow = 'open';
      refreshViews();
      catchUpOnOpen(rt);
    }
    // A pairing added while push is already enabled gets registered
    // automatically: the user opted in ONCE for this device; every pairing
    // participates (see enablePush's fan-out comment). Fire-and-forget and
    // fenced on the runtime still being the installed one when the flag read
    // resolves — best-effort, like every push registration.
    if (rt && stored.vapidPublicKey) {
      void kvGet<boolean>('push-enabled').then((enabled) => {
        if (enabled && runtimesRef.current.get(stored.pairingId) === rt) void enablePushFlowForRuntime(rt);
      }).catch(() => { /* best-effort */ });
    }
    // Go ready WITHOUT touching the other runtimes — pairing appends.
    setPhase('ready');
    return true;
  }, [props.transportOverride, registry, wirePairing, refreshViews, catchUpOnOpen, enablePushFlowForRuntime]);

  const sendEnvelope = useCallback((pairingId: string, env: AnyEnvelope) => {
    // Enqueue to IDB first.  Once the write commits, if this pairing's
    // transport is already open we call drain(pairingId) rather than
    // attempting this specific entry directly. The pairing's drain worker
    // serialises its attempts (one at a time, oldest-first — #ER-2) so there
    // is no risk of a concurrent drain + direct-attempt double-send.  The
    // extra drain() call is cheap when the outbox is empty or the entry was
    // already picked up by a concurrent drain triggered by the 'open' status
    // event.
    //
    // We read the runtime's statusNow — updated synchronously as the FIRST
    // line of the onStatus handler — so this .then() sees the actual current
    // status without waiting for a React render commit.  This closes the
    // race where: the 'open' event fires → drain() runs before the enqueue
    // IDB tx has committed (entry not listed) → enqueue tx commits → .then
    // fires but sees a stale 'closed' → entry is orphaned until the next
    // reconnect.
    //
    // R4-3, per pairing: capture this PAIRING's generation now; if a
    // wipe/unpair of THIS pairing bumps it before the enqueue's IDB write
    // commits, the row was written under an identity that is being (or has
    // been) torn down — settle it away instead of ever letting drain() see
    // it as pending, so it can never be sent through a different session's
    // transport. Wiping pairing B can never drop pairing A's in-flight
    // enqueue: the fences are independent.
    const rt = runtimesRef.current.get(pairingId);
    if (!rt || rt.validUserId === null) return; // no identity: callers already gate, this is belt-and-braces
    const gen = rt.gen;
    void outbox.enqueue(env, pairingId).then(() => {
      const now = runtimesRef.current.get(pairingId);
      if (!now || now.gen !== gen) { void outbox.settle(env.id); return; } // R4-3, per pairing
      if (env.kind === 'msg' && env.payload.attachments?.length) {
        // LEASE, not permanent: keeps the bytes alive for the outbox's retry
        // window (renewable); the SERVER performs the permanent reference
        // when it accepts the message. A permanently-failed or wiped outbox
        // row therefore cannot leak media forever — its lease expires and the
        // sweep reclaims. Fired only once the DURABLE row committed, and
        // BEFORE/independent of first delivery. Fire-and-forget HERE (it
        // never rejects); the drain loop re-fires it from durable state
        // before every delivery attempt (see attempt()).
        void leaseUploads(env.payload.attachments.map((a) => a.url), env.id, uploadProviderRef.current);
      }
      if (now.statusNow === 'open') void drain(pairingId);
    });
  }, [drain]);

  const sendMessage = useCallback((key: ConvKey, text: string, attachments?: Attachment[]) => {
    const r = resolveConvKey(key, runtimesRef.current.keys());
    if (!r) return;
    const rt = runtimesRef.current.get(r.pairingId);
    // R4-3: validUserId, not the stored pairing snapshot — nulled
    // synchronously the instant a wipe/unpair decision is made for THIS
    // pairing, so a send attempt from that point onward is rejected outright.
    const userId = rt?.validUserId;
    if (!userId) return;
    // The wire never carries a pairingId: the envelope gets the BARE channel.
    const env = createEnvelope('msg', {
      from: userAddress(userId), to: agentAddress(r.channel), channel: r.channel,
      payload: { text, ...(attachments?.length ? { attachments } : {}) },
    });
    dispatch({
      type: 'optimistic',
      msg: {
        id: env.id, channel: key, role: 'user', sender: 'you', kind: 'text', text, ts: env.ts, delivery: 'pending',
        ...(attachments?.length ? { attachments } : {}),
      },
    });
    sendEnvelope(r.pairingId, env);
  }, [sendEnvelope]);

  const respondApproval = useCallback((key: ConvKey, refId: string, choice: string, editedText?: string) => {
    const r = resolveConvKey(key, runtimesRef.current.keys());
    if (!r) return;
    const rt = runtimesRef.current.get(r.pairingId);
    // R4-3: see sendMessage's matching comment.
    const userId = rt?.validUserId;
    if (!userId) return;
    const env = createEnvelope('approval.response', {
      from: userAddress(userId), to: agentAddress(r.channel), channel: r.channel,
      payload: { refId, choice, ...(editedText !== undefined ? { editedText } : {}) },
    });
    dispatch({ type: 'responded', convKey: key, refId, choice, responseId: env.id, ...(editedText !== undefined ? { editedText } : {}) });
    sendEnvelope(r.pairingId, env);
  }, [sendEnvelope]);

  const openChannel = useCallback((key: ConvKey | null) => {
    if (key) {
      const r = resolveConvKey(key, runtimesRef.current.keys());
      // R2-10, per pairing: validate membership against that pairing's channel
      // list. A stale `?c=` URL param (ChatScreen reads it on mount/popstate)
      // naming an unknown pairing, or a channel outside that pairing's list,
      // is a no-op — it cannot reopen a conversation left over from a PRIOR
      // pairing on the same device/browser tab.
      // NOTE for host embeddings (transportOverride/sessionOverride): this
      // makes openChannel a silent no-op for any conversation outside
      // sessionOverride.channels. Populate that list before the user can call
      // openChannel, or every open call will be silently dropped.
      if (!r || !runtimesRef.current.get(r.pairingId)!.pairing.channels.includes(r.channel)) return;
    }
    setActiveChannel(key);
    if (!key) return;
    dispatch({ type: 'read-channel', convKey: key });
    void kvSet(`lastread:${key}`, new Date().toISOString());
    // Only request history when this pairing's transport is open; if closed,
    // the onStatus handler catches up when it reconnects.
    const r = resolveConvKey(key, runtimesRef.current.keys())!;
    const rt = runtimesRef.current.get(r.pairingId)!;
    if (!stateRef.current.historyLoaded[key] && rt.statusNow === 'open') requestHistory(r.pairingId, r.channel);
  }, [requestHistory]);

  const loadOlder = useCallback((key: ConvKey) => {
    const before = stateRef.current.nextBefore[key];
    if (!before) return;
    const r = resolveConvKey(key, runtimesRef.current.keys());
    if (r) requestHistory(r.pairingId, r.channel, before);
  }, [requestHistory]);

  const retryMessage = useCallback((key: ConvKey, id: string) => {
    void outbox.retry(id).then(async (applied) => {
      // #R6-7: retry() is a failed-only CAS — if the row is gone or another
      // tab holds a live claim on it, do nothing (no phantom 'pending' UI,
      // no drain that could double-send).
      if (!applied) return;
      dispatch({ type: 'delivery', convKey: key, id, delivery: 'pending' });
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
    // Built-in VAPID flow, fanned out across pairings. One browser
    // subscription per install; each pairing is told about it over its own
    // transport and pushes independently. Browsers key the subscription to
    // ONE VAPID application key — instances that use the standard web-push
    // vendor must share a public key to co-deliver; vendor-scheme transports
    // are unaffected. The first pairing's key wins the browser registration;
    // enablePushFlow for a mismatched-key instance fails closed (returns
    // false) rather than throwing.
    const env = browserPushEnv();
    if (!env) return false;
    let any = false;
    for (const rt of runtimesRef.current.values()) {
      any = (await enablePushFlowForRuntime(rt)) || any;
    }
    if (any) await kvSet('push-enabled', true);
    return any;
  }, [props.pushRegistrarOverride, enablePushFlowForRuntime]);

  const unpair = useCallback(async (pairingId: string) => {
    // Per-pairing unpair — the other pairings keep running.
    const rt = runtimesRef.current.get(pairingId);
    if (!rt) return;
    // R4-3: bump FIRST, synchronously, before any await — see the
    // PairingRuntime.gen comment. Any sendEnvelope() call whose enqueue()
    // commits after this point (no matter how the wipe's own async work
    // interleaves) observes the new generation and drops its row instead of
    // leaving it to be picked up by a later drain() under a different
    // identity.
    rt.gen += 1;
    const myGen = rt.gen;
    const wiped = rt.pairing;
    // R5-3/#R6-8: tell every OTHER open tab this exact pairing identity is
    // gone — see the auth-error handler's matching comment.
    bcRef.current?.postMessage({ type: 'identity-wiped', pairingId, epoch: wiped.epoch });
    // Tear down THIS pairing's server-side push registration before closing
    // the transport (still need the connection + userId for the instance
    // envelope). Without this, the instance's subscription row survived, so
    // the device kept receiving the PRIOR user's push notifications (message
    // bodies included) after pairing as someone else, until the next
    // 404/410-based prune (or indefinitely, if that never happened).
    // Per-instance ONLY: the browser-level subscription is shared by every
    // pairing on this device — it (and the host registrar's device-level
    // registration, and the push-enabled flag) is torn down inside
    // wipePairing when the LAST runtime is actually removed. Best-effort:
    // unpair proceeds regardless of outcome.
    //
    // Captured into locals BEFORE nulling validUserId below — every further
    // use in this function reads these locals, never the runtime field, so
    // nulling it immediately (rather than only at the very end) closes the
    // window where a concurrent sendMessage()/respondApproval() call would
    // still see this (now-terminating) pairing identity as valid.
    const userId = wiped.userId;
    const transport = rt.transport;
    rt.validUserId = null;
    // #P1-F3: invalidate the DURABLE pairing FIRST — before the un-timeout-
    // bounded push-disable / transport-close awaits below. Previously the only
    // durable clear sat at the very end, so a hung host push disable() (or the
    // user closing the tab) during those awaits left the pairing row in IDB
    // and the "unpaired" device silently reconnected on next boot.
    // Compare-and-remove (epoch-gated) so a concurrent re-pair's newer entry
    // is not erased. #ER-1: the RESULT is captured and threaded into the
    // durable wipe — together with the wipe's own retry it authorizes the
    // destructive clears (a stale-epoch caller matches neither and the wipe
    // self-heals instead of erasing the refreshed pairing's state).
    const hoistedRemoved = await removePairingIfMatches(pairingId, wiped.epoch)
      .catch(() => false); /* best-effort; wipePairingDurable re-runs it (always reached — see the bounded awaits below) */
    // #P1-F3 (adv): bound each best-effort cleanup so a hung host disable() /
    // server unsubscribe cannot prevent the durable wipe from running its
    // clear retry. The cleanup keeps running detached; we just stop waiting.
    if (props.pushRegistrarOverride) {
      // Host-managed push is DEVICE-level (no per-instance half): disable()
      // only with the last pairing. Two concurrent unpairs of the final two
      // pairings can each see size 2 here and both skip it — an accepted
      // residual for the host-registrar path (its disable() needs no live
      // transport, so a host can re-run it; moving it after the runtime
      // removal would break the durable-removal-while-parked ordering that
      // #P1-F3 pins). The built-in browser-subscription teardown, where the
      // same race silently strands OS-level deliveries, is checked at the
      // deletion point inside wipePairing instead.
      if (runtimesRef.current.size === 1) {
        await settleWithinCall(() => props.pushRegistrarOverride!.disable?.(), UNPAIR_CLEANUP_TIMEOUT_MS);
      }
    } else if (userId && transport) {
      const env = browserPushEnv();
      if (env) {
        await settleWithinCall(() => unsubscribeInstanceOnly({ env, userId, send: (e) => transport.send(e) }), UNPAIR_CLEANUP_TIMEOUT_MS);
      }
    }
    // Shared teardown tail with the auth-error path (listeners off, bounded
    // transport close, durable wipe, runtime delete, React-state adjustment)
    // — wipePairing carries the R4-3 supersession guard and the #ER-1
    // stale-epoch self-heal.
    await wipePairing(rt, myGen, wiped.epoch, { closeTransport: true, hoistedRemoved });
  }, [wipePairing, props.pushRegistrarOverride]);

  const renamePairing = useCallback(async (pairingId: string, displayName: string) => {
    // updatePairingMeta validates before write and treats an empty value as
    // "clear the local override" — see lib/session.ts.
    const list = await updatePairingMeta(pairingId, { displayName });
    const rt = runtimesRef.current.get(pairingId);
    const updated = list.find((p) => p.pairingId === pairingId);
    if (rt && updated) {
      rt.pairing = updated;
      refreshViews();
    }
  }, [refreshViews]);

  // Push availability: a VAPID key on ANY pairing, or a host registrar — but
  // never with ZERO pairings (nothing could deliver a push worth enabling).
  // Reads the runtimes map keyed off `views`, which updates in lockstep with
  // it, so the banner re-evaluates as pairings come and go.
  const canEnablePush = views.length > 0
    && ([...runtimesRef.current.values()].some((r) => !!r.pairing.vapidPublicKey) || !!props.pushRegistrarOverride);

  const retryStorage = useCallback(async () => {
    // #F6: re-probe durable storage from the storage-error state. On success,
    // enable pairing (setup); prior stored pairings are not auto-restored — the
    // user re-pairs, which #P1-B persists durably (or fails safely). On failure,
    // stay in storage-error with an updated message.
    const writable = await probeStorageWritable();
    if (writable) { setAuthError(null); setPhase('setup'); }
    else setAuthError('Still can’t save data locally. Free up space or leave private browsing, then retry.');
  }, []);

  const api = useMemo<ChatApi>(() => ({
    phase, pairings: views, state, activeChannel, authError,
    pairWithPayload, retryStorage, openChannel, loadOlder, enablePush, canEnablePush, uploadProvider, unpair, renamePairing,
    // sendMessage, respondApproval, retryMessage are only wired once the
    // pairings are loaded and the transports are connected (phase === 'ready').
    // Before ready they are undefined at runtime (the `as` cast is intentional —
    // callers that need to guard can check phase === 'ready' or use ?.() syntax,
    // and tests can rely on waitFor(() => expect(chat.sendMessage).toBeDefined())
    // to block until the pairings are available).
    sendMessage: (phase === 'ready' ? sendMessage : undefined) as ChatApi['sendMessage'],
    respondApproval: (phase === 'ready' ? respondApproval : undefined) as ChatApi['respondApproval'],
    retryMessage: (phase === 'ready' ? retryMessage : undefined) as ChatApi['retryMessage'],
  }), [phase, views, state, activeChannel, authError, pairWithPayload, retryStorage, openChannel, sendMessage, respondApproval, retryMessage, loadOlder, enablePush, canEnablePush, uploadProvider, unpair, renamePairing]);

  return <ChatContext.Provider value={api}>{props.children}</ChatContext.Provider>;
}

export function useChat(): ChatApi {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error('useChat must be used within TransportProvider');
  return ctx;
}
