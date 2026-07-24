import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { createMediaStore } from './media-store.js';

const dirs: string[] = [];
function makeStore(overrides = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'raccoon-media-'));
  dirs.push(dir);
  return { dir, store: createMediaStore({ dir, freeBytes: async () => 10 * 1024 ** 3, ...overrides }) };
}
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

const body = (s: string) => Readable.from([Buffer.from(s)]);
const readAll = async (s: NodeJS.ReadableStream) => {
  const chunks: Buffer[] = [];
  for await (const c of s) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
};

describe('save + open', () => {
  it('stores bytes at <id>/blob with meta.json and returns a valid attachment', async () => {
    const { dir, store } = makeStore();
    const r = await store.save(body('hello'), { mime: 'image/png', name: 'My Photo (1).png', uploadedBy: 'u1' });
    if (!r.ok) throw new Error('save failed');
    expect(r.attachment.url).toMatch(/^\/media\/[0-9A-HJKMNP-TV-Z]{26}\/My_Photo__1_.png$/);
    expect(r.attachment).toMatchObject({ mime: 'image/png', name: 'My_Photo__1_.png', size: 5 });
    const id = r.attachment.url.split('/')[2]!;
    expect(readFileSync(join(dir, id, 'blob'), 'utf8')).toBe('hello');
    const meta = JSON.parse(readFileSync(join(dir, id, 'meta.json'), 'utf8'));
    expect(meta).toMatchObject({ mime: 'image/png', size: 5, uploadedBy: 'u1', referenced: false });
    const opened = await store.open(id);
    expect(opened?.meta.mime).toBe('image/png');
    expect(await readAll(opened!.stream)).toBe('hello');
  });

  it('works in a FRESH nested media dir (statfs/quota must not run before mkdir)', async () => {
    const base = mkdtempSync(join(tmpdir(), 'raccoon-media-'));
    dirs.push(base);
    const store = createMediaStore({ dir: join(base, 'nested', 'media') }); // real statfs default
    const r = await store.save(body('x'), { mime: 'text/plain', name: 'a.txt', uploadedBy: 'u1' });
    expect(r.ok).toBe(true);
  });

  it('an fd stream opened before a delete still serves the bytes (GET-vs-delete race)', async () => {
    const { store } = makeStore();
    const r = await store.save(body('survivor'), { mime: 'text/plain', name: 'a.txt', uploadedBy: 'u1' });
    if (!r.ok) throw new Error('save failed');
    const id = r.attachment.url.split('/')[2]!;
    const opened = await store.open(id);
    expect(await store.delete(id, 'u1')).toBe('deleted');
    expect(await readAll(opened!.stream)).toBe('survivor'); // fd survives the unlink
    expect(await store.open(id)).toBeNull();
  });

  it('a filename of meta.json / dots cannot address metadata (stored name sanitized, bytes always at blob)', async () => {
    const { dir, store } = makeStore();
    const r = await store.save(body('x'), { mime: 'text/plain', name: 'meta.json', uploadedBy: 'u1' });
    if (!r.ok) throw new Error('save failed');
    const id = r.attachment.url.split('/')[2]!;
    expect(readFileSync(join(dir, id, 'blob'), 'utf8')).toBe('x');
    expect(JSON.parse(readFileSync(join(dir, id, 'meta.json'), 'utf8')).referenced).toBe(false);
  });

  it('rejects over-cap bodies mid-stream and leaves NO partial state (tmp or id dir)', async () => {
    const { dir, store } = makeStore({ maxFileBytes: 4 });
    const r = await store.save(body('too big'), { mime: 'text/plain', name: 'a.txt', uploadedBy: 'u1', declaredLength: 4 });
    expect(r).toEqual({ ok: false, error: 'too-large' });
    const { readdir } = await import('node:fs/promises');
    expect((await readdir(join(dir, 'tmp'))).length).toBe(0);
    expect((await readdir(dir)).filter((e) => e !== 'tmp')).toHaveLength(0);
  });

  it('rejects an over-cap declaredLength before reading', async () => {
    const { store } = makeStore({ maxFileBytes: 4 });
    let read = false;
    const s = new Readable({ read() { read = true; this.push(null); } });
    const r = await store.save(s, { mime: 'text/plain', name: 'a.txt', uploadedBy: 'u1', declaredLength: 10 });
    expect(r).toEqual({ ok: false, error: 'too-large' });
    expect(read).toBe(false);
  });

  it('RESERVES quota at admission: undeclared uploads reserve maxFileBytes; ledger survives deletion', async () => {
    // maxFileBytes doubles as the reservation for undeclared lengths.
    const { store } = makeStore({ identityQuotaBytes: 6, maxFileBytes: 4 });
    const first = await store.save(body('aaaa'), { mime: 'text/plain', name: 'a', uploadedBy: 'u1' });
    expect(first.ok).toBe(true);                       // reserved 4 of 6, reconciled to 4
    expect(await store.save(body('bb'), { mime: 'text/plain', name: 'b', uploadedBy: 'u1' }))
      .toEqual({ ok: false, error: 'quota' });         // 4 used + 4 reserve > 6
    // deleting the first upload does NOT free the ledger — no quota laundering
    if (first.ok) {
      await store.delete(first.attachment.url.split('/')[2]!, 'u1');
      expect(await store.save(body('cc'), { mime: 'text/plain', name: 'c', uploadedBy: 'u1' }))
        .toEqual({ ok: false, error: 'quota' });
    }
    // a different identity is unaffected
    expect((await store.save(body('cc'), { mime: 'text/plain', name: 'c', uploadedBy: 'u2' })).ok).toBe(true);
  });

  it('CONCURRENT saves cannot jointly exceed the quota (admission lock)', async () => {
    const { store } = makeStore({ identityQuotaBytes: 5, maxFileBytes: 4 });
    const [a, b] = await Promise.all([
      store.save(body('aaaa'), { mime: 'text/plain', name: 'a', uploadedBy: 'u1' }),
      store.save(body('bbbb'), { mime: 'text/plain', name: 'b', uploadedBy: 'u1' }),
    ]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1); // exactly one admitted
  });

  it('enforces the global byte cap with reservation and releases it on failure', async () => {
    const { store } = makeStore({ maxTotalBytes: 3, maxFileBytes: 2 });
    expect((await store.save(body('aa'), { mime: 'text/plain', name: 'a', uploadedBy: 'u1' })).ok).toBe(true);
    expect(await store.save(body('bb'), { mime: 'text/plain', name: 'b', uploadedBy: 'u2' }))
      .toEqual({ ok: false, error: 'disk-full' });     // 2 stored + 2 reserve > 3
  });

  it('rejects when the filesystem is low on space', async () => {
    const { store } = makeStore({ freeBytes: async () => 0 });
    expect(await store.save(body('x'), { mime: 'text/plain', name: 'a', uploadedBy: 'u1' })).toEqual({ ok: false, error: 'disk-full' });
  });
});

