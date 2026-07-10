import {
  createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, useState,
  type ReactNode,
} from 'react';
import {
  agentAddress, createEnvelope, parsePairingPayload, userAddress,
  type AnyEnvelope, type TransportStatus,
} from '@raccoon/protocol';
import { WsClientTransport } from '@raccoon/transport-ws';
import { kvGet, kvSet, wipeLocal } from '../lib/idb.js';
import { browserPushEnv, enablePushFlow, unsubscribeCurrentPush } from '../lib/push-client.js';
import * as outbox from '../lib/outbox.js';
import { loadSession, saveSession, type Session } from '../lib/session.js';
import { chatReducer, emptyChatState, type ChatState } from '../state/messages.js';
import type { AppTransport, MakeTransport } from './types.js';

export const ACK_TIMEOUT_MS = 10_000;
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
  const [session, setSession] = useState<Session | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [state, dispatch] = useReducer(chatReducer, emptyChatState);

  const transportRef = useRef<AppTransport | null>(null);
  const sessionRef = useRef<Session | null>(null);
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
    }
    else if (env.kind === 'ack') {
      const timer = ackTimers.current.get(env.payload.refId);
      if (timer) { clearTimeout(timer); ackTimers.current.delete(env.payload.refId); }
      void outbox.settle(env.payload.refId);
      dispatch({ type: 'ack', channel: env.channel, refId: env.payload.refId, status: env.payload.status });
    } else if (env.kind === 'history.page') {
      void kvGet<string>(`lastread:${env.payload.channel}`).then((lastRead) => {
        dispatch({
          type: 'history',
          channel: env.payload.channel,
          agentId: env.payload.channel,
          messages: env.payload.messages,
          nextBefore: env.payload.nextBefore,
          lastRead,
          active: isActive(env.payload.channel),
        });
      });
    }
  }, [isActive]);

  const attempt = useCallback(async (entry: outbox.OutboxEntry) => {
    const transport = transportRef.current;
    if (!transport) return;
    await outbox.markSending(entry.id);
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
          void outbox.markFailed(entry.id, 'no ack');
          dispatch({ type: 'delivery', channel: entry.channel, id: entry.id, delivery: 'failed' });
        }, ACK_TIMEOUT_MS);
        ackTimers.current.set(entry.id, timer);
      } else {
        // Other non-msg envelopes (e.g. push.subscribe) are genuinely
        // fire-and-forget; settle them immediately without waiting for an ack.
        await outbox.settle(entry.id);
      }
    } catch (err) {
      await outbox.markSendFailed(entry.id, err instanceof Error ? err.message : 'send failed');
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
        for (const entry of pending) await attempt(entry);
      } while (drainPendingRef.current);
    } finally {
      drainLockRef.current = false;
    }
  }, [attempt]);

  // Full local-identity wipe, used on unpair and on a terminal auth-error: cancel
  // pending ack timers, clear the kv store (session, read markers, push flag) AND the
  // outbox, and reset in-memory chat state. Without the outbox + state wipe, a
  // subsequent pairing as a different user would drain the prior user's queued
  // messages through the new session and briefly render their history.
  //
  // outbox.clearAll() (not a raw store clear) is required here: it is serialized
  // against outbox.demoteSending(), which the transport's 'closed' status callback
  // fires unawaited. Without that serialization, a demoteSending() write in flight
  // when the wipe runs can land AFTER the clear and resurrect a stale row from the
  // prior user's outbox.
  const wipeAndReset = useCallback(async () => {
    for (const timer of ackTimers.current.values()) clearTimeout(timer);
    ackTimers.current.clear();
    await Promise.all([wipeLocal(), outbox.clearAll()]);
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
      if (s === 'closed') void outbox.demoteSending();
    });
    const isOverride = !!props.transportOverride;
    const u3 = transport.onAuthError(() => {
      if (isOverride) {
        // In override mode the host owns auth recovery — the transport's own
        // retry budget handles the first attempt.  Never terminal-unpair here;
        // just surface the error string and leave phase as 'ready'.
        setAuthError('Authentication error. The host is attempting to reconnect.');
      } else {
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

        // Defer the transition until the wipe settles: nulling the session and
        // dropping to setup only after wipeLocal() completes closes a TOCTOU where a
        // re-pair racing the async wipe could have its freshly-saved session cleared.
        void wipeAndReset().finally(() => {
          sessionRef.current = null;
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
  }, [drain, handleEnvelope, requestHistory, wipeAndReset]);

  useEffect(() => {
    // Host-embedding fast path: a pre-constructed, already-authenticated transport
    // was injected — skip IDB session loading and go straight to ready.
    if (props.transportOverride) {
      // Set the session synchronously on the ref FIRST so that the very first
      // wireTransport → onStatus('open') → drain/requestHistory path sees a valid
      // userId.  The corresponding setSession call queues a React state update
      // (delivered asynchronously) but sessionRef.current is authoritative for all
      // imperative code paths (sendMessage, respondApproval, requestHistory).
      if (props.sessionOverride) {
        sessionRef.current = props.sessionOverride;
        setSession(props.sessionOverride);
      }
      wireTransport(props.transportOverride);
      setPhase('ready');
      void props.transportOverride.connect().catch(() => { /* reconnect loop handles it */ });
      return () => {
        for (const unsub of unsubsRef.current) unsub();
        unsubsRef.current = [];
        for (const timer of ackTimers.current.values()) clearTimeout(timer);
        ackTimers.current.clear();
        // Do NOT close the override transport — the host owns its lifecycle.
        transportRef.current = null;
      };
    }

    let cancelled = false;
    void loadSession().then(async (loaded) => {
      if (cancelled) return;
      if (!loaded) { setPhase('setup'); return; }
      // Update the ref immediately so callbacks (sendMessage etc.) can use the
      // session before the setSession re-render fires through the scheduler.
      sessionRef.current = loaded;
      setSession(loaded);
      const transport = makeTransport({ url: loaded.url, session: loaded.sessionToken, device: 'raccoon-app' });
      wireTransport(transport);
      setPhase('ready');
      try { await transport.connect(); } catch { /* reconnect loop handles it */ }
    });
    return () => {
      cancelled = true;
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
    // Register the grant handler before connect; defer full wiring until after the grant
    // so that the connect-phase status change doesn't trigger React state updates outside act.
    const granted = new Promise<Session>((resolve) => {
      transport.onGrant((g) => resolve({
        url: payload.instanceUrl,
        sessionToken: g.payload.sessionToken,
        userId: g.payload.userId,
        instance: g.payload.instance,
        channels: g.payload.channels,
        vapidPublicKey: g.payload.vapidPublicKey,
      }));
    });
    // Finding 3: wire the transport BEFORE connect so the initial 'open' status
    // emission during connect() is captured rather than missed.
    wireTransport(transport);
    await transport.connect();
    const next = await granted;
    setSession(next);
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
    void outbox.enqueue(env).then(() => {
      if (statusNowRef.current === 'open') void drain();
    });
  }, [drain]);

  const sendMessage = useCallback((channel: string, text: string) => {
    const userId = sessionRef.current?.userId;
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
    const userId = sessionRef.current?.userId;
    if (!userId) return;
    const env = createEnvelope('approval.response', {
      from: userAddress(userId), to: agentAddress(channel), channel,
      payload: { refId, choice, ...(editedText !== undefined ? { editedText } : {}) },
    });
    dispatch({ type: 'responded', channel, refId, choice, responseId: env.id });
    sendEnvelope(env);
  }, [sendEnvelope]);

  const openChannel = useCallback((channel: string | null) => {
    // R2-10: validate membership against the CURRENT session's channel list.
    // Without this, a stale `?c=<channel>` URL param (ChatScreen reads it on
    // mount/popstate) could reopen a channel left over from a PRIOR user's
    // session after a fresh pairing on the same device/browser tab.
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
    void outbox.retry(id).then(async () => {
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
    // Tear down THIS device's push registration before closing the transport
    // (still need the connection + userId for the server-side unsubscribe).
    // Without this, only local app state was ever wiped: the server-side
    // subscription row and the browser's own PushManager registration both
    // survived, so the device kept receiving the PRIOR user's push
    // notifications (message bodies included) after pairing as someone else,
    // until the next 404/410-based prune (or indefinitely, if that never
    // happened). Best-effort: unpair proceeds regardless of outcome.
    const userId = sessionRef.current?.userId;
    const transport = transportRef.current;
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
    await wipeAndReset();
    sessionRef.current = null;
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
