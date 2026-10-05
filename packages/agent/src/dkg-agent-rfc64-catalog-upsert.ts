// SPDX-License-Identifier: Apache-2.0

/** Catalog-owned, serialized exact-set mutations for confirmed public SWM assets. */

import {
  MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1,
  assertSignedAuthorCatalogHeadEnvelopeV1,
  assertSignedAuthorCatalogIssuerDelegationEnvelopeV1,
  computeCanonicalGraphScopedAuthorSealDigestV1,
  computeAuthorCatalogScopeDigestV1,
  computeControlSignatureVariantDigestHex,
  createOperationContext,
  decodeOpaqueKaBundleV1,
  parseCanonicalGraphScopedAuthorSealV1,
  type AssertionCoordinateV1,
  type AuthorCatalogScopeV1,
  type CatalogSealDeploymentProfileV1,
  type Digest32V1,
  type TimestampMsV1,
} from '@origintrail-official/dkg-core';
import { verifyControlEnvelopeIssuerSignatureV1 } from '@origintrail-official/dkg-chain';

import { DKGAgentBase } from './dkg-agent-base.js';
import type { DKGAgent } from './dkg-agent.js';
import {
  loadBoundedAuthorCatalogHistoryV1,
  type BoundedAuthorCatalogHistoryV1,
  type Rfc64CatalogAuthorSignerV1,
  type Rfc64CatalogSuccessorAssetInputV1,
  type Rfc64StagedAuthorCatalogHeadRefV1,
} from './dkg-agent-rfc64-catalog.js';
import type { AppliedCatalogHeadSnapshotV1 } from './rfc64/inventory-v1/index.js';
import { assertRfc64CatalogReplacementOrderV1, sameRfc64SuccessorAssetV1 } from './rfc64/catalog-replacement-order-v1.js';
import {
  compareRfc64PublicCatalogSuccessorAssetsByKaIdV1,
  snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1,
} from './rfc64/public-catalog-successor-asset-v1.js';
import { snapshotRfc64PublicCatalogAnnouncementPeersV1 } from './rfc64/catalog-peers-v1.js';
import { computeRfc64AppliedInventoryDigestV1 } from './rfc64/public-catalog-inventory-completeness-v1.js';
import type { Rfc64PublicCatalogIssuerAuthorizationV1 } from './rfc64/public-catalog-successor-producer-v1.js';
import type { AnnounceRfc64PublicCatalogHeadResultV1 } from './rfc64/public-catalog-service-v1.js';
import type { Rfc64PersistenceV1 } from './rfc64/persistence-v1.js';
import {
  throwIfRfc64AbortedV1 as throwIfAbortedV1,
} from './rfc64/abort-v1.js';
import type { Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1 } from
  './rfc64/swm-author-inventory-producer-v1.js';

export interface UpsertConfirmedRfc64PublicRootCatalogAssetParamsV1 {
  readonly scope: AuthorCatalogScopeV1;
  readonly author: Rfc64CatalogAuthorSignerV1;
  readonly asset: Rfc64CatalogSuccessorAssetInputV1;
  readonly deployment: CatalogSealDeploymentProfileV1;
  readonly peers: readonly string[];
  readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
}

export interface ReconcileRfc64PublicRootCatalogExactSetParamsV1 {
  readonly scope: AuthorCatalogScopeV1;
  readonly author: Rfc64CatalogAuthorSignerV1;
  /** Complete bounded target. Input order is ignored after immutable snapshotting. */
  readonly assets: readonly Rfc64CatalogSuccessorAssetInputV1[];
  readonly deployment: CatalogSealDeploymentProfileV1;
  readonly peers: readonly string[];
  readonly catalogIssuerDelegationEffectiveAt: TimestampMsV1;
  readonly catalogIssuerDelegationExpiresAt: TimestampMsV1;
  readonly signal?: AbortSignal;
}

