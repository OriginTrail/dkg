// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { AgentChild } from './run.mjs';
import {
  RFC64_PRIVATE_GATE_RPC_BUDGET_V1,
  finalizedRuntimeRpcVerdictV1,
  hasFinalizedRpcReadEvidenceV1,
  isWithinRpcBudgetV1,
  isWithinRpcCeilingV1,
  rpcEvidenceV1,
} from './rpc-evidence.mjs';

test('RPC evidence is method-attributed and rejects unknown or over-budget work', async () => {
  const withinBudget = {
    rpcCallCounts: {
      eth_blockNumber: 2,
      eth_call: 12,
      eth_chainId: 2,
      eth_getBlockByNumber: 4,
      eth_getCode: 1,
    },
  };
  assert.deepEqual(rpcEvidenceV1(withinBudget), {
    byMethod: withinBudget.rpcCallCounts,
    total: 21,
  });
  assert.equal(isWithinRpcBudgetV1(withinBudget), true);
  assert.equal(isWithinRpcBudgetV1({
    rpcCallCounts: { eth_call: RFC64_PRIVATE_GATE_RPC_BUDGET_V1.methods.eth_call + 1 },
  }), false);
  assert.equal(isWithinRpcBudgetV1({ rpcCallCounts: { eth_unexpected: 1 } }), false);
  assert.equal(isWithinRpcBudgetV1({ rpcCallCounts: {} }), false);
  assert.equal(isWithinRpcCeilingV1({ rpcCallCounts: {} }), true);
  assert.equal(isWithinRpcCeilingV1({
    rpcCallCounts: { eth_call: RFC64_PRIVATE_GATE_RPC_BUDGET_V1.methods.eth_call + 1 },
  }), false);
  assert.equal(isWithinRpcCeilingV1({ rpcCallCounts: { eth_unexpected: 1 } }), false);
  assert.equal(isWithinRpcCeilingV1({ rpcCallCounts: { eth_call: '1' } }), false);
  assert.equal(hasFinalizedRpcReadEvidenceV1({ rpcCallCounts: { eth_chainId: 1 } }), false);
  assert.equal(hasFinalizedRpcReadEvidenceV1({
    rpcCallCounts: { eth_call: 1, eth_getBlockByNumber: 1 },
  }), true);

  const finalized = { rpcCallCounts: { eth_call: 1, eth_getBlockByNumber: 1 } };
  const quiet = { rpcCallCounts: {} };
  const receipts = {
    owner: quiet,
    provider2: finalized,
    'receiver-seed': finalized,
    receiver: finalized,
    outsider: quiet,
    'receiver-restart': quiet,
  };
  assert.deepEqual(finalizedRuntimeRpcVerdictV1(receipts), {
    finalizedChainPathExecuted: true,
    finalizedChainRpcWithinBudget: true,
  });
  assert.equal(finalizedRuntimeRpcVerdictV1({
    ...receipts,
    provider2: { rpcCallCounts: { eth_chainId: 1 } },
  }).finalizedChainPathExecuted, false);
  assert.equal(finalizedRuntimeRpcVerdictV1({
    ...receipts,
    'receiver-seed': { rpcCallCounts: { eth_call: 97, eth_getBlockByNumber: 1 } },
  }).finalizedChainRpcWithinBudget, false);
  const { owner: _missingOwner, ...missingOwner } = receipts;
  assert.equal(
    finalizedRuntimeRpcVerdictV1(missingOwner).finalizedChainRpcWithinBudget,
    false,
  );

  const root = await mkdtemp(join(tmpdir(), 'rfc64-private-late-rpc-'));
  const child = new AgentChild('late-rpc', root, undefined, 'late-rpc', {
    agentProcess: fileURLToPath(new URL('./fixtures/late-rpc-child.mjs', import.meta.url)),
  });
  try {
    await child.waitFor('ready');
    const inspection = await child.request({ cmd: 'inspect' });
    assert.equal(isWithinRpcCeilingV1(inspection), true);
    const shutdown = await child.stop();
    assert.deepEqual(shutdown.rpcCallCounts, { eth_call: 97 });
    assert.equal(isWithinRpcBudgetV1(shutdown), false);
  } finally {
    await child.forceStop().catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});
