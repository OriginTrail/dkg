/**
 * The daemon log-sink fan-out — the trust boundary where a REDACTED log record
 * is forwarded to remote shippers (syslog / OTLP). The canonical local log is
 * already written to daemon.log; duplicating every routine record into SQLite
 * made high-volume sync/query logging block the event loop. Low-volume warning
 * and error records remain in SQLite for operation and dashboard diagnostics.
 */
import type { LogRecord } from '@origintrail-official/dkg-core';

/** Minimal shape of a remote log shipper (LogPushWorker / OtlpLogWorker). */
export interface RemoteLogShipper {
  push: (record: LogRecord) => void;
}

export interface DaemonLogSinkDeps {
  /** Persist a FULL (un-redacted) warning/error record to the local DB. */
  insertDiagnosticLog: (rec: {
    ts: number;
    level: string;
    operation_name?: string | null;
    operation_id?: string | null;
    module: string;
    message: string;
  }) => void;
  /** Redactor applied to the copy that leaves the node. */
  redact: (record: LogRecord) => LogRecord;
  /**
   * The CURRENT set of active remote shippers, evaluated per record so the sink
   * reflects runtime start/stop without re-wiring. `null`/`undefined` entries
   * (a disabled exporter) are skipped.
   */
  remoteShippers: () => Array<RemoteLogShipper | null | undefined>;
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Build the `Logger.setSink` callback. Forwards exactly ONE redacted copy to
 * each active remote shipper, and does no extra work when none are active.
 */
export function createDaemonLogSink(deps: DaemonLogSinkDeps): (entry: LogRecord) => void {
  const now = deps.now ?? Date.now;
  return (entry: LogRecord): void => {
    if (entry.level === 'warn' || entry.level === 'error') {
      try {
        deps.insertDiagnosticLog({
          ts: now(),
          level: entry.level,
          operation_name: entry.operationName,
          operation_id: entry.operationId,
          module: entry.module,
          message: entry.message,
        });
      } catch {
        /* Diagnostic persistence must never break logging or remote export. */
      }
    }
    const shippers = deps.remoteShippers().filter((s): s is RemoteLogShipper => !!s);
    if (shippers.length === 0) return;
    // Fan out a single redacted copy to every active remote shipper.
    const safe = deps.redact(entry);
    for (const shipper of shippers) shipper.push(safe);
  };
}
