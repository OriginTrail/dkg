import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import {
  readApiPort, loadConfig, apiPortPath, removeApiPort, logPath, ensureDkgDir,
} from './config.js';
import { DAEMON_EXIT_CODE_RESTART, decodeForcedExitCode } from './daemon.js';
import {
  isLivenessProbeEnabled,
  startLivenessWatcher,
  LIVENESS_CONSECUTIVE_FAILURES_TO_KILL,
  resolveLivenessShutdownGraceMs,
} from './daemon/supervisor-liveness.js';
import {
  resolveShutdownPolicy,
} from './daemon/shutdown-policy.js';
import {
  sleep, withSelectedDkgHome, selectedDkgHomeForEnv, probeHostForApiHost,
} from './cli-helpers.js';
import { resolveDaemonNodeCommand } from './daemon-entrypoint.js';
import {
  cleanupDaemonWorker,
  type WorkerExit,
} from './daemon/worker-cleanup-policy.js';
import { createForegroundSignalRelay } from './daemon/foreground-signal-relay.js';

async function appendSupervisorLog(message: string): Promise<void> {
  await ensureDkgDir();
  await appendFile(logPath(), `${new Date().toISOString()} ${message}\n`, 'utf-8');
}

function supervisorWarn(message: string): void {
  console.warn(message);
  void appendSupervisorLog(message).catch(() => {});
}

async function waitForWorkerExit(
  child: ReturnType<typeof spawn>,
): Promise<WorkerExit> {
  return new Promise<WorkerExit>((resolve) => {
    let settled = false;
    const finish = (exit: WorkerExit) => {
      if (settled) return;
      settled = true;
      resolve(exit);
    };
    child.once('exit', (code, signal) => finish({ code, signal }));
    child.once('error', () => finish({ code: 1, signal: null }));
  });
}

interface FinalizedWorkerExit {
  cleanupSucceeded: boolean;
  rawExitCode: number | null;
  forced: boolean;
  originalExitCode: number | null;
}

