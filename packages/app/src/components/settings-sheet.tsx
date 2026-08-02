import { useEffect, useState } from 'react';
import { useChat } from '../transport/context.js';
import { RACCOON_BUILD_ID } from '../build-id.js';
import { PairPanel } from './pair-panel.js';

/** Settings sheet — platform management lives on the Platforms screen
 *  (Task 10); the sheet keeps the host-extension slot (#settings-extra), the
 *  Add-platform seam (PairPanel behind `startOnAdd`, until the dedicated
 *  pairing screen — Task 11 — takes it over), and the build line. */
export function SettingsSheet(props: {
  open: boolean;
  onClose: () => void;
  /** When the sheet opens with this set, the Add-platform panel starts
   *  expanded — the chat list's "+" entry and the Platforms screen's
   *  Add-platform entries route here until the dedicated pairing screen
   *  (Task 11) replaces the seam. */
  startOnAdd?: boolean;
}) {
  const { pairings } = useChat();
  const [addOpen, setAddOpen] = useState(false);
  // Reset the panel to the caller's intent on every open (the component stays
  // mounted while closed, so initial state alone cannot express this).
  useEffect(() => {
    if (props.open) setAddOpen(props.startOnAdd ?? false);
  }, [props.open, props.startOnAdd]);
  if (!props.open) return null;
  // A host-managed session owns pairing entirely — never offer "Add platform".
  const hostManaged = pairings.some((p) => p.transportKind === 'host');
  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-ink/40 md:items-center" onClick={props.onClose}>
      <div
        className="w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(env(safe-area-inset-bottom),20px)] md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ink">Settings</h2>
        <div id="settings-extra" className="mt-4" />
        {hostManaged ? null : addOpen ? (
          <div className="mt-3 flex flex-col items-center border-t border-line pt-4">
            <PairPanel onDone={() => setAddOpen(false)} />
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setAddOpen(true)}
            className="mt-3 h-11 w-full rounded-[10px] border border-line text-sm font-medium text-ink"
          >
            Add platform
          </button>
        )}
        <p className="mt-4 text-center text-xs text-ink-faint">build {RACCOON_BUILD_ID}</p>
      </div>
    </div>
  );
}
