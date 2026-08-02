import { useState } from 'react';
import type { ReactNode } from 'react';
import { channelMeta } from '../config.js';
import { useChat } from '../transport/context.js';
import type { PairSuccess } from '../transport/context.js';
import { QrScanner } from './qr-scanner.js';
import { Bar, Btn, Icon, PlatformMark, pushToast } from './ui/primitives.js';

/** The pairing flow (README decision 10): scan/paste → connecting → one of
 *  success / reconnected / expired / unsupported. Hosted by both the first-run
 *  SetupScreen and the pushed Add-platform screen. `onDone` fires from the
 *  success/reconnected CTA; `onCancel` (when provided) is the error screens'
 *  way out of the flow. The scan/paste surface stays the inline home for
 *  parse errors and the residual failure kinds (unreachable, host-managed). */
type Step = 'scan' | 'connecting' | 'done' | 'failed';

/** Centered single-state layout shared by the non-scan steps. */
function StateScreen(props: { children: ReactNode }) {
  return (
    <div className="flex w-full flex-1 flex-col items-center justify-center gap-1.5 pb-10 text-center">
      {props.children}
    </div>
  );
}

function StateTitle(props: { children: ReactNode }) {
  return <h2 className="mt-4 text-xl font-bold text-ink">{props.children}</h2>;
}

function StateBody(props: { children: ReactNode }) {
  return <p className="max-w-[300px] text-sm leading-relaxed text-ink-soft">{props.children}</p>;
}

