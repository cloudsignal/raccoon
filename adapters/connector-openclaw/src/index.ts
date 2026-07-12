// adapters/openclaw/src/index.ts
// Task 7/8: channel-native entry.
//
// Swapped from definePluginEntry (non-channel) to defineChannelPluginEntry
// (real channel-capability entry). The full ChannelPlugin — config, outbound,
// pairing, security, setupWizard, and the gateway lifecycle — now lives in
// channel-plugin.ts (raccoonChannelPlugin).
//
// ---------------------------------------------------------------------------
// T8 LIVE-GATE FIX — operator pairing is GATEWAY-MEDIATED
// ---------------------------------------------------------------------------
// A Raccoon pairing token is only valid against the ONE live WsHub instance
// that minted it (WsHub keeps the token in a per-instance in-memory map and
// validates the incoming pair.request against it). That hub lives ONLY in the
// gateway process (started by raccoonChannelPlugin.gateway.startAccount).
//
// OpenClaw runs the CLI in a SEPARATE process, and a plugin CLI command's
// action runs IN THAT CLI PROCESS with a context of just
// { program, config, workspaceDir, logger } — no gateway/hub handle (verified
// against openclaw@2026.6.11 types-CR1WAXpo.d.ts + the running gateway). So a
// CLI-minted token lands in a throwaway registry the live hub never sees, and
// a plugin CLI command cannot reach the live transport by itself.
//
// Therefore operator pairing is exposed as a GATEWAY HTTP ROUTE that mints
// against the live hub in the gateway process:
//   POST /raccoon/pair    { "userId": "<id>" } -> { token, payload, qr }
//   POST /raccoon/revoke  { "userId": "<id>" } -> { ok: true }
// Both use auth:'gateway' so only an operator holding the gateway token can
// call them. `/raccoon/version` (auth:'plugin', unauthenticated liveness) is
// retained.
//
// Registration hooks (defineChannelPluginEntry dispatches by mode — verified
// live against openclaw@2026.6.11, core-Ch6CsyM-.d.ts / core dispatch):
//   - registerCliMetadata: runs in the cli-metadata / discovery passes. It
//     declares the `raccoon` command so the CLI dispatcher advertises it and
//     — where the CLI is able to attach a channel-plugin registrar — the
//     `raccoon pair/revoke` action PROXIES to the gateway route over HTTP
//     (createGatewayCliDeps), so a CLI-issued token is still minted by the
//     live hub. The load-bearing operator path is the gateway route itself
//     (curl / any HTTP client), which does not depend on CLI attach.
//   - registerFull: runs ONLY in 'full' (the gateway runtime). Registers the
//     /raccoon/version + /raccoon/pair + /raccoon/revoke HTTP routes. NEVER
//     binds the hub port (the WsHub + RaccoonBridge lifecycle lives in
//     raccoonChannelPlugin.gateway.start/stop).

import { defineChannelPluginEntry } from 'openclaw/plugin-sdk/channel-core';
import { raccoonChannelPlugin } from './channel-plugin.js';
import { registerRaccoonCli } from './cli.js';
import { createGatewayCliDeps } from './gateway-client.js';
import { makeRaccoonPairHandler, makeRaccoonRevokeHandler } from './gateway.js';

const RACCOON_BUILD_ID = process.env.RACCOON_BUILD_ID ?? 'dev';

// register() fires more than once even within a mode (boot pass + agent-runtime
// pre-warm share this module instance). Guard per api instance so the CLI
// metadata and the version route each register exactly once PER api. Separate
// WeakSets so the CLI-metadata pass and the full pass don't clobber each other
// (they can receive the same api object; a shared guard would skip the second).
const cliRegisteredApis = new WeakSet<object>();
const routeRegisteredApis = new WeakSet<object>();

export default defineChannelPluginEntry({
  id: 'raccoon',
  name: 'Raccoon',
  description: 'Self-hosted Raccoon messenger (installable PWA + push).',
  plugin: raccoonChannelPlugin,
  configSchema: raccoonChannelPlugin.configSchema,
  registerCliMetadata(api) {
    // Declare the `raccoon` command. Its pair/revoke actions proxy to the
    // gateway HTTP route (see createGatewayCliDeps) so a CLI-issued token is
    // minted by the live hub in the gateway process — never by the CLI process.
    if (cliRegisteredApis.has(api)) return;
    cliRegisteredApis.add(api);
    registerRaccoonCli(api, createGatewayCliDeps());
  },
  registerFull(api) {
    // Only the full gateway runtime registers HTTP routes. Other modes never
    // reach registerFull. These routes run IN THE GATEWAY PROCESS, where the
    // live hub is reachable via the module-scope running-account registry.
    if (api.registrationMode !== 'full') return;
    if (routeRegisteredApis.has(api)) return;
    routeRegisteredApis.add(api);

    // Unauthenticated liveness probe (retained from T7).
    api.registerHttpRoute({
      path: '/raccoon/version',
      auth: 'plugin',
      handler: (_req, res) => {
        res.statusCode = 200;
        res.end(JSON.stringify({ buildId: RACCOON_BUILD_ID }));
        return true;
      },
    });

    // Operator pairing — gateway-authenticated; mints against the live hub.
    api.registerHttpRoute({
      path: '/raccoon/pair',
      auth: 'gateway',
      handler: makeRaccoonPairHandler(),
    });
    api.registerHttpRoute({
      path: '/raccoon/revoke',
      auth: 'gateway',
      handler: makeRaccoonRevokeHandler(),
    });
  },
});

export { createRaccoonChannel } from './plugin.js';
export { raccoonChannelPlugin } from './channel-plugin.js';
export {
  startAccount,
  stopAccount,
  resolveRunning,
  raccoonPairDeps,
  makeRaccoonPairHandler,
  makeRaccoonRevokeHandler,
} from './gateway.js';
export { buildRaccoonInboundRunner, type InboundRunnerOpts } from './inbound.js';
