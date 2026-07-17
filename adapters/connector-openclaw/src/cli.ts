// adapters/openclaw/src/cli.ts
// Task 5/8: Raccoon CLI sub-commands for the OpenClaw CLI surface.
//
// Registers `openclaw raccoon pair <userId>` and `openclaw raccoon revoke <userId>`
// via the real OpenClaw registrar contract (registerCli / OpenClawPluginCliRegistrar).
//
// The `pair` command issues a Raccoon device-pairing QR for a user and prints
// it to the terminal. The `revoke` command revokes the device-pairing session.
//
// T8 EXECUTION MODEL: a plugin CLI action runs in the OpenClaw CLI PROCESS,
// which is separate from the gateway runtime and has no handle to the live
// Raccoon WsHub. Pairing tokens are only valid against the hub that minted
// them, which lives in the gateway process. So `deps` here proxies pair/revoke
// to the gateway `/raccoon/pair` route over HTTP (createGatewayCliDeps in
// gateway-client.ts) — the token is minted by the live hub, not the CLI. The
// deps interface is unchanged; only the implementation moved from a
// gateway-process registry lookup (T5/T7, unreachable from the CLI) to a
// gateway HTTP call.
//
// Real SDK shapes sourced from:
//   types-CR1WAXpo.d.ts — OpenClawPluginCliContext, OpenClawPluginCliRegistrar
//   (shim: openclaw/plugin-sdk/plugin-entry block, extended in T5 for CLI)

import type { OpenClawPluginCliRegistrar, OpenClawPluginCliContext } from 'openclaw/plugin-sdk/plugin-runtime';
import * as fs from 'node:fs';

import { defaultSetupIo, runRaccoonSetup } from './setup-cli.js';

// ---------------------------------------------------------------------------
// RaccoonCliDeps — injectable deps for the CLI commands (testable without a
// live WsHub)
// ---------------------------------------------------------------------------

/**
 * Dependencies injected into the CLI commands.
 * Mirrors the signature of `createRaccoonChannel(...).pair/revoke`.
 */
export interface RaccoonCliDeps {
  /** Issue a Raccoon device-pairing QR for a user. */
  pair(userId: string): Promise<{ token: string; payload: string; qr: string }>;
  /** Revoke the device-pairing session for a user. */
  revoke(userId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Registrar shape — minimal surface we call on the api object
// ---------------------------------------------------------------------------

/** Minimal OpenClawPluginApi surface needed for CLI registration. */
interface CliRegistrar {
  registerCli(registrar: OpenClawPluginCliRegistrar, opts?: {
    parentPath?: string[];
    commands?: string[];
    descriptors?: Array<{ name: string; description: string; hasSubcommands: boolean }>;
  }): void;
}

// ---------------------------------------------------------------------------
// registerRaccoonCli — called by T7's plugin.register() wiring
// ---------------------------------------------------------------------------

/**
 * Register `openclaw raccoon pair <userId>` and `openclaw raccoon revoke <userId>`
 * CLI commands via the OpenClaw registrar contract.
 *
 * @param registrar - OpenClaw plugin API (subset: registerCli). T7 passes the
 *   real `api` from the `register(api)` callback.
 * @param deps - Injectable pair/revoke functions. T7 passes the channel
 *   instance's `.pair` and `.revoke` methods.
 */
export function registerRaccoonCli(registrar: CliRegistrar, deps: RaccoonCliDeps): void {
  const cliRegistrar: OpenClawPluginCliRegistrar = (ctx: OpenClawPluginCliContext) => {
    const { program } = ctx;

    // `openclaw raccoon` parent command
    const raccoon = (program as unknown as {
      command(name: string): {
        description(desc: string): unknown;
        command(name: string): {
          description(desc: string): {
            argument(syntax: string, desc?: string): {
              action(fn: (userId: string) => Promise<void>): unknown;
            };
          };
        };
      };
    }).command('raccoon').description('Raccoon channel management commands') as unknown as {
      command(name: string): {
        description(desc: string): {
          argument(syntax: string, desc?: string): {
            action(fn: (userId: string) => Promise<void>): unknown;
          };
        };
      };
    };

    // `openclaw raccoon pair <userId>`
    raccoon
      .command('pair')
      .description('Issue a Raccoon device-pairing QR for a user')
      .argument('<userId>', 'Raccoon user id to pair')
      .action(async (userId: string) => {
        const result = await deps.pair(userId);
        console.log(`\nRaccoon device pairing QR for user "${userId}":`);
        console.log(result.qr);
        console.log(`Payload: ${result.payload}`);
        console.log(`Token:   ${result.token}`);
      });

    // `openclaw raccoon revoke <userId>`
    raccoon
      .command('revoke')
      .description('Revoke the Raccoon device-pairing session for a user')
      .argument('<userId>', 'Raccoon user id to revoke')
      .action(async (userId: string) => {
        await deps.revoke(userId);
        console.log(`Raccoon device pairing revoked for user "${userId}".`);
      });

    // `openclaw raccoon setup [--url ...] [--tunnel cloudflared] [--channel ...] [--user ...]`
    // One-command onboarding (#3): writes channels.raccoon + plugins.allow,
    // resolves the PWA staticDir, optionally fronts the hub with a quick
    // tunnel, and prints the restart + pair steps. Runs in the CLI process
    // and never needs the gateway to be up.
    const setup = (raccoon as unknown as {
      command(name: string): {
        description(desc: string): {
          option(flags: string, desc: string): unknown;
          action(fn: (opts: Record<string, string | undefined>) => Promise<void>): unknown;
        };
      };
    }).command('setup').description('Configure the Raccoon channel on this OpenClaw host (config, staticDir, TLS, pairing steps)') as unknown as {
      option(flags: string, desc: string): typeof setup;
      action(fn: (opts: Record<string, string | undefined>) => Promise<void>): unknown;
    };
    setup
      .option('--url <wssUrl>', 'public ws(s):// URL clients dial (encoded into pairing QRs)')
      .option('--channel <name>', "channel name shown in the app (default 'assistant')")
      .option('--user <id>', 'user id to allowlist for DMs')
      .option('--port <port>', 'hub port (default 8790)')
      .option('--static-dir <path>', 'absolute path to the built PWA (default: resolved from @raccoon/app)')
      .option('--tunnel <provider>', "front the hub with a quick tunnel ('cloudflared')")
      .option('--config <path>', 'openclaw.json path (default: $OPENCLAW_CONFIG or ~/.openclaw/openclaw.json)')
      .action(async (opts: Record<string, string | undefined>) => {
        const result = await runRaccoonSetup({
          url: opts['url'],
          channel: opts['channel'],
          user: opts['user'],
          port: opts['port'] ? Number(opts['port']) : undefined,
          staticDir: opts['staticDir'],
          tunnel: opts['tunnel'],
          configPath: opts['config'],
        }, defaultSetupIo(fs));
        if (opts['tunnel']) {
          // Keep the CLI (and with it the quick tunnel child process) alive.
          console.log(`\ntunnel active for ${result.instanceUrl} — Ctrl+C to stop.`);
          await new Promise(() => { /* lives until Ctrl+C */ });
        }
      });
  };

  registrar.registerCli(cliRegistrar, {
    commands: ['raccoon'],
    descriptors: [
      { name: 'raccoon', description: 'Raccoon channel management commands', hasSubcommands: true },
    ],
  });
}
