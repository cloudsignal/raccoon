// @vitest-environment jsdom
import 'fake-indexeddb/auto';
import { act, cleanup, createEvent, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Attachment, Envelope } from '@raccoon/protocol';
import { closeDbForTests } from '../lib/idb.js';
import { isUpdateHeld } from '../lib/update-hold.js';
import * as outbox from '../lib/outbox.js';
import { savePairings } from '../lib/session.js';
import { deleteUpload, leaseUploads, MAX_FILE_BYTES, uploadFile } from '../lib/uploads.js';
import { FakeTransport } from '../transport/fake.js';
import { TransportProvider } from '../transport/context.js';
import { Composer } from './composer.js';
import { Thread } from './thread.js';

const P1 = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const CK = `${P1}/coordinator`;

// Network-touching functions are mocked (opts-object signature preserved);
// validateFiles / MAX_* stay REAL — the admission logic is under test.
vi.mock('../lib/uploads.js', async (orig) => ({
  ...(await orig<typeof import('../lib/uploads.js')>()),
  uploadFile: vi.fn(),
  deleteUpload: vi.fn(),
  leaseUploads: vi.fn(),
}));

const ATT: Attachment = { url: '/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.png', mime: 'image/png', name: 'a.png', size: 3 };

// jsdom has no object-URL API — the composer mints previews at admission and
// revokes on remove/send/unmount, so stub both and spy.
const urlApi = URL as unknown as {
  createObjectURL?: (blob: Blob) => string;
  revokeObjectURL?: (url: string) => void;
};

let objectUrlSeq = 0;
beforeEach(() => {
  vi.mocked(uploadFile).mockImplementation(async (_f, _p, opts) => { opts?.onProgress?.(1); return ATT; });
  vi.mocked(deleteUpload).mockResolvedValue(undefined);
  vi.mocked(leaseUploads).mockResolvedValue({ ok: true, unknown: [] });
  objectUrlSeq = 0;
  urlApi.createObjectURL = vi.fn(() => `blob:preview-${objectUrlSeq++}`);
  urlApi.revokeObjectURL = vi.fn();
});

afterEach(async () => {
  cleanup(); // unmount BEFORE the URL stubs disappear (unmount revokes previews)
  vi.mocked(uploadFile).mockReset();
  vi.mocked(deleteUpload).mockReset();
  vi.mocked(leaseUploads).mockReset();
  delete urlApi.createObjectURL;
  delete urlApi.revokeObjectURL;
  await closeDbForTests();
});

async function mount(opts: { thread?: boolean } = {}) {
  const transport = new FakeTransport();
  await savePairings([{ url: 'ws://x/', sessionToken: 't', userId: 'u1', instance: 'i', channels: ['coordinator'], epoch: 'e1', pairingId: P1, transportKind: 'ws' }]);
  render(
    <TransportProvider makeTransport={() => transport}>
      {opts.thread ? <Thread channel={CK} /> : null}
      <Composer channel={CK} />
    </TransportProvider>,
  );
  await waitFor(() => expect(transport.connected).toBe(true));
  return transport;
}

const imageFile = (name: string, content = 'img-bytes') => new File([content], name, { type: 'image/png' });
const textFile = (name: string, content = 'text-bytes') => new File([content], name, { type: 'text/plain' });
const sentMsgs = (t: FakeTransport) => t.sent.filter((e): e is Envelope<'msg'> => e.kind === 'msg');
const sendButton = () => screen.getByRole('button', { name: /send message/i }) as HTMLButtonElement;
const composerBox = () => screen.getByPlaceholderText(/message coordinator/i);

function pickFiles(files: File[]) {
  const input = screen.getByTestId('file-input') as HTMLInputElement;
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  fireEvent.change(input);
}

