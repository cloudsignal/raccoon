import { appConfig } from '../config.js';
import { PairPanel } from './pair-panel.js';

export function SetupScreen() {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-surface px-6 pb-[max(env(safe-area-inset-bottom),24px)] pt-[max(env(safe-area-inset-top),24px)]">
      <img src={appConfig.icons.icon192} alt="" className="h-20 w-20 rounded-[22%]" />
      <div className="text-center">
        <h1 className="text-xl font-semibold text-ink">{appConfig.name}</h1>
        <p className="mt-1 text-sm text-ink-faint">Pair this device with your agent instance.</p>
      </div>
      <PairPanel />
    </div>
  );
}