interface ReconcileRfc64SwmInventoryCatalogParamsV1
  extends ReconcileRfc64PublicRootCatalogExactSetParamsV1 {
  /** Lane-owned projection semantics; repair eligibility is resolved separately. */
  readonly targetPolicy: Rfc64CatalogProjectionTargetPolicyV1;
  /**
   * Projection-owned atomic boundary: verify the expected inventory head while
   * holding its scope lock, then revalidate unpublished evidence and execute
   * the synchronous applied-head CAS before releasing that lock.
   */
  readonly commitAppliedHeadIfInventoryCurrent: (
    commit: () => Promise<AppliedCatalogHeadSnapshotV1>,
  ) => Promise<Rfc64SourceAwareAppliedHeadCommitResultV1>;
}

export type Rfc64CatalogProjectionTargetPolicyV1 =
  | 'exact-replacement'
  | 'monotonic-union';

interface Rfc64CatalogProjectionMutationOptionsV1 {
  readonly targetPolicy: Rfc64CatalogProjectionTargetPolicyV1;
  readonly commitAppliedHead?: (
    commit: () => Promise<AppliedCatalogHeadSnapshotV1>,
  ) => Promise<Rfc64SourceAwareAppliedHeadCommitResultV1>;
}

interface Rfc64SourceAwareAppliedHeadCommitResultV1 {
  readonly appliedHead: AppliedCatalogHeadSnapshotV1;
  /** False means the signed branch was committed but the source needs a follow-up pass. */
  readonly sourceCurrent: boolean;
}

export interface ReconcileRfc64PublicRootCatalogExactSetResultV1 {
  readonly status: 'advanced' | 'existing' | 'empty';
  readonly appliedHead: AppliedCatalogHeadSnapshotV1 | null;
  readonly successorsApplied: number;
  readonly targetAssetCount: number;
}

interface ReconcileRfc64SwmInventoryCatalogResultV1
  extends ReconcileRfc64PublicRootCatalogExactSetResultV1 {
  readonly sourceCurrent: boolean;
}

interface Rfc64CatalogMutationStateV1 {
  readonly current: AppliedCatalogHeadSnapshotV1 | null;
  readonly previousHead: Rfc64StagedAuthorCatalogHeadRefV1;
  readonly catalogIssuerAuthorization: Rfc64PublicCatalogIssuerAuthorizationV1;
  readonly assets: Rfc64CatalogSuccessorAssetInputV1[];
  readonly expectedCurrentCatalogHeadDigest: Digest32V1 | null;
}

/** The canonical planner owns the complete sequence behind one applied-head CAS. */
export type Rfc64CatalogMutationV1 =
  | readonly [Rfc64CatalogSuccessorAssetInputV1[]]
  | readonly [Rfc64CatalogSuccessorAssetInputV1[], Rfc64CatalogSuccessorAssetInputV1[]];

interface Rfc64CatalogTargetMutationResultV1 {
  readonly state: Rfc64CatalogMutationStateV1;
  readonly successorsApplied: number;
  readonly sourceCurrent: boolean;
}