export function PairPanel(props: { onDone?: () => void; onCancel?: () => void }) {
  const { pairWithPayload, authError, pairings } = useChat();
  const [step, setStep] = useState<Step>('scan');
  const [result, setResult] = useState<PairSuccess | null>(null);
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);

  const pair = async (payload: string): Promise<void> => {
    setError(null);
    setStep('connecting');
    try {
      // PairSuccess (object) is truthy on success; false = resolved-but-failed.
      const paired = await pairWithPayload(payload.trim());
      if (paired) {
        setResult(paired);
        setStep('done');
        return;
      }
      // Resolved-but-failed: the provider surfaced the reason via authError.
      // Render-time branching (not here) reads the fresh context value —
      // rejected and unsupported get dedicated screens, the rest fall back to
      // the scan screen with the message inline.
      setStep('failed');
    } catch {
      // Malformed payload — recoverable in place on the scan screen.
      setError('Could not read that pairing code. Ask your agent host for a fresh QR.');
      setStep('scan');
    }
  };

  const backToScan = (): void => { setStep('scan'); setError(null); setValue(''); };

  if (step === 'connecting') {
    return (
      <StateScreen>
        <span aria-hidden className="h-9 w-9 animate-spin rounded-full border-[3px] border-line border-t-primary" />
        <StateTitle>Connecting…</StateTitle>
        <StateBody>Waiting for the platform to accept this device.</StateBody>
      </StateScreen>
    );
  }

  if (step === 'done' && result) {
    // The provider commits the pairing before pairWithPayload resolves, so the
    // stored entry (accent, channels, kept display name) is available here.
    const paired = pairings.find((p) => p.pairingId === result.pairingId);
    if (result.kind === 'refreshed') {
      const name = paired?.displayName ?? 'platform';
      return (
        <StateScreen>
          {paired ? <PlatformMark instance={paired.instance} color={paired.color} icon={paired.icon} size={64} /> : null}
          <StateTitle>Reconnected {name}</StateTitle>
          <StateBody>Already paired on this phone — refreshed instead of duplicated. Name, color and history kept.</StateBody>
          <span className="mt-4 flex min-w-[180px] flex-col">
            <Btn onClick={() => { pushToast(`Reconnected ${name}`); props.onDone?.(); }}>Done</Btn>
          </span>
        </StateScreen>
      );
    }
    const names = (paired?.channels ?? []).map((c) => channelMeta(c).label);
    return (
      <StateScreen>
        {paired ? <PlatformMark instance={paired.instance} color={paired.color} icon={paired.icon} size={64} /> : null}
        <StateTitle>{paired ? `Connected · ${paired.displayName}` : 'Connected'}</StateTitle>
        <StateBody>
          {names.length > 0
            ? `${names.length} agent${names.length === 1 ? '' : 's'} granted — ${names.join(', ')}. `
            : ''}
          Accent color auto-assigned; change it anytime in Platforms.
        </StateBody>
        <span className="mt-4 flex min-w-[180px] flex-col">
          <Btn onClick={props.onDone}>Open chats</Btn>
        </span>
      </StateScreen>
    );
  }

  if (step === 'failed' && authError?.kind === 'rejected') {
    return (
      <StateScreen>
        <span aria-hidden className="text-danger"><Icon name="alert" size={40} strokeWidth={1.6} /></span>
        <StateTitle>Pairing code expired</StateTitle>
        <StateBody>The platform rejected this code. Generate a fresh one on its screen and scan again.</StateBody>
        <span className="mt-4 flex min-w-[180px] flex-col gap-2">
          <Btn onClick={backToScan}>Try again</Btn>
          {props.onCancel ? <Btn kind="quiet" onClick={props.onCancel}>Cancel</Btn> : null}
        </span>
      </StateScreen>
    );
  }

  if (step === 'failed' && authError?.kind === 'unsupported') {
    return (
      <StateScreen>
        <span aria-hidden className="text-danger"><Icon name="alert" size={40} strokeWidth={1.6} /></span>
        <StateTitle>Platform type not supported</StateTitle>
        <StateBody>
          This platform pairs over a connection type this app doesn’t support yet.
          Pair it from a device that does — it will still show up here as read-only.
        </StateBody>
        <span className="mt-4 flex min-w-[180px] flex-col gap-2">
          <Btn onClick={backToScan}>Scan a different code</Btn>
          {props.onCancel ? <Btn kind="quiet" onClick={props.onCancel}>Cancel</Btn> : null}
        </span>
      </StateScreen>
    );
  }

  // Scan/paste surface — also the fallback for residual failure kinds.
  return (
    <div className="flex w-full max-w-xs flex-col gap-4">
      {step === 'failed' && authError ? (
        <p className="text-center text-sm text-ink-soft">{authError.message}</p>
      ) : null}
      <QrScanner onResult={(text) => void pair(text)} />
      {error ? (
        <p className="flex items-start gap-2 text-[13px] leading-snug text-danger">
          <span aria-hidden className="mt-px shrink-0"><Icon name="alert" size={15} /></span>
          <span>{error}</span>
        </p>
      ) : null}
      <div className="flex items-center gap-3 text-xs text-ink-faint">
        <span aria-hidden className="h-px flex-1 bg-line" />
        or paste a code
        <span aria-hidden className="h-px flex-1 bg-line" />
      </div>
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void pair(value); }}>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Paste the pairing code"
          className="h-12 w-full min-w-0 flex-1 rounded-[12px] border border-line bg-surface px-3.5 font-mono text-sm text-ink outline-none focus:border-primary"
        />
        <button
          type="submit"
          disabled={value.trim() === ''}
          className="h-12 shrink-0 rounded-[12px] bg-primary px-[18px] text-[15px] font-medium text-white outline-none focus-visible:outline-2 focus-visible:outline-ink disabled:opacity-45"
        >
          Connect
        </button>
      </form>
      <p className="text-xs leading-normal text-ink-faint">
        Re-scanning a platform you already have just refreshes it — name, color and history are kept.
      </p>
    </div>
  );
}

/** The pushed Add-platform screen (README Screens: Add platform) — a Bar over
 *  the pairing flow. ChatScreen pushes it on the nav stack (chat-list "+" and
 *  the Platforms screen's add entries); SetupScreen hosts it for first-run. */
export function AddPlatformScreen(props: { onBack: () => void; onDone?: () => void }) {
  return (
    <section className="flex h-full flex-col bg-surface">
      <Bar big onBack={props.onBack} title="Add platform" />
      <div className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-[max(env(safe-area-inset-bottom),24px)] pt-5">
        <PairPanel onDone={props.onDone} onCancel={props.onBack} />
      </div>
    </section>
  );
}
