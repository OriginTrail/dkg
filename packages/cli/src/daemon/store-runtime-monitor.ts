/**
 * Runtime store monitor + managed-store recovery (store.monitor.*).
 *
 * # Why this exists (2026-07-18 mainnet wedge incident)
 *
 * The boot-time probe (store-health-check.ts) catches a store that's
 * dead at daemon start, but the incident showed the fleet's real
 * failure mode is a store that dies WHILE the daemon runs: Blazegraph's
 * JVM survives an OutOfMemoryError storm with its HTTP poller thread
 * dead (alive-but-deaf — ASK answers nothing forever at ~0.2% CPU), so
 * `--restart unless-stopped` never fires and nodes silently stop
 * submitting RandomSampling proofs until a human runs `docker restart`.
 *
 * This module owns everything operational around that gap — probing
 * timers, bounded `docker restart`s, the harden-lock suspension, and the
 * boot-recovery cooldown persistence — while store-health-check.ts stays
 * a pure probe/identity/formatting module (this monitor deliberately
 * reuses its `checkExternalStoreReachable`: raw fetch, NOT agent.store,
 * so a scheduler-saturated daemon can't mask a live endpoint — or vice
 * versa):
 *
 *   - `createStoreRuntimeMonitor`: periodic probe; ONLY for a
 *     daemon-managed Blazegraph container, a bounded `docker restart`
 *     (restart-only; never rm/recreate/volume ops) after N consecutive
 *     failures, with a cooldown so a genuinely sick store can't be
 *     restart-stormed. Operator-managed stores get loud logs and nothing
 *     else. All log lines carry the `store.monitor.` prefix so journald
 *     queries can grep one namespace.
 *   - `attemptManagedStoreBootRecovery`: one-shot boot-time recovery
 *     with a cross-process restart cooldown.
 *   - the `dkg store harden` lock path helpers this monitor READS and
 *     the harden executor WRITES (kept beside the reader so writer and
 *     reader can never drift).
 */
import { existsSync, statSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultDockerRunner, type DockerRunner } from './blazegraph-docker.js';
import { checkExternalStoreReachable } from './store-health-check.js';

function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Harden-migration lock marker (`<DKG_HOME>/.store-harden.lock`).
 *
 * `dkg store harden` stops the legacy container and then `docker cp`s a
 * multi-GB journal out of it — minutes of wall time during which THIS
 * monitor would otherwise see 6 failed probes and `docker restart` the
 * deliberately-stopped container mid-copy, tearing the export. The
 * harden executor writes this marker before its first mutating step and
 * removes it in a `finally`; while it exists the monitor (and the boot
 * recovery below) must not issue ANY docker restart.
 *
 * The filename constant + path helper live here (not in
 * harden/executor.ts) because the monitor is the reader; harden
 * imports them so writer and reader can never drift. Callers plumb the
 * config dir (`dkgDir()`) the same way `dkg store harden` resolves it.
 */
export const STORE_HARDEN_LOCK_FILENAME = '.store-harden.lock';

/** Boot-recovery restart-attempt timestamp (`<DKG_HOME>/.store-boot-restart-ts`). */
export const STORE_BOOT_RESTART_TS_FILENAME = '.store-boot-restart-ts';

export function storeHardenLockPath(dkgHome: string): string {
  return join(dkgHome, STORE_HARDEN_LOCK_FILENAME);
}

export function storeBootRestartTsPath(dkgHome: string): string {
  return join(dkgHome, STORE_BOOT_RESTART_TS_FILENAME);
}

/**
 * A harden lock older than this is treated as stale (crashed/SIGKILLed
 * harden that never reached its `finally`): the monitor logs loudly and
 * resumes normal operation rather than staying suspended forever. A real
 * migration (docker cp of a ~5.5 GB journal + verify) completes in
 * minutes; 6 hours is a generous ceiling.
 */
const HARDEN_LOCK_STALE_MS = 6 * 60 * 60 * 1000;

/** Live = exists and not stale. Errors reading mtime count as live (fail-safe). */
function hardenLockIsLive(lockPath: string, log: (m: string) => void): boolean {
  if (!existsSync(lockPath)) return false;
  let ageMs: number | null = null;
  try {
    ageMs = Date.now() - statSync(lockPath).mtimeMs;
  } catch {
    // Raced deletion or unreadable: treat as live for this tick — the
    // next tick re-checks and the cost of one skipped restart is nil.
    return true;
  }
  if (ageMs > HARDEN_LOCK_STALE_MS) {
    log(
      `[store.monitor] store.monitor.harden-lock-stale lock=${lockPath} ageMs=${Math.round(ageMs)} ` +
      `— a previous 'dkg store harden' apparently died without cleanup; ignoring the lock ` +
      `(remove the file to silence this)`,
    );
    return false;
  }
  return true;
}

