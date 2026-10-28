// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { dirname, join, isAbsolute } from 'node:path';

export interface DevnetPaths {
  /** The repository root (where `scripts/devnet.sh` lives and restarts run from). */
  repoRoot: string;
  /** The devnet state directory (`<repoRoot>/.devnet`), holding `node<N>/`. */
  devnetDir: string;
  /** Exact configured alternate entry for each mixed-version node. */
  nodeCliEntries?: Readonly<Record<number, string>>;
}

/**
 * A node's PID files. `daemon.pid` is the daemon worker (written by the daemon
 * itself). `devnet.pid` is written by `devnet.sh` once `cli.js start` has
 * returned (`refresh_node_pidfile`): the detached `daemon-supervisor`, the
 * worker's parent, which respawns a worker that dies, or the worker itself when
 * it has been reparented to init. (The `cli.js start` launcher is in neither
 * file: it has exited by then.) Killing only the worker would let the
 * supervisor bring it back, so both are read (the daemon first).
 */
export const NODE_PID_FILES = ['daemon.pid', 'devnet.pid'] as const;

export interface NodePidEntry {
  file: (typeof NODE_PID_FILES)[number];
  pid: number;
}

/** What `devnet.sh` falls back to for the Hardhat RPC when node1's config has none. */
export const DEFAULT_DEVNET_RPC = 'http://127.0.0.1:8545';

/** A PID file's content as a PID, or `null` when it holds none. */
export function parsePid(text: string): number | null {
  const value = text.trim();
  if (!/^[1-9]\d*$/.test(value)) return null;
  const pid = Number(value);
  return Number.isSafeInteger(pid) ? pid : null;
}

function nodeHome(paths: DevnetPaths, num: number): string {
  return join(paths.devnetDir, `node${num}`);
}

/** Every parseable PID entry of a node, daemon first. */
export function readNodePidEntries(paths: DevnetPaths, num: number): NodePidEntry[] {
  const entries: NodePidEntry[] = [];
  for (const file of NODE_PID_FILES) {
    const pidFile = join(nodeHome(paths, num), file);
    if (!existsSync(pidFile)) continue;
    const pid = parsePid(readFileSync(pidFile, 'utf8'));
    if (pid !== null) entries.push({ file, pid });
  }
  return entries;
}

/** The node's distinct PIDs (daemon first). */
export function readNodePids(paths: DevnetPaths, num: number): number[] {
  return [...new Set(readNodePidEntries(paths, num).map((entry) => entry.pid))];
}

/**
 * `ps -o stat= -p <pid>`: the process state letters (`Z...` is a zombie), `null`
 * when the process is gone or `ps` cannot show it.
 */
