import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const swSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../sw/service-worker.js'),
  'utf8',
).replaceAll('__RACCOON_BUILD_ID__', 'test-build-2');

type NotificationCall = [string, { tag?: string; data: Record<string, unknown> }];

interface SwHandle {
  listeners: Record<string, (event: { waitUntil: (p: Promise<unknown>) => void }) => void>;
  deleted: string[];
  notifications: NotificationCall[];
  setCacheNames: (names: string[]) => void;
}

/** Evaluate the SW source in a sandbox with mock `self`/`caches`, capturing
 *  its event listeners, which caches it deletes, and shown notifications. */
function loadServiceWorker(): SwHandle {
  const listeners: SwHandle['listeners'] = {};
  const deleted: string[] = [];
  const notifications: NotificationCall[] = [];
  let cacheNames: string[] = [];
  const self = {
    addEventListener: (type: string, fn: SwHandle['listeners'][string]) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    registration: {
      showNotification: async (title: string, opts: NotificationCall[1]) => { notifications.push([title, opts]); },
    },
    location: { origin: 'https://hub.example' },
  };
  const caches = {
    keys: async () => cacheNames,
    delete: async (n: string) => { deleted.push(n); return true; },
    open: async () => ({ put: async () => {}, match: async () => undefined }),
  };
  const ctx = { self, caches, fetch: async () => ({ ok: false }), console, URL };
  vm.createContext(ctx);
  vm.runInContext(swSource, ctx);
  return { listeners, deleted, notifications, setCacheNames: (names) => { cacheNames = names; } };
}

async function fire(
  listener: SwHandle['listeners'][string],
  event: Record<string, unknown> = {},
): Promise<void> {
  let held: Promise<unknown> | undefined;
  listener({ ...event, waitUntil: (p) => { held = p; } });
  await held;
}

describe('service worker activate cache pruning (#R6-10)', () => {
  it('deletes only stale raccoon caches, never another same-origin app\'s caches', async () => {
    const sw = loadServiceWorker();
    sw.setCacheNames([
      'raccoon-shell-test-build-2',   // current — keep
      'raccoon-static-test-build-2',  // current — keep
      'raccoon-shell-old-build',      // stale ours — delete
      'raccoon-static-old-build',     // stale ours — delete
      'dashboard-app-v3',             // another app — MUST keep
      'workbox-precache-v2',          // another app — MUST keep
      'firebase-messaging-sw',        // another app — MUST keep
    ]);

    await fire(sw.listeners.activate!);

    expect([...sw.deleted].sort()).toEqual(['raccoon-shell-old-build', 'raccoon-static-old-build']);
  });

  it('deletes nothing when only the current caches and foreign caches exist', async () => {
    const sw = loadServiceWorker();
    sw.setCacheNames(['raccoon-shell-test-build-2', 'raccoon-static-test-build-2', 'some-other-app']);
    await fire(sw.listeners.activate!);
    expect(sw.deleted).toEqual([]);
  });
});

describe('push notifications: per-pairing titles and tap-routing', () => {
  function pushEvent(payload: unknown) {
    return { data: { json: () => payload } };
  }

  it('composes the title and tag from payload.instance and routes clicks by (pi, pu, pc)', async () => {
    const sw = loadServiceWorker();
    await fire(sw.listeners.push!, pushEvent({
      title: 'Atlas',
      body: 'hi',
      data: { channel: 'coordinator' },
      instance: { name: 'alpha', instanceUrl: 'wss://a.example/', userId: 'u1' },
    }));
    expect(sw.notifications).toHaveLength(1);
    const [title, opts] = sw.notifications[0]!;
    expect(title).toBe('Atlas · alpha');
    // Per-pairing collapse key: two instances exposing same-named channels
    // must not replace each other's notifications.
    expect(opts.tag).toBe('wss://a.example/|u1|coordinator');
    expect(opts.data.url).toBe('/?pi=wss%3A%2F%2Fa.example%2F&pu=u1&pc=coordinator');
    expect(opts.data.channel).toBe('coordinator'); // original data preserved
  });

  it('payload without instance keeps today\'s title, tag, and url behavior', async () => {
    const sw = loadServiceWorker();
    await fire(sw.listeners.push!, pushEvent({
      title: 'Atlas',
      body: 'hi',
      data: { channel: 'coordinator', url: '/?c=coordinator' },
    }));
    expect(sw.notifications).toHaveLength(1);
    const [title, opts] = sw.notifications[0]!;
    expect(title).toBe('Atlas');
    expect(opts.tag).toBe('coordinator');
    expect(opts.data).toEqual({ channel: 'coordinator', url: '/?c=coordinator' });
  });
});
