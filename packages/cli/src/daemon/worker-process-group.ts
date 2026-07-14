import { createConnection } from 'node:net';

export const WORKER_GROUP_TERM_GRACE_MS = 5_000;
export const WORKER_GROUP_KILL_GRACE_MS = 2_000;
export const WORKER_GROUP_POLL_INTERVAL_MS = 50;
export const MANAGED_STORE_PORT_RELEASE_TIMEOUT_MS = 8_000;

export interface WorkerProcessGroupCleanupOptions {
  platform?: NodeJS.Platform;
  termGraceMs?: number;
  killGraceMs?: number;
  pollIntervalMs?: number;
  kill?: typeof process.kill;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface WorkerProcessGroupCleanupResult {
  applicable: boolean;
  termSent: boolean;
  killSent: boolean;
  empty: boolean;
}

function isMissingProcessError(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === 'ESRCH';
}

function processGroupExists(
  processGroupId: number,
  kill: typeof process.kill,
): boolean {
  try {
    kill(-processGroupId, 0);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) return false;
    // EPERM still proves that the process group exists. Any other error is
    // treated the same way so cleanup fails closed instead of respawning a
    // worker while ownership is uncertain.
    return true;
  }
}

function signalProcessGroup(
  processGroupId: number,
  signal: NodeJS.Signals,
  kill: typeof process.kill,
): boolean {
  try {
    kill(-processGroupId, signal);
    return true;
  } catch (error) {
    if (isMissingProcessError(error)) return false;
    throw error;
  }
}

/**
 * Deliver a signal to a worker-owned POSIX process group.
 *
 * Returns false when the caller must fall back to signalling the child handle
 * directly: Windows has no process groups, the PGID is unusable, or the group
 * has already exited. Best-effort by design -- the post-exit reap barrier, not
 * this call, is what actually guarantees the group is empty.
 */
export function signalWorkerProcessGroup(
  processGroupId: number | undefined,
  signal: NodeJS.Signals,
  opts: { platform?: NodeJS.Platform; kill?: typeof process.kill } = {},
): boolean {
  const platform = opts.platform ?? process.platform;
  if (
    platform === 'win32' ||
    !Number.isInteger(processGroupId) ||
    (processGroupId ?? 0) <= 1
  ) {
    return false;
  }
  const kill = opts.kill ?? process.kill.bind(process);
  try {
    return signalProcessGroup(processGroupId!, signal, kill);
  } catch {
    return false;
  }
}

async function waitForProcessGroupExit(
  processGroupId: number,
  timeoutMs: number,
  pollIntervalMs: number,
  kill: typeof process.kill,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = now() + Math.max(0, timeoutMs);
  while (processGroupExists(processGroupId, kill)) {
    if (now() >= deadline) return false;
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }
  return true;
}

/**
 * Reap every process left in a worker-owned POSIX process group.
 *
 * Workers are spawned as private session/process-group leaders, so their PID
 * is also the exact PGID. The supervisor calls this only after the worker exit
 * event: ordinary descendants get a bounded SIGTERM window, stubborn
 * survivors get SIGKILL, and a replacement is allowed only after the group is
 * confirmed empty.
 */
export async function reapWorkerProcessGroup(
  processGroupId: number | undefined,
  opts: WorkerProcessGroupCleanupOptions = {},
): Promise<WorkerProcessGroupCleanupResult> {
  const platform = opts.platform ?? process.platform;
  if (
    platform === 'win32' ||
    !Number.isInteger(processGroupId) ||
    (processGroupId ?? 0) <= 1
  ) {
    return {
      applicable: false,
      termSent: false,
      killSent: false,
      empty: true,
    };
  }

  const pgid = processGroupId!;
  const kill = opts.kill ?? process.kill.bind(process);
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollIntervalMs = opts.pollIntervalMs ?? WORKER_GROUP_POLL_INTERVAL_MS;

  if (!processGroupExists(pgid, kill)) {
    return {
      applicable: true,
      termSent: false,
      killSent: false,
      empty: true,
    };
  }

  const termSent = signalProcessGroup(pgid, 'SIGTERM', kill);
  if (await waitForProcessGroupExit(
    pgid,
    opts.termGraceMs ?? WORKER_GROUP_TERM_GRACE_MS,
    pollIntervalMs,
    kill,
    now,
    sleep,
  )) {
    return {
      applicable: true,
      termSent,
      killSent: false,
      empty: true,
    };
  }

  const killSent = signalProcessGroup(pgid, 'SIGKILL', kill);
  const empty = await waitForProcessGroupExit(
    pgid,
    opts.killGraceMs ?? WORKER_GROUP_KILL_GRACE_MS,
    pollIntervalMs,
    kill,
    now,
    sleep,
  );
  return {
    applicable: true,
    termSent,
    killSent,
    empty,
  };
}

async function tcpPortAcceptsConnections(
  host: string,
  port: number,
  connectTimeoutMs: number,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const socket = createConnection({ host, port });
    const finish = (listening: boolean) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(listening);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    // A timeout is uncertainty, not proof of release. Fail closed and keep
    // waiting; only an explicit connect error (normally ECONNREFUSED on
    // loopback) proves there is no listener.
    socket.setTimeout(connectTimeoutMs, () => finish(true));
  });
}

/** Confirm that a managed-store listener is gone before spawning a worker. */
export async function waitForTcpPortRelease(
  host: string,
  port: number,
  opts: {
    timeoutMs?: number;
    pollIntervalMs?: number;
    connectTimeoutMs?: number;
    now?: () => number;
    sleep?: (ms: number) => Promise<void>;
    isListening?: (host: string, port: number, timeoutMs: number) => Promise<boolean>;
  } = {},
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const isListening = opts.isListening ?? tcpPortAcceptsConnections;
  const timeoutMs = opts.timeoutMs ?? MANAGED_STORE_PORT_RELEASE_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? WORKER_GROUP_POLL_INTERVAL_MS;
  const connectTimeoutMs = opts.connectTimeoutMs ?? 250;
  const deadline = now() + Math.max(0, timeoutMs);

  while (await isListening(host, port, connectTimeoutMs)) {
    if (now() >= deadline) return false;
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - now())));
  }
  return true;
}
