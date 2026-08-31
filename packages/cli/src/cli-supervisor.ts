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

async function appendSupervisorLog(message: string): Promise<void> {
  await ensureDkgDir();
  await appendFile(logPath(), `${new Date().toISOString()} ${message}\n`, 'utf-8');
}

function supervisorWarn(message: string): void {
  console.warn(message);
  void appendSupervisorLog(message).catch(() => {});
}

interface SupervisorLivenessConfig {
  enabled: boolean;
  shutdownGraceMs: number;
}

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
): Promise<() => void> {
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
      const port = await readApiPort().catch(() => null);
      if (port) {
        if (cancelled) return;
        const apiHost = await loadConfig().then((loaded) => loaded.apiHost).catch(() => undefined);
        if (cancelled) return;
        watcher = startLivenessWatcher({
          port,
          host: probeHostForApiHost(apiHost),
          // Graceful-shutdown disarm: the worker's `shutdown()` removes
          // `api.port` BEFORE the slow cleanup tail (`agent.stop()`,
          // `dashDb.close()`, …), so its absence is the unambiguous "I'm
          // intentionally shutting down" signal. Without this the watcher
          // would race a slow teardown and SIGKILL mid-cleanup.
          isShuttingDown: () => !existsSync(apiPortPath()),
          shutdownGraceMs: config.shutdownGraceMs,
          onUnresponsive: () => {
            supervisorWarn(
              `[supervisor] worker unresponsive after ${LIVENESS_CONSECUTIVE_FAILURES_TO_KILL} consecutive liveness probes; SIGKILL + respawn.`,
            );
            try {
              child.kill('SIGKILL');
            } catch {
              /* child may already be exiting; ignore */
            }
          },
          onFailure: (consecutive: number) => {
            supervisorWarn(`[supervisor] liveness probe failed (${consecutive} in a row).`);
          },
        });
        return;
      }
      await sleep(500);
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

  while (true) {
    await removeApiPort().catch((err: any) => {
      supervisorWarn(
        `[supervisor] could not clear stale api.port before spawn: ${err?.message ?? String(err)}`,
      );
    });
    const daemonCommand = resolveDaemonNodeCommand('daemon-worker');
    const child = spawn(
      daemonCommand.executable,
      daemonCommand.args,
      {
        stdio: ['ignore', 'ignore', 'ignore'],
        env: childEnv,
      },
    );

    // Positive-liveness watchdog. Catches the generic zombie shape (HTTP
    // listener dead but process still alive) that the exit-watcher can't
    // see. SIGKILL forces the child's exit, the existing respawn logic
    // takes it from there. Gated by DKG_SUPERVISOR_LIVENESS_PROBE so
    // tests + headless-worker scenarios can opt out. See
    // packages/cli/src/daemon/supervisor-liveness.ts for the full rationale.
    const stopWatcher = await maybeStartSupervisorLivenessWatcher(child, livenessConfig);

    const rawExitCode = await new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
    });
    stopWatcher();
    const { forced, originalExitCode } = decodeForcedExitCode(rawExitCode);
    if (forced) {
      console.warn(
        `[supervisor] previous worker forced-exited (code ${rawExitCode}; original intent ${originalExitCode}). ` +
          `Shutdown cleanup deadlocked — see worker logs for [shutdown-timeout].`,
      );
    }

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
      { stdio: 'inherit', env: childEnv },
    );
  },
  startWorkerLiveness: maybeStartSupervisorLivenessWatcher,
  warn: supervisorWarn,
};

interface ForegroundWorkerIterationResult {
  rawExitCode: number | null;
  forced: boolean;
  originalExitCode: number | null;
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
    const rawExitCode = await new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', () => resolve(1));
    });
    return { rawExitCode, ...decodeForcedExitCode(rawExitCode) };
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

      const decision = await runForegroundWorkerIteration({
        childEnv,
        livenessConfig,
        onChild: (child) => { currentChild = child; },
      });
      const { rawExitCode, forced, originalExitCode } = decision;
      if (forced) {
        console.warn(
          `[supervisor] previous worker forced-exited (code ${rawExitCode}; original intent ${originalExitCode}). ` +
            `Shutdown cleanup deadlocked — see worker logs for [shutdown-timeout].`,
        );
      }

      if (signalled) process.exit(originalExitCode ?? 0);

      if (originalExitCode === DAEMON_EXIT_CODE_RESTART) {
        crashRestartCount = 0;
        await sleep(250);
        if (signalled) process.exit(0);
        continue;
      }

      if (originalExitCode === 0) process.exit(0);

      crashRestartCount += 1;
      if (crashRestartCount >= maxCrashRestarts) process.exit(originalExitCode ?? 1);
      await sleep(1000);
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
  maybeStartSupervisorLivenessWatcher,
  runForegroundWorkerIteration,
  runDaemonSupervisor,
  runForegroundSupervisor,
};
