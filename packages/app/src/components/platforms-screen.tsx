// Platforms screen — one row per paired platform (README Screens: Platforms).
// Reached from the chat list's gear; rows drill into PlatformDetail. In
// host-managed mode (any 'host'-kind pairing) the list is read-only: banner,
// no Add-platform entries (README decision 9).
import { useEffect, useState } from 'react';
import { hostManagedCopy } from '../config.js';
import * as outbox from '../lib/outbox.js';
import { useChat } from '../transport/context.js';
import type { PairingView } from '../transport/context.js';
import { Bar, Icon, IconBtn, PlatformMark, StatusDot } from './ui/primitives.js';

/** Unsupported-kind derivation — same heuristic as Thread (Task 9): the
 *  provider leaves a pairing whose transportKind has no registered factory
 *  permanently 'closed'; this app registers only 'ws' ('host' is the wired
 *  override pairing), so kind outside {ws, host} while closed means "paired
 *  on a device that supports it, not this one". */
function isUnsupported(p: PairingView): boolean {
  return p.status === 'closed' && p.transportKind !== 'ws' && p.transportKind !== 'host';
}

/** Subtitle status segment: Connected/Connecting/Offline, `· n queued` only
 *  when n > 0 (README decision 7 — queues are per-platform), or the
 *  paired-elsewhere line for unsupported kinds (README decision 13). */
function statusLine(p: PairingView, queued: number): string {
  if (isUnsupported(p)) return 'Paired elsewhere · can’t connect on this device';
  const status = p.status === 'open' ? 'Connected' : p.status === 'connecting' ? 'Connecting' : 'Offline';
  return queued > 0 ? `${status} · ${queued} queued` : status;
}

export function PlatformsScreen(props: {
  onBack: () => void;
  onOpenDetail: (pairingId: string) => void;
  /** "+ Add platform" — pushes the Add-platform flow screen. */
  onAddPlatform: () => void;
  /** Remote-revoke banner text (README decision 12), or null. Owned by the
   *  caller — ChatScreen builds it from the `revoked` PlatformEvent so a
   *  revoke that lands while this screen is closed still surfaces here. */
  revokeNotice?: string | null;
  onDismissRevoke?: () => void;
}) {
  const { pairings } = useChat();
  const hostManaged = pairings.some((p) => p.transportKind === 'host');

  // Live per-platform queued counts (scope === pairingId), re-derived on every
  // outbox mutation. Counts resolve async, so they render as absent (no
  // segment) until the first read lands.
  const [queued, setQueued] = useState<Record<string, number>>({});
  useEffect(() => {
    let alive = true;
    const refresh = (): void => {
      void Promise.all(
        pairings.map(async (p) => [p.pairingId, await outbox.countByScope(p.pairingId)] as const),
      ).then((entries) => { if (alive) setQueued(Object.fromEntries(entries)); });
    };
    refresh();
    const unsubscribe = outbox.subscribe(() => refresh());
    return () => { alive = false; unsubscribe(); };
  }, [pairings]);

  // Duplicate display names discriminate by instance (README decision 4).
  const nameCount = new Map<string, number>();
  for (const p of pairings) nameCount.set(p.displayName, (nameCount.get(p.displayName) ?? 0) + 1);

  return (
    <section className="flex h-full flex-col bg-surface">
      <Bar
        big
        onBack={props.onBack}
        title="Platforms"
        right={hostManaged ? null : <IconBtn label="Add platform" icon="plus" onClick={props.onAddPlatform} />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto pt-1.5">
        {hostManaged ? (
          <div className="mx-4 mb-2.5 mt-2 flex items-start gap-2.5 rounded-[12px] bg-surface-dim px-3 py-2.5 text-[13px] leading-relaxed text-ink-soft">
            <span aria-hidden className="mt-px shrink-0 text-ink-faint"><Icon name="alert" size={16} /></span>
            <span>{hostManagedCopy().banner}</span>
          </div>
        ) : null}
        {props.revokeNotice ? (
          <div
            data-testid="revoke-banner"
            className="mx-4 mb-2.5 mt-2 flex items-start gap-2.5 rounded-[12px] bg-danger/10 px-3 py-2.5 text-[13px] leading-relaxed text-danger"
          >
            <span className="min-w-0 flex-1">{props.revokeNotice}</span>
            <button
              type="button"
              onClick={props.onDismissRevoke}
              className="shrink-0 text-[13px] font-medium underline"
            >
              Dismiss
            </button>
          </div>
        ) : null}
        {pairings.map((p) => {
          const collides = (nameCount.get(p.displayName) ?? 0) > 1;
          return (
            <button
              key={p.pairingId}
              type="button"
              data-testid="platform-row"
              onClick={() => props.onOpenDetail(p.pairingId)}
              className="flex w-full items-center gap-3 px-4 py-[13px] text-left active:bg-surface-dim"
            >
              <PlatformMark instance={p.instance} color={p.color} icon={p.icon} size={32} />
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="text-[15px] font-semibold leading-tight text-ink">
                  {p.displayName}
                  {collides ? <span className="font-medium text-ink-faint"> · {p.instance}</span> : null}
                </span>
                <span className="truncate text-[12.5px] text-ink-faint">
                  {p.userId} on {p.instance} · {statusLine(p, queued[p.pairingId] ?? 0)}
                </span>
              </span>
              <StatusDot status={p.status} />
              <span aria-hidden className="flex text-offline"><Icon name="chev" size={18} /></span>
            </button>
          );
        })}
        {hostManaged ? null : (
          <button
            type="button"
            onClick={props.onAddPlatform}
            className="flex w-full items-center gap-3 px-4 py-3.5 text-left text-primary active:bg-surface-dim"
          >
            <span aria-hidden className="flex w-[14px] justify-center"><Icon name="plus" size={18} /></span>
            <span className="text-[15px] font-medium">+ Add platform</span>
          </button>
        )}
        <p className="px-4 pb-10 pt-2.5 text-xs leading-normal text-ink-faint">
          Each platform connects on its own — one being offline never blocks another. Colors are auto-assigned and stay stable.
        </p>
      </div>
    </section>
  );
}
