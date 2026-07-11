import { z } from 'zod';

// #A1 (vendor-neutral): `transport` is a NON-BINDING descriptor of the realtime
// transport a host runs, not a WS-only literal. A CloudSignal/MQTT-backed host
// (e.g. GTM) advertises transport:'cloudsignal' instead of lying with 'ws';
// omitting it is also valid (the client resolves the transport from its own
// wiring). Kept backward-compatible: legacy {transport:'ws'} payloads still
// parse, and 'ws' remains the build default. A future protocol rev folds this
// into a richer capability descriptor (see the v0.2 staging notes).
const pairingPayloadSchema = z.object({
  v: z.literal(1),
  instanceUrl: z.string().min(1),
  transport: z.string().min(1).optional(),
  token: z.string().min(1),
});

export type PairingPayload = z.infer<typeof pairingPayloadSchema>;

export function buildPairingPayload(opts: {
  instanceUrl: string;
  token: string;
  transport?: string;
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
