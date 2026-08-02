// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { appConfig } from '../config.js';
import { closeDbForTests } from '../lib/idb.js';
import { loadPairingsRaw, savePairings } from '../lib/session.js';
import type { PairedSession } from '../lib/session.js';
import { FakeTransport } from '../transport/fake.js';
import type { MakeTransport } from '../transport/types.js';
import { TransportProvider } from '../transport/context.js';
import { PlatformDetail } from './platform-detail.js';
import { ToastHost } from './ui/primitives.js';

const P1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const COLOR_A = 'rgb(10, 20, 30)';

const pairingA: PairedSession = {
  url: 'ws://a/', sessionToken: 'ta', userId: 'u1', instance: 'alpha',
  channels: ['coordinator', 'echo'], epoch: 'ea', pairingId: P1, transportKind: 'ws', color: COLOR_A,
};

afterEach(async () => {
  vi.useRealTimers();
  delete appConfig.platformBranding;
  await closeDbForTests();
});

async function mountDetail(list: PairedSession[], makeTransport: MakeTransport, onBack = () => {}) {
  await savePairings(list);
  render(
    <TransportProvider makeTransport={makeTransport}>
      <PlatformDetail pairingId={P1} onBack={onBack} />
      <ToastHost />
    </TransportProvider>,
  );
  await waitFor(() => expect(screen.getByText('You')).toBeTruthy());
}

/** Drain the module-level toast queue so no timer leaks across tests. */
async function drainToasts() {
  vi.useFakeTimers();
  act(() => { vi.advanceTimersByTime(3000); });
  vi.useRealTimers();
}

describe('PlatformDetail identity', () => {
  it('renders the identity rows with monospace values', async () => {
    await mountDetail([pairingA], () => new FakeTransport());
    for (const [key, value] of [
      ['You', 'u1'], ['Address', 'ws://a/'], ['Server name', 'alpha'], ['Transport', 'ws'],
    ] as const) {
      const label = screen.getByText(key);
      const row = label.closest('[data-testid="identity-row"]') as HTMLElement;
      expect(within(row).getByText(value)).toBeTruthy();
    }
  });

  it('marks an unsupported transport in the identity rows', async () => {
    await mountDetail([{ ...pairingA, transportKind: 'ble-mesh' }], () => new FakeTransport());
    expect(screen.getByText('ble-mesh — unsupported')).toBeTruthy();
  });
});

describe('PlatformDetail rename', () => {
  it('commits a rename and clears back to the server name', async () => {
    await mountDetail([pairingA], () => new FakeTransport());
    const user = userEvent.setup();
    const input = screen.getByLabelText('Rename alpha');
    // The server name is the placeholder — clearing falls back to it.
    expect(input.getAttribute('placeholder')).toBe('alpha');
    await user.type(input, 'Alpha Prod{Enter}');
    await waitFor(() => expect(screen.getByLabelText('Rename Alpha Prod')).toBeTruthy());
    const stored = await loadPairingsRaw();
    expect(stored[0]?.displayName).toBe('Alpha Prod');
    // Clearing resets the override.
    await user.clear(screen.getByLabelText('Rename Alpha Prod'));
    await user.tab();
    await waitFor(() => expect(screen.getByLabelText('Rename alpha')).toBeTruthy());
    expect((await loadPairingsRaw())[0]?.displayName).toBeUndefined();
  });
});

describe('PlatformDetail icon picker', () => {
  it('offers the four markers and persists a pick', async () => {
    await mountDetail([pairingA], () => new FakeTransport());
    const user = userEvent.setup();
    for (const name of ['bot', 'server', 'home', 'sparkle']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
    }
    // bot is the default marker.
    expect(screen.getByRole('button', { name: 'bot' }).getAttribute('aria-pressed')).toBe('true');
    await user.click(screen.getByRole('button', { name: 'server' }));
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'server' }).getAttribute('aria-pressed'),
    ).toBe('true'));
    expect((await loadPairingsRaw())[0]?.icon).toBe('server');
  });

  it('hides the picker when the instance has a branding glyph', async () => {
    appConfig.platformBranding = { alpha: { glyph: 'sparkle' } };
    await mountDetail([pairingA], () => new FakeTransport());
    expect(screen.queryByRole('button', { name: 'server' })).toBeNull();
    expect(screen.queryByText(/pick a marker/)).toBeNull();
  });
});

