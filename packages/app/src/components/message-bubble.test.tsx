// @vitest-environment jsdom
// Bubble rendering for message attachments: images inline (lazy, link-wrapped),
// non-images as name + human-size download rows, attachment-only messages with
// no empty text node, and the channel-list preview fallback (Photo / file name).
import 'fake-indexeddb/auto';
import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createEnvelope, type Attachment, type Envelope } from '@raccoon/protocol';
import { closeDbForTests } from '../lib/idb.js';
import { savePairings } from '../lib/session.js';
import { formatTime } from '../lib/time.js';
import { LONG_PRESS_MS } from '../lib/long-press.js';
import { FakeTransport } from '../transport/fake.js';
import { TransportProvider } from '../transport/context.js';
import { App } from '../app.js';
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
  window.history.replaceState(null, '', '/');
});

const A_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'; // 26 chars, ulid alphabet
const P1 = '01BXPAIRINGIDFORTESTSAAAAA';
const CK = `${P1}/coordinator`;
const IMAGE: Attachment = { url: `/media/${A_ID}/photo.jpg`, mime: 'image/jpeg', name: 'photo.jpg', size: 51_200 };
const PDF: Attachment = { url: `/media/${A_ID}/report.pdf`, mime: 'application/pdf', name: 'report.pdf', size: 34_500 };
const BIG: Attachment = { url: `/media/${A_ID}/build.zip`, mime: 'application/zip', name: 'build.zip', size: 2_621_440 }; // 2.5 MB
const NAMELESS: Attachment = { url: `/media/${A_ID}/blob.bin`, mime: 'application/octet-stream' };

const attachmentMsg = (over: {
  from?: 'agent:assistant' | 'user:u1';
  channel?: string;
  text?: string;
  attachments: Attachment[];
}): Envelope<'msg'> =>
  createEnvelope('msg', {
    from: over.from ?? 'agent:assistant',
    to: 'user:u1',
    channel: over.channel ?? 'coordinator',
    payload: { text: over.text ?? '', attachments: over.attachments },
  });

async function mountThread() {
  const transport = new FakeTransport();
  await savePairings([{ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: 'e1', pairingId: P1, transportKind: 'ws' }]);
  render(
    <TransportProvider makeTransport={() => transport}>
      <Thread channel={CK} />
    </TransportProvider>,
  );
  await waitFor(() => expect(transport.connected).toBe(true));
  return transport;
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

describe('MessageBubble attachments', () => {
  it('renders an image attachment as a lazy img wrapped in a new-tab link, before the text', async () => {
    const transport = await mountThread();
    act(() => { transport.emit(attachmentMsg({ text: 'look at this', attachments: [IMAGE] })); });

    const img = await screen.findByRole('img', { name: 'photo.jpg' });
    expect(img.getAttribute('src')).toBe(IMAGE.url); // RELATIVE media path, untouched
    expect(img.getAttribute('loading')).toBe('lazy');

    const link = img.closest('a');
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBe(IMAGE.url);
    expect(link!.getAttribute('target')).toBe('_blank');
    expect(link!.getAttribute('rel')).toBe('noopener noreferrer');

    // The caption still renders — AFTER the attachment block.
    const caption = screen.getByText('look at this');
    expect(link!.compareDocumentPosition(caption) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('renders a non-image attachment as a name + human-size download row', async () => {
    const transport = await mountThread();
    act(() => { transport.emit(attachmentMsg({ attachments: [PDF, BIG] })); });

    const name = await screen.findByText('report.pdf');
    const link = name.closest('a');
    expect(link).toBeTruthy();
    expect(link!.getAttribute('href')).toBe(PDF.url);
    expect(link!.getAttribute('download')).toBe('report.pdf');
    expect(link!.querySelector('svg')).toBeTruthy(); // file glyph

    // Human sizes: < 1 MB in KB (min 1), >= 1 MB as X.Y MB.
    expect(screen.getByText('34 KB')).toBeTruthy();
    expect(screen.getByText('2.5 MB')).toBeTruthy();
  });

  it('renders no empty text node for an attachment-only message', async () => {
    const transport = await mountThread();
    const env = attachmentMsg({ from: 'user:u1', attachments: [IMAGE] });
    act(() => { transport.emit(env); });

    await screen.findByRole('img', { name: 'photo.jpg' });
    const bubble = screen.getByTestId('message-bubble');
    // The bubble's only text is the time meta — an empty msg.text must not
    // leave stray paragraph spans or <br> separators behind.
    expect(bubble.querySelector('br')).toBeNull();
    expect(bubble.textContent).toBe(formatTime(env.ts));
  });

  it('renders attachments identically for user- and agent-sent messages', async () => {
    const transport = await mountThread();
    act(() => {
      transport.emit(attachmentMsg({ from: 'agent:assistant', attachments: [IMAGE] }));
      transport.emit(attachmentMsg({ from: 'user:u1', attachments: [IMAGE] }));
    });

    const imgs = await screen.findAllByRole('img', { name: 'photo.jpg' });
    expect(imgs).toHaveLength(2);
    for (const img of imgs) {
      expect(img.getAttribute('src')).toBe(IMAGE.url);
      expect(img.getAttribute('loading')).toBe('lazy');
      const link = img.closest('a');
      expect(link!.getAttribute('target')).toBe('_blank');
      expect(link!.getAttribute('rel')).toBe('noopener noreferrer');
    }
  });

  it('still opens the long-press menu on an attachment bubble (handlers untouched)', async () => {
    const transport = await mountThread();
    act(() => { transport.emit(attachmentMsg({ attachments: [IMAGE] })); });
    const img = await screen.findByRole('img', { name: 'photo.jpg' });

    longPress(img); // press starts ON the attachment; bubbles to the bubble div
    expect(screen.getByRole('menu', { name: 'Message actions' })).toBeTruthy();
  });
});

describe('channel-list preview for attachment-only messages', () => {
  async function mountApp() {
    const transport = new FakeTransport();
    await savePairings([{ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator', 'echo'], epoch: 'e1', pairingId: P1, transportKind: 'ws' }]);
    render(
      <TransportProvider makeTransport={() => transport}>
        <App />
      </TransportProvider>,
    );
    await waitFor(() => expect(screen.getByText('Coordinator')).toBeTruthy());
    return transport;
  }

  it('shows Photo for images, the file name otherwise, and File when unnamed', async () => {
    const transport = await mountApp();
    act(() => {
      transport.emit(attachmentMsg({ channel: 'coordinator', attachments: [IMAGE] }));
      transport.emit(attachmentMsg({ channel: 'echo', attachments: [PDF] }));
    });
    expect(await screen.findByText('Photo')).toBeTruthy();
    expect(await screen.findByText('report.pdf')).toBeTruthy();

    // A nameless non-image falls back to File. Later ts so it becomes the
    // channel's last message deterministically.
    const later = { ...attachmentMsg({ channel: 'echo', attachments: [NAMELESS] }), ts: new Date(Date.now() + 1000).toISOString() };
    act(() => { transport.emit(later); });
    expect(await screen.findByText('File')).toBeTruthy();
  });
});
