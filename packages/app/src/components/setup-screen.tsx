import { useState } from 'react';
import { useChat } from '../transport/context.js';
import { AddPlatformScreen } from './pair-panel.js';
import { Btn, Icon } from './ui/primitives.js';

/** First-run screen (README Screens: First-run): QR glyph, pairing pitch,
 *  teal CTA into the same Add-platform flow the ChatScreen pushes. Once the
 *  first pairing lands, the provider flips phase to 'ready' and App swaps to
 *  the chat screen. */
export function SetupScreen() {
  const { authError } = useChat();
  const [pairing, setPairing] = useState(false);
  if (pairing) {
    return <AddPlatformScreen onBack={() => setPairing(false)} onDone={() => setPairing(false)} />;
  }
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2.5 bg-surface px-8 pb-[max(env(safe-area-inset-bottom),24px)] pt-[max(env(safe-area-inset-top),24px)] text-center">
      <span aria-hidden className="flex h-[76px] w-[76px] items-center justify-center rounded-full bg-surface-dim text-primary">
        <Icon name="qr" size={34} strokeWidth={1.7} />
      </span>
      <h1 className="mt-2 text-[22px] font-bold text-ink">Pair your first platform</h1>
      <p className="max-w-[280px] text-sm leading-relaxed text-ink-soft">
        Scan the QR code your platform shows to link this phone. Chats stay on this device.
      </p>
      {authError ? (
        // Terminal pairing/auth notice (e.g. the ONLY platform was revoked by
        // its server, or unpaired in another tab). ChatScreen's toast host
        // unmounts with it when phase drops to 'setup' — this static banner is
        // what tells the user why they are back on first-run.
        <p role="status" className="mt-1 max-w-[280px] rounded-[10px] bg-surface-dim px-4 py-2.5 text-sm leading-relaxed text-ink-soft">
          {authError.message}
        </p>
      ) : null}
      <span className="mt-4 flex min-w-[200px] flex-col">
        <Btn onClick={() => setPairing(true)}>Scan QR code</Btn>
      </span>
    </div>
  );
}
