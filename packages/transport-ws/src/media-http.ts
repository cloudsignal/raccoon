// HTTP surface over the media store: upload, capability-URL serving, delete,
// and reference finalization. Host-agnostic: the standalone hub mounts it
// with session-token auth; other hosts mount it with their own verifyBearer
// (and optionally a shared reference secret for server-to-server callers).

import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { MediaStore } from './media-store.js';

const INLINE_SAFE = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
  'video/mp4', 'video/webm',
  'audio/mpeg', 'audio/mp4', 'audio/ogg', 'audio/wav', 'audio/webm',
  'application/pdf', 'text/plain',
]);
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const RATE_LIMIT = 20;              // uploads/min/identity
const REFERENCE_BODY_MAX = 64 * 1024;

export interface MediaHttpAuth {
  verifyBearer(token: string): Promise<string | null>;
  referenceSecret?: string;
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  return h?.startsWith('Bearer ') ? h.slice(7).trim() || null : null;
}
function secretEqual(a: string, b: string): boolean {
  return timingSafeEqual(createHash('sha256').update(a).digest(), createHash('sha256').update(b).digest());
}
function json(res: ServerResponse, status: number, body: unknown): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(s);
}

export function createMediaHttpHandler(store: MediaStore, auth: MediaHttpAuth) {
  // An EMPTY secret must behave as "not configured" — otherwise a compose
  // file exporting MEDIA_REFERENCE_SECRET='' would let any request carrying
  // an empty x-media-secret header perform PERMANENT references.
  const referenceSecret = auth.referenceSecret?.trim() || undefined;
  const rate = new Map<string, { count: number; resetAt: number }>();
  function rateLimited(identity: string): boolean {
    const now = Date.now();
    const e = rate.get(identity);
    if (!e || now > e.resetAt) { rate.set(identity, { count: 1, resetAt: now + 60_000 }); return false; }
    e.count += 1;
    return e.count > RATE_LIMIT;
  }

  async function handleInner(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const path = (() => { try { return decodeURIComponent(new URL(req.url ?? '/', 'http://x').pathname); } catch { return null; } })();
    if (path === null) { json(res, 400, { error: 'bad path' }); return true; }
    if (!path.startsWith('/media')) return false;
    const method = req.method ?? 'GET';

    if (method === 'POST' && path === '/media') {
      const token = bearer(req);
      const identity = token ? await auth.verifyBearer(token) : null;
      if (!identity) { json(res, 401, { error: 'authentication required' }); return true; }
      if (rateLimited(identity)) { json(res, 429, { error: 'too many uploads, slow down' }); return true; }
      // Chunked-bypass guard: Number('') is 0, so a naive parse would make a
      // chunked upload (no Content-Length) reserve ZERO bytes. Absent or
      // non-numeric header => undefined => the store reserves maxFileBytes.
      const rawLength = req.headers['content-length'];
      const declared = typeof rawLength === 'string' && /^\d+$/.test(rawLength) ? Number(rawLength) : undefined;
      if (declared !== undefined && declared > MAX_FILE_BYTES) { json(res, 413, { error: 'file exceeds 25MB' }); return true; }
      const mime = (req.headers['content-type'] ?? 'application/octet-stream').split(';')[0]!.trim();
      let name = 'file';
      const rawName = req.headers['x-raccoon-filename'];
      if (typeof rawName === 'string' && rawName !== '') { try { name = decodeURIComponent(rawName); } catch { name = rawName; } }
      const result = await store.save(req, { mime, name, uploadedBy: identity, declaredLength: declared });
      if (!result.ok) {
        const map = { 'too-large': [413, 'file exceeds 25MB'], quota: [429, 'upload quota exceeded for today'], 'disk-full': [507, 'server storage is full'], empty: [400, 'empty file'] } as const;
        const [status, msg] = map[result.error];
        // The response goes out FIRST; only after it is flushed do we drop a
        // still-streaming request (chunked clients may keep writing).
        json(res, status, { error: msg });
        res.once('finish', () => req.destroy());
        return true;
      }
      json(res, 201, result.attachment);
      return true;
    }

    if (method === 'POST' && path === '/media/reference') {
      // Auth kind decides the TRANSITION: a server-to-server caller holding
      // the shared secret performs the PERMANENT reference (message accepted
      // + persisted); a client bearer gets a renewable LEASE only — so a
      // message that permanently fails or an outbox wiped at unpair can
      // never leak media forever (the lease expires and the sweep reclaims).
      const secretHeader = req.headers['x-media-secret'];
      const viaSecret = typeof secretHeader === 'string' && secretHeader !== '' && referenceSecret !== undefined && secretEqual(secretHeader, referenceSecret);
      const token = bearer(req);
      const viaBearer = !viaSecret && token !== null && (await auth.verifyBearer(token)) !== null;
      if (!viaSecret && !viaBearer) { json(res, 401, { error: 'authentication required' }); return true; }
      const chunks: Buffer[] = [];
      let total = 0;
      for await (const c of req) {
        total += (c as Buffer).length;
        if (total > REFERENCE_BODY_MAX) { json(res, 413, { error: 'body too large' }); return true; }
        chunks.push(c as Buffer);
      }
      let parsed: { paths?: unknown; messageId?: unknown } = {};
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof parsed; } catch { /* 400 below */ }
      const paths = parsed.paths;
      if (!Array.isArray(paths) || !paths.every((p) => typeof p === 'string')) { json(res, 400, { error: 'expected { paths: string[] }' }); return true; }
      const unique = [...new Set(paths as string[])];
      if (unique.length > 4) { json(res, 400, { error: 'at most 4 attachment paths per call' }); return true; }
      const messageId = typeof parsed.messageId === 'string' ? parsed.messageId : undefined;
      const result = viaSecret
        ? await store.reference(unique)
        : await store.lease(unique, messageId ? { messageId } : undefined);
      json(res, 200, result);
      return true;
    }

    const idMatch = /^\/media\/([0-9A-HJKMNP-TV-Z]{26})(\/|$)/.exec(path);
    if (!idMatch) { json(res, 404, { error: 'not found' }); return true; }
    const id = idMatch[1]!;

    if (method === 'GET' || method === 'HEAD') {
      const found = await store.open(id); // fd acquired under the per-id lock
      if (!found) { json(res, 404, { error: 'not found' }); return true; }
      const inline = INLINE_SAFE.has(found.meta.mime);
      res.writeHead(200, {
        'content-type': inline ? found.meta.mime : 'application/octet-stream',
        'content-length': String(found.meta.size),
        'cache-control': 'public, max-age=31536000, immutable',
        'x-content-type-options': 'nosniff',
        ...(inline ? {} : { 'content-disposition': `attachment; filename="${found.meta.name}"` }),
      });
      if (method === 'HEAD') { found.stream.destroy(); res.end(); return true; }
      // fd-backed stream survives a concurrent delete/sweep unlink; the error
      // handler covers I/O failures mid-body (headers already sent → destroy).
      found.stream.on('error', () => res.destroy());
      res.on('close', () => found.stream.destroy());
      found.stream.pipe(res);
      return true;
    }

    if (method === 'DELETE') {
      const token = bearer(req);
      const identity = token ? await auth.verifyBearer(token) : null;
      if (!identity) { json(res, 401, { error: 'authentication required' }); return true; }
      const outcome = await store.delete(id, identity);
      if (outcome === 'deleted') { res.writeHead(204); res.end(); return true; }
      const map = { forbidden: [403, 'not your upload'], referenced: [409, 'already referenced by a message'], missing: [404, 'not found'] } as const;
      const [status, msg] = map[outcome];
      json(res, status, { error: msg });
      return true;
    }

    json(res, 405, { error: 'method not allowed' });
    return true;
  }

  // Error boundary: handle() NEVER rejects — an auth-store outage, fs error,
  // or statfs failure must not become an unhandled rejection that hangs the
  // request (or kills the process). Hosts still add .catch defensively.
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    try {
      return await handleInner(req, res);
    } catch {
      if (!res.headersSent) json(res, 500, { error: 'internal error' });
      else res.destroy();
      return true;
    }
  };
}
