import { useEffect, useRef, useState } from 'react';
import { resolveConvKey } from '../lib/conv-key.js';
import { buildThreadItems } from '../lib/grouping.js';
import { useChat } from '../transport/context.js';
import { ApprovalCard } from './approval-card.js';
import { MessageBubble } from './message-bubble.js';
import { MessageMenu, type MessageMenuTarget } from './message-menu.js';

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
  const { state, loadOlder, retryMessage, pairings } = useChat();
  const messages = state.messages[props.channel] ?? [];
  const typing = state.typing[props.channel] ?? false;
  const hasMore = Boolean(state.nextBefore[props.channel]);
  const items = buildThreadItems(messages);
  // The owning platform's connection state drives two calm (non-error)
  // notices. Offline is per-platform — never an app-wide condition.
  const r = resolveConvKey(props.channel, pairings.map((p) => p.pairingId));
  const pairing = pairings.find((p) => p.pairingId === r?.pairingId);
  const offline = pairing?.status === 'closed';
  // Registry truth (PairingView.supported, Task 5): no factory for this
  // pairing's kind on this device = permanently offline here ("paired
  // elsewhere"). A supported kind that is merely disconnected renders the
  // plain offline pill instead — the old kind-not-in-{ws,host} heuristic
  // misfiled every registered extra kind (e.g. cloudsignal) during a real
  // disconnect.
  const unsupported = pairing !== undefined && pairing.supported === false;
  // Pending delivery while the platform is offline = queued (per-platform
  // queue): the bubble captions it. Presentation only — delivery logic and
  // the outbox drain are untouched.
  const queuedFor = offline ? pairing?.displayName : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastId = messages.at(-1)?.id;
  // Long-pressed message context menu (Copy / Share). One menu for the thread.
  const [menu, setMenu] = useState<MessageMenuTarget | null>(null);

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
              queuedFor={queuedFor}
              onRetry={(id) => retryMessage(props.channel, id)}
              onLongPress={(msg, x, y) => setMenu({ text: msg.text, x, y })}
            />
          ),
        )}
        {unsupported ? (
          // README decision 13: an unsupported-kind platform is listed but
          // permanently offline — readable history, sends queue, and this
          // card (not an error) explains why.
          <div className="mb-3 max-w-[86%] self-center rounded-[10px] bg-surface/80 px-3 py-1.5 text-center text-xs leading-relaxed text-ink-faint shadow-sm">
            {pairing?.displayName} was paired on another device — this app can’t use its connection type. Messages queue here.
          </div>
        ) : offline ? (
          // Calm, not an error: the platform stays readable and sends queue.
          <div className="mb-3 max-w-[86%] self-center rounded-[10px] bg-surface/80 px-3 py-1.5 text-center text-xs leading-relaxed text-ink-faint shadow-sm">
            Offline — messages will send when it reconnects
          </div>
        ) : null}
        {typing ? <TypingDots /> : null}
      </div>
      {menu ? <MessageMenu target={menu} onClose={() => setMenu(null)} /> : null}
    </div>
  );
}
