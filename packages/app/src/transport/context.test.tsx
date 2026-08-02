// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope, type Envelope } from '@raccoon/protocol';
import { closeDbForTests, kvGet, kvSet } from '../lib/idb.js';
import { loadPairingsRaw, savePairings } from '../lib/session.js';
import { __setPushEnvForTests, type PushEnv } from '../lib/push-client.js';
import * as outbox from '../lib/outbox.js';
import { FakeTransport } from './fake.js';
import type { MakeTransport } from './types.js';
import {
  __setSendAttemptTimeoutForTests, cloudSignalDefaultFactory, TransportProvider, TYPING_AUTO_CLEAR_MS, useChat,
  type ChatApi, type PairSuccess, type PlatformEvent,
} from './context.js';

// Unmount every rendered provider BEFORE resetting the DB — the boot effect's
// cleanup clears its periodic lease sweep, BroadcastChannels, and timers, so a
// prior test's provider can't run async outbox work against the next test's
// shared fake-IndexedDB (a cross-test flake once 'open' began scheduling
// recoverProcessing()/drain(), #R6-2b/#R6-5b).
afterEach(async () => { cleanup(); currentPairingTransport = null; __setPushEnvForTests(null); await closeDbForTests(); });

// The pairingId IS the outbox/approvals scope and every per-conversation key
// prefix. Seeded pairings use a fixed ULID so keys are deterministic across
// the provider and the seeds.
const EPOCH = 'e1';
const P1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CK = `${P1}/coordinator`;
const P2 = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const CK2 = `${P2}/coordinator`;
const OTHER_SCOPE = '01OTHERPAIRINGSCOPEAAAAAAA'; // a pairing this provider does not hold

let api: ChatApi;
function Probe() {
  api = useChat();
  return <div data-testid="phase">{api.phase}</div>;
}

// Harness hook for re-pair tests: when set, mountPaired's makeTransport hands
// out THIS transport instead of the boot one — the boot dial (no onAdoptGrant
// in its opts) keeps the default transport, while a later pairWithPayload
// (which passes onAdoptGrant) picks up the staged re-scan transport.
let currentPairingTransport: FakeTransport | null = null;

/** Inbound agent message envelope with the BARE channel (the wire never
 *  carries a pairingId — boundary stamping names the pairing). */
function agentMsg(channel: string, text: string) {
  return createEnvelope('msg', {
    from: `agent:${channel}`, to: 'user:u1', channel, payload: { text },
  });
}

/** jsdom has no Notification/PushManager, so browserPushEnv() is null in every
 *  test by default — this installs a deterministic PushEnv via the module
 *  seam (mirrors idb's __setBlockedTimeoutMsForTests) and counts local
 *  browser-level unsubscribes. Reset in afterEach. */
function installFakePushEnv() {
  const fake: PushEnv & { unsubscribeLocalCalls: number } = {
    unsubscribeLocalCalls: 0,
    permission: () => 'granted' as NotificationPermission,
    requestPermission: async () => 'granted' as NotificationPermission,
    getSubscription: async () => ({ endpoint: 'https://push.example/ep1', keys: { p256dh: 'p', auth: 'a' } }),
    currentEndpoint: async () => 'https://push.example/ep1',
    unsubscribeLocal: async () => { fake.unsubscribeLocalCalls += 1; },
  };
  __setPushEnvForTests(fake);
  return fake;
}

