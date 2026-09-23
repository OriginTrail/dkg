/**
 * Stop a managed Oxigraph that an earlier daemon worker left behind.
 *
 * RocksDB lets one process hold `<location>/LOCK`. A worker that dies
 * without cleanup (a SIGKILL from the supervisor's liveness watchdog, an OOM
 * kill) can leave its `oxigraph serve` child running. Every later start then
 * fails with "While lock file: … Resource temporarily unavailable" until
 * someone stops that process by hand. The parent watchdog stops new orphans
 * on Unix within about a second; this covers what it cannot: a respawned
 * worker that starts inside that second, a watchdog killed together with its
 * worker on a host without a parent-death signal, and an orphan left by a
 * release that predates the direct-launch watchdog.
 *
 * Before each spawn the daemon terminates a lock holder only when all of
 * these hold:
 *   - the process has `<location>/LOCK` open;
 *   - it runs this node's Oxigraph as `serve --location <location>`: the
 *     current binary, or another `oxigraph*` executable beside it, which is
 *     where the binary pinned by an earlier release lives;
 *   - no live daemon owns it: it was reparented to PID 1, or its parent is a
 *     watchdog of this store whose daemon has exited.
 * Any other holder is reported, with its parent, and left running. The LOCK
 * file itself is never modified.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { OXIGRAPH_WATCHDOG_DIRECT_FLAG } from './oxigraph-parent-watchdog.js';
import {
  procFdTargets,
  procPids,
  processDescriber,
  type ProcessDescription,
} from './process-probe.js';

const execFileAsync = promisify(execFile);

export interface OrphanedOxigraphIo {
  /** PIDs that have the lock file open. */
  listLockHolders(lockPath: string): Promise<number[]>;
  /** Null when the process has exited. */
  describeProcess(pid: number): Promise<ProcessDescription | null>;
  isProcessAlive(pid: number): boolean;
  signal(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface StopOrphanedOxigraphOptions {
  binaryPath: string;
  location: string;
  log: (message: string) => void;
  /** SIGTERM → SIGKILL escalation, matching the managed server's own stop grace. */
  stopGraceMs?: number;
  /** Upper bound on waiting for signalled orphans to release the lock. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  io?: Partial<OrphanedOxigraphIo>;
}

const DEFAULT_STOP_GRACE_MS = 5_000;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 100;

function parsePids(stdout: string): number[] {
  return stdout
    .split('\n')
    .map((line) => Number(line.trim()))
    .filter((pid) => Number.isInteger(pid) && pid > 0);
}

export async function lsofLockHolders(lockPath: string): Promise<number[]> {
  try {
    const { stdout } = await execFileAsync('lsof', ['-t', '-w', lockPath], { timeout: 5_000 });
    return parsePids(stdout);
  } catch (error) {
    // lsof exits 1 when no process has the file open.
    return parsePids(String((error as { stdout?: unknown }).stdout ?? ''));
  }
}

/** Linux: match open descriptors directly; `lsof` is often missing there. */
export async function procLockHolders(lockPath: string): Promise<number[]> {
  const target = await realpath(lockPath);
  const holders: number[] = [];
  for (const pid of await procPids()) {
    if (pid === process.pid) continue;
    if ((await procFdTargets(pid)).includes(target)) holders.push(pid);
  }
  return holders;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

const defaultIo: OrphanedOxigraphIo = {
  listLockHolders: process.platform === 'linux' ? procLockHolders : lsofLockHolders,
  describeProcess: processDescriber(process.platform),
  isProcessAlive: processIsAlive,
  signal: (pid, signal) => { process.kill(pid, signal); },
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now: () => Date.now(),
};

/**
 * Whether a command line runs this node's Oxigraph as
 * `serve --location <location>`: `binaryPath` itself, or another `oxigraph*`
 * executable in its directory. A binary started through an interpreter (`#!`)
 * lists the interpreter first.
 */
export function runsManagedOxigraphStore(
  command: string,
  binaryPath: string,
  location: string,
): boolean {
  const padded = ` ${command} `;
  const serveAt = padded.indexOf(` serve --location ${location} `);
  if (serveAt < 0) return false;
  const launched = padded.slice(0, serveAt);
  if (launched.endsWith(` ${binaryPath}`)) return true;
  const binaryDir = ` ${dirname(binaryPath)}/`;
  const dirAt = launched.lastIndexOf(binaryDir);
  return dirAt >= 0 && /^oxigraph[^/\s]*$/.test(launched.slice(dirAt + binaryDir.length));
}

const WATCHDOG_DAEMON_PID = new RegExp(
  `oxigraph-parent-watchdog\\.[cm]?[jt]s (?:${OXIGRAPH_WATCHDOG_DIRECT_FLAG} )?(\\d+) `,
);

/** The daemon PID that a parent watchdog of this store watches; null for any other command. */
export function watchedDaemonPid(
  command: string,
  binaryPath: string,
  location: string,
): number | null {
  if (!runsManagedOxigraphStore(command, binaryPath, location)) return null;
  const match = WATCHDOG_DAEMON_PID.exec(command);
  return match ? Number(match[1]) : null;
}

/**
 * Terminate orphaned Oxigraph processes that hold this store's lock and wait
 * until they release it. Returns the PIDs that were signalled. Never throws;
 * when a holder cannot be stopped, the next spawn fails with Oxigraph's own
 * lock error, preceded by a log line naming the holder and its parent.
 */
export async function stopOrphanedOxigraph(opts: StopOrphanedOxigraphOptions): Promise<number[]> {
  // Windows processes are not reparented, so an orphan cannot be told apart.
  if (process.platform === 'win32') return [];
  const lockPath = resolve(opts.location, 'LOCK');
  if (!existsSync(lockPath)) return [];
  const io: OrphanedOxigraphIo = { ...defaultIo, ...opts.io };
  const stopGraceMs = opts.stopGraceMs ?? DEFAULT_STOP_GRACE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = io.now() + timeoutMs;
  const signalled = new Map<number, { termAt: number; killed: boolean }>();
  // Holders already reported as left running, or that refused a signal.
  const leftRunning = new Set<number>();

  // Why a holder of this store must stay, or null when no live daemon owns it.
  const liveOwner = async (holder: ProcessDescription): Promise<string | null> => {
    if (holder.ppid === 1) return null;
    const parent = await io.describeProcess(holder.ppid);
    if (!parent) return null;
    const daemonPid = watchedDaemonPid(parent.command, opts.binaryPath, opts.location);
    if (daemonPid === null) {
      return `its parent pid ${holder.ppid} is still running: ${parent.command.slice(0, 200)}`;
    }
    // The watchdog of an exited daemon is about to stop it; do it now, so a
    // worker respawned within that second does not fail on the lock.
    return io.isProcessAlive(daemonPid)
      ? `its watchdog pid ${holder.ppid} still serves live daemon pid ${daemonPid}`
      : null;
  };

  for (;;) {
    const orphans: number[] = [];
    let holders: number[] = [];
    try {
      holders = await io.listLockHolders(lockPath);
    } catch {
      // Unreadable holder list: leave the outcome to the spawn.
    }
    for (const pid of holders) {
      if (pid === process.pid || leftRunning.has(pid)) continue;
      const holder = await io.describeProcess(pid);
      if (!holder) continue;
      const reason = runsManagedOxigraphStore(holder.command, opts.binaryPath, opts.location)
        ? (signalled.has(pid) ? null : await liveOwner(holder))
        : `it is not this node's Oxigraph serving this store`;
      if (reason !== null) {
        leftRunning.add(pid);
        opts.log(
          `[oxigraph] ${lockPath} is held by pid ${pid} (parent ${holder.ppid}): ` +
            `${holder.command.slice(0, 300)}. Leaving it running: ${reason}.`,
        );
        continue;
      }
      const state = signalled.get(pid);
      try {
        if (!state) {
          opts.log(
            `[oxigraph] stopping orphaned Oxigraph pid ${pid}: its daemon exited without ` +
              `stopping it, and it still holds ${lockPath}.`,
          );
          io.signal(pid, 'SIGTERM');
          signalled.set(pid, { termAt: io.now(), killed: false });
        } else if (!state.killed && io.now() - state.termAt >= stopGraceMs) {
          opts.log(`[oxigraph] orphaned Oxigraph pid ${pid} did not exit on SIGTERM; sending SIGKILL.`);
          io.signal(pid, 'SIGKILL');
          state.killed = true;
        }
        orphans.push(pid);
      } catch (error) {
        leftRunning.add(pid);
        opts.log(
          `[oxigraph] could not signal orphaned Oxigraph pid ${pid}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    if (orphans.length === 0) {
      if (signalled.size > 0) opts.log(`[oxigraph] ${lockPath} released by the orphaned Oxigraph.`);
      return [...signalled.keys()];
    }
    if (io.now() >= deadline) {
      opts.log(
        `[oxigraph] orphaned Oxigraph pid ${orphans.join(', ')} still holds ${lockPath} ` +
          `after ${timeoutMs}ms; starting anyway.`,
      );
      return [...signalled.keys()];
    }
    await io.sleep(pollIntervalMs);
  }
}
