import type {
  DashboardDB,
  LogVolumePruneResult,
} from '@origintrail-official/dkg-node-ui';

export interface DashboardLogVolumePrunerIntervals {
  initialDelayMs: number;
  catchupIntervalMs: number;
  reclaimRetryMs: number;
  steadyIntervalMs: number;
}

export const DEFAULT_DASHBOARD_LOG_VOLUME_PRUNER_INTERVALS: DashboardLogVolumePrunerIntervals = {
  initialDelayMs: 60_000,
  catchupIntervalMs: 15_000,
  reclaimRetryMs: 10 * 60_000,
  steadyIntervalMs: 6 * 60 * 60_000,
};

export interface DashboardLogVolumePrunerHandle {
  stop(): void;
}

/**
 * Own the incremental dashboard-log cleanup lifecycle outside the daemon
 * bootstrap. The database decides what one bounded maintenance step did; this
 * helper decides when the next step runs, aggregates deletion telemetry, and
 * guarantees shutdown clears the recursive timeout.
 */
export function startDashboardLogVolumePruner(opts: {
  dashDb: Pick<DashboardDB, 'pruneLogVolumeBatch'>;
  log: (message: string) => void;
  intervals?: Partial<DashboardLogVolumePrunerIntervals>;
}): DashboardLogVolumePrunerHandle {
  const intervals = {
    ...DEFAULT_DASHBOARD_LOG_VOLUME_PRUNER_INTERVALS,
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

  const nextDelayFor = (result: LogVolumePruneResult): number => {
    switch (result.status) {
      case 'more':
        return intervals.catchupIntervalMs;
      case 'reclaim-pending':
        return intervals.reclaimRetryMs;
      case 'done':
      case 'done-compacted':
        return intervals.steadyIntervalMs;
    }
  };

  const run = (): void => {
    timer = null;
    if (stopped) return;
    try {
      const result = opts.dashDb.pruneLogVolumeBatch();
      rowsDeleted += result.deleted;
      if (result.status === 'done' || result.status === 'done-compacted') {
        if (rowsDeleted > 0 || result.status === 'done-compacted') {
          opts.log(
            `Dashboard log-volume cleanup removed ${rowsDeleted} old routine row(s)` +
              (result.status === 'done-compacted' ? ' and compacted node-ui.db' : ''),
          );
        }
        rowsDeleted = 0;
      }
      schedule(nextDelayFor(result));
    } catch (error) {
      opts.log(
        `Dashboard log-volume cleanup deferred: ${error instanceof Error ? error.message : String(error)}`,
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
