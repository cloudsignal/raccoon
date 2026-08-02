// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { closeDbForTests } from '../lib/idb.js';
import { savePairings } from '../lib/session.js';
import type { PairedSession } from '../lib/session.js';
import { FakeTransport } from '../transport/fake.js';
import { TransportProvider } from '../transport/context.js';
import { SettingsSheet } from './settings-sheet.js';

const P1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

const pairingA: PairedSession = {
  url: 'ws://a/', sessionToken: 'ta', userId: 'u1', instance: 'alpha',
  channels: ['coordinator'], epoch: 'ea', pairingId: P1, transportKind: 'ws',
};

afterEach(async () => { await closeDbForTests(); });

describe('SettingsSheet', () => {
  it('keeps the build line and the settings-extra slot — pairing and platform management live on their own screens', async () => {
    await savePairings([pairingA]);
    render(
      <TransportProvider makeTransport={() => new FakeTransport()}>
        <SettingsSheet open onClose={() => {}} />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getByText(/^build /)).toBeTruthy());
    expect(document.getElementById('settings-extra')).toBeTruthy();
    // No platform rows (Task 10 moved them to the Platforms screen) and no
    // Add-platform seam (Task 11 moved pairing to the pushed flow screen).
    expect(screen.queryAllByTestId('platform-row')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: 'Add platform' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Unpair alpha' })).toBeNull();
  });
});