describe('PlatformDetail accent', () => {
  it('offers eight swatches and persists a pick', async () => {
    await mountDetail([pairingA], () => new FakeTransport());
    expect(screen.getAllByTestId('accent-swatch')).toHaveLength(8);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Rust' }));
    await waitFor(() => expect(
      screen.getByRole('button', { name: 'Rust' }).getAttribute('aria-pressed'),
    ).toBe('true'));
    expect((await loadPairingsRaw())[0]?.color).toBe('oklch(0.62 0.14 30)');
  });
});

describe('PlatformDetail agents', () => {
  it('lists granted agents as chips with the count', async () => {
    await mountDetail([pairingA], () => new FakeTransport());
    expect(screen.getByText('Agents · 2')).toBeTruthy();
    expect(screen.getByText('Coordinator')).toBeTruthy();
    expect(screen.getByText('Echo')).toBeTruthy();
  });

  it('rescan bounces the platform transport', async () => {
    const made: FakeTransport[] = [];
    await mountDetail([pairingA], () => { const t = new FakeTransport(); made.push(t); return t; });
    await waitFor(() => expect(made).toHaveLength(1));
    await userEvent.setup().click(screen.getByRole('button', { name: /Rescan/ }));
    // rescanPlatform re-dials through the registered factory.
    await waitFor(() => expect(made).toHaveLength(2));
    await drainToasts();
  });

  it('refuses to rescan while offline', async () => {
    const made: FakeTransport[] = [];
    await mountDetail([pairingA], () => {
      const t = new FakeTransport();
      t.failConnect = made.length === 0;
      made.push(t);
      return t;
    });
    await waitFor(() => expect(screen.getByText(/Offline/)).toBeTruthy());
    await userEvent.setup().click(screen.getByRole('button', { name: /Rescan/ }));
    expect(await screen.findByText('Can’t scan while offline')).toBeTruthy();
    expect(made).toHaveLength(1); // no re-dial happened
    await drainToasts();
  });
});

describe('PlatformDetail unpair', () => {
  it('unpairs via the two-step sheet with the exact copy', async () => {
    await mountDetail([pairingA], () => new FakeTransport());
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Unpair alpha' }));
    // Step two: the sheet names the platform and scopes the deletion locally.
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(
      'Deletes alpha’s chats and queued messages from this phone. The platform itself is untouched and can pair again later.',
    )).toBeTruthy();
    // Cancel walks it back without unpairing.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect((await loadPairingsRaw())).toHaveLength(1);
    // Confirm unpairs.
    await user.click(screen.getByRole('button', { name: 'Unpair alpha' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unpair' }));
    await waitFor(async () => expect(await loadPairingsRaw()).toHaveLength(0));
    // The durable removal above is unpair()'s HOISTED clear — the async tail
    // (bounded cleanups + the per-pairing IDB slice wipe) is still in flight
    // behind it, fired as `void unpair(...)` with nothing awaiting it. Wait
    // for the detail view to leave the tree (it renders null only AFTER the
    // awaited wipe + refreshViews) so afterEach's closeDbForTests() cannot
    // close IDB under those transactions — that race rejected the void-ed
    // promise post-teardown as an unhandled error.
    await waitFor(() => expect(screen.queryByText('You')).toBeNull());
  });
});

describe('PlatformDetail host-managed mode', () => {
  const hostPairing: PairedSession = { ...pairingA, transportKind: 'host' };

  it('disables rename with the host note and hides the mutations', async () => {
    await mountDetail([hostPairing], () => new FakeTransport());
    const input = screen.getByLabelText('Rename alpha');
    expect((input as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByText('Set by the host application')).toBeTruthy();
    // No icon picker, no accent swatches, no rescan — the detail is read-only.
    expect(screen.queryByRole('button', { name: 'server' })).toBeNull();
    expect(screen.queryAllByTestId('accent-swatch')).toHaveLength(0);
    expect(screen.queryByRole('button', { name: /Rescan/ })).toBeNull();
  });

  it('labels unpair as logout and routes it to unpair()', async () => {
    await mountDetail([hostPairing], () => new FakeTransport());
    const user = userEvent.setup();
    expect(screen.queryByRole('button', { name: 'Unpair alpha' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Log out' }));
    const dialog = screen.getByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Log out' }));
    await waitFor(async () => expect(await loadPairingsRaw()).toHaveLength(0));
    // Same teardown discipline as the unpair test above: wait out the async
    // unpair tail before afterEach closes IDB.
    await waitFor(() => expect(screen.queryByText('You')).toBeNull());
  });
});
