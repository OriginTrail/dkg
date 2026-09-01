// SPDX-License-Identifier: Apache-2.0

/** Selected-CG durable SWM-inventory to signed-catalog projection owner. */

import {
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  computeSwmAuthorInventoryScopeDigestV1,
  type AssertionCoordinateV1,
  type AuthorCatalogScopeV1,
  type AuthorLaneScopeV1,
  type CatalogSealDeploymentProfileV1,
  type CanonicalDeterministicUalV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type PositiveDecimalU64V1,
  type SwmAuthorInventoryScopeV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { ethers } from 'ethers';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import type {
  Rfc64CatalogAuthorSignerV1,
  Rfc64CatalogSuccessorAssetInputV1,
} from './dkg-agent-rfc64-catalog.js';
import type {
  ReconcileRfc64PublicRootCatalogExactSetResultV1,
  Rfc64CatalogProjectionTargetPolicyV1,
} from './dkg-agent-rfc64-catalog-upsert.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';
import {
  raceRfc64AgainstAbortV1 as raceAgainstAbortV1,
  throwIfRfc64AbortedV1 as throwIfAbortedV1,
} from './rfc64/abort-v1.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from
  './rfc64/swm-inventory-shadow-runtime-v1.js';
import { snapshotRfc64CatalogDeploymentProfileV1 } from
  './rfc64/catalog-authority-config-v1.js';
import type { Rfc64PublicCatalogServiceV1 } from
  './rfc64/public-catalog-service-v1.js';
import { prepareRfc64SwmInventoryCatalogTargetV1 } from
  './rfc64/swm-inventory-catalog-reconciler-v1.js';
import {
  resolveRfc64ConfirmedVmRepairCatalogAssetV1,
  resolveRfc64InventoryWorkspaceCatalogAssetV1,
} from './rfc64/swm-catalog-durable-asset-resolver-v1.js';

export interface ReconcileRfc64PublicCatalogFromSwmInventoryParamsV1 {
  readonly contextGraphId: ContextGraphIdV1;
  readonly authorAddress: EvmAddressV1;
  readonly signal?: AbortSignal;
}

export interface ReconcileRfc64PublicCatalogFromSwmInventoryResultV1
  extends ReconcileRfc64PublicRootCatalogExactSetResultV1 {
  readonly inventoryHeadObjectDigest: Digest32V1;
}

interface ResolvedRfc64CatalogAuthoringLaneBaseV1 {
  readonly networkId: NetworkIdV1;
  readonly policySourceKind: 'finalized-chain' | 'owner-signed-unregistered';
  readonly service: Rfc64PublicCatalogServiceV1;
  readonly announcementPeers: readonly string[];
  readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
  readonly scopeBase: Readonly<Omit<AuthorLaneScopeV1, 'authorAddress'>>;
}

type ResolvedRfc64CatalogAuthoringLaneV1 =
  | Readonly<ResolvedRfc64CatalogAuthoringLaneBaseV1 & {
    readonly kind: 'public';
    readonly projectionTargetPolicy: 'exact-replacement';
    readonly acceptsFinalizedVmRepair: false;
  }>
  | Readonly<ResolvedRfc64CatalogAuthoringLaneBaseV1 & {
    readonly kind: 'private';
    readonly projectionTargetPolicy: Rfc64CatalogProjectionTargetPolicyV1;
    readonly acceptsFinalizedVmRepair: boolean;
  }>;

type Rfc64CatalogAuthoringLaneDecisionV1 =
  | Readonly<{ readonly status: 'inactive' }>
  | Readonly<{ readonly status: 'unavailable'; readonly error: Error }>
  | Readonly<{
    readonly status: 'active';
    readonly lane: ResolvedRfc64CatalogAuthoringLaneV1;
  }>;

export function rfc64CatalogLaneAcceptsWorkspaceHeadV1(
  lane: ResolvedRfc64CatalogAuthoringLaneV1,
  accessPolicy: 'public' | 'ownerOnly' | 'allowList' | undefined,
): boolean {
  return lane.kind === 'public'
    ? accessPolicy === 'public'
    : accessPolicy === 'ownerOnly' || accessPolicy === 'allowList';
}

export class Rfc64SwmCatalogProjectionMethods extends DKGAgentBase {
  /** Project the latest authenticated durable author inventory into its signed catalog. */
  async reconcileRfc64PublicCatalogFromSwmInventoryV1(
    this: DKGAgent,
    params: ReconcileRfc64PublicCatalogFromSwmInventoryParamsV1,
  ): Promise<ReconcileRfc64PublicCatalogFromSwmInventoryResultV1 | null> {
    assertContextGraphIdV1(params.contextGraphId, 'SWM catalog reconcile contextGraphId');
    assertCanonicalEvmAddress(params.authorAddress, 'SWM catalog reconcile authorAddress');
    throwIfAbortedV1(params.signal);
    const lane = this.resolveRfc64CatalogAuthoringLaneV1(params.contextGraphId, null);
    if (lane === null) return null;
    return this.reconcileRfc64PublicCatalogFromSwmInventoryLaneV1(lane, params);
  }

  /**
   * Move one chain-confirmed private placement from the pending SWM inventory
   * into the durable catalog. The catalog retains prior finalized placements;
   * pre-finalized rows are never projected through this lane.
   */
  protected async publishRfc64FinalizedPrivateCatalogPlacementV1(
    this: DKGAgent,
    params: Readonly<{
      readonly contextGraphId: ContextGraphIdV1;
      readonly authorAddress: EvmAddressV1;
      readonly inventoryScope: SwmAuthorInventoryScopeV1;
      readonly assertionCoordinate: AssertionCoordinateV1;
      readonly assertionVersion: PositiveDecimalU64V1;
      readonly kaUal: CanonicalDeterministicUalV1;
      readonly sealDigest: Digest32V1;
    }>,
  ): Promise<AppliedCatalogHeadSnapshotV1 | null> {
    const lane = this.resolveRfc64CatalogAuthoringLaneV1(params.contextGraphId, null);
    if (lane === null || !lane.acceptsFinalizedVmRepair) {
      throw new Error('RFC-64 finalized-private placement repair lane is inactive');
    }
    const currentInventoryScope = Object.freeze({
      ...lane.scopeBase,
      authorAddress: params.authorAddress,
    }) as SwmAuthorInventoryScopeV1;
    if (
      computeSwmAuthorInventoryScopeDigestV1(currentInventoryScope)
      !== computeSwmAuthorInventoryScopeDigestV1(params.inventoryScope)
    ) {
      throw new Error(
        'RFC-64 finalized-private placement repair conflicts with a policy transition',
      );
    }
    const inventoryScope = params.inventoryScope;
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
    const inventoryScopeDigest = computeSwmAuthorInventoryScopeDigestV1(inventoryScope);
    const snapshot = persistence.swmAuthorInventory.readSwmAuthorInventorySnapshotV1(
      inventoryScopeDigest,
      params.authorAddress,
    );
    const row = snapshot?.rows.find((candidate) => (
      candidate.assertionCoordinate === params.assertionCoordinate
      && candidate.assertionVersion === params.assertionVersion
      && candidate.kaUal === params.kaUal
      && candidate.sealDigest === params.sealDigest
    ));
    const scope = Object.freeze({
      ...inventoryScope,
      bucketCount: '1',
    }) as AuthorCatalogScopeV1;
    if (await this.rfc64CatalogCoversConfirmedSwmRowV1({
      scope,
      expectedRow: params,
    })) return null;
    let asset: Rfc64CatalogSuccessorAssetInputV1;
    if (row === undefined) {
      asset = await resolveRfc64ConfirmedVmRepairCatalogAssetV1({
        store: this.store,
        publicSnapshotStore: this.publicSnapshotStore,
        contextGraphId: params.contextGraphId,
        authorAddress: params.authorAddress,
        identity: params,
      });
    } else {
      asset = await resolveRfc64InventoryWorkspaceCatalogAssetV1({
        store: this.store,
        publicSnapshotStore: this.publicSnapshotStore,
        contextGraphId: params.contextGraphId,
        authorAddress: params.authorAddress,
        laneKind: lane.kind,
        row,
      });
    }
    lane.service.acceptedPolicySnapshotForCatalogScope(scope);
    return this.upsertConfirmedRfc64PublicRootCatalogAssetV1({
      scope,
      author: this.createRfc64CatalogAuthorSignerV1(params.authorAddress),
      asset,
      deployment: await this.resolveRfc64AutoPublishDeploymentProfileV1(lane.networkId),
      peers: lane.announcementPeers,
      catalogIssuerDelegationEffectiveAt: lane.catalogIssuerDelegationEffectiveAt,
      catalogIssuerDelegationExpiresAt: lane.catalogIssuerDelegationExpiresAt,
    });
  }

  /** Canonical selected-CG admission shared by inventory and projection. */
  protected resolveRfc64CatalogAuthoringLaneV1(
    this: DKGAgent,
    contextGraphId: string,
    subGraphName: string | null | undefined,
  ): ResolvedRfc64CatalogAuthoringLaneV1 | null {
    const decision = this.resolveRfc64CatalogAuthoringLaneDecisionV1(
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
          () => wallet.signMessage(message),
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
          () => (
            signMessageAs !== undefined
              ? signMessageAs(authorAddress, message)
              : signMessage !== undefined
                ? signMessage(message)
                : Promise.reject(new Error('RFC-64 configured chain has no message signer'))
          ),
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
    lane: ResolvedRfc64CatalogAuthoringLaneV1,
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
    const inventoryScopeKey = `${inventoryScopeDigest}\n${params.authorAddress}`;
    // Hold the inventory lock only long enough to take one immutable durable
    // snapshot. Catalog construction, signing, storage and peer fan-out are
    // intentionally outside this lock so a VM-confirmation removal never
    // waits for slow catalog delivery. Any mutation after this snapshot marks
    // the supervisor dirty and causes a latest-state follow-up pass.
    while (true) {
      const snapshot = await rfc64SwmInventoryShadowRuntimeV1(this).runScopeExclusive(
        inventoryScopeKey,
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
        resolveAsset: (row) => resolveRfc64InventoryWorkspaceCatalogAssetV1({
          store: this.store,
          publicSnapshotStore: this.publicSnapshotStore,
          contextGraphId: params.contextGraphId,
          authorAddress: params.authorAddress,
          laneKind: lane.kind,
          row,
          signal: params.signal,
        }),
      });
      throwIfAbortedV1(params.signal);
      lane.service.acceptedPolicySnapshotForCatalogScope(prepared.catalogScope);
      const deployment = await this.resolveRfc64AutoPublishDeploymentProfileV1(
        lane.networkId,
      );
      throwIfAbortedV1(params.signal);
      const reconciled = await this.reconcileRfc64SwmInventoryCatalogV1({
          scope: prepared.catalogScope,
          author: this.createRfc64CatalogAuthorSignerV1(
            params.authorAddress,
            params.signal,
          ),
          assets: prepared.assets,
          deployment,
          peers: lane.announcementPeers,
          catalogIssuerDelegationEffectiveAt: lane.catalogIssuerDelegationEffectiveAt,
          catalogIssuerDelegationExpiresAt: lane.catalogIssuerDelegationExpiresAt,
          targetPolicy: lane.projectionTargetPolicy,
          commitAppliedHeadIfInventoryCurrent: (commit) => (
            rfc64SwmInventoryShadowRuntimeV1(this).runScopeExclusive(
              inventoryScopeKey,
              () => {
                const current = persistence.swmAuthorInventory
                  .readSwmAuthorInventorySnapshotV1(
                    inventoryScopeDigest,
                    params.authorAddress,
                  );
                return Promise.resolve(Object.freeze({
                  // Never abandon an already-signed branch. Commit it as the
                  // unique next version, then let the projection loop advance
                  // from that durable head when its source snapshot is stale.
                  appliedHead: commit(),
                  sourceCurrent:
                    current?.head.objectDigest === prepared.inventoryHeadObjectDigest,
                }));
              },
              params.signal,
            )
          ),
          signal: params.signal,
      });
      if (!reconciled.sourceCurrent) {
        throwIfAbortedV1(params.signal);
        continue;
      }
      const { sourceCurrent: _sourceCurrent, ...result } = reconciled;
      return Object.freeze({
        ...result,
        inventoryHeadObjectDigest: prepared.inventoryHeadObjectDigest as Digest32V1,
      });
    }
  }

  private resolveRfc64CatalogAuthoringLaneDecisionV1(
    this: DKGAgent,
    contextGraphId: string,
    subGraphName: string | null | undefined,
  ): Rfc64CatalogAuthoringLaneDecisionV1 {
    if (!this.resolveRfc64CatalogReceiverAuthorityV1(
      contextGraphId,
    ).authoringAllowed) return Object.freeze({ status: 'inactive' });
    const authoringPolicy = this.config.rfc64CatalogAuthoringPolicy;
    const exactControl = authoringPolicy?.byContextGraph[contextGraphId];
    const publicDefault = authoringPolicy?.publicDefault;
    if (
      (exactControl === undefined && publicDefault === undefined)
      || (subGraphName !== undefined && subGraphName !== null)
    ) return Object.freeze({ status: 'inactive' });
    assertContextGraphIdV1(contextGraphId, 'RFC-64 catalog authoring contextGraphId');
    const networkId = (this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.chain.chainId) as NetworkIdV1;
    if (networkId === 'none') {
      return Object.freeze({
        status: 'unavailable',
        error: new Error('RFC-64 catalog authoring requires a trusted deployment network'),
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
          'RFC-64 catalog authoring requires an independently accepted current policy',
        ),
      });
    }
    if (exactControl === undefined && acceptedPolicy.policy.accessPolicy !== 0) {
      return Object.freeze({ status: 'inactive' });
    }
    const selectedControl = exactControl ?? Object.freeze({
      kind: 'selected-public' as const,
      contextGraphId,
      announcementPeers: publicDefault!.announcementPeers,
      catalogIssuerDelegationEffectiveAt:
        publicDefault!.catalogIssuerDelegationEffectiveAt,
      catalogIssuerDelegationExpiresAt:
        publicDefault!.catalogIssuerDelegationExpiresAt,
    });
    if (
      (acceptedPolicy.policy.accessPolicy === 0 && selectedControl.kind !== 'selected-public')
      || (acceptedPolicy.policy.accessPolicy === 1
        && selectedControl.kind !== 'selected-private')
    ) {
      return Object.freeze({
        status: 'unavailable',
        error: new Error('RFC-64 selected-CG authoring policy changed after activation'),
      });
    }
    const commonLane = Object.freeze({
      networkId,
      policySourceKind: acceptedPolicy.policy.source.kind,
      service,
      announcementPeers: selectedControl.announcementPeers,
      catalogIssuerDelegationEffectiveAt:
        selectedControl.catalogIssuerDelegationEffectiveAt,
      catalogIssuerDelegationExpiresAt:
        selectedControl.catalogIssuerDelegationExpiresAt,
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
    const lane: ResolvedRfc64CatalogAuthoringLaneV1 = acceptedPolicy.policy.accessPolicy === 0
      ? Object.freeze({
        ...commonLane,
        kind: 'public',
        projectionTargetPolicy: 'exact-replacement',
        acceptsFinalizedVmRepair: false,
      })
      : Object.freeze({
        ...commonLane,
        kind: 'private',
        projectionTargetPolicy: acceptedPolicy.policy.source.kind === 'finalized-chain'
          ? 'monotonic-union'
          : 'exact-replacement',
        acceptsFinalizedVmRepair: acceptedPolicy.policy.source.kind === 'finalized-chain',
      });
    return Object.freeze({
      status: 'active',
      lane,
    });
  }

}
