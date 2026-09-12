// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { AgentChild } from './run.mjs';
import { createRuntimeLoadEvidenceV1 } from
  '../../../../devnet/rfc64-runtime-load-evidence.mts';
import { RFC64_RUNTIME_EVIDENCE_V1 } from
  '../../../../devnet/rfc64-runtime-provenance.mts';
import {
  RFC64_PRIVATE_GATE_RPC_BUDGET_V1,
  finalizedRuntimeRpcVerdictV1,
  hasFinalizedRpcReadEvidenceV1,
  isWithinRpcBudgetV1,
  isWithinRpcCeilingV1,
  rpcEvidenceV1,
} from './rpc-evidence.mjs';
import { emitAuthoritativeRuntimeShutdownReceiptV1 } from './runtime-shutdown.mjs';

test('shutdown receipt is emitted only after a successful agent drain', async () => {
  const failedOrder = [];
  await assert.rejects(
    emitAuthoritativeRuntimeShutdownReceiptV1({
      agent: {
        stop: async () => {
          failedOrder.push('stop');
          throw new Error('agent drain failed');
        },
      },
      rpc: {
        snapshot: () => { failedOrder.push('snapshot'); return { eth_call: 1 }; },
        close: async () => { failedOrder.push('close'); },
      },
      sealExecutedRuntimeManifest: () => { failedOrder.push('seal'); return {}; },
      emitReceipt: async () => { failedOrder.push('receipt'); },
    }),
    /agent drain failed/,
  );
  assert.deepEqual(failedOrder, ['stop']);

  const successfulOrder = [];
  let receipt;
  await emitAuthoritativeRuntimeShutdownReceiptV1({
    agent: { stop: async () => { successfulOrder.push('stop'); } },
    rpc: {
      snapshot: () => { successfulOrder.push('snapshot'); return { eth_call: 1 }; },
      close: async () => { successfulOrder.push('close'); },
    },
    sealExecutedRuntimeManifest: () => {
      successfulOrder.push('seal');
      return { manifestDigest: 'sha256:fixture' };
    },
    emitReceipt: async (value) => {
      successfulOrder.push('receipt');
      receipt = value;
    },
  });
  assert.deepEqual(successfulOrder, ['stop', 'snapshot', 'close', 'seal', 'receipt']);
  assert.deepEqual(receipt, {
    executedRuntimeManifest: { manifestDigest: 'sha256:fixture' },
    rpcCallCounts: { eth_call: 1 },
  });
});

test('shutdown-time workspace artifacts are captured before the provenance seal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rfc64-private-shutdown-provenance-'));
  try {
    const artifactPath = join(root, 'packages', 'agent', 'dist', 'shutdown.js');
    const source = Buffer.from('export const shutdown = true;\n');
    await mkdir(dirname(artifactPath), { recursive: true });
    await writeFile(artifactPath, source);
    const artifactUrl = pathToFileURL(artifactPath).href;
    const evidence = createRuntimeLoadEvidenceV1({
      repoRoot: root,
      sourceCommit: 'a'.repeat(40),
    });
    let receipt;
    await emitAuthoritativeRuntimeShutdownReceiptV1({
      agent: {
        stop: async () => {
          evidence.resolve(artifactUrl, {}, () => ({
            format: 'module',
            url: artifactUrl,
          }));
          evidence.load(artifactUrl, { format: 'module' }, () => {
            throw new Error('workspace artifact load must be short-circuited');
          });
        },
      },
      rpc: undefined,
      sealExecutedRuntimeManifest:
        evidence.createSealer(RFC64_RUNTIME_EVIDENCE_V1),
      emitReceipt: async (value) => { receipt = value; },
    });
    assert.deepEqual(receipt.executedRuntimeManifest.runtimeFiles, [{
      byteLength: source.byteLength,
      path: 'packages/agent/dist/shutdown.js',
      sha256: `0x${createHash('sha256').update(source).digest('hex')}`,
    }]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
  assert.equal(isWithinRpcCeilingV1({
    rpcCallCounts: {
      eth_call: Number.MAX_SAFE_INTEGER,
      eth_chainId: Number.MAX_SAFE_INTEGER,
    },
  }), false);
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
    'owner-revoker': quiet,
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
