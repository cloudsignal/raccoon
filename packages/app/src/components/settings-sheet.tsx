import { useChat } from '../transport/context.js';

export function SettingsSheet(props: { open: boolean; onClose: () => void }) {
  const { session, unpair } = useChat();
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-ink/40 md:items-center" onClick={props.onClose}>
      <div
        className="w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(env(safe-area-inset-bottom),20px)] md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ink">Settings</h2>
        <p className="mt-1 text-sm text-ink-faint">
          Paired as {session?.userId} on {session?.instance}
        </p>
        <div id="settings-extra" className="mt-4" />
        <button
          type="button"
          onClick={() => void unpair()}
          className="mt-4 h-11 w-full rounded-[10px] border border-line text-sm font-medium text-ink"
        >
          Unpair this device
        </button>
        <p className="mt-3 text-center text-xs text-ink-faint">build {__RACCOON_BUILD_ID__}</p>
      </div>
    </div>
  );
}
