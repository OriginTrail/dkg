import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import {
  dkgDir,
  ensureDkgDir,
  isProcessRunning,
  readPid,
  removePid,
  writePid,
} from '../config.js';
import { writeFileAtomic } from './fs-utils.js';
import { SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS } from './shutdown.js';
import {
  MAX_SHUTDOWN_HARD_TIMEOUT_MS,
  resolveShutdownPolicy,
  type ShutdownPolicy,
} from './shutdown-policy.js';

export const DAEMON_EXIT_POLL_INTERVAL_MS = 500;
const DAEMON_SHUTDOWN_POLICY_STATE_FILE = 'shutdown-policy.json';

interface ShutdownPolicyState {
  version: 1;
  pid: number;
  hardTimeoutMs: number;
}

function daemonShutdownPolicyStatePath(): string {
  return join(dkgDir(), DAEMON_SHUTDOWN_POLICY_STATE_FILE);
}

function decodeShutdownPolicyState(serialized: string): ShutdownPolicyState | null {
  try {
    const parsed = JSON.parse(serialized) as Partial<ShutdownPolicyState>;
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.pid)
      || !Number.isSafeInteger(parsed.hardTimeoutMs)
    ) return null;
    const validated = resolveShutdownPolicy(String(parsed.hardTimeoutMs));
    return { version: 1, pid: parsed.pid as number, ...validated };
  } catch {
    return null;
  }
}

async function readShutdownPolicyState(): Promise<ShutdownPolicyState | null> {
  try {
    return decodeShutdownPolicyState(
      await readFile(daemonShutdownPolicyStatePath(), 'utf8'),
    );
  } catch {
    return null;
  }
}

async function removeShutdownPolicyState(expectedPid: number): Promise<void> {
  const state = await readShutdownPolicyState();
  if (state?.pid !== expectedPid) return;
  try {
    await unlink(daemonShutdownPolicyStatePath());
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code !== 'ENOENT') throw error;
  }
}

/** Canonical owner-scoped boundary for the daemon PID and shutdown policy. */
export const daemonRuntimeState = {
  async claim(pid: number, policy: ShutdownPolicy): Promise<void> {
    const validated = resolveShutdownPolicy(String(policy.hardTimeoutMs));
    await ensureDkgDir();
    await writeFileAtomic(daemonShutdownPolicyStatePath(), JSON.stringify({
      version: 1,
      pid,
      ...validated,
    }));
    try {
      await writePid(pid);
    } catch (error) {
      await removeShutdownPolicyState(pid).catch(() => {});
      throw error;
    }
  },

  readPid,

  async readPolicy(expectedPid: number): Promise<ShutdownPolicy | null> {
    const state = await readShutdownPolicyState();
    return state?.pid === expectedPid ? { hardTimeoutMs: state.hardTimeoutMs } : null;
  },

  async resolveWaitTimeoutMs(expectedPid: number): Promise<number> {
    const persisted = await this.readPolicy(expectedPid);
    return (persisted?.hardTimeoutMs ?? MAX_SHUTDOWN_HARD_TIMEOUT_MS)
      + SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS;
  },

  async release(expectedPid: number): Promise<void> {
    const recordedPid = await readPid();
    await Promise.all([
      recordedPid === expectedPid ? removePid() : Promise.resolve(),
      removeShutdownPolicyState(expectedPid),
    ]);
  },
};

interface WaitForDaemonExitOptions {
  timeoutMs?: number;
  pollIntervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  isRunning?: (pid: number) => boolean;
}

/** Wait for a known worker PID to exit without exceeding the shutdown policy. */
export async function waitForDaemonExit(
  pid: number,
  options: WaitForDaemonExitOptions = {},
): Promise<boolean> {
  const timeoutMs = options.timeoutMs ?? await daemonRuntimeState.resolveWaitTimeoutMs(pid);
  const pollIntervalMs = options.pollIntervalMs ?? DAEMON_EXIT_POLL_INTERVAL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep
    ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isRunning = options.isRunning ?? isProcessRunning;
  const deadline = now() + timeoutMs;

  while (isRunning(pid)) {
    const remainingMs = deadline - now();
    if (remainingMs <= 0) return false;
    await sleep(Math.min(pollIntervalMs, remainingMs));
  }
  return true;
}

