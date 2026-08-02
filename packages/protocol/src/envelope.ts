import { ulid } from 'ulid';
import { z } from 'zod';

export const PROTOCOL_VERSION = '0.1' as const;

const address = z.union([
  z.templateLiteral(['user:', z.string().min(1)]),
  z.templateLiteral(['agent:', z.string().min(1)]),
  z.literal('system'),
]);
export type Address = z.infer<typeof address>;

// Hub-issued media path: 26-char ulid-alphabet id + sanitized display name.
// Attachment URLs are RELATIVE, hub-issued paths ONLY — never absolute URLs.
// This is the SSRF boundary: nothing user-controlled can point server-side
// fetchers (which absolutize against their OWN configured origin) anywhere
// but the deployment's media store. The filename segment is decorative; the
// server locates content by id alone.
export const MEDIA_PATH_RE = /^\/media\/[0-9A-HJKMNP-TV-Z]{26}\/[A-Za-z0-9._-]{1,80}$/;

export const attachmentSchema = z.object({
  url: z.string().regex(MEDIA_PATH_RE),
  /** Display/routing HINT — the serve endpoint's stored metadata is the
   *  authority for what bytes get labeled what. */
  mime: z.string().min(1),
  name: z.string().min(1).max(80).optional(),
  size: z.number().int().positive().optional(),
});
export type Attachment = z.infer<typeof attachmentSchema>;

const historyMessage = z.object({
  id: z.string().min(1),
  role: z.enum(['user', 'agent']),
  text: z.string(),
  ts: z.iso.datetime(),
  attachments: z.array(attachmentSchema).max(4).optional(),
});
export type HistoryMessage = z.infer<typeof historyMessage>;

const base = z.object({
  raccoon: z.literal(PROTOCOL_VERSION),
  id: z.string().min(1),
  from: address,
  to: address,
  channel: z.string().min(1),
  ts: z.iso.datetime(),
});

const msgPayload = z
  .object({
    // Empty text is legal ONLY alongside attachments (image-only sends);
    // enforced by the refine below. NOT wire-compatible with peers built
    // before this change — rollout is server-first (see docs/quickstart).
    text: z.string(),
    attachments: z.array(attachmentSchema).max(4).optional(),
  })
  .refine((p) => p.text.length > 0 || (p.attachments?.length ?? 0) > 0, {
    message: 'msg requires text or at least one attachment',
  });

// 'failed' (#R6-2): the server received the envelope but the turn it drives
// failed terminally on the server side — the client should surface a retry
// affordance instead of showing success. Sent AFTER a 'received' ack.
// 'stalled' (#P1-A): the server received the envelope and started the turn,
// but the turn exceeded the server-side deadline and is STILL RUNNING,
// detached and non-cancellable. Its outcome is UNKNOWN — it may yet complete
// its side effects. The client MUST NOT auto-offer a retry (a retry would
// double side effects for approvals/tool calls); it surfaces "still working —
// check history" and lets any late reply arrive via history. Terminal for the
// client's send state, but distinct from 'failed' (which is safe to retry).
const ackPayload = z.object({ refId: z.string().min(1), status: z.enum(['received', 'delivered', 'read', 'failed', 'stalled']) });

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

// #P1-C: the client's affirmative acknowledgement that it received (and
// adopted) a pair.grant. Until the hub receives this, the granted session is
// PROVISIONAL and non-resumable — so a client whose socket closed while the
// grant was in flight (its close frame not yet seen by the server) never
// confirms, and its provisional session is reaped by TTL instead of becoming
// a live orphan that also burned a one-time pairing token.
const pairConfirmPayload = z.object({ sessionToken: z.string().min(1) });

// #R10: the hub's ACK that a pair.confirm actually PROMOTED an unexpired
// provisional session to durable. The client defers reporting "paired" (and
// persisting the session) until it receives this — so a transient
// confirm/store failure surfaces as an honest pairing failure instead of a
// "paired successfully" state backed by a session that will never resume.
const pairConfirmedPayload = z.object({ sessionToken: z.string().min(1) });

const pairGrantPayload = z.object({
  sessionToken: z.string().min(1),
  userId: z.string().min(1),
  instance: z.string().min(1),
  channels: z.array(z.string()),
  vapidPublicKey: z.string().optional(),
  // Opaque transport dial config for hosted platforms. The protocol does not
  // interpret it — the pairing transport hands it to the client's transport
  // layer as-is (JSON-safe blob only, which the wire format already implies).
  transportConfig: z.unknown().optional(),
});

const pushSubscribePayload = z.object({
  subscription: z.object({
    endpoint: z.string().url(),
    keys: z.object({ p256dh: z.string().min(1), auth: z.string().min(1) }),
  }),
});

const pushUnsubscribePayload = z.object({ endpoint: z.string().url() });

export type Kind = 'msg' | 'ack' | 'typing' | 'presence' | 'approval.request' | 'approval.response' | 'history.request' | 'history.page' | 'pair.request' | 'pair.grant' | 'pair.confirm' | 'pair.confirmed' | 'push.subscribe' | 'push.unsubscribe';

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
  base.extend({ kind: z.literal('pair.confirm'), payload: pairConfirmPayload }),
  base.extend({ kind: z.literal('pair.confirmed'), payload: pairConfirmedPayload }),
  base.extend({ kind: z.literal('push.subscribe'), payload: pushSubscribePayload }),
  base.extend({ kind: z.literal('push.unsubscribe'), payload: pushUnsubscribePayload }),
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
    raccoon: PROTOCOL_VERSION,
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
