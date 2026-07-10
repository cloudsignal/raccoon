import { describe, expect, it } from 'vitest';
import { issuePairing, renderPairingQr, revokePairing } from './pairing.js';
import { parsePairingPayload } from './payload.js';
import type { PairingHub } from './pairing.js';

function fakeHub(): PairingHub & { revoked: string[] } {
  return {
    revoked: [],
    issuePairingToken: (userId: string) => `token-for-${userId}`,
    revokeUser: async function (this: { revoked: string[] }, userId: string) { this.revoked.push(userId); },
  } as PairingHub & { revoked: string[] };
}

describe('pairing helpers', () => {
  it('issuePairing embeds the hub token in a parseable payload and renders a QR', async () => {
    const hub = fakeHub();
    const out = await issuePairing(hub, { userId: 'u1', instanceUrl: 'ws://host:8790/' });
    expect(out.token).toBe('token-for-u1');
    expect(parsePairingPayload(out.payload).token).toBe('token-for-u1');
    expect(out.qr.length).toBeGreaterThan(0);
  });

  it('renderPairingQr returns non-empty terminal art', async () => {
    const qr = await renderPairingQr('hello');
    expect(qr.length).toBeGreaterThan(0);
  });

  it('revokePairing delegates to the hub', async () => {
    const hub = fakeHub();
    await revokePairing(hub, 'u2');
    expect(hub.revoked).toEqual(['u2']);
  });
});
