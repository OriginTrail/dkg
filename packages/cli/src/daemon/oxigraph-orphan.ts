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
 * Ownership comes from a record, not from the process table. Right after
 * each spawn the daemon writes `dkg-oxigraph-owner.json` in the store
 * directory with its own identity, the spawned launcher's and the binary;
 * once Oxigraph is verified ready it adds Oxigraph's identity. Identities are
 * a PID plus process start time. Before each spawn the daemon terminates a
 * holder of `<location>/LOCK` only when
 *   - the recorded daemon or launcher has exited and the holder is the
 *     recorded Oxigraph (same PID and start time), whatever process adopted
 *     it (PID 1, a subreaper, a stopped watchdog), or, for a launch killed
 *     before it was ready, a child of the recorded launcher that runs this
 *     node's Oxigraph for this store; or
 *   - it runs this node's Oxigraph for this store (the recorded or current
 *     binary, or another `oxigraph*` executable in a known binary directory),
 *     no live recorded owner exists, and its parent is gone: it was
 *     reparented to PID 1 or its parent has exited. This covers an orphan
 *     from an earlier release, which has no record.
 * While the recorded daemon and launcher both still run, every holder is left
 * alone. Any holder left running is reported with its parent. A holder is
 * signalled only while it is still the process instance that was judged
 * (same PID and start time). The LOCK file itself is never modified.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { OXIGRAPH_STOP_GRACE_MS } from './oxigraph-parent-watchdog.js';
import {
  mapWithConcurrency,
  procHasFdTarget,
  procPids,
  processDescriber,
  processStartProbe,
  type ProcessDescription,
} from './process-probe.js';

const execFileAsync = promisify(execFile);

export const OXIGRAPH_OWNER_RECORD = 'dkg-oxigraph-owner.json';
export const OXIGRAPH_OWNER_RECORD_SCHEMA = 'dkg-oxigraph-owner/v1';

export interface ProcessIdentity {
  pid: number;
  /** Token from the platform's process start-time probe. */
  start: string;
}

export interface OxigraphOwnerRecordV1 {
  schema: typeof OXIGRAPH_OWNER_RECORD_SCHEMA;
  daemon: ProcessIdentity;
  /** The spawned child: the parent watchdog, or Oxigraph itself. */
  launcher: ProcessIdentity;
  /** Added once the launch is verified ready. */
  oxigraph?: ProcessIdentity;
  binaryPath: string;
}

/** What the store directory says about its owner. */
export type OxigraphOwnerRecordRead =
  | { kind: 'absent' }
  | { kind: 'invalid' }
  | { kind: 'v1'; record: OxigraphOwnerRecordV1 };

export interface OrphanedOxigraphIo {
  /** PIDs that have the lock file open. */
  listLockHolders(lockPath: string): Promise<number[]>;
  /** Null when the process has exited. */
  describeProcess(pid: number): Promise<ProcessDescription | null>;
  /** Start-time token; null when the process has exited. */
  processStart(pid: number): Promise<string | null>;
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
    (pid) => procHasFdTarget(pid, (fdTarget) => fdTarget === target),
  );
  return pids.filter((_, index) => holds[index]);
}

