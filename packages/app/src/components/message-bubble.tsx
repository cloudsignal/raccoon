import { FileText } from 'lucide-react';
import { channelMeta, TONES } from '../config.js';
import { formatTime } from '../lib/time.js';
import { renderMarkdown } from '../lib/markdown.js';
import { useLongPress } from '../lib/long-press.js';
import type { ChatMessage } from '../state/messages.js';
import { Ticks } from './ui/primitives.js';

const SHADOW = { boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.06)' };

/** 34500 -> "34 KB", 2621440 -> "2.5 MB" (KB floor of 1 so tiny files never show 0). */
function humanSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function MessageBubble(props: {
  msg: ChatMessage;
  groupStart: boolean;
  groupEnd: boolean;
  /** Owning platform's displayName while it is offline — a pending outgoing
   *  message is then "queued" (per-platform queue) and gets the caption.
   *  Presentation only; delivery state itself is untouched. */
  queuedFor?: string;
  onRetry?: (id: string) => void;
  /** Long-press (touch) / right-click (mouse) on the bubble — opens the
   *  message context menu (Copy / Share). Receives viewport coordinates. */
  onLongPress?: (msg: ChatMessage, x: number, y: number) => void;
}) {
  const { msg } = props;
  const mine = msg.role === 'user';
  const tail = props.groupEnd ? (mine ? 'rounded-br-[6px]' : 'rounded-bl-[6px]') : '';
  const tone = TONES[channelMeta(msg.sender).tone];
  const longPress = useLongPress((x, y) => props.onLongPress?.(msg, x, y));

  return (
    <div className={`flex flex-col ${mine ? 'items-end' : 'items-start'} ${props.groupEnd ? 'mb-3' : 'mb-0.5'}`}>
      <div
        // select-none + no touch callout: a long-press must open OUR menu,
        // not the platform text-selection callout (Copy lives in the menu).
        className={`max-w-[78%] select-none [-webkit-touch-callout:none] rounded-2xl ${tail} px-2.5 pb-2 pt-[7px] text-sm leading-[1.45] break-words ${
          mine ? 'bg-outgoing text-outgoing-ink' : 'bg-surface text-ink'
        }`}
        style={SHADOW}
        data-testid="message-bubble"
        {...longPress}
      >
        {!mine && props.groupStart ? (
          <div className="mb-0.5 text-[12.5px] font-semibold" style={{ color: tone.label }}>
            {msg.sender}
          </div>
        ) : null}
        <span
          className={`float-right ml-2.5 mt-2 -mr-1 -mb-1 inline-flex items-center gap-[3px] text-[11px] tabular-nums ${
            mine ? 'text-outgoing-meta' : 'text-ink-faint'
          }`}
        >
          {formatTime(msg.ts)}
          {mine && msg.delivery ? <Ticks delivery={msg.delivery} /> : null}
        </span>
        {/* Attachment URLs are RELATIVE hub-issued /media/... paths — rendered
            as-is (same-origin); the app never absolutizes them. */}
        {msg.attachments?.map((a) =>
          a.mime.startsWith('image/') ? (
            <a key={a.url} href={a.url} target="_blank" rel="noopener noreferrer" className="mb-1 block">
              <img src={a.url} alt={a.name ?? 'image'} loading="lazy" className="max-h-64 w-auto rounded-lg" />
            </a>
          ) : (
            <a
              key={a.url}
              href={a.url}
              target="_blank"
              rel="noopener noreferrer"
              download={a.name}
              className="mb-1 flex items-center gap-2 rounded-lg bg-surface-dim px-2.5 py-2"
            >
              <FileText size={16} className="shrink-0" aria-hidden />
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{a.name ?? 'file'}</span>
                {a.size ? <span className="block text-[11px] text-ink-faint">{humanSize(a.size)}</span> : null}
              </span>
            </a>
          ),
        )}
        {msg.text ? renderMarkdown(msg.text) : null}
      </div>
      {mine && msg.delivery === 'pending' && props.queuedFor ? (
        <span className="mt-[3px] text-[11px] text-ink-faint" data-testid="queued-caption">
          Queued — sends when {props.queuedFor} reconnects
        </span>
      ) : null}
      {mine && msg.delivery === 'failed' ? (
        msg.failureReason === 'attachments-expired' ? (
          // Terminal, NOT retryable: the media lease expired and the bytes
          // were swept — a resend would deliver dead URLs. Re-attaching
          // creates a fresh message, so no retry affordance here.
          <span className="mt-1 text-xs font-medium text-ink-soft" data-testid="attachments-expired-hint">
            Attachments expired — remove and re-attach
          </span>
        ) : props.onRetry ? (
          <button
            type="button"
            onClick={() => props.onRetry?.(msg.id)}
            className="mt-1 text-xs font-medium text-ink-soft underline"
          >
            Not sent — tap to retry
          </button>
        ) : null
      ) : null}
      {/* #P1-A: a stalled turn is still running with an UNKNOWN outcome — show a
          non-actionable hint, NEVER a retry (a retry could double side effects). */}
      {mine && msg.delivery === 'stalled' ? (
        <span className="mt-1 text-xs font-medium text-ink-soft" data-testid="stalled-hint">
          Still working — check back shortly
        </span>
      ) : null}
    </div>
  );
}
