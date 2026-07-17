// Tests for `openclaw raccoon setup` (#3) — one-command onboarding on an
// OpenClaw host: merge channels.raccoon config, trust the plugin, resolve the
// PWA staticDir, optionally front the hub with a cloudflared quick tunnel,
// and print the pair instructions.
import { describe, expect, it, vi } from 'vitest';
import {
  mergeRaccoonSetup,
  parseTunnelUrl,
  resolveOpenclawConfigPath,
  runRaccoonSetup,
  type SetupIo,
} from './setup-cli.js';

describe('resolveOpenclawConfigPath', () => {
  it('prefers OPENCLAW_CONFIG, then OPENCLAW_STATE_DIR, then ~/.openclaw', () => {
    expect(resolveOpenclawConfigPath({ OPENCLAW_CONFIG: '/etc/oc.json' }, '/home/u')).toBe('/etc/oc.json');
    expect(resolveOpenclawConfigPath({ OPENCLAW_STATE_DIR: '/data/oc' }, '/home/u')).toBe('/data/oc/openclaw.json');
    expect(resolveOpenclawConfigPath({}, '/home/u')).toBe('/home/u/.openclaw/openclaw.json');
  });
});

describe('parseTunnelUrl', () => {
  it('extracts the trycloudflare URL from cloudflared output', () => {
    const line = '2026-07-17T10:00:00Z INF |  https://tall-fox-quick.trycloudflare.com  |';
    expect(parseTunnelUrl(line)).toBe('https://tall-fox-quick.trycloudflare.com');
  });
  it('returns null for unrelated lines', () => {
    expect(parseTunnelUrl('INF Starting tunnel connection...')).toBeNull();
  });
});

describe('mergeRaccoonSetup', () => {
  it('builds a complete channels.raccoon section on an empty config', () => {
    const { next, warnings } = mergeRaccoonSetup({}, {
      url: 'wss://chat.example.com/', channel: 'atlas', user: 'efi', staticDir: '/abs/app',
    });
    expect(next.channels.raccoon).toEqual({
      port: 8790,
      instanceUrl: 'wss://chat.example.com/',
      channels: ['atlas'],
      allowFrom: ['efi'],
      staticDir: '/abs/app',
    });
    expect(next.plugins.allow).toEqual(['raccoon']);
    // Creating an allowlist disables unlisted local plugins — must warn.
    expect(warnings.some((w) => w.includes('plugins.allow'))).toBe(true);
  });

  it('defaults: channel assistant, port 8790, local-only URL with a warning', () => {
    const { next, warnings } = mergeRaccoonSetup({}, {});
    expect(next.channels.raccoon.channels).toEqual(['assistant']);
    expect(next.channels.raccoon.instanceUrl).toBe('ws://127.0.0.1:8790/');
    expect(warnings.some((w) => w.includes('same machine') || w.includes('local'))).toBe(true);
  });

  it('preserves existing config: appends to allow, merges allowFrom, keeps other keys', () => {
    const existing = {
      gateway: { mode: 'local' },
      plugins: { allow: ['telegram-x'] },
      channels: { telegram: { token: 't' }, raccoon: { port: 9000, allowFrom: ['demo'] } },
    };
    const { next } = mergeRaccoonSetup(existing, { user: 'efi', url: 'wss://c.example/' });
    expect(next.gateway).toEqual({ mode: 'local' });
    expect(next.channels.telegram).toEqual({ token: 't' });
    expect(next.plugins.allow).toEqual(['telegram-x', 'raccoon']);
    expect(next.channels.raccoon.port).toBe(9000);          // kept
    expect(next.channels.raccoon.allowFrom).toEqual(['demo', 'efi']); // merged, no dupes
  });

  it('is idempotent: re-running does not duplicate allow or allowFrom entries', () => {
    const once = mergeRaccoonSetup({}, { user: 'efi' }).next;
    const twice = mergeRaccoonSetup(once, { user: 'efi' }).next;
    expect(twice.plugins.allow).toEqual(['raccoon']);
    expect(twice.channels.raccoon.allowFrom).toEqual(['efi']);
  });

  // Issue #4: without approvals.exec.enabled, OpenClaw never forwards
  // exec-approval requests to any chat channel — the approval card can't
  // render and an ask=always exec turn stalls until the approval expires.
  it('enables approvals.exec (session mode) when the config has no approvals.exec at all', () => {
    const { next, warnings } = mergeRaccoonSetup({}, {});
    expect((next as Record<string, unknown>)['approvals']).toEqual({
      exec: { enabled: true, mode: 'session' },
    });
    expect(warnings.some((w) => w.includes('approvals.exec'))).toBe(true);
  });

  it('leaves an existing approvals.exec section untouched (operator intent)', () => {
    const disabled = { approvals: { exec: { enabled: false } } };
    const { next, warnings } = mergeRaccoonSetup(disabled, {});
    expect((next as Record<string, unknown>)['approvals']).toEqual({ exec: { enabled: false } });
    expect(warnings.some((w) => w.includes('approvals.exec'))).toBe(false);
  });

  it('preserves sibling approvals keys when adding exec', () => {
    const existing = { approvals: { plugin: { enabled: true } } };
    const { next } = mergeRaccoonSetup(existing, {});
    expect((next as Record<string, unknown>)['approvals']).toEqual({
      plugin: { enabled: true },
      exec: { enabled: true, mode: 'session' },
    });
  });
});

