// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvelope } from '@raccoon/protocol';
import { closeDbForTests, kvGet, kvSet } from '../lib/idb.js';
import { loadSession, saveSession } from '../lib/session.js';
import * as outbox from '../lib/outbox.js';
import { FakeTransport } from './fake.js';
import { TransportProvider, useChat, type ChatApi } from './context.js';

// Unmount every rendered provider BEFORE resetting the DB — the boot effect's
// cleanup clears its periodic lease sweep, BroadcastChannels, and timers, so a
// prior test's provider can't run async outbox work against the next test's
// shared fake-IndexedDB (a cross-test flake once 'open' began scheduling
// recoverProcessing()/drain(), #R6-2b/#R6-5b).
afterEach(async () => { cleanup(); await closeDbForTests(); });

// #R6-3b/#R7-3: the provider's identity key is the JSON of {i:instance,
// u:userId,e:epoch}. Seeded sessions/rows use instance 'i', user 'u1',
// epoch EPOCH so the key is deterministic across the provider and the seeds.
const EPOCH = 'e1';
const KEY = JSON.stringify({ i: 'i', u: 'u1', e: EPOCH });
const OTHER_KEY = JSON.stringify({ i: 'i', u: 'other', e: EPOCH });

let api: ChatApi;
function Probe() {
  api = useChat();
  return <div data-testid="phase">{api.phase}</div>;
}

