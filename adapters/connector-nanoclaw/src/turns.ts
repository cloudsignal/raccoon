interface OpenTurn {
  resolve: (text: string | null) => void;
  timer: NodeJS.Timeout;
}

export interface TurnStore {
  open(platformId: string, timeoutMs: number): Promise<string | null>;
  settle(platformId: string, text: string): boolean;
  cancelAll(): void;
}

/** Open turns keyed by platformId, one slot per conversation. The raccoon
 *  bridge does NOT serialize turns per user — the runner (runner.ts) holds a
 *  per-conversation mutex so at most one turn is open per platformId. The
 *  cancel-on-reopen below is therefore a defensive guard for a path that
 *  should be unreachable, not a concurrency strategy. */
export function createTurnStore(): TurnStore {
  const open = new Map<string, OpenTurn>();

  function close(platformId: string, text: string | null): boolean {
    const turn = open.get(platformId);
    if (!turn) return false;
    open.delete(platformId);
    clearTimeout(turn.timer);
    turn.resolve(text);
    return true;
  }

  return {
    open(platformId, timeoutMs) {
      close(platformId, null);
      return new Promise<string | null>((resolve) => {
        const timer = setTimeout(() => close(platformId, null), timeoutMs);
        open.set(platformId, { resolve, timer });
      });
    },
    settle: (platformId, text) => close(platformId, text),
    cancelAll() {
      for (const id of [...open.keys()]) close(id, null);
    },
  };
}
