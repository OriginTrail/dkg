/** Compatibility boundary for the pinned Node diagnostic-report API. */
export interface DiagnosticReporter {
  excludeNetwork: boolean;
  getReport(): { userLimits?: { open_files?: { soft?: number | string; hard?: number | string } } } | undefined;
}

/** Read resource limits without synchronous reverse DNS; always restore global state. */
export function readSoftOpenFileLimit(
  reporter: DiagnosticReporter = process.report as unknown as DiagnosticReporter,
): number | undefined {
  const previous = reporter.excludeNetwork;
  try {
    reporter.excludeNetwork = true;
    const soft = reporter.getReport()?.userLimits?.open_files?.soft;
    return typeof soft === 'number' ? soft : undefined;
  } finally {
    reporter.excludeNetwork = previous;
  }
}

/**
 * Severity of a `checkFdLimit` log emission. The "ok" path is
 * deliberately `info` — emitting it via `console.warn` would make the
 * level unreliable for operator alerting (every healthy startup would
 * trip warning-level filters). Only the under-provisioned and
 * unreadable-limit paths are `warn`.
 */
export type FdLimitLogLevel = 'info' | 'warn';

/**
 * Emit an informational/warning log at relay startup about the host's
 * `ulimit -n` (RLIMIT_NOFILE) versus what the configured maxConnections
 * actually needs. We can read this losslessly from
 * `process.report.getReport().userLimits.open_files` on POSIX (libp2p
 * Core Nodes are POSIX-only in practice).
 *
 * Why this matters: libp2p's maxConnections is an upper bound libp2p
 * tracks internally; if the kernel rejects the underlying socket() with
 * EMFILE before libp2p hits its own cap, the only signal is opaque
 * "peer rejected" errors in logs. Surfacing the discrepancy at startup
 * gives operators a loud, actionable signal.
 *
 * The callback receives `(level, msg)` so consumers can route each
 * emission to the appropriate logger sink (info vs warn). Mapping the
 * "ok" line to `info` keeps the warn channel meaningful for alerting.
 */
export function checkFdLimit(
  maxConnections: number,
  log: (level: FdLimitLogLevel, msg: string) => void,
  readLimit: () => number | undefined = readSoftOpenFileLimit,
): void {
  const recommended = Math.max(4096, maxConnections * 2);
  try {
    const soft = readLimit();
    if (typeof soft === 'number') {
      if (soft < recommended) {
        log(
          'warn',
          `relay server enabled with maxConnections=${maxConnections}, ` +
            `but host ulimit -n soft=${soft} is below the recommended ${recommended} ` +
            `(= max(4096, maxConnections × 2)). The kernel will reject new ` +
            `socket() calls with EMFILE once the daemon hits the limit, ` +
            `manifesting as silent peer rejections. Bump with ` +
            `'ulimit -n ${recommended}' (shell), 'LimitNOFILE=${recommended}' (systemd unit), ` +
            `or '--ulimit nofile=${recommended}:${recommended}' (Docker).`,
        );
      } else {
        log(
          'info',
          `relay server: ulimit -n soft=${soft} >= recommended ${recommended}, ok`,
        );
      }
    } else {
      log(
        'warn',
        `relay server: could not read host ulimit -n via process.report.userLimits; ` +
          `ensure ulimit -n >= ${recommended} on this host`,
      );
    }
  } catch (err: any) {
    log(
      'warn',
      `relay server: error reading ulimit -n (${err?.message ?? String(err)}); ` +
        `ensure ulimit -n >= ${recommended} on this host`,
    );
  }
}