export interface StoreMonitorStats {
  probesTotal: number;
  failuresTotal: number;
  consecutiveFailures: number;
  restartsTotal: number;
  /** docker restart attempts that failed (non-zero exit OR spawn rejection). */
  restartFailuresTotal: number;
  lastProbeOkAt: number | null;
  lastRestartAt: number | null;
  cooldownUntilMs: number | null;
  managedContainer: string | null;
}

export interface StoreRuntimeMonitorOptions {
  storeConfig:
    | {
        backend: string;
        options?: Record<string, unknown>;
      }
    | undefined;
  /**
   * Docker container to restart on sustained failure, or null when the
   * store is not daemon-managed (operator-managed stores are never
   * touched — log-only).
   */
  managedContainerName: string | null;
  /**
   * Path to the `dkg store harden` in-progress marker
   * ({@link storeHardenLockPath}). While the file exists (and is not
   * stale) the monitor suspends ALL docker restarts so it can never
   * revive a container the migration deliberately stopped mid-`docker
   * cp`. Callers (lifecycle.ts) pass `storeHardenLockPath(dkgDir())`;
   * omitting it disables the guard (tests / non-managed monitors).
   */
  hardenLockPath?: string;
  log: (msg: string) => void;
  // Injectables (tests provide these; production callers omit them):
  docker?: DockerRunner;
  fetch?: typeof globalThis.fetch;
  intervalMs?: number;
  probeTimeoutMs?: number;
  failureThreshold?: number;
  restartCooldownMs?: number;
  now?: () => number;
}

export interface StoreRuntimeMonitor {
  start(): void;
  stop(): void;
  /** One probe cycle; exposed so tests drive the state machine directly. */
  tick(): Promise<void>;
  readonly stats: StoreMonitorStats;
}

