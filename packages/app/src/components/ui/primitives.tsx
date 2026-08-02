// Design-system primitives — the shared visual vocabulary for the
// multi-platform screens: platform marks, agent avatars, delivery ticks,
// status dots, icon buttons, bars, bottom sheets, and the toast queue.
// Token values live in src/styles.css (@theme custom properties).
import type { ReactNode } from 'react';
import { useSyncExternalStore } from 'react';
import type { TransportStatus } from '@raccoon/protocol';
import { channelMeta, platformGlyph, TONES } from '../../config.js';
import type { Delivery } from '../../state/messages.js';

/* ------------------------------------------------------------------ icons */

/** Generic platform markers a user can pick for non-branded platforms.
 *  SVG path data (2px-stroke line style, 24x24 viewBox). */
export const MARKERS: Record<'bot' | 'server' | 'home' | 'sparkle', string> = {
  bot: 'M8 8h8a3.5 3.5 0 0 1 3.5 3.5v3a3.5 3.5 0 0 1-3.5 3.5H8a3.5 3.5 0 0 1-3.5-3.5v-3A3.5 3.5 0 0 1 8 8ZM12 8V5M12 2.7a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2ZM9.3 12.5v1.6M14.7 12.5v1.6',
  server: 'M6 4h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2ZM6 13h12a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2v-3a2 2 0 0 1 2-2ZM8 7.5h.01M8 16.5h.01',
  home: 'M3 10.5 12 3l9 7.5M5.5 9v11h13V9',
  sparkle: 'M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9Z',
};

/** Chrome icon set (same 2px line style). Keyed for IconBtn / Icon. */
const ICONS: Record<string, string> = {
  back: 'm12 19-7-7 7-7M19 12H5',
  gear: 'M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  plus: 'M5 12h14M12 5v14',
  mic: 'M12 19v3M19 10v2a7 7 0 0 1-14 0v-2M9 5a3 3 0 0 1 6 0v6a3 3 0 1 1-6 0Z',
  send: 'M14.536 21.686a.5.5 0 0 0 .937-.024l6.5-19a.496.496 0 0 0-.635-.635l-19 6.5a.5.5 0 0 0-.024.937l7.93 3.18a2 2 0 0 1 1.112 1.11ZM21.854 2.147l-10.94 10.939',
  chev: 'm9 18 6-6-6-6',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 7v5l3 2',
  alert: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18ZM12 8v4M12 16h.01',
  qr: 'M4 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM15 3h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-5a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1ZM4 14h5a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-5a1 1 0 0 1 1-1ZM14 14h3v3h-3ZM21 14v.01M14 21v.01M21 18v.01M18 21v.01',
  refresh: 'M3 12a9 9 0 0 1 15.36-6.36L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.36 6.36L3 16M3 21v-5h5',
  ...MARKERS,
};

/** Line icon by name. Decorative — pair with an aria-label on the control. */
export function Icon(props: { name: string; size?: number; strokeWidth?: number }) {
  const size = props.size ?? 24;
  return (
    <svg
      aria-hidden
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={props.strokeWidth ?? 2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={ICONS[props.name] ?? MARKERS.bot} />
    </svg>
  );
}

/* ---------------------------------------------------------------- identity */

/** Platform logo avatar: accent-colored circle containing the platform glyph.
 *  Glyph resolution: host branding config -> user-selected marker -> bot.
 *  A configured glyph may be a MARKERS key or raw SVG path data. */
export function PlatformMark(props: { instance: string; color: string; icon?: string; size?: number }) {
  const size = props.size ?? 28;
  const glyph = platformGlyph(props.instance)?.glyph ?? props.icon ?? 'bot';
  const d = (MARKERS as Record<string, string>)[glyph] ?? ICONS[glyph] ?? glyph;
  return (
    <span
      data-testid="platform-mark"
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full"
      style={{ width: size, height: size, background: props.color, color: 'oklch(0.99 0 0)' }}
    >
      <svg
        width={Math.round(size * 0.58)}
        height={Math.round(size * 0.58)}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={size >= 48 ? 1.7 : 2}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d={d} />
      </svg>
    </span>
  );
}

/** Agent avatar: tone-colored circle with the channel label's initial. */
export function AgentAvatar(props: { channel: string; size?: number }) {
  const size = props.size ?? 44;
  const meta = channelMeta(props.channel);
  return (
    <span
      data-testid="agent-avatar"
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: TONES[meta.tone].avatar, fontSize: Math.round(size * 0.38) }}
    >
      {meta.label.charAt(0)}
    </span>
  );
}

/* ---------------------------------------------------------------- statuses */

/** Delivery ticks: clock = pending, single gray = sent, double gray =
 *  delivered, double blue = read; amber clock = stalled (#P1-A: outcome
 *  unknown — no error styling, unlike the retryable 'failed' state, which
 *  renders no tick here and is surfaced by the bubble itself). */
export function Ticks(props: { delivery?: Delivery }) {
  const d = props.delivery;
  if (d === 'pending' || d === 'stalled') {
    return (
      <svg
        data-testid={`tick-${d}`}
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke={d === 'stalled' ? 'oklch(0.68 0.13 75)' : 'currentColor'}
        strokeWidth="2"
        strokeLinecap="round"
      >
        <circle cx="12" cy="12" r="9" />
        <path d="M12 7v5l3 2" />
      </svg>
    );
  }
  if (d === 'sent') {
    return (
      <svg data-testid="tick-sent" width="13" height="10" viewBox="0 0 14 12" fill="none" stroke="oklch(0.55 0.02 165)" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m1 6.5 3.5 3.5L11 3.5" />
      </svg>
    );
  }
  if (d === 'delivered' || d === 'read') {
    const stroke = d === 'read' ? 'oklch(0.65 0.12 235)' : 'oklch(0.55 0.02 165)';
    return (
      <svg data-testid={`tick-${d}`} width="16" height="10" viewBox="0 0 20 12" fill="none" stroke={stroke} strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="m1 6.5 3.5 3.5L11 3.5" />
        <path d="m8.5 8.5 1.5 1.5L16.5 3.5" />
      </svg>
    );
  }
  return null;
}

