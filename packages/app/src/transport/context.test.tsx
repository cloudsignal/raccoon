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

  it('drops to setup with a notice on auth error', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { transport.authFail(4403); });
    await waitFor(() => expect(api.phase).toBe('setup'));
    expect(api.authError).toContain('unpaired');
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

  it('settles approval responses on send instead of arming an ack timer', async () => {
    const transport = new FakeTransport();
    await mountPaired(transport);
    act(() => { api.respondApproval('coordinator', 'task-9', 'approve'); });
    await waitFor(() => expect(transport.sent.some((e) => e.kind === 'approval.response')).toBe(true));
    const outbox = await import('../lib/outbox.js');
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
