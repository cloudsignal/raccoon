// Upload client for composer attachments. XHR (not fetch) for real upload
// progress events. Auth is host-pluggable: the standalone PWA presents its
// WS session token; an embedding host injects its own provider (it may have
// a rotating external token instead of a session token).
import type { Attachment } from '@raccoon/protocol';

export interface UploadProvider { baseUrl?: string; getBearerToken(): Promise<string>; }
export const MAX_ATTACHMENTS = 4;
export const MAX_FILE_BYTES = 25 * 1024 * 1024;

export function validateFiles(existingCount: number, files: File[]): { accepted: File[]; rejected: { file: File; reason: string }[] } {
  const accepted: File[] = [];
  const rejected: { file: File; reason: string }[] = [];
  for (const file of files) {
    if (file.size === 0) { rejected.push({ file, reason: 'empty' }); continue; }
    if (file.size > MAX_FILE_BYTES) { rejected.push({ file, reason: 'too-large' }); continue; }
    if (existingCount + accepted.length >= MAX_ATTACHMENTS) { rejected.push({ file, reason: 'too-many' }); continue; }
    accepted.push(file);
  }
  return { accepted, rejected };
}

export async function uploadFile(
  file: File,
  provider: UploadProvider,
  opts: { onProgress?: (fraction: number) => void; signal?: AbortSignal } = {},
): Promise<Attachment> {
  const abortError = () => { const err = new Error('upload canceled'); err.name = 'AbortError'; return err; };
  // The abort listener only exists once the XHR does — cover the window
  // where the signal fires while the token is still being acquired.
  if (opts.signal?.aborted) throw abortError();
  const token = await provider.getBearerToken();
  if (opts.signal?.aborted) throw abortError();
  const base = provider.baseUrl ?? '';
  return new Promise<Attachment>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const onAbort = () => { xhr.abort(); };
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const settle = <T,>(fn: (v: T) => void) => (v: T) => { opts.signal?.removeEventListener('abort', onAbort); fn(v); };
    xhr.open('POST', `${base}/media`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.setRequestHeader('X-Raccoon-Filename', encodeURIComponent(file.name || 'file'));
    xhr.upload.onprogress = (e) => { if (e.total > 0) opts.onProgress?.(e.loaded / e.total); };
    xhr.onabort = settle(() => reject(abortError()));
    xhr.onerror = settle(() => reject(new Error('upload failed, check your connection')));
    xhr.onload = settle(() => {
      let body: { error?: string } & Partial<Attachment> = {};
      try { body = JSON.parse(xhr.responseText) as typeof body; } catch { /* fall through */ }
      if (xhr.status === 201 && typeof body.url === 'string') resolve(body as Attachment);
      else reject(new Error(body.error ?? `upload failed (${xhr.status})`));
    });
    xhr.send(file);
  });
}

function idOf(url: string): string | null {
  const m = /^\/media\/([0-9A-HJKMNP-TV-Z]{26})\//.exec(url);
  return m ? m[1]! : null;
}

export async function deleteUpload(attachment: Attachment, provider: UploadProvider): Promise<void> {
  try {
    const id = idOf(attachment.url);
    if (!id) return;
    const token = await provider.getBearerToken(); // inside the try — never rejects
    await fetch(`${provider.baseUrl ?? ''}/media/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  } catch { /* best-effort */ }
}

/** Client-side keep-alive at outbox-enqueue AND before every delivery
 *  attempt: POST /media/reference with a bearer token yields a renewable
 *  LEASE (the server-side accept performs the permanent reference).
 *  messageId = the envelope id, for debuggability. NEVER rejects — token
 *  acquisition and fetch failures resolve { ok: false } so fire-and-forget
 *  callers cannot leak unhandled rejections; `unknown` reports paths the
 *  server no longer knows (expired lease + swept bytes). */
export async function leaseUploads(paths: string[], messageId: string, provider: UploadProvider): Promise<{ ok: boolean; unknown: string[] }> {
  if (paths.length === 0) return { ok: true, unknown: [] };
  try {
    const token = await provider.getBearerToken(); // inside the try: a token failure must not escape fire-and-forget callers
    const res = await fetch(`${provider.baseUrl ?? ''}/media/reference`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths, messageId }),
    });
    if (!res.ok) return { ok: false, unknown: [] };
    const body = (await res.json()) as { unknown?: unknown };
    return { ok: true, unknown: Array.isArray(body.unknown) ? body.unknown.filter((u): u is string => typeof u === 'string') : [] };
  } catch {
    return { ok: false, unknown: [] };
  }
}
