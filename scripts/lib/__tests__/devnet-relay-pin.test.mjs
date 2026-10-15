import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DEVNET = fileURLToPath(new URL('../../devnet.sh', import.meta.url));
const NODE1 = '/ip4/127.0.0.1/tcp/10001/p2p/12D3KooWnode1';
const NODE2 = '/ip4/127.0.0.1/tcp/10002/p2p/12D3KooWnode2';

/**
 * Runs `script` with devnet.sh sourced on a devnet folder that holds Cores 1
 * and 2. Everything of devnet.sh runs for real (addnode, start_node with its
 * config patch, restart-node) except the daemon boundary: the CLI a node is
 * launched with is a stub that records the relay its config.json holds at
 * that launch, and `curl` answers for the node so start_node finds it ready.
 */
function devnet(t, script, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-relay-pin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const [node, address] of [[1, NODE1], [2, NODE2]]) {
    mkdirSync(join(dir, `node${node}`), { recursive: true });
    writeFileSync(join(dir, `node${node}`, 'multiaddr'), `${address}\n`);
    writeFileSync(join(dir, `node${node}`, 'config.json'), JSON.stringify({ nodeRole: 'core' }));
  }
  writeFileSync(join(dir, 'node1', 'auth.token'), '# devnet\nfixture-token\n');
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'bin', 'curl'), '#!/bin/bash\nprintf \'{"peerId":"12D3KooWstub"}\'\n', { mode: 0o755 });
  writeFileSync(join(dir, 'stub-cli.mjs'), [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const home = process.env.DKG_HOME;",
    "const config = readFileSync(`${home}/config.json`, 'utf8');",
    "appendFileSync(`${home}/launched-with-relay`, `${JSON.parse(config).relay}\\n`);",
    "appendFileSync(`${home}/launched-with-config`, `${JSON.stringify(JSON.parse(config))}\\n`);",
  ].join('\n'));
  const result = spawnSync('bash', ['-c', `source "$1"
    refresh_hardhat_pidfile() { echo 1; }
    create_node_config() { mkdir -p "$DEVNET_DIR/node$1"; printf '{"nodeRole":"edge","relay":"none"}' > "$DEVNET_DIR/node$1/config.json"; }
    node_cli_entry() { echo "$STUB_CLI"; }
    refresh_node_pidfile() { :; }
    stop_devnet_node_processes() { :; }
    ${script}`, 'bash', DEVNET], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      PATH: `${join(dir, 'bin')}:${process.env.PATH}`,
      DEVNET_SOURCE_ONLY: '1',
      DEVNET_DIR: dir,
      STUB_CLI: join(dir, 'stub-cli.mjs'),
      DEVNET_NODE_READY_TIMEOUT: '2',
      DEVNET_ADDNODE_CONFIG_OVERRIDES: '',
      ...env,
    },
  });
  return { dir, status: result.status, output: `${result.stdout}${result.stderr}` };
}
const launches = (dir, node) => readFileSync(join(dir, `node${node}`, 'launched-with-relay'), 'utf8').trim().split('\n');
const launchedConfigs = (dir, node) => readFileSync(join(dir, `node${node}`, 'launched-with-config'), 'utf8').trim().split('\n').map(line => JSON.parse(line));
const configRelay = (dir, node) => JSON.parse(readFileSync(join(dir, `node${node}`, 'config.json'), 'utf8')).relay;
const ADD_AND_RESTART = node => `cmd_addnode addnode ${node} edge && cmd_restart_node restart-node ${node}`;

test('a node pinned to node 2 is launched with node 2 as its relay on its first start and after a restart', t => {
  const overrides = JSON.stringify({ relay: NODE2, announceAddresses: ['/ip4/127.0.0.1/tcp/9', `${NODE2}/p2p-circuit`] });
  const { dir, status, output } = devnet(t, ADD_AND_RESTART(7), { DEVNET_ADDNODE_CONFIG_OVERRIDES: overrides });
  assert.equal(status, 0, output);
  // What the daemon read from its config.json at each launch, after start_node's own config patch.
  assert.deepEqual(launches(dir, 7), [NODE2, NODE2], output);
  assert.equal(configRelay(dir, 7), NODE2);
  assert.match(output, /Node 7 restarted\./);
});