describe('Composer', () => {
  it('sends on button tap and clears + releases the update hold', async () => {
    const transport = await mount();
    const user = userEvent.setup();
    const box = composerBox();
    await user.type(box, 'hello there');
    expect(isUpdateHeld()).toBe(true);
    await user.click(sendButton());
    await waitFor(() => expect(sentMsgs(transport)).toHaveLength(1));
    expect((box as HTMLTextAreaElement).value).toBe('');
    expect(isUpdateHeld()).toBe(false);
  });

  it('sends on Enter, keeps newline on Shift+Enter', async () => {
    const transport = await mount();
    const user = userEvent.setup();
    const box = composerBox();
    await user.type(box, 'line one{Shift>}{Enter}{/Shift}line two');
    expect(sentMsgs(transport)).toHaveLength(0);
    await user.type(box, '{Enter}');
    await waitFor(() => expect(sentMsgs(transport)).toHaveLength(1));
    const sent = sentMsgs(transport)[0]!;
    expect(sent.payload.text).toContain('line one\nline two');
  });

  it('does not send blank input', async () => {
    const transport = await mount();
    await userEvent.setup().click(sendButton());
    expect(sentMsgs(transport)).toHaveLength(0);
  });
});

describe('Composer attachments', () => {
  it('adds a chip and starts the upload when files are picked', async () => {
    await mount();
    pickFiles([imageFile('a.png')]);
    expect(screen.getAllByTestId(/^chip-/)).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(1);
    const [file, provider, opts] = vi.mocked(uploadFile).mock.calls[0]!;
    expect(file.name).toBe('a.png');
    expect(provider.getBearerToken).toBeTypeOf('function');
    expect(opts?.signal).toBeInstanceOf(AbortSignal);
    expect(opts?.onProgress).toBeTypeOf('function');
  });

  it('adds a chip on paste of clipboard files', async () => {
    await mount();
    fireEvent.paste(composerBox(), { clipboardData: { files: [imageFile('pasted.png')] } });
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(1);
  });

  it('adds a chip on drop and toggles the drop-active ring', async () => {
    await mount();
    const root = screen.getByTestId('composer-root');
    fireEvent.dragOver(root);
    expect(root.className).toContain('ring-2');
    fireEvent.drop(root, { dataTransfer: { files: [textFile('notes.txt')] } });
    expect(root.className).not.toContain('ring-2');
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    expect(screen.getByText('notes.txt')).toBeTruthy();
  });

  it('admits exactly 4 across a simultaneous paste + drop (ref-serialized admission)', async () => {
    await mount();
    const box = composerBox();
    const root = screen.getByTestId('composer-root');
    // Both admission events dispatched back-to-back inside ONE act() — only
    // the synchronous ref can serialize the two counts correctly.
    const paste = createEvent.paste(box, { clipboardData: { files: [imageFile('1.png'), imageFile('2.png'), imageFile('3.png')] } });
    const drop = createEvent.drop(root, { dataTransfer: { files: [imageFile('4.png'), imageFile('5.png')] } });
    act(() => {
      fireEvent(box, paste);
      fireEvent(root, drop);
    });
    await waitFor(() => expect(screen.getAllByTestId(/^chip-/)).toHaveLength(4));
    expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(4);
    expect(await screen.findByText(/up to 4 per message/)).toBeTruthy();
  });

  it('shows a transient notice for empty and oversized files', async () => {
    await mount();
    const big = imageFile('big.png');
    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });
    pickFiles([new File([], 'empty.bin', { type: 'application/octet-stream' }), big]);
    expect(await screen.findByText(/empty file/)).toBeTruthy();
    expect(screen.getByText(/over 25MB/)).toBeTruthy();
    expect(screen.queryAllByTestId(/^chip-/)).toHaveLength(0);
    expect(vi.mocked(uploadFile)).not.toHaveBeenCalled();
  });

  it('disables send while a chip is uploading', async () => {
    const transport = await mount();
    let resolveUpload!: (a: Attachment) => void;
    vi.mocked(uploadFile).mockImplementation(() => new Promise<Attachment>((res) => { resolveUpload = res; }));
    pickFiles([imageFile('a.png')]);
    expect(screen.getByTestId('chip-uploading')).toBeTruthy();
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(sendButton());
    expect(sentMsgs(transport)).toHaveLength(0);
    act(() => resolveUpload(ATT));
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    expect(sendButton().disabled).toBe(false);
  });

  it('a failed chip blocks send; retry re-runs the upload', async () => {
    const transport = await mount();
    vi.mocked(uploadFile).mockRejectedValueOnce(new Error('upload failed (500)'));
    pickFiles([imageFile('a.png')]);
    await waitFor(() => expect(screen.getByTestId('chip-failed')).toBeTruthy());
    await userEvent.setup().type(composerBox(), 'hello');
    expect(sendButton().disabled).toBe(true);
    fireEvent.click(sendButton());
    expect(sentMsgs(transport)).toHaveLength(0);
    // Retry flips the chip back to uploading and re-runs uploadFile (the
    // default mock now succeeds).
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    expect(vi.mocked(uploadFile)).toHaveBeenCalledTimes(2);
    expect(sendButton().disabled).toBe(false);
  });

  it('removing an uploading chip aborts its upload and removes it silently', async () => {
    await mount();
    let signal: AbortSignal | undefined;
    vi.mocked(uploadFile).mockImplementation((_f, _p, opts) => new Promise<Attachment>((_res, reject) => {
      signal = opts?.signal;
      opts?.signal?.addEventListener('abort', () => {
        const err = new Error('upload canceled');
        err.name = 'AbortError';
        reject(err);
      });
    }));
    pickFiles([imageFile('a.png')]);
    expect(screen.getByTestId('chip-uploading')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(signal?.aborted).toBe(true);
    expect(screen.queryAllByTestId(/^chip-/)).toHaveLength(0);
    // Let the AbortError rejection settle: no failed chip reappears, and an
    // aborted (never-completed) upload is not deleteUpload'ed.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId('chip-failed')).toBeNull();
    expect(vi.mocked(deleteUpload)).not.toHaveBeenCalled();
    expect(urlApi.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('removing a done chip revokes its preview and best-effort deletes the upload', async () => {
    await mount();
    pickFiles([imageFile('a.png')]);
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    const preview = (vi.mocked(urlApi.createObjectURL!).mock.results[0]!).value as string;
    fireEvent.click(screen.getByRole('button', { name: 'Remove a.png' }));
    expect(screen.queryAllByTestId(/^chip-/)).toHaveLength(0);
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith(preview);
    expect(vi.mocked(deleteUpload)).toHaveBeenCalledWith(ATT, expect.objectContaining({ getBearerToken: expect.any(Function) }));
  });

  it('revokes previews on unmount', async () => {
    await mount();
    pickFiles([imageFile('a.png')]);
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    cleanup();
    expect(urlApi.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('sends text + attachments once all chips are done, clears chips, revokes previews', async () => {
    const transport = await mount();
    pickFiles([imageFile('a.png')]);
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    const preview = (vi.mocked(urlApi.createObjectURL!).mock.results[0]!).value as string;
    const box = composerBox();
    await userEvent.setup().type(box, 'with a picture');
    fireEvent.click(sendButton());
    await waitFor(() => expect(sentMsgs(transport)).toHaveLength(1));
    const sent = sentMsgs(transport)[0]!;
    expect(sent.payload.text).toBe('with a picture');
    expect(sent.payload.attachments).toEqual([ATT]);
    expect(screen.queryAllByTestId(/^chip-/)).toHaveLength(0);
    expect((box as HTMLTextAreaElement).value).toBe('');
    expect(urlApi.revokeObjectURL).toHaveBeenCalledWith(preview);
  });

  it('allows attachment-only send with empty text', async () => {
    const transport = await mount();
    pickFiles([imageFile('a.png')]);
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    fireEvent.click(sendButton());
    await waitFor(() => expect(sentMsgs(transport)).toHaveLength(1));
    const sent = sentMsgs(transport)[0]!;
    expect(sent.payload.text).toBe('');
    expect(sent.payload.attachments).toEqual([ATT]);
    expect(screen.queryAllByTestId(/^chip-/)).toHaveLength(0);
  });
});

describe('Composer attachments — outbox lease', () => {
  it('leases uploads at enqueue time, before any delivery', async () => {
    const transport = await mount();
    pickFiles([imageFile('a.png')]);
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    // Take the transport offline: the enqueue .then must still fire the lease
    // (durable row committed) even though no delivery can happen yet.
    act(() => transport.setStatus('closed'));
    fireEvent.click(sendButton());
    await waitFor(() => expect(vi.mocked(leaseUploads)).toHaveBeenCalledTimes(1));
    expect(sentMsgs(transport)).toHaveLength(0);
    const [paths, messageId, provider] = vi.mocked(leaseUploads).mock.calls[0]!;
    expect(paths).toEqual([ATT.url]);
    expect(provider.getBearerToken).toBeTypeOf('function');
    // Reconnect: the drain delivers the SAME envelope the lease referenced.
    act(() => transport.setStatus('open'));
    await waitFor(() => expect(sentMsgs(transport)).toHaveLength(1));
    expect(sentMsgs(transport)[0]!.id).toBe(messageId);
  });

  it('awaits the drain-time lease before transport.send', async () => {
    const transport = await mount();
    const resolvers: Array<(v: { ok: boolean; unknown: string[] }) => void> = [];
    vi.mocked(leaseUploads).mockImplementation(() => new Promise((res) => { resolvers.push(res); }));
    pickFiles([imageFile('a.png')]);
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    fireEvent.click(sendButton());
    // Enqueue-time (fire-and-forget) and drain-time (awaited) lease calls are
    // both pending — the delivery must be blocked on the drain-time one.
    await waitFor(() => expect(vi.mocked(leaseUploads).mock.calls.length).toBeGreaterThanOrEqual(2));
    expect(sentMsgs(transport)).toHaveLength(0);
    for (const resolve of resolvers) resolve({ ok: true, unknown: [] });
    await waitFor(() => expect(sentMsgs(transport)).toHaveLength(1));
    expect(sentMsgs(transport)[0]!.payload.attachments).toEqual([ATT]);
  });

  it('marks the row terminally failed (no send, no retry) when the lease reports unknown paths', async () => {
    const transport = await mount({ thread: true });
    vi.mocked(leaseUploads).mockResolvedValue({ ok: true, unknown: [ATT.url] });
    pickFiles([imageFile('a.png')]);
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    await userEvent.setup().type(composerBox(), 'doomed');
    fireEvent.click(sendButton());
    expect(await screen.findByText('Attachments expired — remove and re-attach')).toBeTruthy();
    expect(sentMsgs(transport)).toHaveLength(0);
    // No retry affordance for this row — re-attaching creates a fresh message.
    expect(screen.queryByText(/tap to retry/i)).toBeNull();
    // The durable row is failed-terminal with the expired reason.
    const rows = await outbox.listForChannel('coordinator');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('failed');
    expect(rows[0]!.lastError).toBe('attachments-expired');
  });

  it('still sends when the lease call itself fails (ok:false)', async () => {
    const transport = await mount();
    vi.mocked(leaseUploads).mockResolvedValue({ ok: false, unknown: [] });
    pickFiles([imageFile('a.png')]);
    await waitFor(() => expect(screen.getByTestId('chip-done')).toBeTruthy());
    fireEvent.click(sendButton());
    await waitFor(() => expect(sentMsgs(transport)).toHaveLength(1));
    expect(sentMsgs(transport)[0]!.payload.attachments).toEqual([ATT]);
  });
});