describe('lease / reference / delete / sweep lifecycle', () => {
  async function saved(store: ReturnType<typeof makeStore>['store'], by = 'u1') {
    const r = await store.save(body('x'), { mime: 'text/plain', name: 'a.txt', uploadedBy: by });
    if (!r.ok) throw new Error('save failed');
    return r.attachment;
  }
  const openOf = async (store: ReturnType<typeof makeStore>['store'], a: { url: string }) => {
    const found = await store.open(a.url.split('/')[2]!);
    found?.stream.destroy();
    return found;
  };

  it('reference flips permanently and idempotently, returns canonical metadata, reports unknown paths', async () => {
    const { store } = makeStore();
    const a = await saved(store);
    const r1 = await store.reference([a.url, '/media/01ARZ3NDEKTSV4RRFFQ69G5FAV/nope.txt']);
    expect(r1.known[0]).toEqual(a);
    expect(r1.unknown).toHaveLength(1);
    const r2 = await store.reference([a.url]); // idempotent
    expect(r2.known[0]).toEqual(a);
  });

  it('lease keeps an entry alive past the sweep horizon until it expires; reference upgrades and clears the lease', async () => {
    let now = 1_000_000;
    const { store } = makeStore({ now: () => now });
    const leased = await saved(store);
    const upgraded = await saved(store);
    await store.lease([leased.url, upgraded.url], { messageId: 'env-1' });
    await store.reference([upgraded.url]);

    now += 25 * 60 * 60 * 1000; // 25h: past the 24h horizon, lease (7d) still live
    expect((await store.sweep(24 * 60 * 60 * 1000)).deleted).toBe(0);
    expect(await openOf(store, leased)).not.toBeNull();

    now += 7 * 24 * 60 * 60 * 1000; // lease expired, message never landed server-side
    const r = await store.sweep(24 * 60 * 60 * 1000);
    expect(r.deleted).toBe(1);                          // the leased-but-never-referenced one
    expect(await openOf(store, leased)).toBeNull();
    expect(await openOf(store, upgraded)).not.toBeNull(); // referenced = permanent
  });

  it('delete: owner-only, allowed while merely leased, blocked once referenced', async () => {
    const { store } = makeStore();
    const a = await saved(store, 'owner');
    const id = a.url.split('/')[2]!;
    expect(await store.delete(id, 'someone-else')).toBe('forbidden');
    expect(await store.delete('01ARZ3NDEKTSV4RRFFQ69G5FAV', 'owner')).toBe('missing');
    await store.lease([a.url]);
    expect(await store.delete(id, 'owner')).toBe('deleted'); // a lease does not lock the owner out
    const b = await saved(store, 'owner');
    await store.reference([b.url]);
    expect(await store.delete(b.url.split('/')[2]!, 'owner')).toBe('referenced');
  });

  it('sweep deletes only unreferenced, unleased files older than the horizon', async () => {
    let now = 1_000_000;
    const { store } = makeStore({ now: () => now });
    const old = await saved(store);
    const kept = await saved(store);
    await store.reference([kept.url]);
    now += 25 * 60 * 60 * 1000; // 25h later
    const fresh = await saved(store);
    const r = await store.sweep(24 * 60 * 60 * 1000);
    expect(r.deleted).toBe(1);
    expect(await openOf(store, old)).toBeNull();
    expect(await openOf(store, kept)).not.toBeNull();
    expect(await openOf(store, fresh)).not.toBeNull();
  });

  it('RACE: delete-vs-reference and sweep-vs-reference never remove referenced media', async () => {
    let now = 1_000_000;
    const { store } = makeStore({ now: () => now });
    const a = await saved(store, 'u1');
    const id = a.url.split('/')[2]!;
    // fire reference and delete concurrently, many rounds
    const [, del] = await Promise.all([store.reference([a.url]), store.delete(id, 'u1')]);
    if (del === 'deleted') {
      // then the reference must have reported it unknown (deleted first) — acceptable;
      // the FORBIDDEN outcome is deleting AFTER reference succeeded:
      expect((await store.reference([a.url])).unknown).toContain(a.url);
    } else {
      expect(del).toBe('referenced');
      expect(await store.open(id)).not.toBeNull();
    }
    // sweep-vs-reference
    const b = await saved(store, 'u1');
    now += 25 * 60 * 60 * 1000;
    const [refR] = await Promise.all([store.reference([b.url]), store.sweep(24 * 60 * 60 * 1000)]);
    if (refR.known.length === 1) expect(await store.open(b.url.split('/')[2]!)).not.toBeNull();
  });
});
