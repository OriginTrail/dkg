/**
 * Devnet node lifecycle, shared by the suites that kill or restart a node:
 * PID-file discovery, liveness, dead-PID cleanup, kill and stop helpers, the
 * port environment `scripts/devnet.sh restart-node` needs, and restart +
 * readiness.
 *
 * Ownership rule (every helper here follows it): a PID is only ever signalled
 * if it was read from a PID file of THIS devnet's node home
 * (`<devnetDir>/node<N>/{daemon,devnet}.pid`), is alive, and its command line
 * shows a DKG daemon (`<node> [flags] <repoRoot>/packages/cli/dist/cli.js`
 * directly followed by `daemon-supervisor|daemon-worker|daemon-foreground-worker`
 * as the last argument) started from THIS checkout. A live PID that fails that
 * check (a stale PID file whose number an unrelated process has taken, even one
 * that merely runs from the checkout) is never signalled:
 * `verifiedNodePids` throws instead, so a wrong PID file is a loud failure, not
 * a silent skip that would leave the node running. A PID file is only ever
 * deleted when the PID in it is known to be dead; a live process keeps its
 * file until it is explicitly stopped, otherwise `restart-node` would launch a
 * duplicate and could signal a recycled PID. A process that is exiting or has
 * exited but not been collected by its parent yet (a zombie: what a just-SIGKILLed
 * daemon is for a moment) counts as dead. Nothing here scans the process
 * table or signals by name.
 *
 * Restarting goes through the same rule: `restartNodeAndWait` first runs
 * `stopNodeProcesses` (verify every live PID-file entry, SIGTERM, escalate to
 * SIGKILL, clear the dead PID files) and only then calls `devnet.sh
 * restart-node`. That script's own stop phase signals whatever the PID files
 * list without any check, so after our stop it finds no live entry to signal.
 * Not covered by this module: the script's stop phase also sweeps the process
 * table for processes that mention the node's home directory and their children
 * (the node's managed store servers and detached children), by design and
 * unchanged.
 *
 * Why the command line names the CHECKOUT and not the node's home: a daemon's
 * argv is `<node> [execArgv] <repoRoot>/packages/cli/dist/cli.js daemon-supervisor|daemon-worker`
 * (`devnet.sh` starts nodes with `DKG_NO_BLUE_GREEN=1`, so the entry point is
 * the CLI of the checkout itself; mixed-version nodes live under
 * `<repoRoot>/.devnet-versions` by default, but `devnet.sh` honours a
 * `DEVNET_VERSIONS_DIR` override: with one outside the checkout a healthy
 * mixed-version daemon would be refused, loudly, and none of the suites that use
 * this module run mixed-version nodes). The home (`DKG_HOME`) is only in the process
 * environment, which `ps` shows with its `e` flag, and as whatever text
 * `devnet.sh` exported. A check that needed it would refuse a healthy daemon
 * whose home is spelled differently, and a refused daemon that keeps running
 * turns a kill -9 test into a graceful stop. The entry point path is resolved
 * by node itself (symlinks followed), so it is compared with the repo root as
 * given and with its `realpath`. Not distinguished: a stale PID that has been
 * recycled by another daemon of this same checkout. Also not covered: PIDs are
 * verified once and signalled later (a suite that verifies before it waits for
 * its kill point, or a stop that escalates to SIGKILL ten seconds after
 * SIGTERM), and only liveness is checked again at the signal, so a verified PID
 * that exits and is recycled inside that window of seconds would still be
 * signalled.
 *
 * Deliberately NOT unified between the suites (they pass their own choice):
 *   - where `restart-node`'s HARDHAT_PORT comes from (`rpcUrl` argument;
 *     `rpcUrlFromNode1Config` is one source, core-peers-features also honours
 *     `DEVNET_RPC`),
 *   - how a node is probed as up (`NodeProbe`: bearer token, request timeout),
 *   - how often readiness is polled.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import * as http from 'node:http';
import { join } from 'node:path';
import { waitFor } from './harness';

export interface DevnetPaths {
  /** The repository root (where `scripts/devnet.sh` lives and restarts run from). */
  repoRoot: string;
  /** The devnet state directory (`<repoRoot>/.devnet`), holding `node<N>/`. */
  devnetDir: string;
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
  const pid = parseInt(text.trim(), 10);
  return Number.isFinite(pid) ? pid : null;
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
export function verifiedNodePids(
  paths: DevnetPaths,
  num: number,
  readCommandLine: CommandLineReader = readProcessCommandLine,
): number[] {
  const roots = repoRootSpellings(paths.repoRoot);
  const pids: number[] = [];
  for (const { file, pid } of readNodePidEntries(paths, num)) {
    if (pids.includes(pid) || !pidAlive(pid)) continue;
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
    pids.push(pid);
  }
  return pids;
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
    await waitFor(label, timeoutMs, 500, async () => (pids.every((pid) => !pidAlive(pid)) ? true : null));
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
export async function stopNodeProcesses(
  paths: DevnetPaths,
  num: number,
  options: {
    graceMs?: number;
    killWaitMs?: number;
    readCommandLine?: CommandLineReader;
    removeUnparseable?: boolean;
  } = {},
): Promise<void> {
  const pids = verifiedNodePids(paths, num, options.readCommandLine);
  if (pids.length > 0) {
    for (const pid of pids) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* may already be gone */ }
    }
    if (!(await waitForPidsGone(`node${num} processes stopped`, pids, options.graceMs ?? 10_000))) {
      sigkillPids(pids.filter(pidAlive));
      await waitForPidsGone(`node${num} processes killed`, pids, options.killWaitMs ?? 10_000);
    }
  }
  clearDeadNodePidFiles(paths, num, { removeUnparseable: options.removeUnparseable });
}

