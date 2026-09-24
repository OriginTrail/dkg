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
 * alone. Any holder left running is reported with its parent. The LOCK file
 * itself is never modified.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, realpath, rename, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { OXIGRAPH_STOP_GRACE_MS } from './oxigraph-parent-watchdog.js';
import {
  procFdTargets,
  procPids,
  processDescriber,
  processStartProbe,
  type ProcessDescription,
} from './process-probe.js';

const execFileAsync = promisify(execFile);

export const OXIGRAPH_OWNER_RECORD = 'dkg-oxigraph-owner.json';

export interface ProcessIdentity {
  pid: number;
  /** Token from the platform's process start-time probe. */
  start: string;
}

export interface OxigraphOwnerRecord {
  daemon: ProcessIdentity;
  /** The spawned child: the parent watchdog, or Oxigraph itself. */
  launcher: ProcessIdentity;
  /** Added once the launch is verified ready. */
  oxigraph?: ProcessIdentity;
  binaryPath: string;
}

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

/**
 * Whether a command line runs Oxigraph with this store's arguments from one
 * of `binaryPaths`, or from an `oxigraph*` executable in one of `binaryDirs`.
 * A binary started through an interpreter (`#!`) lists the interpreter first.
 */
export function runsManagedOxigraphStore(
  command: string,
  location: string,
  binaryPaths: readonly string[],
  binaryDirs: readonly string[] = binaryPaths.map((path) => dirname(path)),
): boolean {
  const padded = ` ${command} `;
  const storeAt = padded.indexOf(` ${oxigraphStoreArgs(location).join(' ')} `);
  if (storeAt < 0) return false;
  const launched = padded.slice(0, storeAt);
  if (binaryPaths.some((path) => launched.endsWith(` ${path}`))) return true;
  return binaryDirs.some((dir) => {
    const prefix = ` ${dir}/`;
    const dirAt = launched.lastIndexOf(prefix);
    return dirAt >= 0 && /^oxigraph[^/\s]*$/.test(launched.slice(dirAt + prefix.length));
  });
}

function ownerRecordPath(location: string): string {
  return join(resolve(location), OXIGRAPH_OWNER_RECORD);
}

function isIdentity(value: unknown): value is ProcessIdentity {
  const identity = value as ProcessIdentity | null;
  return typeof identity?.pid === 'number' && Number.isInteger(identity.pid) && identity.pid > 0
    && typeof identity.start === 'string' && identity.start.length > 0;
}

export async function readOxigraphOwnerRecord(location: string): Promise<OxigraphOwnerRecord | null> {
  try {
    const record = JSON.parse(await readFile(ownerRecordPath(location), 'utf8')) as OxigraphOwnerRecord;
    return isIdentity(record.daemon) && isIdentity(record.launcher)
      && (record.oxigraph === undefined || isIdentity(record.oxigraph))
      && typeof record.binaryPath === 'string'
      ? record
      : null;
  } catch {
    return null;
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
    const record: OxigraphOwnerRecord = {
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

type HolderDecision =
  | { action: 'stop'; because: string }
  | { action: 'leave'; because: string };

interface ReclaimContext {
  location: string;
  record: OxigraphOwnerRecord | null;
  /** Which recorded process has exited; null while both run, or without a record. */
  recordedOwnerGone: string | null;
  binaryPaths: readonly string[];
  binaryDirs: readonly string[];
  io: OrphanedOxigraphIo;
}

async function identityAlive(io: OrphanedOxigraphIo, identity: ProcessIdentity): Promise<boolean> {
  return (await io.processStart(identity.pid)) === identity.start;
}

async function recordedOwnerGone(
  io: OrphanedOxigraphIo,
  record: OxigraphOwnerRecord | null,
): Promise<string | null> {
  if (!record) return null;
  if (!(await identityAlive(io, record.daemon))) {
    return `its recorded daemon pid ${record.daemon.pid} has exited`;
  }
  if (!(await identityAlive(io, record.launcher))) {
    return `its recorded launcher pid ${record.launcher.pid} has exited`;
  }
  return null;
}

async function classifyHolder(
  pid: number,
  holder: ProcessDescription,
  ctx: ReclaimContext,
): Promise<HolderDecision> {
  const { record, io } = ctx;
  if (record && ctx.recordedOwnerGone === null) {
    return {
      action: 'leave',
      because: `this store's recorded daemon pid ${record.daemon.pid} and launcher pid ` +
        `${record.launcher.pid} are still running`,
    };
  }
  if (record && ctx.recordedOwnerGone !== null && record.oxigraph?.pid === pid
    && await identityAlive(io, record.oxigraph)) {
    return { action: 'stop', because: ctx.recordedOwnerGone };
  }
  if (!runsManagedOxigraphStore(holder.command, ctx.location, ctx.binaryPaths, ctx.binaryDirs)) {
    return { action: 'leave', because: `it is not this node's Oxigraph serving this store` };
  }
  // A launch killed before it was ready: its watchdog is alive but cannot
  // act (frozen, wedged), and the daemon that recorded it is gone.
  if (record && ctx.recordedOwnerGone !== null && holder.ppid === record.launcher.pid
    && await identityAlive(io, record.launcher)) {
    return { action: 'stop', because: ctx.recordedOwnerGone };
  }
  if (holder.ppid === 1) return { action: 'stop', because: 'it was reparented to PID 1' };
  const parent = await io.describeProcess(holder.ppid);
  if (!parent) return { action: 'stop', because: `its parent pid ${holder.ppid} has exited` };
  return {
    action: 'leave',
    because: `${record ? 'it is not the Oxigraph recorded for this store' : 'there is no owner record'}, ` +
      `and its parent pid ${holder.ppid} is still running: ${parent.command.slice(0, 200)}`,
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
  const record = await readOxigraphOwnerRecord(opts.location);
  const binaryPaths = [opts.binaryPath, ...(record ? [record.binaryPath] : [])];
  const ctx: ReclaimContext = {
    location: opts.location,
    record,
    recordedOwnerGone: await recordedOwnerGone(io, record),
    binaryPaths,
    binaryDirs: [...binaryPaths.map((path) => dirname(path)), ...(opts.knownBinaryDirs ?? [])],
    io,
  };
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
      const state = signalled.get(pid);
      if (!state) {
        const decision = await classifyHolder(pid, holder, ctx);
        if (decision.action === 'leave') {
          leftRunning.add(pid);
          opts.log(
            `[oxigraph] ${lockPath} is held by pid ${pid} (parent ${holder.ppid}): ` +
              `${holder.command.slice(0, 300)}. Leaving it running: ${decision.because}.`,
          );
          continue;
        }
        opts.log(
          `[oxigraph] stopping orphaned Oxigraph pid ${pid} (${decision.because}); ` +
            `it still holds ${lockPath}.`,
        );
      }
      try {
        if (!state) {
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