export function readProcessState(pid: number): string | null {
  try {
    const out = execFileSync('ps', ['-o', 'stat=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Whether a `ps` state (`readProcessState`) is that of a process that is not running any
 * more: a zombie (`Z...`, exited but not yet collected by its parent) or, on macOS, one
 * that is in the middle of exiting (`E` flag, "trying to exit", for example `?E`). A
 * `null` or ordinary state (`S`, `Ss+`, `R`, ...) is not.
 */
export function processStateIsGone(state: string | null): boolean {
  return state !== null && (state.startsWith('Z') || state.includes('E'));
}

/**
 * Whether the process is still running. A SIGKILLed daemon is, for a moment, a process in
 * the middle of exiting and then a zombie until its parent (or init) collects it: it
 * still answers signal 0 and `ps` shows its command line as `(node)`, yet nothing of the
 * daemon runs and nothing is left to signal. Such a process counts as gone, or a restart
 * right after a kill would refuse it as "not a daemon of this checkout". A state that
 * cannot be read counts as alive.
 */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return !processStateIsGone(readProcessState(pid));
}

/**
 * Remove only PID files whose PID is known dead. A live but unhealthy daemon
 * keeps ownership of its file until it is explicitly stopped; deleting first
 * lets `restart-node` launch a duplicate process.
 *
 * `removeUnparseable` (default false) also deletes a file that holds no PID at
 * all. core-peers-features leaves such a file alone; swm-host-store-durability
 * has always removed it, and keeps doing so by passing `true`.
 */
export function clearDeadNodePidFiles(
  paths: DevnetPaths,
  num: number,
  options: { removeUnparseable?: boolean } = {},
): void {
  for (const file of NODE_PID_FILES) {
    const pidFile = join(nodeHome(paths, num), file);
    if (!existsSync(pidFile)) continue;
    const pid = parsePid(readFileSync(pidFile, 'utf8'));
    if (pid === null ? !options.removeUnparseable : pidAlive(pid)) continue;
    try { rmSync(pidFile); } catch { /* best-effort */ }
  }
}

/**
 * kill -9 each PID at once and return the ones that were signalled (a PID that is
 * already gone is skipped, not an error). It does not check who a PID is: pass it
 * PIDs that `verifiedNodePids` returned.
 */
export function sigkillPids(pids: readonly number[]): number[] {
  const signalled: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
      signalled.push(pid);
    } catch { /* may already be gone */ }
  }
  return signalled;
}

/** The command line (argv, no environment) of a process, or `null` when it cannot be read. */
export type CommandLineReader = (pid: number) => string | null;

/** `ps -ww -o command= -p <pid>`: the full argv of a process, `null` when it is gone or `ps` cannot show it. */
export const readProcessCommandLine: CommandLineReader = (pid) => {
  try {
    const out = execFileSync('ps', ['-ww', '-o', 'command=', '-p', String(pid)], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
};

/** The CLI entry point, relative to the checkout: what `resolveDaemonNodeCommand` puts before the subcommand. */
const CLI_ENTRY_POINT = 'packages/cli/dist/cli.js';
const DAEMON_SUBCOMMANDS = new Set(['daemon-supervisor', 'daemon-worker', 'daemon-foreground-worker']);

/**
 * Whether `commandLine` is a DKG daemon process (the supervisor or a worker)
 * started from the checkout at one of `repoRoots`: the checkout's CLI entry
 * point (`<root>/packages/cli/dist/cli.js`, as its own argument) is directly
 * followed by a daemon subcommand, and that subcommand is the last argument (the
 * CLI starts a daemon as `<node> [execArgv] <entry> <subcommand>`). Anything else
 * fails it: a process that merely runs from the checkout (the test runner, `pnpm`,
 * even when its last argument happens to be named like a daemon command), the
 * CLI launcher (`... cli.js start`), another checkout's daemon, a sibling
 * directory that only shares a prefix with the root, and any unrelated process.
 *
 * `commandLine` is what `ps` prints, argv joined by single spaces, so the entry
 * point is searched for as text rather than as a whitespace-split token: a
 * checkout path that contains spaces still matches (and cannot be told apart
 * from the same words in another argument, which only a process that already
 * names this entry point followed by a daemon subcommand could exploit).
 */
export function isDaemonOfCheckout(commandLine: string, repoRoots: readonly string[]): boolean {
  const text = commandLine.trim();
  return repoRoots.some((root) => {
    const entry = `${root.replace(/\/+$/, '')}/${CLI_ENTRY_POINT}`;
    for (let at = text.indexOf(entry); at !== -1; at = text.indexOf(entry, at + 1)) {
      if (at > 0 && !/\s/.test(text[at - 1]!)) continue; // `/mnt/<root>/...` or `--import=<entry>`: not this argument
      const rest = text.slice(at + entry.length);
      const subcommand = /^\s+(\S+)$/.exec(rest)?.[1];
      if (subcommand !== undefined && DAEMON_SUBCOMMANDS.has(subcommand)) return true;
    }
    return false;
  });
}

function repoRootSpellings(repoRoot: string): string[] {
  try {
    return [...new Set([repoRoot, realpathSync(repoRoot)])];
  } catch {
    return [repoRoot];
  }
}

/**
 * The node's LIVE PIDs from its PID files (daemon first), each one checked to be
 * a DKG daemon of this checkout (see the ownership rule above). Throws, naming
 * the file and the PID, when a live PID is not one (or its command line cannot
 * be read): nothing may be signalled then, and a silent skip would leave the
 * node running. A PID that is dead, or dies while it is being checked, is skipped.
 *
 * Reads the command lines through `ps`, which takes tens of milliseconds: call
 * it before a time-critical kill and pass the result to `sigkillNodeProcesses`.
 */
interface OwnedProcess { readonly pid: number; readonly commandLine: string }
export function verifiedNodePids(paths: DevnetPaths, num: number,
  readCommandLine: CommandLineReader = readProcessCommandLine): number[] {
  return verifiedNodeProcesses(paths, num, readCommandLine).map(record => record.pid);
}
function verifiedNodeProcesses(
  paths: DevnetPaths,
  num: number,
  readCommandLine: CommandLineReader = readProcessCommandLine,
): OwnedProcess[] {
  let recorded: string | undefined;
  try { recorded = readFileSync(join(nodeHome(paths, num), '.devnet-cli-entry'), 'utf8').trim(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const alternate = recorded ?? paths.nodeCliEntries?.[num];
  if (alternate !== undefined && (!isAbsolute(alternate) || /[\r\n\0]/.test(alternate) || !alternate.endsWith(`/${CLI_ENTRY_POINT}`))) throw new Error(`node${num}: invalid configured CLI entry`);
  const roots = [...repoRootSpellings(paths.repoRoot),
    ...(alternate === undefined ? [] : repoRootSpellings(dirname(dirname(dirname(dirname(alternate))))))];
  const owned = new Map<number, OwnedProcess>();
  for (const { file, pid } of readNodePidEntries(paths, num)) {
    if (owned.has(pid) || !pidAlive(pid)) continue;
    const commandLine = readCommandLine(pid);
    if (commandLine === null) {
      if (!pidAlive(pid)) continue; // exited while it was being looked at
      throw new Error(
        `node${num}: ${file} lists pid ${pid}, which is alive but whose command line cannot be read, `
        + `so it cannot be shown to be a daemon of ${paths.repoRoot}; not signalling it`,
      );
    }
    if (!isDaemonOfCheckout(commandLine, roots)) {
      if (!pidAlive(pid)) continue; // exited (and is waiting to be collected) while it was being looked at
      throw new Error(
        `node${num}: ${file} lists pid ${pid}, which is alive but is not a DKG daemon started from `
        + `${paths.repoRoot} (a stale PID file whose number was recycled?); not signalling it`,
      );
    }
    owned.set(pid, { pid, commandLine });
  }
  return [...owned.values()];
}

/**
 * kill -9 the node's live daemon processes, immediately, and return the PIDs
 * that were signalled (the real worker is `daemon.pid`). The PID files are read
 * and every live PID is checked first (`verifiedNodePids`, which throws before
 * anything is signalled). `ps` takes tens of milliseconds per process, so a
 * time-critical caller calls `verifiedNodePids` itself before its wait and
 * `sigkillPids` at the kill point.
 */
export function sigkillNodeProcesses(
  paths: DevnetPaths,
  num: number,
  options: { readCommandLine?: CommandLineReader } = {},
): number[] {
  return sigkillPids(verifiedNodePids(paths, num, options.readCommandLine));
}

/** Resolves `true` once every PID is gone, `false` if any is still alive after `timeoutMs`. */
export async function waitForPidsGone(label: string, pids: readonly number[], timeoutMs: number): Promise<boolean> {
  try {
    const until = Date.now() + timeoutMs;
    while (pids.some(pidAlive)) {
      if (Date.now() >= until) return false;
      await new Promise(resolve => setTimeout(resolve, Math.min(100, timeoutMs)));
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Stop the node's processes: verify every live PID-file entry (`verifiedNodePids`,
 * which throws before anything is signalled), SIGTERM them, wait up to `graceMs`
 * for them to exit, SIGKILL the ones that did not, wait up to `killWaitMs`, then
 * remove the PID files whose PID is dead. Nothing is signalled that is not a
 * daemon of this checkout; a live PID of anything else rejects the whole stop.
 */
export interface DevnetShutdownOptions {
  graceMs?: number;
  killWaitMs?: number;
  readCommandLine?: CommandLineReader;
  removeUnparseable?: boolean;
}
export interface DevnetShutdownPlan {
  readonly paths: DevnetPaths;
  readonly numbers: readonly number[];
  readonly identities: ReadonlyMap<number, string>;
  readonly readCommandLine: CommandLineReader;
}
/** Validate every selected node before signalling anything, sharing one process inventory. */
export function planDevnetShutdown(paths: DevnetPaths, numbers: readonly number[],
  readCommandLine: CommandLineReader = readProcessCommandLine): DevnetShutdownPlan {
  const snapshot = readProcessInventory();
  const identities = new Map(numbers.flatMap(num => collectOwnedNodeProcesses(paths, num, readCommandLine, snapshot))
    .map(record => [record.pid, record.commandLine] as const));
  return { paths, numbers: [...numbers], identities, readCommandLine };
}
/** One TERM/grace/KILL flow for the whole validated set; recheck identity at each signal. */
export async function executeDevnetShutdown(plan: DevnetShutdownPlan,
  options: Omit<DevnetShutdownOptions, 'readCommandLine'> = {}): Promise<void> {
  const pids = [...plan.identities.keys()];
  const current = (pid: number) => pidAlive(pid) && plan.readCommandLine(pid) === plan.identities.get(pid);
  for (const pid of pids) {
    if (!current(pid)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  if (pids.length && !(await waitForPidsGone('devnet processes stopped', pids, options.graceMs ?? 10_000))) {
    sigkillPids(pids.filter(current));
    if (!(await waitForPidsGone('devnet processes killed', pids, options.killWaitMs ?? 10_000)))
      throw new Error(`Selected devnet processes did not stop`);
  }
  for (const num of plan.numbers) clearDeadNodePidFiles(plan.paths, num, { removeUnparseable: options.removeUnparseable });
}
export async function stopNodeProcesses(paths: DevnetPaths, num: number,
  options: DevnetShutdownOptions = {}): Promise<void> {
  await executeDevnetShutdown(planDevnetShutdown(paths, [num], options.readCommandLine), options);
}


/** Collect every owned process before signalling any, including detached stores. */
export function collectDevnetNodePids(paths: DevnetPaths, num: number, readCommandLine: CommandLineReader = readProcessCommandLine,
  inventory: ProcessInventory = readProcessInventory()): number[] {
  return collectOwnedNodeProcesses(paths, num, readCommandLine, inventory).map(record => record.pid);
}
export interface ProcessRecord {
  readonly pid: number;
  readonly parentPid: number;
  readonly commandLine: string;
  readonly executable: string;
}
export interface ProcessInventory {
  readonly records: ReadonlyMap<number, ProcessRecord>;
  readonly childrenByParent: ReadonlyMap<number, readonly number[]>;
}
/** Normalize both OS snapshots once, including executable paths containing spaces. */
export function parseProcessInventory(listings: string, metadata: string): ProcessInventory {
  const commands = new Map<number, string>();
  for (const line of listings.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line);
    if (match) commands.set(Number(match[1]), match[2]!);
  }
  const records = new Map<number, ProcessRecord>();
  const childrenByParent = new Map<number, number[]>();
  for (const line of metadata.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!match) continue;
    const pid = Number(match[1]), parentPid = Number(match[2]);
    if (!Number.isSafeInteger(pid) || pid <= 0 || !Number.isSafeInteger(parentPid) || parentPid < 0) continue;
    const commandLine = commands.get(pid);
    if (commandLine === undefined) continue; // Process exited between snapshots.
    const executable = match[3]!.trim().split('/').at(-1)!;
    records.set(pid, Object.freeze({ pid, parentPid, commandLine, executable }));
    const children = childrenByParent.get(parentPid) ?? [];
    children.push(pid); childrenByParent.set(parentPid, children);
  }
  return { records, childrenByParent };
}
function readProcessInventory(): ProcessInventory {
  const listings = execFileSync('ps', ['axeww', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const metadata = execFileSync('ps', ['-A', '-o', 'pid=,ppid=,comm='], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  return parseProcessInventory(listings, metadata);
}
function collectOwnedNodeProcesses(paths: DevnetPaths, num: number, readCommandLine: CommandLineReader,
  inventory: ProcessInventory): OwnedProcess[] {
  const owned = new Map(verifiedNodeProcesses(paths, num, readCommandLine).map(record => [record.pid, record]));
  // Resolve identity at discovery, retaining it through planning. A verified
  // PID-file record must never be replaced by a later command observation.
  const retain = (pid: number): void => {
    if (owned.has(pid) || !pidAlive(pid)) return;
    const commandLine = readCommandLine(pid);
    if (commandLine !== null) owned.set(pid, { pid, commandLine });
    else if (pidAlive(pid)) throw new Error(`Owned PID ${pid} has no readable command identity; not signalling it`);
  };
  const home = nodeHome(paths, num);
  for (const { pid, commandLine, executable } of inventory.records.values()) {
    if (pid === process.pid || !(commandLine.includes(`${home}/`) || commandLine.includes(`DKG_HOME=${home} `)
      || commandLine.endsWith(`DKG_HOME=${home}`))) continue;
    if (executable === 'node' || executable.startsWith('oxigraph')) retain(pid);
  }
  const pending = [...owned.keys()];
  for (let index = 0; index < pending.length; index++) {
    for (const pid of inventory.childrenByParent.get(pending[index]!) ?? []) {
      if (pid === process.pid || owned.has(pid)) continue;
      retain(pid); if (owned.has(pid)) pending.push(pid);
    }
  }
  return [...owned.values()].filter(record => pidAlive(record.pid));
}
