import { useEffect, useRef } from 'react';
import { buildThreadItems } from '../lib/grouping.js';
import { useChat } from '../transport/context.js';
import { ApprovalCard } from './approval-card.js';
import { MessageBubble } from './message-bubble.js';

function TypingDots() {
  return (
    <div className="flex items-center">
      <div
        data-testid="typing-dots"
        className="inline-flex items-center gap-1 rounded-2xl rounded-bl-[6px] bg-surface px-3.5 py-3 text-ink-faint"
        style={{ boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.06)' }}
      >
        <span className="h-1.5 w-1.5 rounded-full bg-current [animation:typing-bounce_1s_infinite] [animation-delay:-0.3s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-current [animation:typing-bounce_1s_infinite] [animation-delay:-0.15s]" />
        <span className="h-1.5 w-1.5 rounded-full bg-current [animation:typing-bounce_1s_infinite]" />
      </div>
    </div>
  );
}

export function Thread(props: { channel: string }) {
  const { state, loadOlder, retryMessage } = useChat();
  const messages = state.messages[props.channel] ?? [];
  const typing = state.typing[props.channel] ?? false;
  const hasMore = Boolean(state.nextBefore[props.channel]);
  const items = buildThreadItems(messages);
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastId = messages.at(-1)?.id;

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lastId, typing]);

  return (
    <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex min-h-full flex-col justify-end px-4 pb-2.5 pt-4">
        {hasMore ? (
          <button
            type="button"
            onClick={() => loadOlder(props.channel)}
            className="mb-3 self-center rounded-lg bg-surface/80 px-2.5 py-1 text-xs text-ink-faint shadow-sm"
          >
            Load earlier
          </button>
        ) : null}
        {items.map((item) =>
          item.type === 'date' ? (
            <div key={item.key} className="mb-3.5 self-center rounded-lg bg-surface/80 px-2.5 py-1 text-xs text-ink-faint shadow-sm">
              {item.label}
            </div>
          ) : item.msg.kind === 'approval' ? (
            <div key={item.key} className={`flex flex-col items-start ${item.groupEnd ? 'mb-3' : 'mb-0.5'}`}>
              <ApprovalCard msg={item.msg} />
            </div>
          ) : (
            <MessageBubble
              key={item.key}
              msg={item.msg}
              groupStart={item.groupStart}
              groupEnd={item.groupEnd}
              onRetry={(id) => retryMessage(props.channel, id)}
            />
          ),
        )}
        {typing ? <TypingDots /> : null}
      </div>
    </div>
  );
}