const defaultIo: OrphanedOxigraphIo = {
  listLockHolders: process.platform === 'linux' ? procLockHolders : lsofLockHolders,
  describeProcess: processDescriber(process.platform),
  processStart: processStartProbe(process.platform),
  signal: (pid, signal) => { process.kill(pid, signal); },
  sleep: (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  now: () => Date.now(),
};

/**
 * The leading `oxigraph` arguments that open `location`. The managed server
 * launches with them and the reclaim recognises a holder by them, so the two
 * cannot drift apart.
 */
export function oxigraphStoreArgs(location: string): string[] {
  return ['serve', '--location', location];
}

/** Executables that count as this node's Oxigraph. */
export interface OxigraphBinaries {
  /** Exact executable paths. */
  paths: readonly string[];
  /** Directories whose `oxigraph*` executables count too. */
  dirs: readonly string[];
}

/**
 * Whether a process runs a known Oxigraph binary with this store's
 * arguments. Exact argv (from `/proc`) is compared token by token; a binary
 * started through an interpreter (`#!`) has the interpreter first. Where only
 * `ps` display text exists, argv boundaries are lost, so the text is compared
 * only when neither the store path nor a known binary path contains
 * whitespace; otherwise the answer is `ambiguous`.
 */
export function matchManagedOxigraphStore(
  holder: Pick<ProcessDescription, 'argv' | 'command'>,
  location: string,
  binaries: OxigraphBinaries,
): 'match' | 'no-match' | 'ambiguous' {
  let tokens = holder.argv;
  if (tokens === null) {
    if ([location, ...binaries.paths, ...binaries.dirs].some((value) => /\s/.test(value))) {
      return 'ambiguous';
    }
    tokens = holder.command.split(' ');
  }
  const dirs = binaries.dirs.map((dir) => resolve(dir));
  const knownBinary = (token: string): boolean =>
    binaries.paths.includes(token)
    || (/^oxigraph[^/]*$/.test(basename(token)) && dirs.includes(resolve(dirname(token))));
  const storeArgs = oxigraphStoreArgs(location);
  for (let at = 0; at + storeArgs.length < tokens.length; at++) {
    if (knownBinary(tokens[at]) && storeArgs.every((arg, offset) => tokens![at + 1 + offset] === arg)) {
      return 'match';
    }
  }
  return 'no-match';
}

function ownerRecordPath(location: string): string {
  return join(resolve(location), OXIGRAPH_OWNER_RECORD);
}

function isIdentity(value: unknown): value is ProcessIdentity {
  const identity = value as ProcessIdentity | null;
  return typeof identity?.pid === 'number' && Number.isInteger(identity.pid) && identity.pid > 0
    && typeof identity.start === 'string' && identity.start.length > 0;
}

function decodeOwnerRecord(value: unknown): OxigraphOwnerRecordV1 | null {
  const record = value as Partial<OxigraphOwnerRecordV1> | null;
  return record?.schema === OXIGRAPH_OWNER_RECORD_SCHEMA
    && isIdentity(record.daemon) && isIdentity(record.launcher)
    && (record.oxigraph === undefined || isIdentity(record.oxigraph))
    && typeof record.binaryPath === 'string'
    ? record as OxigraphOwnerRecordV1
    : null;
}

export async function readOxigraphOwnerRecord(location: string): Promise<OxigraphOwnerRecordRead> {
  let text: string;
  try {
    text = await readFile(ownerRecordPath(location), 'utf8');
  } catch {
    return { kind: 'absent' };
  }
  try {
    const record = decodeOwnerRecord(JSON.parse(text));
    return record ? { kind: 'v1', record } : { kind: 'invalid' };
  } catch {
    return { kind: 'invalid' };
  }
}

/**
 * Record this daemon as the owner of a store: at spawn with the launcher,
 * then again with `oxigraphPid` once that launch is verified ready. Never
 * throws: without a record, reclaim falls back to PID 1.
 */
export async function recordOxigraphOwner(input: {
  location: string;
  binaryPath: string;
  launcherPid: number;
  oxigraphPid?: number;
  log: (message: string) => void;
}): Promise<void> {
  if (process.platform === 'win32') return;
  const identify = async (pid: number): Promise<ProcessIdentity | null> => {
    const start = await defaultIo.processStart(pid);
    return start === null ? null : { pid, start };
  };
  try {
    const [daemon, launcher, oxigraph] = await Promise.all([
      identify(process.pid),
      identify(input.launcherPid),
      input.oxigraphPid === undefined ? undefined : identify(input.oxigraphPid),
    ]);
    if (!daemon || !launcher || oxigraph === null) return;
    const record: OxigraphOwnerRecordV1 = {
      schema: OXIGRAPH_OWNER_RECORD_SCHEMA,
      daemon,
      launcher,
      ...(oxigraph ? { oxigraph } : {}),
      binaryPath: input.binaryPath,
    };
    const path = ownerRecordPath(input.location);
    const pending = `${path}.${process.pid}.tmp`;
    await writeFile(pending, `${JSON.stringify(record)}\n`, 'utf8');
    await rename(pending, path);
  } catch (error) {
    input.log(
      `[oxigraph] could not record the store owner: ` +
        `${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** Who owns the store now, decided once per reclaim. */
type Ownership =
  | { kind: 'unrecorded' }
  | { kind: 'invalid-record' }
  | { kind: 'owners-live'; record: OxigraphOwnerRecordV1 }
  | { kind: 'owner-gone'; record: OxigraphOwnerRecordV1; gone: { role: 'daemon' | 'launcher'; pid: number } };

type StopReason =
  | { kind: 'owner-gone'; role: 'daemon' | 'launcher'; pid: number }
  | { kind: 'reparented-to-init' }
  | { kind: 'parent-exited'; ppid: number };

type LeaveReason =
  | { kind: 'owners-live'; daemonPid: number; launcherPid: number }
  | { kind: 'not-this-store' }
  | { kind: 'argv-ambiguous' }
  | { kind: 'parent-alive'; ppid: number; parentCommand: string; recorded: boolean };

type HolderDecision =
  | { action: 'stop'; reason: StopReason }
  | { action: 'leave'; reason: LeaveReason };

function describeStop(reason: StopReason): string {
  switch (reason.kind) {
    case 'owner-gone': return `its recorded ${reason.role} pid ${reason.pid} has exited`;
    case 'reparented-to-init': return 'it was reparented to PID 1';
    case 'parent-exited': return `its parent pid ${reason.ppid} has exited`;
  }
}

function describeLeave(reason: LeaveReason): string {
  switch (reason.kind) {
    case 'owners-live':
      return `this store's recorded daemon pid ${reason.daemonPid} and launcher pid ` +
        `${reason.launcherPid} are still running`;
    case 'not-this-store':
      return `it is not this node's Oxigraph serving this store`;
    case 'argv-ambiguous':
      return 'this platform shows no exact argv, and the store or binary path contains ' +
        'whitespace, so its command line cannot be matched reliably';
    case 'parent-alive':
      return `${reason.recorded ? 'it is not the Oxigraph recorded for this store' : 'there is no owner record'}, ` +
        `and its parent pid ${reason.ppid} is still running: ${reason.parentCommand.slice(0, 200)}`;
  }
}

async function identityAlive(io: OrphanedOxigraphIo, identity: ProcessIdentity): Promise<boolean> {
  return (await io.processStart(identity.pid)) === identity.start;
}

async function readOwnership(io: OrphanedOxigraphIo, read: OxigraphOwnerRecordRead): Promise<Ownership> {
  if (read.kind === 'absent') return { kind: 'unrecorded' };
  if (read.kind === 'invalid') return { kind: 'invalid-record' };
  const { record } = read;
  if (!(await identityAlive(io, record.daemon))) {
    return { kind: 'owner-gone', record, gone: { role: 'daemon', pid: record.daemon.pid } };
  }
  if (!(await identityAlive(io, record.launcher))) {
    return { kind: 'owner-gone', record, gone: { role: 'launcher', pid: record.launcher.pid } };
  }
  return { kind: 'owners-live', record };
}

interface ReclaimContext {
  location: string;
  ownership: Ownership;
  binaries: OxigraphBinaries;
  io: OrphanedOxigraphIo;
}

async function classifyHolder(
  holder: ProcessDescription & ProcessIdentity,
  ctx: ReclaimContext,
): Promise<HolderDecision> {
  const { ownership, io } = ctx;
  if (ownership.kind === 'owners-live') {
    return {
      action: 'leave',
      reason: {
        kind: 'owners-live',
        daemonPid: ownership.record.daemon.pid,
        launcherPid: ownership.record.launcher.pid,
      },
    };
  }
  const recordedOxigraph = ownership.kind === 'owner-gone' ? ownership.record.oxigraph : undefined;
  if (ownership.kind === 'owner-gone'
    && recordedOxigraph?.pid === holder.pid && recordedOxigraph.start === holder.start) {
    return { action: 'stop', reason: { kind: 'owner-gone', ...ownership.gone } };
  }
  const match = matchManagedOxigraphStore(holder, ctx.location, ctx.binaries);
  if (match === 'ambiguous') return { action: 'leave', reason: { kind: 'argv-ambiguous' } };
  if (match === 'no-match') return { action: 'leave', reason: { kind: 'not-this-store' } };
  // A launch killed before it was ready: its watchdog is alive but cannot
  // act (frozen, wedged), and the daemon that recorded it is gone.
  if (ownership.kind === 'owner-gone' && holder.ppid === ownership.record.launcher.pid
    && await identityAlive(io, ownership.record.launcher)) {
    return { action: 'stop', reason: { kind: 'owner-gone', ...ownership.gone } };
  }
  if (holder.ppid === 1) return { action: 'stop', reason: { kind: 'reparented-to-init' } };
  const parent = await io.describeProcess(holder.ppid);
  if (!parent) return { action: 'stop', reason: { kind: 'parent-exited', ppid: holder.ppid } };
  return {
    action: 'leave',
    reason: {
      kind: 'parent-alive',
      ppid: holder.ppid,
      parentCommand: parent.command,
      recorded: ownership.kind === 'owner-gone',
    },
  };
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
  const ctx: ReclaimContext = {
    location: opts.location,
    ownership: await readOwnership(io, recordRead),
    binaries: {
      paths: binaryPaths,
      dirs: [...binaryPaths.map((path) => dirname(path)), ...(opts.knownBinaryDirs ?? [])],
    },
    io,
  };
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
      const start = await io.processStart(pid);
      if (start === null) continue;
      const instance = `${pid}:${start}`;
      if (leftRunning.has(instance)) continue;
      const state = signalled.get(instance);
      if (!state) {
        const holder = await io.describeProcess(pid);
        if (!holder) continue;
        const decision = await classifyHolder({ ...holder, pid, start }, ctx);
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
      if ((await io.processStart(pid)) !== start) continue;
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
