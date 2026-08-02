// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createEnvelope } from '@raccoon/protocol';
import { closeDbForTests } from '../lib/idb.js';
import { savePairings } from '../lib/session.js';
import type { PairedSession } from '../lib/session.js';
import { FakeTransport } from '../transport/fake.js';
import type { MakeTransport } from '../transport/types.js';
import { TransportProvider } from '../transport/context.js';
import { SettingsSheet } from './settings-sheet.js';

const P1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const pairingA: PairedSession = {
  url: 'ws://a/', sessionToken: 'ta', userId: 'u1', instance: 'alpha',
  channels: ['coordinator'], epoch: 'ea', pairingId: P1, transportKind: 'ws',
};

afterEach(async () => { await closeDbForTests(); });

async function mountSheet(list: PairedSession[], makeTransport: MakeTransport, startOnAdd = false) {
  await savePairings(list);
  render(
    <TransportProvider makeTransport={makeTransport}>
      <SettingsSheet open onClose={() => {}} startOnAdd={startOnAdd} />
    </TransportProvider>,
  );
  await waitFor(() => expect(screen.getByText(/^build /)).toBeTruthy());
}

describe('SettingsSheet', () => {
  it('keeps the build line and the settings-extra slot — platform management lives on the Platforms screen', async () => {
    await mountSheet([pairingA], () => new FakeTransport());
    expect(screen.getByText(/^build /)).toBeTruthy();
    expect(document.getElementById('settings-extra')).toBeTruthy();
    // No platform rows here anymore (Task 10 moved them out).
    expect(screen.queryAllByTestId('platform-row')).toHaveLength(0);
    expect(screen.queryByLabelText('Rename alpha')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unpair alpha' })).toBeNull();
  });

  it('starts on the Add-platform panel when opened via the startOnAdd seam', async () => {
    await mountSheet([pairingA], () => new FakeTransport(), true);
    expect(await screen.findByRole('button', { name: /enter code manually/i })).toBeTruthy();
  });

  it('Add platform opens PairPanel and closes it on success', async () => {
    const tA = new FakeTransport();
    const tNew = new FakeTransport();
    await mountSheet([pairingA], (opts) => {
      if (opts.url === 'ws://a/') return tA;
      tNew.onAdoptGrant = opts.onAdoptGrant;
      return tNew;
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add platform' }));
    // PairPanel is open (jsdom has no camera, so the scan pane shows its
    // fallback plus the manual-entry switch).
    await user.click(await screen.findByRole('button', { name: /enter code manually/i }));
    await user.type(
      screen.getByPlaceholderText(/paste the pairing code/i),
      JSON.stringify({ v: 1, instanceUrl: 'ws://new/', transport: 'ws', token: 'tok' })
        .replaceAll('{', '{{').replaceAll('[', '[['),
    );
    await user.click(screen.getByRole('button', { name: /^pair$/i }));
    await act(async () => {
      await tNew.grant(createEnvelope('pair.grant', {
        from: 'system', to: 'user:u2', channel: 'pairing',
        payload: { sessionToken: 's2', userId: 'u2', instance: 'beta', channels: ['coordinator'] },
      }));
    });
    // Panel closed; Add platform is offered again.
    await waitFor(() => expect(screen.queryByPlaceholderText(/paste the pairing code/i)).toBeNull());
    expect(screen.getByRole('button', { name: 'Add platform' })).toBeTruthy();
  });

  it('keeps PairPanel open and surfaces the error when pairing is rejected', async () => {
    const tA = new FakeTransport();
    const tNew = new FakeTransport();
    await mountSheet([pairingA], (opts) => {
      if (opts.url === 'ws://a/') return tA;
      tNew.onAdoptGrant = opts.onAdoptGrant;
      return tNew;
    });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add platform' }));
    await user.click(await screen.findByRole('button', { name: /enter code manually/i }));
    await user.type(
      screen.getByPlaceholderText(/paste the pairing code/i),
      JSON.stringify({ v: 1, instanceUrl: 'ws://new/', transport: 'ws', token: 'expired' })
        .replaceAll('{', '{{').replaceAll('[', '[['),
    );
    await user.click(screen.getByRole('button', { name: /^pair$/i }));
    // Server rejects the token (terminal auth failure, not a parse error).
    act(() => tNew.authFail(4401));
    // The panel STAYS open with the rejection surfaced — no silent close.
    expect(await screen.findByText(/pairing was rejected/i)).toBeTruthy();
    expect(screen.getByPlaceholderText(/paste the pairing code/i)).toBeTruthy();
    // Still in panel mode: the Add platform button has not returned.
    expect(screen.queryByRole('button', { name: 'Add platform' })).toBeNull();
    // The user can retry: the Pair button is re-enabled after the failure.
    await waitFor(() => expect(
      (screen.getByRole('button', { name: /^pair$/i }) as HTMLButtonElement).disabled,
    ).toBe(false));
  });

  it('hides Add platform when the single pairing is host-managed (transportKind "host")', async () => {
    await mountSheet(
      [{ ...pairingA, transportKind: 'host' }],
      () => new FakeTransport(),
    );
    // The sheet renders before the provider finishes loading the stored
    // pairings — the host-managed gate applies once they arrive.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Add platform' })).toBeNull());
  });
});
