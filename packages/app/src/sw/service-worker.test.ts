import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

const swSource = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '../../sw/service-worker.js'),
  'utf8',
).replaceAll('__RACCOON_BUILD_ID__', 'test-build-2');

interface SwHandle {
  listeners: Record<string, (event: { waitUntil: (p: Promise<unknown>) => void }) => void>;
  deleted: string[];
  setCacheNames: (names: string[]) => void;
}

/** Evaluate the SW source in a sandbox with mock `self`/`caches`, capturing
 *  its event listeners and which caches it deletes. */
function loadServiceWorker(): SwHandle {
  const listeners: SwHandle['listeners'] = {};
  const deleted: string[] = [];
  let cacheNames: string[] = [];
  const self = {
    addEventListener: (type: string, fn: SwHandle['listeners'][string]) => { listeners[type] = fn; },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, matchAll: async () => [], openWindow: async () => {} },
    registration: { showNotification: async () => {} },
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
  return { listeners, deleted, setCacheNames: (names) => { cacheNames = names; } };
}

async function fire(listener: SwHandle['listeners'][string]): Promise<void> {
  let held: Promise<unknown> | undefined;
  listener({ waitUntil: (p) => { held = p; } });
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
