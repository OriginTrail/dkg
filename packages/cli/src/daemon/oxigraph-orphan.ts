/**
 * Stop a managed Oxigraph that an earlier daemon worker left behind.
 *
 * RocksDB lets one process hold `<location>/LOCK`. A worker that dies
 * without cleanup (a SIGKILL from the supervisor's liveness watchdog, an OOM
 * kill) can leave its `oxigraph serve` child running. Every later start then
 * fails with "While lock file: … Resource temporarily unavailable" until
 * someone stops that process by hand. The parent watchdog stops new orphans
 * on Unix within about a second; this covers what it cannot: a respawned
 * worker that starts inside that second, a watchdog killed on its own, and an
 * orphan left by a release that predates the direct-launch watchdog.
 *
 * This module is the reaper: it lists the lock holders, observes each one and
 * its ancestors, asks the pure policy (`oxigraph-reclaim-policy.ts`) whether
 * to stop it, and runs the TERM → KILL escalation. A holder is signalled only
 * while it is still the process instance that was judged (same PID and start
 * time). The LOCK file itself is never modified.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { promisify } from 'node:util';
import { mapWithConcurrency } from '@origintrail-official/dkg-agent/map-with-concurrency';
import {
  identityIsRunning,
  readOxigraphOwnerRecord,
  type ProcessIdentity,
} from './oxigraph-owner-record.js';
import { OXIGRAPH_STOP_GRACE_MS } from './oxigraph-parent-watchdog.js';
import {
  classifyHolder,
  deriveOwnership,
  describeLeave,
  describeStop,
  MAX_LAUNCHER_DEPTH,
  type OxigraphBinaries,
} from './oxigraph-reclaim-policy.js';
import {
  procHasFdTarget,
  procPids,
  processInspector,
  type ProcessInstance,
} from './process-probe.js';

const execFileAsync = promisify(execFile);

export interface OrphanedOxigraphIo {
  /** PIDs that have the lock file open. */
  listLockHolders(lockPath: string): Promise<number[]>;
  /** One observation of a process; null when it has exited. */
  inspectProcess(pid: number): Promise<ProcessInstance | null>;
  /** Whether `identity` still names a running process (same PID and start time). */
  isSameInstance(identity: ProcessIdentity): Promise<boolean>;
  signal(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface StopOrphanedOxigraphOptions {
  binaryPath: string;
  location: string;
  /**
   * Directories whose `oxigraph*` executables are this node's too, for an
   * orphan from before the owner record: the managed binary cache and the
   * directory of the `oxigraph` on PATH.
   */
  knownBinaryDirs?: readonly string[];
  log: (message: string) => void;
  /** SIGTERM → SIGKILL escalation; defaults to the shared Oxigraph stop grace. */
  stopGraceMs?: number;
  /** Upper bound on waiting for signalled orphans to release the lock. */
  timeoutMs?: number;
  pollIntervalMs?: number;
  io?: Partial<OrphanedOxigraphIo>;
}

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_POLL_INTERVAL_MS = 100;
// Processes whose descriptors are read at once during a `/proc` scan.
const PROC_SCAN_CONCURRENCY = 16;

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
  const pids = (await procPids()).filter((pid) => pid !== process.pid);
  const holds = await mapWithConcurrency(
    pids,
    PROC_SCAN_CONCURRENCY,
    (pid: number) => procHasFdTarget(pid, (fdTarget) => fdTarget === target),
  );
  return pids.filter((_, index) => holds[index]);
}

const defaultIo: OrphanedOxigraphIo = {
  listLockHolders: process.platform === 'linux' ? procLockHolders : lsofLockHolders,
  inspectProcess: processInspector(process.platform),
  isSameInstance: identityIsRunning,
  signal: (pid, signal) => { process.kill(pid, signal); },
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now: () => Date.now(),
};