export function createStoreRuntimeMonitor(
  opts: StoreRuntimeMonitorOptions,
): StoreRuntimeMonitor {
  const log = opts.log;
  const now = opts.now ?? Date.now;
  const intervalMs = opts.intervalMs
    ?? parsePositiveIntegerEnv('DKG_STORE_MONITOR_INTERVAL_MS', 30_000);
  const probeTimeoutMs = opts.probeTimeoutMs ?? 8_000;
  const failureThreshold = opts.failureThreshold
    ?? parsePositiveIntegerEnv('DKG_STORE_MONITOR_FAILURE_THRESHOLD', 6);
  const restartCooldownMs = opts.restartCooldownMs
    ?? parsePositiveIntegerEnv('DKG_STORE_MONITOR_RESTART_COOLDOWN_MS', 600_000);

  const stats: StoreMonitorStats = {
    probesTotal: 0,
    failuresTotal: 0,
    consecutiveFailures: 0,
    restartsTotal: 0,
    restartFailuresTotal: 0,
    lastProbeOkAt: null,
    lastRestartAt: null,
    cooldownUntilMs: null,
    managedContainer: opts.managedContainerName,
  };

  // Uncapped consecutive-failure count for the unmanaged "log at each
  // threshold multiple" cadence; `stats.consecutiveFailures` is capped at
  // the threshold so a post-cooldown restart fires on the next tick, not
  // after another full run of failures.
  let rawConsecutive = 0;
  let inFlight = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  // Lazily constructed so a log-only monitor never spawns a docker probe.
  let docker: DockerRunner | null = opts.docker ?? null;

  async function tick(): Promise<void> {
    if (inFlight) return; // a slow probe must not stack a second one
    inFlight = true;
    try {
      const result = await checkExternalStoreReachable({
        storeConfig: opts.storeConfig,
        timeoutMs: probeTimeoutMs,
        fetch: opts.fetch,
      });
      stats.probesTotal += 1;
      if (result.ok) {
        if (rawConsecutive > 0) {
          log(`[store.monitor] store recovered after ${rawConsecutive} failed probe(s)`);
        }
        rawConsecutive = 0;
        stats.consecutiveFailures = 0;
        stats.lastProbeOkAt = now();
        return;
      }

      stats.failuresTotal += 1;
      rawConsecutive += 1;
      stats.consecutiveFailures = Math.min(rawConsecutive, failureThreshold);
      log(
        `[store.monitor] probe failed (${stats.consecutiveFailures}/${failureThreshold}): ` +
        `${result.error ?? 'unknown error'}`,
      );
      if (stats.consecutiveFailures < failureThreshold) return;

      if (opts.managedContainerName == null) {
        // Operator-managed store: never touch docker; re-alert at every
        // threshold multiple rather than every tick.
        if (rawConsecutive % failureThreshold === 0) {
          log(
            `[store.monitor] ERROR store.monitor.unhealthy endpoint=${result.endpoint ?? '<unknown>'} ` +
            `— NOT daemon-managed; manual intervention required`,
          );
        }
        return;
      }

      // BLOCKER-1(a): a live `dkg store harden` run deliberately stops the
      // container and copies its multi-GB journal — a restart here would
      // tear that export. Skip ANY restart while the lock is live; no
      // cooldown and no counter reset, so the restart fires on the first
      // failing tick after the lock clears. Logged at threshold multiples
      // (every ~failureThreshold ticks), not every tick.
      if (opts.hardenLockPath && hardenLockIsLive(opts.hardenLockPath, log)) {
        if (rawConsecutive % failureThreshold === 0) {
          log(
            `[store.monitor] store.monitor.suspended-by-harden container=${opts.managedContainerName} ` +
            `lock=${opts.hardenLockPath} — 'dkg store harden' is in progress; docker restarts suspended`,
          );
        }
        return;
      }

      const cooldownUntil = stats.cooldownUntilMs ?? 0;
      if (now() < cooldownUntil) {
        log(
          `[store.monitor] store.monitor.cooldown-wait remaining=${cooldownUntil - now()}ms ` +
          `container=${opts.managedContainerName}`,
        );
        return;
      }

      // Restart-ONLY — the monitor never removes, recreates, or touches
      // volumes; recreation is exclusively `dkg store harden`.
      //
      // The runner REJECTS on spawn errors (ENOENT, EMFILE, …) — this tick
      // runs from `void tick()` on a timer, so an escaped rejection would
      // land in the daemon's unhandledRejection handler. Catch, count, log.
      docker ??= defaultDockerRunner();
      let restart: { exitCode: number; stderr: string };
      try {
        restart = await docker.run(
          ['restart', '-t', '30', opts.managedContainerName],
          { timeoutMs: 120_000 },
        );
      } catch (err) {
        restart = {
          exitCode: -1,
          stderr: `docker spawn failed: ${(err as Error).message ?? String(err)}`,
        };
      }
      if (restart.exitCode === 0) {
        stats.restartsTotal += 1;
        stats.lastRestartAt = now();
        log(
          `[store.monitor] store.monitor.restart container=${opts.managedContainerName} ` +
          `restarts=${stats.restartsTotal}`,
        );
      } else {
        stats.restartFailuresTotal += 1;
        log(
          `[store.monitor] store.monitor.restart-failed container=${opts.managedContainerName} ` +
          `exit=${restart.exitCode} stderr=${restart.stderr.trim() || '(empty)'}`,
        );
      }
      // Cooldown starts even on a failed restart attempt — hammering
      // `docker restart` against a broken engine helps nobody.
      stats.cooldownUntilMs = now() + restartCooldownMs;
      rawConsecutive = 0;
      stats.consecutiveFailures = 0;
    } finally {
      inFlight = false;
    }
  }

  return {
    start() {
      if (timer) return;
      timer = setInterval(() => { void tick(); }, intervalMs);
      if (timer.unref) timer.unref();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
    tick,
    stats,
  };
}

/** Boot restarts are attempted at most once per this window (cross-process). */
export const BOOT_RESTART_COOLDOWN_MS = 30 * 60 * 1000;

/**
 * Boot-time one-shot recovery for a daemon-managed store that fails the
 * initial reachability probe: one bounded `docker restart`, then poll
 * until the endpoint answers or the timeout elapses. Returns whether the
 * store came back. Used exactly once before the boot path's exit(1) —
 * without this, a wedged store puts the daemon in an exit-loop (probe
 * fails → exit(1) → systemd restarts the daemon → same wedged store).
 *
 * Cross-process restart cooldown (`restartCooldownFilePath`): under
 * `Restart=always` a slow COLD-starting store (readiness > this
 * function's window) would otherwise loop daemon-exit → systemd-restart
 * → container-restart, never letting the store finish booting — each
 * daemon boot would kick the container back to second zero. The last
 * attempt's timestamp is persisted; while it is younger than
 * `restartCooldownMs` (default 30 min) the container-restart is SKIPPED
 * and we go straight to the re-probe poll (wait, then let the caller's
 * failure path exit) so the container's cold start runs undisturbed
 * across daemon restarts.
 *
 * Harden guard (`hardenLockPath`): while `dkg store harden` holds its
 * lock, no restart is issued at all (same reason as the runtime
 * monitor's suspension) — we only poll.
 */
export async function attemptManagedStoreBootRecovery(opts: {
  storeConfig:
    | {
        backend: string;
        options?: Record<string, unknown>;
      }
    | undefined;
  managedContainerName: string;
  log: (msg: string) => void;
  docker?: DockerRunner;
  fetch?: typeof globalThis.fetch;
  /** See {@link storeHardenLockPath}; omit to disable the guard. */
  hardenLockPath?: string;
  /** See {@link storeBootRestartTsPath}; omit to disable the cooldown. */
  restartCooldownFilePath?: string;
  restartCooldownMs?: number;
  readyTimeoutMs?: number;
  pollIntervalMs?: number;
}): Promise<boolean> {
  const docker = opts.docker ?? defaultDockerRunner();
  // >= 180s: cold start of s6 + Tomcat + a multi-GB RWStore journal takes
  // well over the old 60s (the hardened container's own health-start-period
  // is 120s). A too-small window here re-created the very exit-loop this
  // function exists to break.
  const readyTimeoutMs = opts.readyTimeoutMs ?? 180_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_000;
  const restartCooldownMs = opts.restartCooldownMs ?? BOOT_RESTART_COOLDOWN_MS;

  let restartAllowed = true;
  if (opts.hardenLockPath && hardenLockIsLive(opts.hardenLockPath, opts.log)) {
    opts.log(
      `[store.monitor] store.monitor.suspended-by-harden container=${opts.managedContainerName} ` +
      `lock=${opts.hardenLockPath} — boot recovery will not restart the container; polling only`,
    );
    restartAllowed = false;
  } else if (opts.restartCooldownFilePath) {
    const lastAttempt = await readFile(opts.restartCooldownFilePath, 'utf-8')
      .then((raw) => Number.parseInt(raw.trim(), 10))
      .catch(() => null);
    const ageMs = lastAttempt != null && Number.isFinite(lastAttempt)
      ? Date.now() - lastAttempt
      : null;
    if (ageMs != null && ageMs >= 0 && ageMs < restartCooldownMs) {
      opts.log(
        `[store.monitor] boot-recovery restart skipped — last attempt ${Math.round(ageMs / 1000)}s ago ` +
        `(< ${Math.round(restartCooldownMs / 1000)}s cooldown). Waiting for the store to finish its own ` +
        `start instead of kicking the container again.`,
      );
      restartAllowed = false;
    }
  }

  if (restartAllowed) {
    if (opts.restartCooldownFilePath) {
      // Record the attempt BEFORE issuing it so a crash mid-restart still
      // counts against the cooldown on the next boot.
      await writeFile(opts.restartCooldownFilePath, `${Date.now()}\n`, 'utf-8').catch((err) => {
        opts.log(
          `[store.monitor] boot-recovery could not persist the restart timestamp ` +
          `(${(err as Error).message}) — continuing`,
        );
      });
    }
    let restart: { exitCode: number; stderr: string };
    try {
      restart = await docker.run(
        ['restart', '-t', '30', opts.managedContainerName],
        { timeoutMs: 120_000 },
      );
    } catch (err) {
      restart = {
        exitCode: -1,
        stderr: `docker spawn failed: ${(err as Error).message ?? String(err)}`,
      };
    }
    if (restart.exitCode !== 0) {
      opts.log(
        `[store.monitor] boot-recovery restart failed for ${opts.managedContainerName}: ` +
        `${restart.stderr.trim() || `exit ${restart.exitCode}`}`,
      );
      return false;
    }
  }

  const deadline = Date.now() + readyTimeoutMs;
  for (;;) {
    const health = await checkExternalStoreReachable({
      storeConfig: opts.storeConfig,
      fetch: opts.fetch,
    });
    if (health.ok) {
      opts.log(
        restartAllowed
          ? `[store.monitor] boot-recovery succeeded — store reachable after restart`
          : `[store.monitor] boot-recovery succeeded — store came up on its own (no restart issued)`,
      );
      return true;
    }
    if (Date.now() >= deadline) {
      opts.log(
        `[store.monitor] boot-recovery failed — store still unreachable ` +
        `${readyTimeoutMs}ms after ${restartAllowed ? 'restart' : 'the skipped restart'}: ` +
        `${health.error ?? 'unknown error'}`,
      );
      return false;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
}
