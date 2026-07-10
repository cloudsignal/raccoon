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
  };

  registrar.registerCli(cliRegistrar, {
    commands: ['raccoon'],
    descriptors: [
      { name: 'raccoon', description: 'Raccoon channel management commands', hasSubcommands: true },
    ],
  });
}
