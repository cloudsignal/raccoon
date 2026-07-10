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

  it('a server-side failed ack re-enables retry, and tapping it re-sends the same decision (#R6-2)', async () => {
    const transport = await mount();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Edit' }));
    const box = await screen.findByRole('textbox');
    await user.clear(box);
    await user.type(box, 'Better draft');
    await user.click(screen.getByRole('button', { name: /send edit/i }));
    let first: Envelope<'approval.response'> | undefined;
    await waitFor(() => {
      first = transport.sent.find((e) => e.kind === 'approval.response') as Envelope<'approval.response'> | undefined;
      expect(first).toBeTruthy();
    });

    // The server received the response (settles the outbox row)… then its
    // approval turn failed terminally, surfaced as a second, FAILED ack.
    const ackWith = (status: 'received' | 'failed') => createEnvelope('ack', {
      from: 'agent:assistant', to: 'user:u1', channel: 'coordinator',
      payload: { refId: first!.id, status },
    });
    act(() => { transport.emit(ackWith('received')); });
    act(() => { transport.emit(ackWith('failed')); });

    // The card must come back out of "Responded" into a retry affordance —
    // without this, the user was shown success forever while the server had
    // dropped their decision.
    const retry = await screen.findByRole('button', { name: /tap to retry/i });
    await user.click(retry);

    // The retry re-sends the SAME decision as a FRESH envelope (the old
    // outbox row was settled by the received ack and cannot be revived).
    await waitFor(() => {
      const responses = transport.sent.filter((e) => e.kind === 'approval.response');
      expect(responses).toHaveLength(2);
      const second = responses[1]!;
      expect(second.id).not.toBe(first!.id);
      if (second.kind === 'approval.response') {
        expect(second.payload).toMatchObject({ refId: 'task-9', choice: 'edit', editedText: 'Better draft' });
      }
    });
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
