import { useState } from 'react';
import type { TransportStatus } from '@raccoon/protocol';
import { useChat } from '../transport/context.js';
import type { PairingView } from '../transport/context.js';
import { RACCOON_BUILD_ID } from '../build-id.js';
import { PairPanel } from './pair-panel.js';

/** Exhaustive over TransportStatus — a new union member is a type error here,
 *  not a silent fall-through. */
const STATUS_TEXT: Record<TransportStatus, string> = {
  open: 'connected',
  connecting: 'connecting',
  closed: 'offline',
};

function PlatformRow(props: {
  pairing: PairingView;
  onRename: (displayName: string) => void;
  onUnpair: () => void;
}) {
  const p = props.pairing;
  // Row-local two-step confirm — no window.confirm.
  const [confirming, setConfirming] = useState(false);

  const commit = (value: string): void => {
    const next = value.trim();
    if (next === p.displayName) return;
    // Empty clears the local override back to the default (store-level rule).
    props.onRename(next);
  };

  return (
    <div data-testid="platform-row" className="border-t border-line py-3 first:border-t-0 first:pt-2">
      <div className="flex items-center gap-2">
        <span
          aria-hidden
          data-testid="platform-accent"
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: p.color }}
        />
        {p.transportKind === 'host' ? (
          // Rename patches the STORED pairings list; a host-managed synthetic
          // pairing has no stored entry (updatePairingMeta finds nothing and
          // the edit reverts), so render the name read-only — mirroring how
          // the sheet hides "Add platform" for host-managed installs.
          <span className="min-w-0 flex-1 truncate px-1 text-sm font-medium text-ink">
            {p.displayName}
          </span>
        ) : (
          <input
            key={p.displayName}
            defaultValue={p.displayName}
            aria-label={`Rename ${p.displayName}`}
            onBlur={(e) => commit(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit(e.currentTarget.value); e.currentTarget.blur(); }
            }}
            className="min-w-0 flex-1 rounded-[6px] border border-transparent bg-transparent px-1 text-sm font-medium text-ink outline-none focus:border-line"
          />
        )}
        <span className="shrink-0 text-xs text-ink-faint">{STATUS_TEXT[p.status]}</span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 pl-[18px]">
        <span className="truncate text-xs text-ink-faint">{p.userId} on {p.instance}</span>
        {confirming ? null : (
          <button
            type="button"
            aria-label={`Unpair ${p.displayName}`}
            onClick={() => setConfirming(true)}
            className="shrink-0 text-xs font-medium text-ink-soft"
          >
            Unpair
          </button>
        )}
      </div>
      {confirming ? (
        <div className="mt-2 flex items-center justify-between gap-2 pl-[18px]">
          <span className="text-xs text-ink">Unpair this platform?</span>
          <div className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={props.onUnpair}
              className="h-8 rounded-[8px] border border-line px-3 text-xs font-medium text-ink"
            >
              Unpair
            </button>
            <button
              type="button"
              onClick={() => setConfirming(false)}
              className="h-8 rounded-[8px] px-3 text-xs font-medium text-ink-faint"
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export function SettingsSheet(props: { open: boolean; onClose: () => void }) {
  const { pairings, unpair, renamePairing } = useChat();
  const [addOpen, setAddOpen] = useState(false);
  if (!props.open) return null;
  // A host-managed session owns pairing entirely — never offer "Add platform"
  // next to it.
  const hostManaged = pairings.some((p) => p.transportKind === 'host');
  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-ink/40 md:items-center" onClick={props.onClose}>
      <div
        className="w-full max-w-sm rounded-t-2xl bg-surface p-5 pb-[max(env(safe-area-inset-bottom),20px)] md:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-ink">Settings</h2>
        <div id="settings-extra" className="mt-4" />
        <h3 className="mt-4 text-xs font-medium uppercase tracking-wide text-ink-faint">Platforms</h3>
        <div className="mt-1">
          {pairings.map((p) => (
            <PlatformRow
              key={p.pairingId}
              pairing={p}
              onRename={(name) => void renamePairing(p.pairingId, name)}
              onUnpair={() => void unpair(p.pairingId)}
            />
          ))}
        </div>
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
