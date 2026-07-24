// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { uploadFile, validateFiles, deleteUpload, leaseUploads, MAX_FILE_BYTES } from './uploads.js';

const provider = { getBearerToken: async () => 'tok-1' };

afterEach(() => { vi.unstubAllGlobals(); });

describe('uploads client', () => {
  it('validateFiles enforces per-message count and per-file size', () => {
    const big = new File([new ArrayBuffer(10)], 'big.bin');
    Object.defineProperty(big, 'size', { value: MAX_FILE_BYTES + 1 });
    const ok = new File(['x'], 'ok.txt');
    const r = validateFiles(3, [ok, ok, big]);
    expect(r.accepted).toHaveLength(1);            // 3 existing + 1 = 4 cap
    expect(r.rejected.map((x) => x.reason)).toEqual(expect.arrayContaining(['too-many', 'too-large']));
  });

  it('validateFiles rejects empty files', () => {
    const empty = new File([], 'empty.txt');
    const r = validateFiles(0, [empty]);
    expect(r.accepted).toHaveLength(0);
    expect(r.rejected).toEqual([{ file: empty, reason: 'empty' }]);
  });

  it('uploadFile POSTs bytes with bearer + filename headers and resolves the attachment', async () => {
    const calls: Record<string, string> = {};
    class FakeXHR {
      upload = { onprogress: null as null | ((e: ProgressEvent) => void) };
      onload: null | (() => void) = null;
      onerror: null | (() => void) = null;
      status = 201;
      responseText = JSON.stringify({ url: '/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.txt', mime: 'text/plain', name: 'a.txt', size: 1 });
      open(m: string, u: string) { calls.method = m; calls.url = u; }
      setRequestHeader(k: string, v: string) { calls[k.toLowerCase()] = v; }
      send() { this.upload.onprogress?.({ loaded: 1, total: 1 } as ProgressEvent); this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const progress: number[] = [];
    const a = await uploadFile(new File(['x'], 'a.txt', { type: 'text/plain' }), provider, { onProgress: (f) => progress.push(f) });
    expect(calls.method).toBe('POST');
    expect(calls.url).toBe('/media');
    expect(calls.authorization).toBe('Bearer tok-1');
    expect(calls['x-raccoon-filename']).toBe(encodeURIComponent('a.txt'));
    expect(a.url).toContain('/media/');
    expect(progress.at(-1)).toBe(1);
  });

  it('uploadFile rejects with the server reason on non-2xx', async () => {
    class FakeXHR {
      upload = { onprogress: null }; onload: null | (() => void) = null; onerror = null;
      status = 429; responseText = JSON.stringify({ error: 'upload quota exceeded for today' });
      open() {} setRequestHeader() {} send() { this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    await expect(uploadFile(new File(['x'], 'a'), provider)).rejects.toThrow('upload quota exceeded for today');
  });

  it('deleteUpload / leaseUploads hit the right endpoints with bearer auth; abort cancels the XHR', async () => {
    // Typed rest args so .mock.lastCall![1] is indexable under tsc (a zero-arg
    // vi.fn() types its call tuple as [] and rejects the [1] access).
    const fetchSpy = vi.fn(async (..._args: unknown[]) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetchSpy);
    await deleteUpload({ url: '/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.txt', mime: 'text/plain' }, provider);
    expect(fetchSpy).toHaveBeenCalledWith('/media/01ARZ3NDEKTSV4RRFFQ69G5FAV', expect.objectContaining({ method: 'DELETE' }));
    await leaseUploads(['/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.txt'], 'env-123', provider);
    expect(fetchSpy).toHaveBeenLastCalledWith('/media/reference', expect.objectContaining({ method: 'POST' }));
    expect(JSON.parse((fetchSpy.mock.lastCall![1] as { body: string }).body)).toEqual({ paths: ['/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.txt'], messageId: 'env-123' });
  });

  it('abort BEFORE the token resolves rejects with AbortError and never creates an XHR', async () => {
    let constructed = 0;
    class FakeXHR { constructor() { constructed += 1; } upload = { onprogress: null }; open() {} setRequestHeader() {} send() {} abort() {} }
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    let releaseToken!: (t: string) => void;
    const slowProvider = { getBearerToken: () => new Promise<string>((r) => { releaseToken = r; }) };
    const controller = new AbortController();
    const p = uploadFile(new File(['x'], 'a'), slowProvider, { signal: controller.signal });
    controller.abort();          // fires while the token is still pending
    releaseToken('tok-late');    // token arrives after the abort
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(constructed).toBe(0); // the corrected pre/post-token checks stop the XHR from ever existing
  });

  it('abort MID-FLIGHT calls xhr.abort() and rejects with AbortError', async () => {
    let aborted = false;
    let sendStarted!: () => void;
    const sent = new Promise<void>((r) => { sendStarted = r; });
    class FakeXHR {
      upload = { onprogress: null }; onload = null; onerror: null | (() => void) = null;
      onabort: null | (() => void) = null;
      open() {} setRequestHeader() {} send() { sendStarted(); }
      abort() { aborted = true; this.onabort?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const controller = new AbortController();
    const p = uploadFile(new File(['x'], 'a'), provider, { signal: controller.signal });
    await sent;                  // XHR exists and is in flight
    controller.abort();
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(aborted).toBe(true);
  });

  it('leaseUploads never rejects: token failure and network failure resolve { ok: false }', async () => {
    const failingProvider = { getBearerToken: async () => { throw new Error('no session'); } };
    await expect(leaseUploads(['/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.txt'], 'env-1', failingProvider)).resolves.toEqual({ ok: false, unknown: [] });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('network down'); }));
    await expect(leaseUploads(['/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.txt'], 'env-1', provider)).resolves.toEqual({ ok: false, unknown: [] });
  });

  it('leaseUploads reports server-unknown paths and short-circuits on empty input', async () => {
    const fetchSpy = vi.fn(async () => new Response(JSON.stringify({ known: [], unknown: ['/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.txt'] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    await expect(leaseUploads(['/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.txt'], 'env-1', provider))
      .resolves.toEqual({ ok: true, unknown: ['/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.txt'] });
    await expect(leaseUploads([], 'env-1', provider)).resolves.toEqual({ ok: true, unknown: [] });
    expect(fetchSpy).toHaveBeenCalledTimes(1); // empty input never hits the network
  });

  it('deleteUpload never rejects: token failure, bad path, and network failure all resolve', async () => {
    const failingProvider = { getBearerToken: async () => { throw new Error('no session'); } };
    await expect(deleteUpload({ url: '/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.txt', mime: 'text/plain' }, failingProvider)).resolves.toBeUndefined();
    const fetchSpy = vi.fn(async () => { throw new TypeError('network down'); });
    vi.stubGlobal('fetch', fetchSpy);
    await expect(deleteUpload({ url: '/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.txt', mime: 'text/plain' }, provider)).resolves.toBeUndefined();
    // A malformed path (no hub-issued id) is skipped without any request.
    fetchSpy.mockClear();
    await expect(deleteUpload({ url: '/media/not-an-id/a.txt', mime: 'text/plain' }, provider)).resolves.toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('uploadFile prefixes provider.baseUrl on the endpoint', async () => {
    const calls: Record<string, string> = {};
    class FakeXHR {
      upload = { onprogress: null };
      onload: null | (() => void) = null;
      onerror = null;
      status = 201;
      responseText = JSON.stringify({ url: '/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/a.txt', mime: 'text/plain' });
      open(m: string, u: string) { calls.method = m; calls.url = u; }
      setRequestHeader() {}
      send() { this.onload?.(); }
    }
    vi.stubGlobal('XMLHttpRequest', FakeXHR as unknown as typeof XMLHttpRequest);
    const based = { baseUrl: 'https://media.example.com', getBearerToken: async () => 'tok-1' };
    await uploadFile(new File(['x'], 'a.txt'), based);
    expect(calls.url).toBe('https://media.example.com/media');
  });
});
