import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { agentAddress, createEnvelope, userAddress, type AnyEnvelope } from '@raccoon/protocol';
import { FileCredentialStore } from '@raccoon/transport-ws';
import { parseRaccoonConfig } from './config.js';
import { createRaccoonEndpoint, type RaccoonEndpoint } from './endpoint.js';
import { buildNanoClawRunner, type HostCallbacks } from './runner.js';
import { createTurnStore } from './turns.js';
import { extractQuestionCard, buildApprovalEnvelope, createApprovalValueStore } from './approvals.js';
import { deliverFilesAsAttachments } from './media.js';
import { fromPlatformId } from './platform-id.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './nanoclaw-types.js';

export interface AdapterDeps {
  env?: Record<string, string | undefined>;
  createEndpoint?: typeof createRaccoonEndpoint;
  staticDir?: string;
}

const TYPING_STOP_MS = 10_000;
const BRIDGE_DEADLINE_MARGIN_MS = 30_000;

/** Full ChannelDefaults declaration for the wrapper's registration. All three
 *  fields are required by their shape; group is never exercised (raccoon has
 *  no group chats) but must be present and thread-consistent. */
export const RACCOON_CHANNEL_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'dm-only',
};

/** Build the NanoClaw ChannelAdapter, or null when unconfigured (their
 *  graceful-skip convention: a factory returning null disables the channel). */
