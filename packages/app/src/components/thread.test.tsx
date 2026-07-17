// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createEnvelope } from '@raccoon/protocol';
import { closeDbForTests } from '../lib/idb.js';
import { saveSession } from '../lib/session.js';
import { FakeTransport } from '../transport/fake.js';
import { TransportProvider, useChat } from '../transport/context.js';
import { Thread } from './thread.js';

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
  await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'] });
  render(
    <TransportProvider makeTransport={() => transport}>
      <Bind />
      <Thread channel="coordinator" />
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
    act(() => { send('coordinator', 'outgoing'); });
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