/** The holder's ancestors, nearest first, as the policy expects them. */
async function observeAncestors(io: OrphanedOxigraphIo, holder: ProcessInstance): Promise<ProcessInstance[]> {
  const ancestors: ProcessInstance[] = [];
  let ppid = holder.ppid;
  while (ancestors.length < MAX_LAUNCHER_DEPTH && ppid > 1) {
    const parent = await io.inspectProcess(ppid);
    if (!parent) break;
    ancestors.push(parent);
    ppid = parent.ppid;
  }
  return ancestors;
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
  const stopGraceMs = opts.stopGraceMs ?? OXIGRAPH_STOP_GRACE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = io.now() + timeoutMs;
  const recordRead = await readOxigraphOwnerRecord(opts.location);
  if (recordRead.kind === 'invalid') {
    opts.log(`[oxigraph] ignoring an unreadable owner record for ${lockPath}.`);
  }
  const record = recordRead.kind === 'v1' ? recordRead.record : null;
  const binaryPaths = [opts.binaryPath, ...(record ? [record.binaryPath] : [])];
  const binaries: OxigraphBinaries = {
    paths: binaryPaths,
    dirs: [...binaryPaths.map((path) => dirname(path)), ...(opts.knownBinaryDirs ?? [])],
  };
  const ownership = deriveOwnership(recordRead, {
    daemon: record !== null && await io.isSameInstance(record.daemon),
    launcher: record !== null && await io.isSameInstance(record.launcher),
  });
  // Keyed by PID and start time, so a recycled PID is judged afresh.
  const signalled = new Map<string, { pid: number; termAt: number; killed: boolean }>();
  // Holders already reported as left running, or that refused a signal.
  const leftRunning = new Set<string>();

  for (;;) {
    const orphans: number[] = [];
    let holders: number[] = [];
    try {
      holders = await io.listLockHolders(lockPath);
    } catch {
      // Unreadable holder list: leave the outcome to the spawn.
    }
    for (const pid of holders) {
      if (pid === process.pid) continue;
      const holder = await io.inspectProcess(pid);
      if (!holder) continue;
      const instance = `${pid}:${holder.start}`;
      if (leftRunning.has(instance)) continue;
      const state = signalled.get(instance);
      if (!state) {
        const decision = classifyHolder(
          { holder, ancestors: await observeAncestors(io, holder) },
          { location: opts.location, ownership, binaries },
        );
        if (decision.action === 'leave') {
          leftRunning.add(instance);
          opts.log(
            `[oxigraph] ${lockPath} is held by pid ${pid} (parent ${holder.ppid}): ` +
              `${holder.command.slice(0, 300)}. Leaving it running: ${describeLeave(decision.reason)}.`,
          );
          continue;
        }
        opts.log(
          `[oxigraph] stopping orphaned Oxigraph pid ${pid} (${describeStop(decision.reason)}); ` +
            `it still holds ${lockPath}.`,
        );
      }
      // Signal only the instance that was judged: a PID recycled since then
      // has another start time.
      if (!(await io.isSameInstance(holder))) continue;
      try {
        if (!state) {
          io.signal(pid, 'SIGTERM');
          signalled.set(instance, { pid, termAt: io.now(), killed: false });
        } else if (!state.killed && io.now() - state.termAt >= stopGraceMs) {
          opts.log(`[oxigraph] orphaned Oxigraph pid ${pid} did not exit on SIGTERM; sending SIGKILL.`);
          io.signal(pid, 'SIGKILL');
          state.killed = true;
        }
        orphans.push(pid);
      } catch (error) {
        leftRunning.add(instance);
        opts.log(
          `[oxigraph] could not signal orphaned Oxigraph pid ${pid}: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const signalledPids = [...new Set([...signalled.values()].map((entry) => entry.pid))];
    if (orphans.length === 0) {
      if (signalled.size > 0) opts.log(`[oxigraph] ${lockPath} released by the orphaned Oxigraph.`);
      return signalledPids;
    }
    if (io.now() >= deadline) {
      opts.log(
        `[oxigraph] orphaned Oxigraph pid ${orphans.join(', ')} still holds ${lockPath} ` +
          `after ${timeoutMs}ms; starting anyway.`,
      );
      return signalledPids;
    }
    await io.sleep(pollIntervalMs);
  }
}
