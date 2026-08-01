// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it } from 'vitest';
import { act } from 'react';
import { createEnvelope } from '@raccoon/protocol';
import { closeDbForTests } from '../lib/idb.js';
import { savePairings } from '../lib/session.js';
import { FakeTransport } from '../transport/fake.js';
import { TransportProvider } from '../transport/context.js';
import { App } from '../app.js';

const P1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const P2 = '01BX5ZZKBKACTAV9WEVGEMMVRZ';
const COLOR_A = 'rgb(10, 20, 30)';
const COLOR_B = 'rgb(40, 50, 60)';

afterEach(async () => {
  await closeDbForTests();
  window.history.replaceState(null, '', '/');
});

async function mount(transport = new FakeTransport()) {
  await savePairings([{ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator', 'echo'], epoch: 'e1', pairingId: P1, transportKind: 'ws' }]);
  render(
    <TransportProvider makeTransport={() => transport}>
      <App />
    </TransportProvider>,
  );
  await waitFor(() => expect(screen.getByText('Coordinator')).toBeTruthy());
  return transport;
}

/** Two-pairing seed: A (alpha, 3 channels) + B (beta, 1 channel), each dialed
 *  by its own FakeTransport (routed by the stored url). */
async function mountTwo() {
  const tA = new FakeTransport();
  const tB = new FakeTransport();
  await savePairings([
    { url: 'ws://a/', sessionToken: 'ta', userId: 'u1', instance: 'alpha', channels: ['coordinator', 'scout', 'echo'], epoch: 'ea', pairingId: P1, transportKind: 'ws', color: COLOR_A },
    { url: 'ws://b/', sessionToken: 'tb', userId: 'u2', instance: 'beta', channels: ['coordinator'], epoch: 'eb', pairingId: P2, transportKind: 'ws', color: COLOR_B },
  ]);
  render(
    <TransportProvider makeTransport={(opts) => (opts.url === 'ws://a/' ? tA : tB)}>
      <App />
    </TransportProvider>,
  );
  await waitFor(() => expect(screen.getAllByText('Coordinator')).toHaveLength(2));
  return { tA, tB };
}

/** A msg envelope with a pinned ts, for deterministic recency ordering. */
function msgAt(channel: string, userId: string, text: string, ts: string) {
  return { ...createEnvelope('msg', {
    from: `agent:${channel}`, to: `user:${userId}`, channel, payload: { text },
  }), ts };
}

describe('chat shell', () => {
  it('renders the adapter-declared channel list from the session', async () => {
    await mount();
    expect(screen.getByText('Coordinator')).toBeTruthy();
    expect(screen.getByText('Echo')).toBeTruthy();
  });

  it('opens a channel, syncs ?c=, and requests history', async () => {
    const transport = await mount();
    await userEvent.setup().click(screen.getByText('Coordinator'));
    await waitFor(() => expect(window.location.search).toBe(`?c=${encodeURIComponent(`${P1}/coordinator`)}`));
    await waitFor(() => expect(transport.sent.some((e) => e.kind === 'history.request')).toBe(true));
  });

  it('shows unread badges for inactive channels', async () => {
    const transport = await mount();
    act(() => {
      transport.emit(createEnvelope('msg', {
        from: 'agent:echo', to: 'user:u1', channel: 'echo', payload: { text: 'ping' },
      }));
    });
    expect(await screen.findByText('1')).toBeTruthy();
    expect(await screen.findByText('ping')).toBeTruthy(); // list preview
  });

  it('unpairs from the settings sheet', async () => {
    await mount();
    const user = userEvent.setup();
    await user.click(screen.getByText('Coordinator'));
    await user.click(await screen.findByRole('button', { name: /open settings/i }));
    // Two-step: arm the row's confirm, then confirm. displayName defaults to
    // the instance name ('i'), so the arm button reads "Unpair i".
    await user.click(await screen.findByRole('button', { name: 'Unpair i' }));
    await user.click(await screen.findByRole('button', { name: 'Unpair' }));
    await waitFor(() => expect(screen.getByText(/pair this device/i)).toBeTruthy());
  });

  it('clears the composer draft when switching channels', async () => {
    const user = userEvent.setup();
    await mount();
    // Open coordinator and type a draft
    await user.click(screen.getByText('Coordinator'));
    const textarea = await screen.findByPlaceholderText(/message coordinator/i);
    await user.type(textarea, 'my draft');
    expect((textarea as HTMLTextAreaElement).value).toBe('my draft');
    // Switch to a different channel — the keyed Composer remounts with empty state
    await user.click(screen.getByText('Echo'));
    const freshTextarea = await screen.findByPlaceholderText(/message echo/i);
    expect((freshTextarea as HTMLTextAreaElement).value).toBe('');
  });
});

describe('merged conversation list', () => {
  it('merges conversations across pairings sorted by recency, newest first', async () => {
    const { tA, tB } = await mountTwo();
    // A/coordinator at T1, B/coordinator at T2 (later); A/echo and A/scout
    // have no messages — they sort last, stable by channel name.
    act(() => {
      tA.emit(msgAt('coordinator', 'u1', 'from A', '2026-01-01T00:00:01.000Z'));
      tB.emit(msgAt('coordinator', 'u2', 'from B', '2026-01-01T00:00:02.000Z'));
    });
    await screen.findByText('from B');
    const rows = screen.getAllByRole('button').map((b) => b.textContent ?? '');
    const idx = (s: string) => rows.findIndex((t) => t.includes(s));
    expect(idx('from B')).toBeGreaterThanOrEqual(0);
    expect(idx('from B')).toBeLessThan(idx('from A'));
    // Message-less rows last, ordered by channel name (echo < scout), NOT by
    // the pairing's channel-array order (which lists scout before echo).
    expect(idx('from A')).toBeLessThan(idx('Echo'));
    expect(idx('Echo')).toBeLessThan(idx('Scout'));
  });

  it('shows the pairing accent badge only when more than one pairing exists', async () => {
    await mountTwo();
    const badges = screen.getAllByTestId('pairing-badge');
    expect(badges).toHaveLength(4); // one per row: 3 for A, 1 for B
    const colors = badges.map((b) => (b as HTMLElement).style.backgroundColor);
    expect(colors.filter((c) => c === COLOR_A)).toHaveLength(3);
    expect(colors.filter((c) => c === COLOR_B)).toHaveLength(1);
    // Single pairing: no badge elements — the single-install look is unchanged.
    cleanup();
    await closeDbForTests();
    await mount();
    expect(screen.queryAllByTestId('pairing-badge')).toHaveLength(0);
  });

  it('shows agent + instance in the chat header and the owning pairing\'s status dot', async () => {
    const { tB } = await mountTwo();
    // Make B/coordinator identifiable (and first) in the merged list.
    act(() => {
      tB.emit(msgAt('coordinator', 'u2', 'from B', '2026-01-01T00:00:02.000Z'));
    });
    await userEvent.setup().click(await screen.findByText('from B'));
    // Title = agent label + muted `· <displayName>` suffix (displayName
    // defaults to the pairing's instance name).
    expect(await screen.findByText('· beta')).toBeTruthy();
    // The online dot reflects the OWNING pairing (B). Both open at boot → dot.
    expect(document.querySelector('.bg-online')).toBeTruthy();
    // B drops → no dot, even though A is still open.
    act(() => tB.setStatus('closed'));
    await waitFor(() => expect(document.querySelector('.bg-online')).toBeNull());
    // B recovers → dot returns.
    act(() => tB.setStatus('open'));
    await waitFor(() => expect(document.querySelector('.bg-online')).toBeTruthy());
  });

  it('omits the instance suffix from the chat header with a single pairing', async () => {
    await mount();
    await userEvent.setup().click(screen.getByText('Coordinator'));
    await screen.findByRole('button', { name: /open settings/i }); // header mounted
    expect(screen.queryByText(/·/)).toBeNull();
  });

  it('opens the conversation named by push tap-routing params (?pi/?pu/?pc)', async () => {
    // The SW's notification click URL carries (instanceUrl, userId, channel);
    // the app resolves them against its pairings and opens that conversation.
    window.history.replaceState(null, '', `/?pi=${encodeURIComponent('ws://b/')}&pu=u2&pc=coordinator`);
    const tA = new FakeTransport();
    const tB = new FakeTransport();
    await savePairings([
      { url: 'ws://a/', sessionToken: 'ta', userId: 'u1', instance: 'alpha', channels: ['coordinator', 'scout', 'echo'], epoch: 'ea', pairingId: P1, transportKind: 'ws', color: COLOR_A },
      { url: 'ws://b/', sessionToken: 'tb', userId: 'u2', instance: 'beta', channels: ['coordinator'], epoch: 'eb', pairingId: P2, transportKind: 'ws', color: COLOR_B },
    ]);
    render(
      <TransportProvider makeTransport={(opts) => (opts.url === 'ws://a/' ? tA : tB)}>
        <App />
      </TransportProvider>,
    );
    // B/coordinator's thread is open: the chat header shows the '· beta'
    // instance suffix (list rows never render it).
    expect(await screen.findByText('· beta')).toBeTruthy();
  });

  it('stays on the merged list when the tap-routing params match no pairing', async () => {
    // An instance this install no longer pairs with (or an old hub's payload).
    window.history.replaceState(null, '', `/?pi=${encodeURIComponent('wss://gone.example/')}&pu=u9&pc=coordinator`);
    await mountTwo(); // waits for the merged list's two Coordinator rows
    expect(screen.queryByText(/·/)).toBeNull(); // no thread header — list only
  });

  it('shows connecting indicator when any pairing is not open', async () => {
    const { tB } = await mountTwo();
    // Both open after boot → indicator absent.
    expect(screen.queryByText('connecting…')).toBeNull();
    // B drops → indicator present even though A is still open.
    act(() => tB.setStatus('closed'));
    expect(await screen.findByText('connecting…')).toBeTruthy();
  });
});
