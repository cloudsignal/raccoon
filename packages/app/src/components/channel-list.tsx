import { appConfig, channelMeta, listLayout, mergedSuffix } from '../config.js';
import { convKeyOf, type ConvKey } from '../lib/conv-key.js';
import { toPlainText } from '../lib/markdown.js';
import { formatTime } from '../lib/time.js';
import type { ChatMessage } from '../state/messages.js';
import { useChat } from '../transport/context.js';
import type { PairingView } from '../transport/context.js';
import { PushBanner } from './push-banner.js';
import { AgentAvatar, Bar, IconBtn, PlatformMark, Ticks } from './ui/primitives.js';

/** One-line row preview. Attachment-only messages carry legally-empty text —
 *  fall back to a media hint: Photo for images, else the file's name. */
function previewText(last: ChatMessage): string {
  const text = toPlainText(last.text);
  if (text) return text;
  const a = last.attachments?.[0];
  if (!a) return '';
  return a.mime.startsWith('image/') ? 'Photo' : a.name ?? 'File';
}

/** One (pairing, channel) conversation as the list renders it. */
interface Conversation {
  key: ConvKey;
  channel: string;
  pairing: PairingView;
  last: ChatMessage | undefined;
  unread: number;
  /** The channel is marked NEW on its pairing (granted, not yet opened). */
  isNew: boolean;
}

/** Recency comparator: NEW rows first (their moment is "Now"), then newest
 *  last-message first; conversations with no messages yet sort last, stable
 *  by channel name. */
function byRecency(a: Conversation, b: Conversation): number {
  if (a.isNew !== b.isNew) return a.isNew ? -1 : 1;
  const ta = a.last?.ts;
  const tb = b.last?.ts;
  if (ta && tb) return ta < tb ? 1 : ta > tb ? -1 : 0;
  if (ta) return -1;
  if (tb) return 1;
  return a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0;
}

