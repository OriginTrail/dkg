import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import {
  readApiPort, loadConfig, apiPortPath, removeApiPort, logPath, ensureDkgDir,
} from './config.js';
import { DAEMON_EXIT_CODE_RESTART } from './daemon/manifest.js';
import { decodeForcedExitCode } from './daemon/shutdown.js';
import {
  isLivenessProbeEnabled,
  startLivenessWatcher,
  resolveLivenessShutdownGraceMs,
} from './daemon/supervisor-liveness.js';
import {
  resolveShutdownPolicy,
} from './daemon/shutdown-policy.js';
import {
  sleep, withSelectedDkgHome, selectedDkgHomeForEnv, probeHostForApiHost,
} from './cli-helpers.js';
import { resolveDaemonNodeCommand } from './daemon-entrypoint.js';

async function appendSupervisorLog(message: string): Promise<void> {
  await ensureDkgDir();
  await appendFile(logPath(), `${new Date().toISOString()} ${message}\n`, 'utf-8');
}

function supervisorWarn(message: string): void {
  console.warn(message);
  void appendSupervisorLog(message).catch(() => {});
}

interface WorkerExit {
  pid: number | undefined;
  code: number | null;
  signal: NodeJS.Signals | null;
}

/** Crashes in a row after which a supervisor starts no new worker. */
const MAX_CRASH_RESTARTS = 5;
/**
 * A worker that ran this long was healthy: once it crashes, the crashes before
 * it no longer count. So only crashes close together make a supervisor give
 * up, not a few spread over a node's whole life. Longer than a slow start plus
 * the liveness watchdog's kill (5 failed probes 30 s apart, about 2.5 min), so
 * a worker the watchdog keeps killing still counts.
 */
const HEALTHY_WORKER_UPTIME_MS = 10 * 60_000;
const REQUESTED_RESTART_DELAY_MS = 250;
const CRASH_RESTART_DELAY_MS = 1_000;

/**
 * What a supervisor does once its worker has ended. One decision drives the
 * loop and is what the supervisor logs, so the two cannot disagree.
 */
type WorkerExitDecision =
  | { readonly reason: 'asked-to-stop' | 'clean-stop'; readonly next: 'stop'; readonly exitCode: number }
  | { readonly reason: 'gave-up'; readonly next: 'stop'; readonly exitCode: number; readonly crashes: number }
  | { readonly reason: 'restart-requested'; readonly next: 'restart'; readonly crashes: 0; readonly delayMs: number }
  | {
    readonly reason: 'crashed';
    readonly next: 'restart';
    readonly crashes: number;
    readonly delayMs: number;
    /** Crashes before this one that no longer count, because this worker ran {@link HEALTHY_WORKER_UPTIME_MS}. */
    readonly forgiven: number;
  };

/**
 * Decide what follows a worker's exit, given the crashes counted before it.
 * A crash after a healthy run counts as the first again. Giving up ends the
 * supervisor with a non-zero code, the worker's own when it has one, so a
 * service manager sees a failure.
 */
function decideWorkerExit(
  { code, uptimeMs }: { code: number | null; uptimeMs: number },
  crashes: number,
  options: { stopping?: boolean } = {},
): WorkerExitDecision {
  const { originalExitCode } = decodeForcedExitCode(code);
  if (options.stopping) return { reason: 'asked-to-stop', next: 'stop', exitCode: originalExitCode ?? 0 };
  if (originalExitCode === DAEMON_EXIT_CODE_RESTART) {
    return { reason: 'restart-requested', next: 'restart', crashes: 0, delayMs: REQUESTED_RESTART_DELAY_MS };
  }
  if (originalExitCode === 0) return { reason: 'clean-stop', next: 'stop', exitCode: 0 };
  const forgiven = uptimeMs >= HEALTHY_WORKER_UPTIME_MS ? crashes : 0;
  const counted = crashes - forgiven + 1;
  if (counted >= MAX_CRASH_RESTARTS) {
    return { reason: 'gave-up', next: 'stop', exitCode: originalExitCode || 1, crashes: counted };
  }
  return { reason: 'crashed', next: 'restart', crashes: counted, delayMs: CRASH_RESTART_DELAY_MS, forgiven };
}

function describeNext(decision: WorkerExitDecision): string {
  switch (decision.reason) {
    case 'asked-to-stop':
      return 'the supervisor was asked to stop';
    case 'clean-stop':
      return 'clean stop, the supervisor stops too';
    case 'restart-requested':
      return 'restart requested, starting a new worker';
    case 'gave-up':
      return `giving up after ${decision.crashes} crashes with no worker running ${HEALTHY_WORKER_UPTIME_MS / 60_000} min between them: `
        + 'no new worker will start, and the node stays down until it is started again; '
        + `the supervisor exits with code ${decision.exitCode}`;
    case 'crashed':
      return `crash ${decision.crashes} of ${MAX_CRASH_RESTARTS}${describeForgiven(decision.forgiven)}, starting a new worker`;
  }
}

