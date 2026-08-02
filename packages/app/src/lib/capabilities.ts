/** True when this pairing's instance is the origin serving the app —
 *  the only platform attachments work on in v1 (media is single-origin:
 *  capability URLs are relative to the serving origin, so a pairing that
 *  points anywhere else cannot fetch or receive them). A 'host' transport
 *  IS the serving process, so it always qualifies. Otherwise compare the
 *  pairing url's host (ws:/wss: URLs parse fine with `new URL`) against
 *  the host the app was loaded from; no url or an unparseable url means
 *  we cannot establish the match, so: not this app's origin. */
export function servesThisApp(p: { url?: string; transportKind: string }): boolean {
  if (p.transportKind === 'host') return true;
  if (!p.url) return false;
  try {
    return new URL(p.url).host === window.location.host;
  } catch {
    return false;
  }
}
