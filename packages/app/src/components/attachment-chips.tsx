import type { Attachment } from '@raccoon/protocol';

export interface PendingAttachment {
  key: string;
  file: File;
  /** Object URL created ONCE at admission (images only); revoked by the
   *  composer on remove/send/unmount — never created during render. */
  previewUrl?: string;
  controller: AbortController;
  status: 'uploading' | 'done' | 'failed';
  progress: number; // 0..1
  attachment?: Attachment;
  error?: string;
}

export function AttachmentChips(props: {
  items: PendingAttachment[];
  onRemove(key: string): void;
  onRetry(key: string): void;
}) {
  if (props.items.length === 0) return null;
  return (
    <div className="flex gap-2 overflow-x-auto px-3 pb-1.5">
      {props.items.map((item) => {
        const isImage = item.file.type.startsWith('image/');
        return (
          <div
            key={item.key}
            data-testid={`chip-${item.status}`}
            className="relative flex h-16 shrink-0 items-center gap-2 rounded-xl bg-surface p-1.5"
            style={{ boxShadow: '0 1px 2px 0 rgb(0 0 0 / 0.08)' }}
          >
            {isImage && item.previewUrl ? (
              <img src={item.previewUrl} alt={item.file.name} className="h-full w-14 rounded-lg object-cover" />
            ) : (
              <div className="flex max-w-40 flex-col px-1.5">
                <span className="truncate text-xs font-medium text-ink">{item.file.name}</span>
                <span className="text-[11px] text-ink-faint">{Math.max(1, Math.round(item.file.size / 1024))} KB</span>
              </div>
            )}
            {item.status === 'uploading' ? (
              <div className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/25">
                <span className="text-[11px] font-semibold text-white tabular-nums">{Math.round(item.progress * 100)}%</span>
              </div>
            ) : null}
            {item.status === 'failed' ? (
              <button
                type="button"
                title={item.error ?? 'upload failed'}
                onClick={() => props.onRetry(item.key)}
                className="absolute inset-0 flex items-center justify-center rounded-xl bg-black/40 text-[11px] font-semibold text-white"
              >
                Retry
              </button>
            ) : null}
            <button
              type="button"
              aria-label={`Remove ${item.file.name}`}
              onClick={() => props.onRemove(item.key)}
              className="absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-ink text-[11px] leading-none text-white"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