export class Rfc64CatalogUpsertMethods extends DKGAgentBase {
  /** Package-internal positive proof used by crash-safe confirmed-row retirement. */
  async rfc64CatalogCoversConfirmedSwmRowV1(
    this: DKGAgent,
    params: Readonly<{
      readonly scope: AuthorCatalogScopeV1;
      readonly expectedRow: Rfc64ConfirmedSwmAuthorInventoryRowIdentityV1 & Readonly<{
        assertionCoordinate: AssertionCoordinateV1;
      }>;
    }>,
  ): Promise<boolean> {
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) throw new Error('RFC-64 persistence is unavailable');
    const state = await this.readRfc64CatalogMutationStateV1(
      persistence,
      computeAuthorCatalogScopeDigestV1(params.scope),
      params.scope.authorAddress,
    );
    const asset = state?.assets.find((candidate) => (
      candidate.seal.kaUal === params.expectedRow.kaUal
    ));
    if (
      asset === undefined
      || asset.assertionCoordinate !== params.expectedRow.assertionCoordinate
    ) return false;
    const catalogVersion = BigInt(asset.seal.assertionVersion);
    const expectedVersion = BigInt(params.expectedRow.assertionVersion);
    if (catalogVersion > expectedVersion) {
      // A newer assertion on the same stable KA and coordinate is durable
      // completion for an obsolete confirmation repair. Never reconstruct or
      // roll it back to the older workspace/seal generation.
      return true;
    }
    return catalogVersion === expectedVersion
      && computeCanonicalGraphScopedAuthorSealDigestV1(asset.seal)
        === params.expectedRow.sealDigest;
  }

  /**
   * Own genesis creation, predecessor reconstruction, exact-set successor,
   * applied-head CAS, and best-effort availability announcement as one
   * serialized catalog mutation.
   */
  async upsertConfirmedRfc64PublicRootCatalogAssetV1(
    this: DKGAgent,
    params: UpsertConfirmedRfc64PublicRootCatalogAssetParamsV1,
  ): Promise<AppliedCatalogHeadSnapshotV1> {
    const authority = this.assertRfc64CatalogAuthoringModeV1(params.scope.contextGraphId);
    if (params.scope.subGraphName !== null) {
      throw new Error('RFC-64 confirmed public asset upsert requires the root catalog lane');
    }
    if (params.scope.authorAddress !== params.asset.seal.authorAddress) {
      throw new Error('RFC-64 confirmed public asset author differs from the catalog scope');
    }
    const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(params.peers);
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) {
      throw new Error('RFC-64 catalog upsert requires durable persistence');
    }
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error('RFC-64 catalog upsert requires the public catalog service');
    }
    service.acceptedPolicySnapshotForCatalogScope(params.scope);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(params.scope);

    return this.rfc64CatalogMutationCoordinatorV1.run(params.scope, async () => {
      let state = await this.readRfc64CatalogMutationStateV1(
        persistence,
        catalogScopeDigest,
        params.scope.authorAddress,
      );
      state ??= await this.createRfc64CatalogGenesisStateV1(params);
      const assets = state.assets;
      const existingIndex = assets.findIndex(
        (asset) => asset.seal.reservedKaId === params.asset.seal.reservedKaId,
      );
      if (
        existingIndex >= 0
        && sameRfc64SuccessorAssetV1(assets[existingIndex]!, params.asset)
      ) {
        if (state.current === null) {
          throw new Error('RFC-64 staged genesis unexpectedly contains an ordinary asset');
        }
        return state.current;
      }
      if (existingIndex >= 0) {
        const existing = assets[existingIndex]!;
        if (
          existing.assertionCoordinate === params.asset.assertionCoordinate
          && BigInt(params.asset.seal.assertionVersion) < BigInt(existing.seal.assertionVersion)
          && params.asset.seal.assertionFinalizedAt <= existing.seal.assertionFinalizedAt
        ) {
          // Delayed confirmation repair is complete under the later author-issued
          // seal. A genuinely newer reopened draft takes the guarded path below.
          if (state.current === null) {
            throw new Error('RFC-64 staged genesis unexpectedly contains an ordinary asset');
          }
          return state.current;
        }
        await assertRfc64CatalogReplacementOrderV1(this.chain, [existing], [params.asset]);
      }
      const targetAssets = [...assets];
      if (existingIndex >= 0) targetAssets[existingIndex] = params.asset;
      else targetAssets.push(params.asset);
      targetAssets.sort(compareRfc64CatalogAssetsByKaIdV1);
      const mutation = await this.mutateRfc64CatalogTargetV1(
        persistence, state, params, targetAssets, peers,
        authority.reconciliationLane === 'shadow-stage',
      );
      if (mutation.state.current === null) throw new Error('RFC-64 catalog upsert did not apply its asset');
      return mutation.state.current;
    });
  }

  /**
   * Reconcile one complete, already-verified target through deterministic
   * one-KA successors. The selected-CG lifecycle calls this after durable SWM
   * inventory mutations; explicit callers retain the same repair surface.
   */
  async reconcileRfc64PublicRootCatalogExactSetV1(
    this: DKGAgent,
    params: ReconcileRfc64PublicRootCatalogExactSetParamsV1,
  ): Promise<ReconcileRfc64PublicRootCatalogExactSetResultV1> {
    const result = await this.reconcileRfc64PublicRootCatalogProjectionCoreV1(params, {
      targetPolicy: 'exact-replacement',
    });
    return Object.freeze({
      status: result.status,
      appliedHead: result.appliedHead,
      successorsApplied: result.successorsApplied,
      targetAssetCount: result.targetAssetCount,
    });
  }

  /** One lane-owned projection boundary for exact replacement or monotonic union. */
  async reconcileRfc64SwmInventoryCatalogV1(
    this: DKGAgent,
    params: ReconcileRfc64SwmInventoryCatalogParamsV1,
  ): Promise<ReconcileRfc64SwmInventoryCatalogResultV1> {
    return this.reconcileRfc64PublicRootCatalogProjectionCoreV1(params, {
      targetPolicy: params.targetPolicy,
      commitAppliedHead: params.commitAppliedHeadIfInventoryCurrent,
    });
  }

  private async reconcileRfc64PublicRootCatalogProjectionCoreV1(
    this: DKGAgent,
    params: ReconcileRfc64PublicRootCatalogExactSetParamsV1,
    options: Readonly<Rfc64CatalogProjectionMutationOptionsV1>,
  ): Promise<ReconcileRfc64SwmInventoryCatalogResultV1> {
    throwIfAbortedV1(params.signal);
    const authority = this.assertRfc64CatalogAuthoringModeV1(params.scope.contextGraphId);
    if (params.scope.subGraphName !== null) {
      throw new Error('RFC-64 exact-set reconciliation requires the root catalog lane');
    }
    const requestedAssets = snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1(
      params.assets,
      'RFC-64 exact-set target assets',
    );
    for (const asset of requestedAssets) {
      if (asset.seal.authorAddress !== params.scope.authorAddress) {
        throw new Error('RFC-64 exact-set target author differs from the catalog scope');
      }
    }
    const peers = snapshotRfc64PublicCatalogAnnouncementPeersV1(params.peers);
    const persistence = this.rfc64PersistenceV1;
    if (persistence === undefined) {
      throw new Error('RFC-64 exact-set reconciliation requires durable persistence');
    }
    const service = this.rfc64PublicCatalogServiceV1;
    if (service === undefined) {
      throw new Error('RFC-64 exact-set reconciliation requires the public catalog service');
    }
    service.acceptedPolicySnapshotForCatalogScope(params.scope);
    const catalogScopeDigest = computeAuthorCatalogScopeDigestV1(params.scope);

    return this.rfc64CatalogMutationCoordinatorV1.run(params.scope, async () => {
      throwIfAbortedV1(params.signal);
      // The coordinator tail follows this physical read. Caller cancellation
      // remains prompt through the coordinator's outer race, but persistence
      // cannot close until a non-cooperative read actually settles.
      let state = await this.readRfc64CatalogMutationStateV1(
        persistence,
        catalogScopeDigest,
        params.scope.authorAddress,
      );
      throwIfAbortedV1(params.signal);
      if (state === null && requestedAssets.length === 0) {
        return Object.freeze({
          status: 'empty' as const,
          appliedHead: null,
          successorsApplied: 0,
          targetAssetCount: 0,
          sourceCurrent: true,
        });
      }
      state ??= await this.createRfc64CatalogGenesisStateV1(params);
      throwIfAbortedV1(params.signal);
      const targetAssets = planRfc64CatalogProjectionTargetV1(
        state.assets,
        requestedAssets,
        options.targetPolicy,
      );
      await assertRfc64CatalogReplacementOrderV1(this.chain, state.assets, targetAssets, params.signal);
      const mutation = await this.mutateRfc64CatalogTargetV1(
        persistence, state, params, targetAssets, peers,
        authority.reconciliationLane === 'shadow-stage', options.commitAppliedHead,
      );
      return Object.freeze({
        status: mutation.successorsApplied > 0 ? 'advanced' as const
          : state.current === null ? 'empty' as const : 'existing' as const,
        appliedHead: mutation.state.current,
        successorsApplied: mutation.successorsApplied,
        targetAssetCount: targetAssets.length,
        sourceCurrent: mutation.sourceCurrent,
      });
    }, params.signal);
  }

  /** Drive one prepared target while the existing scope coordinator owns mutation. */
  private async mutateRfc64CatalogTargetV1(
    this: DKGAgent,
    persistence: Rfc64PersistenceV1,
    initialState: Rfc64CatalogMutationStateV1,
    params: Readonly<Pick<ReconcileRfc64PublicRootCatalogExactSetParamsV1,
      'scope' | 'author' | 'deployment' | 'signal'>>,
    targetAssets: readonly Rfc64CatalogSuccessorAssetInputV1[],
    peers: readonly string[],
    stageOnly: boolean,
    commitAppliedHead?: Rfc64CatalogProjectionMutationOptionsV1['commitAppliedHead'],
  ): Promise<Rfc64CatalogTargetMutationResultV1> {
    let state = initialState;
    let successorsApplied = 0;
    let sourceCurrent = true;
    const hardLimit = MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1 * 2;
    while (!sameRfc64SuccessorAssetSetsV1(state.assets, targetAssets)) {
      throwIfAbortedV1(params.signal);
      const mutation = planNextRfc64CatalogExactSetV1(state.assets, targetAssets);
      const assets = mutation.at(-1)!;
      if (successorsApplied + mutation.length > hardLimit) {
        throw new Error('RFC-64 exact-set reconciliation exceeded its bounded successor limit');
      }
      const committed = await this.applyRfc64CatalogMutationV1(
        persistence, state, params, mutation, peers, stageOnly,
        params.signal, commitAppliedHead,
      );
      successorsApplied += mutation.length;
      state = catalogStateAfterSuccessorV1(state, committed, assets);
      sourceCurrent = committed.sourceCurrent;
      // A signed successor still commits when its inventory becomes stale,
      // but only a fresh projection pass may construct the next successor.
      if (!sourceCurrent) break;
    }
    return Object.freeze({ state, successorsApplied, sourceCurrent });
  }

  private assertRfc64CatalogAuthoringModeV1(
    this: DKGAgent,
    contextGraphId: string,
  ): ReturnType<DKGAgent['resolveRfc64CatalogServingAuthorityV1']> {
    const authority = this.resolveRfc64CatalogServingAuthorityV1(contextGraphId);
    if (authority.killSwitchActive) {
      throw new Error('RFC-64 catalog authoring is disabled by the Track-2 kill switch');
    }
    if (!authority.authoringAllowed) {
      throw new Error('RFC-64 catalog authoring is disabled for legacy-mode CG');
    }
    return authority;
  }

  private async readRfc64CatalogMutationStateV1(
    this: DKGAgent,
    persistence: Rfc64PersistenceV1,
    catalogScopeDigest: Digest32V1,
    authorAddress: AuthorCatalogScopeV1['authorAddress'],
  ): Promise<Rfc64CatalogMutationStateV1 | null> {
    const current = persistence.inventory.readAppliedCatalogHeadV1(
      catalogScopeDigest,
      authorAddress,
    );
    if (current === null) return null;

    const storedHead = await persistence.controlObjects.getVerifiedObjectByDigest({
      objectDigest: current.currentCatalogHeadDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    if (storedHead === null) throw new Error('RFC-64 applied author head is not durably staged');
    assertSignedAuthorCatalogHeadEnvelopeV1(storedHead.envelope);
    const previousHead = Object.freeze({
      objectDigest: storedHead.envelope.objectDigest as Digest32V1,
      signatureVariantDigest: computeControlSignatureVariantDigestHex(
        storedHead.envelope.objectDigest,
        storedHead.envelope.signature,
      ) as Digest32V1,
    });
    const history = await loadBoundedAuthorCatalogHistoryV1(persistence, previousHead);
    const assets = await loadRfc64CatalogSuccessorAssetsV1(persistence, history);
    const storedDelegation = await persistence.controlObjects.getVerifiedObjectByDigest({
      objectDigest: history.previousHead.payload.catalogIssuerDelegationDigest,
      verifyIssuerSignature: verifyControlEnvelopeIssuerSignatureV1,
    });
    if (storedDelegation === null) {
      throw new Error('RFC-64 applied author head delegation is not durably staged');
    }
    assertSignedAuthorCatalogIssuerDelegationEnvelopeV1(storedDelegation.envelope);
    return Object.freeze({
      current,
      previousHead,
      catalogIssuerAuthorization: Object.freeze({
        catalogIssuerDelegation: storedDelegation.envelope,
        parentAuthorAgentEvidence: null,
      }),
      assets,
      expectedCurrentCatalogHeadDigest: current.currentCatalogHeadDigest,
    });
  }

  private async createRfc64CatalogGenesisStateV1(
    this: DKGAgent,
    params: Readonly<{
      scope: AuthorCatalogScopeV1;
      author: Rfc64CatalogAuthorSignerV1;
      catalogIssuerDelegationEffectiveAt: TimestampMsV1;
      catalogIssuerDelegationExpiresAt: TimestampMsV1;
      signal?: AbortSignal;
    }>,
  ): Promise<Rfc64CatalogMutationStateV1> {
    throwIfAbortedV1(params.signal);
    const genesis = await this.publishAuthorCatalogGenesisV1({
      scope: params.scope,
      author: params.author,
      peers: [],
      issuedAt: Date.now().toString() as TimestampMsV1,
      catalogIssuerDelegationEffectiveAt: params.catalogIssuerDelegationEffectiveAt,
      catalogIssuerDelegationExpiresAt: params.catalogIssuerDelegationExpiresAt,
    });
    throwIfAbortedV1(params.signal);
    return Object.freeze({
      current: null,
      previousHead: Object.freeze({
        objectDigest: genesis.headObjectDigest,
        signatureVariantDigest: genesis.signatureVariantDigest,
      }),
      catalogIssuerAuthorization: genesis.catalogIssuerAuthorization,
      assets: [],
      expectedCurrentCatalogHeadDigest: null,
    });
  }

  private async applyRfc64CatalogMutationV1(
    this: DKGAgent,
    persistence: Rfc64PersistenceV1,
    state: Rfc64CatalogMutationStateV1,
    params: Readonly<{
      scope: AuthorCatalogScopeV1;
      author: Rfc64CatalogAuthorSignerV1;
      deployment: CatalogSealDeploymentProfileV1;
    }>,
    mutation: Rfc64CatalogMutationV1,
    peers: readonly string[],
    stageOnly: boolean,
    signal?: AbortSignal,
    commitAppliedHead?: Rfc64CatalogProjectionMutationOptionsV1['commitAppliedHead'],
  ) {
    throwIfAbortedV1(signal);
    let previousHead = state.previousHead;
    let successor!: Awaited<ReturnType<DKGAgent['publishAuthorCatalogExactSetSuccessorV1']>>;
    // Stage the explicit sequence without exposing an intermediate removal.
    // A failed insertion leaves the prior applied row available and ordered.
    for (const assets of mutation) {
      successor = await this.publishAuthorCatalogExactSetSuccessorV1({
        previousHead,
        author: params.author,
        catalogIssuerAuthorization: state.catalogIssuerAuthorization,
        assets,
        deployment: params.deployment,
        issuedAt: Date.now().toString() as TimestampMsV1,
        peers: [],
      });
      throwIfAbortedV1(signal);
      previousHead = Object.freeze({
        objectDigest: successor.headObjectDigest,
        signatureVariantDigest: successor.signatureVariantDigest,
      });
    }
    const assets = mutation.at(-1)!;
    const appliedInventoryDigest = computeRfc64AppliedInventoryDigestV1({
      catalogScopeDigest: successor.catalogScopeDigest,
      rows: successor.assets,
    });
    const commit = async (): Promise<AppliedCatalogHeadSnapshotV1> => {
      // A reused or lower burned draft is admissible only while its chain proof
      // remains unpublished. Signing, staging and commit ownership may cross a block.
      await assertRfc64CatalogReplacementOrderV1(this.chain, state.assets, assets, signal);
      throwIfAbortedV1(signal);
      return persistence.inventory.compareAndSwapAppliedCatalogHeadV1({
        catalogScopeDigest: successor.catalogScopeDigest,
        authorAddress: params.scope.authorAddress,
        currentCatalogHeadDigest: successor.headObjectDigest,
        appliedInventoryDigest,
        catalogVersion: successor.announcement.catalogVersion,
        inventoryRowCount: successor.signedBucketRowCount,
        expectedCurrentCatalogHeadDigest: state.expectedCurrentCatalogHeadDigest,
        stageOnly,
      }).snapshot;
    };
    const committed = commitAppliedHead === undefined
      ? Object.freeze({ appliedHead: await commit(), sourceCurrent: true })
      : await commitAppliedHead(commit);
    if (!signal?.aborted) {
      this.warnRfc64CatalogAnnounceFailuresV1(await this.announceRfc64PublicCatalogHeadV1({
        announcement: successor.announcement,
        peers,
        signal,
      }));
    }
    return Object.freeze({
      applied: committed.appliedHead,
      successor,
      sourceCurrent: committed.sourceCurrent,
    });
  }

  /**
   * Author-side announce delivery is best-effort, but a silently failed
   * fan-out leaves every replica waiting on connect-time replay churn. Surface
   * the per-peer outcome so a slow convergence can be traced to its cause.
   */
  warnRfc64CatalogAnnounceFailuresV1(
    this: DKGAgent,
    delivery: AnnounceRfc64PublicCatalogHeadResultV1,
  ): void {
    const failed = delivery.failedPeers;
    if (failed.length === 0) return;
    const total = failed.length + delivery.announcedPeers.length;
    this.log.warn(
      createOperationContext('system'),
      `RFC-64 catalog head announce failed for ${failed.length}/${total} peer(s)`
        + ` head=${delivery.announcement.catalogHeadObjectDigest}`
        + ` cg=${delivery.announcement.contextGraphId}`
        + ` version=${delivery.announcement.catalogVersion}`
        + ` peers=${failed.map(({ peerId }) => peerId.slice(-8)).join(',')}`
        + ` error=${failed[0]!.error.slice(0, 160)}`,
    );
  }

}

function catalogStateAfterSuccessorV1(
  state: Rfc64CatalogMutationStateV1,
  committed: Readonly<{
    applied: AppliedCatalogHeadSnapshotV1;
    successor: Readonly<{ headObjectDigest: Digest32V1; signatureVariantDigest: Digest32V1 }>;
  }>,
  assets: Rfc64CatalogSuccessorAssetInputV1[],
): Rfc64CatalogMutationStateV1 {
  return Object.freeze({
    current: committed.applied,
    previousHead: Object.freeze({
      objectDigest: committed.successor.headObjectDigest,
      signatureVariantDigest: committed.successor.signatureVariantDigest,
    }),
    catalogIssuerAuthorization: state.catalogIssuerAuthorization,
    assets,
    expectedCurrentCatalogHeadDigest: committed.applied.currentCatalogHeadDigest,
  });
}

/** Build the explicit projection target before entering the mutation engine. */
export function planRfc64CatalogProjectionTargetV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  requested: readonly Rfc64CatalogSuccessorAssetInputV1[],
  policy: Rfc64CatalogProjectionTargetPolicyV1,
): readonly Rfc64CatalogSuccessorAssetInputV1[] {
  if (policy === 'exact-replacement') return requested;
  return snapshotAndSortRfc64PublicCatalogSuccessorAssetsV1(
    [
      ...current.filter((existing) => !requested.some(
        (candidate) => candidate.seal.reservedKaId === existing.seal.reservedKaId,
      )),
      ...requested,
    ],
    'RFC-64 monotonic-union target assets',
  );
}

