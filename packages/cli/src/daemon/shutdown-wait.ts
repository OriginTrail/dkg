import { isProcessRunning } from '../config.js';
import { SHUTDOWN_FORCED_CLEANUP_TIMEOUT_MS } from './shutdown.js';
import { resolveShutdownPolicy } from './shutdown-policy.js';

export const DAEMON_EXIT_POLL_INTERVAL_MS = 500;

/**
 * The worker may use its entire graceful-shutdown budget and then the bounded
 * forced-cleanup hook before exiting. Lifecycle commands must allow both.
 */
export function resolveDaemonShutdownWaitTimeoutMs(
  hardTimeoutValue: string | undefined = process.env.DKG_SHUTDOWN_HARD_TIMEOUT_MS,
): number {
  return resolveShutdownPolicy(hardTimeoutValue).hardTimeoutMs
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
  const timeoutMs = options.timeoutMs ?? resolveDaemonShutdownWaitTimeoutMs();
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
