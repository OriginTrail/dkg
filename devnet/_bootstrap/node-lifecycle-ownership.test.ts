import { inspectPsProcessSync, type SyncProcessInspector } from '../../packages/cli/src/daemon/process-probe.js';
import { planDevnetShutdown, executeDevnetShutdown, parseProcessInventory, collectDevnetNodePids } from '../../scripts/lib/devnet-node-process-control.js';
import { describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clearDeadNodePidFiles, isDaemonOfCheckout, parsePid, pidAlive, processStateIsGone, readNodePidEntries, readNodePids, readProcessState, sigkillNodeProcesses, sigkillProcesses, verifiedNodeProcesses, stopNodeProcesses, verifiedNodePids, waitForPidsGone } from './node-lifecycle.js';
import { root, paths, children, pidFile, sleeper, zombie, deadPid, exited, processIdentity } from './node-lifecycle-fixture.js';

describe('PID files', () => {
  it('parsePid reads a pid and returns null for anything that is not one', () => {
    expect(parsePid('12345\n')).toBe(12345);
    expect(parsePid('  42  ')).toBe(42);
    expect(parsePid('')).toBeNull();
    expect(parsePid('not-a-pid')).toBeNull();
    for (const value of ['-1', '0', '42abc', '1.5', '9007199254740992']) {
      expect(parsePid(value)).toBeNull();
    }
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

  it('sigkillProcesses kills immediately and tolerates a PID that is already gone', async () => {
    const victim = sleeper();
    expect(() => sigkillProcesses([{ ...processIdentity(victim.pid!), pid: deadPid() }, processIdentity(victim.pid!)])).not.toThrow();
    expect(await exited(victim)).toBe(true);
  });

  it('waitForPidsGone resolves true once the processes are gone and false if one survives the timeout', async () => {
    const victim = sleeper();
    const survivor = sleeper();
    sigkillProcesses([processIdentity(victim.pid!)]);
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
    const reader: SyncProcessInspector = pid => {
      const observed = inspectPsProcessSync(pid);
      if (observed.state !== 'running') return observed;
      read.push(pid);
      return { state: 'running', process: { ...observed.process, command: `${binary} ${join(root, 'packages/cli/dist/cli.js')} daemon-worker` } };
    };

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
    expect(() => verifiedNodePids(paths, 4, () => ({ state: 'unknown', reason: 'unreadable test identity' }))).toThrow(`daemon.pid lists pid ${worker.pid}, which is alive but whose command line cannot be read`);
    expect(() => sigkillNodeProcesses(paths, 4, { inspect: () => ({ state: 'unknown', reason: 'unreadable test identity' }) })).toThrow(/cannot be read/);
    expect(pidAlive(worker.pid!)).toBe(true);
  });

  it('the error never includes the refused process\'s command line', () => {
    const recycled = sleeper({ plain: true });
    writeFileSync(pidFile(4, 'daemon.pid'), `${recycled.pid}\n`);
    const secret = 'super-secret-token-in-argv';
    expect(() => verifiedNodePids(paths, 4, () => ({ state: 'running', process: { ...processIdentity(recycled.pid!), command: `/usr/bin/tool --token ${secret}` } }))).toThrow(/not a DKG daemon/);
    try { verifiedNodePids(paths, 4, () => ({ state: 'running', process: { ...processIdentity(recycled.pid!), command: `/usr/bin/tool --token ${secret}` } })); } catch (err) {
      expect((err as Error).message).not.toContain(secret);
    }
  });

  it('with the real `ps`: a daemon-shaped process is verified and killed, under either spelling of the root', async () => {
    const real = realpathSync(root);
    for (const entry of new Set([join(root, 'packages/cli/dist/cli.js'), join(real, 'packages/cli/dist/cli.js')])) {
      const worker = sleeper({ entry });
      writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
      expect(processIdentity(worker.pid!).command).toContain(`${entry} daemon-worker`);
      expect(verifiedNodePids(paths, 4)).toEqual([worker.pid]);
      expect(sigkillNodeProcesses(paths, 4)).toEqual([worker.pid]);
      expect(await exited(worker)).toBe(true);
    }
  });

  it('with the real `ps`: inspection returns a complete live identity and distinguishes gone processes', () => {
    expect(inspectPsProcessSync(process.pid)).toMatchObject({ state: 'running', process: { command: expect.stringContaining('node'), start: expect.any(String), ppid: expect.any(Number) } });
    expect(inspectPsProcessSync(deadPid())).toEqual({ state: 'gone' });
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

  it('a time-critical caller verifies before its wait and signals the verified PIDs at the kill point: the original process identities are rechecked', async () => {
    const worker = sleeper();
    const supervisor = sleeper();
    const bystander = sleeper(); // not listed anywhere
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${supervisor.pid}\n`);
    const verified = verifiedNodeProcesses(paths, 4);
    expect(verified.map(record => record.pid)).toEqual([worker.pid, supervisor.pid]);

    // One of them exits between the check and the kill: it is not reported as signalled.
    supervisor.kill('SIGKILL');
    expect(await exited(supervisor)).toBe(true);
    const gone = deadPid();
    expect(sigkillProcesses([...verified, { ...verified[0]!, pid: gone }])).toEqual([worker.pid]);
    expect(await exited(worker)).toBe(true);
    expect(worker.signalCode).toBe('SIGKILL');
    expect(pidAlive(bystander.pid!)).toBe(true);
    // An empty list signals nothing and does not fall back to the PID files.
    writeFileSync(pidFile(4, 'daemon.pid'), `${bystander.pid}\n`);
    expect(sigkillProcesses([])).toEqual([]);
    expect(pidAlive(bystander.pid!)).toBe(true);
  });
});

describe('one validated devnet shutdown plan', () => {
  it('accepts only the node-specific configured alternate checkout', async () => {
    const entry = join(root, '.devnet-versions', 'previous', 'packages/cli/dist/cli.js');
    const worker = sleeper({ entry });
    const other = sleeper({ entry: join(root, '.devnet-versions', 'unrelated', 'packages/cli/dist/cli.js') });
    writeFileSync(pidFile(4, 'daemon.pid'), String(worker.pid));
    writeFileSync(pidFile(5, 'daemon.pid'), String(other.pid));
    const configured = { ...paths, nodeCliEntries: { 4: entry } };
    expect(verifiedNodePids(configured, 4)).toEqual([worker.pid]);
    expect(() => planDevnetShutdown(configured, [4, 5])).toThrow(/not a DKG daemon/);
    expect(pidAlive(worker.pid!)).toBe(true); // Complete preflight rejected before any signal.
    await stopNodeProcesses(configured, 4);
    expect(await exited(worker)).toBe(true);
    expect(pidAlive(other.pid!)).toBe(true);
  });

  it('planning retains the exact identity that passed PID-file validation', async () => {
    const worker = sleeper(); writeFileSync(pidFile(4, 'daemon.pid'), String(worker.pid));
    const original = processIdentity(worker.pid!).command;
    let reads = 0;
    const reader: SyncProcessInspector = pid => pid === worker.pid
      ? { state: 'running', process: { ...processIdentity(pid), command: ++reads === 1 ? original : 'unrelated replacement process' } } : inspectPsProcessSync(pid);
    const plan = planDevnetShutdown(paths, [4], reader);
    expect(reads).toBe(1);
    expect(plan.identities.get(worker.pid!)).toMatchObject({ command: original });
    await expect(executeDevnetShutdown(plan, { graceMs: 0, killWaitMs: 0 })).rejects.toThrow('did not stop');
    expect(pidAlive(worker.pid!)).toBe(true);
    expect(readFileSync(pidFile(4, 'daemon.pid'), 'utf8')).toBe(String(worker.pid));
  });

  it('leaves an identity changed after planning alive and preserves its PID file', async () => {
    const worker = sleeper(); writeFileSync(pidFile(4, 'daemon.pid'), String(worker.pid));
    const original = processIdentity(worker.pid!).command;
    let identity = original;
    const reader: SyncProcessInspector = pid => pid === worker.pid ? { state: 'running', process: { ...processIdentity(pid), command: identity } } : inspectPsProcessSync(pid);
    const plan = planDevnetShutdown(paths, [4], reader);
    identity = `${original} recycled`;
    await expect(executeDevnetShutdown(plan, { graceMs: 0, killWaitMs: 0 })).rejects.toThrow('did not stop');
    expect(pidAlive(worker.pid!)).toBe(true);
    expect(readFileSync(pidFile(4, 'daemon.pid'), 'utf8')).toBe(String(worker.pid));
  });

  it('leaves an identity changed during grace alive instead of escalating to KILL', async () => {
    const marker = join(root, 'term-observed');
    const worker = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => require('node:fs').writeFileSync(process.argv[1], 'term')); console.log('ready'); setInterval(() => {}, 1000)",
      marker, join(root, 'packages/cli/dist/cli.js'), 'daemon-worker'], { stdio: ['ignore', 'pipe', 'ignore'] });
    children.push(worker); await new Promise(resolve => worker.stdout!.once('data', resolve));
    writeFileSync(pidFile(4, 'daemon.pid'), String(worker.pid));
    const original = processIdentity(worker.pid!).command;
    const reader: SyncProcessInspector = pid => pid === worker.pid && existsSync(marker) ? { state: 'running', process: { ...processIdentity(pid), command: `${original} recycled` } } : inspectPsProcessSync(pid);
    const plan = planDevnetShutdown(paths, [4], reader);
    await expect(executeDevnetShutdown(plan, { graceMs: 200, killWaitMs: 0 })).rejects.toThrow('did not stop');
    expect(readFileSync(marker, 'utf8')).toBe('term');
    expect(pidAlive(worker.pid!)).toBe(true);
    expect(readFileSync(pidFile(4, 'daemon.pid'), 'utf8')).toBe(String(worker.pid));
  });

  it('selects owned processes and descendants from normalized supplied inventory', () => {
    const daemon = sleeper(), detached = sleeper(), descendant = sleeper(), bystander = sleeper(), otherHome = sleeper();
    writeFileSync(pidFile(4, 'daemon.pid'), String(daemon.pid));
    const home = join(paths.devnetDir, 'node4');
    const rows = [
      [daemon.pid!, 1, '/Program Files/node', processIdentity(daemon.pid!).command],
      [detached.pid!, 1, '/tools/oxigraph-v1', `oxigraph --path ${home}/store`],
      [descendant.pid!, daemon.pid!, '/tools/helper', 'helper'],
      [bystander.pid!, 1, '/usr/bin/tail', `tail -f ${home}/daemon.log`],
      [otherHome.pid!, 1, '/usr/bin/node', `node --path ${home}0/store`],
    ] as const;
    const inventory = parseProcessInventory(rows.map(([pid, , , command]) => `${pid} ${command}`).join('\n'),
      rows.map(([pid, parent, executable]) => `${pid} ${parent} ${executable}`).join('\n'),
      rows.map(([pid, parent, , command]) => `${pid} ${parent} S ${processIdentity(pid).start} ${command}`).join('\n'));
    expect(inventory.records.get(daemon.pid!)?.executable).toBe('node');
    expect(inventory.childrenByParent.get(daemon.pid!)).toEqual([descendant.pid]);
    const consistent: SyncProcessInspector = pid => {
      const record = inventory.records.get(pid);
      return record ? { state: 'running', process: record } : { state: 'gone' };
    };
    expect(collectDevnetNodePids(paths, 4, consistent, inventory).sort()).toEqual([daemon.pid, detached.pid, descendant.pid].sort());
    expect(pidAlive(bystander.pid!)).toBe(true);
    // The real command differs from both synthetic detached/helper inventory identities.
    expect(collectDevnetNodePids(paths, 4, inspectPsProcessSync, inventory)).toEqual([daemon.pid]);
    expect(pidAlive(detached.pid!)).toBe(true);
    expect(pidAlive(descendant.pid!)).toBe(true);
  });

  it('refuses a recycled process at the delayed crash-test kill boundary', () => {
    const worker = sleeper(); writeFileSync(pidFile(4, 'daemon.pid'), String(worker.pid));
    const owned = verifiedNodeProcesses(paths, 4);
    expect(sigkillProcesses(owned, pid => {
      const observed = inspectPsProcessSync(pid);
      return observed.state === 'running' ? { state: 'running', process: { ...observed.process, start: 'replacement-start' } } : observed;
    })).toEqual([]);
    expect(pidAlive(worker.pid!)).toBe(true);
    expect(readFileSync(pidFile(4, 'daemon.pid'), 'utf8')).toBe(String(worker.pid));
  });

  it('signals all stubborn nodes before their shared grace period', async () => {
    const ready: Promise<void>[] = [];
    const workers = [1, 2, 3].map(num => {
      const marker = join(root, `term-${num}`);
      const child = spawn(process.execPath, ['-e',
        `process.on('SIGTERM', () => require('node:fs').writeFileSync(process.argv[1], String(Date.now()))); console.log('ready'); setInterval(() => {}, 1000)`,
        marker, join(root, 'packages/cli/dist/cli.js'), 'daemon-worker'], { stdio: ['ignore', 'pipe', 'ignore'] });
      children.push(child);
      ready.push(new Promise(resolve => child.stdout!.once('data', () => resolve())));
      writeFileSync(pidFile(num, 'daemon.pid'), String(child.pid));
      return child;
    });
    await Promise.all(ready);
    const plan = planDevnetShutdown(paths, [1, 2, 3]);
    await executeDevnetShutdown(plan, { graceMs: 700, killWaitMs: 5000 });
    const times = [1, 2, 3].map(num => Number(readFileSync(join(root, `term-${num}`), 'utf8')));
    expect(Math.max(...times) - Math.min(...times)).toBeLessThan(700);
    for (const worker of workers) { expect(await exited(worker)).toBe(true); expect(worker.signalCode).toBe('SIGKILL'); }
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

