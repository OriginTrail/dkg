/**
 * The daemon log sink — the trust boundary where a REDACTED log record is
 * forwarded to the selected remote shipper (syslog or OTLP). The canonical local log is
 * already written to daemon.log; duplicating every routine record into SQLite
 * made high-volume sync/query logging block the event loop. Low-volume warning
 * and error records remain in SQLite for operation and dashboard diagnostics.
 */
import {
  isDiagnosticLogLevel,
  type CanonicalLogRecord,
  type DiagnosticLogLevel,
  type LogRecord,
} from '@origintrail-official/dkg-core';

/** Minimal shape of a remote log shipper (LogPushWorker / OtlpLogWorker). */
export interface RemoteLogShipper {
  push: (record: LogRecord) => void;
}

export interface DaemonLogSinkDeps {
  /** Persist a FULL (un-redacted) warning/error record to the local DB. */
  insertDiagnosticLog: (rec: {
    ts: number;
    level: DiagnosticLogLevel;
    operation_name?: string | null;
    operation_id?: string | null;
    module: string;
    message: string;
  }) => void;
  /** Redactor applied to the copy that leaves the node. */
  redact: (record: LogRecord) => LogRecord;
  /** The currently selected shipper, evaluated per record for runtime toggles. */
  remoteShipper: () => RemoteLogShipper | null | undefined;
  /** Clock, injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

/**
 * Build the `Logger.setSink` callback. Forwards one redacted copy to the
 * selected shipper and does no redaction work when export is disabled.
 */
export function createDaemonLogSink(deps: DaemonLogSinkDeps): (entry: CanonicalLogRecord) => void {
  const now = deps.now ?? Date.now;
  return (entry: CanonicalLogRecord): void => {
    if (isDiagnosticLogLevel(entry.level)) {
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
    const shipper = deps.remoteShipper();
    if (!shipper) return;
    shipper.push(deps.redact(entry));
  };
}
