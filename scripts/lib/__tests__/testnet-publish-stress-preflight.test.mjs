import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runPreflight } from '../../testnet-publish-stress/preflight-runner.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../../..');

async function networkIdFrom(relativePath) {
  const contents = await readFile(path.join(REPO_ROOT, relativePath), 'utf8');
  return JSON.parse(contents).networkId;
}

async function runNetworkScenario(networkId, expectedNetworkId) {
  const requests = [];
  const logLines = [];
  const apiCall = async (method, requestPath) => {
    requests.push(`${method} ${requestPath}`);
    assert.equal(method, 'GET', 'network-ID coverage must never issue a write');
    if (requestPath === '/api/status') {
      return {
        ok: true,
        status: 200,
        json: {
          name: 'test',
          version: 'test',
          nodeRole: 'edge',
          networkName: 'testnet',
          networkId,
          identityId: 'test',
          hasIdentity: true,
          connectedPeers: 0,
        },
      };
    }
    if (requestPath === '/api/wallets/balances') {
      return {
        ok: true,
        status: 200,
        json: {
          balances: [{ address: '0x1', eth: '1', trac: '50', symbol: 'TRAC' }],
          symbol: 'TRAC',
          rpcUrl: 'http://unused.invalid',
          chainId: 84532,
        },
      };
    }
    if (requestPath === '/api/context-graph/list') {
      return {
        ok: true,
        status: 200,
        json: {
          contextGraphs: [{
            id: 'did:dkg:base:84532/test-agent/miles-publish-stress-test',
            onChainId: '0x01',
          }],
        },
      };
    }
    assert.fail(`unexpected API request: ${method} ${requestPath}`);
  };

  const outcome = await runPreflight({
    apiCall,
    expectedNetworkId,
    runId: 'test',
    log: (message) => logLines.push(message),
  });
  return { outcome, requests, stderr: logLines.join('\n') };
}

test('publish-stress preflight follows the canonical testnet network ID', async () => {
  const canonicalTestnetId = await networkIdFrom('network/testnet.json');
  const result = await runNetworkScenario(canonicalTestnetId, canonicalTestnetId);

  assert.deepEqual(result.outcome, {
    exitCode: 0,
    reason: 'ready',
    resolvedCgId: 'did:dkg:base:84532/test-agent/miles-publish-stress-test',
    onChainId: '0x01',
  });
  assert.deepEqual(result.requests, [
    'GET /api/status',
    'GET /api/wallets/balances',
    'GET /api/context-graph/list',
  ]);
});

test('publish-stress preflight rejects mainnet before balances or writes', async () => {
  const mainnetId = await networkIdFrom('network/mainnet-base.json');
  const canonicalTestnetId = await networkIdFrom('network/testnet.json');
  const result = await runNetworkScenario(mainnetId, canonicalTestnetId);

  assert.deepEqual(result.outcome, { exitCode: 2, reason: 'network_mismatch' });
  assert.deepEqual(result.requests, ['GET /api/status']);
  assert.match(result.stderr, /Aborting\./);
});

test('publish-stress preflight rejects unrelated networks before balances or writes', async () => {
  const canonicalTestnetId = await networkIdFrom('network/testnet.json');
  const result = await runNetworkScenario('unrelated-test-network', canonicalTestnetId);

  assert.deepEqual(result.outcome, { exitCode: 2, reason: 'network_mismatch' });
  assert.deepEqual(result.requests, ['GET /api/status']);
  assert.match(result.stderr, /Aborting\./);
});
