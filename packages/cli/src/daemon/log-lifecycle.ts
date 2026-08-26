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

export interface DaemonLogController {
  activeExporterMode(): DaemonLogExporterMode | null;
  startExporter(
    mode: DaemonLogExporterMode,
    factory: () => Omit<DaemonLogExporter, 'mode'>,
  ): { ok: boolean; error?: string };
  stopExporter(): Promise<DaemonLogExporterMode | null>;
  stop(): Promise<void>;
}

/**
 * Own the complete daemon log-sink lifecycle: sink attachment, the single
 * active remote exporter, exporter shutdown, and sink detachment. Database
 * volume maintenance deliberately lives in dashboard-log-volume-pruner.ts.
 */
export function startDaemonLogController(opts: {
  insertDiagnosticLog: DaemonLogSinkDeps['insertDiagnosticLog'];
  redact: DaemonLogSinkDeps['redact'];
}): DaemonLogController {
  let exporter: DaemonLogExporter | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;

  Logger.setSink(createDaemonLogSink({
    insertDiagnosticLog: opts.insertDiagnosticLog,
    redact: opts.redact,
    remoteShipper: () => exporter?.shipper,
  }));

  const stopExporter = async (): Promise<DaemonLogExporterMode | null> => {
    const current = exporter;
    if (!current) return null;
    // Detach before awaiting so no record can enter an exporter whose final
    // flush has started. Repeated calls observe the empty slot and are safe.
    exporter = null;
    await current.shutdown();
    return current.mode;
  };

  return {
    activeExporterMode: () => exporter?.mode ?? null,
    startExporter(mode, factory) {
      if (stopped) return { ok: false, error: 'Daemon log controller is stopped' };
      if (exporter?.mode === mode) return { ok: true };
      if (exporter) {
        return {
          ok: false,
          error: `Cannot start ${mode} while ${exporter.mode} is active`,
        };
      }
      try {
        exporter = { mode, ...factory() };
        return { ok: true };
      } catch (error) {
        return {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
    stopExporter,
    stop() {
      if (stopPromise) return stopPromise;
      stopped = true;
      // This is synchronous with stop() invocation. A Logger call made while
      // exporter shutdown is pending must not reach SQLite or that exporter.
      Logger.setSink(null);
      stopPromise = stopExporter().then(() => undefined);
      return stopPromise;
    },
  };
}
