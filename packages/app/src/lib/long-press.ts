// Long-press detection for message bubbles (WhatsApp-style context menu).
//
// Pointer-events based so one implementation covers touch, pen, and mouse.
// A hold of LONG_PRESS_MS with less than MOVE_TOLERANCE_PX of drift triggers;
// any earlier pointerup/cancel/leave or a scroll-sized move cancels. Desktop
// right-click (contextmenu) triggers immediately — same menu, no hold.
//
// The consuming element should also carry `select-none` and
// `[-webkit-touch-callout:none]` so iOS long-press opens OUR menu instead of
// the native text-selection callout.

import { useCallback, useRef } from 'react';
import type React from 'react';

export const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 10;

export interface LongPressHandlers {
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: () => void;
  onPointerCancel: () => void;
  onPointerLeave: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
}

export function useLongPress(onTrigger: (x: number, y: number) => void): LongPressHandlers {
  const timer = useRef<number | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    origin.current = null;
  }, []);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // Mouse long-press is unnatural; the mouse path is contextmenu below.
      if (e.pointerType === 'mouse') return;
      origin.current = { x: e.clientX, y: e.clientY };
      timer.current = window.setTimeout(() => {
        timer.current = null;
        const at = origin.current;
        origin.current = null;
        if (at) onTrigger(at.x, at.y);
      }, LONG_PRESS_MS);
    },
    [onTrigger],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const from = origin.current;
      if (!from) return;
      // A scroll gesture moves the pointer; that must not pop the menu.
      if (Math.hypot(e.clientX - from.x, e.clientY - from.y) > MOVE_TOLERANCE_PX) cancel();
    },
    [cancel],
  );

  const onContextMenu = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      cancel(); // a touch long-press also fires contextmenu on some platforms — one trigger only
      onTrigger(e.clientX, e.clientY);
    },
    [cancel, onTrigger],
  );

  return {
    onPointerDown,
    onPointerMove,
    onPointerUp: cancel,
    onPointerCancel: cancel,
    onPointerLeave: cancel,
    onContextMenu,
  };
}
