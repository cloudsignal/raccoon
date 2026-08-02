// Platform detail — name/icon/accent overrides, identity, agents, unpair
// (README Screens: Platform detail; decisions 3, 9, 11, 14). Host-managed
// ('host' transportKind) renders read-only: rename disabled with the config
// note, no icon/accent/rescan mutations, unpair relabeled as logout.
import { useState } from 'react';
import { channelMeta, hostManagedCopy, platformGlyph, TONES } from '../config.js';
import { ACCENTS } from '../lib/conv-key.js';
import { useChat } from '../transport/context.js';
import { Bar, Btn, Icon, MARKERS, PlatformMark, pushToast, Sheet } from './ui/primitives.js';

/** Palette hue names, index-matched to ACCENTS — the swatches' aria-labels. */
const ACCENT_NAMES = ['Blue', 'Rust', 'Moss', 'Violet', 'Amber', 'Rose', 'Cyan', 'Olive'] as const;

const MARKER_KEYS = Object.keys(MARKERS) as Array<keyof typeof MARKERS>;

function SectionLabel(props: { children: string }) {
  return (
    <div className="mx-4 mb-2 mt-[18px] text-xs font-semibold uppercase tracking-wider text-ink-faint">
      {props.children}
    </div>
  );
}

function IdentityRow(props: { k: string; v: string; last?: boolean }) {
  return (
    <div
      data-testid="identity-row"
      className={`flex justify-between gap-3 px-3.5 py-[11px] text-sm ${props.last ? '' : 'border-b border-line'}`}
    >
      <span className="shrink-0 text-ink-faint">{props.k}</span>
      <span className="break-all text-right font-mono text-[12.5px] text-ink">{props.v}</span>
    </div>
  );
}