export function planNextRfc64CatalogExactSetV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  target: readonly Rfc64CatalogSuccessorAssetInputV1[],
): Rfc64CatalogMutationV1 {
  let currentIndex = 0;
  let targetIndex = 0;
  while (currentIndex < current.length || targetIndex < target.length) {
    const currentAsset = current[currentIndex];
    const targetAsset = target[targetIndex];
    if (currentAsset === undefined) {
      return Object.freeze([insertOrFreeRfc64CatalogCapacityV1(current, target, targetAsset!)]);
    }
    if (targetAsset === undefined) {
      return Object.freeze([current.filter((_, index) => index !== currentIndex)]);
    }
    const comparison = compareRfc64CatalogAssetsByKaIdV1(currentAsset, targetAsset);
    if (comparison < 0) return Object.freeze([current.filter((_, index) => index !== currentIndex)]);
    if (comparison > 0) {
      return Object.freeze([insertOrFreeRfc64CatalogCapacityV1(current, target, targetAsset)]);
    }
    if (!sameRfc64SuccessorAssetV1(currentAsset, targetAsset)) {
      if (
        BigInt(targetAsset.seal.assertionVersion)
          !== BigInt(currentAsset.seal.assertionVersion) + 1n
      ) {
        // Reused/lower drafts need a signed remove/insert pair committed as
        // one mutation. Version gaps retain the ordinary removal successor;
        // their later insertion is planned against that newly applied head.
        const removal = current.filter((_, index) => index !== currentIndex);
        return BigInt(targetAsset.seal.assertionVersion) <= BigInt(currentAsset.seal.assertionVersion)
          ? Object.freeze([removal, insertRfc64CatalogAssetV1(removal, targetAsset)])
          : Object.freeze([removal]);
      }
      const next = [...current];
      next[currentIndex] = targetAsset;
      return Object.freeze([next]);
    }
    currentIndex += 1;
    targetIndex += 1;
  }
  throw new Error('RFC-64 exact-set planner was called for an already-converged target');
}

