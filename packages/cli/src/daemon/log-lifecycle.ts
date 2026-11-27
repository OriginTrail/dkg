import { Logger } from '@origintrail-official/dkg-core';
import type { ActiveLogExporterMode } from '../telemetry-config.js';
import {
  createDaemonLogSink,
  type DaemonLogSinkDeps,
  type RemoteLogShipper,
} from './log-sink.js';

export const DEFAULT_FATAL_LOG_DRAIN_TIMEOUT_MS = 2_000;

/**
 * Fatal exceptions must not leave a broken daemon alive because its log file
 * is stuck. Detach all producers, give accepted writes one short best-effort
 * drain window, then invoke the exit callback regardless of the outcome.
 */
export async function exitAfterFatalLogDrain(opts: {
  detach: () => void;
  shutdown: () => Promise<void>;
  exit: (code: number) => void;
  timeoutMs?: number;
  reportTimeout?: (message: string) => void;
}): Promise<void> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    try {
      opts.detach();
    } catch {
      // A failed detach cannot be allowed to suppress fatal process exit.
    }

    const outcome = await Promise.race([
      Promise.resolve()
        .then(opts.shutdown)
        .then(() => 'drained' as const, () => 'failed' as const),
      new Promise<'timed-out'>((resolve) => {
        deadline = setTimeout(
          () => resolve('timed-out'),
          opts.timeoutMs ?? DEFAULT_FATAL_LOG_DRAIN_TIMEOUT_MS,
        );
      }),
    ]);
    if (outcome === 'timed-out') {
      try {
        opts.reportTimeout?.(
          'fatal log drain timed out; exiting with queued log writes abandoned',
        );
      } catch {
        // Timeout reporting bypasses the writer and remains best effort.
      }
    }
  } finally {
    if (deadline) clearTimeout(deadline);
    opts.exit(1);
  }
}

interface DaemonLogExporter {
  mode: ActiveLogExporterMode;
  shipper: RemoteLogShipper;
  shutdown: () => Promise<void>;
}

export type DaemonLogExporterStartResult =
  | { ok: true; started: boolean }
  | { ok: false; error: string };

export interface DaemonLogController {
  startExporter(
    mode: ActiveLogExporterMode,
    factory: () => Omit<DaemonLogExporter, 'mode'>,
  ): DaemonLogExporterStartResult;
  stopExporter(): Promise<ActiveLogExporterMode | null>;
  detachSink(): void;
}

/**
 * Own the daemon Logger sink and the active shipper it reads. TelemetryRuntime
 * is the sole caller that starts/stops the exporter; daemon shutdown calls
 * detachSink() synchronously, then lets that runtime perform the final flush.
 * Database maintenance lives in dashboard-log-volume-pruner.ts.
 */
export function startDaemonLogController(opts: {
  writeLocalDebug: DaemonLogSinkDeps['writeLocalDebug'];
  insertDiagnosticLog: DaemonLogSinkDeps['insertDiagnosticLog'];
  redact: DaemonLogSinkDeps['redact'];
}): DaemonLogController {
  let exporter: DaemonLogExporter | null = null;
  let exporterShutdown: Promise<ActiveLogExporterMode | null> | null = null;
  let sinkDetached = false;

  Logger.setSink(createDaemonLogSink({
    writeLocalDebug: opts.writeLocalDebug,
    insertDiagnosticLog: opts.insertDiagnosticLog,
    redact: opts.redact,
    remoteShipper: () => exporter?.shipper,
  }));

  const stopExporter = async (): Promise<ActiveLogExporterMode | null> => {
    if (exporterShutdown) return exporterShutdown;
    const current = exporter;
    if (!current) return null;
    // Detach before awaiting so no record can enter an exporter whose final
    // flush has started. Repeated calls observe the empty slot and are safe.
    exporter = null;
    let shutdownWork: Promise<void>;
    try {
      // Invoke synchronously so stop()/stopExporter() starts teardown before it
      // returns control, while still normalizing a synchronous throw.
      shutdownWork = current.shutdown();
    } catch (error) {
      shutdownWork = Promise.reject(error);
    }
    const shutdown = shutdownWork
      .then(() => current.mode)
      .finally(() => {
        if (exporterShutdown === shutdown) exporterShutdown = null;
      });
    exporterShutdown = shutdown;
    return shutdown;
  };

  return {
    startExporter(mode, factory) {
      if (sinkDetached) return { ok: false, error: 'Daemon log sink is detached' };
      if (exporterShutdown) {
        return {
          ok: false,
          error: `Cannot start ${mode} while the previous exporter is shutting down`,
        };
      }
      if (exporter?.mode === mode) return { ok: true, started: false };
      if (exporter) {
        return {
          ok: false,
          error: `Cannot start ${mode} while ${exporter.mode} is active`,
        };
      }
      try {
        exporter = { mode, ...factory() };
        return { ok: true, started: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    stopExporter,
    detachSink() {
      if (sinkDetached) return;
      sinkDetached = true;
      // Exporter teardown belongs to TelemetryRuntime. Detachment stays
      // synchronous so no later Logger call reaches SQLite or the shipper
      // while the runtime drains an in-flight settings transition.
      Logger.setSink(null);
    },
  };
}
