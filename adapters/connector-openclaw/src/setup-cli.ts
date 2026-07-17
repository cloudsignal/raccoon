// `openclaw raccoon setup` (#3) — one-command onboarding on an OpenClaw host.
//
// Composes what already exists (the channel config surface, the pairing CLI,
// the hosting patterns) into a single non-interactive-friendly command:
//
//   openclaw raccoon setup --url wss://chat.example.com/ --user efi
//   openclaw raccoon setup --tunnel cloudflared --user efi   # no proxy needed
//
// It merges `channels.raccoon` into openclaw.json (backing the file up first),
// trusts the plugin in `plugins.allow`, resolves the PWA staticDir from the
// installed @raccoon/app, optionally fronts the hub with a cloudflared quick
// tunnel (the tunnel hostname becomes the pairing instanceUrl), and prints
// the restart + pair steps. It deliberately does NOT restart the gateway —
// how the gateway runs (terminal, docker, systemd) is the host's business.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SetupOptions {
  /** Public ws(s):// URL clients dial; encoded into pairing QR codes. */
  url?: string;
  /** Channel name (chat title in the app). Default 'assistant'. */
  channel?: string;
  /** User id to allowlist for DMs (and to use in the printed pair command). */
  user?: string;
  /** Hub port. Default 8790 (an existing configured port is kept). */
  port?: number;
  /** Absolute path to the built PWA. Default: resolved from @raccoon/app. */
  staticDir?: string;
  /** 'cloudflared': front the hub with a quick tunnel and use its hostname. */
  tunnel?: string;
  /** openclaw.json path. Default: $OPENCLAW_CONFIG, $OPENCLAW_STATE_DIR, ~/.openclaw. */
  configPath?: string;
}

/** Injectable side effects so the orchestration is testable. */
export interface SetupIo {
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  log(message: string): void;
  resolveAppStaticDir(): string | null;
  startTunnel(port: number): Promise<{ url: string }>;
}

interface RaccoonSection {
  port: number;
  instanceUrl: string;
  channels: string[];
  allowFrom: string[];
  staticDir?: string;
  [k: string]: unknown;
}

// ---------------------------------------------------------------------------
// Pure pieces
// ---------------------------------------------------------------------------

export function resolveOpenclawConfigPath(env: Record<string, string | undefined>, home: string): string {
  if (env['OPENCLAW_CONFIG']) return env['OPENCLAW_CONFIG'];
  if (env['OPENCLAW_STATE_DIR']) return join(env['OPENCLAW_STATE_DIR'], 'openclaw.json');
  return join(home, '.openclaw', 'openclaw.json');
}

/** Extract a quick-tunnel URL from a cloudflared output line, or null. */
export function parseTunnelUrl(line: string): string | null {
  const m = line.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  return m ? m[0] : null;
}

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? { ...(v as Record<string, unknown>) } : {};

const asStringArray = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];

/**
 * Merge a raccoon setup into an existing openclaw.json object. Pure: returns
 * the next config + human warnings; never mutates the input.
 */
