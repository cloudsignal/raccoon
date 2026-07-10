import { ulid } from 'ulid';
import { z } from 'zod';

export const OAM_VERSION = '0.1' as const;

const address = z.union([
  z.templateLiteral(['user:', z.string().min(1)]),
  z.templateLiteral(['agent:', z.string().min(1)]),
  z.literal('system'),
]);
export type Address = z.infer<typeof address>;

const historyMessage = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'agent']),
  text: z.string(),
  ts: z.iso.datetime(),
});
export type HistoryMessage = z.infer<typeof historyMessage>;

const base = z.object({
  oam: z.literal(OAM_VERSION),
  id: z.string().min(1),
  from: address,
  to: address,
  channel: z.string().min(1),
  ts: z.iso.datetime(),
});

const msgPayload = z.object({
  text: z.string().min(1),
  attachments: z.array(z.object({ url: z.string().url(), mime: z.string() })).optional(),
});

const ackPayload = z.object({ refId: z.string().min(1), status: z.enum(['received', 'delivered', 'read']) });

const typingPayload = z.object({ state: z.enum(['start', 'stop']) });

const presencePayload = z.object({ state: z.enum(['online', 'offline']) });

const approvalRequestPayload = z.object({
  refId: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  options: z.array(z.string().min(1)).min(1),
});

const approvalResponsePayload = z.object({
  refId: z.string().min(1),
  choice: z.string().min(1),
  editedText: z.string().optional(),
});

const historyRequestPayload = z.object({
  channel: z.string().min(1),
  before: z.string().optional(),
  limit: z.number().int().positive().max(200),
});

const historyPagePayload = z.object({
  channel: z.string().min(1),
  messages: z.array(historyMessage),
  nextBefore: z.string().optional(),
});

const pairRequestPayload = z.object({ token: z.string().min(1), device: z.string().min(1) });

const pairGrantPayload = z.object({
  sessionToken: z.string().min(1),
  userId: z.string().min(1),
  instance: z.string().min(1),
  channels: z.array(z.string()),
  vapidPublicKey: z.string().optional(),
});

const pushSubscribePayload = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
});

export type Kind = 'msg' | 'ack' | 'typing' | 'presence' | 'approval.request' | 'approval.response' | 'history.request' | 'history.page' | 'pair.request' | 'pair.grant' | 'push.subscribe';

const envelopeSchema = z.discriminatedUnion('kind', [
  base.extend({ kind: z.literal('msg'), payload: msgPayload }),
  base.extend({ kind: z.literal('ack'), payload: ackPayload }),
  base.extend({ kind: z.literal('typing'), payload: typingPayload }),
  base.extend({ kind: z.literal('presence'), payload: presencePayload }),
  base.extend({ kind: z.literal('approval.request'), payload: approvalRequestPayload }),
  base.extend({ kind: z.literal('approval.response'), payload: approvalResponsePayload }),
  base.extend({ kind: z.literal('history.request'), payload: historyRequestPayload }),
  base.extend({ kind: z.literal('history.page'), payload: historyPagePayload }),
  base.extend({ kind: z.literal('pair.request'), payload: pairRequestPayload }),
  base.extend({ kind: z.literal('pair.grant'), payload: pairGrantPayload }),
  base.extend({ kind: z.literal('push.subscribe'), payload: pushSubscribePayload }),
]);

export type AnyEnvelope = z.infer<typeof envelopeSchema>;
export type Envelope<K extends Kind> = Extract<AnyEnvelope, { kind: K }>;

export function createEnvelope<K extends Kind>(
  kind: K,
  fields: {
    from: Address;
    to: Address;
    channel: string;
    payload: Envelope<K>['payload'];
  },
): Envelope<K> {
  const env = {
    oam: OAM_VERSION,
    id: ulid(),
    kind,
    ts: new Date().toISOString(),
    ...fields,
  };
  return envelopeSchema.parse(env) as Envelope<K>;
}

export function parseEnvelope(data: unknown): AnyEnvelope {
  return envelopeSchema.parse(data);
}

export function tryParseEnvelope(data: unknown): AnyEnvelope | null {
  const res = envelopeSchema.safeParse(data);
  return res.success ? res.data : null;
}
