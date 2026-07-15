import { useState } from 'react';
import { appConfig } from '../config.js';
import { useChat } from '../transport/context.js';

/**
 * #F6: shown when durable local storage is unusable (private browsing, full
 * quota, or a blocked/failed IndexedDB open). Pairing is DISABLED here — a pair
 * with no durable storage could never be saved — until a write-probe succeeds.
 */
export function StorageErrorScreen() {
  const { authError, retryStorage } = useChat();
  const [busy, setBusy] = useState(false);

  const retry = async (): Promise<void> => {
    setBusy(true);
    try { await retryStorage(); } finally { setBusy(false); }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-surface px-6 pb-[max(env(safe-area-inset-bottom),24px)] pt-[max(env(safe-area-inset-top),24px)]">
      <img src={appConfig.icons.icon192} alt="" className="h-20 w-20 rounded-[22%] opacity-60" />
      <div className="text-center">
        <h1 className="text-xl font-semibold text-ink">Storage unavailable</h1>
        <p className="mt-1 max-w-xs text-sm text-ink-faint">
          {authError ?? 'This device can’t save data locally, so pairing is disabled until storage works.'}
        </p>
      </div>
      <button
        type="button"
        onClick={() => void retry()}
        disabled={busy}
        className="h-11 w-full max-w-xs rounded-[10px] bg-primary text-sm font-medium text-white disabled:opacity-50"
      >
        {busy ? 'Checking…' : 'Retry'}
      </button>
    </div>
  );
}