function insertOrFreeRfc64CatalogCapacityV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  target: readonly Rfc64CatalogSuccessorAssetInputV1[],
  asset: Rfc64CatalogSuccessorAssetInputV1,
): Rfc64CatalogSuccessorAssetInputV1[] {
  if (current.length < MAX_AUTHOR_CATALOG_BUCKET_ROWS_V1) {
    return insertRfc64CatalogAssetV1(current, asset);
  }
  const targetKaIds = new Set(target.map((targetAsset) => targetAsset.seal.reservedKaId));
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (!targetKaIds.has(current[index]!.seal.reservedKaId)) {
      return current.filter((_currentAsset, currentIndex) => currentIndex !== index);
    }
  }
  throw new Error('RFC-64 exact-set planner cannot free capacity for a target-only asset');
}

function insertRfc64CatalogAssetV1(
  current: readonly Rfc64CatalogSuccessorAssetInputV1[],
  asset: Rfc64CatalogSuccessorAssetInputV1,
): Rfc64CatalogSuccessorAssetInputV1[] {
  const next = [...current, asset];
  next.sort((left, right) => compareRfc64CatalogAssetsByKaIdV1(left, right));
  return next;
}

function compareRfc64CatalogAssetsByKaIdV1(
  left: Rfc64CatalogSuccessorAssetInputV1,
  right: Rfc64CatalogSuccessorAssetInputV1,
): -1 | 0 | 1 {
  return compareRfc64PublicCatalogSuccessorAssetsByKaIdV1(left, right);
}

