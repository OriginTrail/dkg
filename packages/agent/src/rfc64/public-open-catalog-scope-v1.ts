// SPDX-License-Identifier: Apache-2.0

/**
 * Shared policy primitive for the RFC-64 public/open root author-catalog lane.
 *
 * This module deliberately sits below transport, service, and reconciliation:
 * each caller derives catalog authority from independently accepted local
 * policy state rather than reconstructing it from peer-controlled wire data.
 */

import {
  type AuthorCatalogScopeV1,
  type ContextGraphPolicyV1,
  type CountV1,
} from '@origintrail-official/dkg-core';

import type {
  Rfc64PublicCatalogHeadAnnouncementV1,
} from './public-catalog-transport-v1.js';

/** Wire fields that identify one claimed public/open root author-catalog scope. */
export interface Rfc64PublicOpenCatalogScopeClaimV1 {
  readonly networkId: Rfc64PublicCatalogHeadAnnouncementV1['networkId'];
  readonly contextGraphId: Rfc64PublicCatalogHeadAnnouncementV1['contextGraphId'];
  readonly subGraphName: Rfc64PublicCatalogHeadAnnouncementV1['subGraphName'];
  readonly authorAddress: Rfc64PublicCatalogHeadAnnouncementV1['authorAddress'];
  readonly catalogEra: Rfc64PublicCatalogHeadAnnouncementV1['catalogEra'];
}

/**
 * Derive the one fixed Gate-1 public/open scope from accepted local policy and
 * require the peer claim to name that exact owner/network/CG/era/root lane.
 * Policy and signature-variant digests are transport/authentication context,
 * not semantic catalog identity, and therefore do not participate.
 */
export function deriveRfc64PublicOpenCatalogScopeV1(
  claim: Rfc64PublicOpenCatalogScopeClaimV1,
  acceptedPolicy: ContextGraphPolicyV1,
): AuthorCatalogScopeV1 {
  if (
    acceptedPolicy.accessPolicy !== 0
    || acceptedPolicy.source.kind !== 'owner-signed-unregistered'
    || acceptedPolicy.networkId !== claim.networkId
    || acceptedPolicy.contextGraphId !== claim.contextGraphId
    || acceptedPolicy.governanceChainId !== null
    || acceptedPolicy.governanceContractAddress !== null
    || acceptedPolicy.ownershipTransitionDigest !== null
    || acceptedPolicy.era !== claim.catalogEra
    || claim.subGraphName !== null
    || acceptedPolicy.source.ownerAddress !== claim.authorAddress
  ) {
    throw new Error(
      'RFC-64 public/open catalog claim is not bound to the accepted null-governance owner policy',
    );
  }
  return Object.freeze({
    networkId: acceptedPolicy.networkId,
    contextGraphId: acceptedPolicy.contextGraphId,
    governanceChainId: acceptedPolicy.governanceChainId,
    governanceContractAddress: acceptedPolicy.governanceContractAddress,
    ownershipTransitionDigest: acceptedPolicy.ownershipTransitionDigest,
    subGraphName: null,
    authorAddress: acceptedPolicy.source.ownerAddress,
    era: acceptedPolicy.era,
    bucketCount: '1' as CountV1,
  });
}
