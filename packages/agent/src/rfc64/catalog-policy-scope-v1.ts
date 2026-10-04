// SPDX-License-Identifier: Apache-2.0

import { assertAuthorCatalogScopeV1, type AuthorCatalogScopeV1 } from '@origintrail-official/dkg-core';
import { computeOpenContextGraphPolicyDigestV1, type AcceptedOpenCatalogPolicyV1 } from './open-catalog-policy-v1.js';
import type { Rfc64CatalogAccessPolicyRegistryV1, AcceptedRfc64CatalogAccessSnapshotV1 } from './catalog-access-policy-v1.js';

export function snapshotCatalogScope(input: AuthorCatalogScopeV1): Readonly<AuthorCatalogScopeV1> {
  const scope = Object.freeze({
    networkId: input.networkId,
    contextGraphId: input.contextGraphId,
    governanceChainId: input.governanceChainId,
    governanceContractAddress: input.governanceContractAddress,
    ownershipTransitionDigest: input.ownershipTransitionDigest,
    subGraphName: input.subGraphName,
    authorAddress: input.authorAddress,
    era: input.era,
    bucketCount: input.bucketCount,
  });
  assertAuthorCatalogScopeV1(scope);
  return scope;
}

export function assertOpenPolicyMatchesCatalogScope(
  supplied: AcceptedOpenCatalogPolicyV1,
  held: AcceptedOpenCatalogPolicyV1 | null,
  scope: AuthorCatalogScopeV1,
): void {
  const policy = supplied.policy;
  if (
    held === null
    || held.policyDigest !== supplied.policyDigest
    || supplied.policyDigest !== computeOpenContextGraphPolicyDigestV1(policy)
    || policy.networkId !== scope.networkId
    || policy.contextGraphId !== scope.contextGraphId
    || policy.governanceChainId !== scope.governanceChainId
    || policy.governanceContractAddress !== scope.governanceContractAddress
    || policy.ownershipTransitionDigest !== scope.ownershipTransitionDigest
    || policy.era !== scope.era
    || policy.source.kind !== 'owner-signed-unregistered'
    || policy.source.ownerAddress !== scope.authorAddress
  ) {
    throw new Error(
      'RFC-64 open policy is not bound to the exact catalog network, CG, governance scope, era, and author',
    );
  }
}

export function assertAcceptedPolicyMatchesCatalogScope(
  registry: Rfc64CatalogAccessPolicyRegistryV1,
  held: AcceptedRfc64CatalogAccessSnapshotV1,
  scope: AuthorCatalogScopeV1,
): void {
  const policy = held.policy;
  if (
    policy.networkId !== scope.networkId
    || policy.contextGraphId !== scope.contextGraphId
    || policy.governanceChainId !== scope.governanceChainId
    || policy.governanceContractAddress !== scope.governanceContractAddress
    || policy.ownershipTransitionDigest !== scope.ownershipTransitionDigest
    || policy.era !== scope.era
    || !registry.isSwmAuthorAuthorized({
      networkId: scope.networkId,
      contextGraphId: scope.contextGraphId,
      policyDigest: held.policyDigest,
      authorAddress: scope.authorAddress,
    })
  ) {
    throw new Error(
      'RFC-64 policy snapshot is not bound to the exact catalog network, CG, governance scope, era, and author',
    );
  }
}