/** Per-platform connection dot: green = open, amber = connecting,
 *  gray = closed. Exhaustive over TransportStatus. */
const STATUS_CLASS: Record<TransportStatus, string> = {
  open: 'bg-online',
  connecting: 'bg-connecting',
  closed: 'bg-offline',
};

export function StatusDot(props: { status: TransportStatus }) {
  return (
    <span
      data-testid="status-dot"
      data-status={props.status}
      aria-hidden
      className={`inline-block h-3 w-3 shrink-0 rounded-full ${STATUS_CLASS[props.status]}`}
    />
  );
}

/* ---------------------------------------------------------------- controls */

/** 44px square icon button. */
export function IconBtn(props: { label: string; icon: string; onClick: () => void }) {
  return (
    <button
      type="button"
      aria-label={props.label}
      onClick={props.onClick}
      className="flex h-11 w-11 shrink-0 items-center justify-center rounded-[8px] text-ink outline-none focus-visible:outline-2 focus-visible:outline-primary active:bg-surface-dim"
    >
      <Icon name={props.icon} />
    </button>
  );
}

/** 48px text button in the four prototype kinds. */
export function Btn(props: {
  kind?: 'primary' | 'ghost' | 'quiet' | 'danger';
  onClick?: () => void;
  children: ReactNode;
}) {
  const kind = props.kind ?? 'primary';
  const kindClass = {
    primary: 'bg-primary text-white',
    ghost: 'border border-line bg-surface text-ink',
    quiet: 'bg-transparent text-ink-soft',
    danger: 'bg-danger text-white',
  }[kind];
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={`h-12 rounded-[12px] px-[18px] text-[15px] font-medium outline-none focus-visible:outline-2 focus-visible:outline-ink ${kindClass}`}
    >
      {props.children}
    </button>
  );
}

/** Screen top bar: back, identity, actions. 64px row + safe-area spacer. */
export function Bar(props: {
  onBack?: () => void;
  title: string;
  sub?: ReactNode;
  avatar?: ReactNode;
  right?: ReactNode;
  big?: boolean;
}) {
  return (
    <header className="relative z-[2] shrink-0 border-b border-line bg-surface pt-[env(safe-area-inset-top)]">
      <div className="flex h-16 items-center justify-between gap-2 px-3">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          {props.onBack ? (
            <span className="-ml-2">
              <IconBtn label="Back" icon="back" onClick={props.onBack} />
            </span>
          ) : null}
          {props.avatar}
          <div className="flex min-w-0 flex-col">
            <span
              className={
                props.big
                  ? `truncate text-xl font-bold leading-tight text-ink${props.onBack ? '' : ' pl-1.5'}`
                  : 'truncate text-sm font-semibold leading-tight text-ink'
              }
            >
              {props.title}
            </span>
            {props.sub ? <span className="truncate text-xs leading-4 text-ink-faint">{props.sub}</span> : null}
          </div>
        </div>
        <div className="flex shrink-0 items-center">{props.right}</div>
      </div>
    </header>
  );
}

/* ------------------------------------------------------------------- sheet */

/** Bottom sheet with a tap-to-close backdrop. Content is caller-supplied. */
export function Sheet(props: { open: boolean; onClose: () => void; children: ReactNode }) {
  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-40 flex items-end justify-center">
      <div data-testid="sheet-backdrop" onClick={props.onClose} className="absolute inset-0 animate-fade-in bg-ink/40" />
      <div
        role="dialog"
        aria-modal="true"
        className="relative w-full max-w-sm animate-sheet-up rounded-t-[20px] bg-surface p-5 pb-[max(env(safe-area-inset-bottom),44px)]"
      >
        {props.children}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ toasts */

interface Toast {
  id: number;
  text: string;
}

/** Toast auto-dismiss delay (design spec: ~2.8s). */
const TOAST_MS = 2800;

let toastSeq = 0;
let toastQueue: Toast[] = [];
const toastListeners = new Set<() => void>();

function notifyToastListeners(): void {
  for (const l of toastListeners) l();
}

/** Queue a transient toast; it auto-dismisses after ~2.8s. Callable from
 *  anywhere — a mounted ToastHost renders the queue. */
export function pushToast(text: string): void {
  const id = ++toastSeq;
  toastQueue = [...toastQueue, { id, text }];
  notifyToastListeners();
  setTimeout(() => {
    toastQueue = toastQueue.filter((t) => t.id !== id);
    notifyToastListeners();
  }, TOAST_MS);
}

function subscribeToasts(l: () => void): () => void {
  toastListeners.add(l);
  return () => toastListeners.delete(l);
}

function toastSnapshot(): Toast[] {
  return toastQueue;
}

/** Renders the module-level toast queue. Mount once near the app root. */
export function ToastHost() {
  const items = useSyncExternalStore(subscribeToasts, toastSnapshot, toastSnapshot);
  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed inset-x-0 top-[calc(env(safe-area-inset-top)+8px)] z-50 flex flex-col items-center gap-2 px-5"
    >
      {items.map((t) => (
        <div
          key={t.id}
          className="max-w-full animate-slide-down rounded-[12px] bg-toast px-4 py-2.5 text-[13px] leading-snug text-white shadow-lg"
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
