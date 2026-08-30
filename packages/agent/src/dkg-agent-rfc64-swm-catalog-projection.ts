// SPDX-License-Identifier: Apache-2.0

/** Selected-CG durable SWM-inventory to signed-catalog projection owner. */

import {
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  assertSafeIri,
  canonicalGraphScopedAuthorSealFromAssertionSealV1,
  computeSwmAuthorInventoryScopeDigestV1,
  contextGraphAssertionUri,
  contextGraphMetaUri,
  encodeCanonicalCgSharedPublicRootProjectionV1,
  parseGraphScopedAssertionSealCandidate,
  type AuthorLaneScopeV1,
  type CatalogSealDeploymentProfileV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SwmAuthorInventoryRowV1,
  type SwmAuthorInventoryScopeV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { GraphManager } from '@origintrail-official/dkg-storage';
import {
  resolveKnowledgeAssetOperationPublicQuads,
  resolvePublishedKnowledgeAssetWorkspaceHead,
} from '@origintrail-official/dkg-publisher';
import { ethers } from 'ethers';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type {
  Rfc64CatalogAuthorSignerV1,
  Rfc64CatalogSuccessorAssetInputV1,
} from './dkg-agent-rfc64-catalog.js';
import type { ReconcileRfc64PublicRootCatalogExactSetResultV1 } from
  './dkg-agent-rfc64-catalog-upsert.js';
import type { Rfc64PublicCatalogAutoPublishConfigV1 } from './dkg-agent-types.js';
import {
  raceRfc64AgainstAbortV1 as raceAgainstAbortV1,
  throwIfRfc64AbortedV1 as throwIfAbortedV1,
} from './rfc64/abort-v1.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from
  './rfc64/swm-inventory-shadow-runtime-v1.js';
import { snapshotRfc64CatalogDeploymentProfileV1 } from
  './rfc64/catalog-authority-config-v1.js';
import { resolveRfc64CatalogAuthorityDecisionV1 } from
  './rfc64/public-catalog-activation-config-v1.js';
import type { Rfc64PublicCatalogServiceV1 } from
  './rfc64/public-catalog-service-v1.js';
import { prepareRfc64SwmInventoryCatalogTargetV1 } from
  './rfc64/swm-inventory-catalog-reconciler-v1.js';

export interface ReconcileRfc64PublicCatalogFromSwmInventoryParamsV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly authorAddress: EvmAddressV1;
  readonly signal?: AbortSignal;
}

export interface ReconcileRfc64PublicCatalogFromSwmInventoryResultV1
  extends ReconcileRfc64PublicRootCatalogExactSetResultV1 {
  readonly inventoryHeadObjectDigest: Digest32V1;
}

export type Rfc64LocalPublicCatalogAuthorRepairResultV1 =
  | Readonly<{ readonly outcome: 'inactive' }>
  | Readonly<{ readonly outcome: 'unavailable'; readonly error: string }>
  | Readonly<{ readonly outcome: 'no-inventory' }>
  | Readonly<{
    readonly outcome: 'reconciled';
    readonly reconciliation: ReconcileRfc64PublicCatalogFromSwmInventoryResultV1;
  }>;

export interface ResolvedRfc64AcceptedPublicRootLaneV1 {
  readonly networkId: NetworkIdV1;
  readonly service: Rfc64PublicCatalogServiceV1;
  readonly autoPublishConfig: Readonly<Rfc64PublicCatalogAutoPublishConfigV1>;
  readonly scopeBase: Readonly<Omit<AuthorLaneScopeV1, 'authorAddress'>>;
}

type Rfc64AcceptedPublicRootLaneDecisionV1 =
  | Readonly<{ readonly status: 'inactive' }>
  | Readonly<{ readonly status: 'unavailable'; readonly error: Error }>
  | Readonly<{
    readonly status: 'active';
    readonly lane: ResolvedRfc64AcceptedPublicRootLaneV1;
  }>;

