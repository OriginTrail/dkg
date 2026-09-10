// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  composeRfc64FinalizedCatalogAuthorityV1,
  parseRfc64AuthoritySnapshotV1,
} from '../../src/rfc64/release-native-catalog-authority-v1.ts';
import { Rfc64CatalogAccessPolicyRegistryV1 } from
  '../../src/rfc64/catalog-access-policy-v1.ts';
import { Rfc64PrivateDevnetChainAdapter } from './finalized-chain-fixture.mjs';
import {
  CONTEXT_GRAPH_ID,
  ON_CHAIN_CONTEXT_GRAPH_ID,
  ASSET_NUMBERS,
  PROJECTION_EVIDENCE,
  UPDATED_PROJECTION_EVIDENCE,
  createFinalizedChainFixture,
  createPrivatePolicyAndRoster,
  createReceiverRevokedPolicyAndRoster,
  roleAgentAddress,
} from './fixture.mjs';
import {
  RFC64_PRIVATE_GATE_RPC_BUDGET_V1,
  EXPECTED_MEMORY_CONTENTS,
  hasExactMemoryContents,
  hasExactSourceSwmContents,
  isWithinRpcBudgetV1,
  isWithinRpcCeilingV1,
  rpcEvidenceV1,
} from './run.mjs';
import {
  createGateCommandFailureV1,
  sanitizeGateFailureV1,
} from './gate-artifact.mjs';

test('memory evidence distinguishes finalized VM v1 from newer SWM v2', () => {
  const graphCounts = ASSET_NUMBERS.map((kaNumber) => ({
    kaNumber,
    swm: UPDATED_PROJECTION_EVIDENCE.count,
    swmDigest: UPDATED_PROJECTION_EVIDENCE.digest,
    swmGraph: `swm:${kaNumber}`,
    swmHead: {
      assertionVersion: '2',
      assertionGraph: `swm:${kaNumber}`,
      shareOperationId: `rfc64-private-release-gate-v2-${kaNumber}`,
    },
    vm: PROJECTION_EVIDENCE.count,
    vmDigest: PROJECTION_EVIDENCE.digest,
    vmGraph: `vm:${kaNumber}`,
    vmHead: {
      assertionVersion: '1',
      assertionGraph: `vm:${kaNumber}`,
    },
  }));
  assert.equal(EXPECTED_MEMORY_CONTENTS.swm.assertionVersion, '2');
  assert.equal(EXPECTED_MEMORY_CONTENTS.vm.assertionVersion, '1');
  assert.equal(hasExactSourceSwmContents({ graphCounts }), true);
  assert.equal(hasExactMemoryContents({ graphCounts }), true);
  assert.equal(hasExactMemoryContents({
    graphCounts: graphCounts.map((evidence) => ({
      ...evidence,
      swmDigest: PROJECTION_EVIDENCE.digest,
    })),
  }), false);
});

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
  const policies = new Rfc64CatalogAccessPolicyRegistryV1({
    localAgentAddress: roleAgentAddress('provider2'),
    resolveRemoteAgentAddress: async () => roleAgentAddress('owner'),
  });
  policies.acceptCurrent({
    policy: initial.policy,
    policyDigest: initial.policyDigest,
    roster: initial.roster,
  });

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
  const accepted = policies.acceptAuthoritativeCurrent({
    policy: advanced.policy,
    policyDigest: advanced.policyDigest,
    roster: advanced.roster,
  });
  assert.equal(accepted.roster?.version, '1');
  assert.equal(accepted.roster?.members.some(
    ({ agentAddress }) => agentAddress === roleAgentAddress('receiver'),
  ), false);
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
  assert.equal(isWithinRpcCeilingV1({ rpcCallCounts: {} }), true);
  assert.equal(isWithinRpcCeilingV1({
    rpcCallCounts: { eth_call: RFC64_PRIVATE_GATE_RPC_BUDGET_V1.methods.eth_call + 1 },
  }), false);
  assert.equal(isWithinRpcCeilingV1({
    rpcCallCounts: { eth_unexpected: 1 },
  }), false);
});

test('child command failures retain only a bounded command phase', () => {
  const sensitiveCause = new Error('provider endpoint and wallet material');
  const classified = sanitizeGateFailureV1(
    createGateCommandFailureV1('persisted-inspection', sensitiveCause),
  );
  assert.deepEqual(classified, {
    failureClass: 'gate-command-failed',
    commandPhase: 'persisted-inspection',
  });
  assert.equal(JSON.stringify(classified).includes(sensitiveCause.message), false);
  assert.deepEqual(sanitizeGateFailureV1(
    createGateCommandFailureV1('caller-controlled-phase', sensitiveCause),
  ), {
    failureClass: 'gate-execution-failed',
  });
});
