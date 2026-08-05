// SPDX-License-Identifier: Apache-2.0

/**
 * Opt-in RFC-64 producer bridge from an ordinary confirmed public KA publish
 * to this provider's durable exact author-catalog head.
 */

import {
  assertAssertionCoordinateV1,
  assertContextGraphIdV1,
  assertSafeIri,
  assertSubGraphNameV1,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createOperationContext,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  parseAssertionSealQuads,
  type AssertionCoordinateV1,
  type AssertionSeal,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type CountV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type OperationContext,
  type SubGraphNameV1,
  type SwmAuthorInventoryScopeV1,
  type SwmAuthorInventorySnapshotV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { GraphManager, type Quad } from '@origintrail-official/dkg-storage';
import {
  resolveKnowledgeAssetOperationPublicQuads,
  resolveKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type {
  Rfc64CatalogAuthorSignerV1,
  Rfc64CatalogSuccessorAssetInputV1,
} from './dkg-agent-rfc64-catalog.js';
import type { Rfc64PublicCatalogAutoPublishConfigV1 } from './dkg-agent-types.js';
import { snapshotRfc64CatalogDeploymentProfileV1 } from './rfc64/catalog-authority-config-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';
import type { Rfc64PublicCatalogServiceV1 } from './rfc64/public-catalog-service-v1.js';
import {
  maintainRfc64SwmAuthorInventoryV1,
  removeRfc64SwmAuthorInventoryRowV1,
} from './rfc64/swm-author-inventory-producer-v1.js';

/** Internal normal-publication handoff after VM confirmation is durable locally. */
export interface RecordConfirmedRfc64PublicCatalogAssetParamsV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly subGraphName?: SubGraphNameV1 | null;
  readonly assertionCoordinate: AssertionCoordinateV1;
  readonly publicQuads: readonly Quad[];
  readonly seal: AssertionSeal;
}

function shadowResult(
  status: Rfc64SwmAuthorInventoryShadowMutationResultV1['status'],
  action: Rfc64SwmAuthorInventoryShadowMutationResultV1['action'],
  attempts: number,
  headObjectDigest: string | null,
  error: string | null,
): Rfc64SwmAuthorInventoryShadowMutationResultV1 {
  return Object.freeze({ status, action, attempts, headObjectDigest, error });
}

export interface RecordRfc64SwmAuthorInventoryShadowParamsV1 {
  readonly contextGraphId: string;
  readonly subGraphName?: string | null;
  readonly assertionCoordinate: string;
  /** Lifecycle identity whose assertion URI owns the durable seal. */
  readonly lifecycleAgentAddress: string;
  readonly shareOperationId: string;
}

export interface RemoveRfc64SwmAuthorInventoryShadowParamsV1 {
  readonly contextGraphId: string;
  readonly subGraphName?: string | null;
  readonly seal: AssertionSeal;
}

export interface ObserveRfc64DurableSwmPromotionParamsV1
  extends RecordRfc64SwmAuthorInventoryShadowParamsV1 {
  readonly ctx: OperationContext;
}

export interface ObserveRfc64ConfirmedVmParamsV1 {
  readonly contextGraphId: string;
  readonly subGraphName?: string | null;
  readonly assertionCoordinate: string;
  readonly publicQuads: readonly Quad[];
  readonly seal: AssertionSeal;
  readonly assertionUri: string;
  readonly ctx: OperationContext;
  readonly publicationLabel: 'publish' | 'queued publish';
}

export type Rfc64SwmAuthorInventoryShadowMutationResultV1 = Readonly<{
  status: 'dormant' | 'applied' | 'existing' | 'absent' | 'failed';
  action: 'upsert' | 'remove';
  attempts: number;
  headObjectDigest: string | null;
  error: string | null;
}>;

export interface Rfc64SwmAuthorInventoryShadowStatusV1 {
  readonly attemptedUpserts: number;
  readonly appliedUpserts: number;
  readonly existingUpserts: number;
  readonly attemptedRemovals: number;
  readonly appliedRemovals: number;
  readonly absentRemovals: number;
  readonly failed: number;
  readonly casRetries: number;
  readonly lastAction: 'upsert' | 'remove' | null;
  readonly lastContextGraphId: string | null;
  readonly lastKaUal: string | null;
  readonly lastHeadDigest: string | null;
  readonly lastError: string | null;
}

interface ResolvedRfc64AcceptedPublicRootLaneV1 {
  readonly networkId: NetworkIdV1;
  readonly service: Rfc64PublicCatalogServiceV1;
  readonly autoPublishConfig: Readonly<Rfc64PublicCatalogAutoPublishConfigV1>;
  readonly scopeBase: Readonly<Omit<SwmAuthorInventoryScopeV1, 'authorAddress'>>;
}

export class Rfc64CatalogAutoPublishMethods extends DKGAgentBase {
  /** Canonical non-blocking observer for every durable WM to SWM promotion path. */
  async observeRfc64DurableSwmPromotionV1(
    this: DKGAgent,
    params: ObserveRfc64DurableSwmPromotionParamsV1,
  ): Promise<void> {
    try {
      await this.recordRfc64SwmAuthorInventoryShadowV1(params);
    } catch (cause) {
      this.log.warn(
        params.ctx,
        `RFC-64 SWM inventory shadow escaped its failure boundary: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  /** Canonical non-blocking observer for catalog advancement and exact SWM removal. */
  async observeRfc64ConfirmedVmV1(
    this: DKGAgent,
    params: ObserveRfc64ConfirmedVmParamsV1,
  ): Promise<void> {
    const subGraphName = params.subGraphName ?? null;
    const contextGraphId = params.contextGraphId;
    const assertionCoordinate = params.assertionCoordinate;
    try {
      assertContextGraphIdV1(contextGraphId, 'confirmed publish contextGraphId');
      assertAssertionCoordinateV1(
        assertionCoordinate,
        'confirmed publish assertionCoordinate',
      );
      if (subGraphName !== null) {
        assertSubGraphNameV1(subGraphName, 'confirmed publish subGraphName');
      }
      await this.recordConfirmedRfc64PublicCatalogAssetV1({
        contextGraphId,
        subGraphName,
        assertionCoordinate,
        publicQuads: params.publicQuads,
        seal: params.seal,
      });
    } catch (cause) {
      this.log.warn(
        params.ctx,
        `Confirmed ${params.publicationLabel} for <${params.assertionUri}> but RFC-64 catalog advancement failed: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    try {
      await this.removeRfc64SwmAuthorInventoryShadowV1({
        contextGraphId: params.contextGraphId,
        subGraphName: params.subGraphName,
        seal: params.seal,
      });
    } catch (cause) {
      this.log.warn(
        params.ctx,
        `Confirmed ${params.publicationLabel} but RFC-64 SWM inventory shadow removal escaped its failure boundary: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
  }

  readRfc64SwmAuthorInventorySnapshotV1(
    this: DKGAgent,
    params: Readonly<{
      inventoryScopeDigest: Digest32V1;
      authorAddress: EvmAddressV1;
    }>,
  ): SwmAuthorInventorySnapshotV1 | null {
    return this.rfc64PersistenceV1?.inventory.readSwmAuthorInventorySnapshotV1(
      params.inventoryScopeDigest,
      params.authorAddress,
    ) ?? null;
  }

  /** Read-only process-local evidence; authoritative state remains the signed SQLite snapshot. */
  rfc64SwmAuthorInventoryShadowStatusV1(
    this: DKGAgent,
  ): Readonly<Rfc64SwmAuthorInventoryShadowStatusV1> {
    return Object.freeze({ ...this.rfc64SwmAuthorInventoryShadowStatsV1 });
  }

  /**
   * Observe an already-durable WM→SWM commit without participating in its outcome.
   * Unsupported/private/unselected graphs are dormant; every attempted failure is
   * counted and logged, then returned instead of crossing back into the user write.
   */
  async recordRfc64SwmAuthorInventoryShadowV1(
    this: DKGAgent,
    params: RecordRfc64SwmAuthorInventoryShadowParamsV1,
  ): Promise<Rfc64SwmAuthorInventoryShadowMutationResultV1> {
    const stats = this.rfc64SwmAuthorInventoryShadowStatsV1;
    stats.attemptedUpserts += 1;
    try {
      const lane = this.resolveRfc64AcceptedPublicRootLaneV1(
        params.contextGraphId,
        params.subGraphName,
      );
      if (lane === null) {
        stats.attemptedUpserts -= 1;
        return shadowResult('dormant', 'upsert', 0, null, null);
      }
      stats.lastAction = 'upsert';
      stats.lastContextGraphId = params.contextGraphId;
      assertContextGraphIdV1(params.contextGraphId, 'SWM inventory contextGraphId');
      assertAssertionCoordinateV1(
        params.assertionCoordinate,
        'SWM inventory assertionCoordinate',
      );
      const assertionUri = contextGraphAssertionUri(
        params.contextGraphId,
        params.lifecycleAgentAddress,
        params.assertionCoordinate,
        params.subGraphName ?? undefined,
      );
      const metaGraph = contextGraphMetaUri(params.contextGraphId);
      const sealResult = await this.store.query(
        `CONSTRUCT { <${assertSafeIri(assertionUri)}> ?p ?o } WHERE { GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(assertionUri)}> ?p ?o } }`,
        { source: 'agent.rfc64.swmInventory.seal' },
      );
      const seal = parseAssertionSealQuads(
        sealResult.type === 'quads' ? sealResult.quads : [],
        assertionUri,
      );
      if (seal === undefined) throw new Error('durable SWM assertion has no author seal');
      const canonicalSeal = canonicalGraphScopedAuthorSealFromAssertionSealV1(seal);
      const graphManager = new GraphManager(this.store);
      const head = await resolveKnowledgeAssetWorkspaceHead({
        store: this.store,
        graphManager,
        contextGraphId: params.contextGraphId,
        kaUal: canonicalSeal.kaUal,
        subGraphName: params.subGraphName ?? undefined,
      });
      if (
        head === undefined
        || head.shareOperationId !== params.shareOperationId
        || head.assertionVersion !== canonicalSeal.assertionVersion
        || head.publicTripleCount !== Number(canonicalSeal.publicTripleCount)
        || head.privateTripleCount !== Number(canonicalSeal.privateTripleCount)
      ) throw new Error('durable SWM head does not match the committed share and author seal');
      const snapshot = await resolveKnowledgeAssetOperationPublicQuads({
        store: this.store,
        graphManager,
        contextGraphId: params.contextGraphId,
        shareOperationId: params.shareOperationId,
        kaUal: canonicalSeal.kaUal,
        assertionVersion: canonicalSeal.assertionVersion,
        subGraphName: params.subGraphName ?? undefined,
        publicSnapshotStore: this.publicSnapshotStore,
      });
      const sharedAt = head.publishedAt;
      if (sharedAt === undefined) {
        throw new Error('durable SWM share has no canonical publishedAt timestamp');
      }
      const projectionBytes = encodeCanonicalCgSharedPublicRootProjectionV1(snapshot.quads);
      const scope: SwmAuthorInventoryScopeV1 = Object.freeze({
        ...lane.scopeBase,
        authorAddress: canonicalSeal.authorAddress,
      });
      const persistence = this.rfc64PersistenceV1;
      if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
      const signer = this.createRfc64CatalogAuthorSignerV1(canonicalSeal.authorAddress);
      const issuedAt = Math.max(Date.now(), Number(sharedAt)).toString() as TimestampMsV1;
      const maintained = await maintainRfc64SwmAuthorInventoryV1(
        persistence.inventory,
        {
          scope,
          row: Object.freeze({
            assertionCoordinate: params.assertionCoordinate,
            assertionVersion: canonicalSeal.assertionVersion,
            kaUal: canonicalSeal.kaUal,
            shareOperationId: params.shareOperationId,
            projectionDigest: computeKaProjectionDigestV1(projectionBytes),
            publicTripleCount: canonicalSeal.publicTripleCount,
            privateTripleCount: canonicalSeal.privateTripleCount,
            sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(canonicalSeal),
            sharedAt,
            expiresAt: null,
          }),
          issuedAt,
          signer: Object.freeze({
            issuer: signer.address as EvmAddressV1,
            signDigest: signer.signMessage,
          }),
        },
      );
      stats.casRetries += maintained.attempts - 1;
      if (maintained.status === 'applied') stats.appliedUpserts += 1;
      else stats.existingUpserts += 1;
      stats.lastKaUal = canonicalSeal.kaUal;
      stats.lastHeadDigest = maintained.snapshot.head.objectDigest;
      stats.lastError = null;
      return shadowResult(
        maintained.status,
        'upsert',
        maintained.attempts,
        maintained.snapshot.head.objectDigest,
        null,
      );
    } catch (cause) {
      return this.failRfc64SwmAuthorInventoryShadowV1(
        'upsert',
        params.contextGraphId,
        null,
        cause,
      );
    }
  }

  /** Remove a row after VM confirmation, independently of VM catalog advancement. */
  async removeRfc64SwmAuthorInventoryShadowV1(
    this: DKGAgent,
    params: RemoveRfc64SwmAuthorInventoryShadowParamsV1,
  ): Promise<Rfc64SwmAuthorInventoryShadowMutationResultV1> {
    const stats = this.rfc64SwmAuthorInventoryShadowStatsV1;
    stats.attemptedRemovals += 1;
    let kaUal: string | null = null;
    try {
      const lane = this.resolveRfc64AcceptedPublicRootLaneV1(
        params.contextGraphId,
        params.subGraphName,
      );
      if (lane === null) {
        stats.attemptedRemovals -= 1;
        return shadowResult('dormant', 'remove', 0, null, null);
      }
      stats.lastAction = 'remove';
      stats.lastContextGraphId = params.contextGraphId;
      assertContextGraphIdV1(params.contextGraphId, 'SWM inventory contextGraphId');
      const seal = canonicalGraphScopedAuthorSealFromAssertionSealV1(params.seal);
      kaUal = seal.kaUal;
      const scope: SwmAuthorInventoryScopeV1 = Object.freeze({
        ...lane.scopeBase,
        authorAddress: seal.authorAddress,
      });
      const persistence = this.rfc64PersistenceV1;
      if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
      const signer = this.createRfc64CatalogAuthorSignerV1(seal.authorAddress);
      const removed = await removeRfc64SwmAuthorInventoryRowV1(persistence.inventory, {
        scope,
        expectedRow: Object.freeze({
          kaUal: seal.kaUal,
          assertionVersion: seal.assertionVersion,
          sealDigest: computeCanonicalGraphScopedAuthorSealDigestV1(seal),
        }),
        issuedAt: Date.now().toString() as TimestampMsV1,
        signer: Object.freeze({
          issuer: signer.address as EvmAddressV1,
          signDigest: signer.signMessage,
        }),
      });
      stats.casRetries += removed.attempts - 1;
      if (removed.status === 'applied') stats.appliedRemovals += 1;
      else stats.absentRemovals += 1;
      stats.lastKaUal = seal.kaUal;
      stats.lastHeadDigest = removed.snapshot?.head.objectDigest ?? null;
      stats.lastError = null;
      return shadowResult(
        removed.status,
        'remove',
        removed.attempts,
        removed.snapshot?.head.objectDigest ?? null,
        null,
      );
    } catch (cause) {
      return this.failRfc64SwmAuthorInventoryShadowV1(
        'remove',
        params.contextGraphId,
        kaUal,
        cause,
      );
    }
  }
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
    const lane = this.resolveRfc64AcceptedPublicRootLaneV1(
      params.contextGraphId,
      params.subGraphName,
    );
    if (lane === null) return null;
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
    const scope: AuthorCatalogScopeV1 = Object.freeze({
      ...lane.scopeBase,
      authorAddress: seal.authorAddress,
      bucketCount: '1' as CountV1,
    });
    lane.service.acceptedPolicySnapshotForCatalogScope(scope);
    const asset: Rfc64CatalogSuccessorAssetInputV1 = Object.freeze({
      assertionCoordinate: params.assertionCoordinate,
      projectionBytes,
      seal,
    });
    return this.upsertConfirmedRfc64PublicRootCatalogAssetV1({
      scope,
      author: this.createRfc64CatalogAuthorSignerV1(seal.authorAddress),
      asset,
      deployment: await this.resolveRfc64AutoPublishDeploymentProfileV1(lane.networkId),
      peers: lane.autoPublishConfig.peers,
      catalogIssuerDelegationEffectiveAt:
        lane.autoPublishConfig.catalogIssuerDelegationEffectiveAt
        ?? ('0' as TimestampMsV1),
      catalogIssuerDelegationExpiresAt:
        lane.autoPublishConfig.catalogIssuerDelegationExpiresAt,
    });
  }

  /** One canonical activation, policy, ownership, and era boundary for catalog and SWM. */
  private resolveRfc64AcceptedPublicRootLaneV1(
    this: DKGAgent,
    contextGraphId: string,
    subGraphName: string | null | undefined,
  ): ResolvedRfc64AcceptedPublicRootLaneV1 | null {
    const policy = this.config.rfc64PublicCatalogAutoPublishPolicy;
    if (
      policy === undefined
      || (subGraphName !== undefined && subGraphName !== null)
      || (
        policy.mode === 'selected-public'
        && !policy.selectedContextGraphs.includes(contextGraphId)
      )
    ) return null;
    assertContextGraphIdV1(contextGraphId, 'RFC-64 public-root contextGraphId');
    const networkId = (this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.chain.chainId) as NetworkIdV1;
    if (networkId === 'none') {
      throw new Error('RFC-64 public-root activation requires a trusted deployment network');
    }
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error('RFC-64 public catalog service is unavailable');
    }
    const acceptedPolicy = service.acceptedPolicySnapshot(networkId, contextGraphId);
    if (acceptedPolicy === null || acceptedPolicy.policy.accessPolicy !== 0) {
      throw new Error(
        'RFC-64 public-root activation requires an independently accepted current public policy',
      );
    }
    return Object.freeze({
      networkId,
      service,
      autoPublishConfig: policy.config,
      scopeBase: Object.freeze({
        networkId,
        contextGraphId,
        governanceChainId: acceptedPolicy.policy.governanceChainId,
        governanceContractAddress: acceptedPolicy.policy.governanceContractAddress,
        ownershipTransitionDigest: acceptedPolicy.policy.ownershipTransitionDigest,
        subGraphName: null,
        era: acceptedPolicy.policy.era,
      }),
    });
  }

  private failRfc64SwmAuthorInventoryShadowV1(
    this: DKGAgent,
    action: 'upsert' | 'remove',
    contextGraphId: string,
    kaUal: string | null,
    cause: unknown,
  ): Rfc64SwmAuthorInventoryShadowMutationResultV1 {
    const error = cause instanceof Error ? cause.message : String(cause);
    const stats = this.rfc64SwmAuthorInventoryShadowStatsV1;
    stats.failed += 1;
    stats.lastAction = action;
    stats.lastContextGraphId = contextGraphId;
    stats.lastKaUal = kaUal;
    stats.lastError = error;
    this.log.warn(
      createOperationContext('share'),
      `RFC-64 SWM inventory shadow ${action} failed after the user operation committed: ${error}`,
    );
    return shadowResult('failed', action, 0, null, error);
  }

  private createRfc64CatalogAuthorSignerV1(
    this: DKGAgent,
    authorAddress: EvmAddressV1,
  ): Rfc64CatalogAuthorSignerV1 {
    const custodialKey = this.getCustodialAgentPrivateKey(authorAddress);
    if (custodialKey !== undefined) {
      const wallet = new ethers.Wallet(
        custodialKey.startsWith('0x') ? custodialKey : `0x${custodialKey}`,
      );
      if (wallet.address.toLowerCase() !== authorAddress) {
        throw new Error('RFC-64 custodial author key does not match the confirmed seal');
      }
      return Object.freeze({
        address: authorAddress,
        signMessage: (message: Uint8Array) => wallet.signMessage(message),
      });
    }
    const signMessageAs = this.chain.signMessageAs?.bind(this.chain);
    const signMessage = this.chain.signMessage?.bind(this.chain);
    return Object.freeze({
      address: authorAddress,
      signMessage: async (message: Uint8Array) => {
        const compact = signMessageAs !== undefined
          ? await signMessageAs(authorAddress, message)
          : signMessage !== undefined
            ? await signMessage(message)
            : (() => { throw new Error('RFC-64 configured chain has no message signer'); })();
        const signature = ethers.Signature.from({
          r: ethers.hexlify(compact.r),
          yParityAndS: ethers.hexlify(compact.vs),
        }).serialized;
        if (ethers.verifyMessage(message, signature).toLowerCase() !== authorAddress) {
          throw new Error('RFC-64 configured publisher cannot sign for the confirmed KA author');
        }
        return signature;
      },
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
