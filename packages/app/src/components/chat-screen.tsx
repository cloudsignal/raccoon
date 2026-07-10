import { useEffect, useState } from 'react';
import { useChat } from '../transport/context.js';
import { handleSwNavigate } from '../lib/sw-navigate.js';
import { ChannelHeader } from './channel-header.js';
import { ChannelList } from './channel-list.js';
import { Composer } from './composer.js';
import { SettingsSheet } from './settings-sheet.js';
import { Thread } from './thread.js';

export function ChatScreen() {
  const { activeChannel, openChannel } = useChat();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // URL sync: ?c=<channel>; popstate (mobile back) closes the thread.
  useEffect(() => {
    const initial = new URLSearchParams(window.location.search).get('c');
    if (initial) openChannel(initial);
    const onPop = (): void => {
      openChannel(new URLSearchParams(window.location.search).get('c'));
    };
    window.addEventListener('popstate', onPop);
    const sw = 'serviceWorker' in navigator ? navigator.serviceWorker : undefined;
    const onSwMessage = (event: MessageEvent): void => { handleSwNavigate(event.data); };
    sw?.addEventListener('message', onSwMessage);
    return () => {
      window.removeEventListener('popstate', onPop);
      sw?.removeEventListener('message', onSwMessage);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const open = (id: string): void => {
    window.history.pushState(null, '', `?c=${encodeURIComponent(id)}`);
    openChannel(id);
  };

  const back = (): void => {
    window.history.pushState(null, '', window.location.pathname);
    openChannel(null);
  };

  return (
    <div className="flex h-full bg-surface">
      <aside className={`${activeChannel ? 'hidden md:flex' : 'flex'} w-full flex-col border-r border-line md:w-80 md:shrink-0`}>
        <ChannelList onOpen={open} />
      </aside>
      <main className={`${activeChannel ? 'flex' : 'hidden md:flex'} min-w-0 flex-1 flex-col`}>
        {activeChannel ? (
          <>
            <ChannelHeader channel={activeChannel} onBack={back} onSettings={() => setSettingsOpen(true)} />
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
      <SettingsSheet open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
