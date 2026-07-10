import {
  tryParseEnvelope,
  topicUserInbox,
  topicUserOutbox,
  topicUserPresence,
} from '@raccoon/protocol';
import type { Codec, CodecContext, WirePublish, AnyEnvelope } from '@raccoon/protocol';

export const oamCodec: Codec = {
  subscriptions(ctx: CodecContext): Array<{ topic: string; qos: 0 | 1 }> {
    return [{ topic: topicUserOutbox(ctx.instance, ctx.userId), qos: 1 }];
  },

  encode(env: AnyEnvelope, ctx: CodecContext): WirePublish[] {
    return [
      {
        topic: topicUserInbox(ctx.instance, ctx.userId),
        payload: JSON.stringify(env),
        qos: 1,
      },
    ];
  },

  decode(topic: string, payload: string, _ctx: CodecContext): AnyEnvelope[] {
    try {
      const parsed: unknown = JSON.parse(payload);
      const env = tryParseEnvelope(parsed);
      return env ? [env] : [];
    } catch {
      return [];
    }
  },

  onConnect(ctx: CodecContext): WirePublish[] {
    const presenceTopic = topicUserPresence(ctx.instance, ctx.userId);
    return [
      {
        topic: presenceTopic,
        payload: JSON.stringify({ state: 'online', userId: ctx.userId, ts: new Date().toISOString() }),
        qos: 1,
        retain: true,
      },
    ];
  },

  will(ctx: CodecContext): WirePublish | null {
    const presenceTopic = topicUserPresence(ctx.instance, ctx.userId);
    return {
      topic: presenceTopic,
      payload: JSON.stringify({ state: 'offline', userId: ctx.userId }),
      qos: 1,
      retain: true,
    };
  },
};