async function finalizeWorkerExit(
  workerPid: number | undefined,
  workerExit: WorkerExit,
  stopWatcher: () => void,
  label: string,
  generation: number,
): Promise<FinalizedWorkerExit> {
  stopWatcher();
  const rawExitCode = workerExit.code;
  const { forced, originalExitCode } = decodeForcedExitCode(rawExitCode);
  const cleanupSucceeded = await cleanupDaemonWorker(
    workerPid,
    workerExit,
    { warn: supervisorWarn },
    { label, generation },
  );
  if (!cleanupSucceeded) {
    return { cleanupSucceeded, rawExitCode, forced, originalExitCode };
  }
  if (workerExit.signal) {
    supervisorWarn(
      `[supervisor] ${label} exited by ${workerExit.signal} ` +
        `(code=${rawExitCode ?? 'null'}).`,
    );
  }
  if (forced) {
    console.warn(
      `[supervisor] previous worker forced-exited (code ${rawExitCode}; original intent ${originalExitCode}). ` +
        `Shutdown cleanup deadlocked — see worker logs for [shutdown-timeout].`,
    );
  }
  return { cleanupSucceeded, rawExitCode, forced, originalExitCode };
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
          onUnresponsive: () => {
            dependencies.warn(
              `[supervisor] worker unresponsive after ${LIVENESS_CONSECUTIVE_FAILURES_TO_KILL} consecutive liveness probes; SIGKILL + respawn.`,
            );
            try {
              child.kill('SIGKILL');
            } catch {
              /* child may already be exiting; ignore */
            }
          },
          onFailure: (consecutive: number) => {
            dependencies.warn(`[supervisor] liveness probe failed (${consecutive} in a row).`);
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

async function runDaemonSupervisor(): Promise<void> {
  process.env.DKG_HOME = selectedDkgHomeForEnv(process.env);
  const childEnv = withSelectedDkgHome(process.env);
  const livenessConfig = resolveSupervisorLivenessConfig(childEnv);
  const maxCrashRestarts = 5;
  let crashRestartCount = 0;
  let workerGeneration = 0;

  while (true) {
    await removeApiPort().catch((err: any) => {
      supervisorWarn(
        `[supervisor] could not clear stale api.port before spawn: ${err?.message ?? String(err)}`,
      );
    });
    const daemonCommand = resolveDaemonNodeCommand('daemon-worker');
    workerGeneration += 1;
    const child = spawn(
      daemonCommand.executable,
      daemonCommand.args,
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: childEnv,
        // POSIX: make the worker a private session/process-group leader. Its
        // PID is then the exact PGID the cleanup barrier owns. Windows keeps
        // the existing Job Object/pipe watchdog shape.
        detached: process.platform !== 'win32',
      },
    );
    const workerPid = child.pid;

    // Positive-liveness watchdog. Catches the generic zombie shape (HTTP
    // listener dead but process still alive) that the exit-watcher can't
    // see. SIGKILL forces the child's exit, the existing respawn logic
    // takes it from there. Gated by DKG_SUPERVISOR_LIVENESS_PROBE so
    // tests + headless-worker scenarios can opt out. See
    // packages/cli/src/daemon/supervisor-liveness.ts for the full rationale.
    const stopWatcher = await maybeStartSupervisorLivenessWatcher(child, livenessConfig);

    const workerExit = await waitForWorkerExit(child);
    const finalizedExit = await finalizeWorkerExit(
      workerPid,
      workerExit,
      stopWatcher,
      'worker',
      workerGeneration,
    );
    if (!finalizedExit.cleanupSucceeded) {
      process.exitCode = 1;
      return;
    }
    const { originalExitCode } = finalizedExit;

    if (originalExitCode === DAEMON_EXIT_CODE_RESTART) {
      crashRestartCount = 0;
      await sleep(250);
      continue;
    }

    if (originalExitCode === 0) return;

    crashRestartCount += 1;
    if (crashRestartCount >= maxCrashRestarts) return;
    await sleep(1000);
  }
}

interface ForegroundWorkerIterationDependencies {
  clearApiPort(): Promise<void>;
  spawnWorker(childEnv: NodeJS.ProcessEnv): ReturnType<typeof spawn>;
  startWorkerLiveness: typeof maybeStartSupervisorLivenessWatcher;
  warn(message: string): void;
}

const foregroundWorkerIterationDependencies: ForegroundWorkerIterationDependencies = {
  clearApiPort: removeApiPort,
  spawnWorker: (childEnv) => {
    const daemonCommand = resolveDaemonNodeCommand('daemon-foreground-worker');
    return spawn(
      daemonCommand.executable,
      daemonCommand.args,
      { stdio: 'inherit', env: childEnv, detached: process.platform !== 'win32' },
    );
  },
  startWorkerLiveness: maybeStartSupervisorLivenessWatcher,
  warn: supervisorWarn,
};

interface ForegroundWorkerIterationResult {
  rawExitCode: number | null;
  forced: boolean;
  originalExitCode: number | null;
  workerExit: WorkerExit;
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
  input.onChild?.(child);
  let stopWatcher: (() => void) | undefined;
  try {
    stopWatcher = await dependencies.startWorkerLiveness(
      child,
      input.livenessConfig ?? resolveSupervisorLivenessConfig(input.childEnv),
    );
    const workerExit = await new Promise<WorkerExit>((resolve) => {
      child.once('exit', (code, signal) => resolve({ code, signal }));
      child.once('error', () => resolve({ code: 1, signal: null }));
    });
    const rawExitCode = workerExit.code;
    return { rawExitCode, ...decodeForcedExitCode(rawExitCode), workerExit };
  } finally {
    stopWatcher?.();
    input.onChild?.(null);
  }
}

async function runForegroundSupervisor(
  childEnv: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const livenessConfig = resolveSupervisorLivenessConfig(childEnv);
  const maxCrashRestarts = 5;
  let crashRestartCount = 0;
  let currentWorkerPid: number | undefined;
  let workerGeneration = 0;

  const relay = createForegroundSignalRelay({ onTerminate: () => {} });

  try {
    while (true) {
      if (relay.signalled()) process.exit(0);

      const decision = await runForegroundWorkerIteration({
        childEnv,
        livenessConfig,
        onChild: (child) => {
          currentWorkerPid = child?.pid;
          if (child) relay.attach(child);
          else relay.detach();
        },
      });
      workerGeneration += 1;
      const finalizedExit = await finalizeWorkerExit(
        currentWorkerPid,
        decision.workerExit,
        () => {},
        'foreground worker',
        workerGeneration,
      );
      currentWorkerPid = undefined;
      if (!finalizedExit.cleanupSucceeded) {
        process.exit(1);
      }
      const { originalExitCode } = finalizedExit;

      if (relay.signalled()) process.exit(originalExitCode ?? 0);

      if (originalExitCode === DAEMON_EXIT_CODE_RESTART) {
        crashRestartCount = 0;
        await sleep(250);
        if (relay.signalled()) process.exit(0);
        continue;
      }

      if (originalExitCode === 0) process.exit(0);

      crashRestartCount += 1;
      if (crashRestartCount >= maxCrashRestarts) process.exit(originalExitCode ?? 1);
      await sleep(1000);
      if (relay.signalled()) process.exit(0);
    }
  } finally {
    relay.dispose();
  }
}

export {
  appendSupervisorLog,
  supervisorWarn,
  maybeStartSupervisorLivenessWatcher,
  runForegroundWorkerIteration,
  runDaemonSupervisor,
  runForegroundSupervisor,
};