export class Rfc64SwmCatalogProjectionMethods extends DKGAgentBase {
  /** Project the latest authenticated durable author inventory into its signed catalog. */
  async reconcileRfc64PublicCatalogFromSwmInventoryV1(
    this: DKGAgent,
    params: ReconcileRfc64PublicCatalogFromSwmInventoryParamsV1,
  ): Promise<ReconcileRfc64PublicCatalogFromSwmInventoryResultV1 | null> {
    assertContextGraphIdV1(params.contextGraphId, 'SWM catalog reconcile contextGraphId');
    assertCanonicalEvmAddress(params.authorAddress, 'SWM catalog reconcile authorAddress');
    throwIfAbortedV1(params.signal);
    const lane = this.resolveRfc64AcceptedPublicRootLaneV1(params.contextGraphId, null);
    if (lane === null) return null;
    return this.reconcileRfc64PublicCatalogFromSwmInventoryLaneV1(lane, params);
  }

  /** One restart/periodic repair attempt for a bounded graph and local author. */
  async repairRfc64LocalPublicCatalogAuthorV1(
    this: DKGAgent,
    params: Readonly<{
      contextGraphId: string;
      authorAddress: string;
      signal?: AbortSignal;
    }>,
  ): Promise<Rfc64LocalPublicCatalogAuthorRepairResultV1> {
    throwIfAbortedV1(params.signal);
    assertContextGraphIdV1(params.contextGraphId, 'SWM catalog repair contextGraphId');
    const authorAddress = params.authorAddress.toLowerCase() as EvmAddressV1;
    assertCanonicalEvmAddress(authorAddress, 'SWM catalog repair authorAddress');
    if (!this.listLocalAgents().some(
      ({ agentAddress }) => agentAddress.toLowerCase() === authorAddress,
    )) return Object.freeze({ outcome: 'inactive' });
    const laneDecision = this.resolveRfc64AcceptedPublicRootLaneDecisionV1(
      params.contextGraphId,
      null,
    );
    if (laneDecision.status === 'inactive') return Object.freeze({ outcome: 'inactive' });
    if (laneDecision.status === 'unavailable') {
      return Object.freeze({
        outcome: 'unavailable',
        error: laneDecision.error.message,
      });
    }
    const reconciliation = await this.reconcileRfc64PublicCatalogFromSwmInventoryLaneV1(
      laneDecision.lane,
      {
        contextGraphId: params.contextGraphId as ContextGraphIdV1,
        authorAddress,
        signal: params.signal,
      },
    );
    return reconciliation === null
      ? Object.freeze({ outcome: 'no-inventory' })
      : Object.freeze({ outcome: 'reconciled', reconciliation });
  }

  /** Canonical selected public-root admission shared by inventory and projection. */
  resolveRfc64AcceptedPublicRootLaneV1(
    this: DKGAgent,
    contextGraphId: string,
    subGraphName: string | null | undefined,
  ): ResolvedRfc64AcceptedPublicRootLaneV1 | null {
    const decision = this.resolveRfc64AcceptedPublicRootLaneDecisionV1(
      contextGraphId,
      subGraphName,
    );
    if (decision.status === 'inactive') return null;
    if (decision.status === 'unavailable') throw decision.error;
    return decision.lane;
  }

