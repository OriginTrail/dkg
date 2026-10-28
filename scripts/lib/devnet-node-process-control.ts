// SPDX-License-Identifier: Apache-2.0
import { inspectPsProcessSync, readProcessInventorySync, processDescendants, type ProcessInstance, type ProcessInventory, type SyncProcessInspector } from '../../packages/cli/src/daemon/process-probe.ts';
export { inspectPsProcessSync, type SyncProcessInspector, readProcessState, processStateIsGone, parseProcessInventory, type ProcessInventory, type ProcessRecord } from '../../packages/cli/src/daemon/process-probe.ts';
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

/** Unknown observations never prove that a process has exited. */
export function pidAlive(pid: number): boolean {
  return inspectPsProcessSync(pid).state !== 'gone';
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

/** Immediate SIGKILL, with the original process instance rechecked at the signal boundary. */
export function sigkillProcesses(processes: readonly ProcessInstance[], inspect: SyncProcessInspector = inspectPsProcessSync): number[] {
  const signalled: number[] = [];
  for (const owned of processes) {
    const current = inspect(owned.pid);
    if (current.state !== 'running' || !sameProcess(owned, current.process)) continue;
    try { process.kill(owned.pid, 'SIGKILL'); signalled.push(owned.pid); } catch { /* already gone */ }
  }
  return signalled;
}
function sameProcess(owned: ProcessInstance, current: ProcessInstance): boolean {
  return owned.pid === current.pid && owned.start === current.start && owned.command === current.command;
}

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
 * it before a time-critical kill; retain `verifiedNodeProcesses` for deferred signalling.
 */
type OwnedProcess = ProcessInstance;
export function verifiedNodePids(paths: DevnetPaths, num: number,
  inspect: SyncProcessInspector = inspectPsProcessSync): number[] {
  return verifiedNodeProcesses(paths, num, inspect).map(record => record.pid);
}
export function verifiedNodeProcesses(
  paths: DevnetPaths,
  num: number,
  inspect: SyncProcessInspector = inspectPsProcessSync,
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
    if (owned.has(pid)) continue;
    const observed = inspect(pid);
    if (observed.state === 'gone') continue;
    if (observed.state === 'unknown') {
      throw new Error(
        `node${num}: ${file} lists pid ${pid}, which is alive but whose command line cannot be read, `
        + `so it cannot be shown to be a daemon of ${paths.repoRoot}; not signalling it`,
      );
    }
    if (!isDaemonOfCheckout(observed.process.command, roots)) {
      if (inspect(pid).state === 'gone') continue; // exited (and is waiting to be collected) while it was being looked at
      throw new Error(
        `node${num}: ${file} lists pid ${pid}, which is alive but is not a DKG daemon started from `
        + `${paths.repoRoot} (a stale PID file whose number was recycled?); not signalling it`,
      );
    }
    owned.set(pid, observed.process);
  }
  return [...owned.values()];
}

/**
 * kill -9 the node's live daemon processes, immediately, and return the PIDs
 * that were signalled (the real worker is `daemon.pid`). The PID files are read
 * and every live PID is checked first (`verifiedNodePids`, which throws before
 * anything is signalled). `ps` takes tens of milliseconds per process, so a
 * time-critical caller retains `verifiedNodeProcesses` before waiting and calls
 * `sigkillProcesses` at the kill point, which rechecks that exact process instance.
 */
