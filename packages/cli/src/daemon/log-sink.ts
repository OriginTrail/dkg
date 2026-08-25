/**
 * The daemon log-sink fan-out — the trust boundary where a REDACTED log record
 * is forwarded to remote shippers (syslog / OTLP). The canonical local log is
 * already written to daemon.log; duplicating every record into SQLite made
 * high-volume sync/query logging block the event loop without serving the
 * dashboard, whose log viewer is file-backed via /api/node-log.
 */
import type { LogRecord } from '@origintrail-official/dkg-core';

/** Minimal shape of a remote log shipper (LogPushWorker / OtlpLogWorker). */
export interface RemoteLogShipper {
  push: (record: LogRecord) => void;
}

export interface DaemonLogSinkDeps {
  /** Redactor applied to the copy that leaves the node. */
  redact: (record: LogRecord) => LogRecord;
  /**
   * The CURRENT set of active remote shippers, evaluated per record so the sink
   * reflects runtime start/stop without re-wiring. `null`/`undefined` entries
   * (a disabled exporter) are skipped.
   */
  remoteShippers: () => Array<RemoteLogShipper | null | undefined>;
}

/**
 * Build the `Logger.setSink` callback. Forwards exactly ONE redacted copy to
 * each active remote shipper, and does no extra work when none are active.
 */
export function createDaemonLogSink(deps: DaemonLogSinkDeps): (entry: LogRecord) => void {
  return (entry: LogRecord): void => {
    const shippers = deps.remoteShippers().filter((s): s is RemoteLogShipper => !!s);
    if (shippers.length === 0) return;
    // Fan out a single redacted copy to every active remote shipper.
    const safe = deps.redact(entry);
    for (const shipper of shippers) shipper.push(safe);
  };
}
