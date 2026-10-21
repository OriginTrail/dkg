/**
 * Supervisor positive-liveness probe.
 *
 * # Why this exists
 *
 * The supervisor loops in `cli.ts` (`runDaemonSupervisor`, `runForegroundSupervisor`)
 * watch for the worker child process to **exit** and respawn on a configured set
 * of exit codes. That works for clean crashes, segfaults, and graceful
 * shutdowns. It does **NOT** catch the beacon-01-class zombie: a worker
 * whose event loop is wedged after a partial shutdown attempt, with a dead
 * HTTP listener and no pending exit. The process is alive enough that
 * `child.exit` never fires; the supervisor waits forever.
 *
 * PR-1 (#655) catches the specific "deadlocked-shutdown" shape via a hard
 * timeout in the shutdown handler. This module catches the **generic** zombie
 * shape: anything that leaves the HTTP listener dead while the process
 * remains alive. Defense-in-depth.
 *
 * # HTTP response liveness
 *
 * The kernel can complete a TCP handshake while the worker's JavaScript
 * event loop is stuck. Require an HTTP response to a cheap, unknown API
 * HEAD route. Any status (including 401/404/503) proves request handling
 * progressed, without credentials or a database/chain health dependency.
 * A single absolute deadline bounds connecting and receiving the status
 * line, and the socket is destroyed on every outcome.
 *
 * # Env gate
 *
 * `DKG_SUPERVISOR_LIVENESS_PROBE` controls behaviour:
 *   - unset / `"on"` / `"1"` / `"true"`: probe is active.
 *   - `"off"` / `"0"` / `"false"`: probe disabled.
 *
 * Why an env gate: tests + the worker-without-HTTP scenario (e.g.
 * benchmark scripts that spawn a worker headlessly without the API
 * server) shouldn't get SIGKILLed because they have no listener to
 * probe. Defaults to on so production benefits; tests opt out.
 */

import { randomUUID } from 'node:crypto';
import { probeWorkerLiveness, livenessElapsedMs, LIVENESS_PROBE_TIMEOUT_MS, type LivenessProbeResult } from './liveness-probe.js';
export { probeWorkerAlive, probeWorkerLiveness, LIVENESS_PROBE_TIMEOUT_MS } from './liveness-probe.js';
import { SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS } from './shutdown.js';

export const DEFAULT_LIVENESS_SHUTDOWN_GRACE_MS = 30_000;

/** Default tick — 30s. Picked to be longer than typical request handling but short enough that a 5-failure quorum triggers within ~2.5 min. */
export const LIVENESS_PROBE_INTERVAL_MS = 30_000;

/** Default trigger threshold — 5 consecutive failures. With 30s tick → ~2.5 min unresponsive before SIGKILL. */
export const LIVENESS_CONSECUTIVE_FAILURES_TO_KILL = 5;

/** Derive watchdog grace from the already-validated worker hard timeout. */
export function resolveLivenessShutdownGraceMs(hardTimeoutMs: number): number {
  return Math.max(
    DEFAULT_LIVENESS_SHUTDOWN_GRACE_MS,
    hardTimeoutMs + SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS + LIVENESS_PROBE_TIMEOUT_MS,
  );
}

/**
 * Parse the env-gate value. Exported so tests can verify the truth table
 * without re-implementing the parser.
 *
 *   - unset / `"on"` / `"1"` / `"true"` (case-insensitive) → `true` (enabled).
 *   - `"off"` / `"0"` / `"false"` (case-insensitive) → `false` (disabled).
 *   - anything else → `true` (fail-safe: unknown value = enable rather than
 *     silently disable an operator's protection).
 */
export function isLivenessProbeEnabled(envValue: string | undefined): boolean {
  if (envValue === undefined) return true;
  const v = envValue.trim().toLowerCase();
  if (v === '' || v === 'on' || v === '1' || v === 'true') return true;
  if (v === 'off' || v === '0' || v === 'false') return false;
  return true;
}

