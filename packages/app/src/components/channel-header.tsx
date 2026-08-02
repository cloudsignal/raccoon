import { ArrowLeft, Settings } from 'lucide-react';
import { channelMeta, TONES } from '../config.js';
import { resolveConvKey, type ConvKey } from '../lib/conv-key.js';
import { useChat } from '../transport/context.js';

export function ChannelHeader(props: { convKey: ConvKey; onBack: () => void; onSettings: () => void }) {
  const { pairings } = useChat();
  // Resolve the conversation's pairing for its connection status and instance
  // suffix; the label stays derived from the BARE channel.
  const r = resolveConvKey(props.convKey, pairings.map((p) => p.pairingId));
  const pairing = pairings.find((p) => p.pairingId === r?.pairingId);
  const meta = channelMeta(r?.channel ?? props.convKey);
  // The `· <displayName>` suffix appears only with multiple pairings — a
  // single-install header keeps the original agent-only title.
  const multi = pairings.length > 1;
  return (
    <header className="relative z-[2] shrink-0 border-b border-line bg-surface">
      <div className="h-[env(safe-area-inset-top)]" />
      <div className="flex h-16 items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 items-center gap-2">
          <button
            type="button"
            aria-label="Back to channels"
            onClick={props.onBack}
            className="-ml-2 flex h-11 w-11 shrink-0 items-center justify-center rounded-md text-ink md:hidden"
          >
            <ArrowLeft size={24} strokeWidth={2} />
          </button>
          <div className="relative shrink-0">
            <div
              className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold text-white"
              style={{ background: TONES[meta.tone].avatar }}
            >
              {meta.label.charAt(0)}
            </div>
            {pairing?.status === 'open' ? (
              <span className="absolute -bottom-0.5 -right-0.5 box-border h-3 w-3 rounded-full border-2 border-surface bg-online" />
            ) : null}
          </div>
          <div className="flex min-w-0 flex-col">
            <span className={multi ? 'truncate text-sm font-semibold leading-tight text-ink' : 'text-sm font-semibold leading-tight text-ink'}>
              {meta.label}
              {/* Decision 6: muted, weight 500 — quieter than the agent name. */}
              {multi ? <span className="font-medium text-ink-faint"> · {pairing?.displayName}</span> : null}
            </span>
            <span className="truncate text-xs leading-4 text-ink-faint">{meta.blurb}</span>
          </div>
        </div>
        <button
          type="button"
          aria-label="Open settings"
          onClick={props.onSettings}
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-ink"
        >
          <Settings size={20} strokeWidth={2} />
        </button>
      </div>
    </header>
  );
}
