// SPDX-License-Identifier: Apache-2.0

import type {
  AuthorCatalogScopeV1,
  CatalogSealDeploymentProfileV1,
  SignedAuthorCatalogHeadEnvelopeV1,
} from '@origintrail-official/dkg-core';

/** What every row of one exact-set successor binds to. */
export interface Rfc64PublicCatalogSuccessorRowBindingV1 {
  /** The deployment the rows' seals were asserted on. */
  readonly deployment: Readonly<CatalogSealDeploymentProfileV1>;
  /** The lane the predecessor head names. */
  readonly scope: Readonly<AuthorCatalogScopeV1>;
}

/**
 * A detached copy of the lane and the deployment, so a production that spans
 * several turns binds all of its rows alike. The fields are copied as they
 * are: whether the head is a valid one is decided where it always was, by the
 * checks that run on it afterwards.
 */
export function snapshotRfc64PublicCatalogSuccessorRowBindingV1(
  previousHead: SignedAuthorCatalogHeadEnvelopeV1,
  deployment: CatalogSealDeploymentProfileV1,
): Rfc64PublicCatalogSuccessorRowBindingV1 {
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
