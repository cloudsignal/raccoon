import { useEffect, useRef, useState } from 'react';
import { useChat } from '../transport/context.js';
import { convKeyOf } from '../lib/conv-key.js';
import { handleSwNavigate } from '../lib/sw-navigate.js';
import { ChannelHeader } from './channel-header.js';
import { ChannelList } from './channel-list.js';
import { Composer } from './composer.js';
import { PlatformDetail } from './platform-detail.js';
import { PlatformsScreen } from './platforms-screen.js';
import { SettingsSheet } from './settings-sheet.js';
import { Thread } from './thread.js';
import { pushToast, ToastHost } from './ui/primitives.js';

/** Pushed screens (README Interactions: push stack, 200ms slide-in). The
 *  chat list/thread is the stack's floor and never an entry. */
type NavEntry = { s: 'platforms' } | { s: 'platform'; id: string };

export function ChatScreen() {
  const { activeChannel, openChannel, pairings, subscribeEvents } = useChat();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // "+" opens the settings sheet directly on its Add-platform panel — the
  // minimal seam until the dedicated pairing screen (Task 11) takes it over.
  const [settingsStartOnAdd, setSettingsStartOnAdd] = useState(false);
  // Platforms / platform-detail push stack (gear → Platforms → detail).
  const [nav, setNav] = useState<NavEntry[]>([]);
  // Remote-revoke banner for the Platforms screen (README decision 12) —
  // held here, not in the screen, so a revoke landing while the screen is
  // closed still surfaces on the next visit. Dismissible.
  const [revokeNotice, setRevokeNotice] = useState<string | null>(null);
  // Last-rendered pairings, for the revoked handler: the event fires before
  // React re-renders the shrunken list, so this snapshot still contains the
  // revoked pairing — needed to discriminate colliding display names by
  // instance (the event itself carries only pairingId + displayName).
  const pairingsRef = useRef(pairings);
  pairingsRef.current = pairings;

  // Platform lifecycle events → transient toasts. Fire-and-forget (no
  // replay); ToastHost below renders the queue.
  useEffect(() => subscribeEvents((e) => {
    if (e.type === 'new-agents') {
      pushToast(`New agent${e.agents.length === 1 ? '' : 's'} granted on ${e.displayName}`);
    } else if (e.type === 'reconnect-flush') {
      pushToast(`${e.displayName} reconnected — ${e.sent} queued message${e.sent === 1 ? '' : 's'} sent`);
    } else if (e.type === 'revoked') {
      pushToast(`${e.displayName} was disconnected by its owner — everything else keeps running.`);
      const known = pairingsRef.current;
      const revoked = known.find((p) => p.pairingId === e.pairingId);
      const collides = known.filter((p) => p.displayName === e.displayName).length > 1;
      const label = collides && revoked ? `${e.displayName} · ${revoked.instance}` : e.displayName;
      setRevokeNotice(`${label} was disconnected by its owner — everything else keeps running.`);
    }
  }), [subscribeEvents]);

  // A detail screen whose pairing disappeared (unpair confirmed here, or a
  // remote revoke) pops itself back to the Platforms list.
  useEffect(() => {
    setNav((n) => {
      const top = n[n.length - 1];
      if (top?.s === 'platform' && !pairings.some((p) => p.pairingId === top.id)) return n.slice(0, -1);
      return n;
    });
  }, [pairings]);

  // URL sync. `?c=<ConvKey>` opens a conversation directly; `?pi=&pu=&pc=`
  // (push tap-routing — the SW encodes the pushing hub's instanceUrl, userId,
  // and channel into the notification click URL) is resolved against the live
  // pairings to the unique local pairing. Resolution needs the pairings list
  // loaded, so the URL read runs in an effect keyed on [pairings]; the
  // ref-guard arms it once per navigation event (mount + each popstate /
  // SW NAVIGATE, which handleSwNavigate re-dispatches as popstate) so a later
  // pairings refresh cannot re-fire an already-resolved navigation.
  const navPendingRef = useRef(true);
  const [navTick, setNavTick] = useState(0);

  useEffect(() => {
    const onPop = (): void => { navPendingRef.current = true; setNavTick((t) => t + 1); };
    window.addEventListener('popstate', onPop);
    const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : undefined;
    const onSwMessage = (event: MessageEvent): void => { handleSwNavigate(event.data); };
    sw?.addEventListener('message', onSwMessage);
    return () => {
      window.removeEventListener('popstate', onPop);
      sw?.removeEventListener('message', onSwMessage);
    };
  }, []);

  useEffect(() => {
    if (!navPendingRef.current) return;
    const params = new URLSearchParams(window.location.search);
    const c = params.get('c');
    if (c) {
      // openChannel validates the ConvKey against the live pairings, so a
      // stale param (unknown pairing or channel) no-ops.
      navPendingRef.current = false;
      openChannel(c);
      return;
    }
    const pi = params.get('pi');
    const pu = params.get('pu');
    const pc = params.get('pc');
    if (pi && pu && pc) {
      if (pairings.length === 0) return; // wait for the pairings to load
      navPendingRef.current = false;
      const p = pairings.find((x) => x.url === pi && x.userId === pu);
      if (p) openChannel(convKeyOf(p.pairingId, pc));
      // unresolvable (an instance this install no longer pairs with, or an old
      // hub's payload): stay on the merged list.
      return;
    }
    navPendingRef.current = false;
    openChannel(null); // no params — popstate (mobile back) closes the thread
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pairings, navTick]);

  // `?c=` carries the encoded ConvKey; openChannel validates it against the
  // live pairings, so a stale param (unknown pairing or channel) no-ops.
  const open = (key: string): void => {
    window.history.pushState(null, '', `?c=${encodeURIComponent(key)}`);
    openChannel(key);
  };

  const back = (): void => {
    window.history.pushState(null, '', window.location.pathname);
    openChannel(null);
  };

  const openAdd = (): void => { setSettingsStartOnAdd(true); setSettingsOpen(true); };
  const navTop = nav[nav.length - 1];

  return (
    <div className="relative flex h-full bg-surface">
      <aside className={`${activeChannel ? 'hidden md:flex' : 'flex'} w-full flex-col border-r border-line md:w-80 md:shrink-0`}>
        <ChannelList
          onOpen={open}
          onAddPlatform={openAdd}
          onSettings={() => setNav([{ s: 'platforms' }])}
        />
      </aside>
      <main className={`${activeChannel ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
        {activeChannel ? (
          <>
            <ChannelHeader convKey={activeChannel} onBack={back} onSettings={() => setSettingsOpen(true)} />
            <div className="wallpaper flex min-h-0 flex-1 flex-col">
              <Thread channel={activeChannel} />
              <Composer key={activeChannel} channel={activeChannel} />
            </div>
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center text-sm text-ink-faint">
            Select a channel
          </div>
        )}
      </main>
      {navTop ? (
        // Pushed screen: each push remounts the container (stack-signature
        // key), replaying the 200ms slide-in (README Interactions). Sits
        // under the settings sheet (z-10) so the Add-platform seam opens
        // over the Platforms screen.
        <div
          key={nav.map((e) => (e.s === 'platform' ? `platform:${e.id}` : e.s)).join('/')}
          className="absolute inset-0 z-[5] animate-screen-in bg-surface"
        >
          {navTop.s === 'platforms' ? (
            <PlatformsScreen
              onBack={() => setNav([])}
              onOpenDetail={(id) => setNav((n) => [...n, { s: 'platform', id }])}
              onAddPlatform={openAdd}
              revokeNotice={revokeNotice}
              onDismissRevoke={() => setRevokeNotice(null)}
            />
          ) : (
            <PlatformDetail pairingId={navTop.id} onBack={() => setNav((n) => n.slice(0, -1))} />
          )}
        </div>
      ) : null}
      <SettingsSheet
        open={settingsOpen}
        startOnAdd={settingsStartOnAdd}
        onClose={() => setSettingsOpen(false)}
      />
      <ToastHost />
    </div>
  );
}