export function mergeRaccoonSetup(
  cfg: Record<string, unknown>,
  opts: Pick<SetupOptions, 'url' | 'channel' | 'user' | 'port' | 'staticDir'>,
): { next: { plugins: { allow: string[]; [k: string]: unknown }; channels: { raccoon: RaccoonSection; [k: string]: unknown }; [k: string]: unknown }; warnings: string[] } {
  const warnings: string[] = [];
  const channels = asRecord(cfg['channels']);
  const existing = asRecord(channels['raccoon']);

  const port = opts.port ?? (typeof existing['port'] === 'number' ? (existing['port'] as number) : 8790);

  let instanceUrl = opts.url ?? (typeof existing['instanceUrl'] === 'string' ? (existing['instanceUrl'] as string) : undefined);
  if (!instanceUrl) {
    instanceUrl = `ws://127.0.0.1:${port}/`;
    warnings.push(
      `no --url given: instanceUrl defaults to ${instanceUrl}, which only pairs a browser on the same machine. ` +
      'Pass your public wss:// URL (or use --tunnel cloudflared) to pair a phone.',
    );
  }

  const channelName = opts.channel ?? (asStringArray(existing['channels'])[0] ?? 'assistant');

  const allowFrom = asStringArray(existing['allowFrom']);
  if (opts.user && !allowFrom.includes(opts.user)) allowFrom.push(opts.user);

  const raccoon: RaccoonSection = {
    ...existing,
    port,
    instanceUrl,
    channels: [channelName, ...asStringArray(existing['channels']).filter((c) => c !== channelName && opts.channel === undefined)].slice(0, opts.channel ? 1 : undefined) as string[],
    allowFrom,
  };
  if (opts.staticDir) raccoon.staticDir = opts.staticDir;

  const plugins = asRecord(cfg['plugins']);
  const hadAllow = Array.isArray(plugins['allow']);
  const allow = asStringArray(plugins['allow']);
  if (!allow.includes('raccoon')) allow.push('raccoon');
  if (!hadAllow) {
    warnings.push(
      'created the plugins.allow allowlist with ["raccoon"]. OpenClaw disables locally-linked plugins that are ' +
      'not on this list — add any others you use.',
    );
  }

  // Exec-approval forwarding: without approvals.exec.enabled, OpenClaw never
  // delivers exec-approval requests to ANY chat channel — an `ask=always`
  // exec turn just stalls until the approval expires. Enable it (session
  // mode: the request goes back to the conversation that started the turn,
  // where the Raccoon card renders) ONLY when the operator has no
  // approvals.exec section at all; an existing section is operator intent
  // and is left untouched.
  const approvals = asRecord(cfg['approvals']);
  if (approvals['exec'] === undefined) {
    approvals['exec'] = { enabled: true, mode: 'session' };
    warnings.push(
      'enabled approvals.exec (mode: session) so exec-approval prompts reach the Raccoon card. ' +
      'Approvals only trigger once exec approvals are configured (openclaw approvals set — ask: on-miss or always).',
    );
  }

  return {
    next: {
      ...cfg,
      plugins: { ...plugins, allow },
      channels: { ...channels, raccoon },
      approvals,
    },
    warnings,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runRaccoonSetup(
  opts: SetupOptions,
  io: SetupIo,
): Promise<{ configPath: string; instanceUrl: string; warnings: string[] }> {
  const configPath = opts.configPath ?? resolveOpenclawConfigPath(process.env, process.env['HOME'] ?? '~');
  const raw = io.readFile(configPath);
  let cfg: Record<string, unknown> = {};
  if (raw) {
    try { cfg = JSON.parse(raw) as Record<string, unknown>; }
    catch { throw new Error(`${configPath} is not valid JSON — fix or remove it, then re-run setup.`); }
  }

  const port = opts.port ?? 8790;
  let url = opts.url;
  let tunneled = false;
  if (!url && opts.tunnel === 'cloudflared') {
    io.log(`starting a cloudflared quick tunnel for http://127.0.0.1:${port} …`);
    const t = await io.startTunnel(port);
    url = t.url.replace(/^https:/, 'wss:').replace(/\/?$/, '/');
    tunneled = true;
    io.log(`tunnel up: ${t.url}`);
  } else if (opts.tunnel && opts.tunnel !== 'cloudflared') {
    throw new Error(`unknown --tunnel provider '${opts.tunnel}' (supported: cloudflared)`);
  }

  const warnings: string[] = [];
  let staticDir = opts.staticDir ?? null;
  if (!staticDir) {
    staticDir = io.resolveAppStaticDir();
    if (!staticDir) {
      warnings.push(
        'could not resolve the PWA staticDir (is @raccoon/app installed, or the monorepo built?). ' +
        'Set channels.raccoon.staticDir to an ABSOLUTE dist-standalone path yourself.',
      );
    }
  }

  const merged = mergeRaccoonSetup(cfg, {
    url, channel: opts.channel, user: opts.user, port: opts.port, staticDir: staticDir ?? undefined,
  });
  warnings.push(...merged.warnings);

  if (raw) io.writeFile(`${configPath}.bak-raccoon-setup`, raw);
  io.writeFile(configPath, JSON.stringify(merged.next, null, 2) + '\n');

  const instanceUrl = merged.next.channels.raccoon.instanceUrl;
  const pairUser = opts.user ?? '<userId>';
  io.log(`\nwrote ${configPath}${raw ? ` (backup: ${configPath}.bak-raccoon-setup)` : ''}`);
  for (const w of warnings) io.log(`warning: ${w}`);
  io.log(`\nNext steps:`);
  io.log(`  1. Restart the OpenClaw gateway so it picks up the raccoon channel.`);
  io.log(`  2. openclaw raccoon pair ${pairUser}    # prints the pairing QR`);
  io.log(`  3. Open ${instanceUrl.replace(/^ws/, 'http')} and scan (or paste) it.`);
  if (tunneled) {
    io.log(`\ntunnel note: keep this process running — the quick tunnel (and its URL) dies with it.`);
    io.log(`For something permanent, see examples/hosting/ in the raccoon repo.`);
  }

  return { configPath, instanceUrl, warnings };
}

// ---------------------------------------------------------------------------
// Real IO
// ---------------------------------------------------------------------------

export function defaultSetupIo(fs: Pick<typeof import('node:fs'), 'readFileSync' | 'writeFileSync' | 'existsSync'>): SetupIo {
  return {
    readFile: (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null),
    writeFile: (p, c) => fs.writeFileSync(p, c),
    log: (m) => console.log(m),
    resolveAppStaticDir: () => {
      try {
        const require = createRequire(import.meta.url);
        return join(dirname(require.resolve('@raccoon/app/package.json')), 'dist-standalone');
      } catch {
        return null;
      }
    },
    startTunnel: (port) =>
      new Promise((resolve, reject) => {
        const child = spawn('cloudflared', ['tunnel', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
        let settled = false;
        const scan = (chunk: Buffer) => {
          const url = parseTunnelUrl(chunk.toString());
          if (url && !settled) { settled = true; resolve({ url }); }
        };
        child.stdout.on('data', scan);
        child.stderr.on('data', scan);
        child.on('error', (err: NodeJS.ErrnoException) => {
          if (settled) return;
          settled = true;
          reject(err.code === 'ENOENT'
            ? new Error('cloudflared not found — install it (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/) or pass --url instead.')
            : err);
        });
        child.on('exit', (code) => {
          if (!settled) { settled = true; reject(new Error(`cloudflared exited (code ${code}) before printing a tunnel URL`)); }
        });
        // The tunnel must outlive setup's own work: the process stays attached
        // and the action keeps the CLI alive (see cli.ts).
      }),
  };
}
