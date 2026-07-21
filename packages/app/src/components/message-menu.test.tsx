// @vitest-environment jsdom
// Long-press message menu: Copy / Share to WhatsApp / Share to Telegram.
import 'fake-indexeddb/auto';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createEnvelope, type Envelope } from '@raccoon/protocol';
import { closeDbForTests } from '../lib/idb.js';
import { saveSession } from '../lib/session.js';
import { FakeTransport } from '../transport/fake.js';
import { TransportProvider } from '../transport/context.js';
import { LONG_PRESS_MS } from '../lib/long-press.js';
import { placeMenu } from './message-menu.js';
import { Thread } from './thread.js';

// jsdom has no PointerEvent — shim it over MouseEvent (carrying pointerType),
// which is all the long-press hook reads.
class FakePointerEvent extends MouseEvent {
  pointerType: string;
  constructor(type: string, init: MouseEventInit & { pointerType?: string } = {}) {
    super(type, init);
    this.pointerType = init.pointerType ?? 'touch';
  }
}
(globalThis as unknown as { PointerEvent: typeof FakePointerEvent }).PointerEvent = FakePointerEvent;

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDbForTests();
});

const MSG_TEXT = 'We ship the raccoon build on Friday.';

const agentMsg = (): Envelope<'msg'> => createEnvelope('msg', {
  from: 'agent:assistant', to: 'user:u1', channel: 'coordinator',
  payload: { text: MSG_TEXT },
});

async function mount() {
  const transport = new FakeTransport();
  await saveSession({ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'] });
  render(
    <TransportProvider makeTransport={() => transport}>
      <Thread channel="coordinator" />
    </TransportProvider>,
  );
  await waitFor(() => expect(transport.connected).toBe(true));
  act(() => { transport.emit(agentMsg()); });
  await screen.findByText(MSG_TEXT);
  return transport;
}

function bubble(): HTMLElement {
  const el = screen.getByTestId('message-bubble');
  expect(el).toBeTruthy();
  return el;
}

/** Simulate a touch long-press: pointerdown, hold past the threshold. */
function longPress(el: HTMLElement): void {
  vi.useFakeTimers();
  try {
    act(() => {
      el.dispatchEvent(new PointerEvent('pointerdown', {
        bubbles: true, pointerType: 'touch', clientX: 60, clientY: 300,
      }));
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
  } finally {
    vi.useRealTimers();
  }
}

describe('message long-press menu', () => {
  it('opens on long-press with Copy and the two share targets; backdrop tap dismisses', async () => {
    await mount();
    longPress(bubble());

    expect(screen.getByRole('menu', { name: 'Message actions' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Copy' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Share to WhatsApp' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Share to Telegram' })).toBeTruthy();

    // Dismissal plays a short exit animation, THEN unmounts.
    await userEvent.setup().click(screen.getByTestId('message-menu-backdrop'));
    expect(screen.getByRole('menu').getAttribute('data-state')).toBe('exit');
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('places the menu below a press near the top, above a press near the composer', async () => {
    // Pure placement logic — the animated component reads it verbatim.
    const vp = { w: 390, h: 844 };
    const high = placeMenu({ x: 60, y: 200 }, vp);
    expect(high.openAbove).toBe(false);
    expect(high.top).toBeGreaterThan(200); // opens below the finger

    const nearComposer = placeMenu({ x: 60, y: 760 }, vp);
    expect(nearComposer.openAbove).toBe(true);
    expect(nearComposer.top).toBeLessThan(760); // opens above the finger
    // The menu's bottom edge sits above the press point (finger gap included).
    expect(nearComposer.top + 144).toBeLessThanOrEqual(760);

    // Clamped: never offscreen even for edge presses.
    const corner = placeMenu({ x: 5, y: 840 }, vp);
    expect(corner.left).toBeGreaterThanOrEqual(8);
    expect(corner.top).toBeGreaterThanOrEqual(8);
  });

  it('anchors the pop transform-origin at the press point (grows out of the finger)', async () => {
    await mount();
    longPress(bubble()); // press at x=60, y=300 (high on an 844px-tall window? jsdom default 768)
    const menu = screen.getByRole('menu');
    const origin = (menu as HTMLElement).style.transformOrigin;
    // Vertical origin faces the press point: bottom edge ('100%') when the
    // menu opens above the finger, top edge ('0%') when it opens below.
    const placement = menu.getAttribute('data-placement');
    expect(['above', 'below']).toContain(placement);
    expect(origin.endsWith(placement === 'above' ? '100%' : '0%')).toBe(true);
  });

  it('does NOT open on a short tap or when the pointer moves (scroll)', async () => {
    await mount();
    const el = bubble();

    // Short tap: down then up before the threshold.
    vi.useFakeTimers();
    act(() => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 60, clientY: 300 }));
      vi.advanceTimersByTime(100);
      el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, pointerType: 'touch' }));
      vi.advanceTimersByTime(LONG_PRESS_MS);
    });
    // Scroll: down then a >10px move cancels.
    act(() => {
      el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', clientX: 60, clientY: 300 }));
      el.dispatchEvent(new PointerEvent('pointermove', { bubbles: true, pointerType: 'touch', clientX: 60, clientY: 340 }));
      vi.advanceTimersByTime(LONG_PRESS_MS + 10);
    });
    vi.useRealTimers();

    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('opens on right-click (contextmenu) for mouse users', async () => {
    await mount();
    act(() => {
      bubble().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 80, clientY: 200 }));
    });
    expect(screen.getByRole('menu', { name: 'Message actions' })).toBeTruthy();
  });

  it('Copy writes the raw message text to the clipboard and closes the menu', async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText }, configurable: true,
    });

    await mount();
    longPress(bubble());
    // fireEvent, not userEvent: userEvent.setup() installs its OWN clipboard
    // stub over the spy above.
    fireEvent.click(screen.getByRole('menuitem', { name: 'Copy' }));

    expect(writeText).toHaveBeenCalledWith(MSG_TEXT);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });

  it('Share to WhatsApp opens wa.me with the encoded text; Telegram opens t.me/share', async () => {
    const opened: string[] = [];
    vi.spyOn(window, 'open').mockImplementation((url) => { opened.push(String(url)); return null; });

    await mount();
    longPress(bubble());
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Share to WhatsApp' }));
    // The window opens SYNCHRONOUSLY on the tap (deferring it past the exit
    // animation would lose the user activation and popup-block on iOS)…
    expect(opened[0]).toBe(`https://wa.me/?text=${encodeURIComponent(MSG_TEXT)}`);
    // …and the menu unmounts after its exit animation.
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());

    longPress(bubble());
    await userEvent.setup().click(screen.getByRole('menuitem', { name: 'Share to Telegram' }));
    expect(opened[1]).toBe(`https://t.me/share/url?url=${encodeURIComponent(MSG_TEXT)}`);
    await waitFor(() => expect(screen.queryByRole('menu')).toBeNull());
  });
});
