// @vitest-environment jsdom
// Design-system primitives: platform marks, avatars, ticks, status dots,
// icon buttons, bottom sheet, toast queue.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AgentAvatar,
  IconBtn,
  MARKERS,
  PlatformMark,
  Sheet,
  StatusDot,
  Ticks,
  ToastHost,
  pushToast,
} from './primitives.js';

// Branding is host-config-driven; stub the config lookup so both branches of
// the glyph resolution are exercised without editing raccoon.config.json.
vi.mock('../../config.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../config.js')>();
  return {
    ...mod,
    platformGlyph: (instance: string) => {
      if (instance === 'branded-path') return { glyph: 'M2 2l20 20', label: 'Branded' };
      if (instance === 'branded-marker') return { glyph: 'sparkle' };
      return null;
    },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function markPath(container: HTMLElement): string | null {
  return container.querySelector('svg path')?.getAttribute('d') ?? null;
}

describe('PlatformMark', () => {
  it('falls back to the bot marker when there is no branding and no icon', () => {
    const { container } = render(<PlatformMark instance="plain" color="oklch(0.55 0.13 255)" />);
    expect(markPath(container)).toBe(MARKERS.bot);
  });

  it('renders the user-selected marker when given via props.icon', () => {
    const { container } = render(<PlatformMark instance="plain" color="#123" icon="home" />);
    expect(markPath(container)).toBe(MARKERS.home);
  });

  it('renders a config-declared SVG path glyph verbatim, over props.icon', () => {
    const { container } = render(<PlatformMark instance="branded-path" color="#123" icon="home" />);
    expect(markPath(container)).toBe('M2 2l20 20');
  });

  it('resolves a config-declared MARKERS key to its path data', () => {
    const { container } = render(<PlatformMark instance="branded-marker" color="#123" />);
    expect(markPath(container)).toBe(MARKERS.sparkle);
  });

  it('paints the accent circle with the given color', () => {
    render(<PlatformMark instance="plain" color="oklch(0.62 0.14 30)" />);
    const el = screen.getByTestId('platform-mark');
    expect(el.style.background).toContain('oklch(0.62 0.14 30)');
  });
});

describe('AgentAvatar', () => {
  it('shows the channel label initial with the channel tone', () => {
    render(<AgentAvatar channel="coordinator" />);
    const el = screen.getByTestId('agent-avatar');
    expect(el.textContent).toBe('C');
    // coordinator is tone navy in raccoon.config.json
    expect(el.style.background).toContain('oklch(0.55 0.13 255)');
  });
});

describe('Ticks', () => {
  it('renders a clock for pending', () => {
    render(<Ticks delivery="pending" />);
    expect(screen.getByTestId('tick-pending')).toBeTruthy();
  });

  it('renders a single gray check for sent', () => {
    render(<Ticks delivery="sent" />);
    const el = screen.getByTestId('tick-sent');
    expect(el.querySelectorAll('path').length).toBe(1);
    expect(el.getAttribute('stroke')).toBe('oklch(0.55 0.02 165)');
  });

  it('renders a double gray check for delivered', () => {
    render(<Ticks delivery="delivered" />);
    const el = screen.getByTestId('tick-delivered');
    expect(el.querySelectorAll('path').length).toBe(2);
    expect(el.getAttribute('stroke')).toBe('oklch(0.55 0.02 165)');
  });

  it('renders a double blue check for read', () => {
    render(<Ticks delivery="read" />);
    const el = screen.getByTestId('tick-read');
    expect(el.querySelectorAll('path').length).toBe(2);
    expect(el.getAttribute('stroke')).toBe('oklch(0.65 0.12 235)');
  });

  it('renders an amber clock for stalled', () => {
    render(<Ticks delivery="stalled" />);
    expect(screen.getByTestId('tick-stalled')).toBeTruthy();
  });

  it('renders nothing without a delivery', () => {
    const { container } = render(<Ticks />);
    expect(container.innerHTML).toBe('');
  });
});

describe('StatusDot', () => {
  it.each([['open'], ['connecting'], ['closed']] as const)('tags status %s', (status) => {
    const { unmount } = render(<StatusDot status={status} />);
    expect(screen.getByTestId('status-dot').getAttribute('data-status')).toBe(status);
    unmount();
  });
});

describe('IconBtn', () => {
  it('is an accessible 44px hit target and fires onClick', () => {
    const onClick = vi.fn();
    render(<IconBtn label="Back" icon="back" onClick={onClick} />);
    const btn = screen.getByRole('button', { name: 'Back' });
    expect(btn.className).toContain('h-11');
    expect(btn.className).toContain('w-11');
    fireEvent.click(btn);
    expect(onClick).toHaveBeenCalledTimes(1);
  });
});

describe('Sheet', () => {
  it('renders nothing when closed', () => {
    render(
      <Sheet open={false} onClose={() => {}}>
        <p>Body</p>
      </Sheet>,
    );
    expect(screen.queryByText('Body')).toBeNull();
  });

  it('shows children and closes on backdrop tap, not on panel tap', () => {
    const onClose = vi.fn();
    render(
      <Sheet open onClose={onClose}>
        <p>Body</p>
      </Sheet>,
    );
    fireEvent.click(screen.getByText('Body'));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId('sheet-backdrop'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('toasts', () => {
  it('renders pushed toasts and auto-dismisses after ~2.8s', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => {
      pushToast('Saved');
    });
    expect(screen.getByText('Saved')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(2700);
    });
    expect(screen.getByText('Saved')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByText('Saved')).toBeNull();
  });

  it('stacks multiple toasts and dismisses them independently', () => {
    vi.useFakeTimers();
    render(<ToastHost />);
    act(() => {
      pushToast('First');
    });
    act(() => {
      vi.advanceTimersByTime(1000);
      pushToast('Second');
    });
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1900);
    });
    expect(screen.queryByText('First')).toBeNull();
    expect(screen.getByText('Second')).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(screen.queryByText('Second')).toBeNull();
  });
});
