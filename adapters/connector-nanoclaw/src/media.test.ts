import { describe, expect, it, vi } from 'vitest';
import type { AnyEnvelope } from '@raccoon/protocol';
import { absolutizeMediaPaths, deliverFilesAsAttachments, toNanoClawAttachments } from './media.js';

const ORIGIN = 'http://host.docker.internal:8790';

describe('toNanoClawAttachments', () => {
  it('absolutizes and types by mime major', () => {
    expect(
      toNanoClawAttachments(
        [
          { url: '/media/01ABC/photo.png', mime: 'image/png', name: 'photo.png' },
          { url: '/media/01DEF/clip.mp4', mime: 'video/mp4' },
          { url: '/media/01GHI/doc.pdf', mime: 'application/pdf' },
        ],
        ORIGIN,
      ),
    ).toEqual([
      { type: 'image', url: `${ORIGIN}/media/01ABC/photo.png` },
      { type: 'video', url: `${ORIGIN}/media/01DEF/clip.mp4` },
      { type: 'file', url: `${ORIGIN}/media/01GHI/doc.pdf` },
    ]);
  });
  it('handles undefined', () => {
    expect(toNanoClawAttachments(undefined, ORIGIN)).toEqual([]);
  });
});

describe('absolutizeMediaPaths', () => {
  it('rewrites hub media paths inside text', () => {
    expect(absolutizeMediaPaths('see /media/01ABC/x.png ok', ORIGIN)).toBe(`see ${ORIGIN}/media/01ABC/x.png ok`);
  });
  it('leaves already-absolute urls and non-media paths alone', () => {
    const s = `${ORIGIN}/media/01ABC/x.png and /medial/nope and /other/path`;
    expect(absolutizeMediaPaths(s, ORIGIN)).toBe(s);
  });
});

describe('deliverFilesAsAttachments', () => {
  function fakes() {
    const sent: AnyEnvelope[] = [];
    const send = vi.fn(async (_u: string, env: AnyEnvelope) => (sent.push(env), true));
    const media = {
      save: vi.fn(async (_body: NodeJS.ReadableStream, opts: { mime: string; name: string }) => ({
        ok: true as const,
        // Protocol schema requires a real ULID media id in attachment urls.
        attachment: { url: `/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/${opts.name}`, mime: opts.mime, name: opts.name },
      })),
    };
    return { sent, send, media };
  }

  it('saves files and sends one msg with attachments and text', async () => {
    const { sent, send, media } = fakes();
    const n = await deliverFilesAsAttachments({ media, send }, 'assistant', 'u1', [
      { filename: 'a.png', data: Buffer.from('x') },
      { filename: 'b.bin', data: Buffer.from('y') },
    ], 'here you go');
    expect(n).toBe(1);
    expect(media.save).toHaveBeenCalledTimes(2);
    expect(media.save.mock.calls[0]![1]).toMatchObject({ mime: 'image/png', name: 'a.png', uploadedBy: 'agent:assistant' });
    const env = sent[0]!;
    expect(env.kind).toBe('msg');
    expect((env.payload as { text: string }).text).toBe('here you go');
    expect((env.payload as { attachments: unknown[] }).attachments).toHaveLength(2);
  });

  it('chunks at 4 attachments per envelope, text on the first only', async () => {
    const { sent, send, media } = fakes();
    const files = Array.from({ length: 5 }, (_, i) => ({ filename: `f${i}.png`, data: Buffer.from('x') }));
    const n = await deliverFilesAsAttachments({ media, send }, 'assistant', 'u1', files, 'five files');
    expect(n).toBe(2);
    expect((sent[0]!.payload as { attachments: unknown[] }).attachments).toHaveLength(4);
    expect((sent[1]!.payload as { attachments: unknown[] }).attachments).toHaveLength(1);
    expect((sent[1]!.payload as { text: string }).text).toBe('');
  });

  it('all saves fail with no text: still sends one msg carrying the failure notice', async () => {
    const { sent, send } = fakes();
    const media = { save: vi.fn(async () => ({ ok: false as const, error: 'too-large' as const })) };
    const n = await deliverFilesAsAttachments({ media, send }, 'assistant', 'u1', [{ filename: 'a.png', data: Buffer.from('x') }], '');
    expect(n).toBe(1);
    expect(sent).toHaveLength(1);
    expect((sent[0]!.payload as { text: string }).text).toBe('[1 attachment(s) could not be transferred]');
    expect((sent[0]!.payload as { attachments?: unknown[] }).attachments).toBeUndefined();
  });

  it('partial failure: appends the failure notice to the first envelope text', async () => {
    const { sent, send } = fakes();
    // ok.png saves; broken.png fails.
    const media = {
      save: vi.fn(async (_body: NodeJS.ReadableStream, opts: { mime: string; name: string }) =>
        opts.name === 'broken.png'
          ? { ok: false as const, error: 'too-large' as const }
          : {
              ok: true as const,
              attachment: { url: `/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/${opts.name}`, mime: opts.mime, name: opts.name },
            }),
    };
    const n = await deliverFilesAsAttachments({ media, send }, 'assistant', 'u1', [
      { filename: 'ok.png', data: Buffer.from('x') },
      { filename: 'broken.png', data: Buffer.from('y') },
    ], 'here you go');
    expect(n).toBe(1);
    expect((sent[0]!.payload as { text: string }).text)
      .toBe('here you go\n[1 of 2 attachments could not be transferred]');
    expect((sent[0]!.payload as { attachments: unknown[] }).attachments).toHaveLength(1);
  });
});
