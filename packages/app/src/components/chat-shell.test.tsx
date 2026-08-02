// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createEnvelope } from '@raccoon/protocol';
import { appConfig } from '../config.js';
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
  vi.useRealTimers();
  delete appConfig.listLayout;
  delete appConfig.mergedSuffix;
  await closeDbForTests();
  window.history.replaceState(null, '', '/');
});

/** Advance fake timers in small steps so fake-indexeddb's (faked) setImmediate
 *  scheduling and chained promise continuations both get to run. */
async function flushFake(ms: number) {
  await act(async () => {
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(ms / 20);
  });
}

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

  it('unpairs from the platform detail screen', async () => {
    await mount();
    const user = userEvent.setup();
    // Gear → Platforms → the platform's detail → destructive unpair (two-step
    // sheet). displayName defaults to the instance name ('i').
    await user.click(screen.getByRole('button', { name: 'Platforms' }));
    await user.click(await screen.findByTestId('platform-row'));
    await user.click(await screen.findByRole('button', { name: 'Unpair i' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Unpair' }));
    // Last pairing gone — back to first-run setup.
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
  // The merged flat list is the opt-in variant since the grouped layout became
  // the default — force it for this suite (reset in the global afterEach).
  beforeEach(() => { appConfig.listLayout = 'merged'; });

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
    // defaults to the pairing's instance name). The merged list row carries
    // the collision suffix too, so expect BOTH: row + thread header.
    await waitFor(() => expect(screen.getAllByText('· beta')).toHaveLength(2));
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
    // displayName defaults to the instance name ('i') — no `· i` suffix
    // anywhere (the footer meta's `·` is not an instance suffix).
    expect(screen.queryByText('· i')).toBeNull();
  });

  it('suffixes only colliding channel names with the platform name (collision policy)', async () => {
    await mountTwo(); // both pairings expose 'coordinator'; scout/echo are A-only
    const rows = screen.getAllByTestId('conv-row').map((b) => b.textContent ?? '');
    expect(rows.some((t) => t.includes('Coordinator · alpha'))).toBe(true);
    expect(rows.some((t) => t.includes('Coordinator · beta'))).toBe(true);
    // Non-colliding channels stay bare.
    expect(rows.some((t) => t.includes('Echo ·'))).toBe(false);
    expect(rows.some((t) => t.includes('Scout ·'))).toBe(false);
  });

  it('never suffixes under the badge policy (dot only)', async () => {
    appConfig.mergedSuffix = 'badge';
    await mountTwo();
    const rows = screen.getAllByTestId('conv-row').map((b) => b.textContent ?? '');
    expect(rows.some((t) => t.includes('Coordinator ·'))).toBe(false);
    expect(screen.getAllByTestId('pairing-badge')).toHaveLength(4);
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
    // B/coordinator's thread is open — its header settings entry proves the
    // open (the '· beta' text alone is ambiguous: the merged list row carries
    // the collision suffix too).
    expect(await screen.findByRole('button', { name: /open settings/i })).toBeTruthy();
    expect(screen.getAllByText('· beta').length).toBeGreaterThanOrEqual(1);
  });

  it('stays on the merged list when the tap-routing params match no pairing', async () => {
    // An instance this install no longer pairs with (or an old hub's payload).
    window.history.replaceState(null, '', `/?pi=${encodeURIComponent('wss://gone.example/')}&pu=u9&pc=coordinator`);
    await mountTwo(); // waits for the merged list's two Coordinator rows
    // No thread header mounted — list only.
    expect(screen.queryByRole('button', { name: /open settings/i })).toBeNull();
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

describe('grouped conversation list (default)', () => {
  it('groups by platform in stored pairings order with in-group recency', async () => {
    const { tA, tB } = await mountTwo();
    act(() => {
      tA.emit(msgAt('coordinator', 'u1', 'from A', '2026-01-01T00:00:01.000Z'));
      tA.emit(msgAt('scout', 'u1', 'scout latest', '2026-01-01T00:00:03.000Z'));
      // B holds the globally newest message — stored pairing order still wins.
      tB.emit(msgAt('coordinator', 'u2', 'from B', '2026-01-01T00:00:05.000Z'));
    });
    await screen.findByText('from B');
    // Group headers are labels, not buttons — no drill-down.
    expect(screen.getByText('alpha').closest('button')).toBeNull();
    expect(screen.getByText('beta').closest('button')).toBeNull();
    // All of alpha's rows precede beta's row; within alpha, recency first,
    // message-less rows last.
    const rows = screen.getAllByTestId('conv-row').map((b) => b.textContent ?? '');
    const idx = (s: string) => rows.findIndex((t) => t.includes(s));
    expect(idx('scout latest')).toBeGreaterThanOrEqual(0);
    expect(idx('scout latest')).toBeLessThan(idx('from A'));
    expect(idx('from A')).toBeLessThan(idx('Echo'));
    expect(idx('Echo')).toBeLessThan(idx('from B'));
    // Grouped rows carry no per-row accent badge (that is the merged cue) and
    // no instance suffix.
    expect(screen.queryAllByTestId('pairing-badge')).toHaveLength(0);
    expect(rows.some((t) => t.includes('Coordinator ·'))).toBe(false);
  });

  it('discriminates duplicate platform display names by instance in the group header', async () => {
    const tA = new FakeTransport();
    const tB = new FakeTransport();
    await savePairings([
      { url: 'ws://a/', sessionToken: 'ta', userId: 'u1', instance: 'alpha', channels: ['coordinator'], epoch: 'ea', pairingId: P1, transportKind: 'ws', displayName: 'studio' },
      { url: 'ws://b/', sessionToken: 'tb', userId: 'u2', instance: 'beta', channels: ['coordinator'], epoch: 'eb', pairingId: P2, transportKind: 'ws', displayName: 'studio' },
    ]);
    render(
      <TransportProvider makeTransport={(opts) => (opts.url === 'ws://a/' ? tA : tB)}>
        <App />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getAllByText('Coordinator')).toHaveLength(2));
    expect(screen.getByText('studio · alpha')).toBeTruthy();
    expect(screen.getByText('studio · beta')).toBeTruthy();
  });

  it('marks a newly granted agent NEW and clears the mark on open', async () => {
    const transport = await mount();
    vi.useFakeTimers();
    act(() => { transport.emitSessionMeta({ instance: 'i', channels: ['coordinator', 'echo', 'courier'] }); });
    await flushFake(200);
    expect(screen.getByText('NEW')).toBeTruthy();
    expect(screen.getByText('Now')).toBeTruthy();
    // Row subtitle names the granting platform (displayName defaults to the
    // instance name 'i'); the grant also pushed a toast with the same copy.
    expect(screen.getAllByText('New agent granted on i').length).toBeGreaterThanOrEqual(1);
    // Drain the toast queue before interacting (auto-dismiss ~2.8s).
    await flushFake(3000);
    fireEvent.click(screen.getByText('Courier'));
    await flushFake(200);
    expect(screen.queryByText('NEW')).toBeNull();
    expect(screen.queryByText('New agent granted on i')).toBeNull();
  });

  it('shows the platforms/agents footer meta with correct pluralization', async () => {
    await mountTwo();
    expect(screen.getByText('2 platforms · 4 agents')).toBeTruthy();
    cleanup();
    await closeDbForTests();
    await mount();
    expect(screen.getByText('1 platform · 2 agents')).toBeTruthy();
  });

  it('offers add-platform and platforms entries; "+" hides for host-managed installs', async () => {
    await mount();
    expect(screen.getByRole('button', { name: 'Platforms' })).toBeTruthy();
    // "+" opens the settings sheet with the Add-platform panel expanded (the
    // Task 11 pairing screen will take this seam over).
    await userEvent.setup().click(screen.getByRole('button', { name: 'Add platform' }));
    expect(await screen.findByText('Settings')).toBeTruthy();
    expect(screen.getByText('Enter code manually')).toBeTruthy(); // PairPanel is open
    cleanup();
    await closeDbForTests();
    // A host-managed pairing owns identity — never offer "Add platform".
    await savePairings([{ url: 'ws://h/', sessionToken: 't', userId: 'u1', instance: 'hosted', channels: ['coordinator'], epoch: 'e1', pairingId: P1, transportKind: 'host' }]);
    render(
      <TransportProvider makeTransport={() => new FakeTransport()}>
        <App />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getByText('Coordinator')).toBeTruthy());
    expect(screen.queryByRole('button', { name: 'Add platform' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Platforms' })).toBeTruthy();
  });
});

describe('platform event toasts', () => {
  it('toasts a new-agent grant and auto-dismisses it', async () => {
    const transport = await mount();
    vi.useFakeTimers();
    act(() => { transport.emitSessionMeta({ instance: 'i', channels: ['coordinator', 'echo', 'courier'] }); });
    await flushFake(200);
    // Two occurrences: the toast plus the NEW row's subtitle.
    expect(screen.getAllByText('New agent granted on i')).toHaveLength(2);
    // Past the ~2.8s auto-dismiss only the row subtitle remains.
    await flushFake(3000);
    expect(screen.getAllByText('New agent granted on i')).toHaveLength(1);
  });
});

describe('platforms navigation (push stack)', () => {
  it('gear pushes Platforms, rows drill into detail, back pops in order', async () => {
    await mountTwo();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'Platforms' }));
    // Platforms screen: one row per pairing.
    expect(await screen.findByText('u1 on alpha · Connected')).toBeTruthy();
    expect(screen.getAllByTestId('platform-row')).toHaveLength(2);
    // Drill into beta's detail — identity rows replace the list (only the
    // top of the stack renders).
    await user.click(screen.getAllByTestId('platform-row')[1]!);
    expect(await screen.findByText('You')).toBeTruthy();
    expect(screen.getByText('u2')).toBeTruthy();
    expect(screen.queryByText('u1 on alpha · Connected')).toBeNull();
    // Back pops to Platforms...
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(await screen.findByText('u1 on alpha · Connected')).toBeTruthy();
    expect(screen.queryByText('You')).toBeNull();
    // ...and again to the chat list.
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await waitFor(() => expect(screen.queryAllByTestId('platform-row')).toHaveLength(0));
    expect(screen.getByText('2 platforms · 4 agents')).toBeTruthy();
  });

  it('surfaces the revoke banner on Platforms, instance-discriminated on a name collision', async () => {
    // Two pairings sharing the display name — the banner must say WHICH one.
    const tA = new FakeTransport();
    const tB = new FakeTransport();
    await savePairings([
      { url: 'ws://a/', sessionToken: 'ta', userId: 'u1', instance: 'alpha', displayName: 'Studio', channels: ['coordinator'], epoch: 'ea', pairingId: P1, transportKind: 'ws' },
      { url: 'ws://b/', sessionToken: 'tb', userId: 'u2', instance: 'beta', displayName: 'Studio', channels: ['coordinator'], epoch: 'eb', pairingId: P2, transportKind: 'ws' },
    ]);
    render(
      <TransportProvider makeTransport={(opts) => (opts.url === 'ws://a/' ? tA : tB)}>
        <App />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getAllByText('Coordinator')).toHaveLength(2));
    vi.useFakeTimers();
    // The server terminally revokes B.
    act(() => { tB.authFail(4403); });
    await flushFake(500);
    // Drain the revoked toast so only the banner carries the copy below.
    await flushFake(3000);
    fireEvent.click(screen.getByRole('button', { name: 'Platforms' }));
    await flushFake(200);
    expect(screen.getByText(
      'Studio · beta was disconnected by its owner — everything else keeps running.',
    )).toBeTruthy();
    // Dismissible.
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText(/disconnected by its owner/)).toBeNull();
  });
});
