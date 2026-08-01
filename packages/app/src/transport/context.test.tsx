// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@raccoon/protocol';
import { closeDbForTests, kvGet, kvSet } from '../lib/idb.js';
import { loadPairingsRaw, savePairings } from '../lib/session.js';
import * as outbox from '../lib/outbox.js';
import { FakeTransport } from './fake.js';
import { TransportProvider, TYPING_AUTO_CLEAR_MS, useChat, type ChatApi } from './context.js';

// Unmount every rendered provider BEFORE resetting the DB — the boot effect's
// cleanup clears its periodic lease sweep, BroadcastChannels, and timers, so a
// prior test's provider can't run async outbox work against the next test's
// shared fake-IndexedDB (a cross-test flake once 'open' began scheduling
// recoverProcessing()/drain(), #R6-2b/#R6-5b).
afterEach(async () => { cleanup(); await closeDbForTests(); });

// The pairingId IS the outbox/approvals scope and every per-conversation key
// prefix. Seeded pairings use a fixed ULID so keys are deterministic across
// the provider and the seeds.
const EPOCH = 'e1';
const P1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CK = `${P1}/coordinator`;
const OTHER_SCOPE = '01OTHERPAIRINGSCOPEAAAAAAA'; // a pairing this provider does not hold

let api: ChatApi;
function Probe() {
  api = useChat();
  return <div data-testid="phase">{api.phase}</div>;
}

async function mountPaired(transport: FakeTransport) {
  await savePairings([{
    url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i',
    channels: ['coordinator'], epoch: EPOCH, pairingId: P1, transportKind: 'ws',
  }]);
  render(
    <TransportProvider makeTransport={() => transport}>
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
      await pairing;
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

  it('rejects a pairing payload whose transport kind has no registered factory', async () => {
    render(
      <TransportProvider makeTransport={() => new FakeTransport()}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(api.phase).toBe('setup'));
    await act(async () => {
      await api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'x://h/', transport: 'exotic', token: 'tok' }));
    });
    expect(api.authError).toContain('No transport is available');
    expect(api.phase).toBe('setup');
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
    expect(api.authError).toContain('unpaired');
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
      const noEpoch = { url: 'wss://x/', sessionToken: 'super-secret-token', userId: 'u1', instance: 'gtm', channels: ['coordinator'] };
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
      expect(parsed.i).toBe('gtm');
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
      expect(api.authError).toContain('managed by the host');
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
      expect(api.authError).toContain('unpaired');
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
    const P2 = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
    const CK2 = `${P2}/coordinator`;

    async function mountTwoPaired(tA: FakeTransport, tB: FakeTransport) {
      await savePairings([
        { url: 'ws://a/', sessionToken: 'tA', userId: 'u1', instance: 'alpha', channels: ['coordinator'], epoch: 'eA', pairingId: P1, transportKind: 'ws' },
        { url: 'ws://b/', sessionToken: 'tB', userId: 'u2', instance: 'beta', channels: ['coordinator'], epoch: 'eB', pairingId: P2, transportKind: 'ws' },
      ]);
      render(
        <TransportProvider makeTransport={(opts) => (opts.url === 'ws://a/' ? tA : tB)}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(api.phase).toBe('ready'));
      await new Promise((r) => setTimeout(r, 20));
    }

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
});