export function sigkillNodeProcesses(
  paths: DevnetPaths,
  num: number,
  options: { inspect?: SyncProcessInspector } = {},
): number[] {
  return sigkillProcesses(verifiedNodeProcesses(paths, num, options.inspect),
    options.inspect ?? inspectPsProcessSync);
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
  inspect?: SyncProcessInspector;
  removeUnparseable?: boolean;
}
export interface DevnetShutdownPlan {
  readonly paths: DevnetPaths;
  readonly numbers: readonly number[];
  readonly identities: ReadonlyMap<number, ProcessInstance>;
  readonly inspect: SyncProcessInspector;
}
/** Validate every selected node before signalling anything, sharing one process inventory. */
export function planDevnetShutdown(paths: DevnetPaths, numbers: readonly number[],
  inspect: SyncProcessInspector = inspectPsProcessSync): DevnetShutdownPlan {
  const snapshot = readProcessInventorySync();
  const identities = new Map(numbers.flatMap(num => collectOwnedNodeProcesses(paths, num, inspect, snapshot))
    .map(record => [record.pid, record] as const));
  return { paths, numbers: [...numbers], identities, inspect };
}
/** One TERM/grace/KILL flow for the whole validated set; recheck identity at each signal. */
export async function executeDevnetShutdown(plan: DevnetShutdownPlan,
  options: Omit<DevnetShutdownOptions, 'inspect'> = {}): Promise<void> {
  const pids = [...plan.identities.keys()];
  const current = (pid: number) => {
    const observed = plan.inspect(pid);
    return observed.state === 'running' && sameProcess(plan.identities.get(pid)!, observed.process);
  };
  for (const pid of pids) {
    if (!current(pid)) continue;
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
  }
  if (pids.length && !(await waitForPidsGone('devnet processes stopped', pids, options.graceMs ?? 10_000))) {
    sigkillProcesses([...plan.identities.values()], plan.inspect);
    if (!(await waitForPidsGone('devnet processes killed', pids, options.killWaitMs ?? 10_000)))
      throw new Error(`Selected devnet processes did not stop`);
  }
  for (const num of plan.numbers) clearDeadNodePidFiles(plan.paths, num, { removeUnparseable: options.removeUnparseable });
}
export async function stopNodeProcesses(paths: DevnetPaths, num: number,
  options: DevnetShutdownOptions = {}): Promise<void> {
  await executeDevnetShutdown(planDevnetShutdown(paths, [num], options.inspect), options);
}


/** Collect every owned process before signalling any, including detached stores. */
export function collectDevnetNodePids(paths: DevnetPaths, num: number, inspect: SyncProcessInspector = inspectPsProcessSync,
  inventory: ProcessInventory = readProcessInventorySync()): number[] {
  return collectOwnedNodeProcesses(paths, num, inspect, inventory).map(record => record.pid);
}
function collectOwnedNodeProcesses(paths: DevnetPaths, num: number, inspect: SyncProcessInspector,
  inventory: ProcessInventory): OwnedProcess[] {
  const owned = new Map(verifiedNodeProcesses(paths, num, inspect).map(record => [record.pid, record]));
  // Ownership comes from the inventory's process instance, never a later replacement.
  const retain = (pid: number): void => {
    if (owned.has(pid)) return;
    const original = inventory.records.get(pid);
    if (!original) return;
    const current = inspect(pid);
    if (current.state === 'unknown') throw new Error(`Owned PID ${pid} has no readable process identity; not signalling it`);
    if (current.state === 'running' && sameProcess(original, current.process)) owned.set(pid, original);
  };
  const home = nodeHome(paths, num);
  for (const { pid, ownershipText: commandLine, executable } of inventory.records.values()) {
    if (pid === process.pid || !(commandLine.includes(`${home}/`) || commandLine.includes(`DKG_HOME=${home} `)
      || commandLine.endsWith(`DKG_HOME=${home}`))) continue;
    if (executable === 'node' || executable.startsWith('oxigraph')) retain(pid);
  }
  for (const pid of processDescendants([...owned.keys()], inventory.childrenByParent)) {
    if (pid === process.pid || owned.has(pid)) continue;
    const record = inventory.records.get(pid);
    const parent = record && owned.get(record.ppid);
    const observedParent = record && inventory.records.get(record.ppid);
    if (parent && observedParent && sameProcess(parent, observedParent)) retain(pid);
  }
  return [...owned.values()];
}
