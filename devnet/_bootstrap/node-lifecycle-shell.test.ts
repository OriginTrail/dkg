import { afterEach, describe, expect, it } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DEVNET_RPC, pidAlive, restartNodeAndWait } from './node-lifecycle.js';
import { root, paths, children, pidFile, sleeper, exited, listen } from './node-lifecycle-fixture.js';

describe('devnet.sh stop phase: which processes that mention the node home it signals', () => {
  const devnetSh = join(import.meta.dirname, '../../scripts/devnet.sh');
  const home = () => join(paths.devnetDir, 'node4');
  const env = () => ({ ...process.env, DEVNET_DIR: paths.devnetDir });
  const strayPids: number[] = [];

  afterEach(() => {
    for (const pid of strayPids.splice(0)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ }
    }
  });

  /** Sources the real script and runs `body`, without blocking this process (children of the test must still be reaped). */
  const run = (body: string, extraEnv: Record<string, string> = {}) =>
    new Promise<{ status: number | null; stdout: string; stderr: string }>((resolve, reject) => {
      const bash = spawn('bash', ['-c', `DEVNET_SOURCE_ONLY=1 source "${devnetSh}"; ${body}`], { env: { ...env(), ...extraEnv } });
      let stdout = '';
      let stderr = '';
      bash.stdout.on('data', (chunk) => { stdout += chunk; });
      bash.stderr.on('data', (chunk) => { stderr += chunk; });
      bash.once('error', reject);
      bash.once('close', (status) => resolve({ status, stdout, stderr }));
    });

  /** A `tail -f <home>/daemon.log`: names the home, is not part of the node. */
  function logTail(): ChildProcess {
    writeFileSync(join(home(), 'daemon.log'), 'line\n');
    const child = spawn('tail', ['-f', join(home(), 'daemon.log')], { stdio: 'ignore' });
    children.push(child);
    return child;
  }

  /** A node process that mentions the home in its arguments (a daemon helper). */
  const homeNode = () => sleeper({ argv: [join(home(), 'work')] });

  /** A process named like the managed store binary (`oxigraph-v<version>`) working in the home. */
  function homeStore(): ChildProcess {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', join(home(), 'store')], {
      argv0: 'oxigraph-v0.0.0',
      stdio: 'ignore',
    });
    children.push(child);
    return child;
  }

  const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null && pidAlive(child.pid!);
  it('collects and stops harmlessly before a devnet directory exists', async () => {
    rmSync(paths.devnetDir, { recursive: true, force: true });
    expect(await run('collect_devnet_node_pids')).toMatchObject({ status: 0, stdout: '\n' });
    expect(await run('stop_devnet_node_processes')).toMatchObject({ status: 0 });
    // Other filesystem faults remain visible.
    writeFileSync(paths.devnetDir, 'not a directory');
    expect((await run('collect_devnet_node_pids')).status).not.toBe(0);
  });

  const collected = async () => (await run('collect_devnet_node_pids 4')).stdout.split(/\s+/).filter(Boolean).map(Number);

  it('stops an unrecorded legacy alternate using only its configured node version', async () => {
    const versions = join(root, 'legacy versions');
    const entry = join(versions, 'previous', 'packages/cli/dist/cli.js');
    const worker = sleeper({ entry }); writeFileSync(pidFile(4, 'daemon.pid'), String(worker.pid));
    const result = await run('stop_devnet_node_processes 4', {
      DEVNET_VERSIONS_DIR: versions, DEVNET_VERSION_LAYOUT: 'all:current,4:previous',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(await exited(worker)).toBe(true);
    expect(existsSync(pidFile(4, 'daemon.pid'))).toBe(false);
  });

  it('rejects an unrecorded alternate that is configured for another node', async () => {
    const versions = join(root, 'legacy versions');
    const worker = sleeper({ entry: join(versions, 'previous', 'packages/cli/dist/cli.js') });
    writeFileSync(pidFile(4, 'daemon.pid'), String(worker.pid));
    const result = await run('stop_devnet_node_processes 4', {
      DEVNET_VERSIONS_DIR: versions, DEVNET_VERSION_LAYOUT: 'all:current,5:previous',
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('not a DKG daemon');
    expect(pidAlive(worker.pid!)).toBe(true);
    expect(existsSync(pidFile(4, 'daemon.pid'))).toBe(true);
  });

  it('stops a recorded alternate-version daemon in a separate invocation with a changed layout', async () => {
    const entry = join(root, 'alternate build', 'packages/cli/dist/cli.js');
    const worker = sleeper({ entry }); writeFileSync(pidFile(4, 'daemon.pid'), String(worker.pid));
    expect(await run('record_node_cli_entry 4 "$TEST_CLI_ENTRY"', {
      TEST_CLI_ENTRY: entry, DEVNET_VERSION_LAYOUT: 'all:current,edges:prev',
    })).toMatchObject({ status: 0 });
    const result = await run('stop_devnet_node_processes 4', { DEVNET_VERSION_LAYOUT: 'all:current,4:unrelated' });
    expect(result.status, result.stderr).toBe(0);
    expect(await exited(worker)).toBe(true);
    expect(existsSync(pidFile(4, 'daemon.pid'))).toBe(false);
  });

  it('lists a node process and a managed store binary that mention the home, and not a log tail', async () => {
    const node = homeNode();
    const store = homeStore();
    const tail = logTail();
    const pids = await collected();
    expect(pids).toEqual(expect.arrayContaining([node.pid, store.pid]));
    expect(pids).not.toContain(tail.pid);
  });

  it('lists a node process whose executable path contains a space (a checkout under a directory with a space in its name)', async () => {
    const spaced = join(root, 'my projects');
    mkdirSync(spaced);
    symlinkSync(process.execPath, join(spaced, 'node'));
    const child = spawn(join(spaced, 'node'), ['-e', 'setInterval(() => {}, 1000)', join(home(), 'work')], { stdio: 'ignore' });
    children.push(child);
    expect(await collected()).toContain(child.pid);
  });

  it('does not list a process that mentions another node\'s home', async () => {
    const other = sleeper({ argv: [join(paths.devnetDir, 'node5', 'work')] });
    expect(await collected()).not.toContain(other.pid);
  });

  it('stops the node\'s own processes and leaves the log tail running', async () => {
    const node = homeNode();
    const store = homeStore();
    const tail = logTail();
    const result = await run('stop_devnet_node_processes 4');
    expect(result.status, result.stderr).toBe(0);
    expect(await exited(node), 'the node process is reaped').toBe(true);
    expect(await exited(store), 'the managed store binary is reaped').toBe(true);
    expect(alive(tail), 'the log tail is a bystander').toBe(true);
  });

  it('restartNodeAndWait, through the real script\'s restart-node, leaves a log tail alone', async () => {
    // The real script's restart-node with only start_node replaced by a recorder.
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(
      join(root, 'scripts/devnet.sh'),
      [
        '#!/usr/bin/env bash',
        `export DEVNET_DIR="${paths.devnetDir}"`,
        `DEVNET_SOURCE_ONLY=1 source "${devnetSh}"`,
        'start_node() { echo "start_node $1" >> "$DEVNET_DIR/start-node-called"; }',
        'if [ "$1" = start-node ]; then start_node "$2"; else cmd_restart_node "$@"; fi',
      ].join('\n'),
    );
    writeFileSync(join(paths.devnetDir, 'node1', 'config.json'), JSON.stringify({ apiPort: 9333, listenPort: 10222 }));
    // restartNodeAndWait blocks this process while the script runs, so a child of ours that the
    // script kills would stay a zombie (the script waits on it) until it returns. A node's own
    // processes are not children of the caller: start the store from a launcher that exits.
    const launcher = spawnSync(
      process.execPath,
      ['-e', "const c = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', process.argv[1]], { argv0: 'oxigraph-v0.0.0', detached: true, stdio: 'ignore' }); c.unref(); console.log(c.pid)", join(home(), 'store')],
      { encoding: 'utf8' },
    );
    const storePid = Number(launcher.stdout.trim());
    strayPids.push(storePid);
    expect(pidAlive(storePid), 'the stand-in store must be running before the restart').toBe(true);
    const tail = logTail();
    const api = await listen(() => ({ status: 200 }));
    await restartNodeAndWait(paths, {
      num: 4, apiPort: api.port, rpcUrl: DEFAULT_DEVNET_RPC, label: 'x', timeoutMs: 5_000, pollIntervalMs: 50,
    });
    expect(readFileSync(join(paths.devnetDir, 'start-node-called'), 'utf8')).toBe('start_node 4\n');
    expect(pidAlive(storePid), 'the managed store binary is reaped by the stop phase').toBe(false);
    expect(alive(tail), 'the log tail survives the restart').toBe(true);
  });
});