export interface LivenessWatcherOpts {
  /** Port to probe (the worker's API listener). */
  port: number;
  /** Host to probe. Defaults to IPv4 loopback for the common apiHost case. */
  host?: string;
  /** Called whenever the threshold trips. Wired by the supervisor to `child.kill('SIGKILL')`. */
  onUnresponsive: (summary: LivenessRestartSummary) => void;
  onObservation?: (observation: LivenessObservation) => void;
  intervalMs?: number;
  timeoutMs?: number;
  consecutiveFailuresToKill?: number;
  /** Injectable probe — tests pass a stub. Defaults to `probeWorkerLiveness`. */
  probe?: typeof probeWorkerLiveness;
  /**
   * Optional graceful-shutdown detector. Called on every failed probe BEFORE
   * the consecutive-failure counter is incremented. If it returns truthy, the
   * watcher enters a bounded shutdown-grace window — failed probes during
   * this window do not count toward the SIGKILL threshold so we don't
   * SIGKILL the worker mid-teardown (e.g. `agent.stop()` / DB close after
   * `server.close()`).
   *
   * The supervisor wires this to `existsSync(apiPortFile) === false`: the
   * worker's `shutdown()` removes `api.port` BEFORE the slow awaits, so its
   * absence is the "graceful shutdown initiated" signal the watcher needs.
   *
   * Codex (#664#discussion_r3302432762): the previous implementation
   * PERMANENTLY disarmed the watcher on the first shutdown observation.
   * If a later teardown step hung (DB close, network shutdown, …), the
   * supervisor could no longer SIGKILL or respawn the worker. The fix:
   * keep probing during shutdown, but only fire SIGKILL after a bounded
   * grace window (`shutdownGraceMs`) so the worker's own
   * SHUTDOWN_HARD_TIMEOUT_MS gets first crack at force-exiting itself.
   */
  isShuttingDown?: () => boolean | Promise<boolean>;
  /**
   * Maximum time to wait after the worker enters graceful shutdown before
   * the watcher resumes counting failures toward `consecutiveFailuresToKill`.
   * Default remains 30s. The CLI supervisor supplies a value derived from the
   * worker's resolved hard timeout so an operator override cannot be
   * preempted. Set to a negative value to disable the bounded fallback
   * (legacy "disarm forever" behavior).
   */
  shutdownGraceMs?: number;
}

export interface LivenessObservation {
  generation: string;
  probe: LivenessProbeResult;
  consecutiveFailures: number;
  shutdownGrace: {
    state: 'not_observed' | 'within_grace' | 'expired' | 'unbounded' | 'detector_error';
    elapsedMs: number;
    budgetMs: number;
  };
}

export interface LivenessRestartSummary {
  generation: string;
  threshold: number;
  recent: LivenessObservation[];
}

export const LIVENESS_HISTORY_LIMIT = 8;

/** One watcher belongs to one child; stop also retires its in-flight HTTP request. */
export function startLivenessWatcher(opts: LivenessWatcherOpts): { stop(): void } {
  const intervalMs = opts.intervalMs ?? LIVENESS_PROBE_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? LIVENESS_PROBE_TIMEOUT_MS;
  const threshold = opts.consecutiveFailuresToKill ?? LIVENESS_CONSECUTIVE_FAILURES_TO_KILL;
  const probe = opts.probe ?? probeWorkerLiveness;
  const host = opts.host ?? '127.0.0.1';
  const shutdownGraceMs = opts.shutdownGraceMs ?? DEFAULT_LIVENESS_SHUTDOWN_GRACE_MS;
  const generation = randomUUID();
  const recent: LivenessObservation[] = [];
  const abort = new AbortController();
  let consecutiveFailures = 0;
  let probing = false;
  let stopped = false;
  let shutdownObservedAt: number | null = null;

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    abort.abort();
  };
  const tick = async () => {
    if (stopped || probing) return;
    probing = true;
    try {
      const result = await probe(opts.port, host, timeoutMs, abort.signal);
      if (stopped) return;
      const grace: LivenessObservation['shutdownGrace'] = {
        state: 'not_observed', elapsedMs: 0, budgetMs: shutdownGraceMs,
      };
      let suppressed = false;
      if (result.outcome === 'http_response') {
        consecutiveFailures = 0;
        shutdownObservedAt = null;
      } else {
        let inShutdown = false;
        try {
          inShutdown = !!(await opts.isShuttingDown?.());
        } catch {
          grace.state = 'detector_error';
        }
        // Child exit may occur while an asynchronous detector is pending.
        if (stopped) return;
        if (inShutdown) {
          if (shutdownObservedAt === null) {
            shutdownObservedAt = performance.now();
            consecutiveFailures = 0;
          }
          grace.elapsedMs = livenessElapsedMs(shutdownObservedAt);
          suppressed = shutdownGraceMs < 0 || grace.elapsedMs < shutdownGraceMs;
          grace.state = shutdownGraceMs < 0 ? 'unbounded' : suppressed ? 'within_grace' : 'expired';
        } else {
          shutdownObservedAt = null;
        }
        consecutiveFailures = suppressed ? 0 : consecutiveFailures + 1;
      }
      const observation: LivenessObservation = {
        generation, probe: result, consecutiveFailures, shutdownGrace: grace,
      };
      recent.push(observation);
      if (recent.length > LIVENESS_HISTORY_LIMIT) recent.shift();
      // Logging callbacks cannot disarm the watchdog or mutate retained history.
      try { opts.onObservation?.(structuredClone(observation)); } catch { /* best effort */ }
      if (stopped) return;
      if (consecutiveFailures >= threshold) {
        stop();
        opts.onUnresponsive({ generation, threshold, recent: structuredClone(recent) });
      }
    } finally {
      probing = false;
    }
  };
  const timer = setInterval(() => { void tick(); }, intervalMs);
  timer.unref?.();
  return { stop };
}
