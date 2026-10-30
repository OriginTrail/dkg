import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_DEVNET_RPC, devnetPortEnv, nodeReachable, pidAlive, restartNodeAndWait, rpcUrlFromNode1Config } from './node-lifecycle.js';
import { root, paths, servers, pidFile, sleeper, zombie, exited, listen } from './node-lifecycle-fixture.js';

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
        '  echo "DEVNET_DIR=$DEVNET_DIR"',
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
      `DEVNET_DIR=${paths.devnetDir}`,
      'HARDHAT_PORT=8777',
      'API_PORT_BASE=9333',
      'LIBP2P_PORT_BASE=10222',
    ]);
    expect(api.seen.at(-1)?.authorization).toBe('Bearer tok');
  });

  function useCheckedRestart(): void {
    const realScript = join(import.meta.dirname, '../../scripts/devnet.sh');
    writeFileSync(join(paths.devnetDir, 'node4', '.devnet-cli-entry'), join(root, 'packages/cli/dist/cli.js'));
    writeFileSync(join(root, 'scripts/devnet.sh'), [
      '#!/usr/bin/env bash',
      `DEVNET_SOURCE_ONLY=1 source "${realScript}"`,
      'test "$1" = restart-node',
      'start_node() { echo "args=restart-node $1" >> "$FAKE_DEVNET_OUT"; }',
      'cmd_restart_node "$@"',
    ].join('\n'));
  }

  it('lets the checked restart command stop the node daemons before starting it', async () => {
    const worker = sleeper();
    const supervisor = sleeper();
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${supervisor.pid}\n`);
    useCheckedRestart();
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
    useCheckedRestart();
    const api = await listen(() => ({ status: 200 }));

    await restartNodeAndWait(paths, {
      num: 4, apiPort: api.port, rpcUrl: DEFAULT_DEVNET_RPC, label: 'node4 back', timeoutMs: 5_000, pollIntervalMs: 50,
    });

    expect(readFileSync(out, 'utf8').split('\n')[0]).toBe('args=restart-node 4');
  });

  it('a live unrelated PID makes the checked restart refuse before starting or signaling anything', async () => {
    const worker = sleeper();
    const unrelated = sleeper({ plain: true }); // a recycled number
    useCheckedRestart();
    writeFileSync(pidFile(4, 'daemon.pid'), `${worker.pid}\n`);
    writeFileSync(pidFile(4, 'devnet.pid'), `${unrelated.pid}\n`);
    const api = await listen(() => ({ status: 200 }));

    await expect(
      restartNodeAndWait(paths, {
        num: 4, apiPort: api.port, rpcUrl: DEFAULT_DEVNET_RPC, label: 'node4 back', timeoutMs: 1_000, pollIntervalMs: 50,
      }),
    ).rejects.toThrow(`node4: devnet.pid lists pid ${unrelated.pid}, which is alive but is not a DKG daemon`);

    expect(existsSync(out), 'checked shutdown must refuse before start_node').toBe(false);
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

// The stop phase of `devnet.sh restart-node` (`stop_devnet_node_processes`) reaps the node's
// processes by scanning the process table for the node's home directory. It must find the
// node's own processes (daemon, helpers, a managed store binary) and nothing else: a
// `tail -f <home>/daemon.log` (what `devnet.sh logs 4` runs) only mentions the home.