export type DaemonShutdownResult =
  | { status: 'not-running'; pid: number | null }
  | { status: 'stopped'; pid: number | null; timeoutMs?: number; cleanupError?: unknown }
  | { status: 'timed-out'; pid: number; timeoutMs: number };

export interface DaemonShutdownCoordinator {
  stopViaApi(requestShutdown: () => Promise<void>): Promise<DaemonShutdownResult>;
  stopViaSignal(): Promise<DaemonShutdownResult>;
}

interface DaemonShutdownCoordinatorIo {
  runtimeState: Pick<typeof daemonRuntimeState, 'readPid' | 'resolveWaitTimeoutMs' | 'release'>;
  isRunning(pid: number): boolean;
  kill(pid: number, signal: NodeJS.Signals): void;
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
}

const defaultDaemonShutdownCoordinatorIo: DaemonShutdownCoordinatorIo = {
  runtimeState: daemonRuntimeState,
  isRunning: isProcessRunning,
  kill: (pid, signal) => process.kill(pid, signal),
  waitForExit: (pid, timeoutMs) => waitForDaemonExit(pid, { timeoutMs }),
};

/** Build the single lifecycle coordinator; low-level process I/O is injected here once. */
export function createDaemonShutdownCoordinator(
  io: DaemonShutdownCoordinatorIo = defaultDaemonShutdownCoordinatorIo,
): DaemonShutdownCoordinator {
  const complete = async (pid: number | null): Promise<DaemonShutdownResult> => {
    if (pid === null) return { status: 'stopped', pid };
    const timeoutMs = await io.runtimeState.resolveWaitTimeoutMs(pid);
    if (!await io.waitForExit(pid, timeoutMs)) {
      return { status: 'timed-out', pid, timeoutMs };
    }
    try {
      await io.runtimeState.release(pid);
      return { status: 'stopped', pid, timeoutMs };
    } catch (cleanupError) {
      return { status: 'stopped', pid, timeoutMs, cleanupError };
    }
  };

  return {
    async stopViaApi(requestShutdown) {
      const requestedOwnerPid = await io.runtimeState.readPid();
      await requestShutdown();
      // A supervised worker can restart while the HTTP request is in flight.
      // Prefer the owner that exists after the request so success cannot be
      // reported merely because the worker observed before it has exited.
      const activeOwnerPid = await io.runtimeState.readPid();
      return complete(activeOwnerPid ?? requestedOwnerPid);
    },

    async stopViaSignal() {
      const pid = await io.runtimeState.readPid();
      if (pid === null || !io.isRunning(pid)) return { status: 'not-running', pid };
      try {
        io.kill(pid, 'SIGTERM');
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error
          ? (error as NodeJS.ErrnoException).code
          : undefined;
        if (code !== 'ESRCH') throw error;
      }
      return complete(pid);
    },
  };
}

export const daemonShutdownCoordinator = createDaemonShutdownCoordinator();

interface DaemonShutdownReporter {
  log(message: string): void;
  error(message: string): void;
}

/** Keep presentation at the command boundary while the coordinator owns lifecycle I/O. */
export function reportDaemonShutdownResult(
  result: DaemonShutdownResult,
  reporter: DaemonShutdownReporter = console,
): boolean {
  if (result.status === 'not-running') return true;
  if (result.status === 'timed-out') {
    reporter.error(
      `Daemon is still running after the configured shutdown deadline (${result.timeoutMs}ms).`,
    );
    return false;
  }
  if (result.cleanupError !== undefined) {
    reporter.error(
      `Daemon runtime-state cleanup error: ${result.cleanupError instanceof Error
        ? result.cleanupError.message
        : String(result.cleanupError)}`,
    );
  }
  reporter.log('Stopped.');
  return true;
}
