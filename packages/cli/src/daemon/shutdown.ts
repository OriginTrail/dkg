/**
 * Hard-timeout fallback for the daemon graceful-shutdown path.
 *
 * Why this exists: shutdown can deadlock when in-flight sync work is holding
 * libp2p reads/writes open while `agent.stop()` waits to drain (observed on
 * beacon-01 during a mid-deploy upgrade). Without a deadline, the worker
 * process becomes a zombie — the supervisor doesn't notice because the worker
 * is technically still alive, just unresponsive — and operator intervention
 * (`kill -9`) is the only recovery. This module provides:
 *
 *   1. A wall-clock deadline ({@link raceShutdownWithTimeout}) so a stuck
 *      graceful path always yields to a forced exit within {@link SHUTDOWN_HARD_TIMEOUT_MS}
 *      (plus at most {@link SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS} for best-effort
 *      forced cleanup — see below).
 *   2. An exit-code convention ({@link SHUTDOWN_FORCED_OFFSET}) so the supervisor
 *      and external monitoring can distinguish "shutdown deadlocked" from
 *      "shutdown OK", without losing the restart-vs-final-exit signal embedded
 *      in the original exit code passed to `shutdown()`.
 *
 * This is a safety net, not a root-cause fix. The proper fix (PR-6 in the
 * core-stability workstream) is to plumb an `AbortSignal` through `DKGNode.stop()`
 * to the long-await sites so they unwind cleanly. PR-1 lands first so the
 * failure mode stops bleeding network-wide while PR-6 is in flight.
 */

import { DAEMON_EXIT_CODE_RESTART } from './manifest.js';

/** Default deadline for graceful shutdown before we hard-exit. */
export const SHUTDOWN_HARD_TIMEOUT_MS = 15_000;

/**
 * Per-callsite budget for the best-effort forced-cleanup hook (state-file
 * unlinks, etc.) that runs after the hard timeout fires. Bounded separately
 * from {@link SHUTDOWN_HARD_TIMEOUT_MS} so a stalled filesystem op cannot
 * recreate the same zombie shape we're trying to prevent: if THIS deadlines
 * too, we abandon the work and exit. 1s is generous for `unlink()` calls and
 * still keeps total wall-clock < 16s in the worst case.
 */
export const SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS = 1_000;

/**
 * Forced-shutdown exit codes are derived from the shutdown callsites that
 * exist today:
 *
 *   exitCode 0                          -> 100  (operator wanted final exit; cleanup deadlocked)
 *   exitCode DAEMON_EXIT_CODE_RESTART   -> 100 + DAEMON_EXIT_CODE_RESTART
 *                                          (operator wanted restart; cleanup deadlocked, restart still respected)
 *
 * The supervisor in `cli.ts` calls {@link decodeForcedExitCode} to recover the
 * original intent (so a forced "restart" still triggers respawn, and a forced
 * "final exit" still terminates the supervisor).
 *
 * Offset of 100 chosen because:
 *   - Stays comfortably under the 8-bit exit-code limit of 255 for our current
 *     callsites (0 and `DAEMON_EXIT_CODE_RESTART = 75`).
 *   - Doesn't collide with any exit code we currently emit (we have nothing
 *     in [100, 199]).
 *   - Visibly distinct in log output and on Datadog/Prometheus exit-code
 *     dashboards; alerts can target `exitCode >= 100 && exitCode < 200` as
 *     the "shutdown deadlocked" signal.
 *
 * Built dynamically from `DAEMON_EXIT_CODE_RESTART` so the encode/decode path
 * stays coupled to whatever the supervisor's actual restart sentinel is — if
 * the constant ever moves, this table moves with it instead of silently
 * diverging.
 */
export const SHUTDOWN_FORCED_OFFSET = 100;
const FORCED_SHUTDOWN_EXIT_CODES = new Map<number, number>([
  [SHUTDOWN_FORCED_OFFSET, 0],
  [SHUTDOWN_FORCED_OFFSET + DAEMON_EXIT_CODE_RESTART, DAEMON_EXIT_CODE_RESTART],
]);

