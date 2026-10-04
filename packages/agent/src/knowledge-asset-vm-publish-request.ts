// SPDX-License-Identifier: Apache-2.0

import { createHash } from 'node:crypto';
import { type AssertionSeal, GRAPH_KA_CONTENT_SCOPE_VERSION, createGraphKnowledgeAssetScope } from '@origintrail-official/dkg-core';
import { type PublishOptions, type KnowledgeAssetVmPublishRequest, assertPublicationPricingPolicyApplicable } from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

type KnowledgeAssetVmPublicationOperationPlan =
  | {
      readonly kind: 'initial';
      readonly pricingPolicy: PublishOptions['pricingPolicy'];
    }
  | {
      readonly kind: 'update';
      readonly vmCurrentAssertion: string;
    };

/** One operation discriminator shared by admission, sync, and queued execution. */
export function planKnowledgeAssetVmPublication(input: {
  readonly vmCurrentAssertion?: string;
  readonly pricingPolicy?: PublishOptions['pricingPolicy'];
}): KnowledgeAssetVmPublicationOperationPlan {
  if (input.vmCurrentAssertion) {
    assertPublicationPricingPolicyApplicable(input.pricingPolicy, { kind: 'update' });
    return { kind: 'update', vmCurrentAssertion: input.vmCurrentAssertion };
  }
  assertPublicationPricingPolicyApplicable(input.pricingPolicy, {
    kind: 'initial',
    graphScoped: true,
  });
  return { kind: 'initial', pricingPolicy: input.pricingPolicy };
}

/** Rebuild the immutable graph-scoped seal carried by one queued VM request. */
export function assertionSealFromQueuedKnowledgeAssetVmPublishRequest(
  request: KnowledgeAssetVmPublishRequest,
): AssertionSeal {
  // Both execution boundaries validate the immutable graph-scoped envelope
  // before calling this shared reconstruction helper.
  const graphScope = createGraphKnowledgeAssetScope(
    request.kaUal!,
    request.assertionVersion!,
  );
  return {
    merkleRoot: ethers.getBytes(request.seal.merkleRoot),
    authorAddress: ethers.getAddress(request.seal.authorAddress),
    authorAttestationR: ethers.getBytes(request.seal.signature.r),
    authorAttestationVS: ethers.getBytes(request.seal.signature.vs),
    authorSchemeVersion: request.seal.schemeVersion,
    chainId: BigInt(request.sealChainId),
    kav10Address: ethers.getAddress(request.sealKav10Address),
    finalizedAtIso: request.sealFinalizedAtIso,
    contentScopeVersion: GRAPH_KA_CONTENT_SCOPE_VERSION,
    kaUal: graphScope.ual,
    assertionVersion: graphScope.assertionVersion,
    publicTripleCount: request.publicTripleCount!,
    ...(request.privateMerkleRoot
      ? { privateMerkleRoot: ethers.getBytes(request.privateMerkleRoot) }
      : {}),
    privateTripleCount: request.privateTripleCount!,
    rootEntities: [],
    ...(request.seal.reservedKaId !== undefined
      ? { reservedKaId: BigInt(request.seal.reservedKaId) }
      : {}),
  };
}

export type KnowledgeAssetVmPublishRequestWithoutIntentKey = Omit<
  KnowledgeAssetVmPublishRequest,
  'intentKey'
>;

/** Canonical immutable projection of the persisted queued-publish request. */
export function createKnowledgeAssetVmPublishIntentKey(
  request: KnowledgeAssetVmPublishRequestWithoutIntentKey,
): string {
  const canonicalIntent = {
    contextGraphId: request.contextGraphId,
    name: request.name,
    agentAddress: request.agentAddress ?? null,
    subGraphName: request.subGraphName ?? null,
    shareOperationId: request.shareOperationId,
    roots: request.roots,
    contentScopeVersion: request.contentScopeVersion ?? null,
    kaUal: request.kaUal ?? null,
    assertionVersion: request.assertionVersion ?? null,
    publicTripleCount: request.publicTripleCount ?? null,
    privateMerkleRoot: request.privateMerkleRoot?.toLowerCase() ?? null,
    privateTripleCount: request.privateTripleCount ?? null,
    accessPolicy: request.accessPolicy ?? null,
    allowedPeers: request.allowedPeers ?? [],
    entityProofs: request.entityProofs ?? null,
    sealMerkleRoot: request.sealMerkleRoot.toLowerCase(),
    seal: request.seal,
    sealChainId: request.sealChainId,
    sealKav10Address: request.sealKav10Address,
    sealFinalizedAtIso: request.sealFinalizedAtIso,
    wmCurrentAssertion: request.wmCurrentAssertion ?? null,
    swmCurrentAssertion: request.swmCurrentAssertion ?? null,
    vmCurrentAssertion: request.vmCurrentAssertion ?? null,
    kaNumber: request.kaNumber ?? null,
    reservedUal: request.reservedUal ?? null,
    publishEpochs: request.publishEpochs ?? null,
    // Keep the pre-feature canonical JSON unchanged when the policy is omitted.
    ...(request.pricingPolicy !== undefined
      ? { pricingPolicy: request.pricingPolicy }
      : {}),
    clearSharedMemoryAfter: request.clearSharedMemoryAfter ?? null,
    publisherNodeIdentityIdOverride:
      request.publisherNodeIdentityIdOverride ?? null,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(canonicalIntent)).digest('hex')}`;
}
