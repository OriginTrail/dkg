import type { StoreWorkPriority } from './triple-store.js';
import type { BackpressureSnapshot } from '@origintrail-official/dkg-core';

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

export interface StoreSchedulerTimeoutWaiter {
  priority: StoreWorkPriority;
  operation: string;
}

function metricOperation(operation: string): string {
  const trimmed = operation.trim();
  if (!trimmed) return 'unknown';
  return trimmed.replace(/[^\w:./-]/g, '_').slice(0, 80) || 'unknown';
}

/** Admit first, then collect and project only diagnostics that can be emitted. */
export function createRateLimitedStoreTimeoutDiagnosticReporter(options: {
  emit: (diagnostic: StoreSchedulerTimeoutDiagnostic) => void | Promise<void>;
  now?: () => number;
  intervalMs?: number;
  maxKeys?: number;
  maxEmitsPerWindow?: number;
}): (waiting: StoreSchedulerTimeoutWaiter, snapshot: () => BackpressureSnapshot) => void {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 60_000;
  const maxKeys = options.maxKeys ?? 128;
  // One outage can create many distinct operation labels. Bound the total
  // synchronous warning volume as well as the per-label frequency.
  const maxEmitsPerWindow = options.maxEmitsPerWindow ?? 16;
  const emittedAt = new Map<string, number>();
  let windowStart: number | undefined;
  let windowEmitted = 0;
  return (waiting, snapshot) => {
    try {
      const key = `${waiting.priority}:${waiting.operation}`;
      const timestamp = now();
      const lastEmittedAt = emittedAt.get(key);
      if (lastEmittedAt !== undefined && timestamp - lastEmittedAt < intervalMs) return;
      const newWindow = windowStart === undefined || timestamp < windowStart
        || timestamp - windowStart >= intervalMs;
      if (!newWindow && windowEmitted >= maxEmitsPerWindow) return;
      const activeAtTimeout = snapshot().lanes
        .flatMap((lane) => lane.activeOperations.map((active) => ({
          priority: lane.lane as StoreWorkPriority,
          operation: metricOperation(active.operation),
          count: active.count,
          oldestAgeMs: active.oldestAgeMs,
        })))
        .sort((a, b) => b.oldestAgeMs - a.oldestAgeMs)
        .slice(0, 3);
      if (activeAtTimeout.length === 0) return;
      // Commit admission only for a warning that has active work to report.
      // Empty snapshots must not suppress a later useful warning for this key.
      if (newWindow) {
        windowStart = timestamp;
        windowEmitted = 0;
      }
      windowEmitted += 1;
      emittedAt.delete(key);
      if (emittedAt.size >= maxKeys) emittedAt.delete(emittedAt.keys().next().value!);
      emittedAt.set(key, timestamp);
      const diagnostic: StoreSchedulerTimeoutDiagnostic = { waiting, activeAtTimeout };
      const delivery = options.emit(diagnostic);
      if (delivery) void delivery.catch(() => undefined);
    } catch {
      // Collection and delivery cannot alter the scheduler's timeout outcome.
    }
  };
}
