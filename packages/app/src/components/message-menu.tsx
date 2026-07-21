// Floating context menu for a long-pressed message bubble (WhatsApp-style).
// v1 actions: Copy, Share to WhatsApp, Share to Telegram.
//
// Placement: the menu opens BELOW the press point when there is room, and
// flips ABOVE it when the press is near the bottom of the viewport (where
// the composer lives), so it never covers the input row or clips offscreen.
// Horizontal position is clamped to the viewport with an edge gap.
//
// Motion: a compositor-friendly pop — transform + opacity only, with the
// transform-origin anchored at the press point (the menu grows out of where
// the finger is, iOS-style) and a soft overshoot on enter. Exit is a quick
// fade-scale, and the component stays mounted until it finishes. Both honor
// prefers-reduced-motion via `motion-reduce:transition-none`. Transitions
// are interruptible: reopening mid-exit just remounts cleanly.

import { useEffect, useRef, useState } from 'react';

export interface MessageMenuTarget {
  /** Raw text content of the message (what Copy/Share operate on). */
  text: string;
  /** Press point in viewport coordinates. */
  x: number;
  y: number;
}

const MENU_WIDTH_PX = 224;
const MENU_HEIGHT_PX = 3 * 44 + 12; // three items + padding
const EDGE_GAP_PX = 8;
/** Gap between the press point and the menu edge nearest to it. */
const PRESS_GAP_PX = 12;
/** Viewport bottom reserve: the composer row + home-indicator safe area.
 *  A press within MENU height of this band flips the menu above the finger. */
const BOTTOM_RESERVE_PX = 88;
const EXIT_MS = 130;

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Clipboard API can be unavailable (older webviews) — textarea fallback.
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } finally { ta.remove(); }
  }
}

/** wa.me opens the WhatsApp app (or web) with the text prefilled for forwarding. */
function whatsappShareUrl(text: string): string {
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
}

/** t.me/share prefills Telegram's forward-to-chat screen with the content. */
function telegramShareUrl(text: string): string {
  return `https://t.me/share/url?url=${encodeURIComponent(text)}`;
}

/** Above/below decision + clamped coordinates + press-anchored origin. */
export function placeMenu(target: { x: number; y: number }, viewport: { w: number; h: number }): {
  left: number;
  top: number;
  openAbove: boolean;
  originX: number;
} {
  const openAbove = target.y + PRESS_GAP_PX + MENU_HEIGHT_PX > viewport.h - BOTTOM_RESERVE_PX;
  const top = openAbove
    ? Math.max(EDGE_GAP_PX, target.y - PRESS_GAP_PX - MENU_HEIGHT_PX)
    : Math.min(target.y + PRESS_GAP_PX, viewport.h - MENU_HEIGHT_PX - EDGE_GAP_PX);
  const left = Math.max(EDGE_GAP_PX, Math.min(target.x - MENU_WIDTH_PX / 3, viewport.w - MENU_WIDTH_PX - EDGE_GAP_PX));
  // The scale animation grows out of the press point: anchor the horizontal
  // origin under the finger and the vertical origin at the edge facing it.
  const originX = Math.max(0, Math.min(target.x - left, MENU_WIDTH_PX));
  return { left, top, openAbove, originX };
}

export function MessageMenu(props: { target: MessageMenuTarget; onClose: () => void }) {
  const { target, onClose } = props;
  // 'enter' → (next frame) 'open' → on dismiss 'exit' → unmount via onClose.
  const [phase, setPhase] = useState<'enter' | 'open' | 'exit'>('enter');
  const exitTimer = useRef<number | null>(null);

  useEffect(() => {
    // Double rAF so the 'enter' styles paint before transitioning to 'open'.
    const raf = requestAnimationFrame(() => requestAnimationFrame(() => {
      setPhase((p) => (p === 'enter' ? 'open' : p));
    }));
    return () => cancelAnimationFrame(raf);
  }, []);

  useEffect(() => () => {
    if (exitTimer.current !== null) clearTimeout(exitTimer.current);
  }, []);

  const dismiss = (): void => {
    if (exitTimer.current !== null) return; // already leaving
    setPhase('exit');
    exitTimer.current = window.setTimeout(onClose, EXIT_MS);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- dismiss is stable per mount
  }, []);

  const { left, top, openAbove, originX } = placeMenu(target, {
    w: window.innerWidth,
    h: window.innerHeight,
  });

  const share = (url: string): void => {
    // Open SYNCHRONOUSLY in the tap handler: deferring to the exit animation's
    // timeout loses the transient user activation and popup-blocks on iOS.
    window.open(url, '_blank', 'noopener,noreferrer');
    dismiss();
  };

  const item =
    'flex h-11 w-full items-center px-4 text-left text-[14px] text-ink active:bg-surface-dim ' +
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60 ' +
    '[touch-action:manipulation] [-webkit-tap-highlight-color:transparent]';

  const visible = phase === 'open';

  return (
    <div
      data-testid="message-menu-backdrop"
      className={`fixed inset-0 z-50 bg-black/10 transition-opacity duration-150 motion-reduce:transition-none ${
        visible ? 'opacity-100' : 'opacity-0'
      }`}
      onClick={() => dismiss()}
      onContextMenu={(e) => { e.preventDefault(); dismiss(); }}
    >
      <div
        role="menu"
        aria-label="Message actions"
        data-state={phase}
        data-placement={openAbove ? 'above' : 'below'}
        className={`absolute overflow-hidden rounded-xl bg-surface py-1.5 will-change-transform ` +
          `transition-[transform,opacity] motion-reduce:transition-none ${
            visible
              ? 'scale-100 opacity-100 duration-200 ease-[cubic-bezier(0.34,1.4,0.64,1)]'
              : 'scale-90 opacity-0 duration-[130ms] ease-in'
          }`}
        style={{
          left,
          top,
          width: MENU_WIDTH_PX,
          boxShadow: '0 10px 34px rgb(0 0 0 / 0.2), 0 2px 8px rgb(0 0 0 / 0.08)',
          transformOrigin: `${originX}px ${openAbove ? '100%' : '0%'}`,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          className={item}
          onClick={() => { void copyText(target.text); dismiss(); }}
        >
          Copy
        </button>
        <button
          type="button"
          role="menuitem"
          className={item}
          onClick={() => share(whatsappShareUrl(target.text))}
        >
          Share to WhatsApp
        </button>
        <button
          type="button"
          role="menuitem"
          className={item}
          onClick={() => share(telegramShareUrl(target.text))}
        >
          Share to Telegram
        </button>
      </div>
    </div>
  );
}