async function mountPaired(transport: FakeTransport) {
  await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: EPOCH });
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
  it('boots to setup with no session', async () => {
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
    expect(api.session?.userId).toBe('u1');
    // #P1-B: durably persisted (the save preceded confirmation), not a racy after-the-fact write.
    expect((await loadSession())?.sessionToken).toBe('s1');
  });

  it('pairing survives a rejected connect() and completes on the recovery grant — session persisted + ready (#R10)', async () => {
    // Models a lost pair.confirmed: the initial connect() REJECTS, then the
    // transport recovers in the background and re-emits the grant. pairWithPayload
    // must NOT abort on the connect() rejection — it must persist the recovered
    // session and reach 'ready'. Pre-fix, the connect() throw aborted pairing:
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
    expect(api.session?.userId).toBe('u1');
    // Logical pairing: the recovered session is DURABLY persisted (survives reload).
    const saved = await loadSession();
    expect(saved?.sessionToken).toBe('s-recovered');
    expect(saved?.userId).toBe('u1');
  });

  it('unpair wipes local identity state (outbox + kv + chat state) so a re-pair cannot leak the prior user', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    // Close the transport before seeding so the queued row is not immediately
    // drained by the open connection (an open transport correctly sends
    // pending rows) — we want it to stay queued to prove unpair wipes it.
    act(() => { transport.setStatus('closed'); });
    // Seed prior-user local state: a queued outbox entry + a read marker.
    await outbox.enqueue(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'A private draft' },
    }), KEY);
    await kvSet('lastread:coordinator', new Date(0).toISOString());
    expect((await outbox.listPending()).length).toBe(1);

    await act(async () => { await api.unpair(); });
    await waitFor(() => expect(api.phase).toBe('setup'));

    // Outbox emptied: the next pairing's onStatus('open') -> drain() cannot flush
    // the prior user's queued messages through the new session.
    expect(await outbox.listPending()).toEqual([]);
    // kv wiped: session gone and read markers cleared.
    expect(await loadSession()).toBeNull();
    expect(await kvGet('lastread:coordinator')).toBeUndefined();
    // In-memory chat state reset.
    expect(api.state.messages).toEqual({});
    expect(api.session).toBeNull();
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
    await act(async () => { await api.unpair(); });
    expect(disabled).toBe(true);
  });

  it('unpair invalidates the durable session BEFORE the unbounded push cleanup, so a hung disable() cannot leave a reconnectable session (#P1-F3)', async () => {
    await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: EPOCH });
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
    act(() => { unpairing = api.unpair(); });
    // The durable session must be cleared even though unpair is still parked in
    // disable(); otherwise next boot's loadSession() would silently reconnect
    // the "unpaired" device. Resolves only because the clear was hoisted ahead
    // of the push/transport awaits.
    await waitFor(async () => expect(await loadSession()).toBeNull());
    // Release so unpair completes and its bounded-cleanup timer is cleared (no
    // dangling timer to flake later tests).
    releaseDisable();
    await act(async () => { await unpairing; });
  });

  it('unpair completes even if the host push disable() throws SYNCHRONOUSLY (#R10)', async () => {
    await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: EPOCH });
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
    await act(async () => { await api.unpair(); });
    expect(api.phase).toBe('setup');
    expect(await loadSession()).toBeNull();
  });

  it('a history.page arriving after the identity is wiped is dropped (null-scope fence, #R10)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { transport.authFail(4403); }); // wipe → identityScopeRef null, phase setup
    await waitFor(() => expect(api.phase).toBe('setup'));
    // A late history.page for the just-wiped identity must NOT repopulate state.
    act(() => {
      transport.emit(createEnvelope('history.page', {
        from: 'system', to: 'user:u1', channel: 'coordinator',
        payload: { channel: 'coordinator', messages: [{ id: 'h1', role: 'agent', text: 'ghost', ts: '2020-01-01T00:00:00.000Z' }] },
      }));
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(api.state.messages['coordinator'] ?? []).toHaveLength(0);
  });

  it('requeues a row stranded in "sending" by a crash/reload and sends it once the transport opens (#R3-8)', async () => {
    // Simulate a prior session that was killed mid-send: an outbox entry left
    // in 'sending' state with no chance to fire the transport's 'closed'
    // event (which is the only other thing that calls demoteSending()).
    await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: EPOCH });
    const stranded = await outbox.enqueue(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'stranded' },
    }), KEY);
    // Owned by a DIFFERENT (now-crashed) tab — this boot's fresh tabIdRef
    // cannot match it. #R4-4: demoteSending() only reclaims a row it doesn't
    // own once its lease has expired, so simulate real staleness (rather
    // than a still-possibly-alive claim) by backdating Date.now() for just
    // this one markSending() call, landing leaseExpiresAt safely in the past.
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() - outbox.SEND_LEASE_MS - 1000);
    await outbox.markSending(stranded.id, 'crashed-prior-tab', KEY);
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

  it('a cross-tab wipe arriving during boot recovery prevents the wiped session from connecting (#R6-4)', async () => {
    await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: EPOCH });

    // Park the boot inside its lease-sweep await, deliver identity-wiped
    // from "another tab" while parked, then release. The boot continuation
    // previously checked only the unmount flag — not the session generation
    // the wipe handler bumps — and wired + connected the wiped session.
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
    otherTab.postMessage({ type: 'identity-wiped', key: KEY });
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('setup'));
    otherTab.close();

    releaseDemote();
    await new Promise((r) => setTimeout(r, 20));

    expect(transport.connected).toBe(false);
    expect(screen.getByTestId('phase').textContent).toBe('setup');
    demoteSpy.mockRestore();
  });

  it('an IndexedDB boot failure enters storage-error, never hanging on loading (#F6)', async () => {
    // loadSession() (and the IDB paths it drives) reject on a blocked/failed
    // IndexedDB open. The boot must enter the retryable 'storage-error' state —
    // NOT stay on the initial 'loading' spinner, and NOT drop to 'setup' (whose
    // pairing could never be saved).
    const realLoad = await import('../lib/session.js');
    const loadSpy = vi.spyOn(realLoad, 'loadSession').mockRejectedValue(new Error('IndexedDB open blocked'));
    render(
      <TransportProvider makeTransport={() => new FakeTransport()}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('storage-error'));
    loadSpy.mockRestore();
  });

  it('a failed durable-storage write-probe enters storage-error, so pairing stays disabled (#F6)', async () => {
    // Storage opens/reads but a WRITE fails (private mode / quota). loadSession
    // would succeed, but a pair could never be saved — so gate on the write-probe.
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

  it('a wipe that arrives BEFORE loadSession resolves is not ignored — the loaded session is not installed (#R6-4b)', async () => {
    await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: EPOCH });

    // Gate the IDB session load so the wipe lands while this tab has NO
    // current identity yet (sessionRef null). The old listener returned early
    // in that state and dropped the wipe, so a stale load could then connect
    // a just-unpaired session. The tombstone must be recorded regardless.
    const realLoad = await import('../lib/session.js');
    let releaseLoad!: (v: Awaited<ReturnType<typeof realLoad.loadSession>>) => void;
    const loadGate = new Promise<Awaited<ReturnType<typeof realLoad.loadSession>>>((r) => { releaseLoad = r; });
    const loadSpy = vi.spyOn(realLoad, 'loadSession').mockReturnValue(loadGate);

    const transport = new FakeTransport();
    render(
      <TransportProvider makeTransport={() => transport}>
        <Probe />
      </TransportProvider>,
    );
    await new Promise((r) => setTimeout(r, 10)); // boot effect ran; load is parked

    // Another tab wipes THIS identity while we are still loading.
    const wiper = new BroadcastChannel('raccoon-identity');
    wiper.postMessage({ type: 'identity-wiped', key: KEY });
    await new Promise((r) => setTimeout(r, 10));
    wiper.close();

    // Now the stale read resolves with the (just-wiped) session.
    releaseLoad({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: EPOCH });
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('setup'));

    // It must NOT have been installed or connected.
    expect(transport.connected).toBe(false);
    expect(api.session).toBeNull();
    loadSpy.mockRestore();
  });

  it('an identity-wiped for a DIFFERENT identity does not log this tab out (#R6-8)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport); // u1 @ ws://x/

    // A delayed/unrelated wipe event — different user, and separately a
    // different instance URL — must not tear down this session.
    const otherTab = new BroadcastChannel('raccoon-identity');
    otherTab.postMessage({ type: 'identity-wiped', key: JSON.stringify({ i: 'i', u: 'someone-else', e: EPOCH }) });
    otherTab.postMessage({ type: 'identity-wiped', key: JSON.stringify({ i: 'other-instance', u: 'u1', e: EPOCH }) });
    await new Promise((r) => setTimeout(r, 30));
    otherTab.close();

    expect(api.phase).toBe('ready');
    expect(api.session?.userId).toBe('u1');
  });

  it('a stale wipe for a since-re-paired session (new epoch) does not log out the new session (#R6-8b)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport); // session token 't'

    // A wipe posted for a DIFFERENT session epoch (old token) for the same
    // user@instance must not tear down this (freshly-paired) session.
    const otherTab = new BroadcastChannel('raccoon-identity');
    otherTab.postMessage({ type: 'identity-wiped', key: JSON.stringify({ i: 'i', u: 'u1', e: 'old-epoch' }) });
    await new Promise((r) => setTimeout(r, 30));
    otherTab.close();

    expect(api.phase).toBe('ready');
    expect(api.session?.userId).toBe('u1');
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
    }), KEY);
    const realNow = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow - outbox.SEND_LEASE_MS + 400);
    await outbox.markSending(row.id, 'crashed-late-tab', KEY); // lease expires ~400ms from now
    dateNowSpy.mockRestore();

    await waitFor(
      () => expect(transport.sent.some((e) => e.id === row.id)).toBe(true),
      { timeout: 5000 },
    );
  }, 10_000);

  it('never sends a pending row written under a different identity, but LEAVES it for its owner (#R5-3/#R7-3)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport); // current identity: u1

    // A row belonging to a DIFFERENT identity's scope — could be another tab
    // logged in as user:other, live right now.
    const foreign = await outbox.enqueue(createEnvelope('msg', {
      from: 'user:other', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'someone else\'s message' },
    }), OTHER_KEY);
    // A legitimate row for the current identity, to prove drain still works.
    const mine = await outbox.enqueue(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'mine' },
    }), KEY);

    act(() => { transport.setStatus('open'); }); // trigger drain

    await waitFor(() => expect(transport.sent.some((e) => e.id === mine.id)).toBe(true));
    // The foreign row was never transmitted through u1's session…
    expect(transport.sent.some((e) => e.from === 'user:other')).toBe(false);
    // …and #R7-3: it is LEFT in the store (not deleted) — it may belong to a
    // live tab under that identity; destroying it would lose that tab's data.
    expect((await outbox.listForChannel('coordinator')).some((e) => e.id === foreign.id)).toBe(true);
  });

  it('a wipe in one tab tears down other tabs running the same identity (#R5-3 cross-tab)', async () => {
    interface Sink { api?: ChatApi }
    function ProbeInto({ sink }: { sink: Sink }) {
      sink.api = useChat();
      return <div>{sink.api.phase}</div>;
    }
    await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: EPOCH });
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
    // in-memory identity live indefinitely — still enqueueing rows (and
    // showing chat UI) as a user whose local state was already wiped.
    await act(async () => { await a.api!.unpair(); });

    await waitFor(() => expect(b.api!.phase).toBe('setup'));

    // Tab B can no longer act as the wiped identity. Its api surface drops
    // sendMessage outside phase 'ready' (hence ?.()), and even a stale UI
    // closure that captured the pre-teardown function is rejected by the
    // synchronously-nulled validUserIdRef — either way, nothing reaches the
    // outbox or the transport.
    act(() => { b.api!.sendMessage?.('coordinator', 'stale message from a dead identity'); });
    await new Promise((r) => setTimeout(r, 20));
    expect(await outbox.listPending()).toEqual([]);
    expect(tB.sent.filter((e) => e.kind === 'msg')).toHaveLength(0);
  });

  it('a foreign row whose lease is still valid at boot is requeued and sent once that lease lapses (#R5-4)', async () => {
    await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: EPOCH });
    const stranded = await outbox.enqueue(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'crashed mid-send' },
    }), KEY);
    // The owning tab crashed MOMENTS ago: its lease is still valid at boot
    // (expires ~1.5s from now), so the one-shot boot demote must skip it.
    // Backdate Date.now() during the claim so leaseExpiresAt lands there.
    const realNow = Date.now();
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(realNow - outbox.SEND_LEASE_MS + 1500);
    await outbox.markSending(stranded.id, 'crashed-tab', KEY);
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
    await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: EPOCH });

    // Gate the boot's demoteSending() await so the test can unmount the
    // provider while the boot effect's async continuation is still
    // in flight, mid-way through the loadSession().then(...) chain.
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

  it('re-requests history for loaded channels on reconnect so messages missed while offline appear (#10)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.openChannel('coordinator'); });
    await waitFor(() => expect(
      transport.sent.some((e) => e.kind === 'history.request' && e.channel === 'coordinator'),
    ).toBe(true));
    act(() => {
      transport.emit(createEnvelope('history.page', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
        payload: { channel: 'coordinator', messages: [] },
      }));
    });
    await waitFor(() => expect(api.state.historyLoaded['coordinator']).toBe(true));
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
    await outbox.enqueue(env1, KEY);
    await new Promise((r) => setTimeout(r, 2)); // force env2's ts to sort strictly after env1's
    const env2 = createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'SECOND must never be sent' },
    });
    await outbox.enqueue(env2, KEY);

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
    act(() => { api.sendMessage('coordinator', 'stale — queued right as unpair happens'); });

    // Started IMMEDIATELY after, with no intervening await/yield: unpair()'s
    // FIRST statement (the synchronous session-generation bump) runs before
    // the just-started enqueue's IDB callback has any chance to fire — a
    // realistic stand-in for "a user action races a server-driven
    // auth-error/unpair decision".
    await act(async () => { await api.unpair(); });

    await new Promise((r) => setTimeout(r, 20)); // let the stale enqueue's .then() run, if it hadn't already

    // The row must not survive the wipe it raced: settled away rather than
    // left pending for a future session's drain() to pick up and send.
    expect(await outbox.listPending()).toEqual([]);
    expect(transport.sent).toHaveLength(0);
  });

  it('sends optimistically, settles on ack', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.sendMessage('coordinator', 'hello'); });
    await waitFor(() => expect(transport.sent).toHaveLength(1));
    const sent = transport.sent[0]!;
    expect(sent.kind).toBe('msg');
    expect(api.state.messages['coordinator']![0]!.delivery).toBe('pending');
    act(() => {
      transport.emit(createEnvelope('ack', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
        payload: { refId: sent.id, status: 'received' },
      }));
    });
    await waitFor(() => expect(api.state.messages['coordinator']![0]!.delivery).toBe('sent'));
  });

  it('a terminal (MAX_ATTEMPTS-exhausted) send failure flips delivery to "failed", not stuck on "pending" (#R3-11)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    // Force every send to fail synchronously — mirrors the real
    // "transport not open" race (attempt() sees a non-null transport but its
    // send() throws because the connection dropped in between).
    transport.send = async () => { throw new Error('transport not open'); };

    act(() => { api.sendMessage('coordinator', 'hello'); });
    await waitFor(() => expect(api.state.messages['coordinator']).toBeDefined());
    expect(api.state.messages['coordinator']![0]!.delivery).toBe('pending');

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
    await waitFor(() => expect(api.state.messages['coordinator']![0]!.delivery).toBe('failed'));
  });

  it('routes inbound msg/typing/approval and requests history on open', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.openChannel('coordinator'); });
    await waitFor(() => expect(transport.sent.some((e) => e.kind === 'history.request')).toBe(true));
    act(() => {
      transport.emit(createEnvelope('typing', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { state: 'start' },
      }));
    });
    await waitFor(() => expect(api.state.typing['coordinator']).toBe(true));
    act(() => {
      transport.emit(createEnvelope('msg', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'hi' },
      }));
    });
    await waitFor(() => expect(api.state.messages['coordinator']!.some((m) => m.text === 'hi')).toBe(true));
    expect(api.state.typing['coordinator']).toBe(false);
  });

  it('drops to setup with a notice on auth error, clearing activeChannel (#R2-10)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.openChannel('coordinator'); });
    expect(api.activeChannel).toBe('coordinator');
    act(() => { transport.authFail(4403); });
    await waitFor(() => expect(api.phase).toBe('setup'));
    expect(api.authError).toContain('unpaired');
    // Without this, a stale ?c=coordinator URL (or activeChannel) could reopen
    // a channel left over from the prior user's session after a fresh pairing.
    expect(api.activeChannel).toBeNull();
  });

  it('openChannel ignores a channel not in the current session\'s channel list (#R2-10)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport); // session.channels = ['coordinator']
    act(() => { api.openChannel('someone-elses-channel'); });
    expect(api.activeChannel).toBeNull();
    act(() => { api.openChannel('coordinator'); });
    expect(api.activeChannel).toBe('coordinator');
  });

  it('drains queued sends when the transport reopens', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { transport.setStatus('closed'); transport.connected = false; });
    act(() => { api.sendMessage('coordinator', 'queued'); });
    await waitFor(() => expect(api.state.messages['coordinator']).toHaveLength(1));
    expect(transport.sent).toHaveLength(0);
    await act(async () => { await transport.connect(); });
    await waitFor(() => expect(transport.sent.filter((e) => e.kind === 'msg')).toHaveLength(1));
  });

  it('requests history on reconnect for the active channel when it was opened offline', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { transport.setStatus('closed'); transport.connected = false; });
    act(() => { api.openChannel('coordinator'); });
    expect(transport.sent.some((e) => e.kind === 'history.request')).toBe(false);
    await act(async () => { await transport.connect(); });
    await waitFor(() => expect(transport.sent.some((e) => e.kind === 'history.request')).toBe(true));
  });

  it('approval responses stay durable through "received" and settle only on the terminal ack (#R2-5/#R6-2b)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.respondApproval('coordinator', 'task-9', 'approve'); });
    await waitFor(() => expect(transport.sent.some((e) => e.kind === 'approval.response')).toBe(true));
    const responseEnv = transport.sent.find((e) => e.kind === 'approval.response')!;

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
    await approvals.saveApproval(KEY, reqEnv);
    await outbox.enqueue(createEnvelope('approval.response', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator',
      payload: { refId: 'task-1', choice: 'approve' },
    }), KEY); // stays 'pending' (transport closed) — omitted by the old failed/processing-only filter

    act(() => {
      transport.emit(createEnvelope('history.page', {
        from: 'system', to: 'user:u1', channel: 'coordinator',
        payload: { channel: 'coordinator', messages: [{ id: reqEnv.id, role: 'agent', text: 'approve?', ts: reqEnv.ts }] },
      }));
    });
    // The reconciled card must show the pending response as answered, so the
    // user cannot submit a competing second response for the same refId.
    await waitFor(() => {
      const m = api.state.messages['coordinator']?.find((x) => x.kind === 'approval');
      expect(m?.respondedChoice).toBe('approve');
    });
  });

  it('history reconciliation bails if the identity changes across its awaits — no cross-identity attach (#P1-E3)', async () => {
    const approvals = await import('../lib/approvals.js');
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { transport.setStatus('closed'); });
    const reqEnv = createEnvelope('approval.request', {
      from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
      payload: { refId: 'task-1', title: 'Draft', description: 'approve?', options: ['approve'] },
    });
    await approvals.saveApproval(KEY, reqEnv);

    // Park the reconcile inside listApprovals so we can flip identity mid-flight.
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

    // Identity A unpairs WHILE the reconcile is parked (identityScopeRef → null,
    // state reset).
    await act(async () => { await api.unpair?.(); });
    // Release with identity A's approval — the fence must drop it, not attach
    // it into the post-unpair (identity B / reset) UI.
    await act(async () => {
      releaseList([{ key: `${KEY}::task-1`, scope: KEY, channel: 'coordinator', refId: 'task-1', env: reqEnv, ts: reqEnv.ts }]);
      await gate.catch(() => {});
      await new Promise((r) => setTimeout(r, 10));
    });
    listSpy.mockRestore();

    expect((api.state.messages['coordinator'] ?? []).some((m) => m.kind === 'approval')).toBe(false);
  });

  it('advances the read marker for messages arriving on the active channel', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.openChannel('coordinator'); });
    const env = createEnvelope('msg', { from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'seen live' } });
    act(() => { transport.emit(env); });
    const { kvGet } = await import('../lib/idb.js');
    await waitFor(async () => expect(await kvGet<string>('lastread:coordinator')).toBe(env.ts));
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

    it('session is the supplied sessionOverride', async () => {
      const transport = new FakeTransport();
      render(
        <TransportProvider transportOverride={transport} sessionOverride={hostSession}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
      expect(api.session).toEqual(hostSession);
    });

    it('accepts a host transport WITHOUT onGrant (non-pairing transport) and reaches ready + sends (#A2)', async () => {
      // A CloudSignal/MQTT-style transport authenticates out-of-band and never
      // issues a pair.grant, so it omits onGrant. It must satisfy AppTransport
      // (onGrant optional) without the `as unknown as AppTransport` cast.
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
      act(() => { api.sendMessage('coordinator', 'hi from a non-pairing transport'); });
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
      expect(api.session?.userId).toBe('u-host');
      expect(api.session?.url).toBeUndefined();
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
      expect(api.session?.channels).toEqual(['coordinator', 'assistant']);
    });

    it('a host override WITHOUT an epoch never derives the identity key from the secret sessionToken (#R8-5)', async () => {
      // The documented host API permits a stable placeholder sessionToken and
      // may omit epoch (e.g. GTM wiring passes sessionToken:"gtm"). The
      // identity key (stamped on outbox rows and broadcast in wipes) must NOT
      // derive from that secret token — a per-mount epoch is minted instead.
      const noEpoch = { url: 'wss://x/', sessionToken: 'super-secret-token', userId: 'u1', instance: 'gtm', channels: ['coordinator'] };
      const transport = new FakeTransport();
      render(
        <TransportProvider transportOverride={transport} sessionOverride={noEpoch}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));

      // A queued message is stamped with the identity scope (= the key).
      act(() => { transport.setStatus('closed'); }); // keep it queued
      act(() => { api.sendMessage('coordinator', 'hi'); });
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

    it('sendMessage produces an envelope with from: user:<userId>', async () => {
      const transport = new FakeTransport();
      render(
        <TransportProvider transportOverride={transport} sessionOverride={hostSession}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
      act(() => { api.sendMessage('coordinator', 'hello from host'); });
      await waitFor(() => expect(transport.sent).toHaveLength(1));
      const sent = transport.sent[0]!;
      expect(sent.kind).toBe('msg');
      expect(sent.from).toBe('user:u-host');
    });

    it('transportOverride without sessionOverride leaves session null (no-op path)', async () => {
      const transport = new FakeTransport();
      render(
        <TransportProvider transportOverride={transport}>
          <Probe />
        </TransportProvider>,
      );
      await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
      expect(api.session).toBeNull();
    });

    it('onAuthError in override mode sets authError and keeps phase ready (does NOT clearSession)', async () => {
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
      // Session must be preserved — clearSession must not have been called
      expect(api.session).toEqual(hostSession);
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
});