function describeForgiven(forgiven: number): string {
  if (forgiven === 0) return '';
  const minutes = HEALTHY_WORKER_UPTIME_MS / 60_000;
  return forgiven === 1
    ? ` (it ran ${minutes} min or more, so the crash before it no longer counts)`
    : ` (it ran ${minutes} min or more, so the ${forgiven} crashes before it no longer count)`;
}

/** The line a supervisor writes when its worker ended: how it ended, and what the supervisor does next. */
function describeWorkerExit({ pid, code, signal }: WorkerExit, decision: WorkerExitDecision): string {
  const { forced } = decodeForcedExitCode(code);
  const how = signal
    ? `signal ${signal}`
    : `exit code ${code}${forced ? ' (forced: its shutdown did not finish)' : ''}`;
  return `[supervisor] worker ${pid ?? 'unknown'} ended with ${how}; ${describeNext(decision)}`;
}

/**
 * Says it where it can be read: a detached supervisor and worker run with every
 * stream ignored, so `daemon.log` is the only record. Awaited, so that the line
 * comes before the next worker's and survives the supervisor's own exit.
 */
async function reportWorkerExit(message: string): Promise<void> {
  console.warn(message);
  await appendSupervisorLog(message).catch(() => {});
}

interface SupervisorLivenessConfig {
  enabled: boolean;
  shutdownGraceMs: number;
}

interface SupervisorLivenessDependencies {
  readPort(): Promise<number | null>;
  loadApiHost(): Promise<string | undefined>;
  apiPortExists(): boolean;
  startWatcher: typeof startLivenessWatcher;
  wait(ms: number): Promise<void>;
  warn(message: string): void;
}

const supervisorLivenessDependencies: SupervisorLivenessDependencies = {
  readPort: () => readApiPort(),
  loadApiHost: () => loadConfig().then((loaded) => loaded.apiHost),
  apiPortExists: () => existsSync(apiPortPath()),
  startWatcher: startLivenessWatcher,
  wait: sleep,
  warn: supervisorWarn,
};

function resolveSupervisorLivenessConfig(env: NodeJS.ProcessEnv): SupervisorLivenessConfig {
  return {
    enabled: isLivenessProbeEnabled(env.DKG_SUPERVISOR_LIVENESS_PROBE),
    shutdownGraceMs: resolveLivenessShutdownGraceMs(
      resolveShutdownPolicy(env.DKG_SHUTDOWN_HARD_TIMEOUT_MS).hardTimeoutMs,
    ),
  };
}

/**
 * Wire up the supervisor-liveness watchdog for a spawned worker child.
 *
 * Returns a `stop()` function the supervisor must call when the child
 * exits (cleanly or via SIGKILL). Returns a no-op if:
 *   - The env gate is disabled (`DKG_SUPERVISOR_LIVENESS_PROBE=off`).
 *
 * Wraps the apiPort-read in a polling loop because the worker writes the
 * port file midway through boot, AFTER spawn returns. The loop stays alive
 * until the supervisor stops it; slow boots must still get liveness
 * protection once their HTTP listener is ready.
 */
async function maybeStartSupervisorLivenessWatcher(
  child: { kill(signal: 'SIGKILL'): boolean },
  config: SupervisorLivenessConfig = resolveSupervisorLivenessConfig(process.env),
  dependencyOverrides: Partial<SupervisorLivenessDependencies> = {},
): Promise<() => void> {
  const dependencies = {
    ...supervisorLivenessDependencies,
    ...dependencyOverrides,
  };
  if (!config.enabled) {
    return () => {};
  }

  // Defer-start: keep waiting for the worker to write api.port. Some normal
  // boots do heavy initialization before binding HTTP; a fixed cutoff would
  // permanently disable the watchdog for those processes.
  let cancelled = false;
  let killRequested = false;
  let watcher: { stop(): void } | null = null;
  void (async () => {
    while (!cancelled) {
      const port = await dependencies.readPort().catch(() => null);
      if (port) {
        if (cancelled) return;
        const apiHost = await dependencies.loadApiHost().catch(() => undefined);
        if (cancelled) return;
        watcher = dependencies.startWatcher({
          port,
          host: probeHostForApiHost(apiHost),
          // Graceful-shutdown disarm: the worker's `shutdown()` removes
          // `api.port` BEFORE the slow cleanup tail (`agent.stop()`,
          // `dashDb.close()`, …), so its absence is the unambiguous "I'm
          // intentionally shutting down" signal. Without this the watcher
          // would race a slow teardown and SIGKILL mid-cleanup.
          isShuttingDown: () => !dependencies.apiPortExists(),
          shutdownGraceMs: config.shutdownGraceMs,
          onUnresponsive: (summary) => {
            if (cancelled || killRequested) return;
            killRequested = true;
            try {
              dependencies.warn(`[supervisor] liveness restart ${JSON.stringify(summary)}`);
            } catch { /* logging must not prevent termination */ }
            try {
              child.kill('SIGKILL');
            } catch {
              /* child may already be exiting; ignore */
            }
          },
          onObservation: (observation) => {
            if (!cancelled) dependencies.warn(`[supervisor] liveness probe ${JSON.stringify(observation)}`);
          },
        });
        return;
      }
      await dependencies.wait(500);
    }
  })();

  return () => {
    cancelled = true;
    watcher?.stop();
  };
}