function sameRfc64SuccessorAssetSetsV1(
  left: readonly Rfc64CatalogSuccessorAssetInputV1[],
  right: readonly Rfc64CatalogSuccessorAssetInputV1[],
): boolean {
  return left.length === right.length
    && left.every((asset, index) => sameRfc64SuccessorAssetV1(asset, right[index]!));
}

async function loadRfc64CatalogSuccessorAssetsV1(
  persistence: Rfc64PersistenceV1,
  history: BoundedAuthorCatalogHistoryV1,
): Promise<Rfc64CatalogSuccessorAssetInputV1[]> {
  const assets: Rfc64CatalogSuccessorAssetInputV1[] = [];
  for (const row of history.previousBucket?.payload.rows ?? []) {
    const bundleBytes = await persistence.kaBundles.readKaBundleByDigest(row.transfer.blobDigest);
    if (bundleBytes === null) {
      throw new Error(`RFC-64 applied catalog bundle ${row.transfer.blobDigest} is unavailable`);
    }
    const decoded = decodeOpaqueKaBundleV1(bundleBytes);
    if (
      decoded.blobDigest !== row.transfer.blobDigest
      || decoded.projectionDigest !== row.projectionDigest
    ) {
      throw new Error('RFC-64 applied catalog bundle differs from its signed predecessor row');
    }
    assets.push(Object.freeze({
      assertionCoordinate: row.assertionCoordinate,
      projectionBytes: new Uint8Array(decoded.projectionBytes),
      seal: parseCanonicalGraphScopedAuthorSealV1(decoded.sealBytes),
    }));
  }
  return assets;
}
