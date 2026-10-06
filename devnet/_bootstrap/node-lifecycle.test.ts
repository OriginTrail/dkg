// No-devnet tests for the shared node-lifecycle helpers (node-lifecycle.ts): PID files,
// the ownership rule (only this devnet's own, live PIDs, and only a daemon of this
// checkout, are ever signalled), port resolution, the readiness probe, and the restart
// wiring against a stand-in devnet.sh.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_DEVNET_RPC,
  clearDeadNodePidFiles,
  devnetPortEnv,
  isDaemonOfCheckout,
  nodeReachable,
  parsePid,
  pidAlive,
  processStateIsGone,
  readNodePidEntries,
  readNodePids,
  readProcessCommandLine,
  readProcessState,
  restartNodeAndWait,
  rpcUrlFromNode1Config,
  sigkillNodeProcesses,
  sigkillPids,
  stopNodeProcesses,
  verifiedNodePids,
  waitForPidsGone,
  type DevnetPaths,
} from './node-lifecycle.js';

let root: string;
let paths: DevnetPaths;
const children: ChildProcess[] = [];
const servers: Server[] = [];

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dkg-node-lifecycle-'));
  paths = { repoRoot: root, devnetDir: join(root, '.devnet') };
  for (const n of [1, 2, 3, 4, 5]) mkdirSync(join(paths.devnetDir, `node${n}`), { recursive: true });
});

afterEach(async () => {
  for (const child of children.splice(0)) {
    try { child.kill('SIGKILL'); } catch { /* gone */ }
  }
  for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
  rmSync(root, { recursive: true, force: true });
});

const pidFile = (n: number, name: 'daemon.pid' | 'devnet.pid') => join(paths.devnetDir, `node${n}`, name);

/**
 * A live process that only sleeps. By default it looks like what `devnet.sh` leaves running for a
 * node: its command line ends in `<repoRoot>/packages/cli/dist/cli.js daemon-worker`. Pass `plain`
 * for an unrelated process (what a recycled PID would be), or `argv` for exactly the arguments that
 * follow the script (a process that runs from the checkout without being a daemon). `ignoreTerm`
 * makes it survive SIGTERM.
 */
function sleeper(options: { plain?: boolean; entry?: string; argv?: string[]; ignoreTerm?: boolean } = {}): ChildProcess {
  const args = ['-e', `${options.ignoreTerm ? "process.on('SIGTERM', () => {}); " : ''}setInterval(() => {}, 1000)`];
  if (options.argv) args.push(...options.argv);
  else if (!options.plain) args.push(options.entry ?? join(root, 'packages/cli/dist/cli.js'), 'daemon-worker');
  const child = spawn(process.execPath, args, { stdio: 'ignore' });
  children.push(child);
  return child;
}

/**
 * A zombie: a process that has exited but has not been collected by its parent (a `sleep` that never
 * waits for it), which is what a just-SIGKILLed daemon is until its parent or init reaps it.
 */
async function zombie(): Promise<number> {
  const holder = spawn('sh', ['-c', 'sleep 0.1 & echo $!; exec sleep 60'], { stdio: ['ignore', 'pipe', 'ignore'] });
  children.push(holder);
  const pid = await new Promise<number>((resolve, reject) => {
    holder.stdout!.once('data', (chunk) => resolve(parseInt(String(chunk).trim(), 10)));
    holder.once('error', reject);
  });
  for (let i = 0; i < 50 && !readProcessState(pid)?.startsWith('Z'); i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  expect(readProcessState(pid), 'the helper must leave a zombie').toMatch(/^Z/);
  return pid;
}

/** A PID that is certainly dead: a child that has already exited and been reaped. */
function deadPid(): number {
  const result = spawnSync(process.execPath, ['-e', '0']);
  return result.pid!;
}

async function exited(child: ChildProcess): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(true); });
  });
}

