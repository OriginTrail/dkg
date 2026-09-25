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
 * time). A process that cannot be read is never taken to have exited: the
 * holder concerned is left running. The LOCK file itself is never modified.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  oxigraphBinaryCatalog,
  withOxigraphBinary,
  type OxigraphBinaryCatalog,
} from './oxigraph-binary.js';
import {
  checkIdentity,
  readOxigraphOwnerRecord,
  type IdentityState,
  type OxigraphOwnerRecordRead,
  type ProcessIdentity,
} from './oxigraph-owner-record.js';
import { OXIGRAPH_STOP_GRACE_MS } from './oxigraph-parent-watchdog.js';
import {
  classifyHolder,
  deriveOwnership,
  describeLeave,
  describeStop,
  MAX_LAUNCHER_DEPTH,
  type HolderObservation,
} from './oxigraph-reclaim-policy.js';
import {
  procPidsWithFdTarget,
  processInspector,
  type ProcessInstance,
  type ProcessLookup,
} from './process-probe.js';

const execFileAsync = promisify(execFile);

/**
 * Everything the reclaim observes or does on this host; `reclaimHost` builds
 * it for a platform, and tests replace any part.
 */
export interface OrphanedOxigraphIo {
  /** Windows processes are not reparented, so nothing is reclaimed there. */
  platform: NodeJS.Platform;
  lockExists(lockPath: string): Promise<boolean>;
  /** PIDs that have the lock file open. */
  listLockHolders(lockPath: string): Promise<number[]>;
  readOwnerRecord(location: string): Promise<OxigraphOwnerRecordRead>;
  /** One observation of a process: running, confirmed gone, or unreadable. */
  inspectProcess(pid: number): Promise<ProcessLookup>;
  /** Whether `identity` still names a running process (same PID and start time). */
  checkIdentity(identity: ProcessIdentity): Promise<IdentityState>;
  signal(pid: number, signal: NodeJS.Signals): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}

export interface StopOrphanedOxigraphOptions {
  binaryPath: string;
  location: string;
  /**
   * The binaries that count as this node's Oxigraph, from
   * `resolveOxigraphBinary`; defaults to `binaryPath` and its directory. The
   * recorded binary is added from the owner record.
   */
  binaries?: OxigraphBinaryCatalog;
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
  return (await procPidsWithFdTarget((fdTarget) => fdTarget === target))
    .filter((pid) => pid !== process.pid);
}

/** The reclaim's view of a host: its lock, owner record and process probes. */
export function reclaimHost(platform: NodeJS.Platform): OrphanedOxigraphIo {
  const inspectProcess = processInspector(platform);
  return {
    platform,
    lockExists: async (lockPath) => existsSync(lockPath),
    listLockHolders: platform === 'linux' ? procLockHolders : lsofLockHolders,
    readOwnerRecord: readOxigraphOwnerRecord,
    inspectProcess,
    checkIdentity: (identity) => checkIdentity(identity, inspectProcess),
    signal: (pid, signal) => { process.kill(pid, signal); },
    sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
    now: () => Date.now(),
  };
}

/**
 * What the reaper has done about the process instance holding the lock under
 * one PID. `start` names the instance: a holder with another start time under
 * the same PID is a recycled PID and is judged afresh.
 */
type Attempt =
  /** Judged and left running, or its signal was refused; `start` null: it could not be inspected. */
  | { kind: 'left'; start: string | null }
  /** SIGTERM sent at `termAt`; SIGKILL follows once the stop grace has passed. */
  | { kind: 'term-sent'; start: string; termAt: number }
  | { kind: 'kill-sent'; start: string };

/** The holder and its ancestors, nearest first, as the policy expects them. */
async function observeHolder(io: OrphanedOxigraphIo, holder: ProcessInstance): Promise<HolderObservation> {
  const ancestors: ProcessInstance[] = [];
  let ppid = holder.ppid;
  while (ancestors.length < MAX_LAUNCHER_DEPTH && ppid > 1) {
    const parent = await io.inspectProcess(ppid);
    if (parent.state !== 'running') return { holder, ancestors, ancestryEnd: parent };
    ancestors.push(parent.process);
    ppid = parent.process.ppid;
  }
  return { holder, ancestors, ancestryEnd: { state: 'complete' } };
}

/**
 * Terminate orphaned Oxigraph processes that hold this store's lock and wait
 * until they release it. Returns the PIDs that were signalled. Never throws;
 * when a holder cannot be stopped, the next spawn fails with Oxigraph's own
 * lock error, preceded by a log line naming the holder and its parent.
 */
