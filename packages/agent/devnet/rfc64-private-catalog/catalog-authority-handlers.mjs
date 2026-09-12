// SPDX-License-Identifier: Apache-2.0

import {
  composeRfc64FinalizedCatalogAuthorityV1,
  parseRfc64AuthoritySnapshotV1,
} from '../../src/rfc64/release-native-catalog-authority-v1.ts';
import {
  CONTEXT_GRAPH_ID,
  NETWORK_ID,
  ON_CHAIN_CONTEXT_GRAPH_ID,
  createReceiverRevokedPolicyAndRoster,
  roleAgentAddress,
} from './fixture.mjs';
import { assertFinalizedRuntimeV1 } from './agent-runtime.ts';
import { assertAuthorityEvidenceParityV1 } from './initial-authority.mjs';

export async function revokeReceiverV1(context) {
  assertFinalizedRuntimeV1(context);
  const { role } = context;
  if (role !== 'owner') throw new Error('only the owner can advance the gate roster');
  if (context.chainAdapter === undefined) throw new Error('owner has no finalized chain adapter');
  await context.agent.removeAgentFromContextGraph(
    CONTEXT_GRAPH_ID,
    roleAgentAddress('receiver'),
    roleAgentAddress('owner'),
  );
  const finalizedAuthority = await readExactReceiverRevokedFinalizedAuthorityV1(context, role);
  return {
    policyDigest: finalizedAuthority.policyDigest,
    rosterVersion: finalizedAuthority.roster.version,
    revokedAgentAddress: roleAgentAddress('receiver'),
  };
}

export async function observeReceiverRevocationV1(context) {
  assertFinalizedRuntimeV1(context);
  const { role } = context;
  if (role !== 'provider2') throw new Error('only provider2 can observe the gate revocation');
  let providerMutationDenied = false;
  try {
    await context.agent.removeAgentFromContextGraph(
      CONTEXT_GRAPH_ID,
      roleAgentAddress('receiver'),
      roleAgentAddress('provider2'),
    );
  } catch (error) {
    providerMutationDenied = /Only the context graph creator can manage participants/u.test(
      error instanceof Error ? error.message : '',
    );
  }
  if (!providerMutationDenied) {
    throw new Error('provider2 identity was not denied the owner-only receiver revocation');
  }
  const finalizedAuthority = await readExactReceiverRevokedFinalizedAuthorityV1(context, role);
  const curatorMetadataRefreshed = await context.agent.refreshMetaFromCurator(
    CONTEXT_GRAPH_ID,
    {
      force: true,
      trustedCuratorPeerId: context.peerIds.owner,
    },
  );
  if (!curatorMetadataRefreshed) {
    throw new Error('provider2 did not refresh the owner-authenticated revocation metadata');
  }
  const authority = await context.agent.reconcileRfc64CatalogAccessAuthorityV1(
    CONTEXT_GRAPH_ID,
  );
  if (authority === null) {
    throw new Error('provider2 canonical authority reconciliation produced no snapshot');
  }
  if (
    authority.roster === null
    || authority.source !== 'finalized-chain'
    || BigInt(authority.roster.version)
      <= BigInt(context.initialFinalizedAuthority.roster.version)
  ) {
    throw new Error('provider2 reconciliation differs from the finalized receiver revocation');
  }
  assertAuthorityEvidenceParityV1({
    actual: authority,
    expected: finalizedAuthority,
    expectedRosterVersion: authority.roster.version,
    message: 'provider2 reconciliation differs from the finalized receiver revocation',
  });
  return {
    policyDigest: authority.policyDigest,
    curatorMetadataRefreshed,
    providerMutationDenied,
    rosterVersion: authority.roster.version,
    revokedAgentAddress: roleAgentAddress('receiver'),
  };
}

async function readExactReceiverRevokedFinalizedAuthorityV1(context, role) {
  if (context.chainAdapter === undefined) {
    throw new Error(`${role} has no finalized chain adapter`);
  }
  const onChainContextGraphId = BigInt(ON_CHAIN_CONTEXT_GRAPH_ID);
  const finalizedAuthority = composeRfc64FinalizedCatalogAuthorityV1({
    networkId: NETWORK_ID,
    contextGraphId: CONTEXT_GRAPH_ID,
    snapshot: parseRfc64AuthoritySnapshotV1(
      await context.chainAdapter.getContextGraphAuthoritySnapshot(onChainContextGraphId),
      onChainContextGraphId,
    ),
  });
  const receiverAddress = roleAgentAddress('receiver');
  const expected = createReceiverRevokedPolicyAndRoster();
  if (
    finalizedAuthority.roster === null
    || context.initialFinalizedAuthority.roster === null
    || BigInt(finalizedAuthority.roster.version)
      <= BigInt(context.initialFinalizedAuthority.roster.version)
    || finalizedAuthority.roster.members.some(
      ({ agentAddress }) => agentAddress === receiverAddress,
    )
  ) {
    throw new Error('finalized chain authority did not exactly apply the receiver revocation');
  }
  assertAuthorityEvidenceParityV1({
    actual: finalizedAuthority,
    expected,
    message: 'finalized chain authority did not exactly apply the receiver revocation',
  });
  return finalizedAuthority;
}
