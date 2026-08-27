/**
 * The daemon log sink — the trust boundary where a REDACTED log record is
 * forwarded to the selected remote shipper (syslog or OTLP). Info/warn/error
 * already reach daemon.log through the stdout/stderr tee; this sink queues the
 * otherwise-silent debug level to that file too. Duplicating routine records
 * into SQLite made high-volume sync/query logging block the event loop, so only
 * low-volume warning/error diagnostics remain in SQLite.
 */
import {
  type CanonicalLogRecord,
  type LogLevel,
  type LogRecord,
} from '@origintrail-official/dkg-core';
import {
  isDebugLogRecord,
  type DebugLogRecord,
} from './daemon-log-file-writer.js';

type PersistedDiagnosticLogLevel = Extract<LogLevel, 'warn' | 'error'>;

function shouldPersistDiagnostic(
  level: LogLevel,
): level is PersistedDiagnosticLogLevel {
  return level === 'warn' || level === 'error';
}

/** Minimal shape of a remote log shipper (LogPushWorker / OtlpLogWorker). */
export interface RemoteLogShipper {
  push: (record: LogRecord) => void;
}

export interface DaemonLogSinkDeps {
  /** Queue an unredacted debug record for the local file-backed daemon log. */
  writeLocalDebug: (record: DebugLogRecord) => void;
  /** Persist a FULL (un-redacted) warning/error record to the local DB. */
  insertDiagnosticLog: (rec: {
    ts: number;
    level: PersistedDiagnosticLogLevel;
    operation_name?: string | null;
    operation_id?: string | null;
    module: string;
    message: string;
  }) => void;
  /** Redactor applied to the copy that leaves the node. */
  redact: (record: CanonicalLogRecord) => CanonicalLogRecord;
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
    if (isDebugLogRecord(entry)) {
      try {
        deps.writeLocalDebug(entry);
      } catch {
        /* Local file logging must never break remote export. */
      }
    }
    if (shouldPersistDiagnostic(entry.level)) {
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
