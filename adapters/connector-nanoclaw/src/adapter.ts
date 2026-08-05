import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { agentAddress, createEnvelope, userAddress, type AnyEnvelope } from '@raccoon/protocol';
import { FileCredentialStore } from '@raccoon/transport-ws';
import { parseRaccoonConfig } from './config.js';
import { startAdminServer } from './admin-server.js';
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
  let admin: { port: number; close(): Promise<void> } | null = null;
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
    // Capture the endpoint once: teardown() nulls the closure variable
    // synchronously, and a flush parked on an await must not re-read it and
    // dereference null on the next iteration (the call site is void'd, so
    // that TypeError would surface as an unhandled rejection).
    const ep = endpoint;
    const queue = pendingCards.get(userId);
    if (!queue || queue.length === 0 || !ep) return;
    pendingCards.delete(userId);
    try {
      for (const env of queue) {
        const live = await ep.sendAgentEnvelope(userId, env);
        if (!live) {
          // Torn down mid-flush: teardown already cleared pendingCards —
          // re-buffering would resurrect the map. Drop with a log instead.
          if (endpoint !== ep) {
            console.error(`raccoon: dropping buffered card ${env.id} for ${userId} — adapter torn down mid-flush`);
            continue;
          }
          bufferCard(userId, env); // still offline — keep it
        }
      }
    } catch (err) {
      // Never let a flush rejection escape the void'd call site unhandled.
      console.error(`raccoon: pending-card flush failed for ${userId}:`, err);
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
      let adminSrv: { port: number; close(): Promise<void> } | null = null;
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
        adminSrv = await startAdminServer({
          port: cfg.adminPort,
          host: cfg.adminHost, // '127.0.0.1' unless RACCOON_ADMIN_HOST is set — never cfg.host
          secret: cfg.adminSecret,
          // Closes over the boundary-local ep: the admin listener lives exactly
          // as long as this endpoint and is closed first in teardown.
          deps: () => (ep ? { pair: (u) => ep!.pair(u), revoke: (u) => ep!.revoke(u) } : null),
        });
      } catch (err) {
        try { await adminSrv?.close(); } catch { /* best-effort */ }
        try { await ep?.stop(); } catch { /* start may have left a partial hub */ }
        await store.close?.();
        throw err;
      }
      // Publish state only after every start succeeded.
      sessionStore = store;
      endpoint = ep;
      admin = adminSrv;
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
      // Admin closes FIRST (it depends on the endpoint), then the endpoint.
      // The adapter owns the store it created: close it even when ep.stop()
      // is a no-op (fakes) or throws. close() is idempotent — the real
      // endpoint's stop() also closes it (openclaw gateway #F4 precedent).
      const adminHandle = admin;
      admin = null;
      try {
        await adminHandle?.close();
      } finally {
        try { await ep?.stop(); } finally { await store?.close?.(); }
      }
    },

    isConnected: () => connected,

    async deliver(platformId, _threadId, message: OutboundMessage) {
      // Capture once and use the local throughout: teardown() nulls the
      // closure variable synchronously, and deliver awaits (media.save, sends)
      // between uses — a mid-flight teardown must not make deliver throw at
      // the host (a throw routes into their retry path and ends 'failed').
      // A send after stop() resolving false is fine; a throw is not.
      const ep = endpoint;
      if (!ep) return undefined;
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
        const live = await ep.sendAgentEnvelope(userId, env);
        // Offline: push degrades cards to plain text — buffer the raw envelope
        // and replay it when the user's socket comes back (flushPendingCards).
        if (!live) bufferCard(userId, env);
        return env.id;
      }

      if (content['type'] === 'ask_question') {
        // A question the extractor rejected (duplicate labels, missing
        // fields): falling through to the contentless log would silently
        // swallow the agent's question. Tell the user instead — the card
        // cannot render here, but the question still exists on the host side.
        turns.settle(platformId, ''); // as the card path does: this IS the turn's answer
        const env = createEnvelope('msg', {
          from: agentAddress(channel),
          to: userAddress(userId),
          channel,
          payload: { text: "The agent asked a question this chat cannot render. Answer it from the agent's own interface." },
        });
        const live = await ep.sendAgentEnvelope(userId, env);
        if (!live) console.error(`raccoon deliver: no live socket for ${userId}; unrenderable-question notice is in history`);
        return env.id;
      }

      const text = typeof content['text'] === 'string' ? (content['text'] as string) : '';

      const files = message.files ?? [];
      if (files.length > 0) {
        turns.settle(platformId, '');
        await deliverFilesAsAttachments(
          { media: ep.hub.media, send: (u, e) => ep.sendAgentEnvelope(u, e) },
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
      const live = await ep.sendAgentEnvelope(userId, env);
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
