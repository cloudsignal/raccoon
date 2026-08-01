/**
 * @raccoon/app — library surface for host embedding.
 *
 * This is the package ROOT entry (see package.json "exports"). A host installs
 * @raccoon/app and imports from the package name — never a /src path.
 *
 * Host-embedding contract (already-authenticated transport):
 *
 *   import { App, TransportProvider, UpdateGate } from '@raccoon/app';
 *   import type { AppTransport, Session } from '@raccoon/app';
 *   import '@raccoon/app/styles.css';
 *
 *   const myTransport = new MyTransport({ ... }); // any AppTransport the host owns + authenticates
 *   const mySession: Session = {
 *     url: 'wss://example.com',      // placeholder OK — not used by provider
 *     sessionToken: 'host-managed',   // placeholder OK — not used by provider
 *     userId: 'user:abc123',          // REQUIRED — drives from: address on all sends
 *     instance: 'my-instance',        // REQUIRED
 *     channels: ['coordinator'],      // REQUIRED — drives the conversation list UI
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
 * - The provider skips IDB pairing storage and the QR-pairing flow entirely.
 * - phase starts as 'loading' for one tick then becomes 'ready'.
 * - The override session becomes the app's SINGLE synthetic pairing, exposed
 *   as `ChatApi.pairings[0]` (the old `session`/`status` fields no longer
 *   exist on ChatApi; per-pairing connection status lives on each
 *   PairingView).
 * - The host is fully responsible for authentication and transport lifecycle
 *   (the provider does NOT call close() on an override transport on unmount).
 * - `pairWithPayload` is rejected with an error message under an override —
 *   the host owns identity.
 *
 * `sessionOverride` MUST accompany `transportOverride`.  Without it,
 * `pairings` is empty, the conversation list is empty, and all outbound
 * messages (sendMessage, respondApproval) silently no-op because no pairing
 * identity is available.  The override session is NOT persisted to IDB — the
 * host owns identity.
 *
 * Conversation addressing: ChatApi conversation methods (openChannel,
 * sendMessage, respondApproval, retryMessage, loadOlder) take ConvKeys —
 * `${pairingId}/${channel}` (build one as
 * `pairings[0].pairingId + '/' + channel`, or via the exported convKeyOf).
 * Envelopes on the wire keep the BARE channel; the pairingId never leaves the
 * device.
 *
 * For the pairing flow (still supported): supply `makeTransport` to override
 * the built-in WS factory (the registry's 'ws' slot) — the factory receives
 * `{url, session?, pairingToken?, device?}` from the provider but may ignore
 * opts and return a fully custom transport.  To support ADDITIONAL transport
 * kinds selected by a pairing payload's `transport` field, register factories
 * via the `transports` prop (a TransportRegistry).
 */

// Core UI components
export { App } from './app.js';
export { UpdateGate } from './components/update-gate.js';

// Transport layer
export { TransportProvider, useChat } from './transport/context.js';
export type { ChatApi, PairingView, TransportProviderProps, PushRegistrar } from './transport/context.js';
export type { AppTransport, MakeTransport, TransportRegistry } from './transport/types.js';

// Conversation keys — `${pairingId}/${channel}`, the state key for every
// per-conversation ChatApi call.
export { convKeyOf, resolveConvKey } from './lib/conv-key.js';
export type { ConvKey } from './lib/conv-key.js';

// The push-registrar factory belongs on the public surface so a host wiring a
// VAPID-over-HTTP registrar does not reach into internal modules.
export { createHttpPushRegistrar } from './lib/push-registrar-http.js';

// Session type — hosts using transportOverride need this for sessionOverride
export type { Session } from './lib/session.js';

// Media upload surface — a host supplying its own uploadProvider (see
// TransportProviderProps) or building custom attachment UI uses these
// directly rather than reaching into internal modules.
export { uploadFile, validateFiles, deleteUpload, leaseUploads, MAX_ATTACHMENTS, MAX_FILE_BYTES } from './lib/uploads.js';
export type { UploadProvider } from './lib/uploads.js';

// Config / theming
export { appConfig, channelMeta, TONES } from './config.js';
export type { RaccoonConfig, ChannelTone, ChannelMeta } from './config.js';

// Protocol pass-through (optional — host may import from @raccoon/protocol directly)
export type { AnyEnvelope, Transport, TransportStatus } from '@raccoon/protocol';
