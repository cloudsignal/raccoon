import { channelMeta, TONES, appConfig } from '../config.js';
import { convKeyOf, type ConvKey } from '../lib/conv-key.js';
import { toPlainText } from '../lib/markdown.js';
import type { ChatMessage } from '../state/messages.js';
import { useChat } from '../transport/context.js';
import { PushBanner } from './push-banner.js';

/** One-line row preview. Attachment-only messages carry legally-empty text —
 *  fall back to a media hint: Photo for images, else the file's name. */
function previewText(last: ChatMessage): string {
  const text = toPlainText(last.text);
  if (text) return text;
  const a = last.attachments?.[0];
  if (!a) return '';
  return a.mime.startsWith('image/') ? 'Photo' : a.name ?? 'File';
}

export function ChannelList(props: { onOpen: (key: ConvKey) => void }) {
  const { pairings, state } = useChat();
  // One row per (pairing, channel) conversation — state is keyed by ConvKey;
  // labels/tones stay derived from the BARE channel.
  const conversations = pairings.flatMap((p) =>
    p.channels.map((channel) => ({ key: convKeyOf(p.pairingId, channel), channel, pairing: p })));

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-center justify-between border-b border-line px-4 pb-3 pt-[max(env(safe-area-inset-top),16px)]">
        <h1 className="text-lg font-semibold text-ink">{appConfig.name}</h1>
        {pairings.some((p) => p.status !== 'open') ? <span className="text-xs text-ink-faint">connecting…</span> : null}
      </header>
      <PushBanner />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversations.map((c) => {
          const meta = channelMeta(c.channel);
          const unread = state.unread[c.key] ?? 0;
          const last = state.messages[c.key]?.at(-1);
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => props.onOpen(c.key)}
              className="flex w-full items-center gap-3 border-b border-line px-4 py-3 text-left active:bg-surface-dim"
            >{/* per-pairing accent/labels land in Task 9 — visuals unchanged here */}
              <span
                className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-base font-semibold text-white"
                style={{ background: TONES[meta.tone].avatar }}
              >
                {meta.label.charAt(0)}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-semibold text-ink">{meta.label}</span>
                <span className="block truncate text-sm text-ink-faint">{last ? previewText(last) : meta.blurb}</span>
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
