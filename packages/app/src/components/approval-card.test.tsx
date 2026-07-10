// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createEnvelope, type Envelope } from '@raccoon/protocol';
import { closeDbForTests } from '../lib/idb.js';
import { saveSession } from '../lib/session.js';
import { FakeTransport } from '../transport/fake.js';
import { TransportProvider } from '../transport/context.js';
import { Thread } from './thread.js';

afterEach(async () => { await closeDbForTests(); });

const approvalEnv = (): Envelope<'approval.request'> => createEnvelope('approval.request', {
  from: 'agent:assistant', to: 'user:u1', channel: 'coordinator',
  payload: {
    refId: 'task-9',
    title: 'Assistant · draft reply',
    description: 'We run Raccoon next to Mosquitto in our lab.',
    options: ['approve', 'edit', 'skip'],
  },
});

async function mount() {
  const transport = new FakeTransport();
  await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'] });
  render(
    <TransportProvider makeTransport={() => transport}>
      <Thread channel="coordinator" />
    </TransportProvider>,
  );
  await waitFor(() => expect(transport.connected).toBe(true));
  act(() => { transport.emit(approvalEnv()); });
  await screen.findByText('Assistant · draft reply');
  return transport;
}

describe('ApprovalCard', () => {
  it('renders title, draft body, and option buttons', async () => {
    await mount();
    expect(screen.getByText(/We run Raccoon/)).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Edit' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Skip' })).toBeTruthy();
  });

  it('sends approval.response on approve and collapses to a status line', async () => {
    const transport = await mount();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Approve' }));
    await waitFor(() => {
      const sent = transport.sent.find((e) => e.kind === 'approval.response');
      expect(sent && sent.kind === 'approval.response' && sent.payload).toMatchObject({ refId: 'task-9', choice: 'approve' });
    });
    expect(await screen.findByText(/responded: approve/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
  });

  it('edit opens an inline editor and sends editedText', async () => {
    const transport = await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const box = await screen.findByRole('textbox');
    await user.clear(box);
    await user.type(box, 'Better draft');
    await user.click(screen.getByRole('button', { name: /send edit/i }));
    await waitFor(() => {
      const sent = transport.sent.find((e) => e.kind === 'approval.response');
      expect(sent && sent.kind === 'approval.response' && sent.payload).toMatchObject({
        refId: 'task-9', choice: 'edit', editedText: 'Better draft',
      });
    });
  });
});
