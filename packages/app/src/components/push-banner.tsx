import { useEffect, useState } from 'react';
import { kvGet } from '../lib/idb.js';
import { useChat } from '../transport/context.js';

export function PushBanner() {
  const { canEnablePush, enablePush } = useChat();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!canEnablePush) return;
    // Show while notifications are not yet enabled and not blocked. Include the
    // 'granted' case: permission can already be granted while the subscription was
    // lost (server restart / re-pair), and the user must be able to re-register.
    if (!('Notification' in window) || Notification.permission === 'denied') return;
    void kvGet<boolean>('push-enabled').then((enabled) => {
      if (!enabled) setVisible(true);
    });
  }, [canEnablePush]);

  if (!visible) return null;
  return (
    <div className="flex items-center justify-between gap-3 border-b border-line bg-surface-dim px-4 py-2.5">
      <p className="text-sm text-ink-soft">Get notified when agents reply.</p>
      <div className="flex shrink-0 gap-1">
        <button
          type="button"
          onClick={() => { void enablePush().then((ok) => setVisible(!ok)).catch(() => { /* keep the banner up so the user can retry */ }); }}
          className="h-9 rounded-[10px] bg-primary px-3 text-sm font-medium text-white"
        >
          Enable
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setVisible(false)}
          className="h-9 rounded-[10px] px-2 text-sm text-ink-faint"
        >
          Later
        </button>
      </div>
    </div>
  );
}
