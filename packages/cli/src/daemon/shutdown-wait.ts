import { readFile, writeFile } from 'node:fs/promises';
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
  expectedPid?: number,
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
      || (expectedPid !== undefined && parsed.pid !== expectedPid)
      || !Number.isSafeInteger(parsed.hardTimeoutMs)
    ) return null;
    return resolveShutdownPolicy(String(parsed.hardTimeoutMs));
  } catch {
    return null;
  }
}

/**
 * The worker may use its entire graceful-shutdown budget and then the bounded
 * forced-cleanup hook before exiting. Lifecycle commands must allow both.
 */
export async function resolveDaemonShutdownWaitTimeoutMs(expectedPid?: number): Promise<number> {
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