export function encodeForcedShutdownExitCode(exitCode: number): number {
  const forcedExitCode = exitCode + SHUTDOWN_FORCED_OFFSET;
  if (!FORCED_SHUTDOWN_EXIT_CODES.has(forcedExitCode)) {
    throw new Error(
      `Unsupported forced shutdown exit code ${exitCode}; add an explicit sentinel before using this shutdown path.`,
    );
  }
  return forcedExitCode;
}

/**
 * Returns true if `exitCode` is one our shutdown handler emitted because the
 * graceful path missed the {@link SHUTDOWN_HARD_TIMEOUT_MS} deadline.
 */
export function isForcedShutdownExitCode(exitCode: number | null): boolean {
  if (exitCode === null) return false;
  return FORCED_SHUTDOWN_EXIT_CODES.has(exitCode);
}

/**
 * Recovers the original `exitCode` the shutdown handler was called with, even
 * when the offset was applied. For non-forced exits returns the input unchanged.
 *
 * Used by the supervisor: if it receives `DAEMON_EXIT_CODE_RESTART + offset`
 * it should still respawn, because the operator (or auto-update path) asked for
 * a restart and the offset is orthogonal to that intent.
 */
export function decodeForcedExitCode(exitCode: number | null): {
  forced: boolean;
  originalExitCode: number | null;
} {
  if (exitCode === null) return { forced: false, originalExitCode: null };
  if (isForcedShutdownExitCode(exitCode)) {
    return { forced: true, originalExitCode: FORCED_SHUTDOWN_EXIT_CODES.get(exitCode)! };
  }
  return { forced: false, originalExitCode: exitCode };
}

/**
 * Resolves with `{ forced: true }` after `hardTimeoutMs`, or with
 * `{ forced: false }` the moment `cleanup` settles — whichever happens first.
 *
 * On the timeout path, `onForcedTimeout` (best-effort post-deadline cleanup —
 * typically state-file unlinks the supervisor needs to be gone before the next
 * worker spawns) runs behind its own {@link forcedCleanupTimeoutMs} budget.
 * If it completes within the budget, the race resolves; if it stalls (e.g.
 * filesystem I/O blocked) we log and resolve anyway, because the whole point
 * of this helper is that nothing past the wall-clock deadline can prevent
 * `process.exit()` from being reached.
 *
 * The single-shot timer is always cleared on race resolution (including if
 * `cleanup` rejects), so callers don't need a `finally` block. Callers SHOULD
 * pre-wrap `cleanup` with `.catch()` if they don't want shutdown errors to
 * surface as unhandled-rejections — `Promise.race` will otherwise propagate
 * the rejection here.
 */
export async function raceShutdownWithTimeout(
  cleanup: Promise<void>,
  hardTimeoutMs: number,
  log: (msg: string) => void,
  onForcedTimeout?: () => void | Promise<void>,
  forcedCleanupTimeoutMs: number = SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS,
): Promise<{ forced: boolean }> {
  let forced = false;
  let timer: NodeJS.Timeout | null = null;
  const hardKill = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      forced = true;
      log(
        `[shutdown-timeout] cleanup exceeded ${hardTimeoutMs}ms; forcing exit. ` +
          `Likely a sync-deadlock in agent.stop(); preserve the preceding 20 log lines for a bug report.`,
      );
      if (!onForcedTimeout) {
        resolve();
        return;
      }
      // Bound the forced cleanup with its own timer: if state-file unlinks
      // stall on filesystem I/O, we still reach `process.exit()` instead of
      // recreating the same zombie shape we're trying to prevent.
      let forcedTimer: NodeJS.Timeout | null = null;
      const forcedKill = new Promise<void>((forcedResolve) => {
        forcedTimer = setTimeout(() => {
          log(
            `[shutdown-timeout] forced cleanup exceeded ${forcedCleanupTimeoutMs}ms; abandoning.`,
          );
          forcedResolve();
        }, forcedCleanupTimeoutMs);
      });
      const forcedCleanup = Promise.resolve()
        .then(() => onForcedTimeout())
        .catch((err: any) => {
          log(`[shutdown-timeout] forced cleanup error: ${err?.message ?? String(err)}`);
        });
      void Promise.race([forcedCleanup, forcedKill]).finally(() => {
        if (forcedTimer) clearTimeout(forcedTimer);
        resolve();
      });
    }, hardTimeoutMs);
  });
  try {
    await Promise.race([cleanup, hardKill]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { forced };
}