interface SupervisorClock {
  /** Milliseconds on a monotonic clock: how long each worker ran. */
  now(): number;
  sleep(ms: number): Promise<void>;
}

const supervisorClock: SupervisorClock = {
  now: () => performance.now(),
  sleep,
};

interface DaemonSupervisorDependencies extends SupervisorClock {
  spawnWorker(childEnv: NodeJS.ProcessEnv): ReturnType<typeof spawn>;
}

const daemonSupervisorDependencies: DaemonSupervisorDependencies = {
  ...supervisorClock,
  spawnWorker: (childEnv) => {
    const daemonCommand = resolveDaemonNodeCommand('daemon-worker');
    return spawn(
      daemonCommand.executable,
      daemonCommand.args,
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: childEnv,
      },
    );
  },
};

/** Resolves with the code the supervisor's process ends with: non-zero once it gave up. */
async function runDaemonSupervisor(
  dependencyOverrides: Partial<DaemonSupervisorDependencies> = {},
): Promise<number> {
  const dependencies = { ...daemonSupervisorDependencies, ...dependencyOverrides };
  process.env.DKG_HOME = selectedDkgHomeForEnv(process.env);
  const childEnv = withSelectedDkgHome(process.env);
  const livenessConfig = resolveSupervisorLivenessConfig(childEnv);
  let crashRestartCount = 0;

  while (true) {
    await removeApiPort().catch((err: any) => {
      supervisorWarn(
        `[supervisor] could not clear stale api.port before spawn: ${err?.message ?? String(err)}`,
      );
    });
    const child = dependencies.spawnWorker(childEnv);
    const startedAt = dependencies.now();

    // Positive-liveness watchdog. Catches the generic zombie shape (HTTP
    // listener dead but process still alive) that the exit-watcher can't
    // see. SIGKILL forces the child's exit, the existing respawn logic
    // takes it from there. Gated by DKG_SUPERVISOR_LIVENESS_PROBE so
    // tests + headless-worker scenarios can opt out. See
    // packages/cli/src/daemon/supervisor-liveness.ts for the full rationale.
    const stopWatcher = await maybeStartSupervisorLivenessWatcher(child, livenessConfig);

    const { code: rawExitCode, signal } = await new Promise<Omit<WorkerExit, 'pid'>>((resolve) => {
      child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
    });
    const uptimeMs = dependencies.now() - startedAt;
    stopWatcher();
    const { forced, originalExitCode } = decodeForcedExitCode(rawExitCode);
    if (forced) {
      console.warn(
        `[supervisor] previous worker forced-exited (code ${rawExitCode}; original intent ${originalExitCode}). ` +
          `Shutdown cleanup deadlocked — see worker logs for [shutdown-timeout].`,
      );
    }
    const decision = decideWorkerExit({ code: rawExitCode, uptimeMs }, crashRestartCount);
    await reportWorkerExit(describeWorkerExit({ pid: child.pid, code: rawExitCode, signal }, decision));

    if (decision.next === 'stop') return decision.exitCode;
    crashRestartCount = decision.crashes;
    await dependencies.sleep(decision.delayMs);
  }
}

interface ForegroundWorkerIterationDependencies {
  clearApiPort(): Promise<void>;
  spawnWorker(childEnv: NodeJS.ProcessEnv): ReturnType<typeof spawn>;
  startWorkerLiveness: typeof maybeStartSupervisorLivenessWatcher;
  warn(message: string): void;
  /** Milliseconds on a monotonic clock: how long the worker ran. */
  now(): number;
}

