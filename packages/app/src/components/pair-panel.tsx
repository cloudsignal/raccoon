import { useState } from 'react';
import { useChat } from '../transport/context.js';
import { QrScanner } from './qr-scanner.js';

/** The scan/paste pairing flow, extracted from SetupScreen so the Settings
 *  "Add platform" flow can reuse it. Calls `onDone` after a successful
 *  pairing (SetupScreen ignores it — the provider flips phase to 'ready'
 *  and App swaps screens). */
export function PairPanel(props: { onDone?: () => void }) {
  const { pairWithPayload, authError } = useChat();
  const [mode, setMode] = useState<'scan' | 'paste'>('scan');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pair = async (payload: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const paired = await pairWithPayload(payload.trim());
      if (paired) {
        props.onDone?.();
        return;
      }
      // Resolved-but-failed (rejected token, no factory, host-managed): the
      // provider surfaced the reason via authError, rendered above. Keep the
      // panel open and re-enable the form for another attempt.
      setBusy(false);
    } catch {
      setError('Could not read that pairing code. Ask your agent host for a fresh QR.');
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full max-w-xs flex-col gap-3">
      {authError ? <p className="text-center text-sm text-ink-soft">{authError}</p> : null}
      {mode === 'scan' ? (
        <div className="flex flex-col gap-3">
          <QrScanner onResult={(text) => void pair(text)} />
          <button
            type="button"
            onClick={() => setMode('paste')}
            className="h-11 rounded-[10px] text-sm font-medium text-primary"
          >
            Enter code manually
          </button>
        </div>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => { e.preventDefault(); void pair(value); }}
        >
          <textarea
            value={value}
            onChange={(e) => setValue(e.target.value)}
            rows={4}
            placeholder="Paste the pairing code"
            className="w-full rounded-[10px] border border-line bg-surface p-3 text-base text-ink outline-none focus:border-primary"
          />
          <button
            type="submit"
            disabled={busy || value.trim() === ''}
            className="h-11 rounded-[10px] bg-primary text-sm font-medium text-white disabled:opacity-50"
          >
            Pair
          </button>
          <button type="button" onClick={() => setMode('scan')} className="h-11 rounded-[10px] text-sm font-medium text-primary">
            Scan a QR instead
          </button>
        </form>
      )}
      {error ? <p className="text-sm text-ink-soft">{error}</p> : null}
    </div>
  );
}
