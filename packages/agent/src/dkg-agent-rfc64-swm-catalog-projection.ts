import { catalogAuthoringApplicability } from './internal/catalog-authoring-applicability.js';
import { SwmCatalogAuthorityNotReady } from './internal/swm-inventory-write.js';
// SPDX-License-Identifier: Apache-2.0

import { CatalogRepairConditionErrorV1, CatalogRepairLaneInactiveErrorV1 } from './rfc64/catalog-repair-diagnostics-v1.js';
/** Selected-CG durable SWM-inventory to signed-catalog projection owner. */

import {
  assertCanonicalDeterministicUalV1,
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  computeSwmAuthorInventoryScopeDigestV1,
  createOperationContext,
  type AuthorLaneScopeV1,
  type CatalogSealDeploymentProfileV1,
  type CanonicalDeterministicUalV1,
  type ContextGraphIdV1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type SwmAuthorInventoryScopeV1,
  type SwmAuthorInventorySnapshotV1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { withOwnedRpcRequestContext } from '@origintrail-official/dkg-chain';
import {
  storeLaneInflightLimit,
  withDefaultStoreWorkPriority,
} from '@origintrail-official/dkg-storage';
import { ethers } from 'ethers';

import { resolveFinalizedPlacementDecisionV1 } from './internal/finalized-placement-decision.js';
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
import {
  raceRfc64AgainstAbortV1 as raceAgainstAbortV1,
  throwIfRfc64AbortedV1 as throwIfAbortedV1,
} from './rfc64/abort-v1.js';
import { rfc64SwmInventoryShadowRuntimeV1 } from
  './rfc64/swm-inventory-shadow-runtime-v1.js';
import { snapshotRfc64CatalogDeploymentProfileV1 } from
  './rfc64/catalog-authority-config-v1.js';
import {
  catalogHeadDeliveryReportV1,
  type CatalogHeadDeliveryStatusV1,
} from './internal/catalog-head-delivery-report.js';
import type { Rfc64PublicCatalogServiceV1 } from
  './rfc64/public-catalog-service-v1.js';
import {
  RFC64_CATALOG_HEAD_HANDOFF_CANCELLED_V1,
  RFC64_CATALOG_HEAD_HANDOFF_UNAVAILABLE_V1,
  type DeliverRfc64PublicCatalogHeadInputV1,
  type Rfc64CatalogHeadDeliveryOptionsV1,
  type Rfc64CatalogHeadDeliveryOutcomeV1,
  type Rfc64CatalogHeadHandoffV1,
} from './rfc64/public-catalog-head-delivery-v1.js';
import type { Rfc64PublicCatalogHeadAnnouncementV1 } from
  './rfc64/public-catalog-transport-v1.js';
import { prepareRfc64SwmInventoryCatalogTargetV1 } from
  './rfc64/swm-inventory-catalog-reconciler-v1.js';
import {
  resolveRfc64ConfirmedVmRepairCatalogAssetV1,
  resolveRfc64InventoryWorkspaceCatalogAssetV1,
} from './rfc64/swm-catalog-durable-asset-resolver-v1.js';
import { markRfc64LegacySwmRepublishedV1 } from
  './rfc64/legacy-swm-boundary-v1.js';
import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from
  './rfc64/catalog-peers-v1.js';
import { signsThroughExternalSigner } from './external-author-signing.js';
import { heldAuthorSigner } from './author-signer.js';
import { rfc64AuthorDigestSignerV1 } from './rfc64/control-envelope-signer-v1.js';
import {
  INERT_CATALOG_PLACEMENT_ATTEMPT_V1,
  type CatalogPlacementAttemptV1,
} from './internal/catalog-placement-timing.js';
import { readOwedPlacementSealV1 } from './internal/owed-placement-seals.js';
import { healFinalizedSwmInventoryRowsV1 } from './internal/finalized-row-heal.js';
import { catalogRepairDiagnosticV1 } from './rfc64/catalog-repair-diagnostics-v1.js';
import type { Rfc64FinalizedPrivatePlacementRepairV1 } from
  './rfc64/finalized-private-placement-repair-store-v1.js';

const RFC64_DEFAULT_CATALOG_DELEGATION_EXPIRES_AT_V1 =
  '253402300799000' as TimestampMsV1;

/** Positive execution evidence, independent of whether the lane publishes a catalog head. */
export type ConfirmedCatalogObligationCompletionV1 = Readonly<
  | { status: 'applied'; action: 'private-placement' | 'public-retirement' }
  | { status: 'already-covered'; action: 'private-placement' }
  | { status: 'already-absent'; action: 'public-retirement' }
>;

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

export type Rfc64CatalogAuthoringLaneDecisionV1<Lane = ResolvedRfc64CatalogAuthoringLaneV1> =
  | Readonly<{ readonly status: 'inactive' }>
  | Readonly<{ readonly status: 'unavailable'; readonly error: Error }>
  | Readonly<{
    readonly status: 'active';
    readonly lane: Lane;
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
   * GH#3134 — this node retired its shared-memory copy of an asset because the asset is finalized,
   * which happens on an author's node when a curator publishes the author's shared asset under the
   * author's seal. The asset's row in the author's SWM inventory has no shared-memory head left to
   * resolve, and on a lane that drops confirmed rows it fails every later projection of the
   * author's catalog. So the row goes, as at the publishing node's confirmation; a finalized
   * private lane keeps its rows. Detached, and read only after the author's queued inventory work:
   * a share observer that already prepared the asset's row commits first. Never throws.
   */
  scheduleRfc64SwmInventoryRowRemovalAfterFinalizedTwinV1(
    this: DKGAgent,
    input: Readonly<{
      contextGraphId: string;
      kaUal: string;
      assertionVersion: string;
      subGraphName?: string;
    }>,
  ): void {
    const ctx = createOperationContext('system');
    const failed = (cause: unknown) => this.log.warn(
      ctx,
      `RFC-64 SWM inventory row of finalized ${input.kaUal} was not removed: `
        + (cause instanceof Error ? cause.message : String(cause)),
    );
    try {
      const persistence = this.rfc64PersistenceV1;
      if (persistence === undefined) return;
      // Without an active authoring lane this node keeps no inventory to project for the graph.
      const decision = this.resolveRfc64CatalogAuthoringLaneDecisionV1(
        input.contextGraphId,
        input.subGraphName ?? null,
      );
      if (decision.status !== 'active' || decision.lane.acceptsFinalizedVmRepair) return;
      const contextGraphId = input.contextGraphId as ContextGraphIdV1;
      const authorAddress = assertCanonicalDeterministicUalV1(input.kaUal).agentAddress;
      const scope = Object.freeze({ ...decision.lane.scopeBase, authorAddress }) as SwmAuthorInventoryScopeV1;
      const scopeDigest = computeSwmAuthorInventoryScopeDigestV1(scope);
      const runtime = rfc64SwmInventoryShadowRuntimeV1(this);
      const lane = { contextGraphId, authorAddress };
      // No inventory and no share of this author's on its way into one: no row to remove.
      if (
        persistence.swmAuthorInventory.readSwmAuthorInventoryHeadDigestV1(scopeDigest, authorAddress) === null
        && !runtime.hasInventoryWrites(lane)
      ) return;
      runtime.scheduleAfterInventoryWrites(lane, input.kaUal, async () => {
        if (runtime.shutdownSignal.aborted) return;
        try {
          const row = this.rfc64PersistenceV1?.swmAuthorInventory.readSwmAuthorInventoryRowV1(
            scopeDigest,
            authorAddress,
            input.kaUal as CanonicalDeterministicUalV1,
          ) ?? null;
          // A newer share's row has its own shared-memory head.
          if (row === null || BigInt(row.assertionVersion) > BigInt(input.assertionVersion)) return;
          const removed = await this.removeRfc64SwmAuthorInventoryRowV1({
            contextGraphId,
            scope,
            expectedRow: { assertionVersion: row.assertionVersion, kaUal: row.kaUal, sealDigest: row.sealDigest },
            signal: runtime.shutdownSignal,
          });
          if (removed.status !== 'applied' && removed.status !== 'absent') return;
          this.requestRfc64SwmCatalogProjectionV1({ contextGraphId, authorAddress, ctx });
          if (removed.status === 'applied') this.log.info(ctx, `Removed the RFC-64 SWM inventory row of finalized ${row.kaUal}`);
        } catch (cause) {
          if (!runtime.shutdownSignal.aborted) failed(cause);
        }
      });
    } catch (cause) {
      failed(cause);
    }
  }

  /**
   * Idempotent durable repair of one finalized-private placement. The supervisor runs the observed
   * variant with its admitted attempt's recorder; a call from anywhere else is unobserved.
   */
  async repairRfc64FinalizedPrivateCatalogPlacementV1(
    this: DKGAgent,
    repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
  ): Promise<'repaired' | 'already-complete'> {
    return this.repairObservedRfc64FinalizedPrivateCatalogPlacementV1(repair, INERT_CATALOG_PLACEMENT_ATTEMPT_V1);
  }

  /**
   * Move one chain-confirmed private placement from the pending SWM inventory
   * into the durable catalog. The catalog retains prior finalized placements;
   * pre-finalized rows are never projected through this lane. Phases are
   * charged to `placement` (GH#3081, observation only).
   */
  protected async publishRfc64FinalizedPrivateCatalogPlacementV1(
    this: DKGAgent,
    params: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>,
    placement: CatalogPlacementAttemptV1,
  ): Promise<ConfirmedCatalogObligationCompletionV1> {
    const decision = this.resolveRfc64FinalizedPlacementDecisionV1(params);
    if (decision.status === 'unavailable') throw decision.error;
    if (decision.status === 'inactive') throw new CatalogRepairLaneInactiveErrorV1('RFC-64 finalized-private placement repair lane is inactive');
    const { lane, currentInventoryScope, inventoryScope, scope, action } = decision;
    if (action === 'retire-public-row') {
      // Public VM discovery is chain-owned; this owed transition removes only the exact SWM row.
      const removed = await this.removeRfc64SwmAuthorInventoryConfirmedRowV1({
        scope: currentInventoryScope, expectedRow: params,
      });
      if (removed.status !== 'applied' && removed.status !== 'absent') {
        throw new Error('RFC-64 confirmed public inventory transition did not complete');
      }
      rfc64SwmInventoryShadowRuntimeV1(this).record(Object.freeze({
        status: removed.status, action: 'remove', attempts: removed.attempts,
        headObjectDigest: removed.snapshot?.head.objectDigest ?? null, error: null,
      }), params.contextGraphId, params.kaUal);
      this.requestRfc64SwmCatalogProjectionV1({
        contextGraphId: params.contextGraphId, authorAddress: params.authorAddress,
      });
      return { status: removed.status === 'applied' ? 'applied' : 'already-absent', action: 'public-retirement' };
    }
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) throw new CatalogRepairConditionErrorV1('persistence_unavailable', 'RFC-64 persistence is unavailable');
    const covered = await placement.measure('coverage', () => this.rfc64CatalogCoversConfirmedSwmRowV1({
      scope,
      expectedRow: params,
    }));
    placement.covered(covered);
    if (covered) return { status: 'already-covered', action: 'private-placement' };
    // This placement needs one sealed asset, not a whole-author completeness claim.
    const candidate = persistence.swmAuthorInventory.readSwmAuthorInventoryRowV1(
      computeSwmAuthorInventoryScopeDigestV1(inventoryScope), params.authorAddress, params.kaUal,
    );
    const row = candidate !== null && candidate.assertionCoordinate === params.assertionCoordinate
      && candidate.assertionVersion === params.assertionVersion && candidate.sealDigest === params.sealDigest
      ? candidate : undefined;
    const asset: Rfc64CatalogSuccessorAssetInputV1 = await placement.measure('asset', () => (row === undefined
      ? resolveRfc64ConfirmedVmRepairCatalogAssetV1({
        store: this.store,
        publicSnapshotStore: this.publicSnapshotStore,
        contextGraphId: params.contextGraphId,
        authorAddress: params.authorAddress,
        identity: params,
        // V2 owns its seal durably; legacy promotion markers retain their process-local fallback.
        retainedSeal: params.version === 2 ? params.seal : readOwedPlacementSealV1(this, params.sealDigest),
      })
      : resolveRfc64InventoryWorkspaceCatalogAssetV1({
        store: this.store,
        publicSnapshotStore: this.publicSnapshotStore,
        contextGraphId: params.contextGraphId,
        authorAddress: params.authorAddress,
        laneKind: lane.kind,
        row,
        retainedSeal: params.version === 2 ? params.seal : readOwedPlacementSealV1(this, params.sealDigest),
      })));
    lane.service.acceptedPolicySnapshotForCatalogScope(scope);
    await this.upsertObservedRfc64PublicRootCatalogAssetV1({
      scope,
      author: this.createRfc64CatalogAuthorSignerV1(params.authorAddress),
      asset,
      deployment: await this.resolveRfc64AutoPublishDeploymentProfileV1(lane.networkId),
      peers: this.resolveRfc64CatalogAnnouncementPeersV1(lane.announcementPeers),
      catalogIssuerDelegationEffectiveAt: lane.catalogIssuerDelegationEffectiveAt,
      catalogIssuerDelegationExpiresAt: lane.catalogIssuerDelegationExpiresAt,
    }, placement);
    return { status: 'applied', action: 'private-placement' };
  }

  /** Current authority, action and scope shared by repair admission and execution. */
  protected resolveRfc64FinalizedPlacementDecisionV1(this: DKGAgent, repair: Readonly<Rfc64FinalizedPrivatePlacementRepairV1>) {
    return resolveFinalizedPlacementDecisionV1(repair, () => this.resolveRfc64CatalogAuthoringLaneDecisionV1(repair.contextGraphId, null));
  }

  requiresRfc64ShareInventoryV1(this: DKGAgent, contextGraphId: string, subGraphName: string | undefined): boolean {
    return this.resolveRfc64ShareInventoryApplicabilityV1(contextGraphId, subGraphName).status === 'required';
  }

  /**
   * A bound share owes the signed-inventory handoff only where the commit-time lane can be
   * active. A fenced or non-responsible authority keeps the obligation above, but the share
   * completes and its row goes to the detached observer, like an unbound share.
   */
  requiresRfc64ShareInventoryHandoffV1(this: DKGAgent, contextGraphId: string, subGraphName: string | undefined): boolean {
    const decision = this.resolveRfc64ShareInventoryApplicabilityV1(contextGraphId, subGraphName);
    return decision.status === 'required' && decision.authority.authoringAllowed === true;
  }

  /** One receiver-authority read per decision; readiness gaps throw their typed cause. */
  private resolveRfc64ShareInventoryApplicabilityV1(this: DKGAgent, contextGraphId: string, subGraphName: string | undefined) {
    const decision = catalogAuthoringApplicability({ authority: this.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId),
      config: this.config, service: this.rfc64PublicCatalogServiceV1 }, contextGraphId, subGraphName);
    if (decision.status === 'unavailable') throw decision.error;
    return decision;
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
    // The legacy fallback for an author key held neither on the node nor by an
    // external signer: the configured chain adapter's own message signer.
    const signMessageAs = this.chain.signMessageAs?.bind(this.chain);
    const signMessage = this.chain.signMessage?.bind(this.chain);
    const signWithChain = async (message: Uint8Array): Promise<string> => {
      const compact = await raceAgainstAbortV1(
        () => (
          signMessageAs !== undefined
            ? signMessageAs(authorAddress, message)
            : signMessage !== undefined
              ? signMessage(message)
              : Promise.reject(new CatalogRepairConditionErrorV1('signer_mismatch', 'RFC-64 configured chain has no message signer'))
        ),
        signal,
      );
      const signature = ethers.Signature.from({
        r: ethers.hexlify(compact.r),
        yParityAndS: ethers.hexlify(compact.vs),
      }).serialized;
      if (ethers.verifyMessage(message, signature).toLowerCase() !== authorAddress) {
        throw new CatalogRepairConditionErrorV1('signer_mismatch', 'RFC-64 configured publisher cannot sign for the confirmed KA author');
      }
      return signature;
    };
    const authors = this.config?.authorSigners;
    const chain = this.chain;
    return Object.freeze({
      address: authorAddress,
      signMessage: async (message: Uint8Array) => {
        // The author's key held on the node, or by the external signer as an
        // author key (never a payer), signs. A node that signs externally never
        // falls back to its payers.
        throwIfAbortedV1(signal);
        const author = await heldAuthorSigner(this, authors, authorAddress);
        if (author !== undefined) return rfc64AuthorDigestSignerV1(authorAddress, author, signal)(message);
        if (signsThroughExternalSigner(chain)) {
          throw new CatalogRepairConditionErrorV1('signer_mismatch', `RFC-64: author ${authorAddress} has no key on this node and is no author key of its external signer`);
        }
        return signWithChain(message);
      },
    });
  }

  async resolveRfc64AutoPublishDeploymentProfileV1(
    this: DKGAgent,
    networkId: NetworkIdV1,
  ): Promise<CatalogSealDeploymentProfileV1> {
    let deployment = this.config.rfc64CatalogDeploymentProfile;
    const trustedNetworkId = deployment?.networkId ?? this.config.networkIdentity?.chainId;
    if (trustedNetworkId === undefined || trustedNetworkId !== networkId) {
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
    if (persistence === undefined) throw new CatalogRepairConditionErrorV1('persistence_unavailable', 'RFC-64 persistence is unavailable');
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
        signal: params.signal,
        // As wide as the store lane these reads run in, and no wider.
        resolveConcurrency: storeLaneInflightLimit(this.store),
        resolveAsset: (row, signal) => resolveRfc64InventoryWorkspaceCatalogAssetV1({
          store: this.store,
          publicSnapshotStore: this.publicSnapshotStore,
          contextGraphId: params.contextGraphId,
          authorAddress: params.authorAddress,
          laneKind: lane.kind,
          row,
          signal,
        }),
      }).catch(async (failure: unknown) => {
        if (!await this.healRfc64SwmInventoryAfterProjectionFailureV1(lane, snapshot, failure, params)) throw failure;
        return null;
      });
      if (prepared === null) continue;
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
          peers: this.resolveRfc64CatalogAnnouncementPeersV1(lane.announcementPeers),
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
      await markRfc64LegacySwmRepublishedV1(
        this,
        params.contextGraphId,
        prepared.assets.map((asset) => Object.freeze({
          kaUal: asset.seal.kaUal,
          assertionVersion: asset.seal.assertionVersion,
        })),
      );
      const { sourceCurrent: _sourceCurrent, ...result } = reconciled;
      return Object.freeze({
        ...result,
        inventoryHeadObjectDigest: prepared.inventoryHeadObjectDigest as Digest32V1,
      });
    }
  }

  /**
   * GH#3134 — a projection that failed on its inventory's integrity sweeps rows of finalized
   * assets whose shared-memory copy is already retired out of the author's inventory, once per
   * inventory head (`healFinalizedSwmInventoryRowsV1`). True when rows went and the projection
   * runs again. A finalized private lane keeps its rows.
   */
  private async healRfc64SwmInventoryAfterProjectionFailureV1(
    this: DKGAgent,
    lane: ResolvedRfc64CatalogAuthoringLaneV1,
    snapshot: SwmAuthorInventorySnapshotV1,
    failure: unknown,
    params: ReconcileRfc64PublicCatalogFromSwmInventoryParamsV1,
  ): Promise<boolean> {
    if (lane.acceptsFinalizedVmRepair || catalogRepairDiagnosticV1(failure).kind !== 'integrity') return false;
    const ctx = createOperationContext('system');
    const scope = Object.freeze({ ...lane.scopeBase, authorAddress: params.authorAddress }) as SwmAuthorInventoryScopeV1;
    const scopeDigest = computeSwmAuthorInventoryScopeDigestV1(scope);
    try {
      const healed = await healFinalizedSwmInventoryRowsV1(this, {
        store: this.store,
        contextGraphId: params.contextGraphId,
        authorAddress: params.authorAddress,
        snapshot,
        ...(params.signal === undefined ? {} : { signal: params.signal }),
        removeRow: async (row) => (await this.removeRfc64SwmAuthorInventoryRowV1({
          contextGraphId: params.contextGraphId,
          scope,
          expectedRow: { assertionVersion: row.assertionVersion, kaUal: row.kaUal, sealDigest: row.sealDigest },
          ...(params.signal === undefined ? {} : { signal: params.signal }),
        })).status,
      });
      if (healed > 0) {
        this.log.info(ctx, `RFC-64 SWM inventory of ${params.authorAddress} in ${params.contextGraphId}: `
          + `removed ${healed} row(s) of finalized assets whose shared-memory copy was retired`);
      }
      // A row that other work removed or replaced since the failed read may have been its cause.
      return healed > 0 || this.rfc64PersistenceV1?.swmAuthorInventory
        .readSwmAuthorInventoryHeadDigestV1(scopeDigest, params.authorAddress) !== snapshot.head.objectDigest;
    } catch (cause) {
      // A cancelled sweep ends the projection attempt with its cancellation.
      if (params.signal?.aborted === true) throw cause;
      this.log.warn(ctx, `RFC-64 SWM inventory rows of finalized assets were not swept: `
        + (cause instanceof Error ? cause.message : String(cause)));
      return false;
    }
  }

  private resolveRfc64CatalogAuthoringLaneDecisionV1(
    this: DKGAgent,
    contextGraphId: string,
    subGraphName: string | null | undefined,
  ): Rfc64CatalogAuthoringLaneDecisionV1 {
    const applicability = catalogAuthoringApplicability({ authority: this.resolveRfc64CatalogReceiverAuthorityV1(contextGraphId),
      config: this.config, service: this.rfc64PublicCatalogServiceV1 }, contextGraphId, subGraphName);
    if (applicability.status === 'excluded') return Object.freeze({ status: 'inactive' });
    if (applicability.status === 'unavailable') return applicability;
    if (!applicability.authority.authoringAllowed) return Object.freeze({ status: 'inactive' });
    const authoringPolicy = this.config.rfc64CatalogAuthoringPolicy;
    const exactControl = authoringPolicy?.byContextGraph[contextGraphId];
    const publicDefault = authoringPolicy?.publicDefault;
    assertContextGraphIdV1(contextGraphId, 'RFC-64 catalog authoring contextGraphId');
    const networkId = (this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.config.networkIdentity?.chainId) as NetworkIdV1 | undefined;
    if (networkId === undefined) {
      return Object.freeze({
        status: 'unavailable',
        error: new Error('RFC-64 catalog authoring requires a trusted deployment network'),
      });
    }
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      return Object.freeze({
        status: 'unavailable',
        error: new SwmCatalogAuthorityNotReady('service-unavailable'),
      });
    }
    const acceptedPolicy = service.acceptedPolicySnapshot(networkId, contextGraphId);
    if (acceptedPolicy === null) {
      return Object.freeze({
        status: 'unavailable',
        error: new SwmCatalogAuthorityNotReady('policy-not-accepted'),
      });
    }
    const defaultPeers = Object.freeze([...new Set(
      this.node.libp2p.getConnections()
        .map((connection) => connection.remotePeer.toString()),
    )].sort().slice(0, RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1));
    const selectedControl = exactControl ?? (publicDefault === undefined
      ? Object.freeze({
        kind: acceptedPolicy.policy.accessPolicy === 0
          ? 'selected-public' as const
          : 'selected-private' as const,
        contextGraphId,
        announcementPeers: defaultPeers,
        catalogIssuerDelegationEffectiveAt: '0' as TimestampMsV1,
        catalogIssuerDelegationExpiresAt:
          RFC64_DEFAULT_CATALOG_DELEGATION_EXPIRES_AT_V1,
      })
      : Object.freeze({
      kind: 'selected-public' as const,
      contextGraphId,
      announcementPeers: publicDefault!.announcementPeers,
      catalogIssuerDelegationEffectiveAt:
        publicDefault!.catalogIssuerDelegationEffectiveAt,
      catalogIssuerDelegationExpiresAt:
        publicDefault!.catalogIssuerDelegationExpiresAt,
    }));
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

  /**
   * Hand a head that a catalog mutation just committed to the catalog service's delivery owner
   * and return at once: the fan-out to peers runs outside the serialized mutation (GH#3081).
   * Never throws. A hand-off that nobody takes is logged; its head stays durable and reaches
   * peers with the next head of its catalog or through replay.
   */
  deliverRfc64CatalogHeadV1(
    this: DKGAgent,
    input: DeliverRfc64PublicCatalogHeadInputV1,
  ): Rfc64CatalogHeadHandoffV1 {
    const receipt = this.rfc64PublicCatalogServiceV1?.deliverCatalogHead(input)
      ?? RFC64_CATALOG_HEAD_HANDOFF_UNAVAILABLE_V1;
    catalogHeadDeliveryReportV1(this).handoff(this.log, input?.announcement, receipt);
    return receipt;
  }

  /** A committed head that its mutation did not hand off, because the caller had given up. */
  reportRfc64CatalogHeadNotHandedOffV1(
    this: DKGAgent,
    announcement: Rfc64PublicCatalogHeadAnnouncementV1,
  ): void {
    catalogHeadDeliveryReportV1(this)
      .handoff(this.log, announcement, RFC64_CATALOG_HEAD_HANDOFF_CANCELLED_V1);
  }

  /** Await the fan-outs of handed-off heads (tests / graceful shutdown coordination). */
  whenRfc64CatalogHeadDeliveryIdleV1(this: DKGAgent): Promise<void> {
    return this.rfc64PublicCatalogServiceV1?.whenCatalogHeadDeliveryIdle() ?? Promise.resolve();
  }

  /** Head delivery in counts since this process started, for `/api/status`: no identities. */
  readRfc64CatalogHeadDeliveryStatusV1(this: DKGAgent): Readonly<CatalogHeadDeliveryStatusV1> {
    return catalogHeadDeliveryReportV1(this).status();
  }

  /**
   * The agent's side of head delivery. A fan-out is best-effort work that outlives the mutation
   * that produced its head, so the store and chain reads of its policy decisions take the
   * background lanes; its outcome goes to the log.
   */
  rfc64CatalogHeadDeliveryPortsV1(
    this: DKGAgent,
  ): Pick<Rfc64CatalogHeadDeliveryOptionsV1, 'onDelivered' | 'runFanout'> {
    return Object.freeze({
      runFanout: (fanout: () => Promise<void>) => withDefaultStoreWorkPriority(
        'background',
        () => withOwnedRpcRequestContext({ requestClass: 'background' }, fanout),
      ),
      onDelivered: (outcome: Rfc64CatalogHeadDeliveryOutcomeV1) =>
        this.reportRfc64CatalogHeadDeliveryV1(outcome),
    });
  }

  /**
   * One finished fan-out of a handed-off head: the delivery report's lines (see
   * `internal/catalog-head-delivery-report.ts`), then the warning for deliveries that failed.
   * Peers this node's own policy refused received nothing and are not failures, so a head with
   * no eligible peer writes nothing at warn level.
   */
  reportRfc64CatalogHeadDeliveryV1(
    this: DKGAgent,
    outcome: Rfc64CatalogHeadDeliveryOutcomeV1,
  ): void {
    catalogHeadDeliveryReportV1(this).delivered(this.log, outcome);
    this.warnRfc64CatalogAnnounceFailuresV1(outcome);
  }

}
