// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createEnvelope } from '@raccoon/protocol';
import { closeDbForTests } from '../lib/idb.js';
import * as outbox from '../lib/outbox.js';
import { savePairings } from '../lib/session.js';
import type { PairedSession } from '../lib/session.js';
import { FakeTransport } from '../transport/fake.js';
import type { MakeTransport } from '../transport/types.js';
import { TransportProvider } from '../transport/context.js';
import { PlatformsScreen } from './platforms-screen.js';

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

interface MountOpts {
  onBack?: () => void;
  onOpenDetail?: (pairingId: string) => void;
  onAddPlatform?: () => void;
  revokeNotice?: string | null;
  onDismissRevoke?: () => void;
}

async function mountScreen(list: PairedSession[], makeTransport: MakeTransport, opts: MountOpts = {}) {
  await savePairings(list);
  render(
    <TransportProvider makeTransport={makeTransport}>
      <PlatformsScreen
        onBack={opts.onBack ?? (() => {})}
        onOpenDetail={opts.onOpenDetail ?? (() => {})}
        onAddPlatform={opts.onAddPlatform ?? (() => {})}
        revokeNotice={opts.revokeNotice ?? null}
        onDismissRevoke={opts.onDismissRevoke ?? (() => {})}
      />
    </TransportProvider>,
  );
  await waitFor(() => expect(screen.getAllByTestId('platform-row')).toHaveLength(list.length));
}

function rowFor(name: string): HTMLElement {
  const el = screen.getAllByTestId('platform-row')
    .find((r) => within(r as HTMLElement).queryByText(name) !== null);
  if (!el) throw new Error(`no platform row for ${name}`);
  return el as HTMLElement;
}

describe('PlatformsScreen rows', () => {
  it('renders one row per pairing: mark, name, subtitle, status dot', async () => {
    const tA = new FakeTransport();
    const tB = new FakeTransport();
    await mountScreen([pairingA, pairingB], (opts) => (opts.url === 'ws://a/' ? tA : tB));
    // Names + subtitle identity segments.
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.getByText('beta')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('u1 on alpha · Connected')).toBeTruthy());
    // 32px platform marks carry each pairing's accent.
    const marks = screen.getAllByTestId('platform-mark');
    expect(marks.some((m) => (m as HTMLElement).style.background.includes(COLOR_A))).toBe(true);
    expect(marks.some((m) => (m as HTMLElement).style.background.includes(COLOR_B))).toBe(true);
    // Per-row status dot follows the pairing's own transport.
    act(() => tB.setStatus('closed'));
    await waitFor(() => expect(screen.getByText('u2 on beta · Offline')).toBeTruthy());
    expect(within(rowFor('beta')).getByTestId('status-dot').getAttribute('data-status')).toBe('closed');
    expect(within(rowFor('alpha')).getByTestId('status-dot').getAttribute('data-status')).toBe('open');
    // One platform being offline never blocks another — the caption says so.
    expect(screen.getByText(/Each platform connects on its own/)).toBeTruthy();
  });

  it('discriminates duplicate display names by instance', async () => {
    await mountScreen(
      [{ ...pairingA, displayName: 'Workspace' }, { ...pairingB, displayName: 'Workspace' }],
      () => new FakeTransport(),
    );
    expect(screen.getByText('· alpha')).toBeTruthy();
    expect(screen.getByText('· beta')).toBeTruthy();
  });

  it('opens the detail on row tap', async () => {
    const onOpenDetail = vi.fn();
    await mountScreen([pairingA], () => new FakeTransport(), { onOpenDetail });
    await userEvent.setup().click(rowFor('alpha'));
    expect(onOpenDetail).toHaveBeenCalledWith(P1);
  });

  it('shows a live queued count for an offline pairing', async () => {
    const tA = new FakeTransport();
    const tB = new FakeTransport();
    tB.failConnect = true; // B never opens — its rows stay queued
    await mountScreen([pairingA, pairingB], (opts) => (opts.url === 'ws://a/' ? tA : tB));
    await waitFor(() => expect(screen.getByText('u2 on beta · Offline')).toBeTruthy());
    // Two queued sends for B's scope surface in the subtitle...
    await act(async () => {
      await outbox.enqueue(createEnvelope('msg', {
        from: 'user:u2', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'one' },
      }), P2);
      await outbox.enqueue(createEnvelope('msg', {
        from: 'user:u2', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'two' },
      }), P2);
    });
    await waitFor(() => expect(screen.getByText('u2 on beta · Offline · 2 queued')).toBeTruthy());
    // ...and the count is live: another enqueue re-derives it via subscribe.
    await act(async () => {
      await outbox.enqueue(createEnvelope('msg', {
        from: 'user:u2', to: 'agent:coordinator', channel: 'coordinator', payload: { text: 'three' },
      }), P2);
    });
    await waitFor(() => expect(screen.getByText('u2 on beta · Offline · 3 queued')).toBeTruthy());
    // The connected pairing shows no queued segment (n = 0).
    expect(screen.getByText('u1 on alpha · Connected')).toBeTruthy();
  });

  it('labels an unsupported-kind pairing as paired elsewhere', async () => {
    await mountScreen(
      [pairingA, { ...pairingB, transportKind: 'ble-mesh' }],
      () => new FakeTransport(),
    );
    await waitFor(() => expect(
      screen.getByText('u2 on beta · Paired elsewhere · can’t connect on this device'),
    ).toBeTruthy());
  });

  it('offers Add platform as a row and a bar action', async () => {
    const onAddPlatform = vi.fn();
    await mountScreen([pairingA], () => new FakeTransport(), { onAddPlatform });
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Add platform' }));
    expect(onAddPlatform).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: '+ Add platform' }));
    expect(onAddPlatform).toHaveBeenCalledTimes(2);
  });
});

describe('PlatformsScreen host-managed mode', () => {
  it('shows the banner and hides every Add-platform entry', async () => {
    await mountScreen([{ ...pairingA, transportKind: 'host' }], () => new FakeTransport());
    expect(screen.getByText('Managed by the host application')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Add platform' })).toBeNull();
    expect(screen.queryByRole('button', { name: '+ Add platform' })).toBeNull();
  });
});

describe('PlatformsScreen remote revoke', () => {
  it('renders the dismissible revoke banner', async () => {
    const onDismissRevoke = vi.fn();
    await mountScreen([pairingA], () => new FakeTransport(), {
      revokeNotice: 'Workspace · delta was disconnected by its owner — everything else keeps running.',
      onDismissRevoke,
    });
    expect(screen.getByText(/Workspace · delta was disconnected by its owner/)).toBeTruthy();
    await userEvent.setup().click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismissRevoke).toHaveBeenCalledTimes(1);
  });

  it('renders no banner without a notice', async () => {
    await mountScreen([pairingA], () => new FakeTransport());
    expect(screen.queryByRole('button', { name: 'Dismiss' })).toBeNull();
  });
});
