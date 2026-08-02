import { RACCOON_BUILD_ID } from '../build-id.js';

/** Settings sheet — platform management lives on the Platforms screen
 *  (Task 10) and pairing on the pushed Add-platform screen (Task 11); the
 *  sheet keeps the host-extension slot (#settings-extra) and the build line. */
export function SettingsSheet(props: { open: boolean; onClose: () => void }) {
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-ink/40 md:items-center" onClick={props.onClose}>
      <div
        className="w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(env(safe-area-inset-bottom),20px)] md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ink">Settings</h2>
        <div id="settings-extra" className="mt-4" />
        <p className="mt-4 text-center text-xs text-ink-faint">build {RACCOON_BUILD_ID}</p>
      </div>
    </div>
  );
}
