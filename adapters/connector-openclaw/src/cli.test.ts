// adapters/openclaw/src/cli.test.ts
// Task 5 TDD: CLI registrar (registerRaccoonCli) tests.
// Tests verify the testable payload/allowlist logic; full registrar wiring
// is smoke-checked in T8 against the live CLI.

import { describe, it, expect, vi } from 'vitest';

// These imports will fail until cli.ts exists — that is the RED state.
import { registerRaccoonCli, type RaccoonCliDeps } from './cli.js';

// ---------------------------------------------------------------------------
// Minimal Command stub (mirrors commander.Command surface we use)
// ---------------------------------------------------------------------------

interface StubCommand {
  command(name: string): StubCommand;
  description(desc: string): StubCommand;
  argument(syntax: string, desc?: string): StubCommand;
  action(fn: (...args: unknown[]) => Promise<void> | void): StubCommand;
  // Track registered subcommands for assertions
  _registeredCommands: string[];
}

function makeStubCommand(): StubCommand {
  const cmds: string[] = [];
  const stub: StubCommand = {
    _registeredCommands: cmds,
    command(name) {
      cmds.push(name);
      return stub; // fluent chain
    },
    description() { return stub; },
    argument() { return stub; },
    action() { return stub; },
  };
  return stub;
}

// ---------------------------------------------------------------------------
// Minimal registrar stub
// ---------------------------------------------------------------------------

function makeStubRegistrar(program: StubCommand) {
  return {
    registerCli: vi.fn((registrar: (ctx: { program: unknown; parentPath: readonly string[]; config: unknown; logger: unknown }) => void) => {
      registrar({ program, parentPath: [], config: {}, logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } });
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('registerRaccoonCli', () => {
  it('calls registrar.registerCli exactly once', () => {
    const program = makeStubCommand();
    const registrar = makeStubRegistrar(program);
    const deps: RaccoonCliDeps = {
      pair: vi.fn().mockResolvedValue({ token: 't', payload: 'p', qr: 'q' }),
      revoke: vi.fn().mockResolvedValue(undefined),
    };

    registerRaccoonCli(registrar as any, deps);

    expect(registrar.registerCli).toHaveBeenCalledTimes(1);
  });

  it('registers a "raccoon" top-level command', () => {
    const program = makeStubCommand();
    const registrar = makeStubRegistrar(program);
    const deps: RaccoonCliDeps = {
      pair: vi.fn().mockResolvedValue({ token: 't', payload: 'p', qr: 'q' }),
      revoke: vi.fn().mockResolvedValue(undefined),
    };

    registerRaccoonCli(registrar as any, deps);

    expect(program._registeredCommands).toContain('raccoon');
  });

  it('pair action calls deps.pair with the userId', async () => {
    let pairAction: ((userId: string) => Promise<void>) | null = null;

    // Build a stub that captures the action registered under "pair"
    const racSubCmds: string[] = [];
    const raccoonStub: StubCommand = {
      _registeredCommands: racSubCmds,
      command(name) { racSubCmds.push(name); return raccoonStub; },
      description() { return raccoonStub; },
      argument() { return raccoonStub; },
      action(fn) {
        if (racSubCmds[racSubCmds.length - 1] === 'pair') {
          pairAction = fn as (userId: string) => Promise<void>;
        }
        return raccoonStub;
      },
    };

    const program = makeStubCommand();
    // Override .command('raccoon') to return our raccoonStub so subcommands register on it
    program.command = (name: string) => {
      program._registeredCommands.push(name);
      return raccoonStub;
    };

    const registrar = makeStubRegistrar(program);
    const mockPair = vi.fn().mockResolvedValue({ token: 't', payload: 'p', qr: 'q' });
    const deps: RaccoonCliDeps = {
      pair: mockPair,
      revoke: vi.fn().mockResolvedValue(undefined),
    };

    registerRaccoonCli(registrar as any, deps);

    // pair action must have been captured
    expect(pairAction).not.toBeNull();
    await pairAction!('alice');

    expect(mockPair).toHaveBeenCalledWith('alice');
  });

  it('revoke action calls deps.revoke with the userId', async () => {
    let revokeAction: ((userId: string) => Promise<void>) | null = null;

    const racSubCmds: string[] = [];
    const raccoonStub: StubCommand = {
      _registeredCommands: racSubCmds,
      command(name) { racSubCmds.push(name); return raccoonStub; },
      description() { return raccoonStub; },
      argument() { return raccoonStub; },
      action(fn) {
        if (racSubCmds[racSubCmds.length - 1] === 'revoke') {
          revokeAction = fn as (userId: string) => Promise<void>;
        }
        return raccoonStub;
      },
    };

    const program = makeStubCommand();
    program.command = (name: string) => {
      program._registeredCommands.push(name);
      return raccoonStub;
    };

    const registrar = makeStubRegistrar(program);
    const mockRevoke = vi.fn().mockResolvedValue(undefined);
    const deps: RaccoonCliDeps = {
      pair: vi.fn().mockResolvedValue({ token: 't', payload: 'p', qr: 'q' }),
      revoke: mockRevoke,
    };

    registerRaccoonCli(registrar as any, deps);

    expect(revokeAction).not.toBeNull();
    await revokeAction!('bob');

    expect(mockRevoke).toHaveBeenCalledWith('bob');
  });
});
