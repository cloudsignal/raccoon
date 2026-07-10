// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { createEnvelope } from '@raccoon/protocol';
import { closeDbForTests } from '../lib/idb.js';
import { FakeTransport } from '../transport/fake.js';
import { TransportProvider } from '../transport/context.js';
import { SetupScreen } from './setup-screen.js';

afterEach(async () => { await closeDbForTests(); });

describe('SetupScreen', () => {
  it('pairs via pasted payload', async () => {
    const transport = new FakeTransport();
    render(
      <TransportProvider makeTransport={() => transport}>
        <SetupScreen />
      </TransportProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /enter code manually/i }));
    await user.type(
      screen.getByRole('textbox'),
      JSON.stringify({ v: 1, instanceUrl: 'ws://h:1/', transport: 'ws', token: 'tok' }).replaceAll('{', '{{').replaceAll('[', '[['),
    );
    const submit = screen.getByRole('button', { name: /pair/i });
    await user.click(submit);
    transport.grant(createEnvelope('pair.grant', {
      from: 'system', to: 'user:u1', channel: 'pairing',
      payload: { sessionToken: 's1', userId: 'u1', instance: 'echo', channels: ['coordinator'] },
    }));
    await waitFor(() => expect(transport.connected).toBe(true));
  });

  it('shows an error for malformed payloads', async () => {
    render(
      <TransportProvider makeTransport={() => new FakeTransport()}>
        <SetupScreen />
      </TransportProvider>,
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: /enter code manually/i }));
    await user.type(screen.getByRole('textbox'), 'not json');
    await user.click(screen.getByRole('button', { name: /pair/i }));
    expect(await screen.findByText(/could not read/i)).toBeTruthy();
  });
});
