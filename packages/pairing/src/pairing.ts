import QRCode from 'qrcode';
import { buildPairingPayload } from './payload.js';

export interface PairingHub {
  issuePairingToken(userId: string): string;
  revokeUser(userId: string): Promise<void>;
}

export async function renderPairingQr(payload: string): Promise<string> {
  // `small: true` uses half-height blocks so the code fits a terminal.
  return QRCode.toString(payload, { type: 'terminal', small: true });
}

export async function issuePairing(
  hub: PairingHub,
  opts: { userId: string; instanceUrl: string },
): Promise<{ token: string; payload: string; qr: string }> {
  const token = hub.issuePairingToken(opts.userId);
  const payload = buildPairingPayload({ instanceUrl: opts.instanceUrl, token });
  const qr = await renderPairingQr(payload);
  return { token, payload, qr };
}

export async function revokePairing(hub: PairingHub, userId: string): Promise<void> {
  await hub.revokeUser(userId);
}