export function createRaccoonChannelAdapter(deps: AdapterDeps = {}): ChannelAdapter | null {
  const cfg = parseRaccoonConfig(deps.env ?? process.env);
  if (!cfg) return null;
  const makeEndpoint = deps.createEndpoint ?? createRaccoonEndpoint;

  const turns = createTurnStore();
  const approvalValues = createApprovalValueStore();
  let host: HostCallbacks | null = null;
  let endpoint: RaccoonEndpoint | null = null;
  let sessionStore: FileCredentialStore | null = null;
  let unsubscribeFlush: (() => void) | null = null;
  let connected = false;
  const typingStops = new Map<string, NodeJS.Timeout>();

  // Offline approval cards, buffered per user until any inbound envelope
  // proves the socket is live (push fallback reduces cards to notification
  // text; the PWA can only persist an actionable card from the raw envelope).
  const PENDING_CARDS_CAP = 20;
  const pendingCards = new Map<string, AnyEnvelope[]>();

  function bufferCard(userId: string, env: AnyEnvelope): void {
    const queue = pendingCards.get(userId) ?? [];
    if (queue.length >= PENDING_CARDS_CAP) {
      const dropped = queue.shift();
      console.error(`raccoon: pending-card buffer full for ${userId}; dropping oldest ${dropped?.id}`);
    }
    queue.push(env);
    pendingCards.set(userId, queue);
  }

  async function flushPendingCards(userId: string): Promise<void> {
    const queue = pendingCards.get(userId);
    if (!queue || queue.length === 0 || !endpoint) return;
    pendingCards.delete(userId);
    for (const env of queue) {
      const live = await endpoint.sendAgentEnvelope(userId, env);
      if (!live) bufferCard(userId, env); // still offline — keep it
    }
  }

  const runner = buildNanoClawRunner({
    host: () => host,
    turns,
    approvalValues,
    publicOrigin: cfg.publicOrigin,
    turnTimeoutMs: cfg.turnTimeoutMs,
  });

  return {
    name: 'raccoon',
    channelType: 'raccoon',
    instance: cfg.instance,
    supportsThreads: false,

    async setup(setup: ChannelSetup) {
      const callbacks: HostCallbacks = {
        onInbound: setup.onInbound.bind(setup),
        onAction: setup.onAction.bind(setup),
      };
      // ONE fail-clean boundary: store, endpoint, and (Task 9) admin listener
      // all start here; on any failure close everything created so far and
      // publish nothing — the adapter is never observable half-started.
      mkdirSync(cfg.dataDir, { recursive: true });
      const store = new FileCredentialStore({ path: join(cfg.dataDir, 'sessions.json') });
      let ep: RaccoonEndpoint | null = null;
      try {
        ep = makeEndpoint({
          instance: cfg.instance,
          instanceUrl: cfg.instanceUrl,
          ...(cfg.host ? { host: cfg.host } : {}),
          port: cfg.port,
          channels: cfg.channels.map((c) => c.channel),
          runner,
          ...(deps.staticDir ? { staticDir: deps.staticDir } : {}),
          mediaDir: join(cfg.dataDir, 'media'),
          ...(cfg.vapid ? { vapid: cfg.vapid } : {}),
          sessionStore: store,
          // The bridge's own deadline must not fire before the park timeout —
          // it would ack 'stalled' and defeat the silent async fallback.
          turnDeadlineMs: cfg.turnTimeoutMs + BRIDGE_DEADLINE_MARGIN_MS,
        });
        await ep.start();
        // admin server attaches here (Task 9 — inside this same boundary)
      } catch (err) {
        try { await ep?.stop(); } catch { /* start may have left a partial hub */ }
        await store.close?.();
        throw err;
      }
      // Publish state only after every start succeeded.
      sessionStore = store;
      endpoint = ep;
      host = callbacks;
      unsubscribeFlush = ep.hub.onEnvelope((_env, userId) => { void flushPendingCards(userId); });
      connected = true;
    },

    async teardown() {
      connected = false;
      turns.cancelAll();
      for (const t of typingStops.values()) clearTimeout(t);
      typingStops.clear();
      pendingCards.clear();
      unsubscribeFlush?.();
      unsubscribeFlush = null;
      const ep = endpoint;
      endpoint = null;
      const store = sessionStore;
      sessionStore = null;
      host = null;
      // The adapter owns the store it created: close it even when ep.stop()
      // is a no-op (fakes) or throws. close() is idempotent — the real
      // endpoint's stop() also closes it (openclaw gateway #F4 precedent).
      try {
        await ep?.stop();
      } finally {
        await store?.close?.();
      }
    },

    isConnected: () => connected,

    async deliver(platformId, _threadId, message: OutboundMessage) {
      if (!endpoint) return undefined;
      const ids = fromPlatformId(platformId);
      if (!ids) {
        console.error(`raccoon deliver: malformed platformId "${platformId}"`);
        return undefined;
      }
      const { channel, userId } = ids;
      const content = (message.content ?? {}) as Record<string, unknown>;

      const card = extractQuestionCard(message);
      if (card) {
        approvalValues.remember(card.questionId, card.options);
        turns.settle(platformId, ''); // the card IS the answer; end the parked turn silently
        const env = buildApprovalEnvelope(channel, userId, card);
        const live = await endpoint.sendAgentEnvelope(userId, env);
        // Offline: push degrades cards to plain text — buffer the raw envelope
        // and replay it when the user's socket comes back (flushPendingCards).
        if (!live) bufferCard(userId, env);
        return env.id;
      }

      const text = typeof content['text'] === 'string' ? (content['text'] as string) : '';

      const files = message.files ?? [];
      if (files.length > 0) {
        turns.settle(platformId, '');
        await deliverFilesAsAttachments(
          { media: endpoint.hub.media, send: (u, e) => endpoint!.sendAgentEnvelope(u, e) },
          channel,
          userId,
          files,
          text,
        );
        return undefined;
      }

      if (text.length === 0) {
        console.error(`raccoon deliver: nothing deliverable in kind=${message.kind}`);
        return undefined;
      }
      if (turns.settle(platformId, text)) return undefined; // parked runner yields it
      const env = createEnvelope('msg', {
        from: agentAddress(channel),
        to: userAddress(userId),
        channel,
        payload: { text },
      });
      const live = await endpoint.sendAgentEnvelope(userId, env);
      if (!live) console.error(`raccoon deliver: no live socket for ${userId}; message is in history (push may deliver)`);
      return env.id;
    },

    async setTyping(platformId, _threadId) {
      if (!endpoint) return;
      const ids = fromPlatformId(platformId);
      if (!ids) return;
      const send = (state: 'start' | 'stop') => {
        const env = createEnvelope('typing', {
          from: agentAddress(ids.channel),
          to: userAddress(ids.userId),
          channel: ids.channel,
          payload: { state },
        });
        void endpoint?.sendAgentEnvelope(ids.userId, env);
      };
      send('start');
      clearTimeout(typingStops.get(platformId));
      typingStops.set(platformId, setTimeout(() => { typingStops.delete(platformId); send('stop'); }, TYPING_STOP_MS));
    },
  };
}