test('a node without a relay among its overrides is launched with node 1 on its first start and after a restart', t => {
  for (const overrides of ['', JSON.stringify({ announceAddresses: ['/ip4/127.0.0.1/tcp/9'] })]) {
    const { dir, status, output } = devnet(t, ADD_AND_RESTART(8), { DEVNET_ADDNODE_CONFIG_OVERRIDES: overrides });
    assert.equal(status, 0, `${overrides}: ${output}`);
    assert.deepEqual(launches(dir, 8), [NODE1, NODE1], overrides);
  }
});

test('every override wins over what start_node generates, on every start', t => {
  // start_node rewrites bootstrapPeers from the Cores on each start, as it does the relay.
  const pinned = ['/ip4/127.0.0.1/tcp/10002/p2p/12D3KooWnode2'];
  const overrides = JSON.stringify({ bootstrapPeers: pinned, relay: NODE2 });
  const { dir, status, output } = devnet(t, ADD_AND_RESTART(9), { DEVNET_ADDNODE_CONFIG_OVERRIDES: overrides });
  assert.equal(status, 0, output);
  const config = JSON.parse(readFileSync(join(dir, 'node9', 'config.json'), 'utf8'));
  assert.deepEqual(config.bootstrapPeers, pinned);
  assert.equal(config.relay, NODE2);
  // Without overrides the generated value stands: both Cores.
  const plain = devnet(t, ADD_AND_RESTART(9));
  assert.equal(plain.status, 0, plain.output);
  assert.deepEqual(JSON.parse(readFileSync(join(plain.dir, 'node9', 'config.json'), 'utf8')).bootstrapPeers, [NODE1, NODE2]);
});

test('the overrides shape the defaults start_node derives, and the first start and a restart launch the same config', t => {
  // An overridden nodeRole: no Edge snapshot trust is derived for a node that is a Core.
  const core = devnet(t, ADD_AND_RESTART(7), { DEVNET_ADDNODE_CONFIG_OVERRIDES: JSON.stringify({ nodeRole: 'core' }) });
  assert.equal(core.status, 0, core.output);
  const coreLaunches = launchedConfigs(core.dir, 7);
  assert.equal(coreLaunches.length, 2, core.output);
  assert.equal(coreLaunches[0].nodeRole, 'core');
  assert.equal(coreLaunches[0].authorityIndex, undefined);
  assert.deepEqual(coreLaunches[1], coreLaunches[0]);
  // An overridden authorityIndex is the one the node starts with; without it an Edge gets the derived one.
  const pinned = { mode: 'core-snapshot', trustedCorePeers: [NODE2], maxTailBlocks: 10 };
  const custom = devnet(t, ADD_AND_RESTART(8), { DEVNET_ADDNODE_CONFIG_OVERRIDES: JSON.stringify({ authorityIndex: pinned, relay: NODE2 }) });
  assert.equal(custom.status, 0, custom.output);
  const customLaunches = launchedConfigs(custom.dir, 8);
  assert.deepEqual(customLaunches.map(config => [config.authorityIndex, config.relay]), [[pinned, NODE2], [pinned, NODE2]]);
  assert.deepEqual(customLaunches[1], customLaunches[0]);
  const plain = devnet(t, ADD_AND_RESTART(9));
  assert.equal(plain.status, 0, plain.output);
  const plainLaunches = launchedConfigs(plain.dir, 9);
  assert.deepEqual(plainLaunches[0].authorityIndex, { mode: 'core-snapshot', trustedCorePeers: [NODE1, NODE2], maxTailBlocks: 2000 });
  assert.deepEqual(plainLaunches[1], plainLaunches[0]);
});
