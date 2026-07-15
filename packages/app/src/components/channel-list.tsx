import { channelMeta, TONES, appConfig } from '../config.js';
import { useChat } from '../transport/context.js';
import { PushBanner } from './push-banner.js';

export function ChannelList(props: { onOpen: (id: string) => void }) {
  const { session, state, status } = useChat();
  const channels = session?.channels ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-4 pb-3 pt-[max(env(safe-area-inset-top),16px)]">
        <h1 className="text-lg font-semibold text-ink">{appConfig.name}</h1>
        {status !== 'open' ? <span className="text-xs text-ink-faint">connecting…</span> : null}
      </header>
      <PushBanner />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {channels.map((id) => {
          const meta = channelMeta(id);
          const unread = state.unread[id] ?? 0;
          const last = state.messages[id]?.at(-1);
          return (
            <button
              key={id}
              type="button"
              onClick={() => props.onOpen(id)}
              className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left active:bg-surface-dim"
            >
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
                style={{ background: TONES[meta.tone].avatar }}
              >
                {meta.label.charAt(0)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-ink">{meta.label}</span>
                <span className="block truncate text-sm text-ink-faint">{last ? last.text : meta.blurb}</span>
              </span>
              {unread > 0 ? (
                <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-white">
                  {unread}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