const foregroundWorkerIterationDependencies: ForegroundWorkerIterationDependencies = {
  now: supervisorClock.now,
  clearApiPort: removeApiPort,
  spawnWorker: (childEnv) => {
    const daemonCommand = resolveDaemonNodeCommand('daemon-foreground-worker');
    return spawn(
      daemonCommand.executable,
      daemonCommand.args,
      { stdio: 'inherit', env: childEnv },
    );
  },
  startWorkerLiveness: maybeStartSupervisorLivenessWatcher,
  warn: supervisorWarn,
};

interface ForegroundWorkerIterationResult {
  pid: number | undefined;
  rawExitCode: number | null;
  signal: NodeJS.Signals | null;
  forced: boolean;
  originalExitCode: number | null;
  /** How long the worker ran, from its spawn to its exit. */
  uptimeMs: number;
}

async function runForegroundWorkerIteration(input: {
  childEnv: NodeJS.ProcessEnv;
  livenessConfig?: SupervisorLivenessConfig;
  onChild?: (child: ReturnType<typeof spawn> | null) => void;
  dependencies?: Partial<ForegroundWorkerIterationDependencies>;
}): Promise<ForegroundWorkerIterationResult> {
  const dependencies = {
    ...foregroundWorkerIterationDependencies,
    ...input.dependencies,
  };
  await dependencies.clearApiPort().catch((err: any) => {
    dependencies.warn(
      `[supervisor] could not clear stale api.port before foreground spawn: `
      + `${err?.message ?? String(err)}`,
    );
  });
  const child = dependencies.spawnWorker(input.childEnv);
  const startedAt = dependencies.now();
  input.onChild?.(child);
  let stopWatcher: (() => void) | undefined;
  try {
    stopWatcher = await dependencies.startWorkerLiveness(
      child,
      input.livenessConfig ?? resolveSupervisorLivenessConfig(input.childEnv),
    );
    const { code: rawExitCode, signal } = await new Promise<Omit<WorkerExit, 'pid'>>((resolve) => {
      child.once('exit', (code, exitSignal) => resolve({ code, signal: exitSignal }));
      child.once('error', () => resolve({ code: 1, signal: null }));
    });
    return {
      pid: child.pid,
      rawExitCode,
      signal,
      ...decodeForcedExitCode(rawExitCode),
      uptimeMs: dependencies.now() - startedAt,
    };
  } finally {
    stopWatcher?.();
    input.onChild?.(null);
  }
}

interface ForegroundSupervisorDependencies extends ForegroundWorkerIterationDependencies {
  sleep(ms: number): Promise<void>;
}

async function runForegroundSupervisor(
  childEnv: NodeJS.ProcessEnv = process.env,
  dependencies: Partial<ForegroundSupervisorDependencies> = {},
): Promise<void> {
  const { sleep: wait = supervisorClock.sleep, ...iterationDependencies } = dependencies;
  const livenessConfig = resolveSupervisorLivenessConfig(childEnv);
  let crashRestartCount = 0;
  let currentChild: ReturnType<typeof spawn> | null = null;

  let signalled = false;
  const onSignal = (sig: NodeJS.Signals) => {
    signalled = true;
    if (currentChild) currentChild.kill(sig);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    while (true) {
      if (signalled) process.exit(0);

      const ended = await runForegroundWorkerIteration({
        childEnv,
        livenessConfig,
        onChild: (child) => { currentChild = child; },
        dependencies: iterationDependencies,
      });
      const { pid, rawExitCode, signal, forced, originalExitCode, uptimeMs } = ended;
      if (forced) {
        console.warn(
          `[supervisor] previous worker forced-exited (code ${rawExitCode}; original intent ${originalExitCode}). ` +
            `Shutdown cleanup deadlocked — see worker logs for [shutdown-timeout].`,
        );
      }
      const decision = decideWorkerExit({ code: rawExitCode, uptimeMs }, crashRestartCount, { stopping: signalled });
      await reportWorkerExit(describeWorkerExit({ pid, code: rawExitCode, signal }, decision));

      if (decision.next === 'stop') process.exit(decision.exitCode);
      crashRestartCount = decision.crashes;
      await wait(decision.delayMs);
      if (signalled) process.exit(0);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
  }
}

export {
  appendSupervisorLog,
  supervisorWarn,
  HEALTHY_WORKER_UPTIME_MS,
  MAX_CRASH_RESTARTS,
  decideWorkerExit,
  describeWorkerExit,
  maybeStartSupervisorLivenessWatcher,
  runForegroundWorkerIteration,
  runDaemonSupervisor,
  runForegroundSupervisor,
};
