import { useEffect } from 'react';
import { isUpdateHeld } from '../lib/update-hold.js';
import { runUpdateCheck } from '../lib/update-check.js';
import { RACCOON_BUILD_ID } from '../build-id.js';

const CHECK_INTERVAL_MS = 60_000;

async function fetchVersion(): Promise<{ buildId?: string } | null> {
  try {
    const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return null;
    return (await res.json()) as { buildId?: string };
  } catch {
    return null;
  }
}

async function updateRegistrations(): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return false;
  const regs = await navigator.serviceWorker.getRegistrations();
  await Promise.all(regs.map((r) => r.update().catch(() => undefined)));
  return regs.some((r) => Boolean(r.installing || r.waiting));
}

async function purgeShellCache(): Promise<void> {
  navigator.serviceWorker?.controller?.postMessage({ type: 'PURGE_SHELL_CACHE' });
  await new Promise((r) => setTimeout(r, 50));
}

function reload(): void {
  window.location.reload();
}

export function UpdateGate() {
  useEffect(() => {
    let pendingReload = false;

    const check = (): void => {
      void runUpdateCheck({
        buildId: RACCOON_BUILD_ID,
        fetchVersion,
        updateRegistrations,
        purgeShellCache,
        reload,
        isHeld: isUpdateHeld,
      }).then((result) => {
        if (result === 'held') pendingReload = true;
        else if (result === 'reloaded') pendingReload = false;
      });
    };

    const maybeFlushHeld = (): void => {
      if (pendingReload && !isUpdateHeld()) { pendingReload = false; reload(); }
    };

    const onVisible = (): void => {
      if (document.visibilityState === 'visible') { maybeFlushHeld(); check(); }
    };
    const onControllerChange = (): void => {
      if (isUpdateHeld()) { pendingReload = true; return; }
      reload();
    };

    const interval = setInterval(() => {
      if (document.visibilityState === 'visible') { maybeFlushHeld(); check(); }
    }, CHECK_INTERVAL_MS);

    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    window.addEventListener('online', onVisible);
    window.addEventListener('pageshow', onVisible);
    navigator.serviceWorker?.addEventListener('controllerchange', onControllerChange);
    check();

    return () => {
      clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
      window.removeEventListener('online', onVisible);
      window.removeEventListener('pageshow', onVisible);
      navigator.serviceWorker?.removeEventListener('controllerchange', onControllerChange);
    };
  }, []);
  return null;
}
