/**
 * The daemon log-sink fan-out — the trust boundary where a log record is
 * written FULL-FIDELITY to the local dashboard DB but only a REDACTED copy is
 * forwarded to remote shippers (syslog / OTLP). Extracted from `lifecycle.ts`
 * so this privacy-critical path is unit-testable (review: "remote log redaction
 * wiring is not verified"): a regression that pushed the raw `entry` to a remote
 * shipper, or skipped redaction, would leak secrets off-node.
 */
import type { LogRecord } from '@origintrail-official/dkg-core';

/** Minimal shape of a remote log shipper (LogPushWorker / OtlpLogWorker). */
export interface RemoteLogShipper {
  push: (record: LogRecord) => void;
}

export interface DaemonLogSinkDeps {
  /** Persist the FULL (un-redacted) record to the local dashboard DB. */
  insertLog: (rec: {
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
 * Build the `Logger.setSink` callback. Always stores the original locally
 * (errors swallowed — a DB write must never break the node); forwards exactly
 * ONE redacted copy to each active remote shipper, and nothing remote when none
 * are active.
 */
export function createDaemonLogSink(deps: DaemonLogSinkDeps): (entry: LogRecord) => void {
  const now = deps.now ?? Date.now;
  return (entry: LogRecord): void => {
    try {
      deps.insertLog({
        ts: now(),
        level: entry.level,
        operation_name: entry.operationName,
        operation_id: entry.operationId,
        module: entry.module,
        message: entry.message,
      });
    } catch {
      /* DB write must never break the node */
    }
    const shippers = deps.remoteShippers().filter((s): s is RemoteLogShipper => !!s);
    if (shippers.length === 0) return;
    // Fan out a single redacted copy to every active remote shipper.
    const safe = deps.redact(entry);
    for (const shipper of shippers) shipper.push(safe);
  };
}
