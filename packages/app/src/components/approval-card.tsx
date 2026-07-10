import { useState } from 'react';
import { channelMeta, TONES } from '../config.js';
import { formatTime } from '../lib/time.js';
import { useChat } from '../transport/context.js';
import type { ChatMessage } from '../state/messages.js';

const SHADOW = { boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.06)' };

function label(option: string): string {
  return option.charAt(0).toUpperCase() + option.slice(1);
}

export function ApprovalCard(props: { msg: ChatMessage }) {
  const { respondApproval } = useChat();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(props.msg.approval?.description ?? '');
  const approval = props.msg.approval;
  if (!approval) return null;
  const tone = TONES[channelMeta(props.msg.sender).tone];
  const responded = props.msg.respondedChoice;

  const respond = (choice: string, editedText?: string): void => {
    respondApproval(props.msg.channel, approval.refId, choice, editedText);
    setEditing(false);
  };

  return (
    <div
      className="box-border flex w-80 max-w-[90%] flex-col gap-2.5 rounded-2xl rounded-bl-[6px] bg-surface p-3"
      style={SHADOW}
    >
      <div className="flex items-center gap-2">
        <span
          className="inline-flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white"
          style={{ background: tone.avatar }}
        >
          {props.msg.sender.charAt(0).toUpperCase()}
        </span>
        <span className="min-w-0 flex-1 truncate text-[12.5px] font-semibold" style={{ color: tone.label }}>
          {approval.title}
        </span>
        <span className="shrink-0 rounded-full bg-surface-dim px-2 py-[3px] font-mono text-[11px] text-ink-soft">
          {props.msg.channel}
        </span>
      </div>
      {editing ? (
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={4}
          className="w-full rounded-[10px] border border-line bg-surface p-2.5 text-[13.5px] leading-normal text-ink outline-none focus:border-primary"
        />
      ) : (
        <div className="rounded-[10px] bg-surface-dim px-3 py-2.5 text-[13.5px] leading-normal text-ink">
          {approval.description}
        </div>
      )}
      <div className="flex items-center justify-between gap-2 text-[11px] text-ink-faint">
        <span>{approval.description.length} chars</span>
        <span className="tabular-nums">{formatTime(props.msg.ts)}</span>
      </div>
      {responded ? (
        <p className="text-sm text-ink-soft">Responded: {responded}</p>
      ) : editing ? (
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => respond('edit', draft)}
            className="h-11 flex-1 rounded-[10px] bg-primary text-sm font-medium text-white"
          >
            Send edit
          </button>
          <button
            type="button"
            onClick={() => setEditing(false)}
            className="h-11 rounded-[10px] px-3.5 text-sm font-medium text-ink-soft"
          >
            Cancel
          </button>
        </div>
      ) : (
        <div className="flex gap-2">
          {approval.options.map((option, i) => {
            if (option === 'edit') {
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => setEditing(true)}
                  className="h-11 rounded-[10px] border border-line bg-surface px-3.5 text-sm font-medium text-ink"
                >
                  {label(option)}
                </button>
              );
            }
            return (
              <button
                key={option}
                type="button"
                onClick={() => respond(option)}
                className={
                  i === 0
                    ? 'h-11 flex-1 rounded-[10px] bg-primary text-sm font-medium text-white'
                    : 'h-11 rounded-[10px] px-3 text-sm font-medium text-ink-soft'
                }
              >
                {label(option)}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
