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
  stop(): Promise<void>;
}

/**
 * Serialize runtime telemetry toggles as complete state transitions. The
 * configured master gate is raised before exporters start and lowered only
 * after every exporter has stopped, so an active exporter can never coexist
 * with `enabled: false` even when enable/disable requests overlap.
 */
export function createSerializedTelemetrySettings(opts: {
  setConfiguredEnabled(enabled: boolean): void;
  persist(): Promise<void>;
  start(): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<void>;
}): {
  setEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
} {
  let transitionTail: Promise<void> = Promise.resolve();

  const apply = async (enabled: boolean): Promise<{ ok: boolean; error?: string }> => {
    if (!enabled) {
      await opts.stop();
      opts.setConfiguredEnabled(false);
      await opts.persist();
      return { ok: true };
    }

    // Raise the in-memory gate synchronously before any signal can start.
    opts.setConfiguredEnabled(true);
    let result: { ok: boolean; error?: string };
    try {
      result = await opts.start();
    } catch (error) {
      await opts.stop().catch(() => undefined);
      opts.setConfiguredEnabled(false);
      throw error;
    }
    if (!result.ok) {
      await opts.stop();
      opts.setConfiguredEnabled(false);
      return result;
    }
    try {
      await opts.persist();
    } catch (error) {
      // A failed save must not leave off-node export running while the durable
      // configuration still says disabled.
      await opts.stop();
      opts.setConfiguredEnabled(false);
      await opts.persist().catch(() => undefined);
      throw error;
    }
    return { ok: true };
  };

  return {
    setEnabled(enabled) {
      const transition = transitionTail.then(
        () => apply(enabled),
        () => apply(enabled),
      );
      transitionTail = transition.then(() => undefined, () => undefined);
      return transition;
    },
  };
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
  let exporterShutdown: Promise<DaemonLogExporterMode | null> | null = null;
  let stopped = false;
  let stopPromise: Promise<void> | null = null;

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
      if (stopped) return { ok: false, error: 'Daemon log controller is stopped' };
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
