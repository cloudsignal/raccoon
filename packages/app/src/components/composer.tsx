import { useEffect, useRef, useState } from 'react';
import { SendHorizonal } from 'lucide-react';
import { channelMeta } from '../config.js';
import { setUpdateHold } from '../lib/update-hold.js';
import { useChat } from '../transport/context.js';

export function Composer(props: { channel: string }) {
  const { sendMessage, status } = useChat();
  const [value, setValue] = useState('');
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const meta = channelMeta(props.channel);

  useEffect(() => {
    setUpdateHold(value.trim() !== '');
    return () => setUpdateHold(false);
  }, [value]);

  const autoGrow = (): void => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  const send = (): void => {
    const text = value.trim();
    if (text === '') return;
    sendMessage(props.channel, text);
    setValue('');
    requestAnimationFrame(autoGrow);
  };

  return (
    <div className="flex shrink-0 flex-col">
      {status !== 'open' ? (
        <p className="px-4 pb-1 text-center text-xs text-ink-faint">
          Offline — messages will send when the connection returns.
        </p>
      ) : null}
      <div className="flex items-end gap-2 px-2.5 pb-[max(env(safe-area-inset-bottom),12px)] pt-1.5">
        <div
          className="flex min-h-11 min-w-0 flex-1 items-center rounded-3xl bg-surface px-4 py-1"
          style={{ boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.06)' }}
        >
          <textarea
            ref={boxRef}
            value={value}
            onChange={(e) => { setValue(e.target.value); autoGrow(); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            rows={1}
            // No autocorrect/predictive bar: agent commands and technical
            // terms get mangled by iOS autocorrection. Sentence
            // auto-capitalization stays.
            autoCorrect="off"
            spellCheck={false}
            autoComplete="off"
            placeholder={`Message ${meta.label}…`}
            className="max-h-[120px] w-full resize-none bg-transparent py-1.5 text-base text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
        <button
          type="button"
          aria-label="Send message"
          onClick={send}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-white"
          style={{ boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.15)' }}
        >
          <SendHorizonal size={18} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
