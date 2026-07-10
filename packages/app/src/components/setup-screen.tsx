import { useState } from 'react';
import { appConfig } from '../config.js';
import { useChat } from '../transport/context.js';
import { QrScanner } from './qr-scanner.js';

export function SetupScreen() {
  const { pairWithPayload, authError } = useChat();
  const [mode, setMode] = useState<'scan' | 'paste'>('scan');
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pair = async (payload: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await pairWithPayload(payload.trim());
    } catch {
      setError('Could not read that pairing code. Ask your agent host for a fresh QR.');
      setBusy(false);
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-surface px-6 pb-[max(env(safe-area-inset-bottom),24px)] pt-[max(env(safe-area-inset-top),24px)]">
      <img src={appConfig.icons.icon192} alt="" className="h-20 w-20 rounded-[22%]" />
      <div className="text-center">
        <h1 className="text-xl font-semibold text-ink">{appConfig.name}</h1>
        <p className="mt-1 text-sm text-ink-faint">Pair this device with your agent instance.</p>
      </div>
      {authError ? <p className="max-w-xs text-center text-sm text-ink-soft">{authError}</p> : null}
      <div className="w-full max-w-xs">
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
        {error ? <p className="mt-3 text-sm text-ink-soft">{error}</p> : null}
      </div>
    </div>
  );
}
