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
import type { OxigraphBinaryLocations } from './oxigraph-binary.js';
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
  oxigraphBinaryCatalog,
  withOxigraphBinary,
  type HolderObservation,
} from './oxigraph-reclaim-policy.js';
import {
  bootIdReader,
  procPidsWithFdTarget,
  processInspector,
  type BootIdReader,
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
  /** This boot's identifier, which an owner record must carry to be matched. */
  bootId: BootIdReader;
  /** One observation of a process: running, confirmed gone, or unreadable. */
  inspectProcess(pid: number): Promise<ProcessLookup>;
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
  binaries?: OxigraphBinaryLocations;
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

// `lsof -t` output: one PID per line; anything else is not a holder list.
function parsePids(stdout: string): number[] {
  const lines = stdout.split('\n').map((line) => line.trim()).filter(Boolean);
  const pids = lines.map(Number);
  if (pids.some((pid) => !Number.isInteger(pid) || pid <= 0)) {
    throw new Error(`lsof: unexpected output: ${stdout.slice(0, 200)}`);
  }
  return pids;
}

/** Runs `lsof` with these arguments; rejects like `execFile` (`code`, `killed`, `stdout`, `stderr`). */
export type LsofRunner = (args: readonly string[]) => Promise<{ stdout: string }>;

const runLsof: LsofRunner = (args) => execFileAsync('lsof', [...args], { timeout: 5_000 });

/**
 * The processes holding a file, from `lsof -t`. It exits 1 with no output
 * when no process has the file open, which is the one failure read as "no
 * holders". Anything else (a timeout, a missing `lsof`, a message on stderr,
 * output that is not a PID list) rejects, so the reclaim treats the holders
 * as unknown rather than absent.
 */
export function lsofLockHolderLister(run: LsofRunner = runLsof): (lockPath: string) => Promise<number[]> {
  return async (lockPath) => {
    let stdout: string;
    try {
      ({ stdout } = await run(['-t', '-w', lockPath]));
    } catch (error) {
      const failed = error as { code?: unknown; signal?: unknown; stdout?: unknown; stderr?: unknown; killed?: boolean };
      const noHolder = failed.code === 1 && failed.killed !== true && failed.signal == null
        && String(failed.stdout ?? '').trim() === '' && String(failed.stderr ?? '').trim() === '';
      if (noHolder) return [];
      throw error;
    }
    return parsePids(stdout);
  };
}

export const lsofLockHolders = lsofLockHolderLister();

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
    bootId: bootIdReader(platform),
    inspectProcess,
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
export type Attempt =
  /** Judged and left running, or its signal was refused; `start` null: it could not be inspected. */
  | { kind: 'left'; start: string | null }
  /** SIGTERM sent at `termAt`; SIGKILL follows once the stop grace has passed. */
  | { kind: 'term-sent'; start: string; termAt: number }
  | { kind: 'kill-sent'; start: string };

/** What the reaper does next about one PID, after one read of it. */
export type AttemptStep =
  /** The instance exited (or the PID now names a process off the lock): forget it. */
  | { kind: 'forget' }
  /** Nothing changes: a holder left running, or a signalled one still awaited. */
  | { kind: 'keep'; awaited: boolean }
  /** A process instance not judged yet: classify it, then `confirmStop`. */
  | { kind: 'judge'; holder: ProcessInstance }
  /** An unjudged holder that could not be read: report it and leave it. */
  | { kind: 'leave-unreadable'; reason: string }
  /** The stop grace has passed since SIGTERM: send SIGKILL. */
  | { kind: 'escalate'; start: string };

/**
 * The transition for one PID from its attempt (if any) and one read of it.
 * `listed`: whether the PID is among the current lock holders. A signalled
 * holder is awaited until it is confirmed gone, listed or not (an orphan can
 * close LOCK before it exits, and a holder scan can fail); a read that fails
 * keeps it awaited but never escalates it.
 */
export function advanceAttempt(
  attempt: Attempt | undefined,
  read: ProcessLookup,
  at: { now: number; stopGraceMs: number; listed: boolean },
): AttemptStep {
  if (read.state === 'gone') return { kind: 'forget' };
  if (read.state === 'unknown') {
    if (attempt === undefined) return { kind: 'leave-unreadable', reason: read.reason };
    return { kind: 'keep', awaited: attempt.kind !== 'left' };
  }
  const holder = read.process;
  if (attempt === undefined || attempt.start !== holder.start) {
    // A new process under this PID: judged if it holds the lock; otherwise
    // the instance this attempt named has exited.
    return at.listed ? { kind: 'judge', holder } : { kind: 'forget' };
  }
  if (attempt.kind === 'left') return { kind: 'keep', awaited: false };
  if (attempt.kind === 'term-sent' && at.now - attempt.termAt >= at.stopGraceMs) {
    return { kind: 'escalate', start: attempt.start };
  }
  return { kind: 'keep', awaited: true };
}

/** Whether a holder judged for stopping may be signalled, from a read taken right before. */
export type StopConfirmation =
  | { kind: 'signal' }
  /** It exited, or its PID was recycled, since it was judged. */
  | { kind: 'forget' }
  /** It could not be read: leave it rather than signal a process that may have changed. */
  | { kind: 'leave-unconfirmed'; reason: string };

/** Signal only the instance that was judged: a PID recycled since then has another start time. */
export function confirmStop(holder: ProcessInstance, reread: ProcessLookup): StopConfirmation {
  if (reread.state === 'unknown') return { kind: 'leave-unconfirmed', reason: reread.reason };
  if (reread.state === 'gone' || reread.process.start !== holder.start) return { kind: 'forget' };
  return { kind: 'signal' };
}

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
  // Defaults for the effective platform, then the caller's parts. Identity
  // checks read the same process table as every other observation.
  const io: OrphanedOxigraphIo = { ...reclaimHost(opts.io?.platform ?? process.platform), ...opts.io };
  const identityState = (identity: ProcessIdentity): Promise<IdentityState> =>
    checkIdentity(identity, io.inspectProcess);
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
  const currentBoot = record ? await io.bootId() : null;
  // Identities only mean something within the boot they were taken in.
  const sameBoot = record !== null && currentBoot !== null && record.boot === currentBoot;
  if (record && currentBoot !== null && !sameBoot) {
    opts.log(`[oxigraph] ignoring an owner record for ${lockPath} from an earlier boot.`);
  }
  const catalog = opts.binaries ?? oxigraphBinaryCatalog(opts.binaryPath);
  const binaries = record ? withOxigraphBinary(catalog, record.binaryPath) : catalog;
  const ownership = deriveOwnership(recordRead, sameBoot
    ? { daemon: await identityState(record.daemon), launcher: await identityState(record.launcher) }
    : null, currentBoot);
  const attempts = new Map<number, Attempt>();
  const signalled = new Set<number>();

  const send = (pid: number, signal: NodeJS.Signals, next: Exclude<Attempt, { kind: 'left' }>): boolean => {
    try {
      io.signal(pid, signal);
    } catch (error) {
      attempts.set(pid, { kind: 'left', start: next.start });
      opts.log(
        `[oxigraph] could not signal orphaned Oxigraph pid ${pid}: ` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
    signalled.add(pid);
    attempts.set(pid, next);
    return true;
  };

  // Classify a new holder instance and, if it is to be stopped, confirm it
  // with a second read before SIGTERM. Resolves to whether it is awaited.
  const judge = async (pid: number, holder: ProcessInstance): Promise<boolean> => {
    const decision = classifyHolder(
      await observeHolder(io, holder),
      { location: opts.location, ownership, binaries },
    );
    if (decision.action === 'leave') {
      attempts.set(pid, { kind: 'left', start: holder.start });
      opts.log(
        `[oxigraph] ${lockPath} is held by pid ${pid} (parent ${holder.ppid}): ` +
          `${holder.command.slice(0, 300)}. Leaving it running: ${describeLeave(decision.reason)}.`,
      );
      return false;
    }
    const confirmation = confirmStop(holder, await io.inspectProcess(pid));
    if (confirmation.kind === 'forget') {
      attempts.delete(pid);
      return false;
    }
    if (confirmation.kind === 'leave-unconfirmed') {
      attempts.set(pid, { kind: 'left', start: holder.start });
      opts.log(
        `[oxigraph] could not confirm that pid ${pid} is still the orphaned Oxigraph ` +
          `holding ${lockPath} (${confirmation.reason}). Leaving it running.`,
      );
      return false;
    }
    opts.log(
      `[oxigraph] stopping orphaned Oxigraph pid ${pid} (${describeStop(decision.reason)}); ` +
        `it still holds ${lockPath}.`,
    );
    return send(pid, 'SIGTERM', { kind: 'term-sent', start: holder.start, termAt: io.now() });
  };

  // One read of `pid`, one transition, and its effect. Resolves to whether
  // the PID is still awaited.
  const step = async (pid: number, listed: boolean): Promise<boolean> => {
    const next = advanceAttempt(attempts.get(pid), await io.inspectProcess(pid), {
      now: io.now(),
      stopGraceMs,
      listed,
    });
    switch (next.kind) {
      case 'forget':
        attempts.delete(pid);
        return false;
      case 'keep':
        return next.awaited;
      case 'leave-unreadable':
        attempts.set(pid, { kind: 'left', start: null });
        opts.log(
          `[oxigraph] ${lockPath} is held by pid ${pid}, which could not be inspected ` +
            `(${next.reason}). Leaving it running.`,
        );
        return false;
      case 'escalate':
        opts.log(`[oxigraph] orphaned Oxigraph pid ${pid} did not exit on SIGTERM; sending SIGKILL.`);
        return send(pid, 'SIGKILL', { kind: 'kill-sent', start: next.start });
      case 'judge':
        return judge(pid, next.holder);
    }
  };

  for (;;) {
    // Null when the holders cannot be listed: unknown, never "released".
    let holders: number[] | null = null;
    try {
      holders = await io.listLockHolders(lockPath);
    } catch {
      // Judged from the signalled instances alone this round.
    }
    const listed = new Set((holders ?? []).filter((pid) => pid !== process.pid));
    const awaited: number[] = [];
    for (const pid of listed) {
      if (await step(pid, true)) awaited.push(pid);
    }
    // Signalled instances that no longer show as holders: one read each.
    const unlisted = [...attempts]
      .filter(([pid, attempt]) => attempt.kind !== 'left' && !listed.has(pid))
      .map(([pid]) => pid);
    for (const pid of unlisted) {
      if (await step(pid, false)) awaited.push(pid);
    }
    if (awaited.length === 0) {
      if (signalled.size > 0) {
        opts.log(`[oxigraph] ${lockPath} released by the orphaned Oxigraph.`);
      } else if (holders === null) {
        opts.log(`[oxigraph] could not list the processes holding ${lockPath}; leaving the outcome to the spawn.`);
      }
      return [...signalled];
    }
    if (io.now() >= deadline) {
      opts.log(
        `[oxigraph] orphaned Oxigraph pid ${awaited.join(', ')} was not confirmed gone ` +
          `${timeoutMs}ms after the reclaim began; starting anyway.`,
      );
      return [...signalled];
    }
    await io.sleep(pollIntervalMs);
  }
}
