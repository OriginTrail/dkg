/**
 * Devnet node lifecycle, shared by the suites that kill or restart a node:
 * PID-file discovery, liveness, dead-PID cleanup, kill helpers, the port
 * environment `scripts/devnet.sh restart-node` needs, and restart + readiness.
 *
 * Ownership rule (every helper here follows it): a PID is only ever signalled
 * if it was read from a PID file of THIS devnet's node home
 * (`<devnetDir>/node<N>/{daemon,devnet}.pid`), is alive, and its command line
 * shows a DKG daemon (`<node> <repoRoot>/.../cli.js daemon-supervisor|daemon-worker`)
 * started from THIS checkout. A live PID that fails that check (a stale PID file
 * whose number an unrelated process has taken) is never signalled:
 * `verifiedNodePids` throws instead, so a wrong PID file is a loud failure, not
 * a silent skip that would leave the node running. A PID file is only ever
 * deleted when the PID in it is known to be dead; a live process keeps its
 * file until it is explicitly stopped, otherwise `restart-node` would launch a
 * duplicate and could signal a recycled PID. Nothing here scans the process
 * table or signals by name.
 *
 * Why the command line names the CHECKOUT and not the node's home: a daemon's
 * argv is `<node> <repoRoot>/packages/cli/dist/cli.js daemon-supervisor|daemon-worker`
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

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
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

/** kill -9 each PID at once (a PID that is already gone is fine). */
export function sigkillPids(pids: readonly number[]): void {
  for (const pid of pids) {
    try { process.kill(pid, 'SIGKILL'); } catch { /* may already be gone */ }
  }
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

const DAEMON_SUBCOMMANDS = new Set(['daemon-supervisor', 'daemon-worker', 'daemon-foreground-worker']);

/** True when `text` holds `<root>/` as the start of a path (at the start of the text, or after whitespace or `=`). */
function mentionsPathUnder(text: string, root: string): boolean {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  for (let at = text.indexOf(prefix); at !== -1; at = text.indexOf(prefix, at + 1)) {
    if (at === 0 || /[\s=]/.test(text[at - 1]!)) return true;
  }
  return false;
}

/**
 * Whether `commandLine` is a DKG daemon process (the supervisor or a worker)
 * started from the checkout at one of `repoRoots`: it names a path under that
 * root and its last argument is the daemon subcommand. A process that merely
 * runs from the checkout (the test runner, `pnpm`), another checkout's daemon,
 * a sibling directory that only shares a prefix with the root, and any
 * unrelated process all fail it.
 */
export function isDaemonOfCheckout(commandLine: string, repoRoots: readonly string[]): boolean {
  const words = commandLine.trim().split(/\s+/);
  if (!DAEMON_SUBCOMMANDS.has(words[words.length - 1] ?? '')) return false;
  return repoRoots.some((root) => mentionsPathUnder(commandLine, root));
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
 * that were signalled (the real worker is `daemon.pid`). Without `verified` the
 * PID files are read and every live PID is checked first (`verifiedNodePids`,
 * which throws before anything is signalled). A time-critical caller passes the
 * PIDs it verified earlier; only those still alive are signalled.
 */
export function sigkillNodeProcesses(
  paths: DevnetPaths,
  num: number,
  options: { verified?: readonly number[]; readCommandLine?: CommandLineReader } = {},
): number[] {
  const pids = (options.verified ?? verifiedNodePids(paths, num, options.readCommandLine)).filter(pidAlive);
  sigkillPids(pids);
  return pids;
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
}

/** `scripts/devnet.sh restart-node <num>` with the devnet's port environment, then wait until the node answers. */
export async function restartNodeAndWait(paths: DevnetPaths, options: RestartNodeOptions): Promise<void> {
  execFileSync('bash', [join(paths.repoRoot, 'scripts/devnet.sh'), 'restart-node', String(options.num)], {
    cwd: paths.repoRoot,
    stdio: 'inherit',
    env: { ...process.env, ...devnetPortEnv(paths.devnetDir, options.rpcUrl) },
  });
  await waitFor(options.label, options.timeoutMs, options.pollIntervalMs, async () =>
    (await nodeReachable(options.apiPort, options.probe)) ? true : null,
  );
}
