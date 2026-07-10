// Local type definitions for SDK surface that openclaw@2026.6.11 does NOT
// re-export by name from any public `openclaw/plugin-sdk/*` subpath.
//
// These are derived from the REAL SDK (via the public function's return type),
// not hand-copied shapes, so they stay bound to the installed package and
// break loudly if the upstream contract changes. Do not add convenience types
// here — only genuinely-absent public exports belong in this file.

import type { dispatchReplyFromConfigWithSettledDispatcher } from 'openclaw/plugin-sdk/channel-inbound';

/**
 * Resolved result of `dispatchReplyFromConfigWithSettledDispatcher`.
 *
 * The named `DispatchFromConfigResult` type exists in the SDK but lives only in
 * an internal chunk; no public `plugin-sdk` subpath re-exports it. Derive it
 * from the (publicly exported) dispatch function's return type instead.
 */
export type DispatchFromConfigResult = Awaited<
  ReturnType<typeof dispatchReplyFromConfigWithSettledDispatcher>
>;
