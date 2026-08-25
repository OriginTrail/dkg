import {
  CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
  type ContextGraphIdV1,
  type ContextGraphPolicyV1,
  type Digest32V1,
  type EvmAddressV1,
  type MemberRosterV1,
  type NetworkIdV1,
} from '@origintrail-official/dkg-core';

import { Rfc64CatalogAccessPolicyRegistryV1 } from '../../src/rfc64/catalog-access-policy-v1.js';

export function createRfc64CatalogAccessPolicyRegistryFixture(options: {
  readonly localAgentAddress: EvmAddressV1;
  readonly remoteAgentAddress: EvmAddressV1;
  readonly networkId?: NetworkIdV1;
  readonly contextGraphId: ContextGraphIdV1;
  readonly accessPolicy: 0 | 1;
  readonly publishPolicy: 0 | 1;
  readonly policyDigest: Digest32V1;
  readonly ownerAddress: EvmAddressV1;
  readonly curatorAddress: EvmAddressV1;
}): Rfc64CatalogAccessPolicyRegistryV1 {
  const networkId = options.networkId ?? 'otp:20430';
  const registry = new Rfc64CatalogAccessPolicyRegistryV1({
    localAgentAddress: options.localAgentAddress,
    resolveRemoteAgentAddress: async () => options.remoteAgentAddress,
  });
  const policy = {
    networkId,
    contextGraphId: options.contextGraphId,
    governanceChainId: null,
    governanceContractAddress: null,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousPolicyDigest: null,
    accessPolicy: options.accessPolicy,
    publishPolicy: options.publishPolicy,
    publishAuthority: options.publishPolicy === 0 ? options.curatorAddress : null,
    publishAuthorityAccountId: '0',
    projectionId: CONTEXT_GRAPH_SHARED_PROJECTION_ID_V1,
    administrativeDelegationDigest: null,
    source: {
      kind: 'owner-signed-unregistered',
      ownerAddress: options.ownerAddress,
      ownerAuthorityEra: '0',
    },
    effectiveAt: '0',
    issuedAt: '0',
  } satisfies ContextGraphPolicyV1;
  const roster = options.accessPolicy === 0 ? null : {
    networkId: policy.networkId,
    contextGraphId: policy.contextGraphId,
    ownershipTransitionDigest: null,
    era: '0',
    version: '0',
    previousRosterDigest: null,
    policyDigest: options.policyDigest,
    administrativeDelegationDigest: null,
    members: [
      { agentAddress: options.localAgentAddress, roles: ['holder', 'provider'] },
      { agentAddress: options.remoteAgentAddress, roles: ['holder', 'provider'] },
    ].sort((left, right) => left.agentAddress.localeCompare(right.agentAddress)),
    issuedAt: '0',
  } satisfies MemberRosterV1;
  registry.accept({ policy, policyDigest: options.policyDigest, roster });
  return registry;
}
