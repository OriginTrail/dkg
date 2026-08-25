import type {
  DashboardDB,
  LegacyRoutineLogCleanupResult,
} from '@origintrail-official/dkg-node-ui';

export interface LegacyRoutineLogCleanupIntervals {
  initialDelayMs: number;
  catchupIntervalMs: number;
  reclaimRetryMs: number;
}

export const DEFAULT_LEGACY_ROUTINE_LOG_CLEANUP_INTERVALS: LegacyRoutineLogCleanupIntervals = {
  initialDelayMs: 60_000,
  catchupIntervalMs: 15_000,
  reclaimRetryMs: 10 * 60_000,
};

export interface LegacyRoutineLogCleanupHandle {
  stop(): void;
}

/**
 * Own the incremental dashboard-log cleanup lifecycle outside the daemon
 * bootstrap. The database decides what one bounded maintenance step did; this
 * helper decides when the next step runs, aggregates deletion telemetry, and
 * guarantees shutdown clears the recursive timeout.
 */
export function startLegacyRoutineLogCleanup(opts: {
  dashDb: Pick<DashboardDB, 'runLegacyRoutineLogCleanupBatch'>;
  log: (message: string) => void;
  intervals?: Partial<LegacyRoutineLogCleanupIntervals>;
}): LegacyRoutineLogCleanupHandle {
  const intervals = {
    ...DEFAULT_LEGACY_ROUTINE_LOG_CLEANUP_INTERVALS,
    ...opts.intervals,
  };
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let rowsDeleted = 0;

  const schedule = (delayMs: number): void => {
    if (stopped) return;
    timer = setTimeout(run, delayMs);
    timer.unref?.();
  };

  const nextDelayFor = (result: LegacyRoutineLogCleanupResult): number | null => {
    switch (result.status) {
      case 'more':
        return intervals.catchupIntervalMs;
      case 'reclaim-pending':
        return intervals.reclaimRetryMs;
      case 'done':
      case 'done-compacted':
        return null;
    }
  };

  const run = (): void => {
    timer = null;
    if (stopped) return;
    try {
      const result = opts.dashDb.runLegacyRoutineLogCleanupBatch();
      rowsDeleted += result.deleted;
      if (result.status === 'done' || result.status === 'done-compacted') {
        if (rowsDeleted > 0 || result.status === 'done-compacted') {
          opts.log(
            `Legacy routine-log migration removed ${rowsDeleted} old row(s)` +
              (result.status === 'done-compacted' ? ' and compacted node-ui.db' : ''),
          );
        }
        rowsDeleted = 0;
      }
      const nextDelay = nextDelayFor(result);
      if (nextDelay !== null) schedule(nextDelay);
    } catch (error) {
      opts.log(
        `Legacy routine-log migration deferred: ${error instanceof Error ? error.message : String(error)}`,
      );
      schedule(intervals.reclaimRetryMs);
    }
  };

  schedule(intervals.initialDelayMs);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
