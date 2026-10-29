import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const DEVNET = fileURLToPath(new URL('../../devnet.sh', import.meta.url));
const HUB = '0x5FbDB2315678afecb367f032d93F642f64180aa3';

/**
 * The "chain" member devnet.sh writes into the config of node `node`, as the
 * script itself resolves that node's version under `env`.
 */
function chainConfig({ node = 1, role = 'core', env = {} } = {}) {
  const result = spawnSync('bash', ['-c', `
    set -euo pipefail
    source "$1"
    devnet_chain_config_block "$2" "$(node_version_ref "$3" "$4")"
  `, 'bash', DEVNET, HUB, String(node), role], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DEVNET_SOURCE_ONLY: '1',
      HARDHAT_PORT: '18545',
      DEVNET_RPC_BUDGET: undefined,
      DEVNET_VERSION_LAYOUT: undefined,
      ...env,
    },
  });
  return {
    status: result.status,
    stderr: result.stderr,
    chain: result.status === 0 ? JSON.parse(`{${result.stdout}}`).chain : undefined,
  };
}

const LOCAL_CHAIN_BUDGET = { maxRequestsPerSecond: 1000, burstRequests: 1000, startupJitterMs: 0 };

test('a devnet node gets a request budget sized for the local chain', () => {
  const { status, stderr, chain } = chainConfig();
  assert.equal(status, 0, stderr);
  assert.deepEqual(chain, {
    type: 'evm',
    rpcUrl: 'http://127.0.0.1:18545',
    hubAddress: HUB,
    chainId: 'evm:31337',
    rpcRequestBudget: LOCAL_CHAIN_BUDGET,
  });
});

test('DEVNET_RPC_BUDGET=shipped leaves the node on its shipped budget', () => {
  const { status, stderr, chain } = chainConfig({ env: { DEVNET_RPC_BUDGET: 'shipped' } });
  assert.equal(status, 0, stderr);
  assert.deepEqual(chain, {
    type: 'evm',
    rpcUrl: 'http://127.0.0.1:18545',
    hubAddress: HUB,
    chainId: 'evm:31337',
  });
});

test('a node on another version keeps its shipped budget', () => {
  const env = { DEVNET_VERSION_LAYOUT: 'all:current,edges:v10.0.3' };
  const edge = chainConfig({ node: 5, role: 'edge', env });
  assert.equal(edge.status, 0, edge.stderr);
  assert.equal(edge.chain.rpcRequestBudget, undefined);

  // The code under test, in the same cluster, still gets the local budget.
  const core = chainConfig({ node: 1, role: 'core', env });
  assert.equal(core.status, 0, core.stderr);
  assert.deepEqual(core.chain.rpcRequestBudget, LOCAL_CHAIN_BUDGET);
});

test('an unknown DEVNET_RPC_BUDGET stops the script instead of choosing a budget', () => {
  const { status, stderr, chain } = chainConfig({ env: { DEVNET_RPC_BUDGET: 'none' } });
  assert.equal(status, 1);
  assert.match(stderr, /DEVNET_RPC_BUDGET must be 'local' or 'shipped' \(got 'none'\)/);
  assert.equal(chain, undefined);
});
