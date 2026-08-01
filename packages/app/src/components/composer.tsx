import { useEffect, useRef, useState } from 'react';
import { Paperclip, SendHorizonal } from 'lucide-react';
import { channelMeta } from '../config.js';
import { resolveConvKey } from '../lib/conv-key.js';
import { setUpdateHold } from '../lib/update-hold.js';
import { deleteUpload, uploadFile, validateFiles } from '../lib/uploads.js';
import { useChat } from '../transport/context.js';
import { AttachmentChips, type PendingAttachment } from './attachment-chips.js';

// Transient inline-notice copy per validateFiles rejection reason.
const REJECT_LABEL: Record<string, string> = {
  'too-large': 'over 25MB',
  'too-many': 'up to 4 per message',
  empty: 'empty file',
};

export function Composer(props: { channel: string }) {
  const { sendMessage, pairings, uploadProvider } = useChat();
  // props.channel is a ConvKey (the state key). The label and offline notice
  // derive from the resolved BARE channel + its pairing's connection status.
  const resolved = resolveConvKey(props.channel, pairings.map((p) => p.pairingId));
  const pairing = pairings.find((p) => p.pairingId === resolved?.pairingId);
  const [value, setValue] = useState('');
  const [pending, setPending] = useState<PendingAttachment[]>([]);
  const [dropActive, setDropActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  // Admission serializer: chips admitted and not yet removed/sent. A
  // SYNCHRONOUS ref, never state and never read inside a state updater —
  // React updaters must be pure (Strict Mode double-invokes them), and two
  // admission events landing in one tick (simultaneous paste + drop) must
  // each see the count the other reserved, which only a ref read/write in
  // the event handler itself guarantees.
  const pendingCountRef = useRef(0);
  // Mirror of `pending` for the unmount cleanup (revoke surviving previews).
  const pendingRef = useRef<PendingAttachment[]>(pending);
  pendingRef.current = pending;
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const meta = channelMeta(resolved?.channel ?? props.channel);

  useEffect(() => {
    // Chips are user work in progress just like typed text — hold updates
    // while any are present so an app update can't discard them.
    setUpdateHold(value.trim() !== '' || pending.length > 0);
    return () => setUpdateHold(false);
  }, [value, pending]);

  // Preview object URLs are minted ONCE at admission; if the composer
  // unmounts while chips are still present, release them here (remove/send
  // handle the other lifecycle exits).
  useEffect(() => () => {
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    for (const item of pendingRef.current) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
  }, []);

  const autoGrow = (): void => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  };

  // Pure keyed patch — all side effects (uploads, aborts, revocation) happen
  // in the event handlers / promise continuations that call this.
  const patchChip = (key: string, patch: Partial<PendingAttachment>): void => {
    setPending((prev) => prev.map((p) => (p.key === key ? { ...p, ...patch } : p)));
  };

  const startUpload = (key: string, file: File, controller: AbortController): void => {
    uploadFile(file, uploadProvider, {
      onProgress: (fraction) => patchChip(key, { progress: fraction }),
      signal: controller.signal,
    }).then(
      (attachment) => patchChip(key, { status: 'done', progress: 1, attachment }),
      (err: unknown) => {
        // AbortError: the chip was already removed (and the ref count
        // decremented) by the handler that called controller.abort() — a
        // silent no-op, never a failed state.
        if (err instanceof Error && err.name === 'AbortError') return;
        patchChip(key, { status: 'failed', error: err instanceof Error ? err.message : 'upload failed' });
      },
    );
  };

  const showNotice = (text: string): void => {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => {
      noticeTimer.current = null;
      setNotice(null);
    }, 4000);
  };

  const addFiles = (files: File[]): void => {
    if (files.length === 0) return;
    // Admission via the synchronous ref: event handlers run to completion on
    // one thread, so validate-against-count + reserve here is race-free even
    // for a simultaneous paste + drop (see pendingCountRef above).
    const { accepted, rejected } = validateFiles(pendingCountRef.current, files);
    pendingCountRef.current += accepted.length;
    if (rejected.length > 0) {
      const reasons = [...new Set(rejected.map((r) => REJECT_LABEL[r.reason] ?? r.reason))];
      showNotice(`Some files were not attached: ${reasons.join(', ')}.`);
    }
    if (accepted.length === 0) return;
    // Controllers, preview URLs, and uploads are created exactly ONCE, here
    // in the handler — never during render, never inside a state updater.
    const chips: PendingAttachment[] = accepted.map((file) => ({
      key: crypto.randomUUID(),
      file,
      previewUrl: file.type.startsWith('image/') ? URL.createObjectURL(file) : undefined,
      controller: new AbortController(),
      status: 'uploading',
      progress: 0,
    }));
    setPending((prev) => [...prev, ...chips]); // pure append
    for (const chip of chips) startUpload(chip.key, chip.file, chip.controller);
  };

  const removeChip = (key: string): void => {
    const item = pending.find((p) => p.key === key);
    if (!item) return;
    // Uploading: cancel the XHR — the AbortError path in startUpload then
    // no-ops (the chip is already gone). Done: best-effort delete of the
    // now-orphaned upload (never rejects).
    if (item.status === 'uploading') item.controller.abort();
    else if (item.status === 'done' && item.attachment) void deleteUpload(item.attachment, uploadProvider);
    if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    pendingCountRef.current -= 1;
    setPending((prev) => prev.filter((p) => p.key !== key));
  };

  const retryChip = (key: string): void => {
    const item = pending.find((p) => p.key === key);
    if (!item || item.status !== 'failed') return;
    const controller = new AbortController(); // minted once, in the handler
    patchChip(key, { status: 'uploading', progress: 0, controller, error: undefined });
    startUpload(key, item.file, controller);
  };

  const uploading = pending.some((p) => p.status === 'uploading');
  const failed = pending.some((p) => p.status === 'failed');

  const send = (): void => {
    const text = value.trim();
    const attachments = pending.filter((p) => p.status === 'done').map((p) => p.attachment!);
    if (uploading || failed) return;
    if (text === '' && attachments.length === 0) return;
    sendMessage(props.channel, text, attachments.length ? attachments : undefined);
    setValue('');
    setPending([]);
    pendingCountRef.current = 0;
    for (const item of pending) {
      if (item.previewUrl) URL.revokeObjectURL(item.previewUrl);
    }
    requestAnimationFrame(autoGrow);
  };

  return (
    <div
      data-testid="composer-root"
      className={`flex shrink-0 flex-col ${dropActive ? 'ring-2 ring-primary/50' : ''}`}
      onDragOver={(e) => { e.preventDefault(); setDropActive(true); }}
      onDragLeave={() => setDropActive(false)}
      onDrop={(e) => { e.preventDefault(); setDropActive(false); addFiles([...e.dataTransfer.files]); }}
    >
      {pairing?.status !== 'open' ? (
        <p className="px-4 pb-1 text-center text-xs text-ink-faint">
          Offline — messages will send when the connection returns.
        </p>
      ) : null}
      {notice ? (
        <p className="px-4 pb-1 text-center text-xs text-ink-faint" data-testid="attach-notice">
          {notice}
        </p>
      ) : null}
      <AttachmentChips items={pending} onRemove={removeChip} onRetry={retryChip} />
      <div className="flex items-end gap-2 px-2.5 pb-[max(env(safe-area-inset-bottom),12px)] pt-1.5">
        <input
          ref={fileRef}
          type="file"
          multiple
          data-testid="file-input"
          className="hidden"
          onChange={(e) => { addFiles([...(e.target.files ?? [])]); e.target.value = ''; }}
        />
        <button
          type="button"
          aria-label="Attach files"
          onClick={() => fileRef.current?.click()}
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-ink-soft"
        >
          <Paperclip size={20} strokeWidth={2} />
        </button>
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
            onPaste={(e) => {
              const files = [...e.clipboardData.files];
              if (files.length) { e.preventDefault(); addFiles(files); }
            }}
            rows={1}
            // iOS autocorrect + spellcheck ON: for ordinary chat this is what
            // users expect, and turning it off hurt the common case more than it
            // helped the occasional slash-command. autoComplete stays off (form
            // autofill has no place in a message box).
            autoCorrect="on"
            spellCheck={true}
            autoComplete="off"
            placeholder={`Message ${meta.label}…`}
            className="max-h-[120px] w-full resize-none bg-transparent py-1.5 text-base text-ink outline-none placeholder:text-ink-faint"
          />
        </div>
        <button
          type="button"
          aria-label="Send message"
          onClick={send}
          disabled={uploading || failed}
          className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-primary text-white ${
            uploading || failed ? 'opacity-50' : ''
          }`}
          style={{ boxShadow: '0 1px 3px 0 rgb(0 0 0 / 0.15)' }}
        >
          <SendHorizonal size={18} strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
