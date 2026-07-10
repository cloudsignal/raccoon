export interface UpdateDeps {
  buildId: string;
  fetchVersion(): Promise<{ buildId?: string } | null>;
  updateRegistrations(): Promise<boolean>;
  purgeShellCache(): Promise<void>;
  reload(): void;
  isHeld(): boolean;
}

export type UpdateResult = 'current' | 'sw-updating' | 'reloaded' | 'held' | 'offline';

export async function runUpdateCheck(deps: UpdateDeps): Promise<UpdateResult> {
  if (deps.buildId === 'dev') return 'current';
  const remote = await deps.fetchVersion();
  if (!remote) return 'offline';
  if (!remote.buildId || remote.buildId === deps.buildId) return 'current';
  const swPending = await deps.updateRegistrations();
  if (swPending) return 'sw-updating';
  await deps.purgeShellCache();
  if (deps.isHeld()) return 'held';
  deps.reload();
  return 'reloaded';
}
