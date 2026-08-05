// SPDX-License-Identifier: Apache-2.0

/**
 * Opt-in RFC-64 producer bridge from an ordinary confirmed public KA publish
 * to this provider's durable exact author-catalog head.
 */

import {
  assertAssertionCoordinateV1,
  assertContextGraphIdV1,
  assertSafeIri,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeKaProjectionDigestV1,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  createOperationContext,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  parseAssertionSealQuads,
  sparqlString,
  type AssertionCoordinateV1,
  type AssertionSeal,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type CountV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
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
import { snapshotRfc64CatalogDeploymentProfileV1 } from './rfc64/catalog-authority-config-v1.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';
import {
  maintainRfc64SwmAuthorInventoryV1,
  removeRfc64SwmAuthorInventoryRowV1,
} from './rfc64/swm-author-inventory-producer-v1.js';
import { stripLiteral } from './dkg-agent-utils.js';

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

export class Rfc64CatalogAutoPublishMethods extends DKGAgentBase {
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
    if (!this.isRfc64SwmAuthorInventorySelectedV1(params.contextGraphId, params.subGraphName)) {
      return shadowResult('dormant', 'upsert', 0, null, null);
    }
    const stats = this.rfc64SwmAuthorInventoryShadowStatsV1;
    stats.attemptedUpserts += 1;
    stats.lastAction = 'upsert';
    stats.lastContextGraphId = params.contextGraphId;
    try {
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
      const sharedAt = await this.readRfc64SwmShareTimestampV1(
        params.contextGraphId,
        params.shareOperationId,
        canonicalSeal.kaUal,
        canonicalSeal.assertionVersion,
        params.subGraphName,
      );
      const projectionBytes = encodeCanonicalCgSharedPublicRootProjectionV1(snapshot.quads);
      const scope = this.resolveRfc64SwmAuthorInventoryScopeV1(
        params.contextGraphId,
        canonicalSeal.authorAddress,
      );
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
    if (!this.isRfc64SwmAuthorInventorySelectedV1(params.contextGraphId, params.subGraphName)) {
      return shadowResult('dormant', 'remove', 0, null, null);
    }
    const stats = this.rfc64SwmAuthorInventoryShadowStatsV1;
    stats.attemptedRemovals += 1;
    stats.lastAction = 'remove';
    stats.lastContextGraphId = params.contextGraphId;
    let kaUal: string | null = null;
    try {
      assertContextGraphIdV1(params.contextGraphId, 'SWM inventory contextGraphId');
      const seal = canonicalGraphScopedAuthorSealFromAssertionSealV1(params.seal);
      kaUal = seal.kaUal;
      const scope = this.resolveRfc64SwmAuthorInventoryScopeV1(
        params.contextGraphId,
        seal.authorAddress,
      );
      const persistence = this.rfc64PersistenceV1;
      if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
      const signer = this.createRfc64CatalogAuthorSignerV1(seal.authorAddress);
      const removed = await removeRfc64SwmAuthorInventoryRowV1(persistence.inventory, {
        scope,
        kaUal: seal.kaUal,
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
    const autoPublishPolicy = this.config.rfc64PublicCatalogAutoPublishPolicy;
    if (autoPublishPolicy === undefined) return null;
    if (
      autoPublishPolicy.mode === 'selected-public'
      && !autoPublishPolicy.selectedContextGraphs.includes(params.contextGraphId)
    ) return null;
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
      peers: autoPublishPolicy.config.peers,
      catalogIssuerDelegationEffectiveAt:
        autoPublishPolicy.config.catalogIssuerDelegationEffectiveAt
        ?? ('0' as TimestampMsV1),
      catalogIssuerDelegationExpiresAt:
        autoPublishPolicy.config.catalogIssuerDelegationExpiresAt,
    });
  }

  private isRfc64SwmAuthorInventorySelectedV1(
    this: DKGAgent,
    contextGraphId: string,
    subGraphName: string | null | undefined,
  ): boolean {
    const policy = this.config.rfc64PublicCatalogAutoPublishPolicy;
    return policy !== undefined
      && (subGraphName === undefined || subGraphName === null)
      && (
        policy.mode === 'all-accepted-public'
        || policy.selectedContextGraphs.includes(contextGraphId)
      );
  }

  private resolveRfc64SwmAuthorInventoryScopeV1(
    this: DKGAgent,
    contextGraphId: ContextGraphIdV1,
    authorAddress: EvmAddressV1,
  ): SwmAuthorInventoryScopeV1 {
    const networkId = (this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.chain.chainId) as NetworkIdV1;
    if (networkId === 'none') {
      throw new Error('RFC-64 SWM inventory requires a trusted deployment network');
    }
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error('RFC-64 public catalog service is unavailable');
    }
    const acceptedPolicy = service.acceptedPolicySnapshot(networkId, contextGraphId);
    if (acceptedPolicy === null || acceptedPolicy.policy.accessPolicy !== 0) {
      throw new Error(
        'RFC-64 SWM inventory requires an independently accepted current public policy',
      );
    }
    return Object.freeze({
      networkId,
      contextGraphId,
      governanceChainId: acceptedPolicy.policy.governanceChainId,
      governanceContractAddress: acceptedPolicy.policy.governanceContractAddress,
      ownershipTransitionDigest: acceptedPolicy.policy.ownershipTransitionDigest,
      subGraphName: null,
      authorAddress,
      era: acceptedPolicy.policy.era,
    });
  }

  private async readRfc64SwmShareTimestampV1(
    this: DKGAgent,
    contextGraphId: string,
    shareOperationId: string,
    kaUal: string,
    assertionVersion: string,
    subGraphName: string | null | undefined,
  ): Promise<TimestampMsV1> {
    const metaGraph = new GraphManager(this.store).sharedMemoryMetaUri(
      contextGraphId,
      subGraphName ?? undefined,
    );
    const result = await this.store.query(
      `SELECT ?publishedAt ?assertionVersion WHERE { GRAPH <${assertSafeIri(metaGraph)}> {
        ?operation <http://dkg.io/ontology/shareOperationId> ${sparqlString(shareOperationId)} ;
          <http://dkg.io/ontology/kaUal> <${assertSafeIri(kaUal)}> ;
          <http://dkg.io/ontology/assertionVersion> ?assertionVersion ;
          <http://dkg.io/ontology/publishedAt> ?publishedAt .
      } } LIMIT 2`,
      { source: 'agent.rfc64.swmInventory.publishedAt' },
    );
    if (result.type !== 'bindings' || result.bindings.length !== 1) {
      throw new Error('durable SWM share has no unique publishedAt timestamp');
    }
    const raw = result.bindings[0]?.['publishedAt'];
    const rawVersion = result.bindings[0]?.['assertionVersion'];
    const publishedAt = raw === undefined ? '' : stripLiteral(raw);
    const timestamp = Date.parse(publishedAt);
    const canonicalIso = Number.isSafeInteger(timestamp) && timestamp >= 0
      ? new Date(timestamp).toISOString()
      : '';
    if (
      rawVersion === undefined
      || stripLiteral(rawVersion) !== assertionVersion
      || !Number.isSafeInteger(timestamp)
      || timestamp < 0
      || (
        canonicalIso !== publishedAt
        && canonicalIso.replace(/\.000Z$/u, 'Z') !== publishedAt
      )
    ) {
      throw new Error('durable SWM share publishedAt is not a canonical timestamp');
    }
    return timestamp.toString() as TimestampMsV1;
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
