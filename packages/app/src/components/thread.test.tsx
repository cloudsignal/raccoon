// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createEnvelope } from '@raccoon/protocol';
import { closeDbForTests } from '../lib/idb.js';
import { savePairings } from '../lib/session.js';
import { FakeTransport } from '../transport/fake.js';
import { TransportProvider, useChat } from '../transport/context.js';
import { Thread } from './thread.js';

const P1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CK = `${P1}/coordinator`;

afterEach(async () => { await closeDbForTests(); });

let send: (channel: string, text: string) => void;
let retry: (channel: string, id: string) => void;
function Bind() {
  const chat = useChat();
  send = chat.sendMessage;
  retry = chat.retryMessage;
  return null;
}

async function mount(transport = new FakeTransport()) {
  await savePairings([{ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: 'e1', pairingId: P1, transportKind: 'ws' }]);
  render(
    <TransportProvider makeTransport={() => transport}>
      <Bind />
      <Thread channel={CK} />
    </TransportProvider>,
  );
  await waitFor(() => expect(send).toBeDefined());
  return transport;
}

describe('Thread', () => {
  it('renders date pill, sender label on group start only, and typing dots', async () => {
    const transport = await mount();
    act(() => {
      transport.emit(createEnvelope('msg', { from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'first' } }));
      transport.emit(createEnvelope('msg', { from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'second' } }));
      transport.emit(createEnvelope('typing', { from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { state: 'start' } }));
    });
    expect(await screen.findByText('Today')).toBeTruthy();
    expect(screen.getAllByText('coordinator')).toHaveLength(1); // label once per group
    expect(screen.getByTestId('typing-dots')).toBeTruthy();
  });

  it('shows pending tick then sent tick after ack', async () => {
    const transport = await mount();
    act(() => { send(CK, 'outgoing'); });
    expect(await screen.findByText('outgoing')).toBeTruthy();
    expect(screen.getByTestId('tick-pending')).toBeTruthy();
    await waitFor(() => expect(transport.sent.filter((e) => e.kind === 'msg')).toHaveLength(1));
    act(() => {
      transport.emit(createEnvelope('ack', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
        payload: { refId: transport.sent.find((e) => e.kind === 'msg')!.id, status: 'received' },
      }));
    });
    await waitFor(() => expect(screen.getByTestId('tick-sent')).toBeTruthy());
  });

  it('renders markdown in agent bubbles', async () => {
    const transport = await mount();
    act(() => {
      transport.emit(createEnvelope('msg', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
        payload: { text: 'has **bold** text' },
      }));
    });
    await waitFor(() => expect(screen.getByText('bold').tagName).toBe('STRONG'));
  });

  it('repeats the sender label when a new group starts after an outgoing message', async () => {
    const transport = await mount();
    act(() => {
      transport.emit(createEnvelope('msg', { from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'first' } }));
      transport.emit(createEnvelope('msg', { from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'second' } }));
    });
    act(() => { send(CK, 'interject'); });
    act(() => {
      transport.emit(createEnvelope('msg', { from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator', payload: { text: 'third' } }));
    });
    expect(await screen.findByText('third')).toBeTruthy();
    // First-of-group only: one label for the first-second group, one for third.
    expect(screen.getAllByText('coordinator')).toHaveLength(2);
  });

  it('shows the offline pill only while the owning platform is closed', async () => {
    const transport = await mount();
    expect(screen.queryByText('Offline — messages will send when it reconnects')).toBeNull();
    act(() => transport.setStatus('closed'));
    expect(await screen.findByText('Offline — messages will send when it reconnects')).toBeTruthy();
    act(() => transport.setStatus('open'));
    expect(screen.queryByText('Offline — messages will send when it reconnects')).toBeNull();
  });

  it('captions a pending outgoing message as queued while the platform is offline', async () => {
    const transport = await mount();
    act(() => transport.setStatus('closed'));
    act(() => { send(CK, 'while away'); });
    expect(await screen.findByText('while away')).toBeTruthy();
    expect(screen.getByTestId('tick-pending')).toBeTruthy();
    // displayName falls back to the instance name ('i' in the test pairing).
    expect(screen.getByText('Queued — sends when i reconnects')).toBeTruthy();
    // Reconnect: the drain delivers and the caption goes away with 'pending'.
    act(() => transport.setStatus('open'));
    await waitFor(() => expect(screen.queryByText('Queued — sends when i reconnects')).toBeNull());
  });

  it('shows the unsupported-transport card for a pairing kind with no registered transport', async () => {
    // A stored pairing whose transportKind has no factory stays listed but
    // permanently closed (transport null) — the thread explains it instead of
    // showing the generic offline pill.
    await savePairings([{ url: 'mesh://one/', sessionToken: 't', userId: 'u2', instance: 'gamma', channels: ['coordinator'], epoch: 'e1', pairingId: P1, transportKind: 'mesh' }]);
    render(
      <TransportProvider makeTransport={() => new FakeTransport()}>
        <Thread channel={CK} />
      </TransportProvider>,
    );
    expect(await screen.findByText(/was paired on another device/)).toBeTruthy();
    expect(screen.getByText(/gamma was paired on another device — this app can’t use its connection type\. Messages queue here\./)).toBeTruthy();
    expect(screen.queryByText('Offline — messages will send when it reconnects')).toBeNull();
  });

  it('a cloudsignal pairing (registered kind) shows the plain offline pill, never the paired-elsewhere card', async () => {
    // Task 5: the unsupported derivation is registry truth (view.supported),
    // not a kind allowlist. The old {ws, host} heuristic would have flagged a
    // disconnected cloudsignal pairing as "paired elsewhere" — with the kind
    // registered (built-in slot; overridden here so a fake can stand in), a
    // real disconnect must render the ordinary offline pill instead.
    await savePairings([{
      url: 'wss://pairhost/', sessionToken: 't', userId: 'u2', instance: 'gamma',
      channels: ['coordinator'], epoch: 'e1', pairingId: P1, transportKind: 'cloudsignal',
    }]);
    const fake = new FakeTransport();
    render(
      <TransportProvider transports={{ cloudsignal: () => fake }}>
        <Thread channel={CK} />
      </TransportProvider>,
    );
    await waitFor(() => expect(fake.connected).toBe(true));
    act(() => fake.setStatus('closed'));
    expect(await screen.findByText('Offline — messages will send when it reconnects')).toBeTruthy();
    expect(screen.queryByText(/was paired on another device/)).toBeNull();
  });

  it('offers Load earlier when a history cursor exists', async () => {
    const transport = await mount();
    act(() => {
      transport.emit(createEnvelope('history.page', {
        from: 'agent:coordinator', to: 'user:u1', channel: 'coordinator',
        payload: {
          channel: 'coordinator',
          messages: [{ id: 'h1', role: 'agent', text: 'older', ts: '2026-07-01T08:00:00.000Z' }],
          nextBefore: 'h1',
        },
      }));
    });
    const btn = await screen.findByRole('button', { name: /load earlier/i });
    await userEvent.setup().click(btn);
    await waitFor(() => expect(transport.sent.some((e) => e.kind === 'history.request' && e.payload.before === 'h1')).toBe(true));
  });
});