  createRfc64CatalogAuthorSignerV1(
    this: DKGAgent,
    authorAddress: EvmAddressV1,
    signal?: AbortSignal,
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
        signMessage: (message: Uint8Array) => raceAgainstAbortV1(
          wallet.signMessage(message),
          signal,
        ),
      });
    }
    const signMessageAs = this.chain.signMessageAs?.bind(this.chain);
    const signMessage = this.chain.signMessage?.bind(this.chain);
    return Object.freeze({
      address: authorAddress,
      signMessage: async (message: Uint8Array) => {
        const compact = await raceAgainstAbortV1(
          signMessageAs !== undefined
            ? signMessageAs(authorAddress, message)
            : signMessage !== undefined
              ? signMessage(message)
              : Promise.reject(new Error('RFC-64 configured chain has no message signer')),
          signal,
        );
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

  async resolveRfc64AutoPublishDeploymentProfileV1(
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

  private async reconcileRfc64PublicCatalogFromSwmInventoryLaneV1(
    this: DKGAgent,
    lane: ResolvedRfc64AcceptedPublicRootLaneV1,
    params: ReconcileRfc64PublicCatalogFromSwmInventoryParamsV1,
  ): Promise<ReconcileRfc64PublicCatalogFromSwmInventoryResultV1 | null> {
    throwIfAbortedV1(params.signal);
    const inventoryScope = Object.freeze({
      ...lane.scopeBase,
      authorAddress: params.authorAddress,
    }) as SwmAuthorInventoryScopeV1;
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
    const inventoryScopeDigest = computeSwmAuthorInventoryScopeDigestV1(inventoryScope);
    // Hold the inventory lock only long enough to take one immutable durable
    // snapshot. Catalog construction, signing, storage and peer fan-out are
    // intentionally outside this lock so a VM-confirmation removal never
    // waits for slow catalog delivery. Any mutation after this snapshot marks
    // the supervisor dirty and causes a latest-state follow-up pass.
    const snapshot = await rfc64SwmInventoryShadowRuntimeV1(this).runScopeExclusive(
      `${inventoryScopeDigest}\n${params.authorAddress}`,
      () => Promise.resolve(
        persistence.swmAuthorInventory.readSwmAuthorInventorySnapshotV1(
          inventoryScopeDigest,
          params.authorAddress,
        ),
      ),
      params.signal,
    );
    if (snapshot === null) return null;
    throwIfAbortedV1(params.signal);
    const prepared = await prepareRfc64SwmInventoryCatalogTargetV1({
      snapshot,
      resolveAsset: (row) => this.resolveRfc64SwmInventoryCatalogAssetV1(
        params.contextGraphId,
        params.authorAddress,
        row,
        params.signal,
      ),
    });
    throwIfAbortedV1(params.signal);
    lane.service.acceptedPolicySnapshotForCatalogScope(prepared.catalogScope);
    const deployment = await this.resolveRfc64AutoPublishDeploymentProfileV1(
      lane.networkId,
    );
    throwIfAbortedV1(params.signal);
    const reconciled = await this.reconcileRfc64PublicRootCatalogExactSetV1({
      scope: prepared.catalogScope,
      author: this.createRfc64CatalogAuthorSignerV1(
        params.authorAddress,
        params.signal,
      ),
      assets: prepared.assets,
      deployment,
      peers: lane.autoPublishConfig.peers,
      catalogIssuerDelegationEffectiveAt:
        lane.autoPublishConfig.catalogIssuerDelegationEffectiveAt
        ?? ('0' as TimestampMsV1),
      catalogIssuerDelegationExpiresAt:
        lane.autoPublishConfig.catalogIssuerDelegationExpiresAt,
      signal: params.signal,
    });
    return Object.freeze({
      ...reconciled,
      inventoryHeadObjectDigest: prepared.inventoryHeadObjectDigest as Digest32V1,
    });
  }

  private resolveRfc64AcceptedPublicRootLaneDecisionV1(
    this: DKGAgent,
    contextGraphId: string,
    subGraphName: string | null | undefined,
  ): Rfc64AcceptedPublicRootLaneDecisionV1 {
    const rollout = this.config.rfc64CatalogRollout;
    if (!resolveRfc64CatalogAuthorityDecisionV1(
      rollout,
      contextGraphId,
    ).authoringAllowed) return Object.freeze({ status: 'inactive' });
    const policy = this.config.rfc64PublicCatalogAutoPublishPolicy;
    if (
      policy === undefined
      || (subGraphName !== undefined && subGraphName !== null)
      || (
        policy.mode === 'selected-public'
        && !policy.selectedContextGraphs.includes(contextGraphId)
      )
    ) return Object.freeze({ status: 'inactive' });
    assertContextGraphIdV1(contextGraphId, 'RFC-64 public-root contextGraphId');
    const networkId = (this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.chain.chainId) as NetworkIdV1;
    if (networkId === 'none') {
      return Object.freeze({
        status: 'unavailable',
        error: new Error('RFC-64 public-root activation requires a trusted deployment network'),
      });
    }
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      return Object.freeze({
        status: 'unavailable',
        error: new Error('RFC-64 public catalog service is unavailable'),
      });
    }
    const acceptedPolicy = service.acceptedPolicySnapshot(networkId, contextGraphId);
    if (acceptedPolicy === null) {
      return Object.freeze({
        status: 'unavailable',
        error: new Error(
          'RFC-64 public-root activation requires an independently accepted current public policy',
        ),
      });
    }
    if (acceptedPolicy.policy.accessPolicy !== 0) {
      return Object.freeze({ status: 'inactive' });
    }
    return Object.freeze({
      status: 'active',
      lane: Object.freeze({
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
      }),
    });
  }

  private async resolveRfc64SwmInventoryCatalogAssetV1(
    this: DKGAgent,
    contextGraphId: ContextGraphIdV1,
    authorAddress: EvmAddressV1,
    row: Readonly<SwmAuthorInventoryRowV1>,
    signal?: AbortSignal,
  ): Promise<Rfc64CatalogSuccessorAssetInputV1> {
    throwIfAbortedV1(signal);
    const assertionUri = contextGraphAssertionUri(
      contextGraphId,
      authorAddress,
      row.assertionCoordinate,
    );
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const sealResult = await this.store.query(
      `CONSTRUCT { <${assertSafeIri(assertionUri)}> ?p ?o } WHERE { GRAPH <${assertSafeIri(metaGraph)}> { <${assertSafeIri(assertionUri)}> ?p ?o } }`,
      { source: 'agent.rfc64.swmInventory.catalogReconcile.seal', signal },
    );
    const candidate = parseGraphScopedAssertionSealCandidate(
      sealResult.type === 'quads' ? sealResult.quads : [],
      assertionUri,
    );
    if (candidate === undefined) {
      throw new Error(`durable SWM inventory asset ${row.kaUal} has no strict author seal`);
    }
    if (
      candidate.coordinate.scope !== contextGraphId
      || candidate.coordinate.agentAddress.toLowerCase() !== authorAddress
      || candidate.coordinate.name !== row.assertionCoordinate
    ) {
      throw new Error(`durable SWM inventory asset ${row.kaUal} has a different seal coordinate`);
    }
    const seal = canonicalGraphScopedAuthorSealFromAssertionSealV1(candidate.seal);
    const graphManager = new GraphManager(this.store);
    const head = await resolvePublishedKnowledgeAssetWorkspaceHead({
      store: this.store,
      graphManager,
      contextGraphId,
      kaUal: row.kaUal,
    });
    throwIfAbortedV1(signal);
    if (
      head === undefined
      || head.shareOperationId !== row.shareOperationId
      || head.assertionVersion !== row.assertionVersion
      || head.publicTripleCount !== Number(row.publicTripleCount)
      || head.privateTripleCount !== Number(row.privateTripleCount)
      || head.accessPolicy !== 'public'
    ) {
      throw new Error(`durable SWM head differs from signed inventory row ${row.kaUal}`);
    }
    const snapshot = await resolveKnowledgeAssetOperationPublicQuads({
      store: this.store,
      graphManager,
      contextGraphId,
      shareOperationId: row.shareOperationId,
      kaUal: row.kaUal,
      assertionVersion: row.assertionVersion,
      publicSnapshotStore: this.publicSnapshotStore,
    });
    throwIfAbortedV1(signal);
    return Object.freeze({
      assertionCoordinate: row.assertionCoordinate,
      projectionBytes: encodeCanonicalCgSharedPublicRootProjectionV1(snapshot.quads),
      seal,
    });
  }
}