/**
 * The Hardhat RPC URL node1's config records (`chain.rpcUrl`), or the devnet
 * default when the file or the field is missing.
 */
export function rpcUrlFromNode1Config(devnetDir: string): string {
  try {
    const cfg = JSON.parse(readFileSync(join(devnetDir, 'node1', 'config.json'), 'utf8'));
    if (cfg?.chain?.rpcUrl) return cfg.chain.rpcUrl;
  } catch { /* fall through */ }
  return DEFAULT_DEVNET_RPC;
}

/**
 * Port environment for `devnet.sh restart-node`, so a restart matches whatever
 * (possibly non-default) ports this devnet uses. The Hardhat port comes from
 * `rpcUrl`, which each suite chooses; the API and libp2p bases come from
 * node1's config. Throws if node1's config is missing.
 */
export function devnetPortEnv(devnetDir: string, rpcUrl: string): Record<string, string> {
  const cfg = JSON.parse(readFileSync(join(devnetDir, 'node1', 'config.json'), 'utf8'));
  return {
    HARDHAT_PORT: new URL(rpcUrl).port || '8545',
    API_PORT_BASE: String(cfg.apiPort ?? 9201),
    LIBP2P_PORT_BASE: String(cfg.listenPort ?? 10001),
  };
}

export interface NodeProbe {
  /** Sent as `Authorization: Bearer <token>` when set (an empty string is sent as is). */
  authToken?: string;
  /** Abort the request after this long; no timeout when unset. */
  timeoutMs?: number;
}

/**
 * True when `GET /api/status` on the node's API port answers 200. Same request
 * core-peers-features has always made for this (plain `node:http`, JSON
 * `Content-Type`, the bearer token when there is one, no timeout unless asked).
 */
export function nodeReachable(apiPort: number, probe: NodeProbe = {}): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: apiPort,
        method: 'GET',
        path: '/api/status',
        headers: {
          'Content-Type': 'application/json',
          ...(probe.authToken !== undefined ? { Authorization: `Bearer ${probe.authToken}` } : {}),
        },
        ...(probe.timeoutMs !== undefined ? { signal: AbortSignal.timeout(probe.timeoutMs) } : {}),
      },
      (res) => {
        res.on('error', () => resolve(false));
        res.on('end', () => resolve(res.statusCode === 200));
        res.resume(); // status only
      },
    );
    req.on('error', () => resolve(false));
    req.end();
  });
}

export interface RestartNodeOptions {
  num: number;
  /** The node's API port, probed for readiness. */
  apiPort: number;
  /** Source of `restart-node`'s HARDHAT_PORT: each suite's own choice (see `devnetPortEnv`). */
  rpcUrl: string;
  /** Names the readiness wait in its timeout error. */
  label: string;
  timeoutMs: number;
  pollIntervalMs: number;
  probe?: NodeProbe;
  /** Reads a process's command line for the ownership check (default: `ps`); for tests. */
  readCommandLine?: CommandLineReader;
}

/**
 * Stop the node through `stopNodeProcesses` (ownership checked, nothing signalled
 * if a live PID-file entry is not a daemon of this checkout), then
 * `scripts/devnet.sh restart-node <num>` with the devnet's port environment, then
 * wait until the node answers. The script's own stop phase signals PID-file
 * entries unchecked; running ours first leaves it no live entry to signal.
 */
export async function restartNodeAndWait(paths: DevnetPaths, options: RestartNodeOptions): Promise<void> {
  await stopNodeProcesses(paths, options.num, { readCommandLine: options.readCommandLine });
  execFileSync('bash', [join(paths.repoRoot, 'scripts/devnet.sh'), 'restart-node', String(options.num)], {
    cwd: paths.repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...devnetPortEnv(paths.devnetDir, options.rpcUrl) },
  });
  await waitFor(options.label, options.timeoutMs, options.pollIntervalMs, async () =>
    (await nodeReachable(options.apiPort, options.probe)) ? true : null,
  );
}