export function PlatformDetail(props: { pairingId: string; onBack: () => void }) {
  const { pairings, renamePairing, updatePlatformMeta, rescanPlatform, unpair } = useChat();
  const [confirming, setConfirming] = useState(false);
  const p = pairings.find((x) => x.pairingId === props.pairingId);
  // Unpaired (here or remotely) while open — nothing to render; the owning
  // nav stack pops itself when the pairing disappears (chat-screen effect).
  if (!p) return null;

  // Registry truth (PairingView.supported, Task 5): no factory for this kind
  // on this device = paired elsewhere, permanently offline here.
  const unsupported = p.supported === false;
  const hostManaged = p.transportKind === 'host';
  const host = hostManagedCopy();
  const branded = platformGlyph(p.instance) !== null;
  const status = p.status === 'open' ? 'Connected' : p.status === 'connecting' ? 'Connecting' : 'Offline';

  const commitRename = (value: string): void => {
    const next = value.trim();
    if (next === p.displayName) return;
    // Empty clears the local override back to the server name (store rule).
    void renamePairing(p.pairingId, next);
  };

  const onRescan = (): void => {
    if (p.status !== 'open') {
      pushToast('Can’t scan while offline');
      return;
    }
    void rescanPlatform(p.pairingId);
    pushToast(`Rescanning ${p.displayName}…`);
  };

  return (
    <section className="flex h-full flex-col bg-surface">
      <Bar
        onBack={props.onBack}
        title={p.displayName}
        sub={unsupported ? 'Paired elsewhere' : status}
        avatar={<PlatformMark instance={p.instance} color={p.color} icon={p.icon} size={36} />}
      />
      <div className="min-h-0 flex-1 overflow-y-auto pb-11">
        {unsupported ? (
          <div className="mx-4 mt-3.5 rounded-[12px] bg-surface-dim px-3 py-2.5 text-[13px] leading-relaxed text-ink-soft">
            Paired on another device. This app doesn’t support its connection type ({p.transportKind}), so it stays offline here — history is readable and sends queue.
          </div>
        ) : null}

        <SectionLabel>Name</SectionLabel>
        <div className="mx-4">
          <input
            key={p.displayName}
            defaultValue={p.displayName === p.instance ? '' : p.displayName}
            placeholder={p.instance}
            disabled={hostManaged}
            aria-label={`Rename ${p.displayName}`}
            onBlur={(e) => { if (!hostManaged) commitRename(e.target.value); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commitRename(e.currentTarget.value); e.currentTarget.blur(); }
            }}
            className={`h-[46px] w-full rounded-[12px] border border-line px-3.5 text-[15px] text-ink outline-none focus:border-ink-faint ${hostManaged ? 'bg-surface-dim' : 'bg-surface'}`}
          />
          <p className="mt-1.5 text-xs leading-relaxed text-ink-faint">
            {hostManaged
              ? host.renameNote
              : `Local nickname. Clear it to go back to the server name (${p.instance}).`}
          </p>
        </div>

        {branded || hostManaged ? null : (
          <>
            <SectionLabel>Icon</SectionLabel>
            <div className="mx-4 flex gap-2.5">
              {MARKER_KEYS.map((marker) => {
                const selected = (p.icon ?? 'bot') === marker;
                return (
                  <button
                    key={marker}
                    type="button"
                    aria-label={marker}
                    aria-pressed={selected}
                    onClick={() => void updatePlatformMeta(p.pairingId, { icon: marker })}
                    className={`flex h-10 w-10 items-center justify-center rounded-full ${selected ? 'text-white ring-2 ring-offset-2 ring-offset-surface' : 'bg-surface-dim text-ink-soft'}`}
                    style={selected ? { background: p.color, ['--tw-ring-color' as string]: p.color } : undefined}
                  >
                    <Icon name={marker} size={20} />
                  </button>
                );
              })}
            </div>
            <p className="mx-4 mt-2 text-xs leading-relaxed text-ink-faint">
              {p.instance} doesn’t provide a logo — pick a marker for it.
            </p>
          </>
        )}

        {hostManaged ? null : (
          <>
            <SectionLabel>Accent</SectionLabel>
            <div className="mx-4 flex flex-wrap gap-2.5">
              {ACCENTS.map((color, i) => {
                const selected = p.color === color;
                return (
                  <button
                    key={color}
                    type="button"
                    data-testid="accent-swatch"
                    aria-label={ACCENT_NAMES[i]}
                    aria-pressed={selected}
                    onClick={() => void updatePlatformMeta(p.pairingId, { color })}
                    className={`h-[34px] w-[34px] rounded-full ${selected ? 'ring-2 ring-offset-2 ring-offset-surface' : ''}`}
                    style={{ background: color, ...(selected ? { ['--tw-ring-color' as string]: color } : {}) }}
                  />
                );
              })}
            </div>
            <p className="mx-4 mt-2 text-xs leading-relaxed text-ink-faint">
              Shown as this platform’s badge everywhere. Auto-assigned at pairing.
            </p>
          </>
        )}

        <SectionLabel>Identity</SectionLabel>
        <div className="mx-4 rounded-[12px] border border-line">
          <IdentityRow k="You" v={p.userId} />
          <IdentityRow k="Address" v={p.url ?? '—'} />
          <IdentityRow k="Server name" v={p.instance} />
          <IdentityRow k="Transport" v={unsupported ? `${p.transportKind} — unsupported` : p.transportKind} last />
        </div>

        <SectionLabel>{`Agents · ${p.channels.length}`}</SectionLabel>
        <div className="mx-4 flex flex-wrap items-center gap-2">
          {p.channels.map((channel) => {
            const meta = channelMeta(channel);
            return (
              <span
                key={channel}
                className="inline-flex h-[34px] items-center gap-1.5 rounded-full border border-line px-3 text-[13px] text-ink"
              >
                <span aria-hidden className="h-2 w-2 rounded-full" style={{ background: TONES[meta.tone].avatar }} />
                {meta.label}
              </span>
            );
          })}
          {hostManaged ? null : (
            <button
              type="button"
              onClick={onRescan}
              className="inline-flex h-[34px] items-center gap-1.5 rounded-full border border-primary/45 px-3 text-[13px] font-medium text-primary"
            >
              <Icon name="refresh" size={14} /> Rescan
            </button>
          )}
        </div>
        <p className="mx-4 mt-2 text-xs leading-relaxed text-ink-faint">
          Agents are granted by the platform when it connects.
        </p>

        <div className="mx-4 mt-7 flex flex-col gap-2">
          {hostManaged ? (
            <Btn kind="ghost" onClick={() => setConfirming(true)}>
              <span className="text-danger">{host.logoutLabel}</span>
            </Btn>
          ) : (
            <Btn kind="danger" onClick={() => setConfirming(true)}>Unpair {p.displayName}</Btn>
          )}
          <p className="text-center text-xs leading-relaxed text-ink-faint">
            {hostManaged
              ? 'This platform is managed by the host application.'
              : 'Deletes this platform’s chats and queued messages from this phone only.'}
          </p>
        </div>
      </div>

      {/* Two-step unpair (README decision 11) — local-only, the platform can
          pair again later. Host-managed swaps in the logout copy. */}
      <Sheet open={confirming} onClose={() => setConfirming(false)}>
        <h2 className="text-base font-semibold text-ink">
          {hostManaged ? `${host.logoutLabel}?` : `Unpair ${p.displayName}?`}
        </h2>
        <p className="mt-2 text-sm leading-relaxed text-ink-soft">
          {hostManaged
            ? 'You’ll stop receiving messages on this phone until you log in again.'
            : `Deletes ${p.displayName}’s chats and queued messages from this phone. The platform itself is untouched and can pair again later.`}
        </p>
        <div className="mt-5 flex flex-col gap-2">
          <Btn kind="danger" onClick={() => { setConfirming(false); void unpair(p.pairingId); }}>
            {hostManaged ? host.logoutLabel : 'Unpair'}
          </Btn>
          <Btn kind="quiet" onClick={() => setConfirming(false)}>Cancel</Btn>
        </div>
      </Sheet>
    </section>
  );
}
