// Media store for hub uploads (capability-URL model).
//
// Layout: <dir>/<id>/blob (bytes, FIXED internal name — never client-named)
//         <dir>/<id>/meta.json { mime, name, size, uploadedBy, ts, referenced, lease? }
//         <dir>/tmp/<id> (in-flight upload, atomically renamed into place)
//
// Lifecycle (3-state): unreferenced → leased → referenced.
//   - lease(): client keep-alive (outbox-enqueue) — 7 days, renewable. A
//     message that permanently fails or an outbox wiped at unpair leaves
//     only a lease, which EXPIRES — no permanent leak from a boolean flip.
//   - reference(): server-side permanent transition once a message is
//     accepted and persisted (standalone hub on routing / downstream bridge).
//   - sweep(): deletes entries that are not referenced, have no unexpired
//     lease, and are older than the horizon.
// delete() is owner-only and only while unreferenced (a lease does not
// block the owner deleting their own pending upload).
//
// Admission control RESERVES capacity before any body byte is read:
// declaredLength ?? maxFileBytes is charged against the identity's rolling
// 24h ledger and the global total under a store-wide admission lock, then
// reconciled to the actual size on completion (fully released on failure).
// The ledger outlives deletion — delete-reupload cannot launder quota. It
// is in-memory: a restart resets it (documented v1 bound).
//
// reference/lease/delete/sweep serialize PER-ID and re-read meta under the
// lock; open() acquires the fd under the same lock, so a stream stays valid
// (POSIX) even if delete/sweep unlinks the path a moment later.

import type { ReadStream } from 'node:fs';
import { createWriteStream } from 'node:fs';
import { mkdir, open as fsOpen, readFile, readdir, rename, rm, statfs, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { PassThrough, Transform } from 'node:stream';
import type { Attachment } from '@raccoon/protocol';

const ULID_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const DEFAULT_MAX_FILE = 25 * 1024 * 1024;
const DEFAULT_MAX_TOTAL = 5 * 1024 * 1024 * 1024;
const DEFAULT_IDENTITY_QUOTA = 250 * 1024 * 1024;
const DEFAULT_MIN_FREE = 1024 * 1024 * 1024;
const QUOTA_WINDOW_MS = 24 * 60 * 60 * 1000;
const LEASE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type SaveError = 'too-large' | 'quota' | 'disk-full' | 'empty';
export interface MediaMeta {
  mime: string; name: string; size: number; uploadedBy: string; ts: number;
  referenced: boolean;
  lease?: { expiresAt: number; messageId?: string };
}
export interface MediaStoreOptions {
  dir: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  identityQuotaBytes?: number;
  minFreeBytes?: number;
  freeBytes?: () => Promise<number>;
  now?: () => number;
}
export interface MediaStore {
  save(body: NodeJS.ReadableStream, opts: { mime: string; name: string; uploadedBy: string; declaredLength?: number }): Promise<{ ok: true; attachment: Attachment } | { ok: false; error: SaveError }>;
  open(id: string): Promise<{ meta: MediaMeta; stream: ReadStream } | null>;
  lease(paths: string[], opts?: { messageId?: string }): Promise<{ known: Attachment[]; unknown: string[] }>;
  reference(paths: string[]): Promise<{ known: Attachment[]; unknown: string[] }>;
  delete(id: string, requester: string): Promise<'deleted' | 'forbidden' | 'referenced' | 'missing'>;
  sweep(olderThanMs?: number): Promise<{ deleted: number; bytesFreed: number; totalBytes: number }>;
  sanitizeName(raw: string): string;
}

function newId(): string {
  const bytes = randomBytes(26);
  let out = '';
  for (let i = 0; i < 26; i++) out += ULID_ALPHABET[bytes[i]! % 32];
  return out;
}

export function sanitizeName(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 80);
  if (cleaned === '' || /^\.+$/.test(cleaned)) return 'file';
  return cleaned;
}

const ID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PATH_RE = /^\/media\/([0-9A-HJKMNP-TV-Z]{26})\/[A-Za-z0-9._-]{1,80}$/;

