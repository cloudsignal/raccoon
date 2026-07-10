import { z } from 'zod';

const pairingPayloadSchema = z.object({
  v: z.literal(1),
  instanceUrl: z.string().min(1),
  transport: z.literal('ws'),
  token: z.string().min(1),
});

export type PairingPayload = z.infer<typeof pairingPayloadSchema>;

export function buildPairingPayload(opts: {
  instanceUrl: string;
  token: string;
  transport?: 'ws';
}): string {
  const payload: PairingPayload = {
    v: 1,
    instanceUrl: opts.instanceUrl,
    transport: opts.transport ?? 'ws',
    token: opts.token,
  };
  return JSON.stringify(pairingPayloadSchema.parse(payload));
}

export function parsePairingPayload(json: string): PairingPayload {
  return pairingPayloadSchema.parse(JSON.parse(json));
}
