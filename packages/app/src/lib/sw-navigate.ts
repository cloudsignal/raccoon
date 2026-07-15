/** Handle a NAVIGATE message from the service worker: a notification click
 *  focused an existing window, which cannot be navigated SW-side without a
 *  reload. Accepts only same-origin paths. Returns true when it navigated. */
export function handleSwNavigate(data: unknown): boolean {
  if (typeof data !== 'object' || data === null) return false;
  const msg = data as { type?: unknown; url?: unknown };
  if (msg.type !== 'NAVIGATE' || typeof msg.url !== 'string') return false;
  // Same-origin paths only: '/x' yes, '//evil.example/x' (protocol-relative)
  // no. pushState would throw on a cross-origin resolution anyway — reject
  // instead of throwing.
  if (!msg.url.startsWith('/') || msg.url.startsWith('//')) return false;
  window.history.pushState(null, '', msg.url);
  // ChatScreen syncs the active channel from ?c= on popstate.
  window.dispatchEvent(new PopStateEvent('popstate'));
  return true;
}
