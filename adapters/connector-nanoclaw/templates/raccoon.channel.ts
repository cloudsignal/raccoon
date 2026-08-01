// Raccoon channel for NanoClaw. Installed by the add-raccoon skill:
// this file + raccoon.bundle.mjs + raccoon.bundle.d.mts + raccoon-app/ live in
// src/channels/, and src/channels/index.ts gains `import './raccoon.js';`.
// Config comes from .env (RACCOON_PORT, RACCOON_INSTANCE_URL,
// RACCOON_PUBLIC_ORIGIN, RACCOON_CHANNELS, RACCOON_ADMIN_SECRET, ...).
// When required vars are missing the factory returns null and NanoClaw
// skips the channel.
//
// The explicit ChannelRegistration annotation below is the install-time
// structural check: the bundle's declared shapes (raccoon.bundle.d.mts) must
// remain assignable to THIS fork's adapter contract. If NanoClaw's interface
// has drifted, this file fails to compile — that is the signal to update the
// connector, not to loosen the types.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ChannelRegistration } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { createRaccoonChannelAdapter, RACCOON_CHANNEL_DEFAULTS } from './raccoon.bundle.mjs';

const here = dirname(fileURLToPath(import.meta.url));

const registration: ChannelRegistration = {
  factory: () => createRaccoonChannelAdapter({ staticDir: join(here, 'raccoon-app') }),
  // dm: every message engages (pattern '.'); mentions 'dm-only' — the adapter
  // flags every DM as a mention so the router's registration flow fires for
  // new conversations.
  defaults: RACCOON_CHANNEL_DEFAULTS,
};

registerChannelAdapter('raccoon', registration);