async function mountPaired(transport: FakeTransport, opts?: { vapid?: string }) {
  await savePairings([{
    url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
    channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
    ...(opts?.vapid ? { vapidPublicKey: opts.vapid } : {}),
  }]);
  render(
    <TransportProvider makeTransport={(opts) => {
      const t = (opts.onAdoptGrant && currentPairingTransport) || transport;
      if (opts.onAdoptGrant) t.onAdoptGrant = opts.onAdoptGrant;
      return t;
    }}>
      <Probe />
    </TransportProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
  // Let the boot's deferred recoverProcessing→drain (#R6-2b) settle on the
  // still-empty outbox before the test seeds rows, so a late mount-drain can't
  // race the seed (claim a just-seeded row to 'sending' and fail a precondition
  // that expects it 'pending'). Quiescence, not arbitrary timing.
  await new Promise((r) => setTimeout(r, 20));
}

async function mountTwoPaired(tA: FakeTransport, tB: FakeTransport, opts?: { vapid?: string }) {
  const vapid = opts?.vapid ? { vapidPublicKey: opts.vapid } : {};
  await savePairings([
    { url: 'ws://a/', sessionToken: 'tA', userId: 'u1', instance: 'alpha', channels: ['coordinator'], epoch: 'eA', pairingId: P1, transportKind: 'ws', ...vapid },
    { url: 'ws://b/', sessionToken: 'tB', userId: 'u2', instance: 'beta', channels: ['coordinator'], epoch: 'eB', pairingId: P2, transportKind: 'ws', ...vapid },
  ]);
  render(
    <TransportProvider makeTransport={(opts) => (opts.url === 'ws://a/' ? tA : tB)}>
      <Probe />
    </TransportProvider>,
  );
  await waitFor(() => expect(api.phase).toBe('ready'));
  await new Promise((r) => setTimeout(r, 20));
}

describe('TransportProvider', () => {
  it('boots to setup with no pairings', async () => {
    render(
      <TransportProvider makeTransport={() => new FakeTransport()}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('setup'));
  });

  it('pairs from a QR payload and persists the grant', async () => {
    const transport = new FakeTransport();
    render(
      <TransportProvider makeTransport={(opts) => { transport.onAdoptGrant = opts.onAdoptGrant; return transport; }}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(api.phase).toBe('setup'));
    const pairing = api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://h:1/', transport: 'ws', token: 'tok' }));
    await act(async () => {
      // grant() runs onAdoptGrant (durable save) BEFORE firing grantHandlers.
      await transport.grant(createEnvelope('pair.grant', {
        from: 'system', to: 'user:u1', channel: 'pairing',
        payload: { sessionToken: 's1', userId: 'u1', instance: 'echo', channels: ['coordinator'] },
      }));
      // Success is REPORTED: the caller (PairPanel's onDone) relies on it.
      expect(await pairing).toMatchObject({ kind: 'new' });
    });
    await waitFor(() => expect(api.phase).toBe('ready'));
    expect(api.pairings[0]?.userId).toBe('u1');
    // #P1-B: durably persisted (the save preceded confirmation), not a racy after-the-fact write.
    const stored = await loadPairingsRaw();
    expect(stored[0]?.sessionToken).toBe('s1');
    // pairingId === scope, minted at adoption.
    expect(stored[0]?.pairingId).toBe(api.pairings[0]?.pairingId);
  });

  it('pairing survives a rejected connect() and completes on the recovery grant — pairing persisted + ready (#R10)', async () => {
    // Models a lost pair.confirmed: the initial connect() REJECTS, then the
    // transport recovers in the background and re-emits the grant. pairWithPayload
    // must NOT abort on the connect() rejection — it must persist the recovered
    // pairing and reach 'ready'. Pre-fix, the connect() throw aborted pairing:
    // nothing was saved and phase never left 'setup' (a ghost pairing).
    const transport = new FakeTransport();
    transport.failConnect = true; // first dial rejects
    render(
      <TransportProvider makeTransport={(opts) => { transport.onAdoptGrant = opts.onAdoptGrant; return transport; }}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(api.phase).toBe('setup'));
    const pairing = api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://h:1/', transport: 'ws', token: 'tok' }));
    await act(async () => {
      // connect() has rejected; pairing is now waiting for the recovery grant.
      await new Promise((r) => setTimeout(r, 10));
      // Recovery: the transport reconnects (resume) and re-emits the adopted grant.
      await transport.grant(createEnvelope('pair.grant', {
        from: 'system', to: 'user:u1', channel: 'pairing',
        payload: { sessionToken: 's-recovered', userId: 'u1', instance: 'echo', channels: ['coordinator'] },
      }));
      await pairing;
    });
    await waitFor(() => expect(api.phase).toBe('ready'));
    expect(api.pairings[0]?.userId).toBe('u1');
    // Logical pairing: the recovered pairing is DURABLY persisted (survives reload).
    const saved = await loadPairingsRaw();
    expect(saved[0]?.sessionToken).toBe('s-recovered');
    expect(saved[0]?.userId).toBe('u1');
  });

  it('auto-clears a typing indicator whose stop never arrives (TYPING_AUTO_CLEAR_MS)', async () => {
    // A lost 'typing stop' (or a QoS1-redelivered stale 'start' landing after
    // the reply) must not pin the dots forever — the deadline self-heals it.
    // Mount under real timers (the boot flow needs them), then freeze the
    // clock so the deadline armed by the 'start' can be advanced past.
    const transport = new FakeTransport();
    await mountPaired(transport);
    vi.useFakeTimers();
    try {
      act(() => {
        transport.emit(createEnvelope('typing', {
          from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
          payload: { state: 'start' },
        }));
      });
      expect(api.state.typing[CK]).toBe(true);
      act(() => {
        vi.advanceTimersByTime(TYPING_AUTO_CLEAR_MS + 1_000);
      });
      expect(api.state.typing[CK]).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('unpair wipes the pairing\'s local state (outbox + kv + chat state) so a re-pair cannot leak the prior user', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    // Close the transport before seeding so the queued row is not immediately
    // drained by the open connection (an open transport correctly sends
    // pending rows) — we want it to stay queued to prove unpair wipes it.
    act(() => { transport.setStatus('closed'); });
    // Seed prior-user local state: a queued outbox entry + a read marker.
    await outbox.enqueue(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'A private draft' },
    }), P1);
    await kvSet(`lastread:${CK}`, new Date(0).toISOString());
    expect((await outbox.listPending()).length).toBe(1);

    await act(async () => { await api.unpair(P1); });
    await waitFor(() => expect(api.phase).toBe('setup'));

    // Outbox emptied: the next pairing's onStatus('open') -> drain() cannot flush
    // the prior user's queued messages through the new session.
    expect(await outbox.listPending()).toEqual([]);
    // kv wiped: pairing gone and read markers cleared.
    expect(await loadPairingsRaw()).toEqual([]);
    expect(await kvGet(`lastread:${CK}`)).toBeUndefined();
    // In-memory chat state reset.
    expect(api.state.messages).toEqual({});
    expect(api.pairings).toEqual([]);
  });

  it('unpair calls the host push registrar\'s disable() so a re-pair does not inherit its push subscription (#R2-6)', async () => {
    const transport = new FakeTransport();
    let disabled = false;
    render(
      <TransportProvider
        transportOverride={transport}
        sessionOverride={{ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: EPOCH }}
        pushRegistrarOverride={{ enable: async () => true, disable: async () => { disabled = true; } }}
      >
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
    await act(async () => { await api.unpair(api.pairings[0]!.pairingId); });
    expect(disabled).toBe(true);
  });

  it('host-override unpair still performs the full terminal wipe — no store entry does not mean no authorization (#ER-1)', async () => {
    const transport = new FakeTransport();
    render(
      <TransportProvider
        transportOverride={transport}
        sessionOverride={{ userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: EPOCH }}
      >
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
    const pid = api.pairings[0]!.pairingId;
    const ck = `${pid}/coordinator`;
    // A live message creates the in-memory chat slice…
    act(() => {
      transport.emit(createEnvelope('msg', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'hi' },
      }));
    });
    await waitFor(() => expect(api.state.messages[ck]).toHaveLength(1));
    // …and a queued row lands DURABLY under the host scope (#P1-F2: the host
    // pairing itself never persists, but its outbox rows do — that is the
    // whole point of the stable hostIdentityKey scope). Transport closed so
    // the drain can't flush it before unpair.
    act(() => { transport.setStatus('closed'); transport.connected = false; });
    const row = await outbox.enqueue(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'discard me' },
    }), pid);

    await act(async () => { await api.unpair(pid); });

    // A host pairing has no store entry, so BOTH epoch-gated removals miss —
    // but the #ER-1 gate exists to protect a STORED pairing that may have
    // been refreshed, and a host pairing has neither a store entry nor a
    // refresh path. unpair must therefore stay AUTHORIZED for the full
    // terminal wipe: slice dropped, durable scope cleared, phase 'setup'. A
    // later remount with the same session (same epoch → same pairingId) must
    // NOT resume and transmit rows the user unpaired to discard.
    expect(api.phase).toBe('setup');
    expect(api.state.messages[ck]).toBeUndefined();
    expect(await outbox.getEntry(row.id)).toBeUndefined();
    expect(await outbox.listForChannel('coordinator', pid)).toEqual([]);
  });

  it('unpair invalidates the durable pairing BEFORE the unbounded push cleanup, so a hung disable() cannot leave a reconnectable pairing (#P1-F3)', async () => {
    await savePairings([{
      url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
      channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
    }]);
    const transport = new FakeTransport();
    let releaseDisable!: () => void;
    render(
      <TransportProvider
        makeTransport={() => transport}
        pushRegistrarOverride={{ enable: async () => true, disable: () => new Promise<void>((r) => { releaseDisable = r; }) }}
      >
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(api.phase).toBe('ready'));
    // Fire unpair but do NOT await — disable() is parked (unresolved).
    let unpairing!: Promise<void>;
    act(() => { unpairing = api.unpair(P1); });
    // The durable pairing must be removed even though unpair is still parked in
    // disable(); otherwise next boot's loadPairings() would silently reconnect
    // the "unpaired" device. Resolves only because the removal was hoisted ahead
    // of the push/transport awaits.
    await waitFor(async () => expect(await loadPairingsRaw()).toEqual([]));
    // Release so unpair completes and its bounded-cleanup timer is cleared (no
    // dangling timer to flake later tests).
    releaseDisable();
    await act(async () => { await unpairing; });
  });

  it('unpair completes even if the host push disable() throws SYNCHRONOUSLY (#R10)', async () => {
    await savePairings([{
      url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
      channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
    }]);
    const transport = new FakeTransport();
    render(
      <TransportProvider
        makeTransport={() => transport}
        pushRegistrarOverride={{ enable: async () => true, disable: () => { throw new Error('sync boom'); } }}
      >
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(api.phase).toBe('ready'));
    // A synchronous throw from disable() must be caught inside the bounded
    // cleanup, not escape unpair() — the promise resolves and we reach setup.
    await act(async () => { await api.unpair(P1); });
    expect(api.phase).toBe('setup');
    expect(await loadPairingsRaw()).toEqual([]);
  });

  it('a history.page arriving after the pairing is wiped is dropped (no-identity fence, #R10)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { transport.authFail(4403); }); // wipe → runtime torn down, phase setup
    await waitFor(() => expect(api.phase).toBe('setup'));
    // A late history.page for the just-wiped pairing must NOT repopulate state.
    act(() => {
      transport.emit(createEnvelope('history.page', {
        from: 'system', to: 'user:u1', channel: 'coordinator',
        payload: { channel: 'coordinator', messages: [{ id: 'h1', role: 'agent', text: 'ghost', ts: '2020-01-01T00:00:00.000Z' }] },
      }));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.state.messages[CK] ?? []).toHaveLength(0);
  });

  it('requeues a row stranded in "sending" by a crash/reload and sends it once the transport opens (#R3-8)', async () => {
    // Simulate a prior session that was killed mid-send: an outbox entry left
    // in 'sending' state with no chance to fire the transport's 'closed'
    // event (which is the only other thing that releases owned claims).
    await savePairings([{
      url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
      channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
    }]);
    const stranded = await outbox.enqueue(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'stranded' },
    }), P1);
    // Owned by a DIFFERENT (now-crashed) tab — this boot's fresh tabIdRef
    // cannot match it. #R4-4: the sweep only reclaims a row it doesn't
    // own once its lease has expired, so simulate real staleness (rather
    // than a still-possibly-alive claim) by backdating Date.now() for just
    // this one markSending() call, landing leaseExpiresAt safely in the past.
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - outbox.SEND_LEASE_MS - 1000);
    await outbox.markSending(stranded.id, 'crashed-prior-tab', P1);
    dateNowSpy.mockRestore();
    expect(await outbox.listPending()).toEqual([]); // excluded from listPending while 'sending'

    const transport = new FakeTransport();
    render(
      <TransportProvider makeTransport={() => transport}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));

    // Requeued to 'pending' and drained through the now-open transport — not
    // left stranded in 'sending' forever.
    await waitFor(() => expect(transport.sent.some((e) => e.kind === 'msg' && e.id === stranded.id)).toBe(true));
    expect(await outbox.listPending()).toEqual([]); // moved to 'sending' again by the successful attempt
  });

  it('a cross-tab wipe arriving during boot recovery prevents the wiped pairing from connecting (#R6-4)', async () => {
    await savePairings([{
      url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
      channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
    }]);

    // Park the boot inside its lease-sweep await, deliver identity-wiped
    // from "another tab" while parked, then release. The boot continuation
    // must not wire + connect the wiped pairing's transport.
    let releaseDemote!: () => void;
    const demoteGate = new Promise<void>((r) => { releaseDemote = r; });
    const demoteSpy = vi.spyOn(outbox, 'recoverExpiredSending').mockImplementation(async () => { await demoteGate; return null; });

    const transport = new FakeTransport();
    render(
      <TransportProvider makeTransport={() => transport}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(demoteSpy).toHaveBeenCalled());

    const otherTab = new BroadcastChannel('raccoon-identity');
    otherTab.postMessage({ type: 'identity-wiped', pairingId: P1, epoch: EPOCH });
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('setup'));
    otherTab.close();

    releaseDemote();
    await new Promise((r) => setTimeout(r, 20));

    expect(transport.connected).toBe(false);
    expect(screen.getByTestId('phase').textContent).toBe('setup');
    demoteSpy.mockRestore();
  });

  it('an IndexedDB boot failure enters storage-error, never hanging on loading (#F6)', async () => {
    // loadPairings() (and the IDB paths it drives) reject on a blocked/failed
    // IndexedDB open. The boot must enter the retryable 'storage-error' state —
    // NOT stay on the initial 'loading' spinner, and NOT drop to 'setup' (whose
    // pairing could never be saved).
    const adopt = await import('../lib/adopt.js');
    const loadSpy = vi.spyOn(adopt, 'loadPairings').mockRejectedValue(new Error('IndexedDB open blocked'));
    render(
      <TransportProvider makeTransport={() => new FakeTransport()}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('storage-error'));
    loadSpy.mockRestore();
  });

  it('a failed durable-storage write-probe enters storage-error, so pairing stays disabled (#F6)', async () => {
    // Storage opens/reads but a WRITE fails (private mode / quota). The
    // pairings load would succeed, but a pair could never be saved — so gate
    // on the write-probe.
    const idb = await import('../lib/idb.js');
    const probeSpy = vi.spyOn(idb, 'probeStorageWritable').mockResolvedValue(false);
    render(
      <TransportProvider makeTransport={() => new FakeTransport()}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(api.phase).toBe('storage-error'));
    probeSpy.mockRestore();
  });

  it('retryStorage recovers to setup once storage becomes writable (#F6)', async () => {
    const idb = await import('../lib/idb.js');
    const probeSpy = vi.spyOn(idb, 'probeStorageWritable').mockResolvedValue(false);
    render(
      <TransportProvider makeTransport={() => new FakeTransport()}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(api.phase).toBe('storage-error'));
    // Storage comes back; a retry re-probes and re-enables pairing.
    probeSpy.mockResolvedValue(true);
    await act(async () => { await api.retryStorage(); });
    await waitFor(() => expect(api.phase).toBe('setup'));
    probeSpy.mockRestore();
  });

  it('a failure AFTER the pairing runtimes are installed enters storage-error with the identities CLEARED (#F6r3)', async () => {
    // Storage opens + the probe passes + the pairings load (runtimes installed),
    // but a later boot step (sweepLeases → recoverExpiredSending) throws. The
    // storage-error transition must NOT leave the stale identities live — else
    // a retry → setup would carry them.
    await savePairings([{
      url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
      channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
    }]);
    const recoverSpy = vi.spyOn(outbox, 'recoverExpiredSending').mockRejectedValue(new Error('idb write failed mid-boot'));
    render(
      <TransportProvider makeTransport={() => new FakeTransport()}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(api.phase).toBe('storage-error'));
    expect(api.pairings).toEqual([]); // identities cleared — no stale pairing behind storage-error
    recoverSpy.mockRestore();
  });

  it('a wipe that arrives BEFORE the pairings load resolves is not ignored — the loaded pairing is not installed (#R6-4b)', async () => {
    await savePairings([{
      url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
      channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
    }]);

    // Gate the IDB pairings load so the wipe lands while this tab has NO
    // runtimes yet. The tombstone must be recorded regardless, so a stale
    // load cannot then connect a just-unpaired pairing.
    const adopt = await import('../lib/adopt.js');
    let releaseLoad!: (v: Awaited<ReturnType<typeof adopt.loadPairings>>) => void;
    const loadGate = new Promise<Awaited<ReturnType<typeof adopt.loadPairings>>>((r) => { releaseLoad = r; });
    const loadSpy = vi.spyOn(adopt, 'loadPairings').mockReturnValue(loadGate);

    const transport = new FakeTransport();
    render(
      <TransportProvider makeTransport={() => transport}>
        <Probe />
      </TransportProvider>,
    );
    await new Promise((r) => setTimeout(r, 10)); // boot effect ran; load is parked

    // Another tab wipes THIS pairing while we are still loading.
    const wiper = new BroadcastChannel('raccoon-identity');
    wiper.postMessage({ type: 'identity-wiped', pairingId: P1, epoch: EPOCH });
    await new Promise((r) => setTimeout(r, 10));
    wiper.close();

    // Now the stale read resolves with the (just-wiped) pairing.
    releaseLoad([{
      url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
      channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
    }]);
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('setup'));

    // It must NOT have been installed or connected…
    expect(transport.connected).toBe(false);
    expect(api.pairings).toEqual([]);
    // …and #R7-3: the tombstoned stored pairing was compare-and-removed.
    expect(await loadPairingsRaw()).toEqual([]);
    loadSpy.mockRestore();
  });

  it('an identity-wiped for a DIFFERENT pairing does not log this tab out (#R6-8)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport); // P1 @ ws://x/

    // A delayed/unrelated wipe event — a different pairingId — must not tear
    // down this pairing.
    const otherTab = new BroadcastChannel('raccoon-identity');
    otherTab.postMessage({ type: 'identity-wiped', pairingId: OTHER_SCOPE, epoch: EPOCH });
    await new Promise((r) => setTimeout(r, 30));
    otherTab.close();

    expect(api.phase).toBe('ready');
    expect(api.pairings[0]?.userId).toBe('u1');
  });

  it('a stale wipe for a since-refreshed pairing (new epoch) does not log out the new pairing (#R6-8b)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport); // epoch EPOCH

    // A wipe posted for a DIFFERENT epoch of the same pairingId (an older,
    // since-refreshed pairing) must not tear down the fresh one.
    const otherTab = new BroadcastChannel('raccoon-identity');
    otherTab.postMessage({ type: 'identity-wiped', pairingId: P1, epoch: 'old-epoch' });
    await new Promise((r) => setTimeout(r, 30));
    otherTab.close();

    expect(api.phase).toBe('ready');
    expect(api.pairings[0]?.userId).toBe('u1');
  });

  it('a row claimed by a tab that crashes AFTER this tab booted is still recovered (#R6-5)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport); // boot sweep already ran and found nothing

    // Another tab claims a row and "crashes": nothing on this tab's side —
    // no boot, no transport event — would ever sweep again. The claim
    // broadcast (posted by markSending itself) is what schedules one at the
    // lease's expiry.
    const row = await outbox.enqueue(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'claimed then crashed' },
    }), P1);
    const realNow = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow - outbox.SEND_LEASE_MS + 400);
    await outbox.markSending(row.id, 'crashed-late-tab', P1); // lease expires ~400ms from now
    dateNowSpy.mockRestore();

    await waitFor(
      () => expect(transport.sent.some((e) => e.id === row.id)).toBe(true),
      { timeout: 5000 },
    );
  }, 10_000);

  it('never sends a pending row written under a different pairing scope, but LEAVES it for its owner (#R5-3/#R7-3)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport); // current pairing: P1

    // A row belonging to a DIFFERENT pairing's scope — could be another tab
    // (or another identity) live right now.
    const foreign = await outbox.enqueue(createEnvelope('msg', {
      from: 'user:other', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'someone else\'s message' },
    }), OTHER_SCOPE);
    // A legitimate row for the current pairing, to prove drain still works.
    const mine = await outbox.enqueue(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'mine' },
    }), P1);

    act(() => { transport.setStatus('open'); }); // trigger drain

    await waitFor(() => expect(transport.sent.some((e) => e.id === mine.id)).toBe(true));
    // The foreign row was never transmitted through P1's session…
    expect(transport.sent.some((e) => e.from === 'user:other')).toBe(false);
    // …and #R7-3: it is LEFT in the store (not deleted) — it may belong to a
    // live tab under that scope; destroying it would lose that tab's data.
    expect((await outbox.listForChannel('coordinator')).some((e) => e.id === foreign.id)).toBe(true);
  });

  it('a wipe in one tab tears down other tabs running the same pairing (#R5-3 cross-tab)', async () => {
    interface Sink { api?: ChatApi }
    function ProbeInto({ sink }: { sink: Sink }) {
      sink.api = useChat();
      return <div>{sink.api.phase}</div>;
    }
    await savePairings([{
      url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
      channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
    }]);
    const a: Sink = {};
    const b: Sink = {};
    const tA = new FakeTransport();
    const tB = new FakeTransport();
    render(<TransportProvider makeTransport={() => tA}><ProbeInto sink={a} /></TransportProvider>);
    render(<TransportProvider makeTransport={() => tB}><ProbeInto sink={b} /></TransportProvider>);
    await waitFor(() => {
      expect(a.api?.phase).toBe('ready');
      expect(b.api?.phase).toBe('ready');
    });

    // "Tab" A unpairs. Without the identity-wiped broadcast, tab B kept its
    // in-memory pairing identity live indefinitely — still enqueueing rows
    // (and showing chat UI) as a user whose local state was already wiped.
    await act(async () => { await a.api!.unpair(P1); });

    await waitFor(() => expect(b.api!.phase).toBe('setup'));

    // Tab B can no longer act as the wiped pairing. Its api surface drops
    // sendMessage outside phase 'ready' (hence ?.()), and even a stale UI
    // closure that captured the pre-teardown function is rejected by the
    // synchronously-nulled validUserId — either way, nothing reaches the
    // outbox or the transport.
    act(() => { b.api!.sendMessage?.(CK, 'stale message from a dead identity'); });
    await new Promise((r) => setTimeout(r, 20));
    expect(await outbox.listPending()).toEqual([]);
    expect(tB.sent.filter((e) => e.kind === 'msg')).toHaveLength(0);
  });

  it('a foreign row whose lease is still valid at boot is requeued and sent once that lease lapses (#R5-4)', async () => {
    await savePairings([{
      url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
      channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
    }]);
    const stranded = await outbox.enqueue(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'crashed mid-send' },
    }), P1);
    // The owning tab crashed MOMENTS ago: its lease is still valid at boot
    // (expires ~1.5s from now), so the one-shot boot sweep must skip it.
    // Backdate Date.now() during the claim so leaseExpiresAt lands there.
    const realNow = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow - outbox.SEND_LEASE_MS + 1500);
    await outbox.markSending(stranded.id, 'crashed-tab', P1);
    dateNowSpy.mockRestore();

    const transport = new FakeTransport();
    render(
      <TransportProvider makeTransport={() => transport}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
    // Still leased right after boot — correctly not requeued yet.
    expect(await outbox.listPending()).toEqual([]);

    // Once the lease lapses, the scheduled sweep (not any transport event —
    // the connection stays stably open throughout) must requeue and send it.
    await waitFor(
      () => expect(transport.sent.some((e) => e.id === stranded.id)).toBe(true),
      { timeout: 5000 },
    );
  }, 10_000);

  it('does not wire/connect a transport if the provider unmounts during boot recovery (#R4-10)', async () => {
    await savePairings([{
      url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
      channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
    }]);

    // Gate the boot's sweep await so the test can unmount the provider while
    // the boot effect's async continuation is still in flight, mid-way
    // through the loadPairings().then(...) chain.
    let releaseDemote!: () => void;
    const demoteGate = new Promise<void>((r) => { releaseDemote = r; });
    const demoteSpy = vi.spyOn(outbox, 'recoverExpiredSending').mockImplementation(async () => { await demoteGate; return null; });

    const transport = new FakeTransport();
    const { unmount } = render(
      <TransportProvider makeTransport={() => transport}>
        <Probe />
      </TransportProvider>,
    );

    await waitFor(() => expect(demoteSpy).toHaveBeenCalled());

    unmount();
    releaseDemote();
    // Let the boot continuation resume and run to completion (if unguarded).
    await new Promise((r) => setTimeout(r, 20));

    // A provider that unmounted mid-boot must never wire or connect a
    // transport afterward — that transport would live forever with no
    // owner able to close it.
    expect(transport.connected).toBe(false);

    demoteSpy.mockRestore();
  });

  it('requests history for every pairing channel on first connect so list previews hydrate before any chat is opened (#preview-hydration)', async () => {
    const transport = new FakeTransport();
    // Two channels the user has NEVER opened this session.
    await savePairings([{
      url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
      channels: ['atlas', 'scout'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
    }]);
    render(
      <TransportProvider makeTransport={() => transport}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
    // Without opening either channel, history must have been requested for BOTH
    // (that is what fills state.messages -> the channel-list last-message
    // preview). The envelopes carry BARE channels — the wire has no pairingId.
    await waitFor(() => {
      expect(transport.sent.some((e) => e.kind === 'history.request' && e.channel === 'atlas')).toBe(true);
      expect(transport.sent.some((e) => e.kind === 'history.request' && e.channel === 'scout')).toBe(true);
    });
  });

  it('re-requests history for loaded conversations on reconnect so messages missed while offline appear (#10)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.openChannel(CK); });
    await waitFor(() => expect(
      transport.sent.some((e) => e.kind === 'history.request' && e.channel === 'coordinator'),
    ).toBe(true));
    act(() => {
      transport.emit(createEnvelope('history.page', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
        payload: { channel: 'coordinator', messages: [] },
      }));
    });
    await waitFor(() => expect(api.state.historyLoaded[CK]).toBe(true));
    const before = transport.sent.filter((e) => e.kind === 'history.request' && e.channel === 'coordinator').length;

    // Simulate a reconnect: drop, then re-open.
    act(() => { transport.setStatus('closed'); });
    act(() => { transport.setStatus('open'); });

    await waitFor(() => {
      const after = transport.sent.filter((e) => e.kind === 'history.request' && e.channel === 'coordinator').length;
      expect(after).toBeGreaterThan(before);
    });
  });

  it('a stale drain snapshot entry cleared mid-drain is never sent (#R4-3, Part A)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport); // settles the boot drain before we seed (see mountPaired)

    const env1 = createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'first' },
    });
    await outbox.enqueue(env1, P1);
    await new Promise((r) => setTimeout(r, 2)); // force env2's ts to sort strictly after env1's
    const env2 = createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'SECOND must never be sent' },
    });
    await outbox.enqueue(env2, P1);

    // Gate env1's send so the test can deterministically control exactly
    // when the wipe lands relative to drain()'s progress — no reliance on
    // incidental timing (flaky under parallel test-suite load; a fixed
    // setTimeout margin was not always enough for attempt(env2) to have run
    // by the time the assertion below fired).
    const gate: { release?: () => void } = {};
    const originalSend = transport.send.bind(transport);
    transport.send = async (env) => {
      if (env.id === env1.id) await new Promise<void>((resolve) => { gate.release = resolve; });
      return originalSend(env);
    };

    // Re-trigger drain() via the 'open' status event (both entries are
    // 'pending' in the outbox already).
    act(() => { transport.setStatus('open'); });

    // Wait until drain() has claimed env1 (moved it to 'sending') and is now
    // blocked on the gated send — i.e. it has NOT yet reached env2.
    await waitFor(async () => {
      const entries = await outbox.listForChannel('coordinator');
      expect(entries.find((e) => e.id === env1.id)?.status).toBe('sending');
    });

    // Now simulate the wipe: clear the whole outbox — including env2's still
    // 'pending' row — while drain() is blocked mid-attempt(env1).
    await outbox.clearAll();

    // Release: attempt(env1)'s send completes, THEN drain()'s loop proceeds
    // to env2.
    gate.release?.();
    await waitFor(() => expect(transport.sent.some((e) => e.id === env1.id)).toBe(true));

    // env2's row was cleared before drain() reached it: markSending() must
    // report "no row" and attempt() must bail — never calling transport.send
    // for it, regardless of which transport/session is active by then.
    await new Promise((r) => setTimeout(r, 20)); // let the drain loop finish processing env2
    expect(transport.sent.some((e) => e.id === env2.id)).toBe(false);
    expect(await outbox.listPending()).toEqual([]);
  });

  it('a send whose enqueue commits after a wipe decision is dropped, not left for a later drain under a different identity (#R4-3, Part B)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);

    // sendMessage's own outbox.enqueue() IDB write is started here but — being
    // genuinely async — cannot complete before control returns from this
    // synchronous act() callback.
    act(() => { api.sendMessage(CK, 'stale — queued right as unpair happens'); });

    // Started IMMEDIATELY after, with no intervening await/yield: unpair()'s
    // FIRST statement (the synchronous pairing-generation bump) runs before
    // the just-started enqueue's IDB callback has any chance to fire — a
    // realistic stand-in for "a user action races a server-driven
    // auth-error/unpair decision".
    await act(async () => { await api.unpair(P1); });

    await new Promise((r) => setTimeout(r, 20)); // let the stale enqueue's .then() run, if it hadn't already

    // The row must not survive the wipe it raced: settled away rather than
    // left pending for a future session's drain() to pick up and send.
    expect(await outbox.listPending()).toEqual([]);
    expect(transport.sent.filter((e) => e.kind === 'msg')).toHaveLength(0);
  });

  it('sends optimistically, settles on ack', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.sendMessage(CK, 'hello'); });
    await waitFor(() => expect(transport.sent.filter((e) => e.kind === 'msg')).toHaveLength(1));
    const sent = transport.sent.find((e) => e.kind === 'msg')!;
    expect(sent.kind).toBe('msg');
    expect(sent.channel).toBe('coordinator'); // BARE channel on the wire
    expect(api.state.messages[CK]![0]!.delivery).toBe('pending');
    act(() => {
      transport.emit(createEnvelope('ack', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
        payload: { refId: sent.id, status: 'received' },
      }));
    });
    await waitFor(() => expect(api.state.messages[CK]![0]!.delivery).toBe('sent'));
  });

  it('a terminal (MAX_ATTEMPTS-exhausted) send failure flips delivery to "failed", not stuck on "pending" (#R3-11)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    // Force every send to fail synchronously — mirrors the real
    // "transport not open" race (attempt() sees a non-null transport but its
    // send() throws because the connection dropped in between).
    transport.send = async () => { throw new Error('transport not open'); };

    act(() => { api.sendMessage(CK, 'hello'); });
    await waitFor(() => expect(api.state.messages[CK]).toBeDefined());
    expect(api.state.messages[CK]![0]!.delivery).toBe('pending');

    // Re-trigger drain() via repeated 'open' status events until the outbox
    // entry has exhausted MAX_ATTEMPTS (each failed attempt puts it back to
    // 'pending' — a fresh trigger is needed for each subsequent attempt; once
    // status flips to 'failed' the entry drops out of listPending() and stops
    // being retried, so we stop as soon as that happens).
    for (let i = 0; i < outbox.MAX_ATTEMPTS; i++) {
      const before = await outbox.listForChannel('coordinator');
      if (before[0]?.status === 'failed') break;
      const attemptsBefore = before[0]?.attempts ?? 0;
      act(() => { transport.setStatus('open'); });
      await waitFor(async () => {
        const entry = (await outbox.listForChannel('coordinator'))[0];
        expect(entry?.attempts ?? 0).toBeGreaterThan(attemptsBefore);
      });
    }

    const entry = (await outbox.listForChannel('coordinator'))[0]!;
    expect(entry.status).toBe('failed'); // outbox itself gave up
    await waitFor(() => expect(api.state.messages[CK]![0]!.delivery).toBe('failed'));
  });

  it('routes inbound msg/typing/approval and requests history on open', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.openChannel(CK); });
    await waitFor(() => expect(transport.sent.some((e) => e.kind === 'history.request')).toBe(true));
    act(() => {
      transport.emit(createEnvelope('typing', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { state: 'start' },
      }));
    });
    await waitFor(() => expect(api.state.typing[CK]).toBe(true));
    act(() => {
      transport.emit(createEnvelope('msg', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'hi' },
      }));
    });
    await waitFor(() => expect(api.state.messages[CK]!.some((m) => m.text === 'hi')).toBe(true));
    expect(api.state.typing[CK]).toBe(false);
  });

  it('drops to setup with a notice on auth error, clearing activeChannel (#R2-10)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.openChannel(CK); });
    expect(api.activeChannel).toBe(CK);
    act(() => { transport.authFail(4403); });
    await waitFor(() => expect(api.phase).toBe('setup'));
    expect(api.authError?.message).toContain('unpaired');
    // Without this, a stale ?c= URL (or activeChannel) could reopen a
    // conversation left over from the prior pairing after a fresh one.
    expect(api.activeChannel).toBeNull();
  });

  it('openChannel ignores a conversation outside the pairing\'s channel list (#R2-10)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport); // pairing channels = ['coordinator']
    act(() => { api.openChannel(`${P1}/someone-elses-channel`); });
    expect(api.activeChannel).toBeNull();
    // A bare channel (no pairing prefix) is not a ConvKey — also a no-op.
    act(() => { api.openChannel('coordinator'); });
    expect(api.activeChannel).toBeNull();
    act(() => { api.openChannel(CK); });
    expect(api.activeChannel).toBe(CK);
  });

  it('drains queued sends when the transport reopens', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { transport.setStatus('closed'); transport.connected = false; });
    act(() => { api.sendMessage(CK, 'queued'); });
    await waitFor(() => expect(api.state.messages[CK]).toHaveLength(1));
    expect(transport.sent.filter((e) => e.kind === 'msg')).toHaveLength(0);
    await act(async () => { await transport.connect(); });
    await waitFor(() => expect(transport.sent.filter((e) => e.kind === 'msg')).toHaveLength(1));
  });

  it('requests history on reconnect for the active conversation when it was opened offline', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    // Boot already requested history for the pairing's channels (preview
    // hydration); clear that so this test measures only the offline-open path.
    transport.sent.length = 0;
    act(() => { transport.setStatus('closed'); transport.connected = false; });
    act(() => { api.openChannel(CK); });
    expect(transport.sent.some((e) => e.kind === 'history.request')).toBe(false);
    await act(async () => { await transport.connect(); });
    await waitFor(() => expect(transport.sent.some((e) => e.kind === 'history.request')).toBe(true));
  });

  it('approval responses stay durable through "received" and settle only on the terminal ack (#R2-5/#R6-2b)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.respondApproval(CK, 'task-9', 'approve'); });
    await waitFor(() => expect(transport.sent.some((e) => e.kind === 'approval.response')).toBe(true));
    const responseEnv = transport.sent.find((e) => e.kind === 'approval.response')!;
    expect(responseEnv.channel).toBe('coordinator'); // BARE channel on the wire

    const outbox = await import('../lib/outbox.js');
    // Must NOT settle immediately: a connection drop before the server actually
    // receives this must not silently claim success (the old fire-and-forget bug).
    expect(await outbox.listForChannel('coordinator')).toHaveLength(1);

    // #R6-2b: 'received' is NOT terminal for an approval — the row moves to a
    // durable 'processing' state (still present), so a later lost terminal ack
    // can still be recovered. It must NOT be deleted here.
    act(() => {
      transport.emit(createEnvelope('ack', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
        payload: { refId: responseEnv.id, status: 'received' },
      }));
    });
    await waitFor(async () => expect((await outbox.listForChannel('coordinator'))[0]?.status).toBe('processing'));

    // Only the terminal 'delivered' ack settles it.
    act(() => {
      transport.emit(createEnvelope('ack', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
        payload: { refId: responseEnv.id, status: 'delivered' },
      }));
    });
    await waitFor(async () => expect(await outbox.listForChannel('coordinator')).toHaveLength(0));
  });

  it('reload reconciles a still-PENDING approval response so the card is answered, not re-answerable (#P1-E1)', async () => {
    const approvals = await import('../lib/approvals.js');
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { transport.setStatus('closed'); }); // keep the seeded response 'pending'
    const reqEnv = createEnvelope('approval.request', {
      from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'task-1', title: 'Draft', description: 'approve?', options: ['approve', 'skip'] },
    });
    await approvals.saveApproval(P1, reqEnv);
    await outbox.enqueue(createEnvelope('approval.response', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator',
      payload: { refId: 'task-1', choice: 'approve' },
    }), P1); // stays 'pending' (transport closed) — omitted by the old failed/processing-only filter

    act(() => {
      transport.emit(createEnvelope('history.page', {
        from: 'system', to: 'user:u1', channel: 'coordinator',
        payload: { channel: 'coordinator', messages: [{ id: reqEnv.id, role: 'agent', text: 'approve?', ts: reqEnv.ts }] },
      }));
    });
    // The reconciled card must show the pending response as answered, so the
    // user cannot submit a competing second response for the same refId.
    await waitFor(() => {
      const m = api.state.messages[CK]?.find((x) => x.kind === 'approval');
      expect(m?.respondedChoice).toBe('approve');
    });
  });

  it('history reconciliation bails if the pairing is wiped across its awaits — no cross-identity attach (#P1-E3)', async () => {
    const approvals = await import('../lib/approvals.js');
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { transport.setStatus('closed'); });
    const reqEnv = createEnvelope('approval.request', {
      from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'task-1', title: 'Draft', description: 'approve?', options: ['approve'] },
    });
    await approvals.saveApproval(P1, reqEnv);

    // Park the reconcile inside listApprovals so we can wipe the pairing mid-flight.
    let releaseList!: (v: unknown) => void;
    const gate = new Promise<unknown>((r) => { releaseList = r; });
    const listSpy = vi.spyOn(approvals, 'listApprovals').mockReturnValue(gate as Promise<never>);

    act(() => {
      transport.emit(createEnvelope('history.page', {
        from: 'system', to: 'user:u1', channel: 'coordinator',
        payload: { channel: 'coordinator', messages: [{ id: reqEnv.id, role: 'agent', text: 'approve?', ts: reqEnv.ts }] },
      }));
    });
    await new Promise((r) => setTimeout(r, 10)); // let the handler reach the parked listApprovals

    // The pairing unpairs WHILE the reconcile is parked (runtime gone, state
    // slice dropped).
    await act(async () => { await api.unpair?.(P1); });
    // Release with the wiped pairing's approval — the fence must drop it, not
    // attach it into the post-unpair (re-paired / reset) UI.
    await act(async () => {
      releaseList([{ key: `${P1}::task-1`, scope: P1, channel: 'coordinator', refId: 'task-1', env: reqEnv, ts: reqEnv.ts }]);
      await gate.catch(() => {});
      await new Promise((r) => setTimeout(r, 10));
    });
    listSpy.mockRestore();

    expect((api.state.messages[CK] ?? []).some((m) => m.kind === 'approval')).toBe(false);
  });

  it('advances the read marker for messages arriving on the active conversation', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.openChannel(CK); });
    const env = createEnvelope('msg', { from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'seen live' } });
    act(() => { transport.emit(env); });
    const { kvGet } = await import('../lib/idb.js');
    // The read marker is keyed by ConvKey — two pairings sharing a channel
    // name keep independent markers.
    await waitFor(async () => expect(await kvGet<string>(`lastread:${CK}`)).toBe(env.ts));
  });

  describe('transportOverride + sessionOverride', () => {
    const hostSession = {
      url: 'wss://placeholder/',
      sessionToken: 'host-managed',
      userId: 'u-host',
      instance: 'host-instance',
      channels: ['coordinator', 'assistant'],
      epoch: 'host-epoch', // #R8-5: a host SHOULD supply a persisted non-secret epoch
    };

    it('the override session becomes the single synthetic pairing', async () => {
      const transport = new FakeTransport();
      render(
        <TransportProvider transportOverride={transport} sessionOverride={hostSession}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
      expect(api.pairings).toHaveLength(1);
      const p = api.pairings[0]!;
      expect(p.userId).toBe('u-host');
      expect(p.instance).toBe('host-instance');
      expect(p.transportKind).toBe('host');
      // 'host' is always supported — its transport is host-wired, never
      // registry-dialed (PairingView.supported registry truth, Task 5).
      expect(p.supported).toBe(true);
      // pairingId === the legacy identity key bytes, so a host install's
      // existing IDB outbox/approvals scopes are unchanged.
      expect(p.pairingId).toBe(JSON.stringify({ i: 'host-instance', u: 'u-host', e: 'host-epoch' }));
    });

    it('accepts a host transport WITHOUT onGrant (non-pairing transport) and reaches ready + sends (#A2)', async () => {
      // A transport that authenticates out-of-band never issues a pair.grant,
      // so it omits onGrant. It must satisfy AppTransport (onGrant optional)
      // without the `as unknown as AppTransport` cast.
      const sent: import('@raccoon/protocol').AnyEnvelope[] = [];
      let statusHandler: ((s: import('@raccoon/protocol').TransportStatus) => void) | null = null;
      const noGrant: import('./types.js').AppTransport = {
        connect: async () => { statusHandler?.('open'); },
        close: async () => { statusHandler?.('closed'); },
        send: async (e) => { sent.push(e); },
        onEnvelope: () => () => {},
        onStatus: (h) => { statusHandler = h; return () => { statusHandler = null; }; },
        onAuthError: () => () => {},
        // NOTE: no onGrant — a non-pairing transport.
      };
      render(
        <TransportProvider transportOverride={noGrant} sessionOverride={hostSession}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(api.phase).toBe('ready'));
      act(() => { api.sendMessage(`${api.pairings[0]!.pairingId}/coordinator`, 'hi from a non-pairing transport'); });
      await waitFor(() => expect(sent.some((e) => e.kind === 'msg')).toBe(true));
    });

    it('boots a host session that omits url/sessionToken (no placeholders needed) (#A3)', async () => {
      const transport = new FakeTransport();
      const leanHost = { userId: 'u-host', instance: 'host-instance', channels: ['coordinator'], epoch: 'host-epoch' };
      render(
        <TransportProvider transportOverride={transport} sessionOverride={leanHost}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(api.phase).toBe('ready'));
      expect(api.pairings[0]?.userId).toBe('u-host');
      expect(api.pairings[0]?.url).toBeUndefined();
    });

    it('does not wire/connect the override transport if the provider unmounts during boot recovery (#R4-10)', async () => {
      let releaseDemote!: () => void;
      const demoteGate = new Promise<void>((r) => { releaseDemote = r; });
      const demoteSpy = vi.spyOn(outbox, 'recoverExpiredSending').mockImplementation(async () => { await demoteGate; return null; });

      const transport = new FakeTransport();
      const { unmount } = render(
        <TransportProvider transportOverride={transport} sessionOverride={hostSession}>
          <Probe />
        </TransportProvider>,
      );

      await waitFor(() => expect(demoteSpy).toHaveBeenCalled());

      unmount();
      releaseDemote();
      await new Promise((r) => setTimeout(r, 20));

      // A provider that unmounted mid-boot must never wire or connect the
      // host-supplied transport afterward — that would leave subscriptions
      // bound to a dead component instance and connect a transport nobody
      // asked for.
      expect(transport.connected).toBe(false);

      demoteSpy.mockRestore();
    });

    it('channel list reflects sessionOverride.channels', async () => {
      const transport = new FakeTransport();
      render(
        <TransportProvider transportOverride={transport} sessionOverride={hostSession}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
      expect(api.pairings[0]?.channels).toEqual(['coordinator', 'assistant']);
    });

    it('a host override WITHOUT an epoch never derives the pairing identity from the secret sessionToken (#R8-5)', async () => {
      // The documented host API permits a stable placeholder sessionToken and
      // may omit epoch. The scope stamped on outbox rows (the pairingId) must
      // NOT derive from that secret token — a per-mount epoch is minted instead.
      const noEpoch = { url: 'wss://x/', sessionToken: 'super-secret-token', userId: 'u1', instance: 'atlas', channels: ['coordinator'] };
      const transport = new FakeTransport();
      render(
        <TransportProvider transportOverride={transport} sessionOverride={noEpoch}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));

      // A queued message is stamped with the pairing scope (= the pairingId).
      act(() => { transport.setStatus('closed'); }); // keep it queued
      act(() => { api.sendMessage(`${api.pairings[0]!.pairingId}/coordinator`, 'hi'); });
      await waitFor(async () => expect((await outbox.listForChannel('coordinator')).length).toBe(1));
      const row = (await outbox.listForChannel('coordinator'))[0]!;
      expect(row.scope).toBeTruthy();
      expect(row.scope).not.toContain('super-secret-token'); // token never in the key
      // The scope is the structured identity key with a minted epoch, not a token.
      const parsed = JSON.parse(row.scope!);
      expect(parsed.u).toBe('u1');
      expect(parsed.i).toBe('atlas');
      expect(typeof parsed.e).toBe('string');
      expect(parsed.e).not.toBe('super-secret-token');
    });

    it('sendMessage produces an envelope with from: user:<userId> and the BARE channel', async () => {
      const transport = new FakeTransport();
      render(
        <TransportProvider transportOverride={transport} sessionOverride={hostSession}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
      act(() => { api.sendMessage(`${api.pairings[0]!.pairingId}/coordinator`, 'hello from host'); });
      await waitFor(() => expect(transport.sent.filter((e) => e.kind === 'msg')).toHaveLength(1));
      const sent = transport.sent.find((e) => e.kind === 'msg')!;
      expect(sent.kind).toBe('msg');
      expect(sent.from).toBe('user:u-host');
      expect(sent.channel).toBe('coordinator');
    });

    it('transportOverride without sessionOverride leaves pairings empty (no-op path)', async () => {
      const transport = new FakeTransport();
      render(
        <TransportProvider transportOverride={transport}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
      expect(api.pairings).toEqual([]);
    });

    it('pairWithPayload is rejected in override mode (the host owns identity)', async () => {
      const transport = new FakeTransport();
      render(
        <TransportProvider transportOverride={transport} sessionOverride={hostSession}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(api.phase).toBe('ready'));
      await act(async () => {
        await api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://h:1/', transport: 'ws', token: 'tok' }));
      });
      expect(api.authError?.message).toContain('managed by the host');
      expect(await loadPairingsRaw()).toEqual([]); // never wrote IDB pairings
    });

    it('onAuthError in override mode sets authError and keeps phase ready (does NOT unpair)', async () => {
      const transport = new FakeTransport();
      render(
        <TransportProvider transportOverride={transport} sessionOverride={hostSession}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));

      act(() => { transport.authFail(401); });

      await waitFor(() => expect(api.authError).not.toBeNull());
      // Phase must remain 'ready' — the host manages recovery
      expect(api.phase).toBe('ready');
      // The synthetic pairing must be preserved
      expect(api.pairings[0]?.userId).toBe('u-host');
    });
  });

  describe('default mode auth error (terminal unpair)', () => {
    it('auth error in default mode unpairs and moves to setup phase', async () => {
      const transport = new FakeTransport();
      await mountPaired(transport);
      act(() => { transport.authFail(4403); });
      await waitFor(() => expect(api.phase).toBe('setup'));
      expect(api.authError?.message).toContain('unpaired');
    });
  });

  describe('uploadProvider seam', () => {
    it('default uploadProvider presents the LIVE pairing token', async () => {
      const transport = new FakeTransport();
      await mountPaired(transport); // saves sessionToken 't'
      await expect(api.uploadProvider.getBearerToken()).resolves.toBe('t');
    });

    it('default uploadProvider rejects with a clear error when no pairing token exists', async () => {
      render(
        <TransportProvider makeTransport={() => new FakeTransport()}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('setup'));
      await expect(api.uploadProvider.getBearerToken()).rejects.toThrow(/session token/i);
    });

    it('an injected uploadProvider prop wins over the default', async () => {
      // A pairing token exists, so the DEFAULT would resolve 't' — proving the
      // injected provider takes precedence, not merely filling an absence.
      await savePairings([{
        url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
        channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
      }]);
      const injected = { getBearerToken: async () => 'host-tok' };
      render(
        <TransportProvider makeTransport={() => new FakeTransport()} uploadProvider={injected}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
      expect(api.uploadProvider).toBe(injected);
      await expect(api.uploadProvider.getBearerToken()).resolves.toBe('host-tok');
    });
  });

  describe('two pairings (spec §6)', () => {
    it('routes outbound sends to the owning pairing\'s transport, with the BARE channel on the wire', async () => {
      const tA = new FakeTransport();
      const tB = new FakeTransport();
      await mountTwoPaired(tA, tB);

      act(() => { api.sendMessage(CK, 'to A'); });
      await waitFor(() => expect(tA.sent.filter((e) => e.kind === 'msg')).toHaveLength(1));
      expect(tB.sent.filter((e) => e.kind === 'msg')).toHaveLength(0);

      act(() => { api.sendMessage(CK2, 'to B'); });
      await waitFor(() => expect(tB.sent.filter((e) => e.kind === 'msg')).toHaveLength(1));
      expect(tA.sent.filter((e) => e.kind === 'msg')).toHaveLength(1); // unchanged

      // The wire never carries a pairingId — envelope channels are BARE.
      const sentA = tA.sent.find((e) => e.kind === 'msg')!;
      const sentB = tB.sent.find((e) => e.kind === 'msg')!;
      expect(sentA.channel).toBe('coordinator');
      expect(sentB.channel).toBe('coordinator');
      expect(sentA.from).toBe('user:u1');
      expect(sentB.from).toBe('user:u2');
    });

    it('keeps two same-named channels fully separate: messages, unread, read markers (canonical collision)', async () => {
      const tA = new FakeTransport();
      const tB = new FakeTransport();
      await mountTwoPaired(tA, tB);

      act(() => {
        tA.emit(createEnvelope('msg', { from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'from A' } }));
        tB.emit(createEnvelope('msg', { from: 'agent:coordinator', to: 'user:u2', channel: 'coordinator', payload: { text: 'from B' } }));
      });
      await waitFor(() => {
        expect(api.state.messages[CK]?.map((m) => m.text)).toEqual(['from A']);
        expect(api.state.messages[CK2]?.map((m) => m.text)).toEqual(['from B']);
      });
      // Unread counts are independent.
      expect(api.state.unread[CK]).toBe(1);
      expect(api.state.unread[CK2]).toBe(1);

      // Opening A's conversation zeroes only A's unread and only A's marker.
      act(() => { api.openChannel(CK); });
      await waitFor(() => expect(api.state.unread[CK]).toBe(0));
      expect(api.state.unread[CK2]).toBe(1);
      await waitFor(async () => expect(await kvGet<string>(`lastread:${CK}`)).toBeTruthy());
      expect(await kvGet<string>(`lastread:${CK2}`)).toBeUndefined();
    });

    it('tracks status per pairing and refetches history for the reconnected pairing only', async () => {
      const tA = new FakeTransport();
      const tB = new FakeTransport();
      await mountTwoPaired(tA, tB);

      act(() => { tA.setStatus('closed'); });
      await waitFor(() => {
        expect(api.pairings.find((p) => p.pairingId === P1)?.status).toBe('closed');
        expect(api.pairings.find((p) => p.pairingId === P2)?.status).toBe('open');
      });

      // B keeps dispatching while A is down.
      act(() => {
        tB.emit(createEnvelope('msg', { from: 'agent:coordinator', to: 'user:u2', channel: 'coordinator', payload: { text: 'B still live' } }));
      });
      await waitFor(() => expect(api.state.messages[CK2]?.some((m) => m.text === 'B still live')).toBe(true));

      const bHistoryBefore = tB.sent.filter((e) => e.kind === 'history.request').length;
      const aHistoryBefore = tA.sent.filter((e) => e.kind === 'history.request').length;

      // A reconnects: per-pairing refetch — A's channels only.
      act(() => { tA.setStatus('open'); });
      await waitFor(() => {
        expect(tA.sent.filter((e) => e.kind === 'history.request').length).toBeGreaterThan(aHistoryBefore);
      });
      // No new history requests went to B beyond its own boot batch.
      expect(tB.sent.filter((e) => e.kind === 'history.request').length).toBe(bHistoryBefore);
    });

    it('drains per pairing: a closed pairing\'s sends stay queued while the other delivers, then drain on ITS reconnect', async () => {
      const tA = new FakeTransport();
      const tB = new FakeTransport();
      await mountTwoPaired(tA, tB);

      act(() => { tA.setStatus('closed'); tA.connected = false; });
      act(() => { api.sendMessage(CK, 'queued'); });
      act(() => { api.sendMessage(CK2, 'live'); });

      await waitFor(() => expect(tB.sent.some((e) => e.kind === 'msg' && e.payload.text === 'live')).toBe(true));
      expect(tA.sent.filter((e) => e.kind === 'msg')).toHaveLength(0); // A's row stays queued

      // Reopening A drains the queued row through tA only.
      await act(async () => { await tA.connect(); });
      await waitFor(() => expect(tA.sent.some((e) => e.kind === 'msg' && e.payload.text === 'queued')).toBe(true));
      expect(tB.sent.filter((e) => e.kind === 'msg')).toHaveLength(1); // B saw nothing new
    });

    it('stamps inbound envelopes with the source pairing at the boundary; outbound stays bare (boundary stamping)', async () => {
      const tA = new FakeTransport();
      const tB = new FakeTransport();
      await mountTwoPaired(tA, tB);

      act(() => {
        tA.emit(createEnvelope('msg', { from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'stamped' } }));
      });
      await waitFor(() => expect(api.state.messages[CK]).toHaveLength(1));
      const stored = api.state.messages[CK]![0]!;
      // The stored ChatMessage keys under the ConvKey (pairingId/channel)…
      expect(stored.channel).toBe(CK);
      // …while the sender label stays the bare agent id.
      expect(stored.sender).toBe('coordinator');
      // Every envelope tA ever carried (history requests from boot included)
      // uses the BARE channel — no ConvKey leaks onto the wire.
      for (const e of tA.sent) {
        expect(e.channel.includes(P1)).toBe(false);
      }
    });
  });

  describe('per-pairing drain isolation (#ER-2)', () => {
    it('a hung send on pairing A does not block pairing B\'s outbound queue (no cross-pairing head-of-line blocking)', async () => {
      const tA = new FakeTransport(); const tB = new FakeTransport();
      await mountTwoPaired(tA, tB);
      // Short timeout so A's parked worker un-parks harmlessly within the
      // test's own lifetime. What this test locks: the wait on A's hung send
      // is BOUNDED and B's queue is unblocked while A's row stays claimed and
      // un-failed — not the precise timing of the assertions relative to the
      // timeout firing.
      __setSendAttemptTimeoutForTests(500);
      try {
        tA.send = () => new Promise(() => {}); // A's transport never settles a send
        act(() => { api.sendMessage(CK, 'stuck'); });
        // A's worker has claimed the row and is parked inside the hung send.
        await waitFor(async () => {
          expect((await outbox.listForChannel('coordinator', P1))[0]?.status).toBe('sending');
        });
        act(() => { api.sendMessage(CK2, 'flows'); });
        // B must deliver promptly even though A's worker is parked.
        await waitFor(() => expect(tB.sent.some((e) => e.kind === 'msg' && e.payload.text === 'flows')).toBe(true));
        // A's row is still held by its own worker — claimed, not failed, and
        // never transmitted.
        const aRows = await outbox.listForChannel('coordinator', P1);
        expect(aRows).toHaveLength(1);
        expect(aRows[0]!.status).toBe('sending');
        expect(tA.sent.filter((e) => e.kind === 'msg')).toHaveLength(0);
      } finally {
        __setSendAttemptTimeoutForTests(null);
      }
    });

    it('a timed-out send frees the pairing\'s worker to serve the next row WITHOUT failing the timed-out one (SEND_ATTEMPT_TIMEOUT_MS)', async () => {
      const transport = new FakeTransport();
      await mountPaired(transport);
      __setSendAttemptTimeoutForTests(50);
      try {
        const originalSend = transport.send.bind(transport);
        let hangs = 1;
        transport.send = (env) => {
          if (hangs > 0) { hangs -= 1; return new Promise(() => {}); } // first send hangs forever
          return originalSend(env);
        };
        act(() => { api.sendMessage(CK, 'first: hangs'); });
        await waitFor(async () => {
          expect((await outbox.listForChannel('coordinator', P1))[0]?.status).toBe('sending');
        });
        // The worker times out on the hung send and moves on — the SAME
        // pairing's next row flows instead of queuing behind it forever.
        act(() => { api.sendMessage(CK, 'second: flows'); });
        await waitFor(() => expect(transport.sent.some((e) => e.kind === 'msg' && e.payload.text === 'second: flows')).toBe(true));
        // The timed-out row was NOT marked failed: the send may still land, so
        // it stays 'sending' under its lease — a late settle/failure write is
        // claim-token-gated, and the lease-expiry sweep recovers it if the
        // claim is genuinely dead (the crash-recovery path, reused
        // deliberately).
        const rows = await outbox.listForChannel('coordinator', P1);
        const first = rows.find((r) => r.env.kind === 'msg' && r.env.payload.text === 'first: hangs');
        expect(first?.status).toBe('sending');
      } finally {
        __setSendAttemptTimeoutForTests(null);
      }
    });

    it('two sends on the same pairing arrive in order through its drain worker (per-pairing FIFO preserved)', async () => {
      const transport = new FakeTransport();
      await mountPaired(transport);
      act(() => { transport.setStatus('closed'); transport.connected = false; }); // queue both
      act(() => { api.sendMessage(CK, 'one'); });
      await waitFor(async () => expect((await outbox.listForChannel('coordinator', P1)).length).toBe(1));
      await new Promise((r) => setTimeout(r, 2)); // force the second ts to sort strictly after the first
      act(() => { api.sendMessage(CK, 'two'); });
      await waitFor(async () => expect((await outbox.listForChannel('coordinator', P1)).length).toBe(2));
      await act(async () => { await transport.connect(); });
      await waitFor(() => expect(transport.sent.filter((e) => e.kind === 'msg')).toHaveLength(2));
      expect(transport.sent.filter((e) => e.kind === 'msg').map((e) => e.payload.text)).toEqual(['one', 'two']);
    });
  });

  describe('identity lifecycle — per-pairing unpair, auth-error, cross-tab wipe (Task 6)', () => {
    it('unpair(P1) wipes only pairing A state; B keeps messages, outbox, lastread', async () => {
      const tA = new FakeTransport(); const tB = new FakeTransport();
      await mountTwoPaired(tA, tB);
      act(() => {
        tA.emit(agentMsg('coordinator', 'from A'));
        tB.emit(agentMsg('coordinator', 'from B'));
      });
      await waitFor(() => expect(api.state.messages[CK2]).toHaveLength(1));
      // queue a row on B while its transport is closed, so it survives in the outbox
      act(() => { tB.setStatus('closed'); });
      act(() => { api.sendMessage(CK2, 'queued on B'); });
      act(() => { api.openChannel(CK2); }); // set a lastread marker for B
      // openChannel's lastread write is fire-and-forget — await its commit
      // before unpairing, or the later assertion races the IDB write (flake).
      await waitFor(async () => expect(await kvGet(`lastread:${CK2}`)).toBeTruthy());
      await waitFor(async () => expect((await outbox.listForChannel('coordinator', P2)).length).toBe(1));
      await act(async () => { await api.unpair(P1); });
      await waitFor(() => expect(api.pairings).toHaveLength(1));
      expect(api.phase).toBe('ready');                       // NOT setup — B remains
      expect(api.state.messages[CK]).toBeUndefined();        // A's chat state dropped
      expect(api.state.messages[CK2]).toBeDefined();         // B untouched
      expect((await outbox.listForChannel('coordinator', P2)).length).toBe(1); // B row kept
      expect((await outbox.listForChannel('coordinator', P1)).length).toBe(0); // A rows gone
      expect(await kvGet(`lastread:${P2}/coordinator`)).toBeTruthy();
      expect(await kvGet(`lastread:${P1}/coordinator`)).toBeUndefined();
      expect(await loadPairingsRaw()).toHaveLength(1);
    });

    it('unpairing the last pairing lands on setup', async () => {
      const t = new FakeTransport();
      await mountPaired(t);
      await act(async () => { await api.unpair(P1); });
      await waitFor(() => expect(api.phase).toBe('setup'));
      expect(api.pairings).toHaveLength(0);
      expect(await loadPairingsRaw()).toEqual([]);
    });

    it('a terminal auth error on pairing A unpairs only A and surfaces its name', async () => {
      const tA = new FakeTransport(); const tB = new FakeTransport();
      await mountTwoPaired(tA, tB);
      act(() => { tA.authFail(4401); });
      await waitFor(() => expect(api.pairings).toHaveLength(1));
      expect(api.pairings[0]!.pairingId).toBe(P2);
      expect(api.phase).toBe('ready');
      expect(api.authError?.message).toContain('alpha');   // names the affected instance
      // B still live:
      act(() => { tB.emit(agentMsg('coordinator', 'still works')); });
      await waitFor(() => expect(api.state.messages[CK2]!.some((m) => m.text === 'still works')).toBe(true));
    });

    it('cross-tab identity-wiped for (P1, eA) tears down only that pairing and ignores a stale epoch', async () => {
      const tA = new FakeTransport(); const tB = new FakeTransport();
      await mountTwoPaired(tA, tB);
      const bc = new BroadcastChannel('raccoon-identity');
      bc.postMessage({ type: 'identity-wiped', pairingId: P1, epoch: 'WRONG-EPOCH' });
      await new Promise((r) => setTimeout(r, 20));
      expect(api.pairings).toHaveLength(2);       // #R6-8b: stale event ignored
      bc.postMessage({ type: 'identity-wiped', pairingId: P1, epoch: 'eA' });
      await waitFor(() => expect(api.pairings).toHaveLength(1));
      expect(api.pairings[0]!.pairingId).toBe(P2);
      bc.close();
    });

    it('re-scanning an already-paired instance refreshes in place: same pairingId, state kept', async () => {
      const t = new FakeTransport();
      await mountPaired(t);                              // stored pairing: P1, url 'ws://x/', u1
      act(() => { t.emit(agentMsg('coordinator', 'before refresh')); });
      await waitFor(() => expect(api.state.messages[CK]).toHaveLength(1));
      // Drive the pairing flow for the SAME url+userId with a fresh token —
      // mountPaired's makeTransport hands pairWithPayload the staged transport.
      const t2 = new FakeTransport();
      currentPairingTransport = t2;
      let pair!: Promise<PairSuccess | false>;
      act(() => { pair = api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://x/', transport: 'ws', token: 'fresh' })); });
      await act(async () => {
        await t2.grant(createEnvelope('pair.grant', {
          from: 'system', to: 'user:u1', channel: 'pairing',
          payload: { sessionToken: 't2', userId: 'u1', instance: 'i', channels: ['coordinator'] },
        }));
        // PairSuccess contract: a re-scan of an existing (url, userId) reports
        // 'refreshed' with the PRESERVED pairingId.
        expect(await pair).toEqual({ kind: 'refreshed', pairingId: P1 });
      });
      const list = await loadPairingsRaw();
      expect(list).toHaveLength(1);
      expect(list[0]!.pairingId).toBe(P1);               // preserved
      expect(list[0]!.sessionToken).toBe('t2');          // refreshed
      expect(list[0]!.epoch).not.toBe(EPOCH);            // new epoch
      expect(api.pairings).toHaveLength(1);
      expect(api.state.messages[CK]).toHaveLength(1);    // chat state under P1 survives
    });

    it('a stale unpair (another tab refreshed the pairing) erases nothing and self-heals onto the refreshed credentials (#ER-1)', async () => {
      const approvals = await import('../lib/approvals.js');
      const transport = new FakeTransport();
      await mountPaired(transport); // P1 @ epoch 'e1'
      // Keep the seeded outbox row queued (an open transport would drain it).
      act(() => { transport.setStatus('closed'); transport.connected = false; });
      const row = await outbox.enqueue(createEnvelope('msg', {
        from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'queued before the stale unpair' },
      }), P1);
      await approvals.saveApproval(P1, createEnvelope('approval.request', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
        payload: { refId: 'task-1', title: 'Draft', description: 'approve?', options: ['approve'] },
      }));
      await kvSet(`lastread:${CK}`, '2026-01-01T00:00:00.000Z');
      // Another tab re-scans the same instance: the refresh keeps the
      // pairingId but lands a FRESH token + epoch in the durable store. THIS
      // tab's runtime never hears about it (there is no cross-tab refresh
      // broadcast) and still holds epoch 'e1'.
      await savePairings([{
        url: 'ws://x/', sessionToken: 'tok2', userId: 'u1', instance: 'i',
        channels: ['coordinator'], epoch: 'e2', pairingId: P1, transportKind: 'ws',
      }]);

      // Stale unpair: the epoch-gated removal cannot match, so NOTHING
      // durable may be wiped — the old code still ran the unconditional
      // clears and erased the refreshed pairing's state.
      await act(async () => { await api.unpair(P1); });

      // The refreshed stored pairing survives untouched…
      const stored = await loadPairingsRaw();
      expect(stored).toHaveLength(1);
      expect(stored[0]!.epoch).toBe('e2');
      expect(stored[0]!.sessionToken).toBe('tok2');
      // …and so does every durable slice the wipe used to clear regardless.
      expect(await outbox.getEntry(row.id)).toBeDefined();
      expect(await approvals.listApprovals(P1, 'coordinator')).toHaveLength(1);
      expect(await kvGet(`lastread:${CK}`)).toBe('2026-01-01T00:00:00.000Z');
      // The tab self-heals: the pairing is re-installed from the refreshed
      // store (fresh runtime, wired + connected via the boot path) and the
      // provider never leaves 'ready'.
      await waitFor(() => expect(api.pairings.some((p) => p.pairingId === P1)).toBe(true));
      expect(api.phase).toBe('ready');
    });

    it('duplicate-guard miss: same url as a DIFFERENT user appends a second pairing', async () => {
      const t = new FakeTransport();
      await mountPaired(t);
      const t2 = new FakeTransport();
      currentPairingTransport = t2;
      let pair!: Promise<PairSuccess | false>;
      act(() => { pair = api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://x/', transport: 'ws', token: 'other' })); });
      await act(async () => {
        await t2.grant(createEnvelope('pair.grant', {
          from: 'system', to: 'user:u9', channel: 'pairing',
          payload: { sessionToken: 't9', userId: 'u9', instance: 'i', channels: ['coordinator'] },
        }));
        // PairSuccess contract: a dup-guard miss appends and reports 'new'.
        expect(await pair).toMatchObject({ kind: 'new' });
      });
      expect(api.pairings).toHaveLength(2);
      expect((await loadPairingsRaw()).map((p) => p.userId).sort()).toEqual(['u1', 'u9']);
    });
  });

  describe('universal pairing (Task 3) — WS handshake for every kind, runtime dialed from transportConfig', () => {
    type FactoryOpts = Parameters<MakeTransport>[0];

    /** Provider whose ws slot hands the PAIRING dial `pairingFake` (attaching
     *  onAdoptGrant, mountPaired-style) and registers `hostedkind` from
     *  `hosted` when given. */
    function renderUniversal(pairingFake: FakeTransport, hosted?: MakeTransport) {
      render(
        <TransportProvider
          makeTransport={(opts) => { if (opts.onAdoptGrant) pairingFake.onAdoptGrant = opts.onAdoptGrant; return pairingFake; }}
          {...(hosted ? { transports: { hostedkind: hosted } } : {})}
        >
          <Probe />
        </TransportProvider>,
      );
    }

    const hostedGrant = (cfg: unknown, sessionToken = 's1') => createEnvelope('pair.grant', {
      from: 'system', to: 'user:u1', channel: 'pairing',
      payload: {
        sessionToken, userId: 'u1', instance: 'hosted', channels: ['coordinator'],
        ...(cfg !== undefined ? { transportConfig: cfg } : {}),
      },
    });

    it('pairs a hosted kind over the ws pairing socket, closes it, and dials the runtime factory with the grant transportConfig + identity', async () => {
      const pairingFake = new FakeTransport();
      const hostedFake = new FakeTransport();
      const hostedCalls: FactoryOpts[] = [];
      renderUniversal(pairingFake, (opts) => { hostedCalls.push(opts); return hostedFake; });
      await waitFor(() => expect(api.phase).toBe('setup'));
      let pair!: Promise<PairSuccess | false>;
      act(() => { pair = api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://pairhost/', transport: 'hostedkind', token: 'tok' })); });
      await act(async () => {
        await pairingFake.grant(hostedGrant({ dial: 'cfg1' }));
        expect(await pair).toMatchObject({ kind: 'new' });
      });
      await waitFor(() => expect(api.phase).toBe('ready'));
      // The handshake socket is closed once the grant is confirmed…
      expect(pairingFake.connected).toBe(false);
      // …and the RUNTIME comes from the registry factory, dialed with the
      // grant's opaque blob + the session identity fields.
      expect(hostedCalls).toHaveLength(1);
      expect(hostedCalls[0]).toMatchObject({
        transportConfig: { dial: 'cfg1' }, userId: 'u1', instance: 'hosted', session: 's1', url: 'ws://pairhost/',
      });
      await waitFor(() => expect(hostedFake.connected).toBe(true));
      expect(api.pairings[0]!.transportKind).toBe('hostedkind');
      // The stored pairing carries the blob durably (boot re-dials from it).
      expect((await loadPairingsRaw())[0]!.transportConfig).toEqual({ dial: 'cfg1' });
    });

    it('ws payload keeps single-socket behavior: the factory is called exactly once and the pairing transport IS the runtime', async () => {
      let wsCalls = 0;
      const t = new FakeTransport();
      render(
        <TransportProvider makeTransport={(opts) => { wsCalls += 1; t.onAdoptGrant = opts.onAdoptGrant; return t; }}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(api.phase).toBe('setup'));
      let pair!: Promise<PairSuccess | false>;
      act(() => { pair = api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://h:1/', transport: 'ws', token: 'tok' })); });
      await act(async () => {
        await t.grant(createEnvelope('pair.grant', {
          from: 'system', to: 'user:u1', channel: 'pairing',
          payload: { sessionToken: 's1', userId: 'u1', instance: 'echo', channels: ['coordinator'] },
        }));
        expect(await pair).toMatchObject({ kind: 'new' });
      });
      await waitFor(() => expect(api.phase).toBe('ready'));
      expect(wsCalls).toBe(1);          // the pairing dial — never a second (runtime) dial
      expect(t.connected).toBe(true);   // the pairing socket IS the runtime — never closed
      expect(api.pairings[0]!.status).toBe('open');
    });

    it('a hosted payload with no runtime factory still pairs: listed offline (status closed), NO authError', async () => {
      const pairingFake = new FakeTransport();
      renderUniversal(pairingFake); // NO hostedkind runtime factory registered
      await waitFor(() => expect(api.phase).toBe('setup'));
      let pair!: Promise<PairSuccess | false>;
      act(() => { pair = api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://pairhost/', transport: 'hostedkind', token: 'tok' })); });
      await act(async () => {
        await pairingFake.grant(hostedGrant({ dial: 'cfg1' }));
        // A missing RUNTIME factory is not a pairing error — the WS handshake
        // succeeded and the session was durably adopted.
        expect(await pair).toMatchObject({ kind: 'new' });
      });
      await waitFor(() => expect(api.phase).toBe('ready'));
      expect(api.pairings).toHaveLength(1);
      expect(api.pairings[0]!.status).toBe('closed'); // listed but offline (#A3)
      expect(api.authError).toBeNull();               // listed-offline is NOT an error
      expect(pairingFake.connected).toBe(false);      // handshake socket closed regardless
      expect((await loadPairingsRaw())[0]!.transportConfig).toEqual({ dial: 'cfg1' });
    });

    it('a registered runtime factory that THROWS on construction still pairs: listed offline, blob persisted, no authError', async () => {
      // Adversarial input: the factory VALIDATES the server-supplied
      // transportConfig and throws on a malformed blob. By then the pairing
      // was already durably adopted (#P1-B) and confirmed — the throw must
      // degrade to the missing-factory #A3 shape (listed offline), never
      // reject out of pairWithPayload.
      const pairingFake = new FakeTransport();
      renderUniversal(pairingFake, () => { throw new Error('bad transportConfig'); });
      await waitFor(() => expect(api.phase).toBe('setup'));
      let pair!: Promise<PairSuccess | false>;
      act(() => { pair = api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://pairhost/', transport: 'hostedkind', token: 'tok' })); });
      await act(async () => {
        await pairingFake.grant(hostedGrant({ dial: 'malformed' }));
        expect(await pair).toMatchObject({ kind: 'new' });
      });
      await waitFor(() => expect(api.phase).toBe('ready'));
      expect(api.pairings).toHaveLength(1);
      expect(api.pairings[0]!.status).toBe('closed'); // listed but offline (#A3 shape)
      expect(api.authError).toBeNull();               // a bad blob is NOT a pairing error
      expect(pairingFake.connected).toBe(false);      // handshake socket still closed
      expect((await loadPairingsRaw())[0]!.transportConfig).toEqual({ dial: 'malformed' });
    });

    it('a throwing runtime factory at boot does not prevent OTHER pairings from dialing (and never lands in storage-error)', async () => {
      await savePairings([
        {
          url: 'ws://bad/', sessionToken: 'tX', userId: 'u1', instance: 'bad',
          channels: ['coordinator'], epoch: 'eX', pairingId: P1, transportKind: 'hostedkind',
          transportConfig: { dial: 'malformed' },
        },
        {
          url: 'ws://x/', sessionToken: 't', userId: 'u2', instance: 'good',
          channels: ['coordinator'], epoch: 'eY', pairingId: P2, transportKind: 'ws',
        },
      ]);
      const wsFake = new FakeTransport();
      render(
        <TransportProvider
          makeTransport={() => wsFake}
          transports={{ hostedkind: () => { throw new Error('bad transportConfig'); } }}
        >
          <Probe />
        </TransportProvider>,
      );
      // Pre-fix, the throw aborted the boot dial loop and fell into the #F6
      // catch — a misdiagnosed 'storage-error'. It must instead reach ready…
      await waitFor(() => expect(api.phase).toBe('ready'));
      // …with the SECOND pairing (after the thrower in list order) dialed
      // and connected.
      await waitFor(() => expect(wsFake.connected).toBe(true));
      expect(api.pairings).toHaveLength(2);
      expect(api.pairings.find((p) => p.pairingId === P1)!.status).toBe('closed');
      expect(api.pairings.find((p) => p.pairingId === P2)!.status).toBe('open');
      expect(api.authError).toBeNull();
    });

    it('re-scanning a hosted pairing replaces the stored transportConfig and re-dials the runtime with the fresh blob', async () => {
      await savePairings([{
        url: 'ws://pairhost/', sessionToken: 't0', userId: 'u1', instance: 'hosted',
        channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'hostedkind',
        transportConfig: { dial: 'cfg1' },
      }]);
      const pairingFake = new FakeTransport();
      const hostedFakes: FakeTransport[] = [];
      const hostedCalls: FactoryOpts[] = [];
      renderUniversal(pairingFake, (opts) => {
        hostedCalls.push(opts);
        const f = new FakeTransport();
        hostedFakes.push(f);
        return f;
      });
      await waitFor(() => expect(api.phase).toBe('ready'));
      await new Promise((r) => setTimeout(r, 20));
      // Boot dialed the runtime from the STORED blob.
      expect(hostedCalls[0]).toMatchObject({ transportConfig: { dial: 'cfg1' }, session: 't0' });
      // Re-scan: the fresh grant carries an UPDATED blob.
      let pair!: Promise<PairSuccess | false>;
      act(() => { pair = api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://pairhost/', transport: 'hostedkind', token: 'fresh' })); });
      await act(async () => {
        await pairingFake.grant(hostedGrant({ dial: 'cfg2' }, 't2'));
        expect(await pair).toEqual({ kind: 'refreshed', pairingId: P1 });
      });
      // Blob replaced durably…
      expect((await loadPairingsRaw())[0]!.transportConfig).toEqual({ dial: 'cfg2' });
      // …and the runtime was re-dialed with the fresh blob + token; the
      // superseded runtime transport is closed, the handshake socket too.
      await waitFor(() => expect(hostedCalls).toHaveLength(2));
      expect(hostedCalls[1]).toMatchObject({ transportConfig: { dial: 'cfg2' }, session: 't2', userId: 'u1' });
      await waitFor(() => expect(hostedFakes[1]!.connected).toBe(true));
      expect(hostedFakes[0]!.connected).toBe(false);
      expect(pairingFake.connected).toBe(false);
      expect(api.pairings).toHaveLength(1);
    });
  });

  describe('platform UX — SessionMeta refresh, NEW agents, rescan, typed notices (Task 5)', () => {
    it('SessionMeta with a new channel updates the stored pairing and marks it NEW', async () => {
      const tA = new FakeTransport(); const tB = new FakeTransport();
      await mountTwoPaired(tA, tB);
      act(() => { tA.emitSessionMeta({ instance: 'alpha', channels: ['coordinator', 'courier'] }); });
      await waitFor(() => expect(api.pairings.find((p) => p.pairingId === P1)!.channels).toContain('courier'));
      expect(api.pairings.find((p) => p.pairingId === P1)!.newAgents).toEqual(['courier']);
      // Durably persisted through the epoch-gated grant update — survives reload.
      expect((await loadPairingsRaw()).find((p) => p.pairingId === P1)!.channels).toContain('courier');
      // The other pairing's grant is untouched.
      expect(api.pairings.find((p) => p.pairingId === P2)!.channels).toEqual(['coordinator']);
      // Opening the marked conversation clears its NEW state.
      act(() => { api.openChannel(`${P1}/courier`); });
      await waitFor(() => expect(api.pairings.find((p) => p.pairingId === P1)!.newAgents).toEqual([]));
      expect(await kvGet<string[]>(`newagents:${P1}`)).toEqual([]);
    });

    it('SessionMeta with a stale runtime epoch is dropped (no store write)', async () => {
      const transport = new FakeTransport();
      await mountPaired(transport); // runtime holds epoch 'e1'
      // Another tab refreshed the pairing behind this runtime's back: the
      // durable store now carries epoch 'e2'. This runtime's epoch is STALE.
      await savePairings([{
        url: 'ws://x/', sessionToken: 't2', userId: 'u1', instance: 'i',
        channels: ['coordinator'], epoch: 'e2', pairingId: P1, transportKind: 'ws',
      }]);
      act(() => { transport.emitSessionMeta({ instance: 'i', channels: ['coordinator', 'courier'] }); });
      await new Promise((r) => setTimeout(r, 30));
      // No write happened (epoch-gated null) and no NEW marks were minted.
      expect((await loadPairingsRaw())[0]!.channels).toEqual(['coordinator']);
      expect(api.pairings.find((p) => p.pairingId === P1)!.channels).toEqual(['coordinator']);
      expect(api.pairings.find((p) => p.pairingId === P1)!.newAgents).toEqual([]);
      expect(await kvGet(`newagents:${P1}`)).toBeUndefined();
    });

    it('SessionMeta removing a channel hides its conversation row source', async () => {
      const transport = new FakeTransport();
      await mountPaired(transport); // channels: ['coordinator']
      act(() => { transport.emitSessionMeta({ instance: 'i', channels: ['scout'] }); });
      await waitFor(() => expect(api.pairings.find((p) => p.pairingId === P1)!.channels).toEqual(['scout']));
      expect(api.pairings.find((p) => p.pairingId === P1)!.channels).not.toContain('coordinator');
      expect((await loadPairingsRaw())[0]!.channels).toEqual(['scout']);
    });

    it('rescanPlatform bounces the transport and applies the fresh meta', async () => {
      const t1 = new FakeTransport(); const t2 = new FakeTransport();
      const queue = [t1, t2];
      await savePairings([{
        url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
        channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
      }]);
      render(
        <TransportProvider makeTransport={() => queue.shift() ?? new FakeTransport()}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(api.phase).toBe('ready'));
      await new Promise((r) => setTimeout(r, 20));
      expect(t1.connected).toBe(true);
      await act(async () => { await api.rescanPlatform(P1); });
      // Re-dialed through the factory: fresh transport connected, old one closed.
      await waitFor(() => expect(t2.connected).toBe(true));
      expect(t1.connected).toBe(false);
      // The fresh connection's resume-ok meta applies onto the same pairing.
      act(() => { t2.emitSessionMeta({ instance: 'i', channels: ['coordinator', 'courier'] }); });
      await waitFor(() => expect(api.pairings.find((p) => p.pairingId === P1)!.channels).toContain('courier'));
      expect(api.pairings.find((p) => p.pairingId === P1)!.newAgents).toEqual(['courier']);
    });

    it('authError carries a kind', async () => {
      // unsupported: under universal pairing an unknown payload KIND pairs
      // fine over ws (see the Task 3 tests) — the one remaining pairing-time
      // 'unsupported' is a ws slot overridden with a NON-PAIRING transport
      // (no onGrant capability).
      const noGrant = new FakeTransport();
      (noGrant as { onGrant?: unknown }).onGrant = undefined;
      render(
        <TransportProvider makeTransport={() => noGrant}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(api.phase).toBe('setup'));
      await act(async () => {
        expect(await api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://h/', transport: 'ws', token: 'tok' }))).toBe(false);
      });
      expect(api.authError).toMatchObject({ kind: 'unsupported' });
      // rejected: a terminal auth failure during interactive pairing.
      const t = new FakeTransport();
      render(
        <TransportProvider makeTransport={(opts) => { t.onAdoptGrant = opts.onAdoptGrant; return t; }}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(api.phase).toBe('setup'));
      let pair!: Promise<PairSuccess | false>;
      act(() => { pair = api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://h/', transport: 'ws', token: 'tok' })); });
      await act(async () => {
        t.authFail(4401);
        expect(await pair).toBe(false);
      });
      expect(api.authError).toMatchObject({ kind: 'rejected' });
    });

    it('boot loads persisted NEW-agent marks and unpair wipes them (kv + view)', async () => {
      await kvSet(`newagents:${P1}`, ['coordinator']);
      const transport = new FakeTransport();
      await mountPaired(transport);
      await waitFor(() => expect(api.pairings[0]!.newAgents).toEqual(['coordinator']));
      await act(async () => { await api.unpair(P1); });
      await waitFor(() => expect(api.phase).toBe('setup'));
      expect(await kvGet(`newagents:${P1}`)).toBeUndefined();
    });

    it('emits a revoked event when a pairing is terminally unpaired by its server', async () => {
      const tA = new FakeTransport(); const tB = new FakeTransport();
      await mountTwoPaired(tA, tB);
      const events: PlatformEvent[] = [];
      const unsub = api.subscribeEvents((e) => events.push(e));
      act(() => { tA.authFail(4401); });
      await waitFor(() => expect(events.some((e) => e.type === 'revoked')).toBe(true));
      // The event names its own instance — banner surfaces must not have to
      // race the shrinking pairings list to discriminate colliding names.
      expect(events.find((e) => e.type === 'revoked')).toMatchObject({ pairingId: P1, instance: 'alpha', displayName: 'alpha' });
      expect(api.authError).toMatchObject({ kind: 'revoked' });
      unsub();
    });

    it('emits reconnect-flush with the count of rows sent by the first drain pass after reconnect', async () => {
      const transport = new FakeTransport();
      await mountPaired(transport);
      const events: PlatformEvent[] = [];
      const unsub = api.subscribeEvents((e) => events.push(e));
      act(() => { transport.setStatus('closed'); transport.connected = false; });
      act(() => { api.sendMessage(CK, 'one'); });
      await waitFor(async () => expect((await outbox.listForChannel('coordinator', P1)).length).toBe(1));
      await new Promise((r) => setTimeout(r, 2)); // deterministic FIFO order
      act(() => { api.sendMessage(CK, 'two'); });
      await waitFor(async () => expect((await outbox.listForChannel('coordinator', P1)).length).toBe(2));
      await act(async () => { await transport.connect(); });
      await waitFor(() => expect(events.some((e) => e.type === 'reconnect-flush')).toBe(true));
      expect(events.find((e) => e.type === 'reconnect-flush')).toMatchObject({ pairingId: P1, sent: 2 });
      unsub();
    });
  });

  describe('push registration fan-out (Task 7)', () => {
    const pushSubs = (t: FakeTransport) =>
      t.sent.filter((e): e is Envelope<'push.subscribe'> => e.kind === 'push.subscribe');
    const pushUnsubs = (t: FakeTransport) => t.sent.filter((e) => e.kind === 'push.unsubscribe');

    it('enablePush registers the same subscription with every pairing', async () => {
      const tA = new FakeTransport(); const tB = new FakeTransport();
      await mountTwoPaired(tA, tB, { vapid: 'BKey' });
      installFakePushEnv();
      await act(async () => { await api.enablePush(); });
      const subA = pushSubs(tA);
      const subB = pushSubs(tB);
      expect(subA).toHaveLength(1);
      expect(subB).toHaveLength(1);
      expect(subA[0]!.payload.subscription.endpoint).toBe(subB[0]!.payload.subscription.endpoint); // ONE browser subscription
      expect(subA[0]!.from).toBe('user:u1');   // each pairing's own userId
      expect(subB[0]!.from).toBe('user:u2');
    });

    it('unpair sends push.unsubscribe only to that instance and keeps the browser subscription while others remain', async () => {
      const tA = new FakeTransport(); const tB = new FakeTransport();
      await mountTwoPaired(tA, tB, { vapid: 'BKey' });
      const fakeEnv = installFakePushEnv();
      await act(async () => { await api.enablePush(); });
      await act(async () => { await api.unpair(P1); });
      expect(pushUnsubs(tA)).toHaveLength(1);
      expect(pushUnsubs(tB)).toHaveLength(0);
      expect(fakeEnv.unsubscribeLocalCalls).toBe(0);   // B still needs the browser subscription
      await act(async () => { await api.unpair(P2); });
      expect(fakeEnv.unsubscribeLocalCalls).toBe(1);   // last pairing gone: local teardown
    });

    it('a mismatched-key getSubscription rejection fails closed for that pairing without aborting the fan-out', async () => {
      const tA = new FakeTransport(); const tB = new FakeTransport();
      await mountTwoPaired(tA, tB, { vapid: 'BKey' });
      // First pairing's subscribe attempt rejects (InvalidStateError-style:
      // the existing browser subscription holds a DIFFERENT
      // applicationServerKey); the second succeeds. The rejection must fail
      // closed — not abort the loop, not skip push-enabled, not surface an
      // unhandled rejection out of enablePush().
      let calls = 0;
      __setPushEnvForTests({
        permission: () => 'granted',
        requestPermission: async () => 'granted',
        getSubscription: async () => {
          calls += 1;
          if (calls === 1) throw new DOMException('existing subscription has a different applicationServerKey', 'InvalidStateError');
          return { endpoint: 'https://push.example/ep1', keys: { p256dh: 'p', auth: 'a' } };
        },
        currentEndpoint: async () => 'https://push.example/ep1',
        unsubscribeLocal: async () => {},
      });
      let ok!: boolean;
      await act(async () => { ok = await api.enablePush(); });
      expect(ok).toBe(true);                   // one pairing succeeded
      expect(pushSubs(tA)).toHaveLength(0);    // mismatched-key pairing failed closed, no envelope
      expect(pushSubs(tB)).toHaveLength(1);    // fan-out continued past the rejection
      expect(await kvGet<boolean>('push-enabled')).toBe(true);
    });

    it('a pairing added while push is enabled gets registered automatically', async () => {
      const t = new FakeTransport();
      await mountPaired(t, { vapid: 'BKey' });         // single pairing seeding vapidPublicKey: 'BKey'
      installFakePushEnv();
      await act(async () => { await api.enablePush(); });
      expect(pushSubs(t)).toHaveLength(1);
      const t2 = new FakeTransport();
      currentPairingTransport = t2;
      let pair!: Promise<PairSuccess | false>;
      act(() => { pair = api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://b/', transport: 'ws', token: 'tok' })); });
      await act(async () => {
        await t2.grant(createEnvelope('pair.grant', {
          from: 'system', to: 'user:u2', channel: 'pairing',
          payload: { sessionToken: 'tB', userId: 'u2', instance: 'beta', channels: ['coordinator'], vapidPublicKey: 'BKey' },
        }));
        expect(await pair).toMatchObject({ kind: 'new' }); // object-truthy success
      });
      await waitFor(() => expect(pushSubs(t2)).toHaveLength(1));
    });
  });

  describe('cloudsignal built-in registry (universal pairing Task 5)', () => {
    afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

    /** A structurally valid cloudsignal pair.grant transportConfig blob. */
    const CS_CONFIG = {
      host: 'wss://broker.example',
      organizationId: 'org1',
      tokenServiceUrl: 'https://tokens.example',
      tokenUrl: 'https://platform.example/raccoon/token',
    };

    const csPairing = {
      url: 'wss://pairhost/', sessionToken: 'cs-tok', userId: 'u1', instance: 'hosted',
      channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'cloudsignal',
      transportConfig: CS_CONFIG,
    };

    it('a stored cloudsignal pairing dials at boot and is SUPPORTED — a transports override replaces the built-in slot', async () => {
      await savePairings([csPairing]);
      const csFake = new FakeTransport();
      const calls: Array<Parameters<MakeTransport>[0]> = [];
      render(
        <TransportProvider transports={{ cloudsignal: (opts) => { calls.push(opts); return csFake; } }}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(api.phase).toBe('ready'));
      await waitFor(() => expect(csFake.connected).toBe(true));
      // The override factory (which CAN take fakes) received the stored dial
      // inputs — blob + identity — exactly like any registry kind.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ transportConfig: CS_CONFIG, userId: 'u1', instance: 'hosted', session: 'cs-tok' });
      // Registry truth: no longer an "unsupported kind".
      expect(api.pairings[0]!.supported).toBe(true);
      expect(api.pairings[0]!.status).toBe('open');
    });

    it('the BUILT-IN slot exists: with NO transports prop a stored cloudsignal pairing is supported and a connect is ATTEMPTED', async () => {
      // The built-in factory constructs the REAL CloudSignalTransport, which
      // cannot take injected fakes — so the observables are:
      //  1. supported === true straight from the default registry,
      //  2. dialPairing's factory-threw warn is ABSENT (a transport was
      //     constructed from the valid blob), and
      //  3. the connect attempt is real: the transport's token exchange POSTs
      //     the pairing's sessionToken to the blob's tokenUrl.
      // No live broker needed — the stubbed fetch rejects, the connect
      // attempt fails, and the pairing stays LISTED (status 'closed'), which
      // is the normal offline shape, not the paired-elsewhere one.
      const fetchCalls: Array<{ url: string; init?: { method?: string; headers?: Record<string, string> } }> = [];
      vi.stubGlobal('fetch', async (url: string, init?: { method?: string; headers?: Record<string, string> }) => {
        fetchCalls.push({ url, init });
        throw new Error('no network in tests');
      });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await savePairings([csPairing]);
      render(
        <TransportProvider>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(api.phase).toBe('ready'));
      expect(api.pairings[0]!.supported).toBe(true);
      // The factory ran and the constructed transport dialed: token exchange.
      await waitFor(() => expect(fetchCalls.some((c) => c.url === CS_CONFIG.tokenUrl)).toBe(true));
      const call = fetchCalls.find((c) => c.url === CS_CONFIG.tokenUrl)!;
      expect(call.init?.method).toBe('POST');
      expect(call.init?.headers?.Authorization).toBe('Bearer cs-tok');
      // The built-in slot handled the kind — dialPairing never warned.
      expect(warn.mock.calls.some((args) => String(args[0]).includes('transport factory for kind'))).toBe(false);
      // Failed connect = plain offline; the pairing is listed and supported.
      expect(api.pairings[0]!.status).toBe('closed');
      expect(api.authError).toBeNull();
    });

    it('cloudSignalDefaultFactory throws a DESCRIPTIVE error on missing identity fields (dialPairing degrades it to listed-offline)', () => {
      // The guard names what is missing — the throw is caught by dialPairing's
      // never-throw catch and the platform lists offline (the designed #A3
      // degradation), so the message is the only diagnostic that surfaces.
      expect(() => cloudSignalDefaultFactory({ url: 'wss://x/', transportConfig: CS_CONFIG, userId: 'u1', instance: 'i' }))
        .toThrow(/session/);
      expect(() => cloudSignalDefaultFactory({ url: 'wss://x/', transportConfig: CS_CONFIG, session: 's' }))
        .toThrow(/userId, instance/);
      // With everything present a real transport comes back.
      const t = cloudSignalDefaultFactory({ url: 'wss://x/', transportConfig: CS_CONFIG, session: 's', userId: 'u1', instance: 'i' });
      expect(typeof t.connect).toBe('function');
      expect(typeof t.onAuthError).toBe('function');
    });

    it('a MALFORMED cloudsignal blob lists the platform offline (factory throws, dialPairing catches) — supported stays true', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      await savePairings([{ ...csPairing, transportConfig: { host: '' } }]);
      render(
        <TransportProvider>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(api.phase).toBe('ready'));
      expect(api.pairings[0]!.status).toBe('closed');
      // Registry truth: the KIND is supported here — the blob is what is bad,
      // so this is the offline shape, never "paired elsewhere".
      expect(api.pairings[0]!.supported).toBe(true);
      expect(warn.mock.calls.some((args) => String(args[0]).includes('transport factory for kind "cloudsignal"'))).toBe(true);
      expect(api.authError).toBeNull();
    });

    it('PairingView.supported is registry truth: an unregistered kind is false, ws is true', async () => {
      await savePairings([
        {
          url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'alpha',
          channels: ['coordinator'], epoch: 'eA', pairingId: P1, transportKind: 'ws',
        },
        {
          url: 'mesh://y/', sessionToken: 't2', userId: 'u2', instance: 'beta',
          channels: ['coordinator'], epoch: 'eB', pairingId: P2, transportKind: 'ble-mesh',
        },
      ]);
      render(
        <TransportProvider makeTransport={() => new FakeTransport()}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(api.phase).toBe('ready'));
      expect(api.pairings.find((p) => p.pairingId === P1)!.supported).toBe(true);
      expect(api.pairings.find((p) => p.pairingId === P2)!.supported).toBe(false);
    });

    it('a second auth-error fire after the terminal teardown is a no-op — listeners detach on the FIRST fire', async () => {
      // A revoked cloudsignal grant fires onAuthError(401) per connect
      // attempt. The FIRST fire's handler runs the synchronous-kill preamble
      // and wipePairing detaches the transport listeners before its first
      // await — so a re-fire (same tick or later) reaches zero handlers and
      // cannot start a second competing teardown.
      const transport = new FakeTransport();
      await mountPaired(transport);
      act(() => { transport.authFail(401); transport.authFail(401); });
      await waitFor(() => expect(api.phase).toBe('setup'));
      expect(api.pairings).toHaveLength(0);
      expect(api.authError).toMatchObject({ kind: 'revoked' });
      expect(await loadPairingsRaw()).toHaveLength(0);
    });
  });
});
