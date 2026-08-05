export interface ChannelMapEntry { channel: string; agentGroup: string }

export interface RaccoonConnectorConfig {
  port: number;
  host?: string;
  instance: string;
  instanceUrl: string;
  publicOrigin: string;
  channels: ChannelMapEntry[];
  adminSecret: string;
  adminPort: number;
  adminHost: string;
  dataDir: string;
  turnTimeoutMs: number;
  vapid?: { publicKey: string; privateKey: string; subject: string };
}

type Env = Record<string, string | undefined>;

function req(env: Env, key: string): string | null {
  const v = env[key]?.trim();
  return v !== undefined && v.length > 0 ? v : null;
}

function intOf(raw: string, key: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${key} must be a positive integer, got "${raw}"`);
  return n;
}

/** Ports allow 0 (ephemeral bind — tests and containers behind port maps). */
function portOf(raw: string, key: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`${key} must be a port number, got "${raw}"`);
  return n;
}

function parseChannels(raw: string): ChannelMapEntry[] {
  const entries = raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (entries.length === 0) throw new Error('RACCOON_CHANNELS is empty');
  const seen = new Set<string>();
  return entries.map((entry) => {
    const eq = entry.indexOf('=');
    const channel = eq > 0 ? entry.slice(0, eq).trim() : '';
    const agentGroup = eq > 0 ? entry.slice(eq + 1).trim() : '';
    if (channel.length === 0 || agentGroup.length === 0) {
      throw new Error(`RACCOON_CHANNELS entry "${entry}" must be channel=agent-group`);
    }
    if (seen.has(channel)) throw new Error(`RACCOON_CHANNELS has duplicate channel "${channel}"`);
    seen.add(channel);
    return { channel, agentGroup };
  });
}

/** Null when a required var is absent (graceful channel skip); throws when a
 *  present value is malformed (misconfiguration must be loud). agentGroup
 *  values are install-time wiring input only — the runtime adapter uses just
 *  the channel names. adminHost never inherits RACCOON_HOST: exposing the hub
 *  to 0.0.0.0 must not silently expose the pair/revoke listener. */
export function parseRaccoonConfig(env: Env): RaccoonConnectorConfig | null {
  const portRaw = req(env, 'RACCOON_PORT');
  const instanceUrl = req(env, 'RACCOON_INSTANCE_URL');
  const originRaw = req(env, 'RACCOON_PUBLIC_ORIGIN');
  const channelsRaw = req(env, 'RACCOON_CHANNELS');
  const adminSecret = req(env, 'RACCOON_ADMIN_SECRET');
  if (!portRaw || !instanceUrl || !originRaw || !channelsRaw || !adminSecret) return null;

  const port = portOf(portRaw, 'RACCOON_PORT');
  const adminPortRaw = req(env, 'RACCOON_ADMIN_PORT');
  const timeoutRaw = req(env, 'RACCOON_TURN_TIMEOUT_MS');
  const vapidPk = req(env, 'VAPID_PUBLIC_KEY');
  const vapidSk = req(env, 'VAPID_PRIVATE_KEY');
  const vapidSub = req(env, 'VAPID_SUBJECT');
  const host = req(env, 'RACCOON_HOST');

  return {
    port,
    ...(host ? { host } : {}),
    instance: req(env, 'RACCOON_INSTANCE') ?? 'nanoclaw',
    instanceUrl,
    publicOrigin: originRaw.replace(/\/+$/, ''),
    channels: parseChannels(channelsRaw),
    adminSecret,
    adminPort: adminPortRaw ? portOf(adminPortRaw, 'RACCOON_ADMIN_PORT') : port + 1,
    adminHost: req(env, 'RACCOON_ADMIN_HOST') ?? '127.0.0.1',
    dataDir: req(env, 'RACCOON_DATA_DIR') ?? './data/raccoon',
    turnTimeoutMs: timeoutRaw ? intOf(timeoutRaw, 'RACCOON_TURN_TIMEOUT_MS') : 90_000,
    ...(vapidPk && vapidSk && vapidSub
      ? { vapid: { publicKey: vapidPk, privateKey: vapidSk, subject: vapidSub } }
      : {}),
  };
}
