import type { StoreWorkPriority } from './triple-store.js';
import { createBoundedKeyedLimiter } from '@origintrail-official/dkg-core';

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
  emit: (diagnostic: StoreSchedulerTimeoutDiagnostic) => void | Promise<void>;
  now?: () => number;
  intervalMs?: number;
  maxKeys?: number;
  maxEmitsPerWindow?: number;
}): (diagnostic: StoreSchedulerTimeoutDiagnostic) => void {
  const decide = createBoundedKeyedLimiter({
    now: options.now ?? Date.now,
    intervalMs: options.intervalMs ?? 60_000,
    cacheMax: options.maxKeys ?? 128,
    // One outage can create many distinct operation labels. Bound the total
    // synchronous warning volume as well as the per-label frequency.
    maxEmitsPerWindow: options.maxEmitsPerWindow ?? 16,
  });
  return (diagnostic) => {
    if (diagnostic.activeAtTimeout.length === 0) return;
    const key = `${diagnostic.waiting.priority}:${diagnostic.waiting.operation}`;
    if (decide(key) === undefined) return;
    try {
      const delivery = options.emit(diagnostic);
      if (delivery) void delivery.catch(() => undefined);
    } catch {
      // Telemetry delivery cannot alter the scheduler's timeout outcome.
    }
  };
}
