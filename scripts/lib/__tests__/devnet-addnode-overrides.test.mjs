import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DEVNET = fileURLToPath(new URL('../../devnet.sh', import.meta.url));

/**
 * `devnet.sh addnode 7 edge` with the chain, the wallets and the daemon stubbed
 * out: what is left is the order of the steps and the config the daemon would
 * have started with.
 */
function addnode(t, overrides) {
  const dir = mkdtempSync(join(tmpdir(), 'dkg-addnode-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const result = spawnSync('bash', ['-c', `
    source "$1"
    refresh_hardhat_pidfile() { echo 1; }
    create_node_config() {
      mkdir -p "$DEVNET_DIR/node$1"
      printf '%s' '{"name":"devnet-node-7","nodeRole":"edge","relay":"none","listenPort":10007}' > "$DEVNET_DIR/node$1/config.json"
    }
    # The daemon reads its config when it starts: record what it would have read.
    start_node() { cp "$DEVNET_DIR/node$1/config.json" "$DEVNET_DIR/started-with.json"; }
    cmd_addnode addnode 7 edge
  `, 'bash', DEVNET], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVNET_SOURCE_ONLY: '1',
      DEVNET_DIR: dir,
      DEVNET_ADDNODE_CONFIG_OVERRIDES: overrides,
    },
  });
  const startedWith = join(dir, 'started-with.json');
  return {
    status: result.status,
    output: result.stdout + result.stderr,
    startedWith: existsSync(startedWith) ? JSON.parse(readFileSync(startedWith, 'utf8')) : undefined,
    nodeDirectoryLeft: existsSync(join(dir, 'node7')),
  };
}

test('addnode starts the node with the generated config when no override is given', t => {
  const { status, output, startedWith } = addnode(t, undefined);
  assert.equal(status, 0, output);
  assert.deepEqual(startedWith, { name: 'devnet-node-7', nodeRole: 'edge', relay: 'none', listenPort: 10007 });
});

test('DEVNET_ADDNODE_CONFIG_OVERRIDES is in the config before the first start', t => {
  const announce = ['/ip4/127.0.0.1/tcp/9', '/ip4/127.0.0.1/tcp/10001/p2p/relay/p2p-circuit'];
  const { status, output, startedWith } = addnode(t, JSON.stringify({ announceAddresses: announce, listenPort: 20007 }));
  assert.equal(status, 0, output);
  // New members are added, members of the same name are replaced, the rest is kept.
  assert.deepEqual(startedWith, {
    name: 'devnet-node-7', nodeRole: 'edge', relay: 'none', listenPort: 20007, announceAddresses: announce,
  });
  assert.match(output, /Node 7 config: applied DEVNET_ADDNODE_CONFIG_OVERRIDES/);
});

test('an override that is not a JSON object stops addnode before the node starts and leaves nothing behind', t => {
  for (const overrides of ['{not json', '["a"]', '"text"', 'null']) {
    const { status, output, startedWith, nodeDirectoryLeft } = addnode(t, overrides);
    assert.equal(status, 1, `${overrides}: ${output}`);
    assert.equal(startedWith, undefined, overrides);
    assert.equal(nodeDirectoryLeft, false, overrides);
    assert.match(output, /DEVNET_ADDNODE_CONFIG_OVERRIDES must be a JSON object; node7 was not started/);
  }
});
