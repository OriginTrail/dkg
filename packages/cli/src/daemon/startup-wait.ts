import type { ChildProcess } from 'node:child_process';
import { readApiPort, readPid, isProcessRunning } from '../config.js';
import { probeWorkerLiveness } from './liveness-probe.js';

export const DEFAULT_STARTUP_TIMEOUT_MS = 120_000;
const POLL_MS = 500;
const PROBE_TIMEOUT_MS = 2_000;

export type DaemonStartupResult =
  | { status: 'ready'; pid: number; port: number }
  | { status: 'starting'; pid: number | null; timeoutMs: number }
  | { status: 'failed'; reason: string };

interface StartupDependencies {
  readPid(): Promise<number | null>;
  readPort(): Promise<number | null>;
  isRunning(pid: number): boolean;
  probe(port: number, host: string, timeoutMs: number): Promise<boolean>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const defaults: StartupDependencies = {
  readPid,
  readPort: readApiPort,
  isRunning: isProcessRunning,
  probe: async (port, host, timeoutMs) => {
    const result = await probeWorkerLiveness(port, host, timeoutMs, undefined, '/api/status');
    return result.outcome === 'http_response' && result.statusCode === 200;
  },
  now: () => performance.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** A PID or an early startup status listener alone is not API readiness. */
export async function waitForDaemonReady(
  supervisor: ChildProcess,
  host: string,
  timeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
  dependencies: Partial<StartupDependencies> = {},
): Promise<DaemonStartupResult> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) {
    throw new Error('--timeout must be an integer between 1 and 2147483647 milliseconds');
  }
  const io = { ...defaults, ...dependencies };
  const deadline = io.now() + timeoutMs;
  let spawnError: Error | undefined;
  const onError = (error: Error) => { spawnError = error; };
  supervisor.on('error', onError);
  let workerPid: number | null = null;
  const failure = (): string | undefined => {
    if (spawnError) return `Could not start daemon supervisor: ${spawnError.message}`;
    if (supervisor.exitCode !== null || supervisor.signalCode !== null
      || (supervisor.pid !== undefined && !io.isRunning(supervisor.pid))) {
      return `Daemon supervisor exited before API readiness (code=${supervisor.exitCode}, signal=${supervisor.signalCode})`;
    }
    return undefined;
  };
  try {
    while (io.now() < deadline) {
      const failed = failure();
      if (failed) return { status: 'failed', reason: failed };
      workerPid = await io.readPid();
      if (workerPid && io.isRunning(workerPid)) {
        const port = await io.readPort();
        const remaining = deadline - io.now();
        if (port !== null && Number.isInteger(port) && port > 0 && port <= 65535 && remaining > 0
          && await io.probe(port, host, Math.min(PROBE_TIMEOUT_MS, remaining))) {
          // A supervisor restart can replace the worker while the probe is in flight.
          if (!failure() && io.isRunning(workerPid) && await io.readPid() === workerPid) {
            return { status: 'ready', pid: workerPid, port };
          }
        }
      }
      const remaining = deadline - io.now();
      if (remaining > 0) await io.sleep(Math.min(POLL_MS, remaining));
    }
    const failed = failure();
    if (failed) return { status: 'failed', reason: failed };
    return { status: 'starting', pid: workerPid && io.isRunning(workerPid) ? workerPid : supervisor.pid ?? null, timeoutMs };
  } finally {
    supervisor.removeListener('error', onError);
  }
}

export function describeDaemonStartupFailure(result: Exclude<DaemonStartupResult, { status: 'ready' }>): string {
  return result.status === 'failed' ? result.reason
    : `Daemon is still starting after ${result.timeoutMs / 1000}s${result.pid ? ` (PID ${result.pid})` : ''}; API readiness was not confirmed. Run "dkg status" or retry with a longer "dkg start --timeout <ms>" after stopping the node.`;
}
