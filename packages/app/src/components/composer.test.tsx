// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDbForTests } from '../lib/idb.js';
import { isUpdateHeld } from '../lib/update-hold.js';
import { saveSession } from '../lib/session.js';
import { FakeTransport } from '../transport/fake.js';
import { TransportProvider } from '../transport/context.js';
import { Composer } from './composer.js';

afterEach(async () => { await closeDbForTests(); });

async function mount() {
  const transport = new FakeTransport();
  await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'] });
  render(
    <TransportProvider makeTransport={() => transport}>
      <Composer channel="coordinator" />
    </TransportProvider>,
  );
  await waitFor(() => expect(transport.connected).toBe(true));
  return transport;
}

describe('Composer', () => {
  it('sends on button tap and clears + releases the update hold', async () => {
    const transport = await mount();
    const user = userEvent.setup();
    const box = screen.getByPlaceholderText(/message coordinator/i);
    await user.type(box, 'hello there');
    expect(isUpdateHeld()).toBe(true);
    await user.click(screen.getByRole('button', { name: /send message/i }));
    await waitFor(() => expect(transport.sent.filter((e) => e.kind === 'msg')).toHaveLength(1));
    expect((box as HTMLTextAreaElement).value).toBe('');
    expect(isUpdateHeld()).toBe(false);
  });

  it('sends on Enter, keeps newline on Shift+Enter', async () => {
    const transport = await mount();
    const user = userEvent.setup();
    const box = screen.getByPlaceholderText(/message coordinator/i);
    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(transport.sent).toHaveLength(0);
    await user.type(box, '{Enter}');
    await waitFor(() => expect(transport.sent.filter((e) => e.kind === 'msg')).toHaveLength(1));
    const sent = transport.sent[0]!;
    expect(sent.kind === 'msg' && sent.payload.text).toContain('line one\nline two');
  });

  it('does not send blank input', async () => {
    const transport = await mount();
    await userEvent.setup().click(screen.getByRole('button', { name: /send message/i }));
    expect(transport.sent).toHaveLength(0);
  });
});