async function listen(handler: (headers: IncomingHttpHeaders, url: string) => { status: number; hang?: boolean }): Promise<{ port: number; seen: IncomingHttpHeaders[] }> {
  const seen: IncomingHttpHeaders[] = [];
  const server = createServer((req, res) => {
    seen.push(req.headers);
    const answer = handler(req.headers, req.url ?? '');
    if (answer.hang) return; // never answers
    res.writeHead(answer.status, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  return { port: (server.address() as AddressInfo).port, seen };
}

describe('PID files', () => {
  it('parsePid reads a pid and returns null for anything that is not one', () => {
    expect(parsePid('12345\n')).toBe(12345);
    expect(parsePid('  42  ')).toBe(42);
    expect(parsePid('')).toBeNull();
    expect(parsePid('not-a-pid')).toBeNull();
    expect(parsePid('\n')).toBeNull();
  });

  it('reads both PID files of a node (daemon first), de-duplicates, and skips absent or unparseable files', () => {
    writeFileSync(pidFile(4, 'daemon.pid'), '1001\n');
    writeFileSync(pidFile(4, 'devnet.pid'), '1002\n');
    expect(readNodePidEntries(paths, 4)).toEqual([
      { file: 'daemon.pid', pid: 1001 },
      { file: 'devnet.pid', pid: 1002 },
    ]);
    expect(readNodePids(paths, 4)).toEqual([1001, 1002]);

    writeFileSync(pidFile(4, 'devnet.pid'), '1001\n');
    expect(readNodePids(paths, 4)).toEqual([1001]);

    writeFileSync(pidFile(4, 'devnet.pid'), 'garbage');
    expect(readNodePidEntries(paths, 4)).toEqual([{ file: 'daemon.pid', pid: 1001 }]);
    expect(readNodePids(paths, 5)).toEqual([]);
  });

  it('pidAlive tells a live process from a reaped one', () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(deadPid())).toBe(false);
  });

  it('pidAlive counts a zombie (exited, not yet collected by its parent) as gone, readProcessState shows why', async () => {
    const pid = await zombie();
    expect(() => process.kill(pid, 0), 'signal 0 still reaches a zombie').not.toThrow();
    expect(readProcessState(pid)).toMatch(/^Z/);
    expect(pidAlive(pid)).toBe(false);
    expect(readProcessState(process.pid)).not.toMatch(/^Z/);
    expect(readProcessState(deadPid())).toBeNull();
  });

  it('processStateIsGone: a zombie and a process trying to exit (macOS `E`) are gone, ordinary states and an unreadable one are not', () => {
    // The first live session saw exactly `(node)` / `?E` for a daemon that had just been SIGKILLed.
    for (const state of ['Z', 'Z+', 'Zs', '?E', 'UE', 'S E']) expect(processStateIsGone(state), state).toBe(true);
    for (const state of ['S', 'Ss', 'Ss+', 'R', 'R+', 'U', 'Ssl', 'SN', 'I', null]) expect(processStateIsGone(state), String(state)).toBe(false);
  });

  it('clearDeadNodePidFiles removes the file of a zombie, as it does for any dead PID', async () => {
    writeFileSync(pidFile(4, 'daemon.pid'), `${await zombie()}\n`);
    clearDeadNodePidFiles(paths, 4);
    expect(existsSync(pidFile(4, 'daemon.pid'))).toBe(false);
  });

  it('clearDeadNodePidFiles removes only files whose PID is dead, and only for that node', () => {
    const dead = deadPid();
    writeFileSync(pidFile(4, 'daemon.pid'), `${process.pid}\n`); // live: keeps its ownership
    writeFileSync(pidFile(4, 'devnet.pid'), `${dead}\n`); // dead launcher
    writeFileSync(pidFile(5, 'daemon.pid'), `${dead}\n`); // another node's dead file

    clearDeadNodePidFiles(paths, 4);

    expect(existsSync(pidFile(4, 'daemon.pid'))).toBe(true);
    expect(existsSync(pidFile(4, 'devnet.pid'))).toBe(false);
    expect(existsSync(pidFile(5, 'daemon.pid'))).toBe(true);
  });

  it('leaves an unparseable PID file alone unless the caller asks for it to be removed', () => {
    writeFileSync(pidFile(4, 'daemon.pid'), 'garbage');
    writeFileSync(pidFile(4, 'devnet.pid'), '');

    clearDeadNodePidFiles(paths, 4);
    expect(readFileSync(pidFile(4, 'daemon.pid'), 'utf8')).toBe('garbage');
    expect(existsSync(pidFile(4, 'devnet.pid'))).toBe(true);

    clearDeadNodePidFiles(paths, 4, { removeUnparseable: true });
    expect(existsSync(pidFile(4, 'daemon.pid'))).toBe(false);
    expect(existsSync(pidFile(4, 'devnet.pid'))).toBe(false);
  });

  it('never removes the file of a live process, even with removeUnparseable', () => {
    writeFileSync(pidFile(4, 'daemon.pid'), `${process.pid}`);
    clearDeadNodePidFiles(paths, 4, { removeUnparseable: true });
    expect(existsSync(pidFile(4, 'daemon.pid'))).toBe(true);
  });
});

describe('killing a node', () => {
  it('sigkillNodeProcesses signals only live PIDs listed in THIS node\'s PID files', async () => {
    const worker = sleeper();
    const launcherGone = deadPid();
    const bystander = sleeper(); // not in any PID file
    const otherNode = sleeper(); // in ANOTHER node's PID file
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${launcherGone}\n`);
    writeFileSync(pidFile(5, 'daemon.pid'), `${otherNode.pid}\n`);

    const signalled = sigkillNodeProcesses(paths, 4);

    expect(signalled).toEqual([worker.pid]);
    expect(await exited(worker)).toBe(true);
    expect(worker.signalCode).toBe('SIGKILL');
    expect(pidAlive(bystander.pid!)).toBe(true);
    expect(pidAlive(otherNode.pid!)).toBe(true);
  });

  it('sigkillNodeProcesses on a node with no PID files signals nothing', () => {
    const bystander = sleeper();
    expect(sigkillNodeProcesses(paths, 4)).toEqual([]);
    expect(pidAlive(bystander.pid!)).toBe(true);
  });

  it('sigkillPids kills immediately and tolerates a PID that is already gone', async () => {
    const victim = sleeper();
    expect(() => sigkillPids([deadPid(), victim.pid!])).not.toThrow();
    expect(await exited(victim)).toBe(true);
  });

  it('waitForPidsGone resolves true once the processes are gone and false if one survives the timeout', async () => {
    const victim = sleeper();
    const survivor = sleeper();
    sigkillPids([victim.pid!]);
    expect(await waitForPidsGone('victim gone', [victim.pid!], 5_000)).toBe(true);
    expect(await waitForPidsGone('survivor gone', [survivor.pid!], 600)).toBe(false);
  });
});

describe('every node resolves to its own home', () => {
  // Node 1 gets decoy PID files with different, live PIDs: a helper that resolved any other node to
  // node1's home would read (and signal) them instead of the node it was asked about.
  it('reads, clears and kills by node number: node2 and node3 never see each other\'s or node1\'s files', async () => {
    const decoy1 = sleeper();
    const decoy1Launcher = sleeper();
    const worker2 = sleeper();
    const supervisor2 = sleeper();
    const worker3 = sleeper();
    const dead = deadPid();
    writeFileSync(pidFile(1, 'daemon.pid'), `${decoy1.pid}\n`);
    writeFileSync(pidFile(1, 'devnet.pid'), `${decoy1Launcher.pid}\n`);
    writeFileSync(pidFile(2, 'daemon.pid'), `${worker2.pid}\n`);
    writeFileSync(pidFile(2, 'devnet.pid'), `${supervisor2.pid}\n`);
    writeFileSync(pidFile(3, 'daemon.pid'), `${worker3.pid}\n`);
    writeFileSync(pidFile(3, 'devnet.pid'), `${dead}\n`);

    expect(readNodePidEntries(paths, 1)).toEqual([
      { file: 'daemon.pid', pid: decoy1.pid },
      { file: 'devnet.pid', pid: decoy1Launcher.pid },
    ]);
    expect(readNodePidEntries(paths, 2)).toEqual([
      { file: 'daemon.pid', pid: worker2.pid },
      { file: 'devnet.pid', pid: supervisor2.pid },
    ]);
    expect(readNodePids(paths, 3)).toEqual([worker3.pid, dead]);
    expect(readNodePids(paths, 4)).toEqual([]);

    // Clearing node3's dead files touches neither node2's live ones nor node1's.
    clearDeadNodePidFiles(paths, 3);
    expect(existsSync(pidFile(3, 'daemon.pid'))).toBe(true);
    expect(existsSync(pidFile(3, 'devnet.pid'))).toBe(false);
    for (const n of [1, 2]) for (const name of ['daemon.pid', 'devnet.pid'] as const) expect(existsSync(pidFile(n, name))).toBe(true);

    // Killing node3 signals node3's worker only.
    expect(sigkillNodeProcesses(paths, 3)).toEqual([worker3.pid]);
    expect(await exited(worker3)).toBe(true);
    for (const survivor of [decoy1, decoy1Launcher, worker2, supervisor2]) expect(pidAlive(survivor.pid!)).toBe(true);

    // And node2's two processes, in file order, without touching node1's.
    expect(sigkillNodeProcesses(paths, 2)).toEqual([worker2.pid, supervisor2.pid]);
    expect(await exited(worker2)).toBe(true);
    expect(await exited(supervisor2)).toBe(true);
    for (const survivor of [decoy1, decoy1Launcher]) expect(pidAlive(survivor.pid!)).toBe(true);
  });
});

describe('only a daemon of this checkout is ever signalled', () => {
  const binary = '/usr/local/bin/node';
  const cli = (root_: string) => `${root_}/packages/cli/dist/cli.js`;

  it('isDaemonOfCheckout accepts the daemon supervisor and worker of the checkout, under either spelling of its root', () => {
    expect(isDaemonOfCheckout(`${binary} ${cli('/work/dkg')} daemon-supervisor`, ['/work/dkg'])).toBe(true);
    expect(isDaemonOfCheckout(`${binary} --max-old-space-size=2048 ${cli('/work/dkg')} daemon-worker`, ['/work/dkg'])).toBe(true);
    expect(isDaemonOfCheckout(`node ${cli('/work/dkg')} daemon-foreground-worker`, ['/work/dkg'])).toBe(true);
    // The root may be given as a path or as its realpath.
    expect(isDaemonOfCheckout(`node ${cli('/private/work/dkg')} daemon-worker`, ['/work/dkg', '/private/work/dkg'])).toBe(true);
    // A root with a trailing slash, surrounding whitespace, node flags before the entry point.
    expect(isDaemonOfCheckout(`node --max-old-space-size=4096 --no-warnings ${cli('/work/dkg')} daemon-worker  \n`, ['/work/dkg/'])).toBe(true);
    // `ps` prints argv joined by spaces: a checkout path with spaces in it still matches.
    expect(isDaemonOfCheckout(`${binary} ${cli('/my work/dkg')} daemon-supervisor`, ['/my work/dkg'])).toBe(true);
  });

  it.each([
    ['an unrelated process (a recycled PID)', '/usr/bin/vim /work/notes.txt'],
    ['the same unrelated name without any path', 'sleep 1000'],
    ['a process that runs from the checkout but is not a daemon (the test runner)', `${binary} /work/dkg/node_modules/.bin/vitest run daemon-worker-tests`],
    ['a test runner of the checkout whose last argument is named like a daemon command', `${binary} /work/dkg/node_modules/vitest/vitest.mjs run daemon-worker`],
    ['a script of the checkout other than the CLI entry point, followed by a daemon subcommand', `${binary} /work/dkg/packages/cli/dist/daemon-entrypoint.js daemon-supervisor`],
    ['the CLI entry point of the checkout with the daemon subcommand somewhere else than right after it', `${binary} ${cli('/work/dkg')} run daemon-worker`],
    ['a flag carrying the entry point path (not the script being run)', `${binary} --import=${cli('/work/dkg')} x daemon-worker`],
    ['a daemon command run by another program that only mentions the entry point', `/usr/bin/tool ${cli('/work/dkg')}-copy daemon-worker`],
    ['the CLI launcher, which is not a daemon process', `${binary} ${cli('/work/dkg')} start`],
    ['another checkout\'s daemon', `${binary} ${cli('/elsewhere/dkg')} daemon-worker`],
    ['a sibling directory that only shares a prefix with the root', `${binary} ${cli('/work/dkg-other')} daemon-worker`],
    ['a path that only contains the root as a suffix of a longer one', `${binary} ${cli('/mnt/work/dkg')} daemon-supervisor`],
    ['the daemon subcommand not being the last argument', `${binary} ${cli('/work/dkg')} daemon-worker --extra`],
    ['an empty command line', ''],
  ])('isDaemonOfCheckout rejects %s', (_label, commandLine) => {
    expect(isDaemonOfCheckout(commandLine, ['/work/dkg'])).toBe(false);
  });

  it('verifiedNodePids lists the live daemons from the PID files (daemon first), once each, reading a command line per distinct live PID', () => {
    const worker = sleeper();
    const supervisor = sleeper();
    const dead = deadPid();
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${supervisor.pid}\n`);
    writeFileSync(pidFile(5, 'daemon.pid'), `${dead}\n`);
    writeFileSync(pidFile(5, 'devnet.pid'), `${dead}\n`);
    const read: number[] = [];
    const reader = (pid: number) => { read.push(pid); return `${binary} ${join(root, 'packages/cli/dist/cli.js')} daemon-worker`; };

    expect(verifiedNodePids(paths, 4, reader)).toEqual([worker.pid, supervisor.pid]);
    expect(read).toEqual([worker.pid, supervisor.pid]);

    read.length = 0;
    writeFileSync(pidFile(4, 'devnet.pid'), `${worker.pid}\n`); // the same PID in both files
    expect(verifiedNodePids(paths, 4, reader)).toEqual([worker.pid]);
    expect(read).toEqual([worker.pid]);

    read.length = 0;
    expect(verifiedNodePids(paths, 5, reader)).toEqual([]); // dead PIDs are skipped without a lookup
    expect(read).toEqual([]);
  });

  it('a live PID that is not a daemon of this checkout (the recycled-PID case) is refused, naming the file and the PID, and nothing is signalled', async () => {
    const worker = sleeper();
    const recycled = sleeper({ plain: true }); // stands for an unrelated process that took a dead launcher's number
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${recycled.pid}\n`);

    expect(() => verifiedNodePids(paths, 4)).toThrow(`node4: devnet.pid lists pid ${recycled.pid}, which is alive but is not a DKG daemon`);
    // The verified worker is not killed either: a half-killed node is worse than a loud failure.
    expect(() => sigkillNodeProcesses(paths, 4)).toThrow(/not a DKG daemon/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pidAlive(worker.pid!)).toBe(true);
    expect(pidAlive(recycled.pid!)).toBe(true);

    // Put the recycled number in the daemon file instead: same refusal, other file named.
    writeFileSync(pidFile(4, 'daemon.pid'), `${recycled.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${worker.pid}\n`);
    expect(() => sigkillNodeProcesses(paths, 4)).toThrow(`node4: daemon.pid lists pid ${recycled.pid}`);
    expect(pidAlive(recycled.pid!)).toBe(true);
  });

  it('a daemon of ANOTHER checkout is refused as well', () => {
    const foreign = sleeper({ entry: '/elsewhere/dkg/packages/cli/dist/cli.js' });
    writeFileSync(pidFile(4, 'daemon.pid'), `${foreign.pid}\n`);
    expect(() => verifiedNodePids(paths, 4)).toThrow(/not a DKG daemon started from/);
    expect(() => sigkillNodeProcesses(paths, 4)).toThrow(/not a DKG daemon started from/);
    expect(pidAlive(foreign.pid!)).toBe(true);
  });

  it('a live PID whose command line cannot be read is refused rather than signalled or skipped', () => {
    const worker = sleeper();
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    expect(() => verifiedNodePids(paths, 4, () => null)).toThrow(`daemon.pid lists pid ${worker.pid}, which is alive but whose command line cannot be read`);
    expect(() => sigkillNodeProcesses(paths, 4, { readCommandLine: () => null })).toThrow(/cannot be read/);
    expect(pidAlive(worker.pid!)).toBe(true);
  });

  it('the error never includes the refused process\'s command line', () => {
    const recycled = sleeper({ plain: true });
    writeFileSync(pidFile(4, 'daemon.pid'), `${recycled.pid}\n`);
    const secret = 'super-secret-token-in-argv';
    expect(() => verifiedNodePids(paths, 4, () => `/usr/bin/tool --token ${secret}`)).toThrow(/not a DKG daemon/);
    try { verifiedNodePids(paths, 4, () => `/usr/bin/tool --token ${secret}`); } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('with the real `ps`: a daemon-shaped process is verified and killed, under either spelling of the root', async () => {
    const real = realpathSync(root);
    for (const entry of new Set([join(root, 'packages/cli/dist/cli.js'), join(real, 'packages/cli/dist/cli.js')])) {
      const worker = sleeper({ entry });
      writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
      expect(readProcessCommandLine(worker.pid!)).toContain(`${entry} daemon-worker`);
      expect(verifiedNodePids(paths, 4)).toEqual([worker.pid]);
      expect(sigkillNodeProcesses(paths, 4)).toEqual([worker.pid]);
      expect(await exited(worker)).toBe(true);
    }
  });

  it('with the real `ps`: readProcessCommandLine returns the argv of a live process and null for one that is gone', () => {
    expect(readProcessCommandLine(process.pid)).toContain('node');
    expect(readProcessCommandLine(deadPid())).toBeNull();
  });

  it('with the real `ps`: an unrelated live process in a PID file is refused and survives', () => {
    const recycled = sleeper({ plain: true });
    writeFileSync(pidFile(4, 'daemon.pid'), `${recycled.pid}\n`);
    expect(() => sigkillNodeProcesses(paths, 4)).toThrow(`node4: daemon.pid lists pid ${recycled.pid}`);
    expect(pidAlive(recycled.pid!)).toBe(true);
  });

  it('with the real `ps`: a test runner of this checkout with a daemon-named last argument is refused and survives', async () => {
    // The shape of the review's example: `node <checkout>/node_modules/vitest/vitest.mjs run daemon-worker`.
    const runner = sleeper({ argv: [join(root, 'node_modules/vitest/vitest.mjs'), 'run', 'daemon-worker'] });
    const worker = sleeper();
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${runner.pid}\n`);
    expect(() => verifiedNodePids(paths, 4)).toThrow(`node4: devnet.pid lists pid ${runner.pid}, which is alive but is not a DKG daemon`);
    expect(() => sigkillNodeProcesses(paths, 4)).toThrow(/not a DKG daemon/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(pidAlive(runner.pid!)).toBe(true);
    expect(pidAlive(worker.pid!)).toBe(true);
  });

  it('a just-killed daemon that is still a zombie is not refused as "not a daemon": it is gone, and nothing is signalled for it', async () => {
    // The sequence of a cleanup: SIGKILL, then straight away a restart, before the parent has collected the process.
    const dead = await zombie();
    const supervisor = sleeper();
    writeFileSync(pidFile(4, 'daemon.pid'), `${dead}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${supervisor.pid}\n`);
    expect(verifiedNodePids(paths, 4)).toEqual([supervisor.pid]);
    expect(sigkillNodeProcesses(paths, 4)).toEqual([supervisor.pid]);
    expect(await exited(supervisor)).toBe(true);
    // Only the zombie is left: nothing to verify, nothing to signal.
    expect(verifiedNodePids(paths, 4)).toEqual([]);
    expect(sigkillNodeProcesses(paths, 4)).toEqual([]);
  });

  it('a time-critical caller verifies before its wait and signals the verified PIDs at the kill point: no command line is read then, and only live ones are signalled', async () => {
    const worker = sleeper();
    const supervisor = sleeper();
    const bystander = sleeper(); // not listed anywhere
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${supervisor.pid}\n`);
    const verified = verifiedNodePids(paths, 4);
    expect(verified).toEqual([worker.pid, supervisor.pid]);

    // One of them exits between the check and the kill: it is not reported as signalled.
    supervisor.kill('SIGKILL');
    expect(await exited(supervisor)).toBe(true);
    const gone = deadPid();
    expect(sigkillPids([...verified, gone])).toEqual([worker.pid]);
    expect(await exited(worker)).toBe(true);
    expect(worker.signalCode).toBe('SIGKILL');
    expect(pidAlive(bystander.pid!)).toBe(true);
    // An empty list signals nothing and does not fall back to the PID files.
    writeFileSync(pidFile(4, 'daemon.pid'), `${bystander.pid}\n`);
    expect(sigkillPids([])).toEqual([]);
    expect(pidAlive(bystander.pid!)).toBe(true);
  });
});

describe('stopNodeProcesses', () => {
  it('stops the worker and the supervisor with SIGTERM, leaves other processes and nodes alone, and removes the PID files of the dead', async () => {
    const worker = sleeper();
    const supervisor = sleeper();
    const bystander = sleeper();
    const otherNode = sleeper();
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${supervisor.pid}\n`);
    writeFileSync(pidFile(5, 'daemon.pid'), `${otherNode.pid}\n`);

    await stopNodeProcesses(paths, 4, { graceMs: 5_000 });

    expect(await exited(worker)).toBe(true);
    expect(await exited(supervisor)).toBe(true);
    expect(worker.signalCode).toBe('SIGTERM');
    expect(supervisor.signalCode).toBe('SIGTERM');
    expect(existsSync(pidFile(4, 'daemon.pid'))).toBe(false);
    expect(existsSync(pidFile(4, 'devnet.pid'))).toBe(false);
    expect(pidAlive(bystander.pid!)).toBe(true);
    expect(pidAlive(otherNode.pid!)).toBe(true);
    expect(existsSync(pidFile(5, 'daemon.pid'))).toBe(true);
  });

  it('escalates to SIGKILL for a process that ignores SIGTERM once the grace period is over', async () => {
    const stubborn = sleeper({ ignoreTerm: true });
    writeFileSync(pidFile(4, 'daemon.pid'), `${stubborn.pid}\n`);
    // Make sure the SIGTERM handler is installed before the stop signals it.
    await new Promise((resolve) => setTimeout(resolve, 500));

    await stopNodeProcesses(paths, 4, { graceMs: 700, killWaitMs: 5_000 });

    expect(await exited(stubborn)).toBe(true);
    expect(stubborn.signalCode).toBe('SIGKILL');
    expect(existsSync(pidFile(4, 'daemon.pid'))).toBe(false);
  });

  it('a live PID that is not a daemon of this checkout rejects the stop before anything is signalled, the legitimate worker included', async () => {
    const worker = sleeper();
    const unrelated = sleeper({ plain: true });
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${unrelated.pid}\n`);

    await expect(stopNodeProcesses(paths, 4, { graceMs: 300 })).rejects.toThrow(
      `node4: devnet.pid lists pid ${unrelated.pid}, which is alive but is not a DKG daemon`,
    );
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pidAlive(worker.pid!)).toBe(true);
    expect(pidAlive(unrelated.pid!)).toBe(true);
    // Both files keep their live PIDs.
    expect(existsSync(pidFile(4, 'daemon.pid'))).toBe(true);
    expect(existsSync(pidFile(4, 'devnet.pid'))).toBe(true);
  });

  it('a zombie in a PID file (the daemon was just SIGKILLed) neither rejects the stop nor keeps its file', async () => {
    const supervisor = sleeper();
    writeFileSync(pidFile(4, 'daemon.pid'), `${await zombie()}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${supervisor.pid}\n`);

    await stopNodeProcesses(paths, 4, { graceMs: 5_000 });

    expect(await exited(supervisor)).toBe(true);
    expect(existsSync(pidFile(4, 'daemon.pid'))).toBe(false);
    expect(existsSync(pidFile(4, 'devnet.pid'))).toBe(false);
  });

  it('a node whose PID files hold only dead PIDs (or none) just has the dead files removed', async () => {
    writeFileSync(pidFile(4, 'daemon.pid'), `${deadPid()}\n`);
    await stopNodeProcesses(paths, 4);
    await stopNodeProcesses(paths, 5);
    expect(existsSync(pidFile(4, 'daemon.pid'))).toBe(false);
  });
});

describe('port resolution', () => {
  const writeNode1Config = (config: unknown) => writeFileSync(join(paths.devnetDir, 'node1', 'config.json'), JSON.stringify(config));

  it('rpcUrlFromNode1Config returns node1\'s chain.rpcUrl, else the devnet default (also for a missing file)', () => {
    expect(rpcUrlFromNode1Config(paths.devnetDir)).toBe(DEFAULT_DEVNET_RPC); // no config file yet
    writeNode1Config({ apiPort: 9201 });
    expect(rpcUrlFromNode1Config(paths.devnetDir)).toBe(DEFAULT_DEVNET_RPC);
    writeNode1Config({ chain: { rpcUrl: 'http://127.0.0.1:8600' } });
    expect(rpcUrlFromNode1Config(paths.devnetDir)).toBe('http://127.0.0.1:8600');
    writeFileSync(join(paths.devnetDir, 'node1', 'config.json'), '{ not json');
    expect(rpcUrlFromNode1Config(paths.devnetDir)).toBe(DEFAULT_DEVNET_RPC);
  });

  it('devnetPortEnv takes the Hardhat port from the rpcUrl the suite passes and the API / libp2p bases from node1\'s config', () => {
    writeNode1Config({ apiPort: 9301, listenPort: 10101, chain: { rpcUrl: 'http://127.0.0.1:8545' } });
    // The suite's choice wins over what the config records (core-peers-features passes DEVNET_RPC).
    expect(devnetPortEnv(paths.devnetDir, 'http://127.0.0.1:8600')).toEqual({
      HARDHAT_PORT: '8600',
      API_PORT_BASE: '9301',
      LIBP2P_PORT_BASE: '10101',
    });
    // The other policy: the config's own RPC (swm-host-store-durability).
    expect(devnetPortEnv(paths.devnetDir, rpcUrlFromNode1Config(paths.devnetDir)).HARDHAT_PORT).toBe('8545');
  });

  it('devnetPortEnv falls back to the devnet defaults for a URL without a port and for a config without the fields', () => {
    writeNode1Config({});
    expect(devnetPortEnv(paths.devnetDir, 'http://rpc.local')).toEqual({
      HARDHAT_PORT: '8545',
      API_PORT_BASE: '9201',
      LIBP2P_PORT_BASE: '10001',
    });
  });

  it('devnetPortEnv throws when node1\'s config is missing, so a restart cannot run with guessed ports', () => {
    expect(() => devnetPortEnv(paths.devnetDir, DEFAULT_DEVNET_RPC)).toThrow(/config\.json/);
  });
});

describe('nodeReachable', () => {
  it('is true for a 200 from /api/status and sends the bearer token only when asked to', async () => {
    const api = await listen((_headers, url) => ({ status: url === '/api/status' ? 200 : 404 }));

    expect(await nodeReachable(api.port)).toBe(true);
    expect(api.seen.at(-1)?.authorization).toBeUndefined();
    // The request core-peers-features has always made: plain http GET with a JSON content type.
    expect(api.seen.at(-1)?.['content-type']).toBe('application/json');

    expect(await nodeReachable(api.port, { authToken: 'secret-token' })).toBe(true);
    expect(api.seen.at(-1)?.authorization).toBe('Bearer secret-token');
  });

  it('is false for any other status and when nothing listens', async () => {
    const unavailable = await listen(() => ({ status: 503 }));
    expect(await nodeReachable(unavailable.port)).toBe(false);
    const forbidden = await listen(() => ({ status: 401 }));
    expect(await nodeReachable(forbidden.port, { authToken: 'x' })).toBe(false);

    const closed = await listen(() => ({ status: 200 }));
    await new Promise<void>((resolve) => { servers[servers.length - 1]!.close(() => resolve()); });
    expect(await nodeReachable(closed.port)).toBe(false);
  });

  it('gives up on a node that accepts the connection but never answers once timeoutMs is set', async () => {
    const hung = await listen(() => ({ status: 200, hang: true }));
    const started = Date.now();
    expect(await nodeReachable(hung.port, { timeoutMs: 300 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(3_000);
  });
});

describe('restartNodeAndWait', () => {
  let out: string;
  let previousOut: string | undefined;

  beforeEach(() => {
    out = join(root, 'devnet-sh-call.txt');
    previousOut = process.env.FAKE_DEVNET_OUT;
    process.env.FAKE_DEVNET_OUT = out;
    mkdirSync(join(root, 'scripts'));
    writeFileSync(
      join(root, 'scripts/devnet.sh'),
      [
        '#!/usr/bin/env bash',
        '{',
        '  echo "args=$*"',
        '  echo "cwd=$(pwd -P)"',
        '  echo "HARDHAT_PORT=$HARDHAT_PORT"',
        '  echo "API_PORT_BASE=$API_PORT_BASE"',
        '  echo "LIBP2P_PORT_BASE=$LIBP2P_PORT_BASE"',
        '} > "$FAKE_DEVNET_OUT"',
      ].join('\n'),
    );
    chmodSync(join(root, 'scripts/devnet.sh'), 0o755);
    writeFileSync(
      join(paths.devnetDir, 'node1', 'config.json'),
      JSON.stringify({ apiPort: 9333, listenPort: 10222 }),
    );
  });

  afterEach(() => {
    if (previousOut === undefined) delete process.env.FAKE_DEVNET_OUT;
    else process.env.FAKE_DEVNET_OUT = previousOut;
  });

  it('runs `devnet.sh restart-node <n>` from the repo root with the devnet port environment, then waits for the node', async () => {
    const api = await listen(() => ({ status: 200 }));

    await restartNodeAndWait(paths, {
      num: 4,
      apiPort: api.port,
      rpcUrl: 'http://127.0.0.1:8777',
      label: 'node4 back',
      timeoutMs: 5_000,
      pollIntervalMs: 50,
      probe: { authToken: 'tok' },
    });

    expect(readFileSync(out, 'utf8').split('\n').filter(Boolean)).toEqual([
      'args=restart-node 4',
      // pwd -P resolves the tmpdir symlink (/var -> /private/var on macOS).
      `cwd=${spawnSync('bash', ['-c', 'pwd -P'], { cwd: root, encoding: 'utf8' }).stdout.trim()}`,
      'HARDHAT_PORT=8777',
      'API_PORT_BASE=9333',
      'LIBP2P_PORT_BASE=10222',
    ]);
    expect(api.seen.at(-1)?.authorization).toBe('Bearer tok');
  });

  it('stops the node\'s verified daemons first, then runs `devnet.sh restart-node`, which finds no live PID-file entry left', async () => {
    const worker = sleeper();
    const supervisor = sleeper();
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${supervisor.pid}\n`);
    // The stand-in script records what the real one would have found to signal.
    writeFileSync(
      join(root, 'scripts/devnet.sh'),
      [
        '#!/usr/bin/env bash',
        `for f in ${JSON.stringify(pidFile(4, 'daemon.pid'))} ${JSON.stringify(pidFile(4, 'devnet.pid'))}; do`,
        '  [ -f "$f" ] && echo "left=$f" >> "$FAKE_DEVNET_OUT"',
        'done',
        'echo "args=$*" >> "$FAKE_DEVNET_OUT"',
      ].join('\n'),
    );
    const api = await listen(() => ({ status: 200 }));

    await restartNodeAndWait(paths, {
      num: 4, apiPort: api.port, rpcUrl: DEFAULT_DEVNET_RPC, label: 'node4 back', timeoutMs: 5_000, pollIntervalMs: 50,
    });

    expect(await exited(worker)).toBe(true);
    expect(await exited(supervisor)).toBe(true);
    expect(readFileSync(out, 'utf8').split('\n').filter(Boolean)).toEqual(['args=restart-node 4']);
  });

  it('restarting right after a SIGKILL works: the killed daemon is a zombie for a moment, not an unrelated process', async () => {
    writeFileSync(pidFile(4, 'daemon.pid'), `${await zombie()}\n`);
    const api = await listen(() => ({ status: 200 }));

    await restartNodeAndWait(paths, {
      num: 4, apiPort: api.port, rpcUrl: DEFAULT_DEVNET_RPC, label: 'node4 back', timeoutMs: 5_000, pollIntervalMs: 50,
    });

    expect(readFileSync(out, 'utf8').split('\n')[0]).toBe('args=restart-node 4');
  });

  it('a live unrelated PID in devnet.pid rejects the restart before devnet.sh runs, and leaves it and the legitimate worker alive', async () => {
    const worker = sleeper();
    const unrelated = sleeper({ plain: true }); // a recycled number
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${unrelated.pid}\n`);
    const api = await listen(() => ({ status: 200 }));

    await expect(
      restartNodeAndWait(paths, {
        num: 4, apiPort: api.port, rpcUrl: DEFAULT_DEVNET_RPC, label: 'node4 back', timeoutMs: 1_000, pollIntervalMs: 50,
      }),
    ).rejects.toThrow(`node4: devnet.pid lists pid ${unrelated.pid}, which is alive but is not a DKG daemon`);

    expect(existsSync(out), 'devnet.sh must not run, its stop phase would signal the recycled PID').toBe(false);
    expect(api.seen).toEqual([]);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(pidAlive(unrelated.pid!)).toBe(true);
    expect(pidAlive(worker.pid!)).toBe(true);
  });

  it('polls until the node answers, and fails with the label and the timeout when it never does', async () => {
    let answers = 0;
    const flaky = await listen(() => ({ status: ++answers < 3 ? 503 : 200 }));
    await restartNodeAndWait(paths, {
      num: 4, apiPort: flaky.port, rpcUrl: DEFAULT_DEVNET_RPC, label: 'node4 back', timeoutMs: 5_000, pollIntervalMs: 20,
    });
    expect(answers).toBeGreaterThanOrEqual(3);

    const down = await listen(() => ({ status: 503 }));
    await expect(
      restartNodeAndWait(paths, {
        num: 4, apiPort: down.port, rpcUrl: DEFAULT_DEVNET_RPC, label: 'node4 never back', timeoutMs: 300, pollIntervalMs: 50,
      }),
    ).rejects.toThrow('timed out after 300ms waiting for: node4 never back');
  });

  it('does not wait on a node when devnet.sh itself fails', async () => {
    writeFileSync(join(root, 'scripts/devnet.sh'), '#!/usr/bin/env bash\nexit 3\n');
    const api = await listen(() => ({ status: 200 }));
    await expect(
      restartNodeAndWait(paths, {
        num: 4, apiPort: api.port, rpcUrl: DEFAULT_DEVNET_RPC, label: 'x', timeoutMs: 1_000, pollIntervalMs: 50,
      }),
    ).rejects.toThrow();
    expect(api.seen).toEqual([]);
  });
});
