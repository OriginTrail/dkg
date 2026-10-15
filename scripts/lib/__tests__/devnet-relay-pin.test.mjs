import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DEVNET = fileURLToPath(new URL('../../devnet.sh', import.meta.url));
const NODE1 = '/ip4/127.0.0.1/tcp/10001/p2p/12D3KooWnode1';
const NODE2 = '/ip4/127.0.0.1/tcp/10002/p2p/12D3KooWnode2';

/** Runs `script` with devnet.sh sourced, on a devnet folder that holds node 1's address only. */
function devnet(t, script, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-relay-pin-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'node1'), { recursive: true });
  writeFileSync(join(dir, 'node1', 'multiaddr'), `${NODE1}\n`);
  const result = spawnSync('bash', ['-c', `source "$1"\n${script}`, 'bash', DEVNET], {
    encoding: 'utf8',
    env: { ...process.env, DEVNET_SOURCE_ONLY: '1', DEVNET_DIR: dir, DEVNET_ADDNODE_CONFIG_OVERRIDES: '', ...env },
  });
  return { dir, status: result.status, stdout: result.stdout, output: result.stdout + result.stderr };
}

// `devnet.sh addnode 7 edge` with the chain and the daemon stubbed out; the
// stubbed start records the relay the node would have started with.
const ADDNODE = `
  refresh_hardhat_pidfile() { echo 1; }
  create_node_config() { mkdir -p "$DEVNET_DIR/node$1"; printf '{}' > "$DEVNET_DIR/node$1/config.json"; }
  start_node() { node_relay_arg "$1" > "$DEVNET_DIR/started-relay"; }
  cmd_addnode addnode 7 edge
`;
const read = (dir, file) => readFileSync(join(dir, file), 'utf8').trim();

test('a node starts with node 1 as its relay, and node 1 with none', t => {
  const { status, stdout, output } = devnet(t, 'printf "[%s][%s]" "$(node_relay_arg 1)" "$(node_relay_arg 7)"');
  assert.equal(status, 0, output);
  assert.equal(stdout, `[][${NODE1}]`);
});

test('a relay among the addnode overrides is the node\'s relay on its first start and on every later one', t => {
  const overrides = JSON.stringify({ relay: NODE2, announceAddresses: ['/ip4/127.0.0.1/tcp/9', `${NODE2}/p2p-circuit`] });
  const { dir, status, output } = devnet(t, `${ADDNODE}\nnode_relay_arg 7 > "$DEVNET_DIR/restarted-relay"`, { DEVNET_ADDNODE_CONFIG_OVERRIDES: overrides });
  assert.equal(status, 0, output);
  assert.equal(read(dir, 'started-relay'), NODE2);
  // restart-node starts the node through start_node again.
  assert.equal(read(dir, 'restarted-relay'), NODE2);
  assert.equal(read(dir, 'node7/relay.pinned'), NODE2);
});

test('overrides without a usable relay pin nothing, and the node keeps node 1', t => {
  for (const overrides of ['', JSON.stringify({ announceAddresses: [] }), JSON.stringify({ relay: '' }), JSON.stringify({ relay: 7 })]) {
    const { dir, status, output } = devnet(t, ADDNODE, { DEVNET_ADDNODE_CONFIG_OVERRIDES: overrides });
    assert.equal(status, 0, `${overrides}: ${output}`);
    assert.equal(existsSync(join(dir, 'node7', 'relay.pinned')), false, overrides);
    assert.equal(read(dir, 'started-relay'), NODE1, overrides);
  }
});