function Row(props: {
  c: Conversation;
  grouped: boolean;
  /** Platform-name suffix after the agent label (merged-list policy), or null. */
  suffix: string | null;
  /** Accent badge dot color on the avatar (merged-list cue), or null. */
  badge: string | null;
  onOpen: (key: ConvKey) => void;
}) {
  const { c } = props;
  const meta = channelMeta(c.channel);
  const time = c.isNew ? 'Now' : c.last ? formatTime(c.last.ts) : '';
  return (
    <button
      type="button"
      data-testid="conv-row"
      data-new={c.isNew || undefined}
      onClick={() => props.onOpen(c.key)}
      className={`flex w-full items-center gap-3 text-left active:bg-surface-dim ${
        props.grouped ? 'py-2.5 pl-3 pr-4' : 'border-b border-line px-4 py-3'
      }`}
      style={c.isNew ? { background: `color-mix(in oklab, ${c.pairing.color} 6%, transparent)` } : undefined}
    >
      <span className="relative shrink-0">
        <AgentAvatar channel={c.channel} size={44} />
        {props.badge ? (
          <span
            data-testid="pairing-badge"
            aria-hidden
            className="absolute -bottom-0.5 -right-0.5 h-2.5 w-2.5 rounded-full ring-2 ring-surface"
            style={{ backgroundColor: props.badge }}
          />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline gap-1.5">
          <span className="truncate text-[15px] font-semibold text-ink">
            {meta.label}
            {props.suffix ? <span className="font-medium text-ink-faint"> · {props.suffix}</span> : null}
          </span>
          {time ? (
            <span
              className={`ml-auto shrink-0 text-xs tabular-nums ${
                c.unread > 0 || c.isNew ? 'font-semibold text-primary' : 'text-ink-faint'
              }`}
            >
              {time}
            </span>
          ) : null}
        </span>
        <span className="flex items-center gap-1.5">
          {c.isNew ? (
            <span className="truncate text-sm text-ink-soft">
              New agent granted on {c.pairing.displayName}
            </span>
          ) : (
            <span className="flex min-w-0 flex-1 items-center gap-1 text-sm text-ink-faint">
              {c.last?.role === 'user' ? <Ticks delivery={c.last.delivery} /> : null}
              <span className="truncate">{c.last ? previewText(c.last) : meta.blurb}</span>
            </span>
          )}
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {c.isNew ? (
              <span className="rounded-full bg-primary px-[7px] py-0.5 text-[10px] font-bold tracking-wider text-white">
                NEW
              </span>
            ) : null}
            {c.unread > 0 ? (
              <span className="flex h-5 min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-xs font-semibold text-white">
                {c.unread}
              </span>
            ) : null}
          </span>
        </span>
      </span>
    </button>
  );
}

export function ChannelList(props: {
  onOpen: (key: ConvKey) => void;
  /** "+" entry — pushes the Add-platform flow screen. */
  onAddPlatform: () => void;
  /** Gear entry — pushes the Platforms screen. */
  onSettings: () => void;
}) {
  const { pairings, state } = useChat();
  const multi = pairings.length > 1;
  // Grouped is the default layout; a single-pairing install renders the same
  // flat list as before (no headers) so the single-platform look is unchanged.
  const grouped = listLayout() === 'grouped' && multi;
  // A host-managed install owns pairing entirely — never offer "Add platform".
  const hostManaged = pairings.some((p) => p.transportKind === 'host');

  // One row per (pairing, channel) conversation — state is keyed by ConvKey;
  // labels/tones stay derived from the BARE channel. Globally recency-sorted;
  // the grouped variant partitions this order per platform, so in-group
  // recency comes for free.
  const conversations: Conversation[] = pairings
    .flatMap((p) => p.channels.map((channel) => {
      const key = convKeyOf(p.pairingId, channel);
      return {
        key,
        channel,
        pairing: p,
        last: state.messages[key]?.at(-1),
        unread: state.unread[key] ?? 0,
        isNew: p.newAgents.includes(channel),
      };
    }))
    .sort(byRecency);

  // Duplicate platform display names discriminate by instance name in group
  // headers ("Workspace · alpha" vs "Workspace · beta").
  const nameCount = new Map<string, number>();
  for (const p of pairings) nameCount.set(p.displayName, (nameCount.get(p.displayName) ?? 0) + 1);

  // Merged-list agent-name suffix policy: 'collision' (default) only when two
  // platforms expose the same channel name; 'always'; 'badge' = dot only.
  const channelCount = new Map<string, number>();
  for (const c of conversations) channelCount.set(c.channel, (channelCount.get(c.channel) ?? 0) + 1);
  const suffixPolicy = mergedSuffix();
  const mergedSuffixFor = (c: Conversation): string | null => {
    if (!multi || suffixPolicy === 'badge') return null;
    if (suffixPolicy === 'collision' && (channelCount.get(c.channel) ?? 0) < 2) return null;
    return c.pairing.displayName;
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* No aggregate connection hint here (design decisions 6/7): there is
          no app-wide connection indicator anywhere — per-platform status
          lives on the group headers and the Platforms screens. */}
      <Bar
        big
        title={appConfig.name}
        right={
          <>
            {hostManaged ? null : (
              <IconBtn label="Add platform" icon="plus" onClick={props.onAddPlatform} />
            )}
            <IconBtn label="Platforms" icon="gear" onClick={props.onSettings} />
          </>
        }
      />
      <PushBanner />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {grouped
          ? pairings.map((p) => {
            const list = conversations.filter((c) => c.pairing.pairingId === p.pairingId);
            if (list.length === 0) return null;
            const collides = (nameCount.get(p.displayName) ?? 0) > 1;
            return (
              <div key={p.pairingId} className="mb-1">
                {/* Header is a label, not a button — no drill-down. */}
                <div className="flex items-center gap-[7px] px-4 pb-1.5 pt-4">
                  <PlatformMark instance={p.instance} color={p.color} icon={p.icon} size={20} />
                  <span className="text-xs font-semibold uppercase tracking-wider text-ink-faint">
                    {p.displayName}{collides ? ` · ${p.instance}` : ''}
                  </span>
                  {p.status !== 'open' ? (
                    <span className="text-[11px] text-ink-faint">
                      {/* Prototype casing; unsupported kinds (registry truth,
                          PairingView.supported — Task 5) read "Can't connect here". */}
                      · {p.supported === false ? 'Can’t connect here'
                        : p.status !== 'closed' ? 'Connecting'
                        : 'Offline'}
                    </span>
                  ) : null}
                </div>
                {/* Thin vertical accent line under the header mark; rows indent inside it. */}
                <div
                  data-testid="group-rows"
                  className="ml-[25px] border-l-2"
                  style={{ borderColor: `color-mix(in oklab, ${p.color} 30%, transparent)` }}
                >
                  {list.map((c) => (
                    <Row key={c.key} c={c} grouped suffix={null} badge={null} onOpen={props.onOpen} />
                  ))}
                </div>
              </div>
            );
          })
          : conversations.map((c) => (
            <Row
              key={c.key}
              c={c}
              grouped={false}
              suffix={mergedSuffixFor(c)}
              badge={multi ? c.pairing.color : null}
              onOpen={props.onOpen}
            />
          ))}
        <p className="px-4 pb-10 pt-3 text-center text-xs text-ink-faint">
          {pairings.length} platform{pairings.length === 1 ? '' : 's'} · {conversations.length} agent{conversations.length === 1 ? '' : 's'}
        </p>
      </div>
    </div>
  );
}
