// Floating context menu for a long-pressed message bubble (WhatsApp-style).
// v1 actions: Copy, Share to WhatsApp, Share to Telegram.
//
// Positioning: fixed overlay; the menu is placed at the press point and
// clamped so it never clips outside the viewport. Tapping the backdrop (or
// pressing Escape) dismisses without acting.

import { useEffect } from 'react';

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

export function MessageMenu(props: { target: MessageMenuTarget; onClose: () => void }) {
  const { target, onClose } = props;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const left = Math.max(EDGE_GAP_PX, Math.min(target.x, window.innerWidth - MENU_WIDTH_PX - EDGE_GAP_PX));
  const top = Math.max(EDGE_GAP_PX, Math.min(target.y, window.innerHeight - MENU_HEIGHT_PX - EDGE_GAP_PX));

  const share = (url: string): void => {
    window.open(url, '_blank', 'noopener,noreferrer');
    onClose();
  };

  const item =
    'flex h-11 w-full items-center px-4 text-left text-[14px] text-ink active:bg-surface-dim';

  return (
    <div
      data-testid="message-menu-backdrop"
      className="fixed inset-0 z-50"
      onClick={onClose}
      onContextMenu={(e) => { e.preventDefault(); onClose(); }}
    >
      <div
        role="menu"
        aria-label="Message actions"
        className="absolute overflow-hidden rounded-xl bg-surface py-1.5"
        style={{ left, top, width: MENU_WIDTH_PX, boxShadow: '0 8px 28px rgb(0 0 0 / 0.18)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <button
          type="button"
          role="menuitem"
          className={item}
          onClick={() => { void copyText(target.text).finally(onClose); }}
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
