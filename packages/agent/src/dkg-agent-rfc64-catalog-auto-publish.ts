// SPDX-License-Identifier: Apache-2.0

/**
 * Opt-in RFC-64 producer bridge from an ordinary confirmed public KA publish
 * to this provider's durable exact author-catalog head.
 */

import {
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  type AssertionCoordinateV1,
  type AssertionSeal,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type CountV1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SubGraphNameV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import type { Quad } from '@origintrail-official/dkg-storage';
import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import { createEvmPersonalMessageSignerV1 } from './evm-message-signer-v1.js';
import type {
  Rfc64CatalogAuthorSignerV1,
  Rfc64CatalogSuccessorAssetInputV1,
} from './dkg-agent-rfc64-catalog.js';
import { snapshotRfc64CatalogDeploymentProfileV1 } from './rfc64/catalog-authority-config-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';

/** Internal normal-publication handoff after VM confirmation is durable locally. */
export interface RecordConfirmedRfc64PublicCatalogAssetParamsV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName?: SubGraphNameV1 | null;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly publicQuads: readonly Quad[];
  readonly seal: AssertionSeal;
}

export class Rfc64CatalogAutoPublishMethods extends DKGAgentBase {
  /**
   * Advance this provider's exact public-root author catalog after an ordinary
   * graph-scoped KA publish has confirmed. The hook is dormant unless the
   * preview config is present. Catalog objects and bundles are staged first,
   * the provider's applied-head pointer advances second, and peer availability
   * hints are sent last.
   */
  async recordConfirmedRfc64PublicCatalogAssetV1(
    this: DKGAgent,
    params: RecordConfirmedRfc64PublicCatalogAssetParamsV1,
  ): Promise<AppliedCatalogHeadSnapshotV1 | null> {
    const autoPublish = this.config.rfc64PublicCatalogAutoPublish;
    if (autoPublish === undefined) return null;
    if (params.subGraphName !== undefined && params.subGraphName !== null) return null;
    const seal = canonicalGraphScopedAuthorSealFromAssertionSealV1(params.seal);
    // V1 deliberately catalogs public-only KA projections. Private-bearing
    // publishes require the reserved cg-shared-v1 anchor/hash statements to be
    // present in the author-sealed public projection; ordinary publication does
    // not synthesize those statements yet, so attempting an upsert would always
    // fail projection verification after chain confirmation.
    if (BigInt(seal.privateTripleCount) > 0n) return null;
    if (params.publicQuads.length !== Number(seal.publicTripleCount)) {
      throw new Error(
        'RFC-64 auto-publish public projection count differs from the confirmed author seal',
      );
    }
    const projectionBytes = encodeCanonicalCgSharedPublicRootProjectionV1(params.publicQuads);
    const networkId = (this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.chain.chainId) as NetworkIdV1;
    if (networkId === 'none') {
      throw new Error('RFC-64 auto-publish requires a trusted deployment network');
    }
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error(
        'RFC-64 public catalog service is not available (agent not started or no dataDir)',
      );
    }
    const acceptedPolicy = service.acceptedPolicySnapshot(networkId, params.contextGraphId);
    if (acceptedPolicy === null || acceptedPolicy.policy.accessPolicy !== 0) {
      throw new Error(
        'RFC-64 auto-publish requires an independently accepted current public policy',
      );
    }
    const scope: AuthorCatalogScopeV1 = Object.freeze({
      networkId,
      contextGraphId: params.contextGraphId,
      governanceChainId: acceptedPolicy.policy.governanceChainId,
      governanceContractAddress: acceptedPolicy.policy.governanceContractAddress,
      ownershipTransitionDigest: acceptedPolicy.policy.ownershipTransitionDigest,
      subGraphName: null,
      authorAddress: seal.authorAddress,
      era: acceptedPolicy.policy.era,
      bucketCount: '1' as CountV1,
    });
    service.acceptedPolicySnapshotForCatalogScope(scope);
    const asset: Rfc64CatalogSuccessorAssetInputV1 = Object.freeze({
      assertionCoordinate: params.assertionCoordinate,
      projectionBytes,
      seal,
    });
    return this.upsertConfirmedRfc64PublicRootCatalogAssetV1({
      scope,
      author: this.createRfc64CatalogAuthorSignerV1(seal.authorAddress),
      asset,
      deployment: await this.resolveRfc64AutoPublishDeploymentProfileV1(networkId),
      peers: autoPublish.peers,
      catalogIssuerDelegationEffectiveAt:
        autoPublish.catalogIssuerDelegationEffectiveAt ?? ('0' as TimestampMsV1),
      catalogIssuerDelegationExpiresAt:
        autoPublish.catalogIssuerDelegationExpiresAt,
    });
  }

  private createRfc64CatalogAuthorSignerV1(
    this: DKGAgent,
    authorAddress: EvmAddressV1,
  ): Rfc64CatalogAuthorSignerV1 {
    return createEvmPersonalMessageSignerV1({
      address: authorAddress,
      custodialPrivateKey: this.getCustodialAgentPrivateKey(authorAddress),
      signMessageAs: this.chain.signMessageAs?.bind(this.chain),
      signMessage: this.chain.signMessage?.bind(this.chain),
      purpose: 'RFC-64 catalog author',
    });
  }

  private async resolveRfc64AutoPublishDeploymentProfileV1(
    this: DKGAgent,
    networkId: NetworkIdV1,
  ): Promise<CatalogSealDeploymentProfileV1> {
    let deployment = this.config.rfc64CatalogDeploymentProfile;
    const trustedNetworkId = deployment?.networkId ?? this.chain.chainId;
    if (trustedNetworkId === 'none' || trustedNetworkId !== networkId) {
      throw new Error('RFC-64 auto-publish network differs from the trusted deployment');
    }
    if (deployment === undefined) {
      const [chainId, kav10Address] = await Promise.all([
        this.chain.getEvmChainId(),
        this.chain.getKnowledgeAssetsLifecycleAddress(),
      ]);
      deployment = snapshotRfc64CatalogDeploymentProfileV1({
        networkId,
        assertedAtChainId: chainId.toString() as never,
        assertedAtKav10Address: kav10Address as EvmAddressV1,
      });
      if (deployment === undefined) {
        throw new Error('RFC-64 chain deployment profile resolution failed');
      }
    }
    return deployment;
  }

}
