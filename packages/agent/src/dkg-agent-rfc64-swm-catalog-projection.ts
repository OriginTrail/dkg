// SPDX-License-Identifier: Apache-2.0

/** Selected-CG durable SWM-inventory to signed-catalog projection owner. */

import {
  assertCanonicalEvmAddress,
  assertContextGraphIdV1,
  computeAuthorCatalogScopeDigestV1,
  computeSwmAuthorInventoryScopeDigestV1,
  createOperationContext,
  type AssertionCoordinateV1,
  type AuthorCatalogScopeV1,
  type AuthorLaneScopeV1,
  type CatalogSealDeploymentProfileV1,
  type CanonicalDeterministicUalV1,
  type ContextGraphIdV1,
  type DecimalU64V1,
  type Digest32V1,
  type EvmAddressV1,
  type NetworkIdV1,
  type OperationContext,
  type PositiveDecimalU64V1,
  type SwmAuthorInventoryRowV1,
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
import { rfc64SwmInventoryAssetKeyV1 } from './dkg-agent-rfc64-catalog-auto-publish.js';
import type { Rfc64SwmAuthorInventoryShadowMutationResultV1 } from
  './dkg-agent-rfc64-catalog-auto-publish.js';
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
import { markRfc64LegacySwmRepublishedV1 } from
  './rfc64/legacy-swm-boundary-v1.js';
import { RFC64_PUBLIC_CATALOG_ANNOUNCE_MAX_PEERS_V1 } from
  './rfc64/catalog-peers-v1.js';

const RFC64_DEFAULT_CATALOG_DELEGATION_EXPIRES_AT_V1 =
  '253402300799000' as TimestampMsV1;

/**
 * Era of the owner-signed unregistered generation every locally created Context
 * Graph starts in. `composeRfc64UnregisteredCatalogAuthorityV1` pins that
 * generation's era to zero and its whole governance tuple to `null`, so the
 * lane scope it produces stays reconstructible from `(networkId,
 * contextGraphId, authorAddress)` alone after the graph has already rotated
 * away from it -- no retained previous-generation state is required.
 */
const RFC64_UNREGISTERED_ORIGIN_ERA_V1 = '0' as DecimalU64V1;

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

/** One local author's rows still addressed by the pre-rotation origin scope. */
interface Rfc64PreRotationAuthorInventoryV1 {
  readonly authorAddress: EvmAddressV1;
  readonly originDigest: Digest32V1;
  readonly rows: readonly Readonly<SwmAuthorInventoryRowV1>[];
}

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
   * Re-project this author's inventory under a newly accepted authority
   * generation so heads published before the rotation stop being orphaned.
   *
   * Every applied catalog head is keyed by a scope digest that includes the
   * governance tuple (`AUTHOR_LANE_SCOPE_KEYS_V1`), and so is the durable SWM
   * author inventory this projection reads. A Context Graph rotating from its
   * owner-signed unregistered generation to a finalized-chain generation
   * therefore enters the new generation with an empty inventory: the replay
   * manifest, keyed only on `(networkId, contextGraphId)`, keeps advertising
   * the pre-rotation head while current-head discovery and `isHeadSatisfied`,
   * keyed on the new scope digest, can never resolve it. Both sides then retry
   * forever and every row published before the rotation is unreachable through
   * the catalog path.
   *
   * Only the graph's author of record carries its own rows forward, and only
   * through the ordinary shadow recorder, which re-derives the lane scope from
   * the currently accepted policy and re-validates each row against durable
   * store state. This never weakens the authority fence: a row whose durable
   * workspace head no longer matches the accepted lane's access policy (a
   * registration that turned a public graph owner-only) is left behind and
   * reported, never carried across the fence.
   *
   * Re-entry is safe. A row already present under the accepted scope is
   * skipped, the recorder itself returns `existing` without advancing the
   * inventory lineage, and the projection is an exact-set reconcile onto the
   * accepted scope's own applied head.
   *
   * Admission is deliberately synchronous and returns `null` when there is
   * nothing to carry. This runs inside authority acceptance, where even an
   * already-resolved `await` yields a microtask and re-orders the coalesced
   * finalized-authority batch passes around it, so the overwhelmingly common
   * no-op must not suspend that path at all.
   *
   * The returned promise never rejects: an escaping error here would wrongly
   * demote the graph's authority progress.
   */
  beginRfc64CatalogReprojectionForAuthorityRotationV1(
    this: DKGAgent,
    contextGraphId: string,
    ctx: OperationContext = createOperationContext('system'),
    signal?: AbortSignal,
  ): Promise<void> | null {
    let admitted: Readonly<{
      lane: ResolvedRfc64CatalogAuthoringLaneV1;
      origins: readonly Rfc64PreRotationAuthorInventoryV1[];
    }> | null;
    try {
      admitted = this.admitRfc64CatalogReprojectionV1(contextGraphId, ctx);
    } catch (cause) {
      this.log.warn(ctx, rfc64ReprojectionWarningV1(contextGraphId, cause));
      return null;
    }
    if (admitted === null) return null;
    return this.runRfc64CatalogReprojectionV1(admitted.lane, {
      contextGraphId,
      ctx,
      origins: admitted.origins,
      ...(signal === undefined ? {} : { signal }),
    });
  }

  /** Fully synchronous admission: who may re-project, and is anything stranded. */
  private admitRfc64CatalogReprojectionV1(
    this: DKGAgent,
    contextGraphId: string,
    ctx: OperationContext,
  ): Readonly<{
    lane: ResolvedRfc64CatalogAuthoringLaneV1;
    origins: readonly Rfc64PreRotationAuthorInventoryV1[];
  }> | null {
    // A replica must never fabricate an author lineage for someone else's
    // graph. Only the author of record re-projects its own inventory.
    if (!this.localContextGraphProvenance.hasLocalCreate(contextGraphId)) return null;
    const persistence = this.rfc64PersistenceV1;
    const networkId = (this.config.rfc64CatalogDeploymentProfile?.networkId
      ?? this.config.networkIdentity?.chainId) as NetworkIdV1 | undefined;
    if (persistence === undefined || networkId === undefined) return null;
    const origins = this.listLocalAgents().flatMap(({ agentAddress }) => {
      const authorAddress = agentAddress.toLowerCase() as EvmAddressV1;
      const originScope = Object.freeze({
        networkId,
        contextGraphId: contextGraphId as ContextGraphIdV1,
        governanceChainId: null,
        governanceContractAddress: null,
        ownershipTransitionDigest: null,
        subGraphName: null,
        authorAddress,
        era: RFC64_UNREGISTERED_ORIGIN_ERA_V1,
      }) as SwmAuthorInventoryScopeV1;
      const originDigest = computeSwmAuthorInventoryScopeDigestV1(originScope);
      const snapshot = persistence.swmAuthorInventory
        .readSwmAuthorInventorySnapshotV1(originDigest, authorAddress);
      return snapshot === null || snapshot.rows.length === 0
        ? []
        : [Object.freeze({ authorAddress, originDigest, rows: snapshot.rows })];
    });
    // Nothing was ever durably published under the unregistered origin
    // generation, so this rotation cannot have orphaned a head. Stay silent
    // rather than warning on every ordinary acceptance.
    if (origins.length === 0) return null;
    let lane: ResolvedRfc64CatalogAuthoringLaneV1 | null;
    try {
      lane = this.resolveRfc64CatalogAuthoringLaneV1(contextGraphId, null);
    } catch (cause) {
      this.log.warn(ctx, rfc64ReprojectionWarningV1(contextGraphId, cause));
      return null;
    }
    if (lane === null) {
      this.log.warn(ctx, rfc64ReprojectionWarningV1(
        contextGraphId,
        'the catalog authoring lane is inactive',
      ));
      return null;
    }
    // The GENERATION question belongs here, not inside the async carry. The mere
    // presence of unregistered-origin rows is not evidence that anything is
    // stranded: until the graph is registered the accepted generation IS the
    // unregistered origin, so the ordinary projection already reads exactly
    // these rows. Deciding that downstream meant every locally-created,
    // still-unregistered Context Graph with at least one inventory row returned
    // a promise and suspended the acceptance path for a no-op — on the FIRST
    // acceptance in every fresh process — and logged "rows published under the
    // previous authority generation stay unreachable" for graphs that never
    // rotated. The lane is already resolved synchronously above, so the
    // comparison costs nothing here.
    const stranded = origins.filter(({ authorAddress, originDigest }) => (
      computeSwmAuthorInventoryScopeDigestV1(Object.freeze({
        ...lane!.scopeBase,
        authorAddress,
      }) as SwmAuthorInventoryScopeV1) !== originDigest
    ));
    if (stranded.length === 0) return null;
    return Object.freeze({ lane, origins: stranded });
  }

  private async runRfc64CatalogReprojectionV1(
    this: DKGAgent,
    lane: ResolvedRfc64CatalogAuthoringLaneV1,
    params: Readonly<{
      readonly contextGraphId: string;
      readonly ctx: OperationContext;
      readonly origins: readonly Rfc64PreRotationAuthorInventoryV1[];
      readonly signal?: AbortSignal;
    }>,
  ): Promise<void> {
    for (const origin of params.origins) {
      // The caller awaits this inside `runBoundedOperation`. Without the signal a
      // large stranded inventory kept doing store reads and durable writes long
      // after the budget expired or the node began shutting down, and the
      // caller's post-await abort check could never fire because this promise
      // never rejects.
      if (params.signal?.aborted === true) return;
      try {
        await this.carryRfc64AuthorInventoryIntoAcceptedGenerationV1(lane, {
          contextGraphId: params.contextGraphId,
          ctx: params.ctx,
          ...(params.signal === undefined ? {} : { signal: params.signal }),
          ...origin,
        });
      } catch (cause) {
        this.log.warn(params.ctx, rfc64ReprojectionWarningV1(
          params.contextGraphId,
          cause,
          origin.authorAddress,
        ));
      }
    }
  }

  /**
   * Carry one local author's pre-rotation rows into the accepted generation and
   * request its projection. A row that cannot cross is reported rather than
   * dropped: before this existed, the failure mode was entirely invisible.
   */
  private async carryRfc64AuthorInventoryIntoAcceptedGenerationV1(
    this: DKGAgent,
    lane: ResolvedRfc64CatalogAuthoringLaneV1,
    params: Readonly<{
      readonly contextGraphId: string;
      readonly authorAddress: EvmAddressV1;
      readonly originDigest: Digest32V1;
      readonly rows: readonly Readonly<SwmAuthorInventoryRowV1>[];
      readonly ctx: OperationContext;
      readonly signal?: AbortSignal;
    }>,
  ): Promise<void> {
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
    const acceptedScope = Object.freeze({
      ...lane.scopeBase,
      authorAddress: params.authorAddress,
    }) as SwmAuthorInventoryScopeV1;
    // Admission has already established that this origin differs from the
    // accepted generation; see `admitRfc64CatalogReprojectionV1`.
    const acceptedDigest = computeSwmAuthorInventoryScopeDigestV1(acceptedScope);
    const acceptedCatalogScope = Object.freeze({
      ...acceptedScope,
      bucketCount: '1',
    }) as AuthorCatalogScopeV1;
    const acceptedHead = persistence.inventory.readAppliedCatalogHeadV1(
      computeAuthorCatalogScopeDigestV1(acceptedCatalogScope),
      params.authorAddress,
    );
    // A catalog lineage can only be opened by an era-zero direct-author genesis
    // delegation (`produceDirectAuthorCatalogIssuerDelegationV1` fails closed on
    // `catalog-delegation-scope` otherwise). Registration keeps `ownershipEra`
    // at zero, so the rotation this repairs can always mint one; an ownership
    // TRANSFER advances the era, and a catalog for that generation has to be
    // carried by the RFC-64 transferred-catalog-bundle path instead. Report it
    // once here rather than handing the supervisor a permanently failing pass.
    if (acceptedHead === null && acceptedScope.era !== '0') {
      this.log.warn(params.ctx, rfc64ReprojectionWarningV1(
        params.contextGraphId,
        `the accepted authority generation is era ${acceptedScope.era} and has no `
        + 'catalog lineage; a non-zero era cannot open one with a direct-author '
        + 'genesis delegation and needs a transferred catalog bundle',
        params.authorAddress,
      ));
      return;
    }
    const acceptedRows = persistence.swmAuthorInventory.readSwmAuthorInventorySnapshotV1(
      acceptedDigest,
      params.authorAddress,
    )?.rows ?? [];
    const alreadyCarried = new Set(acceptedRows.map(rfc64AuthorInventoryRowIdentityV1));
    // Row identity includes `shareOperationId`, so a KA RE-SHARED after the
    // rotation has a different identity here even though the accepted
    // generation already serves it. Carrying the pre-rotation operation id
    // would then fail the confirmation fence and be reported as "stays
    // unreachable" for a row that is perfectly reachable. Coordinate-level
    // presence is the honest question: is this assertion already in the
    // accepted generation at this version?
    const alreadyServed = new Set(acceptedRows.map(
      (row) => `${row.assertionCoordinate}\u0000${row.assertionVersion}`,
    ));
    const shadowRuntime = rfc64SwmInventoryShadowRuntimeV1(this);
    for (const row of params.rows) {
      if (params.signal?.aborted === true) return;
      if (alreadyCarried.has(rfc64AuthorInventoryRowIdentityV1(row))) continue;
      if (alreadyServed.has(`${row.assertionCoordinate}\u0000${row.assertionVersion}`)) continue;
      // Route through the shadow runtime rather than calling the recorder
      // directly. Going around it left this write untracked by
      // `drain()`/`closeAndDrain()` — persistence could close mid-write — and
      // unserialized against `observeRfc64ConfirmedVmV1`, whose retraction of a
      // VM-confirmed row could be undone by a carry that read its fences before
      // the confirmation landed and wrote after it.
      // `runExclusive` serializes but does not relay a return value.
      let carried: Rfc64SwmAuthorInventoryShadowMutationResultV1 | undefined;
      await shadowRuntime.runExclusive(
        rfc64SwmInventoryAssetKeyV1({
          contextGraphId: params.contextGraphId,
          subGraphName: null,
          authorAddress: params.authorAddress,
          assertionCoordinate: row.assertionCoordinate,
        }),
        async () => {
          carried = await this.recordRfc64SwmAuthorInventoryShadowV1({
            contextGraphId: params.contextGraphId,
            assertionCoordinate: row.assertionCoordinate,
            lifecycleAgentAddress: params.authorAddress,
            shareOperationId: row.shareOperationId,
          });
        },
      );
      if (carried === undefined) continue;
      if (carried.status === 'applied' || carried.status === 'existing') continue;
      // A durable VM confirmation retires the SWM-only row deliberately; the
      // finalized lane owns it and this rotation did not orphan it.
      if (carried.dormantReason === 'vm-confirmed') continue;
      this.log.warn(
        params.ctx,
        `RFC-64 catalog re-projection could not carry ${row.kaUal} for `
        + `${params.contextGraphId} / ${params.authorAddress} into the accepted `
        + `authority generation (${carried.dormantReason ?? carried.status}`
        + `${carried.error === null ? '' : `: ${carried.error}`}); that row stays `
        + 'unreachable through the catalog path',
      );
    }
    // Requested even when every row was already carried: a crash between the
    // inventory carry and its catalog successor would otherwise leave the
    // accepted generation with rows and no applied head.
    if (!this.requestRfc64SwmCatalogProjectionV1({
      contextGraphId: params.contextGraphId as ContextGraphIdV1,
      authorAddress: params.authorAddress,
      ctx: params.ctx,
    })) {
      this.log.warn(params.ctx, rfc64ReprojectionWarningV1(
        params.contextGraphId,
        'the projection supervisor refused the request',
        params.authorAddress,
      ));
      return;
    }
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
      peers: this.resolveRfc64CatalogAnnouncementPeersV1(lane.announcementPeers),
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
      subGraphName !== undefined && subGraphName !== null
    ) return Object.freeze({ status: 'inactive' });
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
    if (
      exactControl === undefined
      && publicDefault !== undefined
      && acceptedPolicy.policy.accessPolicy === 1
    ) {
      // The compatibility fallback is intentionally public-only. A private
      // policy in the same bootstrap manifest is neither an authoring failure
      // nor an invitation to reinterpret that fallback as private authority.
      return Object.freeze({ status: 'inactive' });
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

}

/** Exact durable identity of one inventory row, used to skip an already-carried row. */
function rfc64AuthorInventoryRowIdentityV1(
  row: Readonly<SwmAuthorInventoryRowV1>,
): string {
  return JSON.stringify([
    row.assertionCoordinate,
    row.assertionVersion,
    row.kaUal,
    row.shareOperationId,
    row.sealDigest,
  ]);
}

/** One observable line for a re-projection that could not run to completion. */
function rfc64ReprojectionWarningV1(
  contextGraphId: string,
  reason: unknown,
  authorAddress?: EvmAddressV1,
): string {
  const detail = reason instanceof Error ? reason.message : String(reason);
  const author = authorAddress === undefined ? '' : ` / ${authorAddress}`;
  return `RFC-64 catalog re-projection after an authority rotation did not `
    + `complete for ${contextGraphId}${author}: ${detail}; catalog rows `
    + 'published under the previous authority generation stay unreachable';
}
