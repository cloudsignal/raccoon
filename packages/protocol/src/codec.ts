import type { AnyEnvelope } from './envelope.js';

export interface CodecContext {
  instance: string;
  userId: string;
}

export interface WirePublish {
  topic: string;
  payload: string;
  qos?: 0 | 1;
  retain?: boolean;
}

export interface Codec {
  subscriptions(ctx: CodecContext): Array<{ topic: string; qos: 0 | 1 }>;
  encode(env: AnyEnvelope, ctx: CodecContext): WirePublish[];
  decode(topic: string, payload: string, ctx: CodecContext): AnyEnvelope[];
  onConnect?(ctx: CodecContext): WirePublish[];
  will?(ctx: CodecContext): WirePublish | null;
}
