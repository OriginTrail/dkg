import { Logger } from '@origintrail-official/dkg-core';
import {
  createDaemonLogSink,
  type DaemonLogSinkDeps,
  type RemoteLogShipper,
} from './log-sink.js';

export type DaemonLogExporterMode = 'syslog' | 'otlp';

export interface DaemonLogExporter {
  mode: DaemonLogExporterMode;
  shipper: RemoteLogShipper;
  shutdown: () => Promise<void>;
}

export type DaemonLogExporterStartResult =
  | { ok: true; started: boolean }
  | { ok: false; error: string };

export interface DaemonLogController {
  startExporter(
    mode: DaemonLogExporterMode,
    factory: () => Omit<DaemonLogExporter, 'mode'>,
  ): DaemonLogExporterStartResult;
  stopExporter(): Promise<DaemonLogExporterMode | null>;
  detachSink(): void;
}

/**
 * Own the daemon Logger sink and the active shipper it reads. TelemetryRuntime
 * is the sole caller that starts/stops the exporter; daemon shutdown calls
 * detachSink() synchronously, then lets that runtime perform the final flush.
 * Database maintenance lives in dashboard-log-volume-pruner.ts.
 */
export function startDaemonLogController(opts: {
  insertDiagnosticLog: DaemonLogSinkDeps['insertDiagnosticLog'];
  redact: DaemonLogSinkDeps['redact'];
}): DaemonLogController {
  let exporter: DaemonLogExporter | null = null;
  let exporterShutdown: Promise<DaemonLogExporterMode | null> | null = null;
  let sinkDetached = false;

  Logger.setSink(createDaemonLogSink({
    insertDiagnosticLog: opts.insertDiagnosticLog,
    redact: opts.redact,
    remoteShipper: () => exporter?.shipper,
  }));

  const stopExporter = async (): Promise<DaemonLogExporterMode | null> => {
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
