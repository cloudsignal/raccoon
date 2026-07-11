/**
 * @raccoon/app — library surface for host embedding.
 *
 * A downstream host app imports from this file via the vendored source path.
 * Do NOT add build/exports-map entries here — the host resolves this file
 * directly.
 *
 * Host-embedding contract (already-authenticated transport):
 *
 *   import { App, TransportProvider, UpdateGate } from '@raccoon/app/src/lib.js';
 *   import type { AppTransport, Session } from '@raccoon/app/src/lib.js';
 *
 *   const myTransport = new MyTransport({ ... }); // any AppTransport the host owns + authenticates
 *   const mySession: Session = {
 *     url: 'wss://example.com',      // placeholder OK — not used by provider
 *     sessionToken: 'host-managed',   // placeholder OK — not used by provider
 *     userId: 'user:abc123',          // REQUIRED — drives from: address on all sends
 *     instance: 'my-instance',        // REQUIRED
 *     channels: ['coordinator'],      // REQUIRED — drives the channel list UI
 *   };
 *
 *   function Shell() {
 *     return (
 *       <TransportProvider transportOverride={myTransport} sessionOverride={mySession}>
 *         <UpdateGate />
 *         <App />
 *       </TransportProvider>
 *     );
 *   }
 *
 * When `transportOverride` is supplied:
 * - The provider skips IDB session loading and the QR-pairing flow entirely.
 * - phase starts as 'loading' for one tick then becomes 'ready'.
 * - The host is fully responsible for authentication and transport lifecycle
 *   (the provider does NOT call close() on an override transport on unmount).
 * - `pairWithPayload` is still present on the ChatApi but is meaningless for
 *   hosts that bypass pairing — do not call it.
 *
 * `sessionOverride` MUST accompany `transportOverride`.  Without it, `session`
 * in ChatApi is null, the channel list is empty, and all outbound messages
 * (sendMessage, respondApproval) silently no-op because userId is unavailable.
 * The override session is NOT persisted to IDB — the host owns identity.
 *
 * For the pairing flow (still supported): supply `makeTransport` instead.
 * The factory receives `{url, session?, pairingToken?, device?}` from the
 * provider but may ignore opts and return a fully custom transport.
 */

// Core UI components
export { App } from './app.js';
export { UpdateGate } from './components/update-gate.js';

// Transport layer
export { TransportProvider, useChat } from './transport/context.js';
export type { ChatApi, TransportProviderProps, PushRegistrar } from './transport/context.js';
export type { AppTransport, MakeTransport } from './transport/types.js';

// #A4 (vendor-neutral): the push-registrar factory belongs on the public
// surface so a host wiring a VAPID-over-HTTP registrar does not deep-import
// '@raccoon/app/src/lib/push-registrar-http.js'.
export { createHttpPushRegistrar } from './lib/push-registrar-http.js';

// Session type — hosts using transportOverride need this for sessionOverride
export type { Session } from './lib/session.js';

// Config / theming
export { appConfig, channelMeta, TONES } from './config.js';
export type { RaccoonConfig, ChannelTone, ChannelMeta } from './config.js';

// Protocol pass-through (optional — host may import from @raccoon/protocol directly)
export type { AnyEnvelope, Transport, TransportStatus } from '@raccoon/protocol';