function makeIo(overrides?: Partial<SetupIo> & { files?: Record<string, string> }): SetupIo & { files: Record<string, string>; logs: string[] } {
  const files: Record<string, string> = overrides?.files ?? {};
  const logs: string[] = [];
  return {
    files,
    logs,
    readFile: (p) => files[p] ?? null,
    writeFile: (p, c) => { files[p] = c; },
    log: (m) => logs.push(m),
    resolveAppStaticDir: () => '/resolved/app/dist-standalone',
    startTunnel: vi.fn(async () => ({ url: 'https://demo-tunnel.trycloudflare.com' })),
    ...overrides,
  };
}

describe('runRaccoonSetup', () => {
  it('writes the merged config with a backup of the original', async () => {
    const io = makeIo({ files: { '/cfg/openclaw.json': '{"gateway":{"mode":"local"}}' } });
    const res = await runRaccoonSetup({ configPath: '/cfg/openclaw.json', url: 'wss://c.example/', user: 'efi' }, io);
    expect(io.files['/cfg/openclaw.json.bak-raccoon-setup']).toBe('{"gateway":{"mode":"local"}}');
    const written = JSON.parse(io.files['/cfg/openclaw.json']!);
    expect(written.gateway.mode).toBe('local');
    expect(written.channels.raccoon.instanceUrl).toBe('wss://c.example/');
    expect(res.instanceUrl).toBe('wss://c.example/');
    // Next steps must mention restart + pair.
    const out = io.logs.join('\n');
    expect(out).toMatch(/restart/i);
    expect(out).toMatch(/raccoon pair efi/);
  });

  it('resolves staticDir from the installed @raccoon/app when not given', async () => {
    const io = makeIo();
    await runRaccoonSetup({ configPath: '/cfg/openclaw.json' }, io);
    const written = JSON.parse(io.files['/cfg/openclaw.json']!);
    expect(written.channels.raccoon.staticDir).toBe('/resolved/app/dist-standalone');
  });

  it('warns instead of failing when no staticDir can be resolved', async () => {
    const io = makeIo({ resolveAppStaticDir: () => null });
    const res = await runRaccoonSetup({ configPath: '/cfg/openclaw.json' }, io);
    expect(res.warnings.some((w) => w.includes('staticDir'))).toBe(true);
    const written = JSON.parse(io.files['/cfg/openclaw.json']!);
    expect(written.channels.raccoon.staticDir).toBeUndefined();
  });

  it('--tunnel cloudflared: derives the wss instanceUrl from the quick tunnel', async () => {
    const io = makeIo();
    const res = await runRaccoonSetup({ configPath: '/cfg/openclaw.json', tunnel: 'cloudflared', port: 8791 }, io);
    expect(io.startTunnel).toHaveBeenCalledWith(8791);
    expect(res.instanceUrl).toBe('wss://demo-tunnel.trycloudflare.com/');
    const written = JSON.parse(io.files['/cfg/openclaw.json']!);
    expect(written.channels.raccoon.instanceUrl).toBe('wss://demo-tunnel.trycloudflare.com/');
    expect(io.logs.join('\n')).toMatch(/keep this process/i);
  });

  it('an explicit --url beats the tunnel URL', async () => {
    const io = makeIo();
    const res = await runRaccoonSetup({ configPath: '/c.json', url: 'wss://mine.example/', tunnel: 'cloudflared' }, io);
    expect(res.instanceUrl).toBe('wss://mine.example/');
  });
});
