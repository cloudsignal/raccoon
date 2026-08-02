// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createEnvelope } from '@raccoon/protocol';
import { closeDbForTests } from '../lib/idb.js';
import { savePairings } from '../lib/session.js';
import { FakeTransport } from '../transport/fake.js';
import type { MakeTransport } from '../transport/types.js';
import { TransportProvider } from '../transport/context.js';
import { ToastHost } from './ui/primitives.js';
import { SetupScreen } from './setup-screen.js';

const P1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';

afterEach(async () => {
  vi.useRealTimers();
  await closeDbForTests();
});

/** userEvent.type treats { and [ as key-descriptor openers — escape them. */
function typable(payload: object): string {
  return JSON.stringify(payload).replaceAll('{', '{{').replaceAll('[', '[[');
}

const PAYLOAD = typable({ v: 1, instanceUrl: 'ws://h:1/', transport: 'ws', token: 'tok' });

function mount(makeTransport: MakeTransport) {
  render(
    <TransportProvider makeTransport={makeTransport}>
      <SetupScreen />
      <ToastHost />
    </TransportProvider>,
  );
}

/** First-run CTA → scan screen (jsdom has no camera, so the paste fallback is
 *  the drive) → paste the payload and submit. */
async function pasteAndConnect(user: ReturnType<typeof userEvent.setup>, payload = PAYLOAD) {
  await user.click(await screen.findByRole('button', { name: /scan qr code/i }));
  await user.type(await screen.findByPlaceholderText(/paste the pairing code/i), payload);
  await user.click(screen.getByRole('button', { name: /^connect$/i }));
}

describe('SetupScreen (first-run)', () => {
  it('renders the first-run copy and routes the CTA into the pairing flow', async () => {
    mount(() => new FakeTransport());
    expect(await screen.findByText('Pair your first platform')).toBeTruthy();
    expect(screen.getByText(/chats stay on this device/i)).toBeTruthy();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: /scan qr code/i }));
    expect(await screen.findByPlaceholderText(/paste the pairing code/i)).toBeTruthy();
    // Back returns to the first-run intro.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('Pair your first platform')).toBeTruthy();
  });

  it('shows an inline error and stays on the scan screen for malformed payloads', async () => {
    mount(() => new FakeTransport());
    await pasteAndConnect(userEvent.setup(), 'not json');
    expect(await screen.findByText(/could not read/i)).toBeTruthy();
    // Recoverable in place — the paste form is still there.
    expect(screen.getByPlaceholderText(/paste the pairing code/i)).toBeTruthy();
  });
});

describe('pairing flow states', () => {
  it('pairs via a pasted code: connecting, then the success screen with granted agents', async () => {
    const t = new FakeTransport();
    mount((opts) => { t.onAdoptGrant = opts.onAdoptGrant; return t; });
    await pasteAndConnect(userEvent.setup());
    // Submitting shows the connecting state until the platform accepts.
    expect(await screen.findByText('Connecting…')).toBeTruthy();
    expect(screen.getByText(/waiting for the platform to accept/i)).toBeTruthy();
    await act(async () => {
      await t.grant(createEnvelope('pair.grant', {
        from: 'system', to: 'user:u1', channel: 'pairing',
        payload: { sessionToken: 's1', userId: 'u1', instance: 'echo', channels: ['coordinator', 'scout'] },
      }));
    });
    // Success: assigned accent mark + granted agent names from the stored pairing.
    expect(await screen.findByText('Connected · echo')).toBeTruthy();
    expect(screen.getByText(/2 agents granted — Coordinator, Scout/)).toBeTruthy();
    expect(screen.getByTestId('platform-mark')).toBeTruthy();
    expect(screen.getByRole('button', { name: /open chats/i })).toBeTruthy();
  });

  it('reports a re-scan of an existing platform as reconnected — name, color and history kept', async () => {
    const tBoot = new FakeTransport();
    const tPair = new FakeTransport();
    await savePairings([{
      url: 'ws://h:1/', sessionToken: 'ta', userId: 'u1', instance: 'echo',
      channels: ['coordinator'], epoch: 'ea', pairingId: P1, transportKind: 'ws',
      displayName: 'Home rig',
    }]);
    mount((opts) => {
      if (opts.pairingToken) { tPair.onAdoptGrant = opts.onAdoptGrant; return tPair; }
      return tBoot;
    });
    await pasteAndConnect(userEvent.setup());
    await act(async () => {
      await tPair.grant(createEnvelope('pair.grant', {
        from: 'system', to: 'user:u1', channel: 'pairing',
        payload: { sessionToken: 's2', userId: 'u1', instance: 'echo', channels: ['coordinator'] },
      }));
    });
    // The dup-guard refreshed in place — the local rename survives.
    expect(await screen.findByText('Reconnected Home rig')).toBeTruthy();
    expect(screen.getByText(/refreshed instead of duplicated/i)).toBeTruthy();
    expect(screen.getByText(/name, color and history kept/i)).toBeTruthy();
    // Done pushes the reconnect toast (fake timers for the ~2.8s auto-dismiss).
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('button', { name: /^done$/i }));
    expect(screen.getByText('Reconnected Home rig')).toBeTruthy(); // now the toast
    await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
    expect(screen.queryByText('Reconnected Home rig')).toBeNull();
  });

  it('shows the expired screen on a rejected token and recovers via Try again', async () => {
    const t = new FakeTransport();
    mount((opts) => { t.onAdoptGrant = opts.onAdoptGrant; return t; });
    const user = userEvent.setup();
    await pasteAndConnect(user);
    act(() => t.authFail(4401));
    expect(await screen.findByText('Pairing code expired')).toBeTruthy();
    expect(screen.getByText(/generate a fresh one/i)).toBeTruthy();
    // Recoverable — Try again returns to the scan screen.
    await user.click(screen.getByRole('button', { name: /try again/i }));
    expect(await screen.findByPlaceholderText(/paste the pairing code/i)).toBeTruthy();
  });

  it('explains an unsupported platform type and offers scanning a different code', async () => {
    mount(() => new FakeTransport());
    const user = userEvent.setup();
    await pasteAndConnect(user, typable({ v: 1, instanceUrl: 'x://h/', transport: 'exotic', token: 'tok' }));
    expect(await screen.findByText('Platform type not supported')).toBeTruthy();
    // README decision 13: paired elsewhere, it still shows up here read-only.
    expect(screen.getByText(/read-only/i)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: /scan a different code/i }));
    expect(await screen.findByPlaceholderText(/paste the pairing code/i)).toBeTruthy();
  });
});
