// SPDX-License-Identifier: Apache-2.0

import assert from 'node:assert/strict';
import test from 'node:test';

import { ethers } from 'ethers';
import {
  composeRfc64FinalizedCatalogAuthorityV1,
  parseRfc64AuthoritySnapshotV1,
} from '../../src/rfc64/release-native-catalog-authority-v1.ts';
import { Rfc64CatalogAccessPolicyRegistryV1 } from
  '../../src/rfc64/catalog-access-policy-v1.ts';
import {
  Rfc64PrivateDevnetChainAdapter,
  startRfc64PrivateDevnetFinalizedRpc,
} from './finalized-chain-fixture.mjs';
import {
  CONTEXT_GRAPH_STORAGE,
  CONTEXT_GRAPH_ID,
  ON_CHAIN_CONTEXT_GRAPH_ID,
  createFinalizedChainFixture,
  createPrivatePolicyAndRoster,
  createReceiverRevokedPolicyAndRoster,
  roleAgentAddress,
} from './fixture.mjs';

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
  const rpc = await startRfc64PrivateDevnetFinalizedRpc(fixture, {
    readAuthoritySnapshot: () => adapter.getContextGraphAuthoritySnapshot(contextGraphId),
  });
  const contextGraphInterface = new ethers.Interface([
    'function getContextGraph(uint256 contextGraphId) view returns (address owner, address[] participantAgents, uint256 metadataBatchId, bool active, uint256 createdAt, uint8 accessPolicy, uint8 publishPolicy, address publishAuthority, uint256 publishAuthorityAccountId)',
  ]);
  const assertAuthorityParity = async () => {
    const adapterParticipants = (await adapter.getContextGraphParticipantAgents(contextGraphId))
      .map((address) => address.toLowerCase())
      .sort();
    const snapshot = await adapter.getContextGraphAuthoritySnapshot(contextGraphId);
    const rpcResponse = await fetch(rpc.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_call',
        params: [{
          to: CONTEXT_GRAPH_STORAGE,
          data: contextGraphInterface.encodeFunctionData('getContextGraph', [contextGraphId]),
        }, 'latest'],
      }),
    });
    const body = await rpcResponse.json();
    const [, rpcParticipants] = contextGraphInterface.decodeFunctionResult(
      'getContextGraph',
      body.result,
    );
    assert.deepEqual([...snapshot.participantAgents], adapterParticipants);
    assert.deepEqual(
      [...rpcParticipants].map((address) => address.toLowerCase()).sort(),
      adapterParticipants,
    );
  };

  try {
    await assertAuthorityParity();
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

    await adapter.addContextGraphParticipantAgent(
      contextGraphId,
      roleAgentAddress('outsider'),
    );
    await assertAuthorityParity();
    await adapter.removeContextGraphParticipantAgent(
      contextGraphId,
      roleAgentAddress('outsider'),
    );
    await assertAuthorityParity();
    await adapter.removeContextGraphParticipantAgent(
      contextGraphId,
      roleAgentAddress('receiver'),
    );
    await assertAuthorityParity();
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
    assert.equal(advanced.roster.version, '3');
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
    assert.equal(accepted.roster?.version, '3');
    assert.equal(accepted.roster?.members.some(
      ({ agentAddress }) => agentAddress === roleAgentAddress('receiver'),
    ), false);
  } finally {
    await rpc.close();
  }
});
