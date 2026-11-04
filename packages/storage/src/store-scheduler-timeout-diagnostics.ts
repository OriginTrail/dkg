import type { StoreWorkPriority } from './triple-store.js';
import type { AsyncAdmissionDiagnosticContext, BackpressureSnapshot } from '@origintrail-official/dkg-core';

/** The lane a store scheduler reports: a shared lane, or `control` for a queue's control-path instance. */
export type StoreSchedulerPriority = StoreWorkPriority | 'control';

export interface StoreSchedulerTimeoutDiagnostic {
  waiting: StoreSchedulerTimeoutWaiter;
  /** Possible slot holders, never proof of which operation delayed the waiter. */
  activeAtTimeout: readonly {
    priority: StoreSchedulerPriority;
    operation: string;
    count: number;
    oldestAgeMs: number;
  }[];
  /** Correlated slot holders, not proof they caused the wait or were using CPU. */
  activeAdmissions?: readonly StoreSchedulerActiveAdmission[];
}

export interface StoreSchedulerActiveAdmission extends AsyncAdmissionDiagnosticContext {
  readonly priority: StoreSchedulerPriority;
  readonly queueWaitMs: number;
  readonly activeAgeMs: number;
}

export interface StoreSchedulerTimeoutWaiter {
  priority: StoreSchedulerPriority;
  operation: string;
  admission?: AsyncAdmissionDiagnosticContext;
}

/** Project only bounded correlation metadata; never retain work closures in a diagnostic. */
export function activeStoreAdmissionsSnapshot(
  entries: Iterable<readonly [{ admission?: AsyncAdmissionDiagnosticContext; lane: StoreSchedulerPriority; queuedAt: number }, number]>,
  now: number,
): readonly StoreSchedulerActiveAdmission[] {
  return [...entries].flatMap(([entry, startedAt]) => entry.admission ? [{
    ...entry.admission,
    priority: entry.lane,
    queueWaitMs: Math.max(0, Math.round(startedAt - entry.queuedAt)),
    activeAgeMs: Math.max(0, Math.round(now - startedAt)),
  }] : []).sort((a, b) => b.activeAgeMs - a.activeAgeMs).slice(0, 3);
}

/** Admit first, then collect and project only diagnostics that can be emitted. */
export function createRateLimitedStoreTimeoutDiagnosticReporter(options: {
  emit: (diagnostic: StoreSchedulerTimeoutDiagnostic) => void | Promise<void>;
  now?: () => number;
  intervalMs?: number;
  maxKeys?: number;
  maxEmitsPerWindow?: number;
}): (
  waiting: StoreSchedulerTimeoutWaiter,
  snapshot: () => BackpressureSnapshot,
  activeAdmissions?: () => readonly StoreSchedulerActiveAdmission[],
) => void {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? 60_000;
  const maxKeys = options.maxKeys ?? 128;
  // One outage can create many distinct operation labels. Bound the total
  // synchronous warning volume as well as the per-label frequency.
  const maxEmitsPerWindow = options.maxEmitsPerWindow ?? 16;
  const emittedAt = new Map<string, number>();
  let windowStart: number | undefined;
  let windowEmitted = 0;
  return (waiting, snapshot, collectAdmissions) => {
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
          priority: lane.lane as StoreSchedulerPriority,
          operation: active.operation,
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
      const activeAdmissions = collectAdmissions?.().slice(0, 3);
      const diagnostic: StoreSchedulerTimeoutDiagnostic = {
        waiting, activeAtTimeout,
        ...(activeAdmissions?.length ? { activeAdmissions } : {}),
      };
      const delivery = options.emit(diagnostic);
      if (delivery) void delivery.catch(() => undefined);
    } catch {
      // Collection and delivery cannot alter the scheduler's timeout outcome.
    }
  };
}
