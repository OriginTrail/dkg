import { readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dkgDir, ensureDkgDir, isProcessRunning } from '../config.js';
import { SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS } from './shutdown.js';
import {
  MAX_SHUTDOWN_HARD_TIMEOUT_MS,
  resolveShutdownPolicy,
  type ShutdownPolicy,
} from './shutdown-policy.js';

export const DAEMON_EXIT_POLL_INTERVAL_MS = 500;
const DAEMON_SHUTDOWN_POLICY_STATE_FILE = 'shutdown-policy.json';

function daemonShutdownPolicyStatePath(): string {
  return join(dkgDir(), DAEMON_SHUTDOWN_POLICY_STATE_FILE);
}

/** Capture the worker's startup-validated policy for later CLI processes. */
export async function persistDaemonShutdownPolicy(policy: ShutdownPolicy): Promise<void> {
  const validated = resolveShutdownPolicy(String(policy.hardTimeoutMs));
  await ensureDkgDir();
  await writeFile(daemonShutdownPolicyStatePath(), JSON.stringify({
    version: 1,
    pid: process.pid,
    ...validated,
  }), 'utf8');
}

/** Read only state written from a validated worker policy. */
export async function readPersistedDaemonShutdownPolicy(
  expectedPid: number,
): Promise<ShutdownPolicy | null> {
  try {
    const parsed = JSON.parse(await readFile(daemonShutdownPolicyStatePath(), 'utf8')) as {
      version?: unknown;
      pid?: unknown;
      hardTimeoutMs?: unknown;
    };
    if (
      parsed.version !== 1
      || !Number.isSafeInteger(parsed.pid)
      || parsed.pid !== expectedPid
      || !Number.isSafeInteger(parsed.hardTimeoutMs)
    ) return null;
    return resolveShutdownPolicy(String(parsed.hardTimeoutMs));
  } catch {
    return null;
  }
}

/** Remove only the policy owned by the worker being retired. */
export async function removePersistedDaemonShutdownPolicy(expectedPid: number): Promise<void> {
  try {
    const parsed = JSON.parse(await readFile(daemonShutdownPolicyStatePath(), 'utf8')) as {
      version?: unknown;
      pid?: unknown;
    };
    if (parsed.version !== 1 || parsed.pid !== expectedPid) return;
    await unlink(daemonShutdownPolicyStatePath());
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error
      ? (error as NodeJS.ErrnoException).code
      : undefined;
    if (code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
  }
}

/**
 * The worker may use its entire graceful-shutdown budget and then the bounded
 * forced-cleanup hook before exiting. Lifecycle commands must allow both.
 */
export async function resolveDaemonShutdownWaitTimeoutMs(expectedPid: number): Promise<number> {
  const persisted = await readPersistedDaemonShutdownPolicy(expectedPid);
  return (persisted?.hardTimeoutMs ?? MAX_SHUTDOWN_HARD_TIMEOUT_MS)
    + SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS;
}

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
  const timeoutMs = options.timeoutMs ?? await resolveDaemonShutdownWaitTimeoutMs(pid);
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

export interface CompleteDaemonShutdownDependencies {
  resolveWaitTimeoutMs(pid: number): Promise<number>;
  waitForExit(pid: number, timeoutMs: number): Promise<boolean>;
  removePersistedPolicy(pid: number): Promise<void>;
  log(message: string): void;
  error(message: string): void;
}

const defaultCompleteDaemonShutdownDependencies: CompleteDaemonShutdownDependencies = {
  resolveWaitTimeoutMs: resolveDaemonShutdownWaitTimeoutMs,
  waitForExit: (pid, timeoutMs) => waitForDaemonExit(pid, { timeoutMs }),
  removePersistedPolicy: removePersistedDaemonShutdownPolicy,
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

/** Canonical post-trigger wait and reporting path for every daemon stop command. */
export async function completeDaemonShutdown(
  pid: number | null,
  dependencies: CompleteDaemonShutdownDependencies = defaultCompleteDaemonShutdownDependencies,
): Promise<boolean> {
  if (pid === null) {
    dependencies.log('Stopped.');
    return true;
  }
  const timeoutMs = await dependencies.resolveWaitTimeoutMs(pid);
  if (await dependencies.waitForExit(pid, timeoutMs)) {
    await dependencies.removePersistedPolicy(pid).catch((error) => {
      dependencies.error(
        `Shutdown policy cleanup error: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    dependencies.log('Stopped.');
    return true;
  }
  dependencies.error(
    `Daemon is still running after the configured shutdown deadline (${timeoutMs}ms).`,
  );
  return false;
}
