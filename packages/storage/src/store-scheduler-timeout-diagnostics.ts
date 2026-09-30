import type { StoreWorkPriority } from './triple-store.js';

export interface StoreSchedulerTimeoutDiagnostic {
  waiting: { priority: StoreWorkPriority; operation: string };
  /** Possible slot holders, never proof of which operation delayed the waiter. */
  activeAtTimeout: readonly {
    priority: StoreWorkPriority;
    operation: string;
    count: number;
    oldestAgeMs: number;
  }[];
}

/** Bound repeated timeout warnings while leaving scheduler outcomes independent of logging. */
export function createRateLimitedStoreTimeoutDiagnosticSink(options: {
  emit: (diagnostic: StoreSchedulerTimeoutDiagnostic) => void;
  now?: () => number;
  intervalMs?: number;
  maxKeys?: number;
}): (diagnostic: StoreSchedulerTimeoutDiagnostic) => void {
  const lastByWaiter = new Map<string, number>();
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 60_000;
  const maxKeys = options.maxKeys ?? 128;
  return (diagnostic) => {
    if (diagnostic.activeAtTimeout.length === 0) return;
    const key = `${diagnostic.waiting.priority}:${diagnostic.waiting.operation}`;
    const at = now();
    const last = lastByWaiter.get(key);
    if (last !== undefined && at - last < intervalMs) return;
    if (!lastByWaiter.has(key) && lastByWaiter.size >= maxKeys) {
      lastByWaiter.delete(lastByWaiter.keys().next().value!);
    }
    lastByWaiter.delete(key);
    lastByWaiter.set(key, at);
    options.emit(diagnostic);
  };
}
