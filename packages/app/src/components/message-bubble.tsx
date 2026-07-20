import { channelMeta, TONES } from '../config.js';
import { formatTime } from '../lib/time.js';
import { renderMarkdown } from '../lib/markdown.js';
import { useLongPress } from '../lib/long-press.js';
import type { ChatMessage } from '../state/messages.js';
import { Ticks } from './ticks.js';

const SHADOW = { boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.06)' };

export function MessageBubble(props: {
  msg: ChatMessage;
  groupStart: boolean;
  groupEnd: boolean;
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
        {renderMarkdown(msg.text)}
      </div>
      {mine && msg.delivery === 'failed' && props.onRetry ? (
        <button
          type="button"
          onClick={() => props.onRetry?.(msg.id)}
          className="mt-1 text-xs font-medium text-ink-soft underline"
        >
          Not sent — tap to retry
        </button>
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