export function createMediaStore(opts: MediaStoreOptions): MediaStore {
  const dir = opts.dir;
  const maxFile = opts.maxFileBytes ?? DEFAULT_MAX_FILE;
  const maxTotal = opts.maxTotalBytes ?? DEFAULT_MAX_TOTAL;
  const identityQuota = opts.identityQuotaBytes ?? DEFAULT_IDENTITY_QUOTA;
  const minFree = opts.minFreeBytes ?? DEFAULT_MIN_FREE;
  const now = opts.now ?? Date.now;
  const freeBytes = opts.freeBytes ?? (async () => {
    const s = await statfs(dir);
    return Number(s.bavail) * Number(s.bsize);
  });

  // Root + tmp dirs exist before ANY statfs/quota/save path runs — a fresh
  // deployment must not fail its first upload on a missing directory.
  const ready = mkdir(join(dir, 'tmp'), { recursive: true });

  // ---- admission ledger (identity rolling window + global total) ----------
  const ledger = new Map<string, Array<{ ts: number; bytes: number }>>();
  let globalTotal: number | null = null; // seeded lazily from disk
  let admissionChain: Promise<unknown> = Promise.resolve();
  function withAdmission<T>(fn: () => Promise<T>): Promise<T> {
    const run = admissionChain.then(fn, fn);
    admissionChain = run.catch(() => undefined);
    return run;
  }
  function chargedInWindow(identity: string, nowMs: number): number {
    const entries = (ledger.get(identity) ?? []).filter((e) => nowMs - e.ts < QUOTA_WINDOW_MS);
    ledger.set(identity, entries);
    return entries.reduce((sum, e) => sum + e.bytes, 0);
  }
  async function seedGlobalTotal(): Promise<number> {
    if (globalTotal !== null) return globalTotal;
    let sum = 0;
    for (const id of await listIds()) {
      const meta = await readMeta(id);
      if (meta) sum += meta.size;
    }
    globalTotal = sum;
    return sum;
  }

  // ---- per-id mutex --------------------------------------------------------
  const locks = new Map<string, Promise<unknown>>();
  function withLock<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const prev = locks.get(id) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => undefined);
    locks.set(id, tail);
    void tail.then(() => { if (locks.get(id) === tail) locks.delete(id); });
    return run;
  }

  async function readMeta(id: string): Promise<MediaMeta | null> {
    try { return JSON.parse(await readFile(join(dir, id, 'meta.json'), 'utf8')) as MediaMeta; }
    catch { return null; }
  }
  async function writeMeta(id: string, meta: MediaMeta): Promise<void> {
    const tmp = join(dir, id, 'meta.json.tmp');
    await writeFile(tmp, JSON.stringify(meta));
    await rename(tmp, join(dir, id, 'meta.json'));
  }
  async function listIds(): Promise<string[]> {
    try { return (await readdir(dir)).filter((e) => ID_RE.test(e)); }
    catch { return []; }
  }
  function attachmentOf(id: string, meta: MediaMeta): Attachment {
    return { url: `/media/${id}/${meta.name}`, mime: meta.mime, name: meta.name, size: meta.size };
  }

  /** Shared walk for lease()/reference(). */
  async function transition(paths: string[], apply: (meta: MediaMeta) => MediaMeta): Promise<{ known: Attachment[]; unknown: string[] }> {
    const known: Attachment[] = [];
    const unknown: string[] = [];
    for (const p of paths) {
      const m = PATH_RE.exec(p);
      if (!m) { unknown.push(p); continue; }
      const id = m[1]!;
      const result = await withLock(id, async () => {
        const meta = await readMeta(id);
        if (!meta) return null;
        const next = apply(meta);
        if (JSON.stringify(next) !== JSON.stringify(meta)) await writeMeta(id, next);
        return next;
      });
      if (result) known.push(attachmentOf(id, result));
      else unknown.push(p);
    }
    return { known, unknown };
  }

  return {
    sanitizeName,

    async save(body, saveOpts) {
      await ready;
      if (saveOpts.declaredLength !== undefined && saveOpts.declaredLength > maxFile) return { ok: false, error: 'too-large' };
      const nowMs = now();
      const reserve = saveOpts.declaredLength ?? maxFile;

      // RESERVE before reading a single byte, under the admission lock —
      // concurrent uploads each see the others' reservations.
      const admitted = await withAdmission(async () => {
        const used = chargedInWindow(saveOpts.uploadedBy, nowMs);
        if (used + reserve > identityQuota) return 'quota' as const;
        const total = await seedGlobalTotal();
        if (total + reserve > maxTotal) return 'disk-full' as const;
        if ((await freeBytes()) < minFree) return 'disk-full' as const;
        ledger.get(saveOpts.uploadedBy)?.push({ ts: nowMs, bytes: reserve }) ?? ledger.set(saveOpts.uploadedBy, [{ ts: nowMs, bytes: reserve }]);
        globalTotal = total + reserve;
        return 'ok' as const;
      });
      if (admitted !== 'ok') return { ok: false, error: admitted };

      const reconcile = (actual: number) => withAdmission(async () => {
        // Swap the reservation for the actual size (0 releases it fully).
        const entries = ledger.get(saveOpts.uploadedBy) ?? [];
        const idx = entries.findIndex((e) => e.ts === nowMs && e.bytes === reserve);
        if (idx >= 0) { if (actual > 0) entries[idx] = { ts: nowMs, bytes: actual }; else entries.splice(idx, 1); }
        globalTotal = (globalTotal ?? reserve) - reserve + actual;
      });

      const id = newId();
      const tmpPath = join(dir, 'tmp', id);
      let size = 0;
      const capped = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          size += chunk.length;
          if (size > maxFile) cb(new Error('too-large'));
          else cb(null, chunk);
        },
      });
      // The source is NOT a pipeline participant: on a cap error, pipeline()
      // destroys everything it was handed — handing it an IncomingMessage
      // would tear down the HTTP socket before the caller can write 413.
      // pipe() into a PassThrough instead: dest teardown just unpipes, and
      // the caller keeps a live response to answer on.
      const src = new PassThrough();
      body.pipe(src);
      // pipe() forwards DATA only — a source error or client abort would
      // otherwise leave src un-ended and the pipeline pending FOREVER,
      // retaining the reservation and tmp file. Forward both into src so the
      // pipeline rejects and the catch below cleans up.
      const onSourceGone = (err?: Error) => src.destroy(err ?? new Error('upload source closed'));
      (body as NodeJS.EventEmitter).on('error', onSourceGone);
      (body as NodeJS.EventEmitter).on('aborted', onSourceGone);
      const detach = () => {
        (body as NodeJS.ReadableStream & { unpipe?: (d: unknown) => void }).unpipe?.(src);
        (body as NodeJS.EventEmitter).off('error', onSourceGone);
        (body as NodeJS.EventEmitter).off('aborted', onSourceGone);
      };
      try {
        await pipeline(src, capped, createWriteStream(tmpPath, { flags: 'wx' }));
        detach();
        if (size === 0) { await rm(tmpPath, { force: true }); await reconcile(0); return { ok: false, error: 'empty' }; }
        const name = sanitizeName(saveOpts.name);
        const meta: MediaMeta = { mime: saveOpts.mime, name, size, uploadedBy: saveOpts.uploadedBy, ts: nowMs, referenced: false };
        await mkdir(join(dir, id), { recursive: true });
        await writeMeta(id, meta);                       // meta first…
        await rename(tmpPath, join(dir, id, 'blob'));    // …then bytes become addressable
        await reconcile(size);
        return { ok: true, attachment: attachmentOf(id, meta) };
      } catch (err) {
        // ANY failure after admission: release the reservation and leave no
        // partial state (tmp file OR a meta-only id dir). The SOURCE stream
        // is untouched (see PassThrough note) — the HTTP caller still owns it.
        detach();
        await rm(tmpPath, { force: true });
        await rm(join(dir, id), { recursive: true, force: true });
        await reconcile(0);
        if (err instanceof Error && err.message === 'too-large') return { ok: false, error: 'too-large' };
        throw err;
      }
    },

    async open(id) {
      if (!ID_RE.test(id)) return null;
      return withLock(id, async () => {
        const meta = await readMeta(id);
        if (!meta) return null;
        try {
          const handle = await fsOpen(join(dir, id, 'blob'), 'r');
          // fd-backed stream: stays readable even if the path is unlinked by
          // a delete/sweep that wins the next lock acquisition.
          return { meta, stream: handle.createReadStream() };
        } catch { return null; }
      });
    },

    lease(paths, leaseOpts) {
      const expiresAt = now() + LEASE_TTL_MS;
      return transition(paths, (meta) => meta.referenced ? meta : ({
        ...meta,
        lease: { expiresAt, ...(leaseOpts?.messageId ? { messageId: leaseOpts.messageId } : {}) },
      }));
    },

    reference(paths) {
      return transition(paths, (meta) => {
        if (meta.referenced) return meta;
        const { lease: _dropped, ...rest } = meta;
        return { ...rest, referenced: true };
      });
    },

    async delete(id, requester) {
      if (!ID_RE.test(id)) return 'missing';
      return withLock(id, async () => {
        const meta = await readMeta(id);
        if (!meta) return 'missing' as const;
        if (meta.uploadedBy !== requester) return 'forbidden' as const;
        if (meta.referenced) return 'referenced' as const;
        await rm(join(dir, id), { recursive: true, force: true });
        // globalTotal mutations ONLY under the admission lock — a decrement
        // racing a concurrent save's reconcile must not be lost (a lost
        // decrement inflates the total and produces persistent false 507s).
        await withAdmission(async () => { if (globalTotal !== null) globalTotal -= meta.size; });
        return 'deleted' as const;
      });
    },

    async sweep(olderThanMs = QUOTA_WINDOW_MS) {
      const nowMs = now();
      const horizon = nowMs - olderThanMs;
      let deleted = 0;
      let bytesFreed = 0;
      for (const id of await listIds()) {
        await withLock(id, async () => {
          const meta = await readMeta(id); // re-read UNDER the lock
          if (!meta || meta.referenced || meta.ts > horizon) return;
          if (meta.lease && meta.lease.expiresAt > nowMs) return; // live lease: keep
          await rm(join(dir, id), { recursive: true, force: true });
          deleted += 1;
          bytesFreed += meta.size;
          await withAdmission(async () => { if (globalTotal !== null) globalTotal -= meta.size; });
        });
      }
      // tmp-orphan reclamation (process crashes leave interrupted uploads
      // under tmp/, invisible to the id scan and to globalTotal): remove tmp
      // entries older than the horizon by mtime.
      try {
        const { readdir: rd, stat: st, rm: rmf } = await import('node:fs/promises');
        for (const t of await rd(join(dir, 'tmp'))) {
          const tp = join(dir, 'tmp', t);
          try { if ((await st(tp)).mtimeMs < horizon) await rmf(tp, { force: true }); } catch { /* raced */ }
        }
      } catch { /* tmp dir missing is fine */ }
      const total = await withAdmission(() => seedGlobalTotal()); // seeding must not race a reserve
      return { deleted, bytesFreed, totalBytes: total };
    },
  };
}
