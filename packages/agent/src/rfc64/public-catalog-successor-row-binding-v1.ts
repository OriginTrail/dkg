// SPDX-License-Identifier: Apache-2.0

import type {
  CatalogSealDeploymentProfileV1,
  SignedAuthorCatalogHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';

/**
 * What every row of one exact-set successor binds to: the lane its predecessor
 * head names and the deployment its seals were asserted on. A detached copy,
 * so a production that spans several turns binds all of its rows alike.
 */
export function snapshotRfc64PublicCatalogSuccessorRowBindingV1(
  previousHead: SignedAuthorCatalogHeadEnvelopeV1,
  deployment: CatalogSealDeploymentProfileV1,
) {
  return Object.freeze({
    deployment: Object.freeze({
      networkId: deployment.networkId,
      assertedAtChainId: deployment.assertedAtChainId,
      assertedAtKav10Address: deployment.assertedAtKav10Address,
    }),
    scope: Object.freeze({
      networkId: previousHead.payload.networkId,
      contextGraphId: previousHead.payload.contextGraphId,
      governanceChainId: previousHead.payload.governanceChainId,
      governanceContractAddress: previousHead.payload.governanceContractAddress,
      ownershipTransitionDigest: previousHead.payload.ownershipTransitionDigest,
      subGraphName: previousHead.payload.subGraphName,
      authorAddress: previousHead.payload.authorAddress,
      era: previousHead.payload.era,
      bucketCount: previousHead.payload.bucketCount,
    }),
  });
}

export type Rfc64PublicCatalogSuccessorRowBindingV1 =
  ReturnType<typeof snapshotRfc64PublicCatalogSuccessorRowBindingV1>;

/** True while `head` names the lane the rows of `binding` were bound to. */
export function rfc64PublicCatalogSuccessorHeadNamesBindingV1(
  head: SignedAuthorCatalogHeadEnvelopeV1,
  binding: Rfc64PublicCatalogSuccessorRowBindingV1,
): boolean {
  const payload = head.payload as unknown as Readonly<Record<string, unknown>>;
  return Object.entries(binding.scope).every(([field, value]) => payload[field] === value);
}
