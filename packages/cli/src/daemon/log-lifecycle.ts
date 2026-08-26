import { Logger } from '@origintrail-official/dkg-core';
import type { DashboardDB } from '@origintrail-official/dkg-node-ui';
import {
  startLegacyRoutineLogCleanup,
  type LegacyRoutineLogCleanupIntervals,
} from './legacy-routine-log-cleanup.js';
import {
  createDaemonLogSink,
  type DaemonLogSinkDeps,
} from './log-sink.js';

export interface DaemonLogLifecycleHandle {
  stop(): void;
}

/**
 * Wire the daemon's structured sink and finite legacy-row scheduler as one
 * lifecycle operation. Keeping the assembly here gives daemon-level coverage
 * to the exact connection that makes the upgrade migration run.
 */
export function startDaemonLogLifecycle(opts: {
  dashDb: Pick<DashboardDB, 'insertLog' | 'runLegacyRoutineLogCleanupBatch'>;
  log: (message: string) => void;
  redact: DaemonLogSinkDeps['redact'];
  remoteShipper: DaemonLogSinkDeps['remoteShipper'];
  cleanupIntervals?: Partial<LegacyRoutineLogCleanupIntervals>;
}): DaemonLogLifecycleHandle {
  Logger.setSink(createDaemonLogSink({
    insertDiagnosticLog: (record) => opts.dashDb.insertLog(record),
    redact: opts.redact,
    remoteShipper: opts.remoteShipper,
  }));
  const cleanup = startLegacyRoutineLogCleanup({
    dashDb: opts.dashDb,
    log: opts.log,
    intervals: opts.cleanupIntervals,
  });
  return { stop: () => cleanup.stop() };
}
