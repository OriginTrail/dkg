// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeRfc64FinalizedCatalogAuthorityV1,
  parseRfc64AuthoritySnapshotV1,
} from '../../src/rfc64/release-native-catalog-authority-v1.ts';
import { Rfc64PrivateDevnetChainAdapter } from './finalized-chain-fixture.mjs';
import {
  CONTEXT_GRAPH_ID,
  ON_CHAIN_CONTEXT_GRAPH_ID,
  createFinalizedChainFixture,
  createPrivatePolicyAndRoster,
  createReceiverRevokedPolicyAndRoster,
  roleAgentAddress,
} from './fixture.mjs';
import {
  RFC64_PRIVATE_GATE_RPC_BUDGET_V1,
  isWithinRpcBudgetV1,
  rpcEvidenceV1,
} from './run.mjs';

test('the deterministic chain snapshot exactly matches bootstrap authority and advances revocation', async () => {
  const fixture = createFinalizedChainFixture();
  const adapter = new Rfc64PrivateDevnetChainAdapter(fixture);
  const contextGraphId = BigInt(ON_CHAIN_CONTEXT_GRAPH_ID);
  await adapter.createOnChainContextGraph({
    accessPolicy: fixture.accessPolicy,
    publishPolicy: fixture.publishPolicy,
    publishAuthority: fixture.publishAuthority,
    publishAuthorityAccountId: BigInt(fixture.publishAuthorityAccountId),
    participantAgents: fixture.participantAgents,
    nameHash: fixture.nameHash,
  });

  const initial = composeRfc64FinalizedCatalogAuthorityV1({
    networkId: fixture.networkId,
    contextGraphId: CONTEXT_GRAPH_ID,
    snapshot: parseRfc64AuthoritySnapshotV1(
      await adapter.getContextGraphAuthoritySnapshot(contextGraphId),
      contextGraphId,
    ),
  });
  const configured = createPrivatePolicyAndRoster();
  assert.deepEqual(initial.policy, configured.policy);
  assert.equal(initial.policyDigest, configured.policyDigest);
  assert.deepEqual(initial.roster, configured.roster);

  await adapter.removeContextGraphParticipantAgent(
    contextGraphId,
    roleAgentAddress('receiver'),
  );
  const advanced = composeRfc64FinalizedCatalogAuthorityV1({
    networkId: fixture.networkId,
    contextGraphId: CONTEXT_GRAPH_ID,
    snapshot: parseRfc64AuthoritySnapshotV1(
      await adapter.getContextGraphAuthoritySnapshot(contextGraphId),
      contextGraphId,
    ),
  });
  const expected = createReceiverRevokedPolicyAndRoster();
  assert.equal(advanced.policyDigest, expected.policyDigest);
  assert.equal(advanced.roster.version, '1');
  assert.deepEqual(advanced.roster.members, expected.roster.members);
  assert.equal(
    advanced.roster.members.some(
      ({ agentAddress }) => agentAddress === roleAgentAddress('receiver'),
    ),
    false,
  );
});

test('RPC evidence is method-attributed and rejects unknown or over-budget work', () => {
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
  assert.equal(isWithinRpcBudgetV1({
    rpcCallCounts: { eth_unexpected: 1 },
  }), false);
  assert.equal(isWithinRpcBudgetV1({ rpcCallCounts: {} }), false);
});
