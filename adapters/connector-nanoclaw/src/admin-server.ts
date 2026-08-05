import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

export interface AdminPairDeps {
  pair(userId: string): Promise<{ token: string; payload: string; qr: string }>;
  revoke(userId: string): Promise<void>;
}

const BODY_LIMIT = 4096;

function authorized(req: IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const presented = header.slice('Bearer '.length);
  // sha256 both sides so timingSafeEqual always gets equal-length buffers.
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(secret).digest();
  return timingSafeEqual(a, b);
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > BODY_LIMIT) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (raw === '') { resolve({}); return; }
      try { resolve(JSON.parse(raw)); } catch { reject(new Error('invalid json body')); }
    });
    req.on('error', reject);
  });
}

function resolveUserId(body: unknown): string | null {
  if (body === null || typeof body !== 'object') return null;
  const raw = (body as Record<string, unknown>)['userId'];
  if (typeof raw !== 'string') return null;
  const userId = raw.trim();
  return userId.length > 0 ? userId : null;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(payload));
}

/** Minimal pair/revoke admin listener. Separate from the WsHub port because
 *  the hub exposes no custom-route hook and core changes are out of scope.
 *  Binds loopback by default; the caller must pass an explicit host to expose
 *  it (RACCOON_ADMIN_HOST) — it never inherits the hub's bind host. */
export function startAdminServer(opts: {
  port: number;
  host?: string;
  secret: string;
  deps: () => AdminPairDeps | null;
}): Promise<{ port: number; close(): Promise<void> }> {
  const server = createServer(async (req, res) => {
    try {
      const path = (req.url ?? '/').split('?')[0];
      if (path !== '/pair' && path !== '/revoke') { sendJson(res, 404, { error: 'not found' }); return; }
      if (!authorized(req, opts.secret)) { sendJson(res, 401, { error: 'unauthorized' }); return; }
      if ((req.method ?? 'GET').toUpperCase() !== 'POST') { sendJson(res, 405, { error: 'method not allowed (use POST)' }); return; }
      let body: unknown;
      try { body = await readJsonBody(req); } catch (err) { sendJson(res, 400, { error: (err as Error).message }); return; }
      const userId = resolveUserId(body);
      if (!userId) { sendJson(res, 400, { error: 'missing or empty "userId" in request body' }); return; }
      const deps = opts.deps();
      if (!deps) { sendJson(res, 503, { error: 'raccoon endpoint not started' }); return; }
      if (path === '/pair') sendJson(res, 200, await deps.pair(userId));
      else { await deps.revoke(userId); sendJson(res, 200, { ok: true }); }
    } catch (err) {
      console.error('raccoon admin:', err);
      sendJson(res, 500, { error: 'internal' });
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, opts.host ?? '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : opts.port;
      resolve({
        port,
        close: () => new Promise<void>((res2, rej2) => server.close((e) => (e ? rej2(e) : res2()))),
      });
    });
  });
}
