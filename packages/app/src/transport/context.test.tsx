// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@raccoon/protocol';
import { closeDbForTests, kvGet, kvSet } from '../lib/idb.js';
import { loadSession, saveSession } from '../lib/session.js';
import * as outbox from '../lib/outbox.js';
import { FakeTransport } from './fake.js';
import { TransportProvider, useChat, type ChatApi } from './context.js';

afterEach(async () => { await closeDbForTests(); });

let api: ChatApi;
function Probe() {
  api = useChat();
  return <div data-testid="phase">{api.phase}</div>;
}

async function mountPaired(transport: FakeTransport) {
  await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'] });
  render(
    <TransportProvider makeTransport={() => transport}>
      <Probe />
    </TransportProvider>,
  );
  await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
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
      <TransportProvider makeTransport={() => transport}>
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(api.phase).toBe('setup'));
    const pairing = api.pairWithPayload(JSON.stringify({ v: 1, instanceUrl: 'ws://h:1/', transport: 'ws', token: 'tok' }));
    await act(async () => {
      transport.grant(createEnvelope('pair.grant', {
        from: 'system', to: 'user:u1', channel: 'pairing',
        payload: { sessionToken: 's1', userId: 'u1', instance: 'echo', channels: ['coordinator'] },
      }));
      await pairing;
    });
    await waitFor(() => expect(api.phase).toBe('ready'));
    expect(api.session?.userId).toBe('u1');
  });

  it('unpair wipes local identity state (outbox + kv + chat state) so a re-pair cannot leak the prior user', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    // Seed prior-user local state: a queued outbox entry + a read marker.
    await outbox.enqueue(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'A private draft' },
    }));
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
        sessionOverride={{ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'] }}
        pushRegistrarOverride={{ enable: async () => true, disable: async () => { disabled = true; } }}
      >
        <Probe />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getByTestId('phase').textContent).toBe('ready'));
    await act(async () => { await api.unpair(); });
    expect(disabled).toBe(true);
  });

  it('requeues a row stranded in "sending" by a crash/reload and sends it once the transport opens (#R3-8)', async () => {
    // Simulate a prior session that was killed mid-send: an outbox entry left
    // in 'sending' state with no chance to fire the transport's 'closed'
    // event (which is the only other thing that calls demoteSending()).
    await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'] });
    const stranded = await outbox.enqueue(createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'stranded' },
    }));
    await outbox.markSending(stranded.id);
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
    await mountPaired(transport);

    const env1 = createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'first' },
    });
    await outbox.enqueue(env1);
    await new Promise((r) => setTimeout(r, 2)); // force env2's ts to sort strictly after env1's
    const env2 = createEnvelope('msg', {
      from: 'user:u1', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'SECOND must never be sent' },
    });
    await outbox.enqueue(env2);

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

  it('approval responses wait for a server ack before settling, and surface as failed on timeout (#R2-5)', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.respondApproval('coordinator', 'task-9', 'approve'); });
    await waitFor(() => expect(transport.sent.some((e) => e.kind === 'approval.response')).toBe(true));
    const responseEnv = transport.sent.find((e) => e.kind === 'approval.response')!;

    const outbox = await import('../lib/outbox.js');
    // Must NOT settle immediately: a connection drop before the server actually
    // receives this must not silently claim success (the old fire-and-forget bug).
    expect(await outbox.listForChannel('coordinator')).toHaveLength(1);

    act(() => {
      transport.emit(createEnvelope('ack', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
        payload: { refId: responseEnv.id, status: 'received' },
      }));
    });
    await waitFor(async () => expect(await outbox.listForChannel('coordinator')).toHaveLength(0));
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