export async function stopOrphanedOxigraph(opts: StopOrphanedOxigraphOptions): Promise<number[]> {
  const io: OrphanedOxigraphIo = { ...reclaimHost(process.platform), ...opts.io };
  // Windows processes are not reparented, so an orphan cannot be told apart.
  if (io.platform === 'win32') return [];
  const lockPath = resolve(opts.location, 'LOCK');
  if (!(await io.lockExists(lockPath))) return [];
  const stopGraceMs = opts.stopGraceMs ?? OXIGRAPH_STOP_GRACE_MS;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const deadline = io.now() + timeoutMs;
  const recordRead = await io.readOwnerRecord(opts.location);
  if (recordRead.kind === 'invalid') {
    opts.log(`[oxigraph] ignoring a malformed owner record for ${lockPath}.`);
  }
  const record = recordRead.kind === 'v1' ? recordRead.record : null;
  const catalog = opts.binaries ?? oxigraphBinaryCatalog(opts.binaryPath);
  const binaries = record ? withOxigraphBinary(catalog, record.binaryPath) : catalog;
  const ownership = deriveOwnership(recordRead, record
    ? { daemon: await io.checkIdentity(record.daemon), launcher: await io.checkIdentity(record.launcher) }
    : null);
  const attempts = new Map<number, Attempt>();
  const signalled = new Set<number>();

  // Settle a holder as left running, and say why. Always false: nothing to await.
  const leave = (pid: number, start: string | null, message: string): false => {
    attempts.set(pid, { kind: 'left', start });
    opts.log(message);
    return false;
  };
  const send = (pid: number, signal: NodeJS.Signals, next: Exclude<Attempt, { kind: 'left' }>): boolean => {
    try {
      io.signal(pid, signal);
    } catch (error) {
      return leave(
        pid,
        next.start,
        `[oxigraph] could not signal orphaned Oxigraph pid ${pid}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    signalled.add(pid);
    attempts.set(pid, next);
    return true;
  };

  // Advance a signalled instance, whether or not it still shows as a lock
  // holder: an orphan can close LOCK before it exits, and a holder scan can
  // fail. It stays awaited until its PID and start time are confirmed gone.
  const advanceSignalled = async (
    pid: number,
    attempt: Exclude<Attempt, { kind: 'left' }>,
  ): Promise<boolean> => {
    const identity = await io.checkIdentity({ pid, start: attempt.start });
    if (identity.state === 'gone') {
      attempts.delete(pid);
      return false;
    }
    // Not confirmed as the signalled instance: keep waiting, do not escalate.
    if (identity.state === 'unknown') return true;
    if (attempt.kind === 'term-sent' && io.now() - attempt.termAt >= stopGraceMs) {
      opts.log(`[oxigraph] orphaned Oxigraph pid ${pid} did not exit on SIGTERM; sending SIGKILL.`);
      return send(pid, 'SIGKILL', { kind: 'kill-sent', start: attempt.start });
    }
    return true;
  };

  // Observe one listed lock holder and advance its attempt. Resolves to
  // whether it is still awaited: signalled and not yet confirmed gone.
  const advance = async (pid: number): Promise<boolean> => {
    const attempt = attempts.get(pid);
    const lookup = await io.inspectProcess(pid);
    if (lookup.state === 'gone') {
      attempts.delete(pid);
      return false;
    }
    if (lookup.state === 'unknown') {
      if (attempt?.kind === 'left') return false;
      // A signalled holder is still awaited, but never escalated blind.
      if (attempt !== undefined) return advanceSignalled(pid, attempt);
      return leave(
        pid,
        null,
        `[oxigraph] ${lockPath} is held by pid ${pid}, which could not be inspected ` +
          `(${lookup.reason}). Leaving it running.`,
      );
    }
    const holder = lookup.process;
    // Another start time: the PID was recycled, so this is a new instance.
    const current = attempt?.start === holder.start ? attempt : undefined;
    if (current?.kind === 'left') return false;
    if (current === undefined) {
      const decision = classifyHolder(
        await observeHolder(io, holder),
        { location: opts.location, ownership, binaries },
      );
      if (decision.action === 'leave') {
        return leave(
          pid,
          holder.start,
          `[oxigraph] ${lockPath} is held by pid ${pid} (parent ${holder.ppid}): ` +
            `${holder.command.slice(0, 300)}. Leaving it running: ${describeLeave(decision.reason)}.`,
        );
      }
      // Signal only the instance that was judged: a PID recycled since then
      // has another start time.
      const identity = await io.checkIdentity(holder);
      if (identity.state === 'gone') return false;
      if (identity.state === 'unknown') {
        return leave(
          pid,
          holder.start,
          `[oxigraph] could not confirm that pid ${pid} is still the orphaned Oxigraph ` +
            `holding ${lockPath} (${identity.reason}). Leaving it running.`,
        );
      }
      opts.log(
        `[oxigraph] stopping orphaned Oxigraph pid ${pid} (${describeStop(decision.reason)}); ` +
          `it still holds ${lockPath}.`,
      );
      return send(pid, 'SIGTERM', { kind: 'term-sent', start: holder.start, termAt: io.now() });
    }
    return advanceSignalled(pid, current);
  };

  for (;;) {
    // Null when the holders cannot be listed: unknown, never "released".
    let holders: number[] | null = null;
    try {
      holders = await io.listLockHolders(lockPath);
    } catch {
      // Judged from the signalled instances alone this round.
    }
    const awaited = new Set<number>();
    for (const pid of holders ?? []) {
      if (pid !== process.pid && await advance(pid)) awaited.add(pid);
    }
    // Advancing an attempt only updates or deletes its own entry, which Map
    // iteration tolerates.
    for (const [pid, attempt] of attempts) {
      if (attempt.kind === 'left' || awaited.has(pid)) continue;
      if (await advanceSignalled(pid, attempt)) awaited.add(pid);
    }
    if (awaited.size === 0) {
      if (signalled.size > 0) {
        opts.log(`[oxigraph] ${lockPath} released by the orphaned Oxigraph.`);
      } else if (holders === null) {
        opts.log(`[oxigraph] could not list the processes holding ${lockPath}; leaving the outcome to the spawn.`);
      }
      return [...signalled];
    }
    if (io.now() >= deadline) {
      opts.log(
        `[oxigraph] orphaned Oxigraph pid ${[...awaited].join(', ')} was not confirmed gone ` +
          `${timeoutMs}ms after the reclaim began; starting anyway.`,
      );
      return [...signalled];
    }
    await io.sleep(pollIntervalMs);
  }
}
