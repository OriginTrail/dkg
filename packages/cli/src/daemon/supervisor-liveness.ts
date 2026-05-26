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
 * # Why TCP-connect rather than HTTP
 *
 * The cheapest possible "is the server alive" check is a plain TCP connect.
 *   - No HTTP request body to parse.
 *   - No auth token to load (saves us from threading config / loadTokens
 *     into the supervisor).
 *   - No 404/405/etc to special-case (any response = alive).
 *   - Cancellable cleanly via socket.destroy().
 *
 * If the TCP connection refuses or times out, the worker either died
 * silently (listener gone) or is in the wedged-event-loop state we're
 * trying to detect. Either way, SIGKILL + respawn is the right response.
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

import { connect, type Socket } from 'node:net';

/** Default tick — 30s. Picked to be longer than typical request handling but short enough that a 5-failure quorum triggers within ~2.5 min. */
export const LIVENESS_PROBE_INTERVAL_MS = 30_000;

/** Default per-probe TCP-connect timeout — 5s. Production daemons handle most requests in <100ms; 5s is many SDs above the long-tail. */
export const LIVENESS_PROBE_TIMEOUT_MS = 5_000;

/** Default trigger threshold — 5 consecutive failures. With 30s tick → ~2.5 min unresponsive before SIGKILL. */
export const LIVENESS_CONSECUTIVE_FAILURES_TO_KILL = 5;

/**
 * One-shot probe: connect to `host:port`, return `true` on success, `false`
 * on refusal / timeout / any error. Never throws.
 *
 * The socket is force-destroyed on every outcome (success or failure) to
 * avoid leaking file descriptors when the supervisor probes the worker
 * thousands of times over a long uptime.
 */
export async function probeWorkerAlive(
  port: number,
  host = '127.0.0.1',
  timeoutMs = LIVENESS_PROBE_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (alive: boolean, socket: Socket | null) => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        /* socket may already be destroyed; ignore */
      }
      resolve(alive);
    };
    let socket: Socket;
    try {
      socket = connect({ port, host });
    } catch (err) {
      // Synchronous throw from `connect` is unusual (it's normally async)
      // but possible on invalid port. Treat as not-alive.
      void err;
      resolve(false);
      return;
    }
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => settle(true, socket));
    socket.once('timeout', () => settle(false, socket));
    socket.once('error', () => settle(false, socket));
  });
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
  onUnresponsive: () => void;
  /**
   * Called once per failure increment (not per healthy probe) for log/telemetry.
   * Receives the running consecutive-failure count after the increment.
   */
  onFailure?: (consecutive: number) => void;
  intervalMs?: number;
  timeoutMs?: number;
  consecutiveFailuresToKill?: number;
  /** Injectable probe — tests pass a stub. Defaults to `probeWorkerAlive`. */
  probe?: (port: number, host?: string, timeoutMs?: number) => Promise<boolean>;
  /**
   * Optional graceful-shutdown detector. Called on every failed probe BEFORE
   * the consecutive-failure counter is incremented. If it returns truthy, the
   * watcher disarms — the worker is in the slow tail of an intentional
   * shutdown (e.g. `agent.stop()` / DB close after `server.close()`), and
   * SIGKILLing now would skip the rest of teardown.
   *
   * The supervisor wires this to `existsSync(apiPortFile) === false`: the
   * worker's `shutdown()` removes `api.port` BEFORE the slow awaits, so its
   * absence is the "graceful shutdown initiated" signal the watcher needs.
   * Without this check, a slow cleanup tail (or future `SHUTDOWN_HARD_TIMEOUT_MS`
   * bump above ~2.5 min) would race with `consecutiveFailuresToKill * intervalMs`
   * and SIGKILL the worker mid-teardown.
   */
  isShuttingDown?: () => boolean | Promise<boolean>;
}

/**
 * Start a periodic liveness watcher. Returns a `stop()` handle that the
 * supervisor's `child.exit` handler must call to cancel the interval —
 * otherwise the watcher keeps probing into the void after the worker
 * exits cleanly, eventually generating spurious SIGKILL attempts.
 *
 * The watcher self-throttles: if a probe is already in flight when the
 * tick fires, the second tick is dropped (we don't pile up probes when
 * the worker is slow but not dead).
 */
export function startLivenessWatcher(opts: LivenessWatcherOpts): { stop(): void } {
  const intervalMs = opts.intervalMs ?? LIVENESS_PROBE_INTERVAL_MS;
  const timeoutMs = opts.timeoutMs ?? LIVENESS_PROBE_TIMEOUT_MS;
  const threshold = opts.consecutiveFailuresToKill ?? LIVENESS_CONSECUTIVE_FAILURES_TO_KILL;
  const probe = opts.probe ?? probeWorkerAlive;
  const host = opts.host ?? '127.0.0.1';

  let consecutiveFailures = 0;
  let probing = false;
  let stopped = false;

  const tick = async () => {
    if (stopped || probing) return;
    probing = true;
    try {
      const alive = await probe(opts.port, host, timeoutMs);
      if (stopped) return;
      if (alive) {
        consecutiveFailures = 0;
        return;
      }
      // Probe failed. Before counting it toward the SIGKILL threshold,
      // ask the supervisor whether the worker is in a graceful shutdown
      // (api.port file absent — see `LivenessWatcherOpts.isShuttingDown`).
      // If so, disarm the watcher: SIGKILLing now would bypass `agent.stop()`,
      // DB close, and pid cleanup, leaving local state dirty.
      if (opts.isShuttingDown) {
        try {
          if (await opts.isShuttingDown()) {
            stopped = true;
            return;
          }
        } catch {
          /* shutdown detector errors shouldn't unconditionally arm the SIGKILL path; treat as "still alive" and keep counting failures. */
        }
      }
      consecutiveFailures += 1;
      opts.onFailure?.(consecutiveFailures);
      if (consecutiveFailures >= threshold) {
        // Reset BEFORE firing the kill — otherwise a slow respawn would
        // hit the threshold again before the new worker's listener binds.
        consecutiveFailures = 0;
        opts.onUnresponsive();
      }
    } finally {
      probing = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  // Allow the parent process to exit cleanly even if a probe interval is
  // still scheduled. The supervisor's lifecycle should always reach stop(),
  // but this is a safety net.
  if (timer.unref) timer.unref();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
