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
import { TransportProvider } from '../transport/context.js';
import { App } from '../app.js';

afterEach(async () => {
  await closeDbForTests();
  window.history.replaceState(null, '', '/');
});

async function mount(transport = new FakeTransport()) {
  await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator', 'echo'] });
  render(
    <TransportProvider makeTransport={() => transport}>
      <App />
    </TransportProvider>,
  );
  await waitFor(() => expect(screen.getByText('Coordinator')).toBeTruthy());
  return transport;
}

describe('chat shell', () => {
  it('renders the adapter-declared channel list from the session', async () => {
    await mount();
    expect(screen.getByText('Coordinator')).toBeTruthy();
    expect(screen.getByText('Echo')).toBeTruthy();
  });

  it('opens a channel, syncs ?c=, and requests history', async () => {
    const transport = await mount();
    await userEvent.setup().click(screen.getByText('Coordinator'));
    await waitFor(() => expect(window.location.search).toBe('?c=coordinator'));
    await waitFor(() => expect(transport.sent.some((e) => e.kind === 'history.request')).toBe(true));
  });

  it('shows unread badges for inactive channels', async () => {
    const transport = await mount();
    act(() => {
      transport.emit(createEnvelope('msg', {
        from: 'agent:echo', to: 'user:u1', channel: 'echo', payload: { text: 'ping' },
      }));
    });
    expect(await screen.findByText('1')).toBeTruthy();
    expect(await screen.findByText('ping')).toBeTruthy(); // list preview
  });

  it('unpairs from the settings sheet', async () => {
    await mount();
    const user = userEvent.setup();
    await user.click(screen.getByText('Coordinator'));
    await user.click(await screen.findByRole('button', { name: /open settings/i }));
    await user.click(await screen.findByRole('button', { name: /unpair this device/i }));
    await waitFor(() => expect(screen.getByText(/pair this device/i)).toBeTruthy());
  });

  it('clears the composer draft when switching channels', async () => {
    const user = userEvent.setup();
    await mount();
    // Open coordinator and type a draft
    await user.click(screen.getByText('Coordinator'));
    const textarea = await screen.findByPlaceholderText(/message coordinator/i);
    await user.type(textarea, 'my draft');
    expect((textarea as HTMLTextAreaElement).value).toBe('my draft');
    // Switch to a different channel — the keyed Composer remounts with empty state
    await user.click(screen.getByText('Echo'));
    const freshTextarea = await screen.findByPlaceholderText(/message echo/i);
    expect((freshTextarea as HTMLTextAreaElement).value).toBe('');
  });
});
