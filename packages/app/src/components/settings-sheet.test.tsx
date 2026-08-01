// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render, screen, waitFor, within } from '@testing-library/react';
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
const P2 = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const COLOR_A = 'rgb(10, 20, 30)';
const COLOR_B = 'rgb(40, 50, 60)';

const pairingA: PairedSession = {
  url: 'ws://a/', sessionToken: 'ta', userId: 'u1', instance: 'alpha',
  channels: ['coordinator'], epoch: 'ea', pairingId: P1, transportKind: 'ws', color: COLOR_A,
};
const pairingB: PairedSession = {
  url: 'ws://b/', sessionToken: 'tb', userId: 'u2', instance: 'beta',
  channels: ['coordinator'], epoch: 'eb', pairingId: P2, transportKind: 'ws', color: COLOR_B,
};

afterEach(async () => { await closeDbForTests(); });

async function mountSheet(list: PairedSession[], makeTransport: MakeTransport) {
  await savePairings(list);
  render(
    <TransportProvider makeTransport={makeTransport}>
      <SettingsSheet open onClose={() => {}} />
    </TransportProvider>,
  );
  await waitFor(() => expect(screen.getAllByTestId('platform-row')).toHaveLength(list.length));
}

function rowFor(name: string): HTMLElement {
  const input = screen.getByLabelText(`Rename ${name}`);
  const row = input.closest('[data-testid="platform-row"]');
  if (!row) throw new Error(`no platform row for ${name}`);
  return row as HTMLElement;
}

describe('SettingsSheet platforms', () => {
  it('lists each pairing with name, instance, status, and accent', async () => {
    const tA = new FakeTransport();
    const tB = new FakeTransport();
    await mountSheet([pairingA, pairingB], (opts) => (opts.url === 'ws://a/' ? tA : tB));
    // Name (the rename input carries the display name) + userId/instance line.
    expect(screen.getByLabelText('Rename alpha')).toBeTruthy();
    expect(screen.getByLabelText('Rename beta')).toBeTruthy();
    expect(screen.getByText('u1 on alpha')).toBeTruthy();
    expect(screen.getByText('u2 on beta')).toBeTruthy();
    // Accent dots carry each pairing's color.
    const accents = screen.getAllByTestId('platform-accent')
      .map((el) => (el as HTMLElement).style.backgroundColor);
    expect(accents).toContain(COLOR_A);
    expect(accents).toContain(COLOR_B);
    // Status text covers every TransportStatus member: both open at boot ...
    await waitFor(() => expect(within(rowFor('beta')).getByText('connected')).toBeTruthy());
    // ... 'connecting' while B redials ...
    act(() => tB.setStatus('connecting'));
    await waitFor(() => expect(within(rowFor('beta')).getByText('connecting')).toBeTruthy());
    // ... and 'closed' reads as offline. A is untouched throughout.
    act(() => tB.setStatus('closed'));
    await waitFor(() => expect(within(rowFor('beta')).getByText('offline')).toBeTruthy());
    expect(within(rowFor('alpha')).getByText('connected')).toBeTruthy();
  });

  it('rename commits via renamePairing on blur/submit', async () => {
    await mountSheet([pairingA, pairingB], () => new FakeTransport());
    const user = userEvent.setup();
    // Enter commits.
    const inputA = screen.getByLabelText('Rename alpha');
    await user.clear(inputA);
    await user.type(inputA, 'Alpha Prod{Enter}');
    await waitFor(() => expect(screen.getByLabelText('Rename Alpha Prod')).toBeTruthy());
    // Blur commits.
    const inputB = screen.getByLabelText('Rename beta');
    await user.clear(inputB);
    await user.type(inputB, 'Beta Lab');
    await user.tab();
    await waitFor(() => expect(screen.getByLabelText('Rename Beta Lab')).toBeTruthy());
    // Clearing the field falls back to the instance-name default.
    const renamed = screen.getByLabelText('Rename Alpha Prod');
    await user.clear(renamed);
    await user.tab();
    await waitFor(() => expect(screen.getByLabelText('Rename alpha')).toBeTruthy());
  });

  it('unpair asks for confirmation and calls unpair(pairingId)', async () => {
    await mountSheet([pairingA, pairingB], () => new FakeTransport());
    const user = userEvent.setup();
    // Step one arms the row-local confirm; nothing is unpaired yet.
    await user.click(screen.getByRole('button', { name: 'Unpair alpha' }));
    expect(screen.getByText('Unpair this platform?')).toBeTruthy();
    expect(screen.getAllByTestId('platform-row')).toHaveLength(2);
    // Cancel walks it back.
    await user.click(within(rowFor('alpha')).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByText('Unpair this platform?')).toBeNull();
    expect(screen.getAllByTestId('platform-row')).toHaveLength(2);
    // Confirm unpairs ONLY that pairing.
    await user.click(screen.getByRole('button', { name: 'Unpair alpha' }));
    await user.click(within(rowFor('alpha')).getByRole('button', { name: 'Unpair' }));
    await waitFor(() => expect(screen.getAllByTestId('platform-row')).toHaveLength(1));
    expect(screen.getByText('u2 on beta')).toBeTruthy();
    expect(screen.queryByText('u1 on alpha')).toBeNull();
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
    // Panel closed, new pairing listed, Add platform is offered again.
    await waitFor(() => expect(screen.getAllByTestId('platform-row')).toHaveLength(2));
    await waitFor(() => expect(screen.queryByPlaceholderText(/paste the pairing code/i)).toBeNull());
    expect(screen.getByText('u2 on beta')).toBeTruthy();
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
    expect(screen.getAllByTestId('platform-row')).toHaveLength(1);
    // Still in panel mode: the Add platform button has not returned.
    expect(screen.queryByRole('button', { name: 'Add platform' })).toBeNull();
    // The user can retry: the Pair button is re-enabled after the failure.
    await waitFor(() => expect(
      (screen.getByRole('button', { name: /^pair$/i }) as HTMLButtonElement).disabled,
    ).toBe(false));
  });

  it('hides Add platform when the single pairing is host-managed (transportKind "host")', async () => {
    // A stored pairing whose kind has no registered factory stays listed but
    // offline — exactly the host-managed shape the sheet must not offer
    // "Add platform" next to.
    await mountSheet(
      [{ ...pairingA, transportKind: 'host' }],
      () => new FakeTransport(),
    );
    expect(screen.getByText('u1 on alpha')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add platform' })).toBeNull();
  });

  it('shows a host-managed pairing name as plain text with no rename textbox', async () => {
    // Rename patches the stored pairings list, but a host-managed session has
    // no stored entry (updatePairingMeta finds nothing and the edit reverts) —
    // so the row must render the name read-only instead of a silently
    // no-opping input.
    await mountSheet([{ ...pairingA, transportKind: 'host' }], () => new FakeTransport());
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.queryByLabelText('Rename alpha')).toBeNull();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});
