/**
 * Stop a managed Oxigraph that an earlier daemon worker left behind.
 *
 * RocksDB lets one process hold `<location>/LOCK`. A worker that dies
 * without cleanup (a SIGKILL from the supervisor's liveness watchdog, an OOM
 * kill) can leave its `oxigraph serve` child running, reparented to init.
 * Every later start then fails with "While lock file: … Resource temporarily
 * unavailable" until someone stops that process by hand. The parent watchdog
 * prevents new orphans on Unix; this covers the ones it cannot: a watchdog
 * killed together with its worker on a host without a parent-death signal,
 * or an orphan left by a release that predates the direct-launch watchdog.
 *
 * Before each spawn the daemon terminates a lock holder only when all of
 * these hold:
 *   - the process has `<location>/LOCK` open;
 *   - its command line runs this daemon's Oxigraph binary as
 *     `serve --location <location>`;
 *   - its parent is gone: it was reparented to PID 1, so no live daemon owns it.
 * Any other holder is reported and left running. The LOCK file itself is
 * never modified.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readdir, readFile, readlink, realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface OxigraphLockHolder {
  ppid: number;
  /** argv joined by single spaces. */
  command: string;
}

export interface OrphanedOxigraphIo {
  /** PIDs that have the lock file open. */
  listLockHolders(lockPath: string): Promise<number[]>;
  /** Null when the process has exited. */
  describeProcess(pid: number): Promise<OxigraphLockHolder | null>;
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
  for (const entry of await readdir('/proc')) {
    const pid = Number(entry);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    let fds: string[];
    try {
      fds = await readdir(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      if (await readlink(`/proc/${entry}/fd/${fd}`).catch(() => null) === target) {
        holders.push(pid);
        break;
      }
    }
  }
  return holders;
}

export async function psDescribeProcess(pid: number): Promise<OxigraphLockHolder | null> {
  try {
    const { stdout } = await execFileAsync(
      'ps',
      ['-ww', '-o', 'ppid=,command=', '-p', String(pid)],
      { timeout: 2_000 },
    );
    const match = /^\s*(\d+)\s+(.*)$/s.exec(stdout.trimEnd());
    return match ? { ppid: Number(match[1]), command: match[2] } : null;
  } catch {
    return null;
  }
}

export async function procDescribeProcess(pid: number): Promise<OxigraphLockHolder | null> {
  try {
    // `pid (comm) state ppid …`; comm may itself contain spaces and parens.
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
    const argv = (await readFile(`/proc/${pid}/cmdline`, 'utf8')).split('\0');
    if (argv.at(-1) === '') argv.pop();
    return Number.isInteger(ppid) ? { ppid, command: argv.join(' ') } : null;
  } catch {
    return null;
  }
}

// The per-platform probes above are exported so tests can run each one on
// every host that has its tool, not only the host that uses it by default.
const defaultIo: OrphanedOxigraphIo = {
  listLockHolders: process.platform === 'linux' ? procLockHolders : lsofLockHolders,
  describeProcess: process.platform === 'linux' ? procDescribeProcess : psDescribeProcess,
  signal: (pid, signal) => { process.kill(pid, signal); },
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now: () => Date.now(),
};

/**
 * Whether a command line runs `binaryPath serve --location <location>`. A
 * binary started through an interpreter (`#!`) lists the interpreter first.
 */
export function runsManagedOxigraphStore(
  command: string,
  binaryPath: string,
  location: string,
): boolean {
  return ` ${command} `.includes(` ${binaryPath} serve --location ${location} `);
}

/**
 * Terminate orphaned Oxigraph processes that hold this store's lock and wait
 * until they release it. Returns the PIDs that were signalled. Never throws;
 * when a holder cannot be stopped, the next spawn fails with Oxigraph's own
 * lock error, preceded by a log line naming the holder.
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
      const ours = runsManagedOxigraphStore(holder.command, opts.binaryPath, opts.location);
      if (!ours || holder.ppid !== 1) {
        leftRunning.add(pid);
        opts.log(
          `[oxigraph] ${lockPath} is held by pid ${pid} (parent ${holder.ppid}): ` +
            `${holder.command.slice(0, 300)}. Leaving it running: ` +
            (ours
              ? 'its parent process is still running.'
              : `it is not ${opts.binaryPath} serving this store.`),
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
