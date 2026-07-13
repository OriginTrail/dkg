import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { appendFile } from 'node:fs/promises';
import {
  readApiPort, loadConfig, apiPortPath, removeApiPort, logPath, ensureDkgDir,
} from './config.js';
import { DAEMON_EXIT_CODE_RESTART, decodeForcedExitCode } from './daemon.js';
import {
  isLivenessProbeEnabled, startLivenessWatcher, LIVENESS_CONSECUTIVE_FAILURES_TO_KILL,
} from './daemon/supervisor-liveness.js';
import {
  sleep, withSelectedDkgHome, selectedDkgHomeForEnv, probeHostForApiHost,
} from './cli-helpers.js';
import { resolveDaemonNodeCommand } from './daemon-entrypoint.js';
import {
  MANAGED_OXIGRAPH_BACKEND,
  resolveManagedOxigraphPort,
} from './daemon/oxigraph-managed.js';
import {
  reapWorkerProcessGroup,
  waitForTcpPortRelease,
} from './daemon/worker-process-group.js';

async function appendSupervisorLog(message: string): Promise<void> {
  await ensureDkgDir();
  await appendFile(logPath(), `${new Date().toISOString()} ${message}\n`, 'utf-8');
}

function supervisorWarn(message: string): void {
  console.warn(message);
  void appendSupervisorLog(message).catch(() => {});
}

interface WorkerExit {
  code: number | null;
  signal: NodeJS.Signals | null;
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

async function configuredManagedOxigraphPort(): Promise<number | null> {
  const config = await loadConfig();
  if (config.store?.backend !== MANAGED_OXIGRAPH_BACKEND) return null;
  return resolveManagedOxigraphPort(config.store.options);
}

/**
 * Cleanup barrier between a worker exit and its replacement.
 *
 * POSIX workers are private process-group leaders. Reap that exact group,
 * then (for a configured managed store) verify the loopback listener is gone.
 * The port check also covers systemd-scope mode, where Oxigraph deliberately
 * lives outside the worker's group and its parent watchdog performs cleanup.
 */
async function cleanupWorkerOwnedProcesses(
  workerPid: number | undefined,
  exit: WorkerExit,
): Promise<boolean> {
  try {
    const result = await reapWorkerProcessGroup(workerPid);
    if (!result.empty) {
      supervisorWarn(
        `[supervisor] worker process group ${workerPid ?? 'unknown'} still has survivors ` +
          `after SIGTERM/SIGKILL; refusing to spawn a replacement.`,
      );
      return false;
    }
    if (result.termSent || result.killSent) {
      supervisorWarn(
        `[supervisor] reaped worker process group ${workerPid} after exit ` +
          `(code=${exit.code ?? 'null'}, signal=${exit.signal ?? 'null'}, ` +
          `sigkill=${result.killSent}).`,
      );
    }

    const managedPort = await configuredManagedOxigraphPort();
    if (managedPort !== null) {
      const released = await waitForTcpPortRelease('127.0.0.1', managedPort);
      if (!released) {
        supervisorWarn(
          `[supervisor] managed Oxigraph port 127.0.0.1:${managedPort} is still listening ` +
            `after worker cleanup; refusing to spawn a replacement.`,
        );
        return false;
      }
    }
    return true;
  } catch (error) {
    supervisorWarn(
      `[supervisor] worker descendant cleanup failed: ` +
        `${error instanceof Error ? error.message : String(error)}; ` +
        `refusing to spawn a replacement.`,
    );
    return false;
  }
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
): Promise<() => void> {
  if (!isLivenessProbeEnabled(process.env.DKG_SUPERVISOR_LIVENESS_PROBE)) {
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
        const config = await loadConfig().catch(() => ({ apiHost: undefined }));
        if (cancelled) return;
        watcher = startLivenessWatcher({
          port,
          host: probeHostForApiHost(config.apiHost),
          // Graceful-shutdown disarm: the worker's `shutdown()` removes
          // `api.port` BEFORE the slow cleanup tail (`agent.stop()`,
          // `dashDb.close()`, …), so its absence is the unambiguous "I'm
          // intentionally shutting down" signal. Without this the watcher
          // would race a slow teardown and SIGKILL mid-cleanup.
          isShuttingDown: () => !existsSync(apiPortPath()),
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
        env: withSelectedDkgHome(process.env),
        // POSIX: make the worker a private session/process-group leader. Its
        // PID is then the exact PGID the cleanup barrier owns. Windows needs
        // a Job Object/pipe watchdog instead and keeps the existing shape.
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
    const stopWatcher = await maybeStartSupervisorLivenessWatcher(child);

    const workerExit = await waitForWorkerExit(child);
    stopWatcher();
    if (!(await cleanupWorkerOwnedProcesses(workerPid, workerExit))) {
      process.exitCode = 1;
      return;
    }
    const rawExitCode = workerExit.code;
    if (workerExit.signal) {
      supervisorWarn(
        `[supervisor] worker exited by ${workerExit.signal} (code=${rawExitCode ?? 'null'}).`,
      );
    }
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

async function runForegroundSupervisor(childEnv: NodeJS.ProcessEnv = process.env): Promise<void> {
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

  while (true) {
    if (signalled) process.exit(0);

    await removeApiPort().catch((err: any) => {
      supervisorWarn(
        `[supervisor] could not clear stale api.port before foreground spawn: ${err?.message ?? String(err)}`,
      );
    });

    const daemonCommand = resolveDaemonNodeCommand('daemon-foreground-worker');
    currentChild = spawn(
      daemonCommand.executable,
      daemonCommand.args,
      {
        stdio: 'inherit',
        env: childEnv,
        detached: process.platform !== 'win32',
      },
    );
    const workerPid = currentChild.pid;

    const stopWatcher = await maybeStartSupervisorLivenessWatcher(currentChild);

    const workerExit = await waitForWorkerExit(currentChild);
    stopWatcher();
    currentChild = null;
    if (!(await cleanupWorkerOwnedProcesses(workerPid, workerExit))) process.exit(1);
    const rawExitCode = workerExit.code;
    if (workerExit.signal) {
      supervisorWarn(
        `[supervisor] foreground worker exited by ${workerExit.signal} ` +
          `(code=${rawExitCode ?? 'null'}).`,
      );
    }
    const { forced, originalExitCode } = decodeForcedExitCode(rawExitCode);
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
}

export {
  appendSupervisorLog,
  supervisorWarn,
  maybeStartSupervisorLivenessWatcher,
  runDaemonSupervisor,
  runForegroundSupervisor,
};
